/**
 * @fileoverview Tests for PUT /api/session-order (global tab-order sync, COD-131).
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Asserts the uniform envelope contract:
 *   SUCCESS -> 2xx, { success: true, data: { order } }
 *   ERROR   -> 4xx/5xx, { success: false, error, errorCode }
 * and that the order is persisted to the (mock) StateStore + broadcast over SSE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';

// registerSessionRoutes pulls in session.js which can shell out; stub the bits
// that would touch the OS at import/registration time. None are needed by the
// session-order handler itself, but the module imports them.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function buildHarness(): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx as unknown as Parameters<typeof registerSessionRoutes>[1]);

  // Mirror production's uniform-envelope preSerialization hook (server.ts).
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

describe('PUT /api/session-order', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('persists the order and returns it in the envelope', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: ['a', 'b', 'c'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ success: true, data: { order: ['a', 'b', 'c'] } });
    // Persisted to the store.
    expect(harness.ctx.store.setSessionOrder).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(harness.ctx.store.getSessionOrder()).toEqual(['a', 'b', 'c']);
    // Broadcast over SSE.
    expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:orderChanged', { order: ['a', 'b', 'c'] });
  });

  it('preserves a server-only id (unknown to the pushing device) at the end', async () => {
    // Seed the store with an order containing a server-only id "z".
    harness.ctx.store.setSessionOrder(['a', 'z', 'b']);
    (harness.ctx.broadcast as ReturnType<typeof vi.fn>).mockClear();

    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: ['b', 'a'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Incoming order wins, server-only "z" falls to the end.
    expect(body).toEqual({ success: true, data: { order: ['b', 'a', 'z'] } });
    expect(harness.ctx.store.getSessionOrder()).toEqual(['b', 'a', 'z']);
    expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:orderChanged', { order: ['b', 'a', 'z'] });
  });

  it('normalizes junk input (dedup + drop empties) before persisting', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: ['a', 'a', '', 'b'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { order: ['a', 'b'] } });
  });

  it('rejects a non-array order with a 4xx envelope', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: 'nope' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(harness.ctx.store.setSessionOrder).not.toHaveBeenCalled();
  });
});
