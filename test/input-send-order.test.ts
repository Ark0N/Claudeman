/**
 * @fileoverview Input dispatch ordering for the durable, acknowledged delivery
 * layer (`CodemanApp._sendInputAsync` → `_reliableSend` → `_drainSession`).
 *
 * Local replaced the upstream best-effort "coalescing fallback queue" with the
 * durable per-(clientId, seq) layer in commit 1255e28 (docs/reliable-input-
 * delivery.md). This suite verifies the client-side ordering guarantees of that
 * layer: each input is a distinct seq-tagged frame, delivered in order over the
 * WebSocket when open, serialized over HTTP POST when not, and only dropped on a
 * server ACK (HTTP 2xx). Exactly-once application is covered server-side in
 * test/reliable-input-dedup.test.ts; the header transport indicator ("WS"/"HTTP")
 * is covered in test/connection-indicator.test.ts.
 *
 * Loaded via `vm` with a stubbed context (no jsdom).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadCodemanAppClass() {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
    document: { addEventListener: vi.fn() },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();

async function waitForCalls(calls: unknown[], count: number) {
  for (let i = 0; i < 50; i++) {
    if (calls.length >= count) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

type Frame = { t: string; d: string; seq: number; cid: string };
type PostBody = { input: string; seq: number; clientId: string };

type App = {
  _sendInputAsync: (sessionId: string, input: string, opts?: { useMux?: boolean }) => void;
  _pendingDeliveries: Map<string, Array<{ seq: number; data: string; sentAt: number }>>;
  _ws: { readyState: number; send: (data: string) => void } | null;
  _wsSessionId: string | null;
  activeSessionId: string | null;
};

function makeApp(): App {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as App & Record<string, unknown>;
  app._clientId = 'c-test';
  app._seqCounters = new Map();
  app._pendingDeliveries = new Map();
  app._postDraining = new Set();
  app._persistReliableState = vi.fn();
  app._persistReliableNow = vi.fn();
  app._updateConnectionIndicator = vi.fn();
  app.clearPendingHooks = vi.fn();
  // _ackDelivery spends a pending IDLE alert through markIdleAlertSeen, which
  // reads this map; without it the real prototype method throws on every ACK.
  app.pendingHooks = new Map();
  app.activeSessionId = 'session-1';
  app.isOnline = true;
  app._connectionStatus = 'connected';
  app._ws = null;
  app._wsSessionId = null;
  return app as unknown as App;
}

describe('durable input delivery — send ordering', () => {
  it('delivers rapid input as distinct ordered seq frames over an open WebSocket (no coalescing)', () => {
    const app = makeApp();
    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)) };
    app._wsSessionId = 'session-1';

    app._sendInputAsync('session-1', 'a');
    app._sendInputAsync('session-1', 'b');
    app._sendInputAsync('session-1', 'c');

    // Each keystroke is its own frame, in seq order — never merged into "abc".
    expect(frames.map((f) => f.d)).toEqual(['a', 'b', 'c']);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(frames.every((f) => f.t === 'i' && f.cid === 'c-test')).toBe(true);
  });

  it('POSTs queued input one frame at a time in seq order when no socket is open', async () => {
    const app = makeApp();
    const calls: PostBody[] = [];
    const completions: Array<() => void> = [];
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as PostBody);
      await new Promise<void>((r) => completions.push(r));
      return new Response('{}', { status: 200 });
    });

    app._sendInputAsync('session-1', 'a');
    app._sendInputAsync('session-1', 'b');

    // Serialized: only the first frame is in flight until its 2xx ACK lands.
    await waitForCalls(calls, 1);
    expect(calls.map((c) => c.input)).toEqual(['a']);

    completions.shift()?.(); // ACK 'a'
    await waitForCalls(calls, 2);
    expect(calls.map((c) => c.input)).toEqual(['a', 'b']);
    expect(calls.map((c) => c.seq)).toEqual([1, 2]);

    completions.shift()?.();
    await waitForCalls(calls, 2);
  });

  it('leaves a frame queued (unacked) when HTTP delivery fails', async () => {
    const app = makeApp();
    const calls: PostBody[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as PostBody);
      return new Response('busy', { status: 503 });
    });

    app._sendInputAsync('session-1', 'a');
    await waitForCalls(calls, 1);
    await new Promise((r) => setTimeout(r, 0));

    // 5xx is not an ACK — the frame must survive for the sweep/reconnect to retry.
    expect(app._pendingDeliveries.get('session-1')).toHaveLength(1);
    expect(app._pendingDeliveries.get('session-1')?.[0].data).toBe('a');
  });

  it('drops a frame addressed to a vanished session (404) instead of retrying forever', async () => {
    const app = makeApp();
    global.fetch = vi.fn(async () => new Response('gone', { status: 404 }));

    app._sendInputAsync('session-1', 'a');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(app._pendingDeliveries.get('session-1')).toBeUndefined();
  });
});

// COD-135 — durable redelivery sweep when an ACK is lost.
type RedriveApp = App & {
  _redeliverSweep: () => void;
  _reliableAckTimeoutMs: number;
  _wsLastRecvAt: number;
};

describe('durable input delivery — _redeliverSweep ACK-loss recovery (COD-135)', () => {
  it('re-drives a stale unacked frame over a STILL-LIVE socket (lost ACK, not silent)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    // Frame sent once over the open socket; ACK never arrives.
    app._sendInputAsync('session-1', 'a');
    expect(frames.map((f) => f.d)).toEqual(['a']);

    // ACK is lost, but the socket KEEPS receiving output → it is NOT silent.
    // Backdate the send so the frame is stale; keep recv timestamp fresh.
    const list = app._pendingDeliveries.get('session-1')!;
    list[0].sentAt = Date.now() - (app._reliableAckTimeoutMs + 1000);
    app._wsLastRecvAt = Date.now();

    app._redeliverSweep();

    // The stale frame must be re-sent over the live socket (a second send),
    // and the socket must NOT be force-closed (it's alive, just the ACK was lost).
    expect(frames.map((f) => f.d)).toEqual(['a', 'a']);
    expect(close).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.get('session-1')).toHaveLength(1);
  });

  it('does NOT re-drive a not-yet-stale frame (sent recently)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    app._sendInputAsync('session-1', 'a');
    app._wsLastRecvAt = Date.now(); // not silent

    // sentAt is fresh (just sent) → below the stale threshold → leave it alone.
    app._redeliverSweep();

    expect(frames.map((f) => f.d)).toEqual(['a']); // no second send
    expect(close).not.toHaveBeenCalled();
  });

  it('force-closes the socket when stale AND silent (half-open — COD-134 fallback preserved)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    app._sendInputAsync('session-1', 'a');
    const list = app._pendingDeliveries.get('session-1')!;
    list[0].sentAt = Date.now() - (app._reliableAckTimeoutMs + 1000); // stale
    app._wsLastRecvAt = Date.now() - (app._reliableAckTimeoutMs + 1000); // silent

    app._redeliverSweep();

    // Half-open socket never recovers on its own → force-close to reconnect.
    // It must NOT have re-sent over the dead socket.
    expect(close).toHaveBeenCalledTimes(1);
    expect(frames.map((f) => f.d)).toEqual(['a']);
  });
});
