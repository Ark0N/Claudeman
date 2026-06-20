/**
 * @fileoverview Route tests for POST /api/sessions/:id/pin (COD-139).
 *
 * Pinning floats a session to the top of the unified session list. The route
 * sets the session's pin flag, persists it, and broadcasts session:pinned.
 * Uses app.inject() with the production-mirroring envelope harness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createEnvelopeHarness(): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
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

describe('POST /api/sessions/:id/pin', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('pins a session: sets state, persists, and broadcasts session:pinned', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/pin',
      payload: { pinned: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.pinned).toBe(true);
    expect(typeof body.data.pinnedAt).toBe('number');

    expect(harness.ctx._session.pinned).toBe(true);
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();
    const broadcastCalls = harness.ctx.broadcast.mock.calls.map((c) => c[0]);
    expect(broadcastCalls).toContain('session:pinned');
  });

  it('unpins a session and clears pinnedAt', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/pin',
      payload: { pinned: true },
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/pin',
      payload: { pinned: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.pinned).toBe(false);
    expect(body.data.pinnedAt).toBeUndefined();
    expect(harness.ctx._session.pinned).toBe(false);
  });

  it('is idempotent for an explicit pinned value', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/pin',
        payload: { pinned: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.pinned).toBe(true);
    }
    expect(harness.ctx._session.pinned).toBe(true);
  });

  it('returns 404 for an unknown session', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/does-not-exist/pin',
      payload: { pinned: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().success).toBe(false);
  });

  it('rejects a missing/invalid body with 400', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/pin',
      payload: { pinned: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });
});
