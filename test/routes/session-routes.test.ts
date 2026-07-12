/**
 * @fileoverview Tests for session route handlers.
 *
 * Uses app.inject() (Fastify's built-in test helper) — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * These tests assert the UNIFORM response envelope (stable HTTP contract):
 *   success -> 2xx, { success: true, data: <payload> }
 *   error   -> 4xx/5xx, { success: false, error, errorCode }
 * The production server applies this via a preSerialization hook (server.ts).
 * The shared route harness doesn't install it, so we build a local harness here
 * that mirrors production: the same preSerialization envelope hook + the shared
 * route error handler, so assertions match the real wire format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { Session } from '../../src/session.js';

// Mock execFile so the send-key route's `tmux` invocation is observable (not run for real).
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, execFile };
});

// In-memory remote store so remote-case tests can inject hosts/cases without real JSON files.
const remoteStore = vi.hoisted(() => ({
  hosts: [] as unknown[],
  cases: [] as unknown[],
  tmuxCheck: { ok: true, tmuxPath: '/usr/bin/tmux' } as { ok: boolean; tmuxPath?: string; error?: string },
}));
vi.mock('../../src/remote-hosts.js', async (orig) => {
  const actual = await orig<typeof import('../../src/remote-hosts.js')>();
  return {
    ...actual,
    readRemoteHosts: vi.fn(async () => remoteStore.hosts),
    readRemoteCases: vi.fn(async () => remoteStore.cases),
    // Stub the remote-tmux prereq probe so quick-start never shells out to ssh.
    checkRemoteTmuxAvailable: vi.fn(async () => remoteStore.tmuxCheck),
  };
});

import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Build a Fastify instance that mirrors production's uniform-envelope behavior
 * (server.ts preSerialization hook) so the test wire format matches the contract:
 * bare payloads become { success: true, data }, and { success:false } error
 * envelopes get the conventional HTTP status from their errorCode.
 */
async function createEnvelopeHarness(
  registerFn: (app: FastifyInstance, ctx: MockRouteContext) => void
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

  // Mirror production uniform response envelope (server.ts).
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
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

describe('session-routes', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    harness = await createEnvelopeHarness(registerSessionRoutes);
    // Reset remote store so tests start with empty hosts/cases and a passing tmux probe
    remoteStore.hosts = [];
    remoteStore.cases = [];
    remoteStore.tmuxCheck = { ok: true, tmuxPath: '/usr/bin/tmux' };
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== POST /api/sessions/:id/send-key ==========

  describe('POST /api/sessions/:id/send-key', () => {
    it('routes tmux send-keys through the dedicated Codeman socket (-L)', async () => {
      // Regression guard: bare `tmux` would hit the user's default server and never
      // find a session that lives only on the Codeman socket (#80 regression class).
      execFile.mockReset();
      execFile.mockImplementation((_bin: string, _argv: string[], _opts: unknown, cb: (e: Error | null) => void) =>
        cb(null)
      );

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'S-Enter' },
      });

      expect(res.statusCode).toBe(200);
      expect(execFile).toHaveBeenCalledTimes(1);
      const [bin, argv] = execFile.mock.calls[0];
      expect(bin).toBe('tmux');
      expect((argv as string[]).slice(0, 2)).toEqual(['-L', 'codeman']);
      expect(argv).toContain('send-keys');
      expect(argv).toContain('-H');
    });

    it('rejects keys outside the hex allowlist without invoking tmux', async () => {
      execFile.mockReset();
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'rm -rf' },
      });
      expect(JSON.parse(res.body).success).toBe(false);
      expect(execFile).not.toHaveBeenCalled();
    });
  });

  // ========== GET /api/sessions ==========

  describe('GET /api/sessions', () => {
    it('returns session list when sessions exist', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it('returns empty array when no sessions', async () => {
      harness.ctx.sessions.clear();
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data).toEqual([]);
    });
  });

  // ========== GET /api/sessions/:id ==========

  describe('GET /api/sessions/:id', () => {
    it('returns session state for existing session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.id).toBe(harness.ctx._sessionId);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });
  });

  // ========== DELETE /api/sessions/:id ==========

  describe('DELETE /api/sessions/:id', () => {
    it('deletes existing session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.cleanupSession).toHaveBeenCalledWith(harness.ctx._sessionId, true, 'user_delete');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== DELETE /api/sessions (delete all) ==========

  describe('DELETE /api/sessions', () => {
    it('deletes all sessions', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.killed).toBe(1);
      expect(harness.ctx.cleanupSession).toHaveBeenCalled();
    });
  });

  // ========== PUT /api/sessions/:id/name ==========

  describe('PUT /api/sessions/:id/name', () => {
    it('renames session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/name`,
        payload: { name: 'new-name' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('new-name');
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/sessions/nonexistent/name',
        payload: { name: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PUT /api/sessions/:id/color ==========

  describe('PUT /api/sessions/:id/color', () => {
    it('sets session color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'blue' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.color).toBe('blue');
    });

    it('rejects invalid color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'neon-rainbow' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/auto-resume ==========

  describe('POST /api/sessions/:id/auto-resume', () => {
    it('enables auto-resume on usage limit', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.autoResume.enabled).toBe(true);
      const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
      expect(session.setAutoResume).toHaveBeenCalledWith(true);
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('disables auto-resume', async () => {
      const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
      session.autoResumeEnabled = true;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.autoResume.enabled).toBe(false);
      expect(session.setAutoResume).toHaveBeenCalledWith(false);
    });

    it('rejects invalid body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
    });

    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/auto-resume',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/input ==========

  describe('POST /api/sessions/:id/input', () => {
    it('sends input to session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/input',
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects empty payload', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('applies a tagged (clientId, seq) input exactly once on redelivery', async () => {
      const url = `/api/sessions/${harness.ctx._sessionId}/input`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as any;
      session.writeBuffer.length = 0;

      const post = (payload: unknown) => harness.app.inject({ method: 'POST', url, payload });

      // First delivery of seq 1 — applied (200, written once).
      const first = await post({ input: 'prompt', seq: 1, clientId: 'cid-1' });
      expect(first.statusCode).toBe(200);

      // Redelivery of the SAME seq (client never saw the ACK) — still 200, but
      // must NOT write again.
      const dup = await post({ input: 'prompt', seq: 1, clientId: 'cid-1' });
      expect(dup.statusCode).toBe(200);

      // A genuinely new seq — applied.
      const next = await post({ input: '\r', seq: 2, clientId: 'cid-1' });
      expect(next.statusCode).toBe(200);

      expect(session.writeBuffer).toEqual(['prompt', '\r']);
    });

    it('always applies untagged input (curl/legacy, no dedup)', async () => {
      const url = `/api/sessions/${harness.ctx._sessionId}/input`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as any;
      session.writeBuffer.length = 0;

      const post = () => harness.app.inject({ method: 'POST', url, payload: { input: 'x' } });
      await post();
      await post();
      // No seq/clientId ⇒ no dedup ⇒ both writes land.
      expect(session.writeBuffer).toEqual(['x', 'x']);
    });
  });

  // ========== POST /api/sessions/:id/resize ==========

  describe('POST /api/sessions/:id/resize', () => {
    it('resizes session terminal', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: undefined });
    });

    it('passes viewport type through for resize arbitration', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 48, rows: 28, viewportType: 'mobile' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(48, 28, { viewportType: 'mobile', force: undefined });
    });

    it('passes force resize through for redraw requests', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40, force: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: true });
    });

    it('rejects cols exceeding max (500)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 501, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects rows exceeding max (200)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 80, rows: 201 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects zero dimensions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 0, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/terminal ==========

  describe('GET /api/sessions/:id/terminal', () => {
    it('returns terminal buffer', async () => {
      harness.ctx._session.terminalBuffer = 'hello world';
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBeDefined();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/terminal',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('prepends the live tmux pane buffer (cleared) before the byte history', async () => {
      harness.ctx._session.terminalBuffer = 'history-bytes';
      harness.ctx.mux.captureActivePaneBuffer = vi.fn(() => 'LIVE-PANE-FRAME');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const buf = JSON.parse(res.body).data.terminalBuffer as string;
      // history, then a viewport clear, then the live pane frame
      expect(buf).toContain('history-bytes');
      expect(buf).toContain('\x1b[H\x1b[2J');
      expect(buf).toContain('LIVE-PANE-FRAME');
      expect(buf.indexOf('history-bytes')).toBeLessThan(buf.indexOf('LIVE-PANE-FRAME'));
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName);
    });

    it('falls back to the byte history when no live pane buffer is available', async () => {
      harness.ctx._session.terminalBuffer = 'history-only';
      // Empty string (the test-mode return) and null both mean "no live frame".
      harness.ctx.mux.captureActivePaneBuffer = vi.fn(() => '');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const buf = JSON.parse(res.body).data.terminalBuffer as string;
      expect(buf).toContain('history-only');
      expect(buf).not.toContain('\x1b[H\x1b[2J');
    });
  });

  // ========== POST /api/sessions/:id/run ==========

  describe('POST /api/sessions/:id/run', () => {
    it('runs prompt on session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'do something' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('rejects empty prompt', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: '' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/run',
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/interactive ==========

  describe('POST /api/sessions/:id/interactive', () => {
    it('starts interactive mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/interactive',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    // COD-118: this endpoint is ALSO the frontend's automatic re-attach path, so it
    // must never clear a tripped PTY-exit breaker unless the request explicitly asks.
    it('does NOT clear the PTY-exit breaker on an automatic re-attach (no body)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.resetRespawnBreaker).not.toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('clears the PTY-exit breaker when the explicit restart flag is sent (COD-118)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { clearBreaker: true },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.resetRespawnBreaker).toHaveBeenCalledTimes(1);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('rejects a non-boolean clearBreaker flag', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { clearBreaker: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
      expect(harness.ctx._session.resetRespawnBreaker).not.toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).not.toHaveBeenCalled();
    });

    // COD-118: the wiring exit handler detaches ALL session listeners on PTY exit;
    // re-attach must restore them or later trips/output go unobserved.
    it('re-runs session listener wiring before starting', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
    });
  });

  // ========== POST /api/sessions/:id/shell ==========

  describe('POST /api/sessions/:id/shell', () => {
    it('starts shell mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startShell).toHaveBeenCalled();
      // COD-118: re-attach restores listener wiring detached by a prior PTY exit.
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/output ==========

  describe('GET /api/sessions/:id/output', () => {
    it('returns session output data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/output`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('textOutput');
      expect(body.data).toHaveProperty('messages');
      expect(body.data).toHaveProperty('errorBuffer');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/output',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/ralph-state ==========

  describe('GET /api/sessions/:id/ralph-state', () => {
    it('returns ralph state data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-state`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('loop');
      expect(body.data).toHaveProperty('todos');
      expect(body.data).toHaveProperty('todoStats');
    });
  });

  // ========== GET /api/sessions/:id/active-tools ==========

  describe('GET /api/sessions/:id/active-tools', () => {
    it('returns active tools', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/active-tools`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('tools');
    });
  });

  // ========== POST /api/logout ==========

  describe('POST /api/logout', () => {
    it('returns success', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/logout',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  // ========== GET /api/history/sessions ==========

  describe('GET /api/history/sessions', () => {
    it('returns sessions array', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveProperty('sessions');
      expect(Array.isArray(body.data.sessions)).toBe(true);
    });

    it('sessions have required fields', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      for (const session of body.data.sessions) {
        expect(session).toHaveProperty('sessionId');
        expect(session).toHaveProperty('workingDir');
        expect(session).toHaveProperty('projectKey');
        expect(session).toHaveProperty('sizeBytes');
        expect(session).toHaveProperty('lastModified');
        // sessionId must be a valid UUID
        expect(session.sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      }
    });

    it('sessions are sorted by lastModified descending', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      const dates = body.data.sessions.map((s: { lastModified: string }) => new Date(s.lastModified).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });

    it('returns at most 50 sessions', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      expect(body.data.sessions.length).toBeLessThanOrEqual(50);
    });
  });

  // ========== POST /api/sessions (with resumeSessionId) ==========

  describe('POST /api/sessions with resumeSessionId', () => {
    it('creates session from a remote case without local stat validation', async () => {
      // Remote cases go through /api/quick-start which skips local stat() of the workingDir.
      // /api/sessions always requires workingDir to exist on the local filesystem.
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          {
            id: 'gpu-box',
            label: 'GPU Box',
            host: '10.0.0.42',
            username: 'ubuntu',
            commands: { codex: 'exec codx personal' },
          },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'shell', name: 'Remote Shell' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.data.casePath).toBe('/home/ubuntu/work');
        const session = [...harness.ctx.sessions.values()].find((item) => item.id === body.data.sessionId);
        expect(session?.toState()).toMatchObject({
          workingDir: '/home/ubuntu/work',
          remote: expect.objectContaining({
            hostId: 'gpu-box',
            host: '10.0.0.42',
            username: 'ubuntu',
            remotePath: '/home/ubuntu/work',
            commands: { codex: 'exec codx personal' },
          }),
        });
      } finally {
        startShell.mockRestore();
      }
    });

    it('quick-start creates remote case sessions through ssh metadata', async () => {
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          {
            id: 'gpu-box',
            label: 'GPU Box',
            host: '10.0.0.42',
            username: 'ubuntu',
            commands: { codex: 'exec codx personal' },
          },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'shell' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.data.casePath).toBe('/home/ubuntu/work');
        const session = [...harness.ctx.sessions.values()].find((item) => item.id === body.data.sessionId);
        expect(session?.toState()).toMatchObject({
          workingDir: '/home/ubuntu/work',
          remote: expect.objectContaining({
            hostId: 'gpu-box',
            host: '10.0.0.42',
            username: 'ubuntu',
            remotePath: '/home/ubuntu/work',
          }),
        });
      } finally {
        startShell.mockRestore();
      }
    });

    it('rejects a remote quick-start that carries envOverrides (inert over ssh)', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'gpu-work', mode: 'claude', envOverrides: { CLAUDE_CODE_FOO: 'bar' } },
      });

      expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects a remote quick-start when the remote host lacks tmux', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];
      remoteStore.tmuxCheck = {
        ok: false,
        error: 'remote host 10.0.0.42 needs tmux installed for durable remote sessions',
      };

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'gpu-work', mode: 'shell' },
      });

      expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.OPERATION_FAILED });
    });

    it('does not run local codex availability check for a remote codex case', async () => {
      // A remote codex case must NOT be blocked by the LOCAL codex availability gate
      // (the CLI runs on the remote host). Probe is stubbed ok in remoteStore.tmuxCheck.
      const startInteractive = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: { codex: 'exec codx' } },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'codex' },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).success).toBe(true);
      } finally {
        startInteractive.mockRestore();
      }
    });

    it('creates session with valid resumeSessionId', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'resume-test',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
          resumeSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.session).toBeDefined();
    });

    it('rejects invalid resumeSessionId format', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'bad-resume',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
          resumeSessionId: 'not-a-uuid',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('creates session without resumeSessionId (optional field)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'no-resume',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });
});
