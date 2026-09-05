/**
 * @fileoverview Capability tokens for the web-tab proxy.
 *
 * The proxy cannot authenticate on Codeman's session cookie. A sandboxed iframe
 * (no `allow-same-origin`) runs in an OPAQUE origin, so every request it makes is
 * cross-site: the `SameSite=lax` `codeman_session` cookie is not sent, and its
 * non-GET requests and WebSocket upgrades arrive with `Origin: null`, which the
 * host guard rejects by design.
 *
 * So `/webview/:cap/*` authenticates on an unguessable capability minted by an
 * already-authenticated `POST /api/webviews/:id/open`. Properties that make this
 * safe to exempt from the cookie/Origin checks:
 *
 * - 128 bits of `randomBytes` entropy, base64url, never derived from anything.
 * - Held in memory only. A restart invalidates every outstanding capability.
 * - Rolling TTL: refreshed on use, expired after inactivity, and revoked outright
 *   on logout, admin logout and user deletion (`revokeOwner`).
 * - Bound to the minting user, so multi-user ownership survives the exemption.
 * - Grants exactly one thing: relaying bytes to that one saved URL. It reaches no
 *   session, no file, no API surface.
 */

import { randomBytes } from 'node:crypto';
import { StaleExpirationMap } from './utils/index.js';
import { MAX_WEBVIEW_CAPABILITIES, WEBVIEW_CAPABILITY_TTL_MS } from './config/webview-limits.js';

export interface WebviewCapabilityRecord {
  webviewId: string;
  /** Username that minted it (multi-user); undefined in single-user mode. */
  owner?: string;
  createdAt: number;
}

export class WebviewCapabilityStore {
  private readonly capabilities: StaleExpirationMap<string, WebviewCapabilityRecord>;
  /** Reverse index so re-opening a webview reuses its capability instead of leaking one per click. */
  private readonly byWebview = new Map<string, string>();

  constructor(ttlMs: number = WEBVIEW_CAPABILITY_TTL_MS) {
    this.capabilities = new StaleExpirationMap<string, WebviewCapabilityRecord>({
      ttlMs,
      refreshOnGet: true,
      onExpire: (_token, record) => {
        const current = this.byWebview.get(record.webviewId);
        if (current !== undefined) this.byWebview.delete(record.webviewId);
      },
    });
  }

  /** Mint (or reuse) a capability for a webview. Returns the token. */
  mint(webviewId: string, owner?: string): string {
    const existing = this.byWebview.get(webviewId);
    if (existing) {
      const record = this.capabilities.get(existing);
      // Reuse only while the record is live AND still belongs to the same identity.
      if (record && record.owner === owner) return existing;
      this.capabilities.delete(existing);
      this.byWebview.delete(webviewId);
    }

    // Bound growth: a client that never reuses tokens must not grow this forever.
    if (this.capabilities.size >= MAX_WEBVIEW_CAPABILITIES) this.capabilities.cleanup();

    const token = randomBytes(24).toString('base64url');
    this.capabilities.set(token, { webviewId, owner, createdAt: Date.now() });
    this.byWebview.set(webviewId, token);
    return token;
  }

  /** Resolve a capability, refreshing its TTL. Returns undefined when unknown or expired. */
  resolve(token: string): WebviewCapabilityRecord | undefined {
    if (!token) return undefined;
    return this.capabilities.get(token);
  }

  /** Revoke every capability for a webview (called on delete/edit). */
  revokeWebview(webviewId: string): void {
    const token = this.byWebview.get(webviewId);
    if (token) {
      this.capabilities.delete(token);
      this.byWebview.delete(webviewId);
    }
  }

  /**
   * Revoke every capability bound to an identity. Called from `POST /api/logout`
   * (the caller's own identity, which in single-user mode is `undefined`, i.e.
   * every capability there is), from the admin logout route, and from user
   * deletion.
   *
   * ⚠️ This method shipped for two releases with NO caller while its docstring
   * claimed logout invoked it. The rolling TTL is refreshed on every use, so a
   * proxy URL that leaked (browser history, a shared screenshot, a dashboard with
   * a loose referrer policy) stayed valid indefinitely as long as something kept
   * polling it. Logging out is the user's one deliberate "invalidate what I
   * opened" gesture, and it has to reach here; `test/webview-capability-revocation.test.ts`
   * pins each call site.
   *
   * @returns how many capabilities were revoked (for the admin audit line).
   */
  revokeOwner(owner: string | undefined): number {
    let revoked = 0;
    for (const [webviewId, token] of [...this.byWebview]) {
      const record = this.capabilities.peek(token);
      if (record?.owner === owner) {
        this.capabilities.delete(token);
        this.byWebview.delete(webviewId);
        revoked++;
      }
    }
    return revoked;
  }

  get size(): number {
    return this.capabilities.size;
  }

  dispose(): void {
    this.capabilities.dispose();
    this.byWebview.clear();
  }
}

/**
 * Process-wide capability store.
 *
 * A singleton rather than an injected dependency because two unrelated layers must
 * agree on it: the proxy routes that mint and consume capabilities, and the auth
 * middleware, which has to recognize a valid capability to know that a
 * `/webview/...` request is legitimately exempt from the cookie and Origin checks.
 * Threading a store through the auth middleware's construction just to answer that
 * one question would be worse. The map's cleanup timer is `unref`'d, so holding
 * this at module scope does not keep the process alive.
 */
export const webviewCapabilities = new WebviewCapabilityStore();
