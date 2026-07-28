import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness(
  mode: string,
  {
    deviceType = 'desktop',
    visibilityState = 'visible',
  }: { deviceType?: 'mobile' | 'tablet' | 'desktop'; visibilityState?: 'visible' | 'hidden' } = {}
) {
  const CodemanApp = function CodemanApp(this: any) {};
  const frameCallbacks: Array<() => void> = [];
  const timeoutCallbacks: Array<() => void> = [];
  const context = vm.createContext({
    window: {},
    document: { visibilityState },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 0 },
    MobileDetection: { getDeviceType: () => deviceType },
    requestAnimationFrame: (fn: () => void) => {
      frameCallbacks.push(fn);
      return 1;
    },
    setTimeout: (fn: () => void) => {
      timeoutCallbacks.push(fn);
      return 1;
    },
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => 'blob:yield',
      revokeObjectURL: () => {},
    },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
    CODEX_POST_SWITCH_MAX_HOLD_MS: 1500,
    CODEX_RESTART_RECOVERY_MAX_HOLD_MS: 3000,
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  const writes: string[] = [];
  app.activeSessionId = 'session-1';
  app.sessions = new Map([['session-1', { mode }]]);
  app.pendingWrites = [];
  app.writeFrameScheduled = false;
  app._wasAtBottomBeforeWrite = false;
  app._workerYield = () => {};
  app._chunkedWriteGen = 0;
  app.terminal = {
    write: (data: string, callback?: () => void) => {
      writes.push(data);
      callback?.();
    },
    scrollToBottom: () => {},
    scrollToLine: () => {},
  };

  return { app, writes, frameCallbacks, timeoutCallbacks };
}

describe('terminal flush budget', () => {
  it('drains a large final batch without waiting for unrelated terminal output', () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    const scheduled: Array<() => void> = [];
    app._safeYield = (callback: () => void) => {
      scheduled.push(callback);
    };
    app.isTerminalAtBottom = () => true;

    app.batchTerminalWrite('x'.repeat(96 * 1024));
    expect(scheduled).toHaveLength(1);

    while (scheduled.length > 0) {
      scheduled.shift()?.();
    }

    expect(writes.map((write) => write.length)).toEqual([32 * 1024, 32 * 1024, 32 * 1024]);
    expect(app.pendingWrites).toEqual([]);
    expect(app.writeFrameScheduled).toBe(false);
  });

  it('uses a smaller first-frame write budget for Codex output to reduce renderer stalls', () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    app.pendingWrites.push('x'.repeat(96 * 1024));

    app.flushPendingWrites();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(32 * 1024);
    expect(app.pendingWrites.join('')).toHaveLength(64 * 1024);
  });

  it('keeps the larger first-frame write budget for non-Codex terminal output', () => {
    const { app, writes } = loadTerminalUiHarness('claude');
    app.pendingWrites.push('x'.repeat(96 * 1024));

    app.flushPendingWrites();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(64 * 1024);
    expect(app.pendingWrites.join('')).toHaveLength(32 * 1024);
  });

  it('uses a display-frame-sized budget for Claude output on mobile', () => {
    const { app, writes } = loadTerminalUiHarness('claude', { deviceType: 'mobile' });
    app.pendingWrites.push('x'.repeat(96 * 1024));

    app.flushPendingWrites();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(16 * 1024);
    expect(app.pendingWrites.join('')).toHaveLength(80 * 1024);
  });

  it('publishes mobile output on complete synchronized-update boundaries', () => {
    const { app, writes } = loadTerminalUiHarness('claude', { deviceType: 'mobile' });
    const block = (char: string) => `\x1b[?2026h${char.repeat(8 * 1024)}\x1b[?2026l`;
    const first = block('a');
    const second = block('b');
    app.pendingWrites.push(first + second);

    app.flushPendingWrites();

    expect(writes).toEqual([first]);
    expect(app.pendingWrites).toEqual([second]);
  });

  it('does not schedule the next live chunk until xterm parses the current one', () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    const scheduled: Array<() => void> = [];
    let writeDone: (() => void) | undefined;
    app._safeYield = (callback: () => void) => {
      scheduled.push(callback);
    };
    app.terminal.write = (data: string, callback?: () => void) => {
      writes.push(data);
      writeDone = callback;
    };
    app.pendingWrites.push('x'.repeat(64 * 1024));

    app.flushPendingWrites();

    expect(writes.map((write) => write.length)).toEqual([32 * 1024]);
    expect(app.pendingWrites.join('')).toHaveLength(32 * 1024);
    expect(scheduled).toEqual([]);

    writeDone?.();

    expect(scheduled).toHaveLength(1);
  });

  it('keeps the Codex switch cover until post-attach redraw output becomes quiet', () => {
    const { app } = loadTerminalUiHarness('codex');
    const scheduled: Array<() => void> = [];
    const remove = vi.fn();
    app._safeYield = (callback: () => void) => {
      scheduled.push(callback);
    };
    app._terminalHistoryReplayCover = { remove };
    app._terminalHistoryReplayCoverOwner = 7;
    app._terminalHistoryReplayCoverVersion = 1;
    app._terminalHistoryReplayCoverComplete = true;
    app._terminalHistoryReplayCoverCompleteAt = Date.now();
    app._terminalHistoryReplayCoverCheckScheduled = false;
    app._terminalHistoryReplayFencePending = false;
    app._terminalHistoryReplayQuietUntil = 0;
    app._wsState = 'connected';
    app._isLoadingBuffer = false;
    app._terminalWriteInFlight = null;
    app.writeFrameScheduled = false;
    app.pendingWrites = [];

    app._deferTerminalHistoryReplayCover('session-1', 500);
    app._tryFinishTerminalHistoryReplayCover();

    expect(app._terminalHistoryReplayQuietUntil).toBeGreaterThan(Date.now());
    expect(remove).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    // Once the quiet barrier expires, the existing xterm paint fence owns the
    // final removal. Every redraw byte was parsed while the cover stayed opaque.
    app._terminalHistoryReplayQuietUntil = 0;
    while (scheduled.length > 0) scheduled.shift()?.();

    expect(remove).toHaveBeenCalledOnce();
    expect(app._terminalHistoryReplayCover).toBeNull();
  });

  it('invalidates an armed cover-removal fence when later Codex output arrives', () => {
    const { app } = loadTerminalUiHarness('codex');
    let paintFence: (() => void) | undefined;
    app.terminal.write = (_data: string, callback?: () => void) => {
      paintFence = callback;
    };
    app._terminalHistoryReplayCover = { remove: vi.fn() };
    app._terminalHistoryReplayCoverOwner = 7;
    app._terminalHistoryReplayCoverVersion = 4;
    app._terminalHistoryReplayCoverComplete = true;
    app._terminalHistoryReplayCoverCompleteAt = Date.now();
    app._terminalHistoryReplayCoverCheckScheduled = false;
    app._terminalHistoryReplayFencePending = false;
    app._terminalHistoryReplayQuietUntil = 0;
    app._wsState = 'connected';
    app._isLoadingBuffer = false;
    app._terminalWriteInFlight = null;
    app.writeFrameScheduled = false;
    app.pendingWrites = [];

    app._tryFinishTerminalHistoryReplayCover();
    expect(paintFence).toBeTypeOf('function');
    expect(app._terminalHistoryReplayFencePending).toBe(true);
    const armedVersion = app._terminalHistoryReplayCoverVersion;

    app._deferTerminalHistoryReplayCover('session-1', 500);

    expect(app._terminalHistoryReplayFencePending).toBe(false);
    expect(app._terminalHistoryReplayCoverVersion).toBeGreaterThan(armedVersion);
  });

  it('allows restart recovery to hold a stable frame beyond the normal switch cap', () => {
    const { app } = loadTerminalUiHarness('codex');
    const writes = vi.fn();
    app.terminal.write = writes;
    app._serverRestartRecovery = true;
    app._terminalHistoryReplayCover = { remove: vi.fn() };
    app._terminalHistoryReplayCoverOwner = 7;
    app._terminalHistoryReplayCoverVersion = 1;
    app._terminalHistoryReplayCoverComplete = true;
    app._terminalHistoryReplayCoverCompleteAt = Date.now() - 2000;
    app._terminalHistoryReplayCoverCheckScheduled = false;
    app._terminalHistoryReplayFencePending = false;
    app._terminalHistoryReplayQuietUntil = Date.now() + 500;
    app._wsState = 'connected';
    app._isLoadingBuffer = false;
    app._terminalWriteInFlight = null;
    app.writeFrameScheduled = false;
    app.pendingWrites = [];

    app._tryFinishTerminalHistoryReplayCover();

    expect(writes).not.toHaveBeenCalled();
  });

  it('holds a transport-loss cover until server init releases it', () => {
    const { app } = loadTerminalUiHarness('codex');
    const remove = vi.fn();
    app._captureTerminalHistoryReplayCover = () => {
      app._terminalHistoryReplayCover = { remove };
      app._terminalHistoryReplayCoverVersion += 1;
      return true;
    };
    app._terminalHistoryReplayCover = null;
    app._terminalHistoryReplayCoverVersion = 0;
    app._terminalHistoryReplayCoverCheckScheduled = false;
    app._terminalHistoryReplayFencePending = false;
    app._terminalHistoryReplayQuietUntil = 0;

    expect(app._freezeTerminalForTransportLoss('session-1')).toBe(true);
    expect(app._terminalTransportFreezeSessionId).toBe('session-1');
    expect(app._terminalHistoryReplayCoverComplete).toBe(false);

    expect(app._releaseTerminalTransportFreeze('session-1', 500)).toBe(true);
    expect(app._terminalTransportFreezeSessionId).toBeNull();
    expect(app._terminalHistoryReplayCoverComplete).toBe(true);
    expect(app._terminalHistoryReplayQuietUntil).toBeGreaterThan(Date.now());
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not delay the history cover for Claude output', () => {
    const { app } = loadTerminalUiHarness('claude');
    app._terminalHistoryReplayCover = { remove: vi.fn() };
    app._terminalHistoryReplayQuietUntil = 0;

    app._deferTerminalHistoryReplayCover('session-1', 500);

    expect(app._terminalHistoryReplayQuietUntil).toBe(0);
  });

  it('invalidates a stale live-write callback when a buffer replay takes ownership', () => {
    const { app } = loadTerminalUiHarness('claude');
    let writeDone: (() => void) | undefined;
    const rerender = vi.fn();
    app._localEchoOverlay = { hasPending: true, rerender };
    app.terminal.write = (_data: string, callback?: () => void) => {
      writeDone = callback;
    };
    app.pendingWrites.push('old session output');

    app.flushPendingWrites();
    app._beginBufferLoad('new-session-replay');
    writeDone?.();

    expect(app._terminalWriteInFlight).toBeNull();
    expect(rerender).not.toHaveBeenCalled();
  });

  it('repositions a pending local draft only after xterm applies agent output', () => {
    const { app, writes } = loadTerminalUiHarness('claude');
    let writeDone: (() => void) | undefined;
    const rerender = vi.fn();
    app._localEchoOverlay = { hasPending: true, rerender };
    app.terminal.write = (data: string, callback?: () => void) => {
      writes.push(data);
      writeDone = callback;
    };
    app.pendingWrites.push('agent output that moves the prompt');

    app.flushPendingWrites();

    expect(writes).toEqual(['agent output that moves the prompt']);
    expect(writeDone).toBeTypeOf('function');
    expect(rerender).not.toHaveBeenCalled();

    writeDone?.();

    expect(rerender).toHaveBeenCalledOnce();
  });

  it('waits for xterm to process small buffer replays before completing buffer load', async () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    let writeDone: (() => void) | undefined;
    let resolved = false;
    const finishBufferLoad = vi.fn();
    app._finishBufferLoad = finishBufferLoad;
    app.terminal.write = (data: string, callback?: () => void) => {
      writes.push(data);
      writeDone = callback;
    };

    const promise = app.chunkedTerminalWrite('fresh tmux pane frame').then(() => {
      resolved = true;
    });

    await Promise.resolve();

    expect(writes).toEqual(['fresh tmux pane frame']);
    expect(writeDone).toBeTypeOf('function');
    expect(resolved).toBe(false);
    expect(finishBufferLoad).not.toHaveBeenCalled();

    writeDone?.();
    await promise;

    expect(resolved).toBe(true);
    expect(finishBufferLoad).toHaveBeenCalledOnce();
  });

  it('waits for each replay chunk to parse before yielding the next one', async () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    const scheduled: Array<() => void> = [];
    const writeCallbacks: Array<() => void> = [];
    app._safeYield = (callback: () => void) => {
      scheduled.push(callback);
    };
    app.terminal.write = (data: string, callback?: () => void) => {
      writes.push(data);
      if (callback) writeCallbacks.push(callback);
    };

    const promise = app.chunkedTerminalWrite('x'.repeat(64 * 1024), 32 * 1024);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(writes.map((write) => write.length)).toEqual([32 * 1024]);
    expect(scheduled).toHaveLength(0);

    writeCallbacks.shift()?.();
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(writes.map((write) => write.length)).toEqual([32 * 1024, 32 * 1024]);

    writeCallbacks.shift()?.();
    scheduled.shift()?.();
    scheduled.shift()?.();
    await promise;
  });

  it('keeps the viewport at the bottom after every parsed history chunk', async () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    const scheduled: Array<() => void> = [];
    const scrollToBottom = vi.fn();
    app._safeYield = (callback: () => void) => {
      scheduled.push(callback);
    };
    app.terminal.scrollToBottom = scrollToBottom;

    const promise = app.chunkedTerminalWrite('x'.repeat(64 * 1024), 32 * 1024, 'history-load', { followBottom: true });
    while (scheduled.length > 0) {
      scheduled.shift()?.();
    }
    await promise;

    expect(writes.map((write) => write.length)).toEqual([32 * 1024, 32 * 1024]);
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it('uses animation frames instead of the Worker while the page is visible', () => {
    const { app, frameCallbacks, timeoutCallbacks } = loadTerminalUiHarness('claude');
    const callback = vi.fn();
    app._workerYield = vi.fn();

    app._safeYield(callback);

    expect(frameCallbacks).toHaveLength(1);
    expect(timeoutCallbacks).toHaveLength(1);
    expect(app._workerYield).not.toHaveBeenCalled();

    frameCallbacks.shift()?.();
    timeoutCallbacks.shift()?.();

    expect(callback).toHaveBeenCalledOnce();
  });

  it('uses the Worker wake-up path while the page is hidden', () => {
    const { app, frameCallbacks, timeoutCallbacks } = loadTerminalUiHarness('claude', {
      visibilityState: 'hidden',
    });
    const callback = vi.fn();
    app._workerYield = vi.fn();

    app._safeYield(callback);

    expect(frameCallbacks).toHaveLength(0);
    expect(timeoutCallbacks).toHaveLength(1);
    expect(app._workerYield).toHaveBeenCalledOnce();
  });

  it('leaves a caller-owned buffer load open after replaying a chunk', async () => {
    const { app } = loadTerminalUiHarness('codex');
    const beginBufferLoad = vi.fn(() => 'nested-owner');
    const finishBufferLoad = vi.fn();
    app._beginBufferLoad = beginBufferLoad;
    app._finishBufferLoad = finishBufferLoad;
    app.terminal.write = (_data: string, callback?: () => void) => callback?.();

    await app.chunkedTerminalWrite('cached frame', 32 * 1024, 'select-owner');

    expect(beginBufferLoad).not.toHaveBeenCalled();
    expect(finishBufferLoad).not.toHaveBeenCalled();
  });

  it('keeps stale buffer load owners from finishing a newer load', () => {
    const { app } = loadTerminalUiHarness('codex');

    app._beginBufferLoad('select-1');
    app._beginBufferLoad('select-2');

    expect(app._finishBufferLoad('select-1')).toBe(false);
    expect(app._isLoadingBuffer).toBe(true);
    expect(app._bufferLoadOwner).toBe('select-2');

    expect(app._finishBufferLoad('select-2')).toBe(true);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._bufferLoadOwner).toBe(null);
  });

  it('does not snap back to bottom during Codex Working redraws while history is scroll-locked', () => {
    const { app } = loadTerminalUiHarness('codex');
    const scrollToBottom = vi.fn();
    app.terminal.scrollToBottom = scrollToBottom;
    app._wasAtBottomBeforeWrite = true;
    app._terminalScrollLocked = true;
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();

    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('restores the user scroll position when Codex Working redraws move the viewport', () => {
    const { app } = loadTerminalUiHarness('codex');
    const buffer = { viewportY: 40, baseY: 100 };
    let writeDone: (() => void) | undefined;
    app.terminal.buffer = { active: buffer };
    app.terminal.write = vi.fn((_data: string, callback?: () => void) => {
      buffer.viewportY = buffer.baseY;
      writeDone = callback;
    });
    app.terminal.scrollToLine = vi.fn((line: number) => {
      buffer.viewportY = line;
    });
    app._wasAtBottomBeforeWrite = true;
    app._terminalScrollLocked = true;
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();

    expect(buffer.viewportY).toBe(100);

    writeDone?.();

    expect(buffer.viewportY).toBe(40);
  });

  it('keeps the history lock until a downward scroll actually reaches the bottom', () => {
    const { app } = loadTerminalUiHarness('codex');
    const buffer = { viewportY: 40, baseY: 50 };
    app.terminal.buffer = { active: buffer };
    app.terminal.scrollLines = vi.fn((lines: number) => {
      buffer.viewportY = Math.max(0, Math.min(buffer.baseY, buffer.viewportY + lines));
    });

    app._scrollTerminalLines(-2);
    expect(app._shouldPreserveTerminalScroll()).toBe(true);

    app._scrollTerminalLines(2);
    expect(app._shouldPreserveTerminalScroll()).toBe(true);

    app._scrollTerminalLines(20);
    expect(app._shouldPreserveTerminalScroll()).toBe(false);
  });
});
