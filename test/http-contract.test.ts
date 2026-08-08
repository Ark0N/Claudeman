/**
 * Live-server tests for the stable HTTP contract (docs/api-reference.md):
 * the uniform {success,data} envelope, error envelopes with conventional
 * HTTP statuses, the /api/v1 alias, and the /api not-found handler.
 *
 * These behaviors live in server.ts (preSerialization hook, setNotFoundHandler),
 * which the route-test harness does not install — so they need a real WebServer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';

const PORT = 3168;

describe('Stable HTTP contract (live server)', () => {
  let server: WebServer;
  const base = `http://localhost:${PORT}`;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('wraps bare payloads as { success: true, data }', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.version).toBeDefined();
  });

  it('serves the same envelope on the /api/v1 alias', async () => {
    const res = await fetch(`${base}/api/v1/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.version).toBeDefined();
  });

  it('maps error envelopes to conventional HTTP statuses', async () => {
    const res = await fetch(`${base}/api/sessions/nonexistent/terminal`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('returns a contract-shaped 404 for unknown /api routes', async () => {
    const res = await fetch(`${base}/api/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('returns a contract-shaped 404 for unknown /api/v1 routes', async () => {
    const res = await fetch(`${base}/api/v1/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('rejects a bad /api/events/subscribe body with an error envelope', async () => {
    const res = await fetch(`${base}/api/events/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INVALID_INPUT');
  });

  it('keeps validation errors on the envelope with HTTP 400', async () => {
    const res = await fetch(`${base}/api/clipboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INVALID_INPUT');
  });

  /**
   * The agent wait primitives, through the REAL pipeline.
   *
   * Their own route tests hand-roll a partial copy of the preSerialization hook that
   * maps errorCode to status but does NOT wrap bare payloads — so nothing there
   * proves these routes emit a correct envelope, a correct status, or work through
   * the /api/v1 alias, and one assertion in them pins `{}` for a response no client
   * will ever receive. This is the file whose docstring already claims that scope.
   */
  describe('agent wait primitives', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      sessionId = (await res.json()).data.session.id;
      expect(sessionId).toBeDefined();
    });

    afterAll(async () => {
      await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' });
    });

    it('answers a wait timeout as a 200 inside the envelope, on the /api/v1 alias', async () => {
      // A timeout is the long-poll SUCCEEDING at "did this happen within N ms?"; a
      // 4xx/5xx here would make every poll boundary indistinguishable from a failure.
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/wait?until=working&timeout=1000`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.sessionId).toBe(sessionId);
      // The one shape all three wait endpoints share.
      expect(body.data.wait.timedOut).toBe(true);
      expect(body.data.wait.signal).toBeNull();
      expect(body.data.wait.timeoutMs).toBe(1000);
      expect(body.data.wait.until).toEqual(['working']);
    });

    it('returns a contract-shaped 400 for an unknown until token', async () => {
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/wait?until=stpo`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INVALID_INPUT');
      expect(body.error).toContain('stpo');
    });

    it('returns a contract-shaped 400 naming the bad query parameter', async () => {
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/wait?timeout=30s`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe('INVALID_INPUT');
      expect(body.error).toContain('timeout');
    });

    it('wraps the non-wait input response as { success: true, data: {} }', async () => {
      // What a client actually receives on the fire-and-forget path — NOT the bare
      // `{}` the handler returns and the route tests assert.
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hello' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: {} });
    });

    it('serves wait-output through the same envelope', async () => {
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/wait-output?match=NEVER_APPEARS&timeout=1000`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.wait.matched).toBe(false);
      expect(body.data.wait.timedOut).toBe(true);
      expect(body.data.wait.match).toBe('NEVER_APPEARS');
    });

    it('404s an unknown session on both new routes, with the error envelope', async () => {
      for (const path of ['wait?until=idle', 'wait-output?match=x']) {
        const res = await fetch(`${base}/api/v1/sessions/nonexistent/${path}`);
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.errorCode).toBe('NOT_FOUND');
      }
    });
  });
});
