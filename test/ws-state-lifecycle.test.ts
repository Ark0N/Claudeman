/**
 * @fileoverview Terminal WebSocket state-machine lifecycle tests
 * (`CodemanApp._connectWs` / `ws.onopen` / `ws.onclose` / `_disconnectWs`).
 *
 * Unlike test/connection-indicator.test.ts (which pins the pure descriptor per
 * pre-seeded `_wsState`), this suite drives the REAL transitions through a fake
 * `WebSocket` class so the production assignments are covered:
 *
 *   1. `_connectWs()` → 'connecting', a real `onopen` → 'connected' (the chip
 *      renders "WS"), `_disconnectWs()` → 'disconnected'. Regression guard for
 *      the PR-review blocker where `_wsState` was only ever written in
 *      `onclose`, leaving the chip stuck on "WS…"/"HTTP" forever.
 *   2. Exponential backoff really escalates across the onclose → timer →
 *      `_connectWs` cycle: `_disconnectWs()` (called first by `_connectWs`)
 *      must NOT zero `_wsReconnectAttempts`, or every retry replans at
 *      attempt 0 (a ~0ms tight reconnect loop during an outage). Only a
 *      successful `onopen` resets the counter.
 *   3. The upgrade URL carries the per-TAB `cid` (`clientId:tabNonce`), not the
 *      browser-wide clientId — two tabs of one profile must register distinct
 *      registry keys so they coexist instead of 4010-evicting each other.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — see input-send-order.test.ts).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type FakeTimer = { id: number; fn: () => void; delay: number; cleared: boolean };

class FakeWebSocket {
  static OPEN = 1;
  url: string;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  static instances: FakeWebSocket[] = [];
}

function loadHarness() {
  FakeWebSocket.instances = [];
  const timers: FakeTimer[] = [];
  let nextTimerId = 1;
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout: (fn: () => void, delay: number) => {
      const id = nextTimerId++;
      timers.push({ id, fn, delay, cleared: false });
      return id;
    },
    clearTimeout: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: FakeWebSocket,
    location: { protocol: 'https:', host: 'test.local' },
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
  const CodemanApp = (context as { __CodemanApp: new () => unknown }).__CodemanApp;
  return { CodemanApp, timers };
}

function fakeElement() {
  return { style: { display: '' }, title: '', textContent: '', className: '' };
}

type LifecycleApp = {
  _connectWs: (id: string) => void;
  _disconnectWs: () => void;
  _wsState: string;
  _wsReady: boolean;
  _wsReconnectAttempts: number | undefined;
  _ws: FakeWebSocket | null;
  _onSessionNeedsRefresh: (data: { id: string }) => void;
  activeSessionId: string | null;
};

function makeApp(
  CodemanApp: new () => unknown,
  overrides: Record<string, unknown> = {}
): { app: LifecycleApp; els: Record<string, ReturnType<typeof fakeElement>> } {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as LifecycleApp & Record<string, unknown>;
  const els: Record<string, ReturnType<typeof fakeElement>> = {
    connectionIndicator: fakeElement(),
    connectionDot: fakeElement(),
    connectionText: fakeElement(),
  };
  app.$ = (id: string) => els[id];
  app._clientId = 'c-browser';
  app._wsTabNonce = 'tab-1';
  app._ws = null;
  app._wsSessionId = null;
  app._wsReady = false;
  app._wsState = 'disconnected';
  app._wsLastRecvAt = 0;
  app._lastIndicatorDescriptor = null;
  app._pendingDeliveries = new Map();
  app._connectionStatus = 'connected';
  app.activeSessionId = 's1';
  app.isOnline = true;
  app.sendResize = vi.fn();
  app._onWsReady = vi.fn();
  app._onSessionNeedsRefresh = vi.fn();
  Object.assign(app, overrides);
  return { app: app as LifecycleApp, els };
}

/** Run the oldest pending (not-cleared, not-yet-fired) reconnect timer. */
function fireNextTimer(timers: FakeTimer[]): FakeTimer {
  const t = timers.find((x) => !x.cleared);
  if (!t) throw new Error('no pending timer');
  t.cleared = true; // mark consumed so the next fire picks the following one
  t.fn();
  return t;
}

describe('WS state lifecycle — real _connectWs/onopen/onclose transitions', () => {
  it("_connectWs sets 'connecting', a real onopen sets 'connected' and renders 'WS'", () => {
    const { CodemanApp } = loadHarness();
    const { app, els } = makeApp(CodemanApp);

    app._connectWs('s1');
    expect(app._wsState).toBe('connecting');
    expect(els.connectionText.textContent).toBe('WS…');

    const ws = FakeWebSocket.instances[0];
    ws.readyState = 1;
    ws.onopen?.();

    expect(app._wsState).toBe('connected');
    expect(app._wsReady).toBe(true);
    expect(app._wsReconnectAttempts).toBe(0);
    // The chip must show the healthy transport from the REAL open path — the
    // 'connected' branch was dead code when only onclose wrote _wsState.
    expect(els.connectionText.textContent).toBe('WS');
    expect(els.connectionDot.className).toBe('connection-dot connected');
  });

  it("_disconnectWs resets the state machine to 'disconnected' and closes the socket", () => {
    const { CodemanApp } = loadHarness();
    const { app } = makeApp(CodemanApp);

    app._connectWs('s1');
    const ws = FakeWebSocket.instances[0];
    ws.readyState = 1;
    ws.onopen?.();
    expect(app._wsState).toBe('connected');

    app._disconnectWs();
    expect(app._wsState).toBe('disconnected');
    expect(app._wsReady).toBe(false);
    expect(app._ws).toBeNull();
    expect(ws.closed).toBe(true);
  });

  it("a retry-fallback close (4010) shows 'HTTP', and the successful retry returns the chip to 'WS'", () => {
    const { CodemanApp, timers } = loadHarness();
    const { app, els } = makeApp(CodemanApp);

    app._connectWs('s1');
    const ws1 = FakeWebSocket.instances[0];
    ws1.readyState = 1;
    ws1.onopen?.();
    expect(els.connectionText.textContent).toBe('WS');

    ws1.onclose?.({ code: 4010, reason: 'Superseded by reconnect' });
    expect(app._wsState).toBe('fallback');
    expect(els.connectionText.textContent).toBe('HTTP');

    // The bounded 5s retry succeeds → the chip must NOT stay stuck on "HTTP".
    const timer = fireNextTimer(timers);
    expect(timer.delay).toBe(5000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.readyState = 1;
    ws2.onopen?.();
    expect(app._wsState).toBe('connected');
    expect(els.connectionText.textContent).toBe('WS');
  });
});

describe('WS reconnect backoff — attempts survive the _connectWs → _disconnectWs call', () => {
  it('escalates the transient-close delay ladder instead of replanning at attempt 0', () => {
    const { CodemanApp, timers } = loadHarness();
    const { app } = makeApp(CodemanApp);

    app._connectWs('s1');
    // Attempt 0: transient close plans 0ms (+ <250ms jitter).
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: '' });
    expect(app._wsReconnectAttempts).toBe(1);
    const t1 = fireNextTimer(timers);
    expect(t1.delay).toBeLessThan(250);

    // Attempt 1: the retry's _connectWs ran _disconnectWs first — the counter
    // must survive it, so this close plans 250ms (+ jitter), not 0ms again.
    FakeWebSocket.instances[1].onclose?.({ code: 1006, reason: '' });
    expect(app._wsReconnectAttempts).toBe(2);
    const t2 = fireNextTimer(timers);
    expect(t2.delay).toBeGreaterThanOrEqual(250);
    expect(t2.delay).toBeLessThan(500);

    // Attempt 2 → 500ms rung.
    FakeWebSocket.instances[2].onclose?.({ code: 1006, reason: '' });
    expect(app._wsReconnectAttempts).toBe(3);
    const t3 = fireNextTimer(timers);
    expect(t3.delay).toBeGreaterThanOrEqual(500);
    expect(t3.delay).toBeLessThan(750);
  });

  it('a successful onopen (not an intentional disconnect) is what resets the counter', () => {
    const { CodemanApp, timers } = loadHarness();
    const { app } = makeApp(CodemanApp);

    app._connectWs('s1');
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: '' });
    FakeWebSocket.instances[0].closed = true;
    fireNextTimer(timers);
    expect(app._wsReconnectAttempts).toBe(1);

    const ws2 = FakeWebSocket.instances[1];
    ws2.readyState = 1;
    ws2.onopen?.();
    expect(app._wsReconnectAttempts).toBe(0);
    expect(app._wsState).toBe('connected');
  });

  it('recovers terminal history once after a WS fallback gap, but not on initial open', () => {
    const { CodemanApp, timers } = loadHarness();
    const { app } = makeApp(CodemanApp);

    app._connectWs('s1');
    const ws1 = FakeWebSocket.instances[0];
    ws1.readyState = 1;
    ws1.onopen?.();
    expect(app._onSessionNeedsRefresh).not.toHaveBeenCalled();

    ws1.onclose?.({ code: 1006, reason: '' });
    fireNextTimer(timers);
    const ws2 = FakeWebSocket.instances[1];
    ws2.readyState = 1;
    ws2.onopen?.();

    expect(app._onSessionNeedsRefresh).toHaveBeenCalledOnce();
    expect(app._onSessionNeedsRefresh).toHaveBeenCalledWith({ id: 's1' });
  });
});

describe('WS upgrade cid — per-TAB identity (clientId:tabNonce)', () => {
  it('sends the composite cid on the upgrade URL, keeping the bare clientId for input frames', () => {
    const { CodemanApp } = loadHarness();
    const { app } = makeApp(CodemanApp);

    app._connectWs('s1');
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.get('cid')).toBe('c-browser:tab-1');
  });

  it('two tabs sharing the browser clientId register DIFFERENT registry keys', () => {
    const { CodemanApp } = loadHarness();
    const { app: tabA } = makeApp(CodemanApp, { _wsTabNonce: 'tab-A' });
    const { app: tabB } = makeApp(CodemanApp, { _wsTabNonce: 'tab-B' });

    tabA._connectWs('s1');
    tabB._connectWs('s1');

    const cidA = new URL(FakeWebSocket.instances[0].url).searchParams.get('cid');
    const cidB = new URL(FakeWebSocket.instances[1].url).searchParams.get('cid');
    expect(cidA).toBe('c-browser:tab-A');
    expect(cidB).toBe('c-browser:tab-B');
    // Distinct keys → the server registry admits both instead of supersede-evicting.
    expect(cidA).not.toBe(cidB);
  });

  it('omits the cid query entirely when no clientId is available', () => {
    const { CodemanApp } = loadHarness();
    const { app } = makeApp(CodemanApp, { _clientId: '' });

    app._connectWs('s1');
    expect(FakeWebSocket.instances[0].url).not.toContain('cid=');
  });
});
