/**
 * Limits and timeouts for web tabs (dashboards embedded as Codeman tabs).
 *
 * Every value here bounds something an untrusted-ish upstream controls: how many
 * dashboards can be saved, how long the server will wait on one, how much of a
 * response it will buffer before rewriting HTML, and how many sockets a single
 * dashboard may hold open. Env-overridable in the same style as the other config
 * modules.
 */

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Max saved webviews (per owner in multi-user mode). */
export const MAX_WEBVIEWS = envInt('CODEMAN_MAX_WEBVIEWS', 50);

/**
 * Max iframes kept mounted at once. Switching tabs must not reload a dashboard,
 * so frames stay alive while hidden; past this many, the least-recently-viewed
 * frame is evicted. Consumed by the frontend via `GET /api/webviews`.
 */
export const MAX_LIVE_WEBVIEW_FRAMES = envInt('CODEMAN_MAX_LIVE_WEBVIEW_FRAMES', 6);

/** How long a minted proxy capability stays valid (rolling, refreshed on use). */
export const WEBVIEW_CAPABILITY_TTL_MS = envInt('CODEMAN_WEBVIEW_CAPABILITY_TTL_MS', 12 * 60 * 60 * 1000);

/** Max concurrent capabilities held in memory before the oldest are dropped. */
export const MAX_WEBVIEW_CAPABILITIES = 200;

/**
 * How long a proxied HTTP request waits for the upstream's RESPONSE HEADERS.
 *
 * This bounds time-to-headers only, never an actively streaming body: the proxy
 * clears the timer the moment headers arrive (issue #237: the old 30s
 * `AbortSignal.timeout` bounded the whole fetch and killed slow AI/model endpoints
 * and long streams alike, as a silent 502). 300s because "the app is thinking" is
 * normal for the dashboards people proxy; abandoned upstreams are reclaimed by the
 * client-hangup abort, not by this value, so a generous default costs nothing.
 */
export const WEBVIEW_UPSTREAM_TIMEOUT_MS = envInt('CODEMAN_WEBVIEW_TIMEOUT_MS', 300_000);

/** Shorter timeout for the editor's "Test" probe, which a human is waiting on. */
export const WEBVIEW_PROBE_TIMEOUT_MS = envInt('CODEMAN_WEBVIEW_PROBE_TIMEOUT_MS', 8_000);

/**
 * WebSocket upgrade handshake timeout. Deliberately decoupled from
 * WEBVIEW_UPSTREAM_TIMEOUT_MS: a handshake is connection establishment, and waiting
 * minutes on one only delays the browser's reconnect logic. Matches the pre-#237
 * behavior (the handshake used to ride the 30s upstream timeout).
 */
export const WEBVIEW_WS_HANDSHAKE_TIMEOUT_MS = envInt('CODEMAN_WEBVIEW_WS_HANDSHAKE_TIMEOUT_MS', 30_000);

/**
 * Max bytes of an HTML response buffered for `<base>` injection and link
 * rewriting. Larger HTML documents stream through untouched: the rewrite is a
 * convenience, and buffering an unbounded upstream body is a memory hazard.
 */
export const MAX_WEBVIEW_HTML_REWRITE_BYTES = envInt('CODEMAN_MAX_WEBVIEW_HTML_BYTES', 8 * 1024 * 1024);

/** Max concurrent proxied WebSockets per webview (mirrors MAX_WS_PER_SESSION). */
export const MAX_WEBVIEW_SOCKETS = envInt('CODEMAN_MAX_WEBVIEW_SOCKETS', 8);

/** URL path prefix the proxy is mounted at. Single source of truth. */
export const WEBVIEW_PROXY_PREFIX = '/webview';
