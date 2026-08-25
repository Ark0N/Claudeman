/**
 * @fileoverview Regression coverage for terminal refresh routing and coalescing.
 *
 * `session:needsRefresh` has two sources: a session-scoped signal and an
 * anonymous SSE backpressure recovery signal. Neither may replay unrelated
 * history, duplicate the active WebSocket's complete stream, or start a second
 * clear-and-replay cycle while one is already in flight.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

let fetchImpl: typeof fetch = vi.fn();

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
    fetch: (...args: Parameters<typeof fetch>) => fetchImpl(...args),
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

type RefreshApp = {
  activeSessionId: string | null;
  _wsReady: boolean;
  _wsSessionId: string | null;
  _isLoadingBuffer: boolean;
  _terminalRefreshSessionId: string | null;
  _terminalRefreshGeneration: number;
  _onSSENeedsRefresh: (data?: { id?: string }) => void;
  _onSessionNeedsRefresh: (data?: { id?: string }) => Promise<void>;
  [key: string]: unknown;
};

function appFromPrototype(): RefreshApp {
  return Object.create((CodemanApp as { prototype: object }).prototype) as RefreshApp;
}

describe('terminal refresh routing', () => {
  it('ignores a refresh emitted for a background session', () => {
    const app = appFromPrototype();
    app.activeSessionId = 'active';
    app._wsReady = false;
    app._wsSessionId = null;
    app._onSessionNeedsRefresh = vi.fn();

    app._onSSENeedsRefresh({ id: 'background' });

    expect(app._onSessionNeedsRefresh).not.toHaveBeenCalled();
  });

  it('ignores anonymous SSE backpressure recovery while the active WebSocket is complete', () => {
    const app = appFromPrototype();
    app.activeSessionId = 'active';
    app._wsReady = true;
    app._wsSessionId = 'active';
    app._onSessionNeedsRefresh = vi.fn();

    app._onSSENeedsRefresh({});

    expect(app._onSessionNeedsRefresh).not.toHaveBeenCalled();
  });

  it('still refreshes the active session when SSE is the terminal transport', () => {
    const app = appFromPrototype();
    app.activeSessionId = 'active';
    app._wsReady = false;
    app._wsSessionId = null;
    app._onSessionNeedsRefresh = vi.fn();

    app._onSSENeedsRefresh({ id: 'active' });

    expect(app._onSessionNeedsRefresh).toHaveBeenCalledOnce();
    expect(app._onSessionNeedsRefresh).toHaveBeenCalledWith({ id: 'active' });
  });
});

describe('terminal refresh coalescing', () => {
  it('allows only one clear-and-replay cycle per active session', async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolveWrite) => {
      releaseWrite = resolveWrite;
    });
    fetchImpl = vi.fn(async () => ({
      json: async () => ({ data: { terminalBuffer: 'history', source: 'mux-full-history' } }),
    })) as unknown as typeof fetch;

    const app = appFromPrototype();
    app.activeSessionId = 'active';
    app._isLoadingBuffer = false;
    app._terminalRefreshSessionId = null;
    app._terminalRefreshGeneration = 0;
    app.terminal = {
      buffer: { active: { baseY: 20, viewportY: 20 } },
      clear: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
    };
    app._replayWouldShrinkBuffer = () => false;
    app.chunkedTerminalWrite = vi.fn(async () => {
      await writeBlocked;
    });
    app._setHistoryTruncation = vi.fn();
    app.sendResize = vi.fn();
    app._localEchoOverlay = null;

    const first = app._onSessionNeedsRefresh({ id: 'active' });
    const duplicate = app._onSessionNeedsRefresh({ id: 'active' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    releaseWrite();
    await Promise.all([first, duplicate]);
    expect(app.chunkedTerminalWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects an older activation after switching A -> B -> A', async () => {
    let releaseOldResponse!: (response: unknown) => void;
    let releaseCurrentJson!: (payload: unknown) => void;
    const oldResponse = new Promise<unknown>((resolveResponse) => {
      releaseOldResponse = resolveResponse;
    });
    const currentJson = new Promise<unknown>((resolveJson) => {
      releaseCurrentJson = resolveJson;
    });
    fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce({ json: () => currentJson }) as unknown as typeof fetch;

    const app = appFromPrototype();
    app.activeSessionId = 'active';
    app._isLoadingBuffer = false;
    app._terminalRefreshSessionId = null;
    app._terminalRefreshGeneration = 0;
    app.terminal = {
      buffer: { active: { baseY: 20, viewportY: 20 } },
      clear: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
    };
    app._replayWouldShrinkBuffer = () => false;
    app.chunkedTerminalWrite = vi.fn(async () => {});
    app._setHistoryTruncation = vi.fn();
    app.sendResize = vi.fn();
    app._localEchoOverlay = null;

    const stale = app._onSessionNeedsRefresh({ id: 'active' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    // Mirror the generation invalidation in selectSession for A -> B -> A.
    app.activeSessionId = 'background';
    app._terminalRefreshGeneration++;
    app._terminalRefreshSessionId = null;
    app.activeSessionId = 'active';
    app._terminalRefreshGeneration++;
    app._terminalRefreshSessionId = null;

    const current = app._onSessionNeedsRefresh({ id: 'active' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    releaseOldResponse({ json: async () => ({ data: { terminalBuffer: 'stale history' } }) });
    await stale;
    expect(app.terminal.clear).not.toHaveBeenCalled();
    expect(app._terminalRefreshSessionId).toBe('active');

    releaseCurrentJson({ data: { terminalBuffer: 'current history', source: 'mux-full-history' } });
    await current;
    expect(app.terminal.clear).toHaveBeenCalledOnce();
    expect(app.chunkedTerminalWrite).toHaveBeenCalledWith('current history');
    expect(app._terminalRefreshSessionId).toBeNull();
  });
});
