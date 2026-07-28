/**
 * @fileoverview Tests for WebSocket terminal I/O route.
 *
 * Unlike other route tests that use app.inject(), WebSocket testing requires
 * a real listening server since inject() doesn't support upgrade requests.
 * Uses the `ws` package (transitive dep of @fastify/websocket) as the client.
 *
 * @dependency test/mocks/mock-route-context.ts (createMockRouteContext)
 * @dependency src/web/routes/ws-routes.ts (registerWsRoutes)
 * Port: 3170 (ws-routes tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';
import { MAX_INPUT_LENGTH } from '../../src/config/terminal-limits.js';

const PORT = 3170;

/** Helper: open a WebSocket connection and wait for it to reach OPEN state. */
function connectWs(path: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connection timeout')), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Helper: wait for the next WS message, parsed as JSON. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}

/** Helper: wait for WS close event and return { code, reason }. */
function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Helper: collect N messages from a WebSocket. */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Only received ${msgs.length}/${count} messages`)), timeoutMs);
    const msgs: unknown[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      msgs.push(JSON.parse(String(raw)));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msgs);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('ws-routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let streamCoordinator: {
    suspendSseTerminal: ReturnType<typeof vi.fn>;
    resumeSseTerminal: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    ctx = createMockRouteContext({ sessionId: 'ws-test-session' });
    streamCoordinator = {
      suspendSseTerminal: vi.fn(),
      resumeSseTerminal: vi.fn(),
    };
    registerWsRoutes(
      app,
      ctx as never,
      () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }),
      streamCoordinator
    );

    await app.listen({ port: PORT, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
  });

  // ========== Session not found ==========

  describe('session not found', () => {
    it('closes with 4004 when session does not exist', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/nonexistent/terminal`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('Session not found');
    });
  });

  // ========== Terminal output ==========

  describe('terminal output', () => {
    it('flushes queued output before handing the session stream back to SSE', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal?cid=page-client-a');
      try {
        expect(streamCoordinator.suspendSseTerminal).toHaveBeenCalledWith('page-client-a', 'ws-test-session');

        const messages = collectMessages(ws, 2);
        ctx._session.emit('terminal', 'last websocket batch');
        ws.send('{"t":"h"}');

        await expect(messages).resolves.toEqual([
          expect.objectContaining({ t: 'o', d: expect.stringContaining('last websocket batch') }),
          { t: 'ha' },
        ]);
        expect(streamCoordinator.resumeSseTerminal).toHaveBeenCalledWith('page-client-a', 'ws-test-session', false);
        expect(ctx._session.listenerCount('terminal')).toBe(0);
      } finally {
        ws.close();
      }
    });

    it('receives terminal output via WS with DEC 2026 sync markers', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit terminal data from mock session
        session.emit('terminal', 'hello world');

        // Wait for the micro-batched message (8ms batch interval + margin)
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        // Should contain DEC 2026 sync markers wrapping the data
        expect(msg.d).toContain('hello world');
        expect(msg.d).toMatch(/^\x1b\[\?2026h/); // starts with DEC 2026 start
        expect(msg.d).toMatch(/\x1b\[\?2026l$/); // ends with DEC 2026 end
      } finally {
        ws.close();
      }
    });

    it('sends clearTerminal event as {"t":"c"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('clearTerminal');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('c');
      } finally {
        ws.close();
      }
    });

    it('sends needsRefresh event as {"t":"r"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('needsRefresh');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('r');
      } finally {
        ws.close();
      }
    });

    it('coalesces rapid terminal emissions into a single frame', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit multiple small chunks in rapid succession (within the 8ms batch window)
        session.emit('terminal', 'chunk1');
        session.emit('terminal', 'chunk2');
        session.emit('terminal', 'chunk3');

        // Should arrive as a single coalesced message
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('chunk1chunk2chunk3');
      } finally {
        ws.close();
      }
    });

    it('coalesces adjacent mobile redraws across the desktop batch window', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'mobile' }));
        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(48, 28, {
            viewportType: 'mobile',
            force: false,
          });
        });

        session.emit('terminal', 'mobile-frame-1');
        await new Promise((resolve) => setTimeout(resolve, 15));
        session.emit('terminal', 'mobile-frame-2');

        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('mobile-frame-1mobile-frame-2');
      } finally {
        ws.close();
      }
    });

    it('splits mobile bulk output into lossless 16KB synchronized frames', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'mobile' }));
        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(48, 28, {
            viewportType: 'mobile',
            force: false,
          });
        });

        const largeData = 'X'.repeat(24 * 1024);
        const messagesPromise = collectMessages(ws, 2, 500);
        session.emit('terminal', largeData);

        const messages = (await messagesPromise) as Array<{ t: string; d: string }>;
        const payloads = messages.map((message) => message.d.slice('\x1b[?2026h'.length, -'\x1b[?2026l'.length));
        expect(payloads.every((payload) => Buffer.byteLength(payload, 'utf8') <= 16 * 1024)).toBe(true);
        expect(payloads.join('')).toBe(largeData);
      } finally {
        ws.close();
      }
    });

    it('splits bulk UTF-8 output into bounded lossless frames', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        const largeData = 'X'.repeat(8000) + '😀'.repeat(1000);
        const messagesPromise = collectMessages(ws, 2, 500);
        session.emit('terminal', largeData);

        const messages = (await messagesPromise) as Array<{ t: string; d: string }>;
        const payloads = messages.map((message) => message.d.slice('\x1b[?2026h'.length, -'\x1b[?2026l'.length));
        expect(messages.every((message) => message.t === 'o')).toBe(true);
        expect(payloads.every((payload) => Buffer.byteLength(payload, 'utf8') <= 8 * 1024)).toBe(true);
        expect(payloads.join('')).toBe(largeData);
      } finally {
        ws.close();
      }
    });

    it('does not split inside ANSI control sequences or synchronized updates', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        const colorSequence = '\x1b[38;5;196m';
        const firstPayload = 'X'.repeat(8190) + colorSequence;
        const atomicPayload = '\x1b[?2026h' + 'Y'.repeat(9000) + '\x1b[?2026l';
        const messagesPromise = collectMessages(ws, 2, 500);

        session.emit('terminal', firstPayload + atomicPayload);

        const messages = (await messagesPromise) as Array<{ t: string; d: string }>;
        const payloads = messages.map((message) => message.d.slice('\x1b[?2026h'.length, -'\x1b[?2026l'.length));
        expect(payloads[0]).toBe(firstPayload);
        expect(payloads[1]).toBe(atomicPayload);
        expect(payloads.join('')).toBe(firstPayload + atomicPayload);
      } finally {
        ws.close();
      }
    });

    it('carries an incomplete ANSI suffix into the next PTY event', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        const messagesPromise = collectMessages(ws, 2, 500);

        session.emit('terminal', 'plain text\x1b[38;');
        await new Promise((resolve) => setTimeout(resolve, 20));
        session.emit('terminal', '5;196mRED');

        const messages = (await messagesPromise) as Array<{ t: string; d: string }>;
        const payloads = messages.map((message) => message.d.slice('\x1b[?2026h'.length, -'\x1b[?2026l'.length));
        expect(payloads).toEqual(['plain text', '\x1b[38;5;196mRED']);
        expect(payloads.join('')).toBe('plain text\x1b[38;5;196mRED');
      } finally {
        ws.close();
      }
    });
  });

  // ========== Client input ==========

  describe('client input', () => {
    it('forwards input messages to session.write()', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'i', d: 'ls -la\r' }));

        // Give the message handler time to process
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ls -la\r');
        });
      } finally {
        ws.close();
      }
    });

    it('reasserts the last mobile viewport before applying ordinary keyboard input', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'mobile' }));
        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(48, 28, {
            viewportType: 'mobile',
            force: false,
          });
        });
        session.resize.mockClear();

        ws.send(JSON.stringify({ t: 'i', d: 'a' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('a');
        });

        expect(session.resize).toHaveBeenCalledWith(48, 28, {
          viewportType: 'mobile',
          takeControl: true,
        });
      } finally {
        ws.close();
      }
    });

    it('reasserts the sending desktop connection dimensions as sizing activity', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        ws.send(JSON.stringify({ t: 'z', c: 180, r: 50, v: 'desktop' }));
        await vi.waitFor(() => {
          expect(session.claimDesktopSizing).toHaveBeenCalledOnce();
        });
        session.resize.mockClear();

        ws.send(JSON.stringify({ t: 'i', d: 'a' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('a');
        });

        expect(session.resize).toHaveBeenCalledWith(180, 50, {
          viewportType: 'desktop',
          takeControl: true,
        });
      } finally {
        ws.close();
      }
    });

    it('uses the active desktop socket dimensions when multiple desktops are connected', async () => {
      const desktopA = await connectWs('/ws/sessions/ws-test-session/terminal?cid=desktop-a');
      const desktopB = await connectWs('/ws/sessions/ws-test-session/terminal?cid=desktop-b');
      try {
        const session = ctx._session;
        desktopA.send(JSON.stringify({ t: 'z', c: 160, r: 44, v: 'desktop' }));
        desktopB.send(JSON.stringify({ t: 'z', c: 220, r: 56, v: 'desktop' }));
        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(160, 44, {
            viewportType: 'desktop',
            force: false,
          });
          expect(session.resize).toHaveBeenCalledWith(220, 56, {
            viewportType: 'desktop',
            force: false,
          });
        });
        session.resize.mockClear();

        desktopA.send(JSON.stringify({ t: 'i', d: 'from-a' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('from-a');
        });

        expect(session.resize).toHaveBeenCalledWith(160, 44, {
          viewportType: 'desktop',
          takeControl: true,
        });
        expect(session.resize).not.toHaveBeenCalledWith(220, 56, {
          viewportType: 'desktop',
          takeControl: true,
        });
      } finally {
        desktopA.close();
        desktopB.close();
      }
    });

    it('ignores input exceeding MAX_INPUT_LENGTH', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        const hugeInput = 'x'.repeat(MAX_INPUT_LENGTH + 1);
        ws.send(JSON.stringify({ t: 'i', d: hugeInput }));

        // Send a valid message after to confirm the connection still works
        ws.send(JSON.stringify({ t: 'i', d: 'ok' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ok');
        });

        // The oversized input should not have been written
        expect(session.writeBuffer).not.toContain(hugeInput);
      } finally {
        ws.close();
      }
    });

    it('ignores malformed JSON messages', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send('not-json{{{');

        // Send valid input to verify connection still alive
        ws.send(JSON.stringify({ t: 'i', d: 'after-bad' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('after-bad');
        });

        // Only 'after-bad' should be in the buffer
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });

    it('ignores unknown message types without breaking the connection', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Send unknown type
        ws.send(JSON.stringify({ t: 'x', d: 'mystery' }));

        // Connection should still work
        ws.send(JSON.stringify({ t: 'i', d: 'still-alive' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('still-alive');
        });

        // Unknown type should not have been written
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Resize validation ==========

  describe('resize validation', () => {
    it('accepts valid resize within bounds', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('passes viewport type through for resize arbitration', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'mobile' }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(48, 28, { viewportType: 'mobile', force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('passes force resize through for redraw requests', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40, f: true }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: true });
        });
      } finally {
        ws.close();
      }
    });

    it('passes explicit viewport takeover through for active mobile interaction', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'mobile', a: true }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(48, 28, {
            viewportType: 'mobile',
            force: false,
            takeControl: true,
          });
        });
      } finally {
        ws.close();
      }
    });

    it('claims desktop sizing on a desktop resize and releases it on close', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const session = ctx._session;
      try {
        ws.send(JSON.stringify({ t: 'z', c: 160, r: 48, v: 'desktop' }));

        await vi.waitFor(() => {
          expect(session.claimDesktopSizing).toHaveBeenCalledTimes(1);
        });
        const token = session.claimDesktopSizing.mock.calls[0][0];

        // A later small-viewport resize on the SAME connection drops the claim
        // (window narrowed past the breakpoint).
        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'tablet' }));
        await vi.waitFor(() => {
          expect(session.releaseDesktopSizing).toHaveBeenCalledWith(token);
        });
      } finally {
        ws.close();
      }

      // Socket close releases the claim again (idempotent set delete).
      await vi.waitFor(() => {
        expect(session.releaseDesktopSizing.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('accepts resize at minimum bounds (1x1)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 1, r: 1 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(1, 1, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('accepts resize at maximum bounds (500x200)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 500, r: 200 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(500, 200, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols out of bounds (0 cols)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 0, r: 40 }));

        // Send a valid message to confirm processing continues
        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols exceeding 500', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 501, r: 40 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with rows exceeding 200', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80, r: 201 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with non-integer values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80.5, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with negative values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: -1, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });
  });

  // ========== Connection limit ==========

  describe('connection limit', () => {
    it('closes with 4008 when too many connections per session', async () => {
      const connections: WebSocket[] = [];
      try {
        // Open 5 connections (the max)
        for (let i = 0; i < 5; i++) {
          connections.push(await connectWs('/ws/sessions/ws-test-session/terminal'));
        }

        // 6th connection should be rejected
        const ws6 = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/ws-test-session/terminal`);
        const { code, reason } = await waitForClose(ws6);
        expect(code).toBe(4008);
        expect(reason).toBe('Too many connections');
      } finally {
        for (const ws of connections) ws.close();
      }
    });

    it('reconnecting client (same cid) is admitted at the cap instead of 4008 (COD-137)', async () => {
      const connections: WebSocket[] = [];
      try {
        // Fill all 5 slots with DISTINCT clients, one of which is "alice".
        for (const c of ['alice', 'b', 'c', 'd', 'e']) {
          connections.push(await connectWs(`/ws/sessions/ws-test-session/terminal?cid=${c}`));
        }

        // Alice reconnects WHILE her old socket is still registered (the
        // over-count window). This must reclaim her slot, not hit the cap.
        const aliceNew = await connectWs('/ws/sessions/ws-test-session/terminal?cid=alice');
        connections.push(aliceNew);

        // Sanity: the reconnected socket is live and usable.
        ctx._session.emit('terminal', 'reconnected-ok');
        const msg = (await nextMessage(aliceNew)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('reconnected-ok');
      } finally {
        for (const ws of connections) ws.close();
      }
    });
  });

  // ========== Heartbeat ==========

  describe('heartbeat', () => {
    it('responds to server ping with pong (connection stays alive)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        // The ws library automatically responds to pings with pongs.
        // Verify the connection survives by sending data after a brief delay.
        const session = ctx._session;
        session.emit('terminal', 'heartbeat-test');

        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('heartbeat-test');
      } finally {
        ws.close();
      }
    });
  });

  // ========== readyState guards ==========

  describe('readyState guards', () => {
    it('does not throw when clearTerminal fires after close', async () => {
      const session = ctx._session;
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      ws.close();
      await waitForClose(ws);

      // These should be no-ops, not throw
      expect(() => session.emit('clearTerminal')).not.toThrow();
      expect(() => session.emit('needsRefresh')).not.toThrow();
    });
  });

  // ========== Connection cleanup ==========

  describe('connection cleanup', () => {
    it('removes session event listeners on close', async () => {
      const session = ctx._session;
      const listenersBefore = session.listenerCount('terminal');

      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      // A listener was added for 'terminal'
      expect(session.listenerCount('terminal')).toBe(listenersBefore + 1);
      expect(session.listenerCount('clearTerminal')).toBeGreaterThanOrEqual(1);
      expect(session.listenerCount('needsRefresh')).toBeGreaterThanOrEqual(1);

      // Close the WS connection
      ws.close();
      await waitForClose(ws);

      // Wait for server-side close handler
      await vi.waitFor(() => {
        expect(session.listenerCount('terminal')).toBe(listenersBefore);
      });

      expect(session.listenerCount('clearTerminal')).toBe(0);
      expect(session.listenerCount('needsRefresh')).toBe(0);
    });
  });
});
