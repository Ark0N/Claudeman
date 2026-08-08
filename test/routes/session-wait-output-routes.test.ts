/**
 * @fileoverview Route tests for `GET /api/sessions/:id/wait-output`.
 *
 * Same 200-on-timeout contract and same `data.wait` envelope as `/wait`. The
 * additional things pinned here:
 * - matching is LITERAL, and a `regex` parameter is rejected rather than ignored,
 *   so an agent that assumed herdr's `--regex` cannot silently wait on the wrong thing;
 * - `from=buffer` scans what already scrolled past, bounded to a tail of the buffer,
 *   and is charged against the waiter cap BEFORE it materializes that buffer;
 * - a chunk-straddling match still resolves, since PTY chunking is arbitrary;
 * - a client that hangs up frees its waiter instead of holding it to the timeout.
 *
 * Plan: docs/agent-control-plan.md
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { registerSessionRoutes, _resetPaneLivenessState } from '../../src/web/routes/session-routes.js';
import { createSessionListeners, attachSessionListeners } from '../../src/web/session-listener-wiring.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { MAX_MATCH_LENGTH, MAX_BUFFER_SCAN_BYTES, MAX_WAIT_MS } from '../../src/config/agent-wait.js';

// Distinct per file on purpose: the three wait suites share the process-wide
// `sessionWaits` singleton, so a common id let one file's leftover waiter be counted
// by another's assertion. Failed only in a 5-file run, which is how CI runs them.
const SESSION_ID = 'wait-output-session';
const URL = `/api/sessions/${SESSION_ID}/wait-output`;

afterEach(() => {
  // Deliberately not `cancelEverything()`: it latches the registry's stopped flag,
  // which would leave every later test in this file talking to a dead registry.
  sessionWaits.cancelAll(SESSION_ID);
  _resetPaneLivenessState();
});

/** Mirrors production's errorCode-to-status mapping; without it negative cases pass vacuously. */
async function harness(): Promise<{ app: FastifyInstance; ctx: MockRouteContext; rawReplies: ServerResponse[] }> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  const rawReplies: ServerResponse[] = [];
  app.addHook('onRequest', async (req, reply) => {
    // The RESPONSE, because that is what the handler's hang-up detection listens to.
    rawReplies.push(reply.raw);
  });

  registerSessionRoutes(app, ctx as never);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    const p = payload as { success?: unknown; errorCode?: unknown } | null;
    if (p && typeof p === 'object' && p.success === false && reply.statusCode === 200) {
      if (typeof p.errorCode === 'string') reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
    }
    return done(null, payload);
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx, rawReplies };
}

describe('GET /api/sessions/:id/wait-output', () => {
  it('resolves when the string appears on the stream', async () => {
    const { app } = await harness();
    const pending = app.inject({ method: 'GET', url: `${URL}?match=BUILD%20OK` });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.outputWaiterCount(SESSION_ID)).toBe(1);
    sessionWaits.notifyOutput(SESSION_ID, 'running tests...\nBUILD OK\n');

    const body = (await pending).json();
    expect(body.success).toBe(true);
    expect(body.data.wait.matched).toBe(true);
    expect(body.data.wait.immediate).toBe(false);
    expect(body.data.wait.snippet).toContain('BUILD OK');
    expect(body.data.wait.match).toBe('BUILD OK');
    expect(body.data.sessionId).toBe(SESSION_ID);
  });

  it('uses the same data.wait envelope as /wait, so one client helper reads both', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `${URL}?match=never&timeout=1` });

    const { data } = res.json();
    expect(Object.keys(data).sort()).toEqual(['limitPaused', 'sessionId', 'status', 'wait']);
    expect(data.matched).toBeUndefined();
    expect(data.wait.matched).toBe(false);
    expect(data.wait.aborted).toBe(false);
  });

  it('sends Cache-Control: no-store', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `${URL}?match=never&timeout=1` });

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('echoes the effective timeout after clamping', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.terminalBuffer = 'BUILD OK\n';

    const res = await app.inject({ method: 'GET', url: `${URL}?match=BUILD%20OK&from=buffer&timeout=1800000` });
    expect(res.json().data.wait.timeoutMs).toBe(MAX_WAIT_MS);
  });

  it('strips ANSI before matching, so colored output still matches', async () => {
    const { app } = await harness();
    const pending = app.inject({ method: 'GET', url: `${URL}?match=BUILD%20OK` });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifyOutput(SESSION_ID, '\x1b[32mBUILD\x1b[0m OK\n');

    expect((await pending).json().data.wait.matched).toBe(true);
  });

  it('matches across a chunk boundary', async () => {
    const { app } = await harness();
    const pending = app.inject({ method: 'GET', url: `${URL}?match=BUILD%20OK` });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifyOutput(SESSION_ID, 'trailing text BUIL');
    sessionWaits.notifyOutput(SESSION_ID, 'D OK done');

    expect((await pending).json().data.wait.matched).toBe(true);
  });

  it('is case-sensitive by default and honors nocase=1', async () => {
    const { app } = await harness();

    const strict = app.inject({ method: 'GET', url: `${URL}?match=build%20ok&timeout=1` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifyOutput(SESSION_ID, 'BUILD OK');
    expect((await strict).json().data.wait.timedOut).toBe(true);

    const loose = app.inject({ method: 'GET', url: `${URL}?match=build%20ok&nocase=1` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifyOutput(SESSION_ID, 'BUILD OK');
    const body = (await loose).json();
    expect(body.data.wait.matched).toBe(true);
    // Reported in the terminal's own casing, not the caller's.
    expect(body.data.wait.snippet).toContain('BUILD OK');
  });

  it('from=buffer resolves immediately against output that already scrolled past', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.terminalBuffer = 'earlier output\n\x1b[32mBUILD OK\x1b[0m\n';

    const res = await app.inject({ method: 'GET', url: `${URL}?match=BUILD%20OK&from=buffer` });
    const body = res.json();
    expect(body.data.wait.matched).toBe(true);
    expect(body.data.wait.immediate).toBe(true);
    expect(body.data.wait.waitedMs).toBe(0);
    expect(sessionWaits.totalWaiterCount()).toBe(0);
  });

  it('from=buffer only scans a bounded tail', async () => {
    const { app, ctx } = await harness();
    // Old marker pushed past the scan window by newer output.
    ctx.sessions.get(SESSION_ID)!.terminalBuffer = `ANCIENT${'x'.repeat(MAX_BUFFER_SCAN_BYTES + 1000)}`;

    const res = await app.inject({ method: 'GET', url: `${URL}?match=ANCIENT&from=buffer&timeout=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.wait.timedOut).toBe(true);
  });

  it('defaults to from=now, ignoring what is already in the buffer', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.terminalBuffer = 'BUILD OK happened before you asked\n';

    const res = await app.inject({ method: 'GET', url: `${URL}?match=BUILD%20OK&timeout=1` });
    expect(res.json().data.wait.timedOut).toBe(true);
  });

  it('answers 200 with timedOut on timeout, never an error status', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `${URL}?match=never&timeout=1` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.wait.timedOut).toBe(true);
    expect(body.data.wait.matched).toBe(false);
    expect(body.data.wait.snippet).toBeNull();
  });

  it('resolves with ended when the session goes away mid-wait', async () => {
    const { app } = await harness();
    const pending = app.inject({ method: 'GET', url: `${URL}?match=never` });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.cancelAll(SESSION_ID);

    const body = (await pending).json();
    expect(body.success).toBe(true);
    expect(body.data.wait.ended).toBe(true);
    expect(body.data.wait.matched).toBe(false);
  });

  it('frees its waiter when the RESPONSE socket closes early', async () => {
    // The injected response is genuinely destroyed by then, so the freed slot is what
    // this can assert; the wire-level behaviour is pinned over real HTTP in
    // session-input-wait.test.ts.
    const { app, rawReplies } = await harness();
    const pending = app.inject({ method: 'GET', url: `${URL}?match=never&timeout=600000` }).then(
      () => 'completed',
      () => 'destroyed'
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.outputWaiterCount(SESSION_ID)).toBe(1);

    rawReplies[rawReplies.length - 1].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sessionWaits.outputWaiterCount(SESSION_ID)).toBe(0);
    expect(await pending).toBe('destroyed');
  });

  it('rejects a regex parameter instead of silently ignoring it', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `${URL}?match=x&regex=%5EBUILD.*OK%24` });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errorCode).toBe('INVALID_INPUT');
    expect(body.error).toContain('match=');
  });

  it('requires match', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: URL });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
  });

  it('rejects an empty or oversized match, and says which parameter was wrong', async () => {
    const { app } = await harness();

    const empty = await app.inject({ method: 'GET', url: `${URL}?match=` });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toContain('match');

    const huge = await app.inject({ method: 'GET', url: `${URL}?match=${'x'.repeat(MAX_MATCH_LENGTH + 1)}` });
    expect(huge.statusCode).toBe(400);
    expect(huge.json().error).toContain('match');
  });

  it('rejects a non-numeric timeout', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `${URL}?match=x&timeout=soon` });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    expect(res.json().error).toContain('timeout');
  });

  it('rejects an unknown from value', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `${URL}?match=x&from=history` });

    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown session', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope/wait-output?match=x' });

    expect(res.statusCode).toBe(404);
    expect(res.json().success).toBe(false);
  });

  it('output waiters share the session waiter cap with signal waiters', async () => {
    const { app } = await harness();
    const pendings = [];
    for (let i = 0; i < 8; i++) {
      pendings.push(app.inject({ method: 'GET', url: `${URL}?match=never${i}` }));
    }
    for (let i = 0; i < 8; i++) {
      pendings.push(app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sessionWaits.waiterCount(SESSION_ID)).toBe(16);

    const overflow = await app.inject({ method: 'GET', url: `${URL}?match=one-too-many` });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().errorCode).toBe('SESSION_BUSY');

    sessionWaits.cancelAll(SESSION_ID);
    await Promise.all(pendings);
  });

  it('checks the cap BEFORE materializing the terminal buffer', async () => {
    // `session.terminalBuffer` joins the whole 32MB accumulator. Paying that for a
    // request that is about to be refused turns the cap into an amplifier: a caller
    // already at the limit can loop `from=buffer` at full speed and never register a
    // waiter, so nothing bounds the work.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    const bufferReads = vi.fn(() => 'nothing to see');
    Object.defineProperty(session, 'terminalBuffer', { get: bufferReads, configurable: true });

    const pendings = [];
    for (let i = 0; i < 16; i++) {
      pendings.push(app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sessionWaits.waiterCount(SESSION_ID)).toBe(16);

    const overflow = await app.inject({ method: 'GET', url: `${URL}?match=x&from=buffer` });
    expect(overflow.json().errorCode).toBe('SESSION_BUSY');
    expect(bufferReads).not.toHaveBeenCalled();

    sessionWaits.cancelAll(SESSION_ID);
    await Promise.all(pendings);
  });
});

/**
 * The LIVE-STREAM half, wired the way production wires it.
 *
 * Everything above drives `sessionWaits.notifyOutput()` directly, which is the
 * registry's API, not the path a real session takes. Deleting the one line that
 * connects them — `sessionWaits.notifyOutput(session.id, data)` in the `terminal`
 * listener — left all four wait suites green and survived a full `test:ci` sweep, so
 * `wait-output?from=now` (the entire live mode, and the one the skill's recipes are
 * built on) could ship severed with nothing to show for it.
 *
 * These go through `createSessionListeners` so the wiring itself is what is pinned.
 */
describe('GET /api/sessions/:id/wait-output: fed by the real terminal listener', () => {
  function stubDeps() {
    return {
      broadcast: vi.fn(),
      batchTerminalData: vi.fn(),
      batchTaskUpdate: vi.fn(),
      broadcastSessionStateDebounced: vi.fn(),
      sendPushNotifications: vi.fn(),
      persistSessionState: vi.fn(),
      getSessionStateWithRespawn: vi.fn(() => ({})),
      getRunSummaryTracker: vi.fn(() => undefined),
      stopTranscriptWatcher: vi.fn(),
      cleanupSessionBatches: vi.fn(),
      cancelPersistDebounce: vi.fn(),
      removeRunSummaryTracker: vi.fn(),
      removeSessionListenerRefs: vi.fn(),
      cleanupRespawnOnExit: vi.fn(),
      getStore: vi.fn(() => ({ updateRalphState: vi.fn() })),
      registerAttachment: vi.fn(async () => {}),
    };
  }

  it('matches output emitted by the session, not injected into the registry', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    const deps = stubDeps();
    attachSessionListeners(session as never, createSessionListeners(session as never, deps as never));

    const pending = app.inject({ method: 'GET', url: `${URL}?match=LIVE_STREAM_HIT` });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // What a PTY chunk actually does: the session emits `terminal`.
    session.simulateTerminalOutput('$ echo LIVE_STREAM_HIT\r\nLIVE_STREAM_HIT\r\n');

    const body = (await pending).json();
    expect(body.data.wait.matched).toBe(true);
    expect(body.data.wait.snippet).toContain('LIVE_STREAM_HIT');
    // The listener must still forward to the SSE batcher; the wait feed is additive.
    expect(deps.batchTerminalData).toHaveBeenCalled();
  });

  it('matches across chunk boundaries through the listener', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    attachSessionListeners(session as never, createSessionListeners(session as never, stubDeps() as never));

    const pending = app.inject({ method: 'GET', url: `${URL}?match=SPLIT_MARKER` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.simulateTerminalOutput('noise SPLIT_');
    session.simulateTerminalOutput('MARKER more noise');

    expect((await pending).json().data.wait.matched).toBe(true);
  });

  it('strips ANSI on the way through the listener', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    attachSessionListeners(session as never, createSessionListeners(session as never, stubDeps() as never));

    const pending = app.inject({ method: 'GET', url: `${URL}?match=COLORED%20HIT` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.simulateAnsiOutput('COLORED HIT');

    expect((await pending).json().data.wait.matched).toBe(true);
  });
});

describe('GET /api/sessions/:id/wait-output: a dead tmux worker', () => {
  it('releases an output waiter when the worker dies while it is parked', async () => {
    // The feed simply stops: no exit event, no further chunks, nothing to match.
    const { app, ctx } = await harness();
    let dead = false;
    (ctx.mux as unknown as { isPaneDead: () => boolean }).isPaneDead = () => dead;

    const pending = app.inject({ method: 'GET', url: `${URL}?match=NEVER&timeout=600000` });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionWaits.outputWaiterCount(SESSION_ID)).toBe(1);

    dead = true;
    const body = (await pending).json();
    expect(body.data.wait.ended).toBe(true);
    expect(body.data.wait.timedOut).toBe(false);
    expect(sessionWaits.outputWaiterCount(SESSION_ID)).toBe(0);
  }, 10_000);

  it('an oversized timeout clamps rather than 400ing', async () => {
    const { app, ctx } = await harness();
    // Resolve from the buffer so the assertion is about the clamp, not a real wait.
    ctx.sessions.get(SESSION_ID)!.terminalBuffer = 'ALREADY_THERE\n';
    const res = await app.inject({
      method: 'GET',
      url: `${URL}?match=ALREADY_THERE&from=buffer&timeout=99999999`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.wait.timeoutMs).toBe(MAX_WAIT_MS);
  });
});
