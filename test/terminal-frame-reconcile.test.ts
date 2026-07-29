import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalMixin() {
  const CodemanApp = function CodemanApp(this: any) {};
  const fetchMock = vi.fn(async () => ({ ok: true }));
  const keyboardHandler = {
    onTerminalFrameAuthoritative: vi.fn(),
    onTerminalFrameReady: vi.fn(),
  };
  const context = vm.createContext({
    window: {},
    CodemanApp,
    KeyboardHandler: keyboardHandler,
    MobileDetection: { isTouchDevice: () => true },
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 0 },
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    setTimeout,
    clearTimeout,
    fetch: fetchMock,
    TextDecoder,
    AbortController,
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
    TERMINAL_LATEST_FRAME_SIZE: 128 * 1024,
    TERMINAL_FRAME_FETCH_TIMEOUT_MS: 5000,
  });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'terminal-ui.js' });
  return {
    mixin: (CodemanApp as any).prototype,
    fetchMock,
    keyboardHandler,
  };
}

describe('authoritative terminal-frame reconciliation', () => {
  it('coalesces intermediate requests and resolves all callers from the latest drain', async () => {
    const { mixin } = loadTerminalMixin();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reasons: string[] = [];
    const app: any = {
      activeSessionId: 'session-1',
      sessions: new Map([['session-1', { mode: 'codex' }]]),
      terminal: {},
      _terminalFrameReconcileSeq: 0,
      _terminalFrameReconcilePending: null,
      _terminalFrameReconcilePromise: null,
      _requestTerminalFrameReconcile: mixin._requestTerminalFrameReconcile,
      _drainTerminalFrameReconciles: mixin._drainTerminalFrameReconciles,
      _runTerminalFrameReconcile: vi.fn(async (request: { reason: string }) => {
        reasons.push(request.reason);
        if (request.reason === 'first') await firstBlocked;
        return request.reason === 'third';
      }),
    };

    const first = app._requestTerminalFrameReconcile({ reason: 'first' });
    const second = app._requestTerminalFrameReconcile({ reason: 'second' });
    const third = app._requestTerminalFrameReconcile({ reason: 'third' });

    expect(first).toBe(second);
    expect(second).toBe(third);
    releaseFirst();

    await expect(first).resolves.toBe(true);
    expect(reasons).toEqual(['first', 'third']);
    expect(app._terminalFrameReconcilePending).toBeNull();
    expect(app._terminalFrameReconcilePromise).toBeNull();
  });

  it('interrupts an older settle window when a newer request supersedes it', async () => {
    const { mixin } = loadTerminalMixin();
    const reasons: string[] = [];
    const app: any = {
      activeSessionId: 'session-1',
      sessions: new Map([['session-1', { mode: 'codex' }]]),
      terminal: {},
      _terminalFrameReconcileSeq: 0,
      _terminalFrameReconcilePending: null,
      _terminalFrameReconcilePromise: null,
      _terminalFrameReconcileAbortController: null,
      _requestTerminalFrameReconcile: mixin._requestTerminalFrameReconcile,
      _drainTerminalFrameReconciles: mixin._drainTerminalFrameReconciles,
      _waitForTerminalFrameSettle: mixin._waitForTerminalFrameSettle,
      _runTerminalFrameReconcile: vi.fn(async function (request: { reason: string }) {
        reasons.push(request.reason);
        if (request.reason !== 'first') return true;
        const controller = new AbortController();
        this._terminalFrameReconcileAbortController = controller;
        return this._waitForTerminalFrameSettle(10_000, controller.signal);
      }),
    };

    const first = app._requestTerminalFrameReconcile({ reason: 'first' });
    const latest = app._requestTerminalFrameReconcile({ reason: 'latest' });

    await expect(latest).resolves.toBe(true);
    await expect(first).resolves.toBe(true);
    expect(reasons).toEqual(['first', 'latest']);
  });

  it('closes synchronized-update mode and releases the buffer gate when invalidated mid-paint', async () => {
    const { mixin, fetchMock } = loadTerminalMixin();
    const writes: string[] = [];
    const app: any = {
      activeSessionId: 'session-1',
      sessions: new Map([['session-1', { mode: 'codex' }]]),
      pendingWrites: [],
      writeFrameScheduled: false,
      flickerFilterBuffer: '',
      flickerFilterActive: false,
      _bufferLoadSeq: 0,
      _bufferLoadOwner: null,
      _isLoadingBuffer: false,
      _loadBufferQueue: null,
      _terminalFrameReconcileSeq: 1,
      _terminalFrameReconcilePending: null,
      _isTerminalFrameReconcileCurrent: mixin._isTerminalFrameReconcileCurrent,
      _runTerminalFrameReconcile: mixin._runTerminalFrameReconcile,
      _beginBufferLoad: mixin._beginBufferLoad,
      _finishBufferLoad: mixin._finishBufferLoad,
      _isTerminalCursor: mixin._isTerminalCursor,
      _terminalEventAfterSnapshot: mixin._terminalEventAfterSnapshot,
      _clearTimer: vi.fn(),
      _waitForTerminalParserFence: vi.fn(async () => {}),
      _waitForTerminalPaint: vi.fn(async () => {}),
      _readTerminalSnapshotResponse: vi.fn(async () => ({
        aborted: false,
        source: 'mux-visible',
        terminalBuffer: 'AUTHORITATIVE FRAME',
        cursor: { stream: 'stream-a', generation: 1, start: 0, end: 19 },
      })),
      chunkedTerminalWrite: vi.fn(async () => {
        app._terminalFrameReconcileSeq += 1;
      }),
      batchTerminalWrite: vi.fn(),
      terminal: {
        write: vi.fn((data: string, callback?: () => void) => {
          writes.push(data);
          callback?.();
        }),
        scrollToBottom: vi.fn(),
      },
    };
    const request = {
      id: 1,
      sessionId: 'session-1',
      reason: 'cancel-mid-paint',
      resizeOptions: null,
      settleMs: 0,
      captureWhenUnchanged: false,
    };

    await expect(app._runTerminalFrameReconcile(request)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writes.at(-1)).toBe('\x1b[?2026l');
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._bufferLoadOwner).toBeNull();
  });

  it('aborts a stalled snapshot request and releases the buffer gate', async () => {
    vi.useFakeTimers();
    try {
      const { mixin, fetchMock } = loadTerminalMixin();
      fetchMock.mockImplementation(
        async (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          })
      );
      const app: any = {
        activeSessionId: 'session-1',
        sessions: new Map([['session-1', { mode: 'codex' }]]),
        pendingWrites: [],
        writeFrameScheduled: false,
        flickerFilterBuffer: '',
        flickerFilterActive: false,
        _bufferLoadSeq: 0,
        _bufferLoadOwner: null,
        _isLoadingBuffer: false,
        _loadBufferQueue: null,
        _terminalFrameReconcileSeq: 1,
        _terminalFrameReconcilePending: null,
        _terminalFrameReconcileAbortController: null,
        _isTerminalFrameReconcileCurrent: mixin._isTerminalFrameReconcileCurrent,
        _runTerminalFrameReconcile: mixin._runTerminalFrameReconcile,
        _beginBufferLoad: mixin._beginBufferLoad,
        _finishBufferLoad: mixin._finishBufferLoad,
        _clearTimer: vi.fn(),
        _waitForTerminalPaint: vi.fn(async () => {}),
        batchTerminalWrite: vi.fn(),
        terminal: {
          write: vi.fn((_data: string, callback?: () => void) => callback?.()),
          scrollToBottom: vi.fn(),
        },
      };
      const request = {
        id: 1,
        sessionId: 'session-1',
        reason: 'stalled-fetch',
        resizeOptions: null,
        settleMs: 0,
        captureWhenUnchanged: false,
      };

      const reconcile = app._runTerminalFrameReconcile(request);
      await vi.advanceTimersByTimeAsync(5000);

      await expect(reconcile).resolves.toBe(false);
      expect(app._isLoadingBuffer).toBe(false);
      expect(app._bufferLoadOwner).toBeNull();
      expect(app._terminalFrameReconcileAbortController).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
