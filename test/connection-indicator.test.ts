/**
 * @fileoverview Regression tests for the header connection indicator
 * (`CodemanApp._updateConnectionIndicator`) and the invariant that updating it
 * never aborts durable input delivery.
 *
 * Guards two regressions from the upstream v1.1.15 merge (fixed in COD-133):
 *   1. The indicator body referenced an undefined `transport` object, throwing
 *      `ReferenceError: transport is not defined` on every queued state. Because
 *      `_reliableSend()` calls `_updateConnectionIndicator()` *before*
 *      `_drainSession()`, the throw skipped immediate delivery on every keystroke
 *      → input only flushed on the 2s sweep (large typing lag) and the indicator
 *      never rendered (missing "WS" status).
 *   2. The restored body only read the SSE `_connectionStatus`, so it never
 *      surfaced the terminal WebSocket transport ("WS" / "HTTP"), and it flashed
 *      "sending 1B" on every single keystroke.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — see input-send-order.test.ts).
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

function fakeElement() {
  return { style: { display: '' }, title: '', textContent: '', className: '' };
}

type Indicator = {
  $: (id: string) => unknown;
  _pendingDeliveries: Map<string, Array<{ seq: number; data: string }>>;
  _connectionStatus: string;
  _wsState: string;
  activeSessionId: string | null;
  isOnline: boolean;
  _updateConnectionIndicator: () => void;
};

function makeApp(overrides: Partial<Indicator> & { queuedBytes?: number } = {}) {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as Indicator & {
    queuedBytes?: number;
  };
  const els: Record<string, ReturnType<typeof fakeElement>> = {
    connectionIndicator: fakeElement(),
    connectionDot: fakeElement(),
    connectionText: fakeElement(),
  };
  app.$ = (id: string) => els[id];
  app._pendingDeliveries = new Map();
  app._connectionStatus = 'connected';
  app._wsState = 'disconnected';
  app.activeSessionId = null;
  app.isOnline = true;
  Object.assign(app, overrides);
  const queued = overrides.queuedBytes ?? 0;
  if (queued > 0) {
    app._pendingDeliveries.set('s1', [{ seq: 1, data: 'x'.repeat(queued) }]);
  }
  return { app, els };
}

describe('connection indicator — transport display', () => {
  it('shows "WS" with a connected dot when the terminal WebSocket is open', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected' });
    app._updateConnectionIndicator();
    expect(els.connectionIndicator.style.display).toBe('flex');
    expect(els.connectionText.textContent).toBe('WS');
    expect(els.connectionDot.className).toContain('connected');
  });

  it('shows "HTTP" with a fallback dot when the socket dropped to HTTP POST', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'fallback' });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('HTTP');
    expect(els.connectionDot.className).toContain('fallback');
  });

  it('shows "WS…" while connecting or reconnecting the socket', () => {
    for (const state of ['connecting', 'reconnecting']) {
      const { app, els } = makeApp({ activeSessionId: 's1', _wsState: state });
      app._updateConnectionIndicator();
      expect(els.connectionText.textContent).toBe('WS…');
      expect(els.connectionDot.className).toContain('reconnecting');
    }
  });

  it('shows "Offline" when the browser reports no network', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', isOnline: false });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('Offline');
    expect(els.connectionDot.className).toContain('offline');
  });

  it('hides on an idle dashboard (no active session, healthy stream, no queue)', () => {
    const { app, els } = makeApp({ activeSessionId: null, _connectionStatus: 'connected' });
    app._updateConnectionIndicator();
    expect(els.connectionIndicator.style.display).toBe('none');
  });

  it('surfaces SSE reconnecting on the dashboard when there is no active terminal', () => {
    const { app, els } = makeApp({ activeSessionId: null, _connectionStatus: 'reconnecting' });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toContain('Reconnecting');
    expect(els.connectionDot.className).toContain('reconnecting');
  });
});

describe('connection indicator — keystroke backlog threshold', () => {
  it('does NOT annotate a single-keystroke (1B) queue — no "sending 1B" flicker', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 1 });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('WS');
    expect(els.connectionText.textContent).not.toMatch(/queued/);
  });

  it('does NOT annotate at the 4B threshold boundary', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 4 });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('WS');
  });

  it('annotates a genuine backlog (>4B) with a queued byte count', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 40 });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toMatch(/^WS · 40B queued$/);
  });
});

describe('connection indicator — never throws (the ReferenceError regression)', () => {
  it('renders every transport × stream × queue combination without throwing', () => {
    const wsStates = ['disconnected', 'connecting', 'connected', 'reconnecting', 'fallback'];
    const sseStates = ['connected', 'connecting', 'reconnecting', 'disconnected', 'offline'];
    for (const ws of wsStates) {
      for (const sse of sseStates) {
        for (const active of ['s1', null] as const) {
          for (const queuedBytes of [0, 1, 4, 200]) {
            for (const isOnline of [true, false]) {
              const { app } = makeApp({
                activeSessionId: active,
                _wsState: ws,
                _connectionStatus: sse,
                isOnline,
                queuedBytes,
              });
              expect(() => app._updateConnectionIndicator()).not.toThrow();
            }
          }
        }
      }
    }
  });
});

describe('durable input delivery is not aborted by the indicator (typing-lag regression)', () => {
  it('_reliableSend reaches _drainSession after updating the indicator', () => {
    const { app } = makeApp({ activeSessionId: 's1', _wsState: 'connected' });
    const a = app as unknown as {
      _seqCounters: Map<string, number>;
      _persistReliableState: () => void;
      _drainSession: (id: string) => void;
      _reliableSend: (id: string, data: string, useMux: boolean) => void;
    };
    a._seqCounters = new Map();
    a._persistReliableState = vi.fn();
    const drain = vi.fn();
    a._drainSession = drain;

    // A single keystroke. The indicator runs first; if it throws, drain is skipped.
    a._reliableSend('s1', 'x', false);

    expect(drain).toHaveBeenCalledWith('s1');
    expect(app._pendingDeliveries.get('s1')).toHaveLength(1);
  });
});
