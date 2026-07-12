/**
 * @fileoverview Regression tests for the buffer-load flush path (COD-144).
 *
 * Bug: newly launched Shell sessions rendered BLANK until a tab-switch. The
 * buffer-load path (`selectSession` → `_beginBufferLoad`/`_finishBufferLoad`)
 * QUEUES live SSE terminal events while `_isLoadingBuffer` is true, then on
 * completion DISCARDS the queue (`_loadBufferQueue = null`). That de-dup is
 * correct for an established session (the fetched buffer already contains the
 * queued output, so replaying it would duplicate Ink redraws). But for a
 * brand-new shell the fetch resolves BEFORE the PTY emits its prompt — the
 * fetched buffer is empty and the prompt arrives only as a queued event, which
 * then gets discarded → blank terminal.
 *
 * Fix: `_finishBufferLoad(owner, { flushQueued })` REPLAYS the queued events
 * through `batchTerminalWrite()` (after `_isLoadingBuffer` is cleared, so they
 * write through normally) ONLY when the load painted nothing. The default path
 * (no opts) still discards, preserving de-dup for established sessions.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts). We extract the REAL
 * `_beginBufferLoad`/`_finishBufferLoad` mixin methods from terminal-ui.js by
 * running it against a fake `CodemanApp` and capturing `CodemanApp.prototype`,
 * then copy them onto a minimal stub whose `batchTerminalWrite` is a spy. This
 * exercises the real flush/discard logic without a full xterm fake.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Run terminal-ui.js in a vm against a fake CodemanApp and return the captured prototype mixin. */
function loadTerminalMixin(): Record<string, unknown> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    // terminal-ui.js IIFE is invoked with `window`; it reads/writes a few globals.
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
  });
  vm.runInContext(source, context);
  return FakeCodemanApp.prototype;
}

const mixin = loadTerminalMixin();

type BufferLoadApp = {
  _bufferLoadSeq: number;
  _bufferLoadOwner: string | null;
  _isLoadingBuffer: boolean;
  _loadBufferQueue: string[] | null;
  batchTerminalWrite: (data: string) => void;
  _beginBufferLoad: (owner?: string) => string;
  _finishBufferLoad: (owner?: string, opts?: { flushQueued?: boolean }) => boolean;
};

/**
 * Minimal stub carrying the buffer-load state plus the REAL begin/finish methods.
 * `batchTerminalWrite` is a spy so flushed events are observable without a real
 * xterm terminal. The real `batchTerminalWrite` would queue while loading, but
 * the flush runs AFTER `_isLoadingBuffer` is cleared, so a spy is faithful here.
 */
function makeApp() {
  const writes: string[] = [];
  const app: BufferLoadApp = {
    _bufferLoadSeq: 0,
    _bufferLoadOwner: null,
    _isLoadingBuffer: false,
    _loadBufferQueue: null,
    batchTerminalWrite: vi.fn((data: string) => {
      writes.push(data);
    }),
    _beginBufferLoad: mixin._beginBufferLoad as BufferLoadApp['_beginBufferLoad'],
    _finishBufferLoad: mixin._finishBufferLoad as BufferLoadApp['_finishBufferLoad'],
  };
  return { app, writes };
}

/** Simulate live SSE events arriving while a buffer load is in progress (the queue path). */
function pushWhileLoading(app: BufferLoadApp, data: string) {
  // Mirrors batchTerminalWrite's queue branch: if loading, push to the queue.
  if (app._isLoadingBuffer && app._loadBufferQueue) app._loadBufferQueue.push(data);
}

describe('buffer-load flush (COD-144)', () => {
  it('finish WITHOUT flushQueued discards the queue (de-dup preserved for established sessions)', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-1');
    pushWhileLoading(app, 'chunk-a');
    pushWhileLoading(app, 'chunk-b');

    const ok = app._finishBufferLoad(owner); // default: discard
    expect(ok).toBe(true);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._loadBufferQueue).toBeNull();
    // Queued events were NOT replayed.
    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('finish WITH { flushQueued: true } replays queued events in order, exactly once each', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-2');
    pushWhileLoading(app, 'prompt-1');
    pushWhileLoading(app, 'prompt-2');

    const ok = app._finishBufferLoad(owner, { flushQueued: true });
    expect(ok).toBe(true);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._loadBufferQueue).toBeNull();
    // Both chunks replayed, IN ORDER, exactly once each.
    expect(writes).toEqual(['prompt-1', 'prompt-2']);
    expect(app.batchTerminalWrite).toHaveBeenCalledTimes(2);
    expect(app.batchTerminalWrite).toHaveBeenNthCalledWith(1, 'prompt-1');
    expect(app.batchTerminalWrite).toHaveBeenNthCalledWith(2, 'prompt-2');
  });

  it('flushed events are not re-queued (the queue is null when batchTerminalWrite runs)', () => {
    const { app } = makeApp();
    const owner = app._beginBufferLoad('load-3');
    pushWhileLoading(app, 'only');

    // Spy that, like the real method, would re-queue if loading were still active.
    let reQueued = false;
    app.batchTerminalWrite = vi.fn((data: string) => {
      if (app._isLoadingBuffer && app._loadBufferQueue) {
        app._loadBufferQueue.push(data);
        reQueued = true;
      }
    });

    app._finishBufferLoad(owner, { flushQueued: true });
    expect(reQueued).toBe(false);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._loadBufferQueue).toBeNull();
  });

  it('owner mismatch returns false and does NOT flush or clear state', () => {
    const { app, writes } = makeApp();
    app._beginBufferLoad('real-owner');
    pushWhileLoading(app, 'queued');

    const ok = app._finishBufferLoad('wrong-owner', { flushQueued: true });
    expect(ok).toBe(false);
    // State untouched — still loading, queue intact, nothing replayed.
    expect(app._isLoadingBuffer).toBe(true);
    expect(app._bufferLoadOwner).toBe('real-owner');
    expect(app._loadBufferQueue).toEqual(['queued']);
    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('empty queue + flushQueued is a no-op (no throw, no writes)', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-empty');
    // No events queued.

    expect(() => app._finishBufferLoad(owner, { flushQueued: true })).not.toThrow();
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._loadBufferQueue).toBeNull();
    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
