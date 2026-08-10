/**
 * @fileoverview Tests for the cross-session search route (COD-9).
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Covers query validation (400s), result shaping (grouped cards), caps,
 * exact-before-recency ranking, and that at least two distinct sources
 * (sessions + events) return results. Source data is injected via the mock
 * route context (sessions map, runSummaryTrackers map, attachment history).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSearchRoutes } from '../../src/web/routes/search-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { createMockRouteContext } from '../mocks/index.js';
import { RunSummaryTracker } from '../../src/run-summary.js';
import { resetHistorySessionIndex, setHistorySessionIndex } from '../../src/web/session-history-index.js';

type Ctx = ReturnType<typeof createMockRouteContext>;

async function harness(configure?: (ctx: Ctx) => void): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const app = Fastify({ logger: false });
  // Start from an empty session map so tests fully control the source data.
  const ctx = createMockRouteContext();
  ctx.sessions.clear();
  ctx.runSummaryTrackers.clear();
  configure?.(ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSearchRoutes(app, ctx as any);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

/** Minimal session-like object compatible with the route's reads. */
function fakeSession(opts: {
  id: string;
  name: string;
  workingDir: string;
  lastActivityAt?: number;
  attachmentHistory?: unknown[];
}) {
  return {
    id: opts.id,
    name: opts.name,
    workingDir: opts.workingDir,
    lastActivityAt: opts.lastActivityAt ?? 0,
    createdAt: 0,
    attachmentHistory: opts.attachmentHistory ?? [],
  };
}

describe('GET /api/search — validation', () => {
  it('400 on missing q', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/search' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('400 on empty q', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=' });
    expect(res.statusCode).toBe(400);
  });

  it('400 on oversized q (>200 chars)', async () => {
    const { app } = await harness();
    const q = 'x'.repeat(201);
    const res = await app.inject({ method: 'GET', url: `/api/search?q=${q}` });
    expect(res.statusCode).toBe(400);
  });

  it('400 on bad types value', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=foo&types=session,bogus' });
    expect(res.statusCode).toBe(400);
  });

  it('400 on non-numeric limit', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=foo&limit=abc' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/search — shaping & multi-source', () => {
  beforeEach(() => {});

  it('returns grouped results from sessions and events (two distinct sources)', async () => {
    const { app } = await harness((ctx) => {
      ctx.sessions.set(
        's1',
        fakeSession({ id: 's1', name: 'needle session', workingDir: '/home/u/proj', lastActivityAt: 100 }) as never
      );
      const tracker = new RunSummaryTracker('s2', 'Other session');
      tracker.addEvent('warning', 'info', 'found a needle', 'in the logs');
      ctx.runSummaryTrackers.set('s2', tracker);
      ctx.sessions.set(
        's2',
        fakeSession({ id: 's2', name: 'Other session', workingDir: '/x', lastActivityAt: 50 }) as never
      );
    });
    const res = await app.inject({ method: 'GET', url: '/api/search?q=needle' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const types = body.data.groups.map((g: { type: string }) => g.type);
    expect(types).toContain('session');
    expect(types).toContain('event');
    // Group order: sessions before events.
    expect(types.indexOf('session')).toBeLessThan(types.indexOf('event'));
    expect(body.data.totalResults).toBe(2);

    const sessionResult = body.data.groups.find((g: { type: string }) => g.type === 'session').results[0];
    expect(sessionResult.sessionId).toBe('s1');
    expect(sessionResult.sessionName).toBe('needle session');
    expect(typeof sessionResult.timestamp).toBe('number');
    expect(typeof sessionResult.snippet).toBe('string');
    expect(sessionResult.jumpTo).toEqual({ kind: 'session', sessionId: 's1' });
  });

  it('exposes file results via relativePath and never leaks an absolute path', async () => {
    const { app } = await harness((ctx) => {
      ctx.sessions.set(
        's1',
        fakeSession({
          id: 's1',
          name: 'Alpha',
          workingDir: '/home/u/proj',
          lastActivityAt: 1,
          attachmentHistory: [
            {
              id: 'item-1',
              sessionId: 's1',
              fileName: 'needle.txt',
              extension: 'txt',
              attachmentType: 'text',
              size: 10,
              mtimeMs: 0,
              timestamp: 5,
              source: 'detected',
              relativePath: 'docs/needle.txt',
              externalPath: '/home/u/secret/needle.txt',
            },
          ],
        }) as never
      );
    });
    const res = await app.inject({ method: 'GET', url: '/api/search?q=needle' });
    const body = JSON.parse(res.body);
    const fileGroup = body.data.groups.find((g: { type: string }) => g.type === 'file');
    expect(fileGroup).toBeTruthy();
    expect(fileGroup.results[0].jumpTo.relativePath).toBe('docs/needle.txt');
    // The server-private absolute/external path must never appear in the payload.
    expect(res.body).not.toContain('/home/u/secret');
  });

  it('ranks exact session-name matches before more-recent partial matches', async () => {
    const { app } = await harness((ctx) => {
      ctx.sessions.set(
        'exact-old',
        fakeSession({ id: 'exact-old', name: 'needle', workingDir: '/x', lastActivityAt: 1 }) as never
      );
      ctx.sessions.set(
        'partial-new',
        fakeSession({ id: 'partial-new', name: 'needle-haystack', workingDir: '/x', lastActivityAt: 9999 }) as never
      );
    });
    const res = await app.inject({ method: 'GET', url: '/api/search?q=needle' });
    const body = JSON.parse(res.body);
    const ids = body.data.groups[0].results.map((r: { sessionId: string }) => r.sessionId);
    expect(ids).toEqual(['exact-old', 'partial-new']);
  });
});

describe('GET /api/search — caps & filters', () => {
  it('respects the limit query param as a total cap', async () => {
    const { app } = await harness((ctx) => {
      for (let i = 0; i < 20; i++) {
        ctx.sessions.set(
          `s${i}`,
          fakeSession({ id: `s${i}`, name: `needle ${i}`, workingDir: '/x', lastActivityAt: i }) as never
        );
      }
    });
    const res = await app.inject({ method: 'GET', url: '/api/search?q=needle&limit=5' });
    const body = JSON.parse(res.body);
    expect(body.data.totalResults).toBe(5);
    expect(body.data.truncated).toBe(true);
  });

  it('filters by types when provided', async () => {
    const { app } = await harness((ctx) => {
      ctx.sessions.set(
        's1',
        fakeSession({ id: 's1', name: 'needle session', workingDir: '/x', lastActivityAt: 1 }) as never
      );
      const tracker = new RunSummaryTracker('s1', 'needle session');
      tracker.addEvent('warning', 'info', 'needle event', '');
      ctx.runSummaryTrackers.set('s1', tracker);
    });
    const res = await app.inject({ method: 'GET', url: '/api/search?q=needle&types=event' });
    const body = JSON.parse(res.body);
    const types = body.data.groups.map((g: { type: string }) => g.type);
    expect(types).toEqual(['event']);
  });
});

// Issue #261: with 3 live sessions and ~35 past ones, searching a past project's
// folder name matched nothing, the corpus was the live session map alone. Past
// sessions now arrive from the out-of-band history index snapshot.
describe('GET /api/search: past sessions (history index)', () => {
  beforeEach(() => {
    resetHistorySessionIndex();
  });

  afterEach(() => {
    resetHistorySessionIndex();
    delete process.env.CODEMAN_MULTIUSER;
  });

  it('matches a past session by folder name with no live session at all', async () => {
    const { app } = await harness();
    setHistorySessionIndex([
      {
        sessionId: 'cod-9',
        name: 'w4-needlework',
        workingDir: '/home/u/projects/needlework',
        claudeSessionId: 'claude-uuid',
        timestamp: 1000,
        live: false,
      },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/search?q=needlework' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalResults).toBe(1);
    expect(body.data.groups[0].results[0].jumpTo).toMatchObject({
      kind: 'resume-session',
      sessionId: 'cod-9',
      claudeSessionId: 'claude-uuid',
    });
  });

  it('does not duplicate a session that is both live and in the snapshot', async () => {
    const { app } = await harness((ctx) => {
      ctx.sessions.set(
        'dup',
        fakeSession({ id: 'dup', name: 'needle live', workingDir: '/home/u/needle', lastActivityAt: 5 }) as never
      );
    });
    setHistorySessionIndex([
      { sessionId: 'dup', name: 'needle live', workingDir: '/home/u/needle', timestamp: 5, live: true },
    ]);
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/search?q=needle' })).body);
    expect(body.data.totalResults).toBe(1);
    // The live harvest wins, so the card still switches to the open tab.
    expect(body.data.groups[0].results[0].jumpTo.kind).toBe('session');
  });

  it('multi-user: a non-admin sees neither another user’s past session nor unowned host-wide history', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: unknown }).authUser = { username: 'bob', role: 'user' };
    });
    const ctx = createMockRouteContext();
    ctx.sessions.clear();
    ctx.runSummaryTrackers.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSearchRoutes(app, ctx as any);
    installRouteErrorHandler(app);
    await app.ready();

    setHistorySessionIndex([
      {
        sessionId: 'mine',
        name: 'needle-bob',
        workingDir: '/home/u/needle-bob',
        timestamp: 3,
        owner: 'bob',
        live: false,
      },
      {
        sessionId: 'hers',
        name: 'needle-alice',
        workingDir: '/home/u/needle-alice',
        timestamp: 2,
        owner: 'alice',
        live: false,
      },
      // Host-wide transcript row: no owning session, so admin-only, the same
      // rule GET /api/sessions/unified applies when it drops history for non-admins.
      { sessionId: 'hostwide', name: 'needle-host', workingDir: '/srv/needle-host', timestamp: 1, live: false },
    ]);

    const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/search?q=needle' })).body);
    expect(body.data.groups[0].results.map((r: { sessionId: string }) => r.sessionId)).toEqual(['mine']);
    await app.close();
  });
});
