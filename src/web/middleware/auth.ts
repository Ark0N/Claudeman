/**
 * @fileoverview Authentication and security middleware.
 *
 * Extracted from server.ts setupRoutes() — handles:
 * - HTTP Basic Auth with session cookies
 * - Rate limiting (per-IP failure tracking)
 * - Security headers (CSP, X-Frame-Options, HSTS)
 * - CORS (localhost only)
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StaleExpirationMap } from '../../utils/index.js';
import type { AuthSessionRecord } from '../ports/auth-port.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import {
  AUTH_SESSION_TTL_MS,
  MAX_AUTH_SESSIONS,
  AUTH_FAILURE_MAX,
  AUTH_FAILURE_WINDOW_MS,
} from '../../config/auth-config.js';
import { getHookSecret, HOOK_SECRET_HEADER } from '../../config/hook-secret.js';

// Auth session cookie name
export const AUTH_COOKIE_NAME = 'codeman_session';

/** State returned from registerAuthMiddleware for cleanup in server stop() */
interface AuthState {
  authSessions: StaleExpirationMap<string, AuthSessionRecord> | null;
  authFailures: StaleExpirationMap<string, number> | null;
  qrAuthFailures: StaleExpirationMap<string, number> | null;
  hookSecretFailures: StaleExpirationMap<string, number> | null;
}

/**
 * Register HTTP Basic Auth middleware with session cookies and rate limiting.
 * Only active when CODEMAN_PASSWORD is set.
 *
 * The `/api/hook-event` + `/api/status-telemetry` localhost bypass requires the
 * shared hook secret unconditionally (COD-91) — see the onRequest hook below.
 *
 * @returns AuthState for lifecycle management (dispose on server stop)
 */
export function registerAuthMiddleware(app: FastifyInstance, https: boolean): AuthState {
  const state: AuthState = {
    authSessions: null,
    authFailures: null,
    qrAuthFailures: null,
    hookSecretFailures: null,
  };

  const authPassword = process.env.CODEMAN_PASSWORD;
  if (!authPassword) return state;

  const authUsername = process.env.CODEMAN_USERNAME || 'admin';
  const expectedHeader = 'Basic ' + Buffer.from(`${authUsername}:${authPassword}`).toString('base64');

  // Session token store — active sessions extend TTL on access
  state.authSessions = new StaleExpirationMap<string, AuthSessionRecord>({
    ttlMs: AUTH_SESSION_TTL_MS,
    refreshOnGet: true,
  });

  // Failure counter per IP — decay naturally after 15 minutes
  state.authFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  // Separate QR auth failure counter — independent from Basic Auth failures
  state.qrAuthFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  // Separate hook-secret failure counter (COD-54). MUST NOT share authFailures:
  // legacy (pre-secret) hook configs fire constantly from 127.0.0.1, and counting
  // their 401s against the shared bucket would 429 every cookie-less request from
  // loopback — locking out the Basic-Auth login path (and, through a tunnel, every
  // client, since tunneled traffic also arrives as 127.0.0.1).
  state.hookSecretFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  const authSessions = state.authSessions;
  const authFailures = state.authFailures;
  const hookSecretFailures = state.hookSecretFailures;

  function sendAuthRateLimit(
    reply: FastifyReply,
    clientIp: string,
    failures: StaleExpirationMap<string, number> = authFailures
  ): void {
    const remainingMs = failures.getRemainingTtl(clientIp) ?? AUTH_FAILURE_WINDOW_MS;
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    reply.header('Retry-After', String(retryAfterSeconds));
    reply.code(429).send('Too Many Requests — try again later');
  }

  app.addHook('onRequest', (req, reply, done) => {
    // Hook events + statusline telemetry come from local Claude Code (curl from
    // localhost) — no Basic-Auth credentials available. Validated downstream by
    // HookEventSchema / StatusTelemetrySchema. Same loopback+hook-secret gate.
    //
    // COD-54: the bare localhost bypass is unsafe while a tunnel is running, because
    // `cloudflared --url http://127.0.0.1:port` proxies internet traffic INTO the
    // loopback origin, so a tunneled request arrives with req.ip === 127.0.0.1 and
    // would pass. COD-91: require the shared hook secret on the loopback bypass
    // UNCONDITIONALLY (not just while the managed tunnel is up). Codeman can't detect
    // a user's own loopback reverse proxy (their own `cloudflared --url`, `tailscale
    // serve`, nginx → 127.0.0.1), so tunnel-gating left that path with the unsafe plain
    // bypass. Managed-session hooks always present the secret (X-Codeman-Hook-Secret,
    // from $CODEMAN_HOOK_SECRET_FILE — generated for every instance), so requiring it
    // always closes the gap without breaking the legitimate hook channel.
    if ((req.url === '/api/hook-event' || req.url === '/api/status-telemetry') && req.method === 'POST') {
      const ip = req.ip;
      const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (isLoopback) {
        // Always require the shared secret (constant-time compare).
        const presented = Buffer.from(req.headers[HOOK_SECRET_HEADER.toLowerCase()]?.toString() ?? '');
        const expected = Buffer.from(getHookSecret());
        if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
          done();
          return;
        }
        // Wrong/absent secret — rate-limit per IP in the DEDICATED hook bucket
        // (never authFailures, which would lock out the login path).
        const hookIp = req.ip;
        const hookFailures = hookSecretFailures.get(hookIp) ?? 0;
        if (hookFailures >= AUTH_FAILURE_MAX) {
          sendAuthRateLimit(reply, hookIp, hookSecretFailures);
          return;
        }
        hookSecretFailures.set(hookIp, hookFailures + 1);
        reply.code(401).send('Unauthorized: hook secret required');
        return;
      }
      // Non-localhost hook requests fall through to normal auth
    }

    // QR auth path — handled by the route itself (token validation + rate limiting)
    if (req.url?.startsWith('/q/')) {
      done();
      return;
    }

    const clientIp = req.ip;

    // Check session cookie first (avoids re-sending credentials on every request)
    // Use get() instead of has() so refreshOnGet extends the TTL on active sessions
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken && authSessions.get(sessionToken) !== undefined) {
      // Sliding cookie: re-issue on every authenticated request so the browser
      // cookie lifetime tracks the server-side sliding TTL (refreshOnGet above).
      // Without this the cookie has a fixed lifetime from login; the browser
      // drops it mid-use, the next request arrives cookie-less and falls through
      // to Basic Auth — popping the native username/password dialog, which reads
      // as a random logout while actively working.
      reply.setCookie(AUTH_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        maxAge: AUTH_SESSION_TTL_MS / 1000, // seconds
        path: '/',
      });
      done();
      return;
    }

    // Check Basic Auth header (timing-safe comparison to prevent side-channel attacks)
    const auth = req.headers.authorization;
    const authBuf = Buffer.from(auth ?? '');
    const expectedBuf = Buffer.from(expectedHeader);
    if (authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf)) {
      // Issue session token cookie so browser doesn't need to re-send credentials
      const token = randomBytes(32).toString('hex');

      // Evict oldest if at capacity (prevent unbounded growth)
      if (authSessions.size >= MAX_AUTH_SESSIONS) {
        const oldestKey = authSessions.keys().next().value;
        if (oldestKey !== undefined) authSessions.delete(oldestKey);
      }

      authSessions.set(token, {
        ip: clientIp,
        ua: req.headers['user-agent'] ?? '',
        createdAt: Date.now(),
        method: 'basic',
      });

      // Reset failure count on successful auth
      authFailures.delete(clientIp);

      reply.setCookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        maxAge: AUTH_SESSION_TTL_MS / 1000, // seconds
        path: '/',
      });
      done();
      return;
    }

    // Rate limit only requests that failed to authenticate on this attempt.
    const failures = authFailures.get(clientIp) ?? 0;
    if (failures >= AUTH_FAILURE_MAX) {
      sendAuthRateLimit(reply, clientIp);
      return;
    }

    // Auth failed — track failure count
    authFailures.set(clientIp, failures + 1);

    reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
    reply.code(401).send('Unauthorized');
  });

  return state;
}

/** Methods that don't change server state and so skip the cross-site Origin check. */
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Register the anti-DNS-rebinding Host allowlist + cross-site (CSRF) Origin guard.
 *
 * This protects the API even on the default no-password install, where there is no
 * cookie/credential to gate on. It must be registered BEFORE the auth middleware so
 * forged cross-site or DNS-rebound requests are rejected up front. `getPolicy` is
 * evaluated per request so a tunnel started at runtime is reflected immediately.
 *
 * - Every request: the `Host` header must be in the allowlist (blocks DNS rebinding,
 *   where a custom domain is rebound to 127.0.0.1 but still sends its own name).
 * - State-changing methods: the `Origin` (when the client sends one — i.e. a browser)
 *   must be same-site (blocks cross-site CSRF, including the text/plain simple-request
 *   trick). Non-browser clients (curl, Claude Code hooks) omit Origin and pass.
 *
 * WebSocket upgrades are validated separately in the ws route handler.
 */
export function registerHostGuard(app: FastifyInstance, getPolicy: () => HostPolicy): void {
  app.addHook('onRequest', (req, reply, done) => {
    const policy = getPolicy();
    if (!isAllowedRequestHost(req.headers.host, policy)) {
      reply.code(403).send('Forbidden: host not allowed');
      return;
    }
    if (!SAFE_HTTP_METHODS.has(req.method) && !isAllowedRequestOrigin(req.headers.origin, policy)) {
      reply.code(403).send('Forbidden: cross-site request blocked');
      return;
    }
    done();
  });
}

/**
 * Register security headers and CORS middleware on every response.
 */
export function registerSecurityHeaders(app: FastifyInstance, https: boolean): void {
  // Gesture-control overlay (opt-in via CODEMAN_GESTURE=1) runs MediaPipe, which
  // needs WebAssembly eval (script-src) and blob workers (worker-src). Its wasm
  // runtime + model are self-hosted under /gesture/ (same-origin, covered by
  // 'self'), so no CDN connect-src entries are needed. OFF by default so the
  // production CSP is byte-for-byte unchanged.
  const gesture = process.env.CODEMAN_GESTURE === '1';
  const scriptSrc =
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net" + (gesture ? " 'wasm-unsafe-eval'" : '');
  const connectSrc = "connect-src 'self' wss://api.deepgram.com";
  // blob: workers are needed unconditionally: terminal-ui's _safeYield tick
  // worker (throttling escape) is created from a Blob URL. Without this, every
  // page load logs a CSP violation and the worker leg of _safeYield is dead.
  // Risk is minimal — only same-origin scripts (already governed by script-src)
  // can construct blob workers.
  const workerSrc = "; worker-src 'self' blob:";
  const csp =
    `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; ` +
    `img-src 'self' data: blob:; ${connectSrc}; font-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'self'${workerSrc}`;

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Content-Security-Policy', csp);
    if (https) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // CORS: restrict to same-origin (localhost) only
    const origin = req.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
          reply.header('Access-Control-Allow-Origin', origin);
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          reply.header('Access-Control-Max-Age', '86400');
        }
      } catch {
        // Invalid origin header — do not set CORS headers
      }
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
      done();
      return;
    }

    done();
  });
}
