/**
 * @fileoverview Web tab (dashboard) types.
 *
 * A "webview" is a saved URL that Codeman renders as a tab alongside agent
 * sessions: Grafana on :3000, a Uptime-Kuma on :4000, an internal status page.
 * It is deliberately NOT a sixth `SessionMode`, it has no PTY, no tmux, no
 * respawn and no idle detection. Same reasoning that keeps Docker and remote-SSH
 * as case overlays rather than modes.
 *
 * Key exports:
 * - Webview, the persisted record (`~/.codeman/webviews.json`).
 * - WebviewEmbedMode, 'proxy' (served through Codeman's origin) or 'direct'
 *   (a plain cross-origin iframe, only viable for HTTPS targets that allow framing).
 * - WebviewProbe, the result of the server-side reachability/framing probe.
 * - WebviewOpenData, what `POST /api/webviews/:id/open` hands the browser.
 *
 * No I/O here. Persistence lives in `src/webview-store.ts`, capability minting in
 * `src/webview-capabilities.ts`, the proxy helpers in `src/web/webview-proxy.ts`.
 */

/**
 * How the browser should embed a webview.
 *
 * - `proxy`: the iframe points at `/webview/<capability>/` on Codeman's own
 *   origin and the server relays to the target. Required whenever the target is
 *   plain HTTP (an HTTPS Codeman page cannot embed it: mixed content) or refuses
 *   framing via `X-Frame-Options` / `frame-ancestors`.
 * - `direct`: the iframe points at the target URL itself. Cheaper, but only works
 *   for HTTPS targets that permit framing, and needs the target origin added to
 *   the page CSP's `frame-src`.
 */
export type WebviewEmbedMode = 'proxy' | 'direct';

/** A saved dashboard, persisted to `~/.codeman/webviews.json`. */
export interface Webview {
  id: string;
  /** Display name shown on the tab. */
  name: string;
  /** Absolute target URL. `http:` / `https:` only, never with embedded credentials. */
  url: string;
  /** Optional single-glyph tab icon (emoji or letter). */
  icon?: string;
  /** Default embed strategy for this dashboard. */
  embedMode: WebviewEmbedMode;
  /**
   * When false (the default) the iframe is sandboxed WITHOUT `allow-same-origin`,
   * so a proxied page runs in an opaque origin and cannot read the Codeman page or
   * call its API. Setting this to true trades that isolation for the page's own
   * cookies/localStorage, only for dashboards the user fully trusts.
   */
  trusted: boolean;
  /** Multi-user owner (username). Undefined in single-user mode. */
  owner?: string;
  createdAt: number;
  lastOpenedAt?: number;
}

/** Result of the server-side probe used by the "Test" button in the editor. */
export interface WebviewProbe {
  /** True when the server could complete an HTTP request to the target. */
  reachable: boolean;
  /** Upstream status code, when a response came back. */
  status?: number;
  /** Raw `X-Frame-Options` value, if the target sent one. */
  xFrameOptions?: string;
  /** The `frame-ancestors` directive extracted from the target's CSP, if any. */
  frameAncestors?: string;
  /** True when the target permits being framed cross-origin by this Codeman. */
  framable: boolean;
  /** Strategy the UI should default to for this URL. */
  recommendedMode: WebviewEmbedMode;
  /** Human-readable explanation of the recommendation (or the failure). */
  reason: string;
}

/** Payload of `POST /api/webviews/:id/open`. */
export interface WebviewOpenData {
  /** The webview being opened (echoed so the client can refresh its copy). */
  webview: Webview;
  /**
   * Same-origin path the iframe should load. Present for `proxy` mode only;
   * `direct` mode uses `webview.url` instead.
   */
  embedUrl?: string;
  /** Epoch ms at which the capability behind `embedUrl` stops working. */
  expiresAt?: number;
}
