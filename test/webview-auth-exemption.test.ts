/**
 * The web-tab proxy is exempt from Codeman's cookie auth and its cross-site Origin
 * guard, because a sandboxed dashboard iframe is opaque-origin: it sends no session
 * cookie and its writes arrive with `Origin: null`. The capability in the path is
 * the credential instead.
 *
 * That exemption is the security-sensitive part of this feature, so these tests pin
 * its EDGES: it must apply to a live capability and to nothing else. A regression
 * here would be an unauthenticated hole into an agent-spawning API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerAuthMiddleware, registerHostGuard, registerSecurityHeaders } from '../src/web/middleware/auth.js';
import { webviewCapabilities } from '../src/webview-capabilities.js';
import type { HostPolicy } from '../src/web/network-auth-policy.js';

const POLICY: HostPolicy = { allowedHosts: [], allowLan: true };
const PASSWORD = 'test-password';

let app: FastifyInstance;
let capability: string;
let savedPassword: string | undefined;

beforeEach(async () => {
  savedPassword = process.env.CODEMAN_PASSWORD;
  // The middleware reads this at registration time; auth is inert without it.
  process.env.CODEMAN_PASSWORD = PASSWORD;

  capability = webviewCapabilities.mint('webview-under-test', undefined);

  app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  // Same order as server.ts (host guard → auth → security headers), so hook
  // interactions are exercised for real. The OPTIONS short-circuit lives in
  // registerSecurityHeaders and is part of what these tests pin.
  registerHostGuard(app, () => POLICY);
  registerAuthMiddleware(app, false);
  registerSecurityHeaders(app, false);

  // Stand-ins for the real surfaces, so a reachable route means auth let it through.
  app.all('/webview/:cap/*', async () => ({ proxied: true }));
  app.all('/api/sessions', async () => ({ sensitive: true }));
  app.get('/', async () => 'app shell');
  app.get('/static/app.js', async () => 'asset');
  app.get('/webviewfoo/bar', async () => 'lookalike');
  await app.ready();
});

afterEach(async () => {
  await app.close();
  webviewCapabilities.revokeWebview('webview-under-test');
  if (savedPassword === undefined) delete process.env.CODEMAN_PASSWORD;
  else process.env.CODEMAN_PASSWORD = savedPassword;
});

describe('the exemption applies to a live capability', () => {
  it('lets an unauthenticated GET through on the proxy path', async () => {
    const res = await app.inject({ method: 'GET', url: `/webview/${capability}/static/app.js` });
    expect(res.statusCode).toBe(200);
  });

  it('lets a write through despite Origin: null, which a sandboxed iframe always sends', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webview/${capability}/login`,
      headers: { origin: 'null' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('lets a CORS preflight reach the proxy instead of the global 204 short-circuit', async () => {
    // registerSecurityHeaders answers every OPTIONS with a bare 204, which carries
    // no Access-Control-Allow-Origin for the `null` origin a sandboxed frame sends.
    // The proxy must get the chance to answer with real CORS headers, or every
    // dashboard fetch fails its preflight.
    const res = await app.inject({
      method: 'OPTIONS',
      url: `/webview/${capability}/api/stats`,
      headers: { origin: 'null', 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(200); // reached the stand-in route, not the 204 hook
  });

  it('still short-circuits OPTIONS everywhere else', async () => {
    // Authenticated, because the auth hook runs before the security-headers hook
    // and would otherwise 401 first. With credentials the 204 short-circuit is
    // reached, proving it is intact for every non-webview path.
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/sessions',
      headers: {
        origin: 'null',
        'access-control-request-method': 'GET',
        authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a root-absolute asset when the Referer identifies the dashboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/static/app.js',
      headers: { referer: `http://localhost/webview/${capability}/panel` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('the exemption does NOT widen anywhere else', () => {
  it('rejects an unauthenticated request with no capability at all', async () => {
    expect((await app.inject({ method: 'GET', url: '/static/app.js' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
  });

  it('rejects a well-formed but UNKNOWN capability', async () => {
    const res = await app.inject({ method: 'GET', url: `/webview/${'Z'.repeat(32)}/x` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked capability immediately', async () => {
    webviewCapabilities.revokeWebview('webview-under-test');
    const res = await app.inject({ method: 'GET', url: `/webview/${capability}/x` });
    expect(res.statusCode).toBe(401);
  });

  it('does not match a lookalike prefix', async () => {
    expect((await app.inject({ method: 'GET', url: '/webviewfoo/bar' })).statusCode).toBe(401);
  });

  it('NEVER exempts the Codeman API, even with a valid capability in the Referer', async () => {
    // This is the hole the Referer form would open if it were not path-fenced.
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { referer: `http://localhost/webview/${capability}/panel` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not let the Referer form carry a WRITE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/static/app.js',
      headers: { referer: `http://localhost/webview/${capability}/panel`, origin: 'null' },
      payload: {},
    });
    // Blocked as cross-site by the Origin guard, or as unauthenticated. Either is fine;
    // what matters is that it is not 200.
    expect(res.statusCode).not.toBe(200);
  });

  it('still blocks a genuinely cross-site write to the API', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: 'https://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('authenticated access is unaffected', () => {
  const basic = 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64');

  it('normal Basic auth still reaches the app', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: basic } });
    expect(res.statusCode).toBe(200);
  });

  it('a wrong password is still rejected', async () => {
    const wrong = 'Basic ' + Buffer.from('admin:nope').toString('base64');
    expect((await app.inject({ method: 'GET', url: '/', headers: { authorization: wrong } })).statusCode).toBe(401);
  });
});
