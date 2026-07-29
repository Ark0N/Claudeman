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
import { TextDecoder, TextEncoder } from 'node:util';
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
    TextDecoder,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
    CodemanApp: FakeCodemanApp,
    // terminal-ui.js IIFE is invoked with `window`; it reads/writes a few globals.
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
  });
  vm.runInContext(source, context);
  return FakeCodemanApp.prototype;
}

const mixin = loadTerminalMixin();

type TerminalCursor = {
  stream: string;
  generation: number;
  start: number;
  end: number;
};

type BufferLoadApp = {
  _bufferLoadSeq: number;
  _bufferLoadOwner: string | null;
  _isLoadingBuffer: boolean;
  _loadBufferQueue: Array<string | { data: string; cursor: TerminalCursor }> | null;
  batchTerminalWrite: (data: string, cursor?: TerminalCursor) => void;
  _beginBufferLoad: (owner?: string) => string;
  _finishBufferLoad: (owner?: string, opts?: { flushQueued?: boolean; snapshotCursor?: TerminalCursor }) => boolean;
  _isTerminalCursor: (cursor: unknown) => boolean;
  _terminalEventAfterSnapshot: (
    item: { data: string; cursor: TerminalCursor },
    snapshotCursor: TerminalCursor
  ) => { data: string; cursor: TerminalCursor } | null;
  _terminalSnapshotCursorFromHeaders: (headers: Headers) => TerminalCursor | null;
  _readTerminalSnapshotResponse: (
    response: Response,
    options?: {
      isCancelled?: () => boolean;
    }
  ) => Promise<{
    terminalBuffer: string;
    cursor?: TerminalCursor;
    streamed: boolean;
    aborted: boolean;
  }>;
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
    _isTerminalCursor: mixin._isTerminalCursor as BufferLoadApp['_isTerminalCursor'],
    _terminalEventAfterSnapshot: mixin._terminalEventAfterSnapshot as BufferLoadApp['_terminalEventAfterSnapshot'],
    _terminalSnapshotCursorFromHeaders:
      mixin._terminalSnapshotCursorFromHeaders as BufferLoadApp['_terminalSnapshotCursorFromHeaders'],
    _readTerminalSnapshotResponse:
      mixin._readTerminalSnapshotResponse as BufferLoadApp['_readTerminalSnapshotResponse'],
  };
  return { app, writes };
}

/** Simulate live SSE events arriving while a buffer load is in progress (the queue path). */
function pushWhileLoading(app: BufferLoadApp, data: string, cursor?: TerminalCursor) {
  // Mirrors batchTerminalWrite's queue branch: if loading, push to the queue.
  if (app._isLoadingBuffer && app._loadBufferQueue) {
    app._loadBufferQueue.push(cursor ? { data, cursor } : data);
  }
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

  it('discards cursor-covered events and replays only the synchronized suffix beyond the snapshot', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('cursor-overlap');
    pushWhileLoading(app, 'covered', { stream: 'stream-a', generation: 1, start: 0, end: 7 });
    pushWhileLoading(app, 'abcdefgh', { stream: 'stream-a', generation: 1, start: 7, end: 15 });
    pushWhileLoading(app, 'after', { stream: 'stream-a', generation: 1, start: 15, end: 20 });

    expect(
      app._finishBufferLoad(owner, {
        snapshotCursor: { stream: 'stream-a', generation: 1, start: 0, end: 10 },
      })
    ).toBe(true);

    expect(writes).toEqual(['\x1b[?2026hdefgh\x1b[?2026l', 'after']);
    expect(app.batchTerminalWrite).toHaveBeenNthCalledWith(1, '\x1b[?2026hdefgh\x1b[?2026l', {
      stream: 'stream-a',
      generation: 1,
      start: 10,
      end: 15,
    });
    expect(app.batchTerminalWrite).toHaveBeenNthCalledWith(2, 'after', {
      stream: 'stream-a',
      generation: 1,
      start: 15,
      end: 20,
    });
  });

  it.each([
    ['opening fragment', '\x1b[?2026habcdefgh'],
    ['middle fragment', 'abcdefgh'],
    ['closing fragment', 'abcdefgh\x1b[?2026l'],
  ])('rewraps an overlap inside a fragmented WS synchronized update (%s)', (_label, data) => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('cursor-fragment-overlap');
    pushWhileLoading(app, data, {
      stream: 'stream-a',
      generation: 1,
      start: 7,
      end: 15,
    });

    app._finishBufferLoad(owner, {
      snapshotCursor: { stream: 'stream-a', generation: 1, start: 0, end: 10 },
    });

    expect(writes).toEqual(['\x1b[?2026hdefgh\x1b[?2026l']);
    expect(app.batchTerminalWrite).toHaveBeenCalledWith('\x1b[?2026hdefgh\x1b[?2026l', {
      stream: 'stream-a',
      generation: 1,
      start: 10,
      end: 15,
    });
  });

  it('drops stale stream and generation events while preserving a newer generation', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('cursor-generation');
    pushWhileLoading(app, 'old stream', { stream: 'old-stream', generation: 9, start: 0, end: 10 });
    pushWhileLoading(app, 'old generation', { stream: 'stream-a', generation: 1, start: 0, end: 14 });
    pushWhileLoading(app, 'new generation', { stream: 'stream-a', generation: 3, start: 0, end: 14 });

    app._finishBufferLoad(owner, {
      snapshotCursor: { stream: 'stream-a', generation: 2, start: 0, end: 5 },
    });

    expect(writes).toEqual(['new generation']);
  });

  it('decodes a streamed snapshot losslessly when an emoji spans wire chunks', async () => {
    const { app } = makeApp();
    const text = 'alpha \u05e9\u05dc\u05d5\u05dd \ud83d\ude80 omega';
    const bytes = new TextEncoder().encode(text);
    const emojiByte = new TextEncoder().encode(text.slice(0, text.indexOf('\ud83d\ude80'))).length;
    const wireChunks = [
      bytes.slice(0, emojiByte + 2),
      bytes.slice(emojiByte + 2, emojiByte + 3),
      bytes.slice(emojiByte + 3),
    ];
    let index = 0;
    const headers = new Headers({
      'x-codeman-terminal-format': 'stream-v1',
      'x-codeman-terminal-stream': 'stream-a',
      'x-codeman-terminal-generation': '4',
      'x-codeman-terminal-start': '0',
      'x-codeman-terminal-end': String(text.length),
      'x-codeman-terminal-source': 'mux-visible',
      'x-codeman-terminal-truncated': '0',
    });
    const response = {
      ok: true,
      headers,
      body: {
        getReader: () => ({
          read: async () =>
            index < wireChunks.length ? { done: false, value: wireChunks[index++] } : { done: true, value: undefined },
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
    const result = await app._readTerminalSnapshotResponse(response);

    expect(result.terminalBuffer).toBe(text);
    expect(result).toMatchObject({
      streamed: true,
      aborted: false,
      source: 'mux-visible',
      cursor: { stream: 'stream-a', generation: 4, start: 0, end: text.length },
    });
  });

  it('keeps the JSON terminal response as a non-streaming fallback', async () => {
    const { app } = makeApp();
    const response = {
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: { terminalBuffer: 'legacy snapshot', truncated: false } }),
    } as unknown as Response;

    await expect(app._readTerminalSnapshotResponse(response)).resolves.toMatchObject({
      terminalBuffer: 'legacy snapshot',
      truncated: false,
      streamed: false,
    });
  });

  it('repositions a pending local draft after the loaded frame becomes authoritative', () => {
    const { app } = makeApp();
    const rerender = vi.fn();
    let writeDone: (() => void) | undefined;
    Object.assign(app, {
      _localEchoOverlay: { hasPending: true, rerender },
      terminal: {
        write: vi.fn((_data: string, callback?: () => void) => {
          writeDone = callback;
        }),
      },
    });
    const owner = app._beginBufferLoad('load-with-draft');

    expect(app._finishBufferLoad(owner)).toBe(true);
    expect(writeDone).toBeTypeOf('function');
    expect(rerender).not.toHaveBeenCalled();

    writeDone?.();

    expect(rerender).toHaveBeenCalledOnce();
  });
});
