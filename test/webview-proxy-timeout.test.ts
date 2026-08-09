/**
 * @fileoverview Issue #237: the webview proxy's upstream timeout bounds
 * TIME-TO-HEADERS only, is logged when it fires, and never kills a response that
 * is actively streaming.
 *
 * Uses app.inject() against the real registerWebviewRoutes with a real local
 * upstream http server on an ephemeral port (inject fakes only the inbound
 * request; the proxy's outbound fetch is real). Port: ephemeral (server.listen(0)).
 *
 * The timeout is shrunk via CODEMAN_WEBVIEW_TIMEOUT_MS inside vi.hoisted(), which
 * runs before the module graph loads (webview-limits reads the env at import).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';

const TIMEOUT_MS = vi.hoisted(() => {
  process.env.CODEMAN_WEBVIEW_TIMEOUT_MS = '400';
  return 400;
});

import { registerWebviewRoutes } from '../src/web/routes/webview-routes.js';
import { webviewCapabilities } from '../src/webview-capabilities.js';
import { writeWebviews } from '../src/webview-store.js';
import { getDataDir } from '../src/config/instance.js';
import type { EventPort } from '../src/web/ports/index.js';

const WEBVIEW_ID = 'wv-timeout-test';

let upstream: Server;
let upstreamPort: number;
let app: FastifyInstance;
let capability: string;

const eventPortStub: EventPort = {
  broadcast: vi.fn(),
  sendPushNotifications: vi.fn(),
  batchTerminalData: vi.fn(),
  broadcastSessionStateDebounced: vi.fn(),
  batchTaskUpdate: vi.fn(),
  getSseClientCount: vi.fn(() => 0),
};

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url === '/fast') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('quick');
      return;
    }
    if (req.url === '/slow-headers') {
      // Headers arrive AFTER the proxy's limit: this is the #237 repro shape
      // (an API endpoint thinking for longer than the timeout).
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('finally');
      }, TIMEOUT_MS + 700);
      return;
    }
    if (req.url === '/stream') {
      // Headers immediately, then a body that takes ~3x the limit to finish.
      // Under the old whole-fetch AbortSignal.timeout this died mid-stream.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('start;');
      let chunks = 0;
      const timer = setInterval(() => {
        chunks++;
        res.write(`chunk${chunks};`);
        if (chunks >= 4) {
          clearInterval(timer);
          res.end('done');
        }
      }, TIMEOUT_MS * 0.75);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (typeof address === 'object' && address) upstreamPort = address.port;

  await writeWebviews(getDataDir(), [
    {
      id: WEBVIEW_ID,
      name: 'timeout-under-test',
      url: `http://127.0.0.1:${upstreamPort}/`,
      embedMode: 'proxy',
      trusted: false,
      createdAt: Date.now(),
    },
  ]);
  capability = webviewCapabilities.mint(WEBVIEW_ID, undefined);

  app = Fastify({ logger: false });
  registerWebviewRoutes(app, eventPortStub);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  webviewCapabilities.revokeWebview(WEBVIEW_ID);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('webview proxy upstream timeout (#237)', () => {
  it('proxies a fast request untouched', async () => {
    const res = await app.inject({ method: 'GET', url: `/webview/${capability}/fast` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('quick');
  });

  it('502s with an actionable, logged message when headers never arrive in time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await app.inject({ method: 'GET', url: `/webview/${capability}/slow-headers` });
      expect(res.statusCode).toBe(502);
      // The body names the limit and the env var that raises it; the old message
      // was an opaque "The operation was aborted due to timeout".
      expect(res.body).toContain(`no response headers within ${TIMEOUT_MS}ms`);
      expect(res.body).toContain('CODEMAN_WEBVIEW_TIMEOUT_MS');
      // And it is logged server-side (the old path was completely silent), with
      // the sanitized target and the webview's name.
      const logged = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('no response headers');
      expect(logged).toContain(`/slow-headers`);
      expect(logged).toContain('timeout-under-test');
    } finally {
      warn.mockRestore();
    }
  });

  it('never aborts a response that is actively streaming past the timeout', async () => {
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: `/webview/${capability}/stream` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('start;chunk1;chunk2;chunk3;chunk4;done');
    // Sanity: the exchange really did outlive the header timeout.
    expect(Date.now() - started).toBeGreaterThan(TIMEOUT_MS);
  });
});
