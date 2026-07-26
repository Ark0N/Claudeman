import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness(mode: string) {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    window: {},
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 0 },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
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
    write: (data: string) => writes.push(data),
    scrollToBottom: () => {},
    scrollToLine: () => {},
  };

  return { app, writes };
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
    app.terminal.buffer = { active: buffer };
    app.terminal.write = vi.fn(() => {
      buffer.viewportY = buffer.baseY;
    });
    app.terminal.scrollToLine = vi.fn((line: number) => {
      buffer.viewportY = line;
    });
    app._wasAtBottomBeforeWrite = true;
    app._terminalScrollLocked = true;
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();

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
