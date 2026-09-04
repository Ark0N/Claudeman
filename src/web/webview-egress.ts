/**
 * @fileoverview Guarded egress for the web-tab proxy: the IO half of the policy in
 * `webview-egress-policy.ts`.
 *
 * Three outbound paths exist for a saved dashboard URL (the "Test" probe, the
 * HTTP proxy, the WebSocket relay), and all three must judge the RESOLVED address
 * rather than the hostname string, or a name pointing at 169.254.169.254 (an
 * attacker's own DNS, or `metadata.google.internal` on GCP) walks straight past
 * a literal-only check. So:
 *
 * - `createEgressLookup()` is a `net.connect`-shaped `lookup` that resolves with
 *   `all: true` and refuses when ANY returned address is blocked (Happy Eyeballs
 *   may otherwise pick the one we did not inspect).
 * - `webviewFetch()` runs undici's own `fetch` through an `Agent` whose connector
 *   uses that lookup. undici's fetch rather than Node's global one, and undici's
 *   Agent rather than a dispatcher handed to the global fetch, so the two are
 *   always the same undici version: Node bundles its own copy, and a mismatched
 *   dispatch protocol between the two fails in ways no test here would catch.
 * - The WebSocket relay passes the same lookup to `ws`, which forwards it to
 *   `http.request`.
 *
 * ⚠️ A lookup hook never sees an IP LITERAL: Node's `net.connect` skips DNS for
 * those. Every caller therefore runs `blockedWebviewHostReason()` on the URL's
 * hostname synchronously BEFORE connecting, and `webviewFetch()` does it for its
 * own callers. Neither half is redundant.
 */

import { promises as dns, type LookupAddress, type LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';
import { blockedWebviewHostReason, isBlockedEgressAddress } from './webview-egress-policy.js';

export const EGRESS_BLOCKED_CODE = 'CODEMAN_EGRESS_BLOCKED';

/** Thrown (or delivered as the lookup error) when a target resolves into a blocked range. */
export class WebviewEgressBlockedError extends Error {
  readonly code = EGRESS_BLOCKED_CODE;
  constructor(reason: string) {
    super(`Blocked: ${reason}; the web-tab proxy never relays to link-local or cloud-metadata addresses`);
    this.name = 'WebviewEgressBlockedError';
  }
}

/**
 * The refusal message when `err`, or anything in its `cause` chain, is an egress
 * refusal; null otherwise. undici's fetch wraps a connect failure as
 * `TypeError('fetch failed', { cause })`, so the interesting error is one level
 * down, and callers want ITS message, not "fetch failed".
 */
export function egressBlockedReason(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === EGRESS_BLOCKED_CODE) {
      return typeof candidate.message === 'string' ? candidate.message : 'Blocked by egress policy';
    }
    current = candidate.cause;
  }
  return null;
}

/** Boolean form of `egressBlockedReason()`. */
export function isEgressBlockedError(err: unknown): boolean {
  return egressBlockedReason(err) !== null;
}

/** `net.connect`'s `lookup` signature, which undici's connector and `ws` both forward to it. */
export type EgressLookup = LookupFunction;

/** Resolver seam for tests: what the lookup consults for a name's addresses. */
export type ResolveAll = (hostname: string, options: LookupOptions) => Promise<LookupAddress[]>;

const defaultResolveAll: ResolveAll = (hostname, options) => {
  const family = typeof options.family === 'string' ? Number(options.family.replace(/^IPv/i, '')) : options.family;
  return dns.lookup(hostname, {
    ...(family === 4 || family === 6 ? { family } : {}),
    ...(options.hints !== undefined ? { hints: options.hints } : {}),
    all: true,
  });
};

/**
 * Build a `lookup` for `net.connect` / undici's connector / `ws` that refuses
 * blocked resolved addresses. Every address is inspected, not just the first:
 * with `autoSelectFamily` Node races the whole list.
 */
export function createEgressLookup(resolve: ResolveAll = defaultResolveAll): EgressLookup {
  return (hostname, options, callback) => {
    // Node's callback type carries a non-optional address; on error `net` reads
    // only `err`, so the placeholder values are never looked at.
    const fail = (err: NodeJS.ErrnoException) => callback(err, '', 0);
    resolve(hostname, options ?? {}).then(
      (addresses) => {
        const blocked = addresses.find((entry) => isBlockedEgressAddress(entry.address));
        if (blocked) {
          fail(new WebviewEgressBlockedError(`${hostname} resolves to ${blocked.address}`));
          return;
        }
        if (options?.all) {
          callback(null, addresses, 0);
          return;
        }
        const first = addresses[0];
        if (!first) {
          const notFound: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          notFound.code = 'ENOTFOUND';
          fail(notFound);
          return;
        }
        callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => fail(err)
    );
  };
}

/** Process-wide lookup for the WebSocket relay (and anything else `net`-shaped). */
export const webviewEgressLookup: EgressLookup = createEgressLookup();

/**
 * An undici `Agent` whose connections resolve through `lookup`. Exported as a
 * factory so a test can inject a resolver and prove the hook is honoured
 * end-to-end; production uses the lazily-built singleton below.
 */
export function createWebviewDispatcher(lookup: EgressLookup = webviewEgressLookup): Agent {
  return new Agent({ connect: { lookup } });
}

let dispatcher: Agent | undefined;
function webviewDispatcher(): Agent {
  dispatcher ??= createWebviewDispatcher();
  return dispatcher;
}

/**
 * `fetch` for dashboard targets. Refuses a blocked IP literal synchronously (the
 * lookup hook never sees one) and routes everything else through the guarded
 * Agent, where a name resolving into a blocked range fails the connect with a
 * `WebviewEgressBlockedError` as the `cause` of undici's `fetch failed` TypeError.
 * Check either shape with `isEgressBlockedError()`.
 */
export function webviewFetch(target: URL, init: RequestInit = {}): Promise<Response> {
  const reason = blockedWebviewHostReason(target.hostname);
  if (reason) return Promise.reject(new WebviewEgressBlockedError(reason));
  return undiciFetch(target.href, { ...init, dispatcher: webviewDispatcher() });
}
