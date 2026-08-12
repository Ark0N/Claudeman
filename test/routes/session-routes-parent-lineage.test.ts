/**
 * @fileoverview `parentSessionId` on the create routes — the "who spawned me" hint
 * that draws the tab lineage lines.
 *
 * The rules under test are the ones that keep a cosmetic field harmless: it is
 * RESOLVED against live sessions rather than trusted, anything unresolvable is
 * dropped instead of failing the spawn (a worker must never fail to start over a
 * decoration), and it never crosses an owner boundary.
 *
 * Uses app.inject(), so no real HTTP port is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, createMockSession, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

const PARENT_ID = 'test-session-1'; // the id the mock context pre-populates

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

describe('POST /api/sessions parentSessionId', () => {
  let workingDir: string;
  let harness: Harness;

  /**
   * The created session as the route returned it. The harness registers the route
   * module alone, without server.ts's envelope hook, so the handler's raw
   * `{ session }` is what lands here.
   */
  const created = (body: string) => {
    const parsed = JSON.parse(body);
    return (parsed.data?.session ?? parsed.session) as { id: string; parentSessionId?: string };
  };

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'codeman-lineage-'));
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
    await rm(workingDir, { recursive: true, force: true });
  });

  it('stores a body-supplied parent that resolves to a live session', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'child', mode: 'claude', workingDir, parentSessionId: PARENT_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(created(res.body).parentSessionId).toBe(PARENT_ID);
  });

  it('accepts the X-Codeman-Parent-Session header, which is how the skill sends it', async () => {
    // The agent skill puts this on its shared curl invocation, so every spawn
    // recipe carries it without a per-recipe edit.
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-codeman-parent-session': PARENT_ID },
      payload: { name: 'child', mode: 'claude', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(created(res.body).parentSessionId).toBe(PARENT_ID);
  });

  it('lets the body win when both are present', async () => {
    harness.ctx.sessions.set('other-session', createMockSession('other-session'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-codeman-parent-session': 'other-session' },
      payload: { name: 'child', mode: 'claude', workingDir, parentSessionId: PARENT_ID },
    });

    expect(created(res.body).parentSessionId).toBe(PARENT_ID);
  });

  it('DROPS an unknown parent instead of failing the spawn', async () => {
    // The whole point: a stale id from a cached preamble must cost a line, not a worker.
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'child', mode: 'claude', workingDir, parentSessionId: 'no-such-session-anywhere' },
    });

    expect(res.statusCode).toBe(200);
    expect(created(res.body).id).toBeTruthy(); // the worker still started
    expect(created(res.body).parentSessionId).toBeUndefined();
  });

  it('resolves a >= 8-char prefix, because ids reach agents truncated', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'child', mode: 'claude', workingDir, parentSessionId: PARENT_ID.slice(0, 8) },
    });

    expect(created(res.body).parentSessionId).toBe(PARENT_ID);
  });

  it('refuses a prefix shorter than 8 chars', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'child', mode: 'claude', workingDir, parentSessionId: PARENT_ID.slice(0, 4) },
    });

    expect(created(res.body).parentSessionId).toBeUndefined();
  });

  it('resolves an AMBIGUOUS prefix to nothing rather than to a guess', async () => {
    harness.ctx.sessions.set('test-session-2', createMockSession('test-session-2'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'child', mode: 'claude', workingDir, parentSessionId: 'test-session-' },
    });

    expect(created(res.body).parentSessionId).toBeUndefined();
  });

  it('drops a parent owned by someone else', async () => {
    // The new session's owner is undefined here (single-user), so a parent carrying
    // an owner is a mismatch — which is exactly the multi-user case of stapling your
    // session under another user's tab.
    (harness.ctx.sessions.get(PARENT_ID) as unknown as { owner?: string }).owner = 'someone-else';

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'child', mode: 'claude', workingDir, parentSessionId: PARENT_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(created(res.body).parentSessionId).toBeUndefined();
  });

  it('ignores an over-long header without failing the request', async () => {
    // The body field is schema-capped at 100; the header is not, so the resolver
    // caps it too rather than scanning an arbitrary string against every session.
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-codeman-parent-session': 'x'.repeat(500) },
      payload: { name: 'child', mode: 'claude', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(created(res.body).parentSessionId).toBeUndefined();
  });

  it('survives into the persisted state, so lineage outlives a restart', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'child', mode: 'claude', workingDir, parentSessionId: PARENT_ID },
    });

    const childId = created(res.body).id;
    const child = harness.ctx.sessions.get(childId) as unknown as {
      toState(): { parentSessionId?: string };
    };
    expect(child.toState().parentSessionId).toBe(PARENT_ID);
  });

  it("applies the same resolution on quick-start, the skill's usual spawn route", async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'lineagecase', mode: 'claude', parentSessionId: PARENT_ID },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = JSON.parse(res.body) as { sessionId: string };
    const child = harness.ctx.sessions.get(sessionId) as unknown as {
      toState(): { parentSessionId?: string };
    };
    expect(child.toState().parentSessionId).toBe(PARENT_ID);
  });

  it('drops an unresolvable parent on quick-start without failing the spawn', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'lineagecase2', mode: 'claude', parentSessionId: 'ghost-session-id' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = JSON.parse(res.body) as { sessionId: string };
    expect(sessionId).toBeTruthy();
    const child = harness.ctx.sessions.get(sessionId) as unknown as {
      toState(): { parentSessionId?: string };
    };
    expect(child.toState().parentSessionId).toBeUndefined();
  });

  it('never lets a session parent itself', async () => {
    // Only reachable through recovery (both values come off disk), but a self-edge
    // would draw a zero-length arc under one tab, so the Session ctor refuses it.
    const { Session } = await import('../../src/session.js');
    const s = new Session({ id: 'self-ref', workingDir, parentSessionId: 'self-ref' });
    expect(s.parentSessionId).toBeUndefined();
  });
});
