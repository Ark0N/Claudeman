/**
 * @fileoverview Owner-scoped tab-layout HTTP concurrency and validation contract.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTabLayoutRoutes } from '../../src/web/routes/tab-layout-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import type { TabLayout } from '../../src/tab-layout.js';

const layout = (version = 3): TabLayout => ({
  version,
  groups: [],
  ungrouped: [{ kind: 'session', id: 'mine' }],
  updatedAt: '2026-08-16T00:00:00.000Z',
});

async function harness(username?: string, role: 'admin' | 'user' = 'user') {
  const app = Fastify({ logger: false });
  if (username) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: { username: string; role: 'admin' | 'user' } }).authUser = { username, role };
    });
  }
  const service = {
    get: vi.fn(async () => layout()),
    put: vi.fn(async (_owner: string, desired: unknown, baseVersion: number) => ({
      status: 'updated' as const,
      layout: { ...(desired as TabLayout), version: baseVersion + 1 },
    })),
  };
  registerTabLayoutRoutes(app, { tabLayouts: service } as never);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, service };
}

afterEach(() => vi.unstubAllEnvs());

describe('tab layout routes', () => {
  it('maps single-user requests to @single and never accepts an owner override', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '0');
    const { app, service } = await harness();
    const response = await app.inject({ method: 'GET', url: '/api/tab-layout?owner=foreign' });
    expect(response.statusCode).toBe(200);
    expect(service.get).toHaveBeenCalledWith('@single');
    await app.close();
  });

  it('uses the authenticated username in multi-user mode, including for admins', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const { app, service } = await harness('admin-a', 'admin');
    await app.inject({ method: 'GET', url: '/api/tab-layout?owner=someone-else' });
    expect(service.get).toHaveBeenCalledWith('admin-a');
    await app.close();
  });

  it.each([2, 4])('returns 409 with the authoritative prepared layout when baseVersion=%s', async (baseVersion) => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const { app, service } = await harness('alice');
    service.put.mockResolvedValueOnce({ status: 'conflict', layout: layout(3) });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: { baseVersion, layout: layout(baseVersion) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().success).toBe(false);
    expect(response.json().errorCode).toBe('CONFLICT');
    expect(response.json().data.layout).toEqual(layout(3));
    expect(service.put).toHaveBeenCalledWith('alice', layout(baseVersion), baseVersion);
    await app.close();
  });

  it('rejects malformed writes before invoking the service', async () => {
    const { app, service } = await harness();
    const response = await app.inject({ method: 'PUT', url: '/api/tab-layout', payload: { baseVersion: -1 } });
    expect(response.statusCode).toBe(400);
    expect(service.put).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects extra write keys before invoking the service', async () => {
    const { app, service } = await harness();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: { baseVersion: 3, layout: layout(), owner: 'foreign' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errorCode).toBe('INVALID_INPUT');
    expect(service.put).not.toHaveBeenCalled();
    await app.close();
  });

  it('has an explicit conservative body limit', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: { baseVersion: 3, layout: layout(), padding: 'x'.repeat(140 * 1024) },
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });
});
