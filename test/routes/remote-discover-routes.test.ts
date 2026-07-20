/**
 * @fileoverview COD-105 — GET /api/remote-hosts/:hostId/sessions discovery endpoint.
 *
 * The endpoint reads the saved host config by id, runs listRemoteCodemanSessions
 * (ssh-guarded under VITEST), and returns the discovered sessions in the
 * ApiResponse envelope. We mock the remote-hosts module so the test controls the
 * host record and the session list WITHOUT any real ssh / filesystem.
 *
 * Port: N/A (app.inject()).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import type { RemoteHost, RemoteSessionInfo } from '../../src/types.js';

// Mock the remote-hosts module: control readRemoteHosts + listRemoteCodemanSessions.
const mockHosts: RemoteHost[] = [];
let mockSessions: RemoteSessionInfo[] = [];
let lastListArg: unknown = undefined;

vi.mock('../../src/remote-hosts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote-hosts.js')>();
  return {
    ...actual,
    readRemoteHosts: vi.fn(async () => mockHosts),
    readRemoteCases: vi.fn(async () => []),
    listRemoteCodemanSessions: vi.fn(async (remote: unknown) => {
      lastListArg = remote;
      return mockSessions;
    }),
  };
});

vi.mock('../../src/templates/claude-md.js', () => ({
  generateClaudeMd: vi.fn(() => '# CLAUDE.md'),
}));
vi.mock('../../src/hooks-config.js', () => ({ writeHooksConfig: vi.fn(async () => {}) }));

import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';

async function createHarness(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
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
  const ctx = createMockRouteContext();
  registerCaseRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  await app.ready();
  return app;
}

describe('COD-105 GET /api/remote-hosts/:hostId/sessions', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createHarness();
    mockHosts.length = 0;
    mockSessions = [];
    lastListArg = undefined;
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns discovered sessions for a known host in the envelope', async () => {
    mockHosts.push({ id: 'aa-desktop', label: 'aa', host: '1.2.3.4', username: 'aakht', port: 2222 });
    mockSessions = [{ name: 'codeman-disco1', attached: false, created: 1700000000, windows: 1 }];

    const res = await app.inject({ method: 'GET', url: '/api/remote-hosts/aa-desktop/sessions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.sessions).toEqual([{ name: 'codeman-disco1', attached: false, created: 1700000000, windows: 1 }]);
    // The host config (incl. port) was threaded to the discovery call.
    expect((lastListArg as { host?: string; port?: number }).host).toBe('1.2.3.4');
    expect((lastListArg as { port?: number }).port).toBe(2222);
  });

  it('404s when the host id is unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/remote-hosts/nope/sessions' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe(ApiErrorCode.NOT_FOUND);
  });

  it('returns an empty list (not an error) when no sessions are discovered', async () => {
    mockHosts.push({ id: 'aa-desktop', label: 'aa', host: '1.2.3.4', username: 'aakht' });
    mockSessions = [];
    const res = await app.inject({ method: 'GET', url: '/api/remote-hosts/aa-desktop/sessions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.sessions).toEqual([]);
  });
});
