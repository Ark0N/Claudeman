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
  _lastInitSnapshotTimestamp: number | null;
  _serverReloadRequested: boolean;
  _initGeneration: number;
  _handleServerInitEpoch: (serverStartedAt: unknown) => InitAction;
  _acceptServerInitSnapshot: (timestamp: unknown) => boolean;
  _reconcileSameServerInit: (data: unknown) => void;
  handleInit: (data: Record<string, unknown>) => void;
  loadState: () => Promise<void>;
  _onSessionTerminal: (data: { id: string; data: string }) => void;
  _clearTimer: ReturnType<typeof vi.fn>;
  _captureActiveSessionDraft: ReturnType<typeof vi.fn>;
  _persistReliableNow: ReturnType<typeof vi.fn>;
  batchTerminalWrite: ReturnType<typeof vi.fn>;
  activeSessionId: string | null;
  _inputState: { persistNow: ReturnType<typeof vi.fn> };
  _resetAllAppState: ReturnType<typeof vi.fn>;
};

function loadHarness() {
  const reload = vi.fn();
  const fetchMock = vi.fn();
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
    fetch: fetchMock,
    document: { addEventListener: vi.fn() },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { reload },
    },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as { __CodemanApp: new () => unknown }).__CodemanApp;
  return { CodemanApp, fetchMock, reload };
}

function makeApp(CodemanApp: new () => unknown): InitApp {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as InitApp;
  app._serverStartedAt = null;
  app._lastInitSnapshotTimestamp = null;
  app._serverReloadRequested = false;
  app._initGeneration = 1;
  app._clearTimer = vi.fn();
  app._captureActiveSessionDraft = vi.fn();
  app._persistReliableNow = vi.fn();
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
    const { CodemanApp, reload } = loadHarness();
    const app = makeApp(CodemanApp);
    app._serverStartedAt = 100;

    expect(app._handleServerInitEpoch(200)).toBe('reload');
    expect(app._captureActiveSessionDraft).toHaveBeenCalledOnce();
    expect(app._inputState.persistNow).toHaveBeenCalledOnce();
    expect(app._persistReliableNow).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();

    expect(app._handleServerInitEpoch(300)).toBe('reload');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('routes a same-process init through reconciliation without terminal reset', () => {
    const { CodemanApp } = loadHarness();
    const app = makeApp(CodemanApp);
    const reconcile = vi.fn();
    app._serverStartedAt = 100;
    app._reconcileSameServerInit = reconcile;

    const snapshot = { serverStartedAt: 100, timestamp: 200, sessions: [] };
    app.handleInit(snapshot);

    expect(reconcile).toHaveBeenCalledWith(snapshot);
    expect(app._resetAllAppState).not.toHaveBeenCalled();
    expect(app._initGeneration).toBe(1);
  });

  it('ignores an older same-process snapshot that arrives out of order', () => {
    const { CodemanApp } = loadHarness();
    const app = makeApp(CodemanApp);
    const reconcile = vi.fn();
    app._serverStartedAt = 100;
    app._lastInitSnapshotTimestamp = 200;
    app._reconcileSameServerInit = reconcile;

    app.handleInit({ serverStartedAt: 100, timestamp: 150, sessions: [] });

    expect(reconcile).not.toHaveBeenCalled();
    expect(app._resetAllAppState).not.toHaveBeenCalled();
    expect(app._lastInitSnapshotTimestamp).toBe(200);
  });

  it('discards a late HTTP fallback after SSE initialization wins the race', async () => {
    const { CodemanApp, fetchMock } = loadHarness();
    const app = makeApp(CodemanApp);
    const handleInit = vi.fn();
    app.handleInit = handleInit;
    let resolveFetch: (response: { json: () => Promise<unknown> }) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const fallback = app.loadState();
    app._initGeneration += 1;
    resolveFetch({ json: async () => ({ data: { serverStartedAt: 100 } }) });
    await fallback;

    expect(handleInit).not.toHaveBeenCalled();
  });

  it('reconciles missed metadata while retaining the active session', () => {
    const { CodemanApp } = loadHarness();
    const app = makeApp(CodemanApp) as InitApp & Record<string, any>;
    app.sessions = new Map([
      ['session-1', { id: 'session-1', name: 'before', totalCost: 1, workingDir: '/before' }],
      ['stale-session', { id: 'stale-session' }],
    ]);
    app.ralphStates = new Map([['session-1', { loop: {}, todos: [] }]]);
    app.ralphClosedSessions = new Set();
    app.sessionOrder = ['session-1', 'stale-session'];
    app.isSoloWindow = false;
    app.subagents = new Map([
      ['agent-1', { agentId: 'agent-1', status: 'running' }],
      ['stale-agent', { agentId: 'stale-agent', status: 'completed' }],
    ]);
    app.subagentActivity = new Map([['stale-agent', []]]);
    app.subagentToolResults = new Map([['stale-agent', new Map()]]);
    app.minimizedSubagents = new Map([['session-1', new Set(['stale-agent'])]]);
    app.activeSubagentId = 'stale-agent';
    app.workflowRuns = new Map([
      ['run-1', { runId: 'run-1' }],
      ['stale-run', { runId: 'stale-run' }],
    ]);
    app.workflowRunDetails = new Map([['stale-run', {}]]);
    app.activeWorkflowRunId = 'stale-run';
    app.systemStatsInterval = {};
    app.timerInterval = {};

    app._onSessionDeleted = vi.fn(({ id }) => app.sessions.delete(id));
    app.updateSubagentParentNames = vi.fn();
    app.updateRespawnTokens = vi.fn();
    app.syncFileBrowserSession = vi.fn();
    app.recheckOrphanSubagents = vi.fn();
    app.updateConnectionLines = vi.fn();
    app.syncSessionOrder = vi.fn(() => {
      app.sessionOrder = ['session-1'];
    });
    app.selectSession = vi.fn();
    app.updateTimer = vi.fn();
    app.showTimer = vi.fn();
    app.hideTimer = vi.fn();
    app.updatePlanUsageChip = vi.fn();
    app.forceCloseSubagentWindow = vi.fn();
    app.findParentSessionForSubagent = vi.fn();
    app.renderSubagentPanel = vi.fn();
    app.updateSubagentWindows = vi.fn();
    app.closeUltracodeWindow = vi.fn();
    app.seedWorkflowRuns = vi.fn((runs) => {
      app.workflowRuns = new Map(runs.map((run: { runId: string }) => [run.runId, run]));
    });
    app.updateCost = vi.fn();
    app.renderSessionTabs = vi.fn();
    app.renderRalphStatePanel = vi.fn();
    app.startSystemStatsPolling = vi.fn();
    app.stopSystemStatsPolling = vi.fn();

    app._reconcileSameServerInit({
      sessions: [
        {
          id: 'session-1',
          name: 'after',
          totalCost: 3,
          tokens: { input: 10 },
          workingDir: '/after',
        },
      ],
      sessionOrder: ['session-1'],
      scheduledRuns: [],
      respawnStatus: { 'session-1': { enabled: true } },
      subagents: [
        { agentId: 'agent-1', status: 'completed' },
        { agentId: 'agent-2', status: 'running' },
      ],
      workflowRuns: [{ runId: 'run-1', status: 'running' }],
    });

    expect(app.activeSessionId).toBe('session-1');
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.sessions.get('session-1')?.name).toBe('after');
    expect(app.sessions.has('stale-session')).toBe(false);
    expect(app.ralphStates.has('session-1')).toBe(false);
    expect(app.syncFileBrowserSession).toHaveBeenCalledWith('session-1', { force: true });
    expect(app.totalCost).toBe(3);
    expect(app.currentRun).toBeNull();
    expect(app.hideTimer).toHaveBeenCalledOnce();
    expect(app.forceCloseSubagentWindow).toHaveBeenCalledWith('stale-agent');
    expect(app.minimizedSubagents.size).toBe(0);
    expect(app.subagents.get('agent-1')?.status).toBe('completed');
    expect(app.findParentSessionForSubagent).toHaveBeenCalledWith('agent-2');
    expect(app.workflowRunDetails.has('stale-run')).toBe(false);
    expect(app.closeUltracodeWindow).toHaveBeenCalledWith('stale-run', false);
  });

  it('drops terminal output after a replacement page has been requested', () => {
    const { CodemanApp } = loadHarness();
    const app = makeApp(CodemanApp);
    app._serverReloadRequested = true;

    app._onSessionTerminal({ id: 'session-1', data: 'stale reconnect redraw' });

    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
  });
});
