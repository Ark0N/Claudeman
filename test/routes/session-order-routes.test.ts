/**
 * @fileoverview Tests for the synchronized legacy PUT /api/session-order endpoint.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Asserts the uniform envelope contract:
 *   SUCCESS -> 2xx, { success: true, data: { order } }
 *   ERROR   -> 4xx/5xx, { success: false, error, errorCode }
 * Legacy callers are routed through the authenticated owner-scoped tab-layout service.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { TabLayoutValidationError } from '../../src/tab-layout.js';

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

async function buildHarness(authUser = { username: 'alice', role: 'user' as const }): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  app.addHook('onRequest', async (req) => {
    (req as unknown as { authUser: typeof authUser }).authUser = authUser;
  });

  const ctx = createMockRouteContext();
  Object.assign(ctx.tabLayouts, {
    putLegacyOrder: vi.fn(async (_actor: unknown, order: string[]) => ({
      order: [...order],
      changedOwnerOrders: {},
      globalOrder: [...order],
      globalChanged: true,
    })),
  });
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
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
    vi.unstubAllEnvs();
  });

  it('routes a regular legacy PUT through the authenticated owner layout service', async () => {
    vi.mocked(harness.ctx.tabLayouts.putLegacyOrder).mockResolvedValueOnce({
      order: ['a', 'b'],
      changedOwnerOrders: { alice: ['a', 'b'] },
      globalOrder: ['a', 'b'],
      globalChanged: true,
    });
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: ['b', 'a'] },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx.tabLayouts.putLegacyOrder).toHaveBeenCalledWith({ owner: 'alice', isAdmin: false }, ['b', 'a']);
    expect(res.json().data.order).toEqual(['a', 'b']);
  });

  it('uses the machine-wide admin bridge for an admin caller', async () => {
    await harness.app.close();
    harness = await buildHarness({ username: 'root', role: 'admin' });
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: ['b', 'a'] },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx.tabLayouts.putLegacyOrder).toHaveBeenCalledWith({ owner: 'root', isAdmin: true }, ['b', 'a']);
  });

  it('rejects malformed bodies before invoking the service', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: 'nope' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(harness.ctx.tabLayouts.putLegacyOrder).not.toHaveBeenCalled();
  });

  it('maps owner-boundary validation failures to INVALID_INPUT', async () => {
    vi.mocked(harness.ctx.tabLayouts.putLegacyOrder).mockRejectedValueOnce(
      new TabLayoutValidationError('session is not owned by layout owner: foreign')
    );
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: ['foreign'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      success: false,
      errorCode: ApiErrorCode.INVALID_INPUT,
    });
  });
});
