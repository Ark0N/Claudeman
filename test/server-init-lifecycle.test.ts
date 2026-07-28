/**
 * @fileoverview Client init lifecycle regression tests.
 *
 * A same-process SSE reconnect must reconcile metadata without destroying and
 * replaying the active terminal. A changed process epoch must persist input and
 * reload once so an already-open browser does not keep running stale assets.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type InitAction = 'legacy' | 'initial' | 'reconnect' | 'reload';

type InitApp = {
  _serverStartedAt: number | null;
  _serverReloadRequested: boolean;
  _serverRestartRecovery: boolean;
  _initGeneration: number;
  _handleServerInitEpoch: (serverStartedAt: unknown) => InitAction;
  _reconcileSameServerInit: (data: unknown) => void;
  handleInit: (data: Record<string, unknown>) => void;
  _onSessionTerminal: (data: { id: string; data: string }) => void;
  _clearTimer: ReturnType<typeof vi.fn>;
  _captureActiveSessionDraft: ReturnType<typeof vi.fn>;
  _persistReliableNow: ReturnType<typeof vi.fn>;
  _releaseTerminalTransportFreeze: ReturnType<typeof vi.fn>;
  batchTerminalWrite: ReturnType<typeof vi.fn>;
  activeSessionId: string | null;
  _inputState: { persistNow: ReturnType<typeof vi.fn> };
  _resetAllAppState: ReturnType<typeof vi.fn>;
};

function loadHarness() {
  const reload = vi.fn();
  const sessionStorage = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    location: { protocol: 'https:', host: 'test.local' },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn() },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    sessionStorage,
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { reload },
    },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as { __CodemanApp: new () => unknown }).__CodemanApp;
  return { CodemanApp, reload, sessionStorage };
}

function makeApp(CodemanApp: new () => unknown): InitApp {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as InitApp;
  app._serverStartedAt = null;
  app._serverReloadRequested = false;
  app._serverRestartRecovery = false;
  app._initGeneration = 1;
  app._clearTimer = vi.fn();
  app._captureActiveSessionDraft = vi.fn();
  app._persistReliableNow = vi.fn();
  app._releaseTerminalTransportFreeze = vi.fn();
  app.batchTerminalWrite = vi.fn();
  app.activeSessionId = 'session-1';
  app._inputState = { persistNow: vi.fn() };
  app._resetAllAppState = vi.fn();
  return app;
}

describe('client server-init lifecycle', () => {
  it('distinguishes initial load and same-process reconnect by server epoch', () => {
    const { CodemanApp } = loadHarness();
    const app = makeApp(CodemanApp);

    expect(app._handleServerInitEpoch(undefined)).toBe('legacy');
    expect(app._handleServerInitEpoch(100)).toBe('initial');
    expect(app._handleServerInitEpoch(100)).toBe('reconnect');
  });

  it('persists editable and queued input before reloading stale assets once', () => {
    const { CodemanApp, reload, sessionStorage } = loadHarness();
    const app = makeApp(CodemanApp);
    app._serverStartedAt = 100;

    expect(app._handleServerInitEpoch(200)).toBe('reload');
    expect(app._captureActiveSessionDraft).toHaveBeenCalledOnce();
    expect(app._inputState.persistNow).toHaveBeenCalledOnce();
    expect(app._persistReliableNow).toHaveBeenCalledOnce();
    expect(sessionStorage.setItem).toHaveBeenCalledWith('codeman-server-restart-recovery', '1');
    expect(reload).toHaveBeenCalledOnce();

    expect(app._handleServerInitEpoch(300)).toBe('reload');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('routes a same-process init through metadata reconciliation without terminal reset', () => {
    const { CodemanApp } = loadHarness();
    const app = makeApp(CodemanApp);
    const reconcile = vi.fn();
    app._serverStartedAt = 100;
    app._reconcileSameServerInit = reconcile;

    const snapshot = { serverStartedAt: 100, sessions: [] };
    app.handleInit(snapshot);

    expect(reconcile).toHaveBeenCalledWith(snapshot);
    expect(app._releaseTerminalTransportFreeze).toHaveBeenCalledWith('session-1');
    expect(app._resetAllAppState).not.toHaveBeenCalled();
    expect(app._initGeneration).toBe(1);
  });

  it('drops terminal output after a replacement page has been requested', () => {
    const { CodemanApp } = loadHarness();
    const app = makeApp(CodemanApp);
    app._serverReloadRequested = true;

    app._onSessionTerminal({ id: 'session-1', data: 'stale reconnect redraw' });

    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
  });
});
