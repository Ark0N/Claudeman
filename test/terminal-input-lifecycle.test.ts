import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

type Draft = {
  pendingText: string;
  flushedText: string;
  cjkText: string;
  updatedAt: number;
  ptyOwned?: boolean;
};

type InputLifecycleApp = {
  activeSessionId: string | null;
  sessions: Map<string, { mode: string }>;
  pendingWrites: string[];
  _inputState: {
    get: (sessionId: string) => Draft | null;
  };
  _localEchoOverlay: {
    state?: Record<string, string>;
    clear?: ReturnType<typeof vi.fn>;
    restoreDraft?: ReturnType<typeof vi.fn>;
    suppressBufferDetection?: ReturnType<typeof vi.fn>;
  } | null;
  _terminalInputController: {
    flushDraftText?: ReturnType<typeof vi.fn>;
    reset?: ReturnType<typeof vi.fn>;
    isPtyEditing?: ReturnType<typeof vi.fn>;
    restorePtyEditing?: ReturnType<typeof vi.fn>;
  } | null;
  _serializeAddon: null;
  _xtermSnapshots: Map<string, string>;
  _disconnectWs: ReturnType<typeof vi.fn>;
  _restoreSessionDraft: (sessionId: string, render?: boolean) => boolean;
  _cleanupPreviousSession: (newSessionId: string) => void;
  selectSession: (sessionId: string, options?: { forceReload?: boolean }) => Promise<void>;
  terminalBufferCache: Map<string, string>;
  _shouldFocusTerminalForTabSwitch: () => boolean;
  _setTerminalLoadState: (sessionId: string, generation: number, phase: string) => void;
};

function loadHarness(storage: MemoryStorage) {
  const pagehideListeners: Array<() => void> = [];
  const visibilityListeners: Array<() => void> = [];
  const cjk = {
    pendingText: '',
    getPendingText: vi.fn(() => cjk.pendingText),
    restorePendingText: vi.fn((text: string) => {
      cjk.pendingText = text;
    }),
    clear: vi.fn(() => {
      cjk.pendingText = '';
    }),
  };
  const document = {
    visibilityState: 'visible',
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'visibilitychange') visibilityListeners.push(listener);
    }),
    getElementById: vi.fn(() => null),
  };
  const window = {
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'pagehide') pagehideListeners.push(listener);
    }),
    removeEventListener: vi.fn(),
  };
  class FakeCanvas {
    getContext(): null {
      return null;
    }

    addEventListener(): void {}
  }

  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const state = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-input-state.js'), 'utf8');
  const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    Date,
    Math,
    crypto: { randomUUID: () => 'test-client' },
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: FakeCanvas,
    navigator: {
      onLine: true,
      sendBeacon: vi.fn(),
    },
    location: {
      pathname: '/',
      protocol: 'https:',
      host: 'test.local',
    },
    document,
    window,
    localStorage: storage,
    NotificationManager: class NotificationManager {},
    MobileDetection: {},
    CjkInput: cjk,
  });
  vm.runInContext(
    `${constants}\n${state}\n${appSource}\n` +
      `CodemanApp.prototype.init = function () {};\n` +
      `globalThis.__CodemanApp = CodemanApp;`,
    context
  );
  const CodemanApp = (
    context as {
      __CodemanApp: new () => InputLifecycleApp;
    }
  ).__CodemanApp;
  return {
    CodemanApp,
    cjk,
    firePagehide: () => {
      for (const listener of pagehideListeners) listener();
    },
  };
}

describe('terminal input lifecycle', () => {
  it('persists pagehide input and reconstructs it in a fresh app instance', () => {
    const storage = new MemoryStorage();
    const firstHarness = loadHarness(storage);
    const first = new firstHarness.CodemanApp();
    first.activeSessionId = 'session-a';
    first._localEchoOverlay = {
      state: {
        pendingText: 'typed',
        compositionText: '候補',
        flushedText: 'tabbed',
      },
    };
    firstHarness.cjk.pendingText = '未提交';

    firstHarness.firePagehide();

    const secondHarness = loadHarness(storage);
    const second = new secondHarness.CodemanApp();
    const restoreDraft = vi.fn();
    second.activeSessionId = 'session-a';
    second._localEchoOverlay = { restoreDraft };

    expect(second._restoreSessionDraft('session-a', false)).toBe(true);
    expect(restoreDraft).toHaveBeenCalledWith(
      {
        pendingText: 'typed候補',
        flushedText: 'tabbed',
      },
      false
    );
    expect(secondHarness.cjk.restorePendingText).toHaveBeenCalledWith('未提交');
  });

  it('hands pending text to the outgoing PTY and restores the remaining draft', () => {
    const storage = new MemoryStorage();
    const harness = loadHarness(storage);
    const app = new harness.CodemanApp();
    const flushDraftText = vi.fn();
    const reset = vi.fn();
    const clear = vi.fn();
    app.activeSessionId = 'session-a';
    app.sessions.set('session-a', { mode: 'codex' });
    app._serializeAddon = null;
    app._xtermSnapshots = new Map();
    app._disconnectWs = vi.fn();
    app._terminalInputController = { flushDraftText, reset };
    app._localEchoOverlay = {
      state: {
        pendingText: 'first\nsecond',
        compositionText: '候補',
        flushedText: 'older ',
      },
      clear,
      suppressBufferDetection: vi.fn(),
    };
    harness.cjk.pendingText = '中文';

    app._cleanupPreviousSession('session-b');

    expect(flushDraftText).toHaveBeenCalledWith('first\nsecond', 'session-a');
    expect(app._inputState.get('session-a')).toMatchObject({
      pendingText: '候補',
      flushedText: 'older first\nsecond',
      cjkText: '中文',
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();

    const restoreDraft = vi.fn();
    app._localEchoOverlay = { restoreDraft };
    expect(app._restoreSessionDraft('session-a', false)).toBe(true);
    expect(restoreDraft).toHaveBeenCalledWith(
      {
        pendingText: '候補',
        flushedText: 'older first\nsecond',
      },
      false
    );
    expect(harness.cjk.restorePendingText).toHaveBeenCalledWith('中文');
  });

  it('restores PTY-owned editing after browser recreation', () => {
    const storage = new MemoryStorage();
    const firstHarness = loadHarness(storage);
    const first = new firstHarness.CodemanApp();
    first.activeSessionId = 'session-a';
    first._localEchoOverlay = {
      state: {
        pendingText: '',
        compositionText: '',
        flushedText: '',
      },
    };
    first._terminalInputController = {
      isPtyEditing: vi.fn(() => true),
    };

    firstHarness.firePagehide();

    const secondHarness = loadHarness(storage);
    const second = new secondHarness.CodemanApp();
    const restorePtyEditing = vi.fn();
    second.activeSessionId = 'session-a';
    second._localEchoOverlay = { restoreDraft: vi.fn() };
    second._terminalInputController = { restorePtyEditing };

    expect(second._restoreSessionDraft('session-a', false)).toBe(true);
    expect(restorePtyEditing).toHaveBeenCalledWith('session-a', true);
    expect(second._inputState.get('session-a')).toMatchObject({
      ptyOwned: true,
    });
  });

  it('keeps the active owner visible to same-session force-reload cleanup', async () => {
    const harness = loadHarness(new MemoryStorage());
    const app = new harness.CodemanApp();
    const stop = new Error('stop after cleanup ownership check');
    let cleanupOwner: string | null = null;
    app.activeSessionId = 'session-a';
    app.sessions.set('session-a', { mode: 'codex' });
    app.terminalBufferCache = new Map([['session-a', 'cached frame']]);
    app._xtermSnapshots = new Map([['session-a', 'serialized frame']]);
    app._shouldFocusTerminalForTabSwitch = () => false;
    app._setTerminalLoadState = () => {};
    app._cleanupPreviousSession = () => {
      cleanupOwner = app.activeSessionId;
      throw stop;
    };

    await expect(app.selectSession('session-a', { forceReload: true })).rejects.toBe(stop);

    expect(cleanupOwner).toBe('session-a');
  });
});
