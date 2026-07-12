/**
 * @fileoverview Route tests for GET /api/sessions/unified (COD-121).
 *
 * Uses app.inject() with a local envelope harness (mirrors the production
 * preSerialization wrap so bodies appear as { success: true, data }). The
 * default mock ctx has testMode=true (handler short-circuits to empty); tests
 * that exercise the real merge path flip testMode off and stub the extra
 * read-only methods the handler calls (store.getState, mux.getSessionsWithStats).
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';

// Keep the handler's IO fast + deterministic: stub the lifecycle log query so it
// never reads the real ~/.codeman/session-lifecycle.jsonl, and point HOME at an
// empty temp dir so the ~/.claude/projects transcript scan is a no-op.
vi.mock('../../src/session-lifecycle-log.js', async (orig) => {
  const actual = await orig<typeof import('../../src/session-lifecycle-log.js')>();
  return {
    ...actual,
    getLifecycleLog: () => ({ query: async () => [] }) as unknown as ReturnType<typeof actual.getLifecycleLog>,
  };
});

import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

let tmpHome: string;
let prevHome: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cod121-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome; // empty home → no ~/.claude/projects → fast empty scan
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createEnvelopeHarness(ctx: MockRouteContext): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerSessionRoutes(app, ctx as never);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

/** Flip the default mock into "real" mode and stub the extra reads the handler makes. */
function makeLiveCtx(): MockRouteContext {
  const ctx = createMockRouteContext();
  // Real merge path (handler short-circuits when testMode is true).
  (ctx as { testMode: boolean }).testMode = false;
  // store.getState().sessions — the handler reads persisted sessions here.
  (ctx.store as { getState?: () => unknown }).getState = vi.fn(() => ({ sessions: {} }));
  // mux.getSessionsWithStats — optional; provide an empty list so the merge runs.
  (ctx.mux as { getSessionsWithStats?: () => Promise<unknown[]> }).getSessionsWithStats = vi.fn(async () => []);
  return ctx;
}

describe('GET /api/sessions/unified', () => {
  let harness: LocalHarness;

  afterEach(async () => {
    if (harness) await harness.app.close();
    // Drop any per-test transcript fixtures so other tests see an empty home.
    rmSync(join(tmpHome, '.claude'), { recursive: true, force: true });
  });

  it('returns the {sessions,total} envelope with default (testMode) ctx', async () => {
    harness = await createEnvelopeHarness(createMockRouteContext());
    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/unified' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.sessions)).toBe(true);
    expect(typeof body.data.total).toBe('number');
  });

  it('surfaces seeded live sessions when testMode is off', async () => {
    // The default mock pre-populates one live session: 'test-session-1'.
    harness = await createEnvelopeHarness(makeLiveCtx());
    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/unified' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.data.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids).toContain('test-session-1');
    expect(body.data.total).toBeGreaterThanOrEqual(1);
  });

  it('filters with ?q=', async () => {
    harness = await createEnvelopeHarness(makeLiveCtx());
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/sessions/unified?q=no-such-session-xyz',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.total).toBe(0);
    expect(body.data.sessions).toHaveLength(0);
  });

  it('caps results with ?limit=', async () => {
    harness = await createEnvelopeHarness(makeLiveCtx());
    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/unified?limit=0' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // limit clamps to a minimum of 1, so at most 1 row is returned.
    expect(body.data.sessions.length).toBeLessThanOrEqual(1);
  });

  it('folds a resumed session transcript (claudeSessionId != id) into ONE row', async () => {
    // Seed a real transcript fixture keyed by the Claude conversation UUID
    // (the .jsonl filename stem), like a resumed session leaves behind.
    const uuid = 'aabbccdd-1111-2222-3333-444455556666';
    const projDir = join(tmpHome, '.claude', 'projects', '-tmp-test-workdir');
    mkdirSync(projDir, { recursive: true });
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'resumed prompt' } }) + '\n';
    writeFileSync(join(projDir, `${uuid}.jsonl`), line.repeat(60)); // >4000 bytes so the scanner keeps it

    const ctx = makeLiveCtx();
    // Resumed session: the live Codeman session owns that conversation UUID.
    const live = ctx.sessions.get('test-session-1') as unknown as { claudeSessionId?: string };
    live.claudeSessionId = uuid;
    harness = await createEnvelopeHarness(ctx);

    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/unified' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.sessions as Array<{ sessionId: string; sources: string[] }>;
    // No separate history-only row keyed by the conversation UUID…
    expect(rows.map((r) => r.sessionId)).not.toContain(uuid);
    // …the transcript merged into the owning live session instead.
    const row = rows.find((r) => r.sessionId === 'test-session-1');
    expect(row).toBeDefined();
    expect(row!.sources).toContain('live');
    expect(row!.sources).toContain('history');
  });
});
