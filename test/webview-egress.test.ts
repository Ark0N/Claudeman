/**
 * Guarded egress for the web-tab proxy (src/web/webview-egress.ts).
 *
 * The policy is judged on RESOLVED addresses through a `lookup` hook, because a
 * hostname-string check cannot see where `metadata.google.internal`, or an
 * attacker's own DNS name, actually points. These tests inject a resolver and
 * drive a real undici Agent against a real local HTTP server, so what is pinned
 * is that undici honours the hook end-to-end, not that a helper returns a value.
 * Port: ephemeral (server.listen(0)).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { fetch as undiciFetch } from 'undici';
import {
  createEgressLookup,
  createWebviewDispatcher,
  egressBlockedReason,
  isEgressBlockedError,
  webviewFetch,
  WebviewEgressBlockedError,
  type EgressLookup,
} from '../src/web/webview-egress.js';

type LookupCallbackArgs = Parameters<Parameters<EgressLookup>[2]>;

const NAMES: Record<string, LookupAddress[]> = {
  'dash.test': [{ address: '127.0.0.1', family: 4 }],
  'meta.test': [{ address: '169.254.169.254', family: 4 }],
  // Happy Eyeballs shape: one fine address and one blocked one.
  'mixed.test': [
    { address: '127.0.0.1', family: 4 },
    { address: 'fd00:ec2::254', family: 6 },
  ],
  'nowhere.test': [],
};

const fakeResolve = async (hostname: string): Promise<LookupAddress[]> => {
  const found = NAMES[hostname];
  if (!found) {
    const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  return found;
};

function callLookup(hostname: string, options: { all?: boolean }): Promise<LookupCallbackArgs> {
  const lookup = createEgressLookup(fakeResolve);
  return new Promise((resolve) => lookup(hostname, options, (...args) => resolve(args)));
}

describe('createEgressLookup', () => {
  it("answers in net.connect's single-address shape when `all` is not requested", async () => {
    const [err, address, family] = await callLookup('dash.test', {});
    expect(err).toBeNull();
    expect(address).toBe('127.0.0.1');
    expect(family).toBe(4);
  });

  it('answers the array shape autoSelectFamily asks for', async () => {
    const [err, addresses] = await callLookup('dash.test', { all: true });
    expect(err).toBeNull();
    expect(addresses).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });

  it('refuses a name that resolves into a blocked range, naming both', async () => {
    const [err] = await callLookup('meta.test', {});
    expect(err).toBeInstanceOf(WebviewEgressBlockedError);
    expect(err?.message).toContain('meta.test resolves to 169.254.169.254');
  });

  it('refuses when ANY resolved address is blocked, not just the first', async () => {
    const [err] = await callLookup('mixed.test', { all: true });
    expect(err).toBeInstanceOf(WebviewEgressBlockedError);
  });

  it('passes resolver errors and empty answers through as ordinary DNS failures', async () => {
    const [notFound] = await callLookup('unknown.test', {});
    expect(notFound?.code).toBe('ENOTFOUND');
    expect(isEgressBlockedError(notFound)).toBe(false);
    const [empty] = await callLookup('nowhere.test', {});
    expect(empty?.code).toBe('ENOTFOUND');
  });
});

describe('guarded undici Agent (end-to-end against a local upstream)', () => {
  let upstream: Server;
  let port: number;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`served ${req.headers.host ?? ''}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    port = (upstream.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('connects through the hook: a name resolving to loopback reaches the server', async () => {
    const dispatcher = createWebviewDispatcher(createEgressLookup(fakeResolve));
    try {
      const res = await undiciFetch(`http://dash.test:${port}/`, { dispatcher });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`served dash.test:${port}`);
    } finally {
      await dispatcher.close();
    }
  });

  it('fails the connect when the name resolves into a blocked range, with the reason as the cause', async () => {
    const dispatcher = createWebviewDispatcher(createEgressLookup(fakeResolve));
    try {
      const attempt = undiciFetch(`http://meta.test:${port}/latest/meta-data/`, { dispatcher });
      await expect(attempt).rejects.toThrow();
      const err = await attempt.catch((e: unknown) => e);
      expect(isEgressBlockedError(err)).toBe(true);
      expect(egressBlockedReason(err)).toContain('169.254.169.254');
    } finally {
      await dispatcher.close();
    }
  });
});

describe('webviewFetch', () => {
  it('refuses a blocked IP literal synchronously, since net.connect never consults lookup for one', async () => {
    const attempt = webviewFetch(new URL('http://169.254.169.254/latest/meta-data/'));
    await expect(attempt).rejects.toBeInstanceOf(WebviewEgressBlockedError);
    const err = await attempt.catch((e: unknown) => e);
    expect(egressBlockedReason(err)).toMatch(/169\.254\.169\.254/);
  });

  it('refuses the bracketed IPv6 and the alias forms the same way', async () => {
    await expect(webviewFetch(new URL('http://[fd00:ec2::254]/'))).rejects.toBeInstanceOf(WebviewEgressBlockedError);
    await expect(webviewFetch(new URL('http://metadata.google.internal/'))).rejects.toBeInstanceOf(
      WebviewEgressBlockedError
    );
  });
});

describe('egressBlockedReason', () => {
  it('walks a cause chain and ignores unrelated errors', () => {
    const inner = new WebviewEgressBlockedError('x resolves to 169.254.1.1');
    const wrapped = new TypeError('fetch failed', { cause: inner });
    expect(egressBlockedReason(wrapped)).toBe(inner.message);
    expect(egressBlockedReason(new Error('ECONNREFUSED'))).toBeNull();
    expect(egressBlockedReason(undefined)).toBeNull();
  });
});
