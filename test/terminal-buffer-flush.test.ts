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
  _terminalHistoryPageFromHeaders: (headers: Headers) => {
    start: number;
    end: number;
    total: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    origin: string;
  } | null;
  _readTerminalSnapshotResponse: (
    response: Response,
    options?: {
      paint?: boolean;
      loadOwner?: string;
      chunkSize?: number;
      beforePaint?: () => void;
      isCancelled?: () => boolean;
      followBottom?: boolean;
    }
  ) => Promise<{
    terminalBuffer: string;
    cursor?: TerminalCursor;
    streamed: boolean;
    painted: boolean;
    aborted: boolean;
  }>;
};

type TerminalCursor = {
  stream: string;
  generation: number;
  start: number;
  end: number;
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
    _terminalHistoryPageFromHeaders:
      mixin._terminalHistoryPageFromHeaders as BufferLoadApp['_terminalHistoryPageFromHeaders'],
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

  it('discards cursor-covered events and replays only a batch suffix beyond the snapshot', () => {
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

    expect(writes).toEqual(['defgh', 'after']);
    expect(app.batchTerminalWrite).toHaveBeenNthCalledWith(1, 'defgh', {
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

  it('drops stale stream/generation events and preserves output from a newer generation', () => {
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

  it('slices overlap inside the SSE synchronized-output wrapper', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('cursor-sync-overlap');
    pushWhileLoading(app, '\x1b[?2026habcdefgh\x1b[?2026l', {
      stream: 'stream-a',
      generation: 1,
      start: 7,
      end: 15,
    });

    app._finishBufferLoad(owner, {
      snapshotCursor: { stream: 'stream-a', generation: 1, start: 0, end: 10 },
    });

    expect(writes).toEqual(['\x1b[?2026hdefgh\x1b[?2026l']);
  });

  it('decodes a streamed snapshot losslessly across UTF-8 chunk boundaries while painting', async () => {
    const { app } = makeApp();
    const text = 'alpha \u05e9\u05dc\u05d5\u05dd \ud83d\ude80 omega';
    const bytes = new TextEncoder().encode(text);
    const wireChunks = [bytes.slice(0, 8), bytes.slice(8, 13), bytes.slice(13)];
    let index = 0;
    const headers = new Headers({
      'x-codeman-terminal-format': 'stream-v1',
      'x-codeman-terminal-stream': 'stream-a',
      'x-codeman-terminal-generation': '4',
      'x-codeman-terminal-start': '0',
      'x-codeman-terminal-end': String(text.length),
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
    const painted: string[] = [];
    const beforePaint = vi.fn();
    Object.assign(app, {
      chunkedTerminalWrite: vi.fn(async (chunk: string) => {
        painted.push(chunk);
      }),
    });

    const result = await app._readTerminalSnapshotResponse(response, {
      paint: true,
      loadOwner: 'stream-load',
      beforePaint,
      followBottom: true,
    });

    expect(result.terminalBuffer).toBe(text);
    expect(painted.join('')).toBe(text);
    expect(beforePaint).toHaveBeenCalledOnce();
    expect(app.chunkedTerminalWrite).toHaveBeenCalledWith(expect.any(String), 32 * 1024, 'stream-load', {
      followBottom: true,
    });
    expect(result).toMatchObject({
      streamed: true,
      painted: true,
      aborted: false,
      cursor: { stream: 'stream-a', generation: 4, start: 0, end: text.length },
    });
  });

  it('exposes bounded history-page coordinates from streamed response headers', async () => {
    const { app } = makeApp();
    const response = new Response('bounded history page', {
      status: 200,
      headers: {
        'x-codeman-terminal-format': 'stream-v1',
        'x-codeman-terminal-stream': 'stream-a',
        'x-codeman-terminal-generation': '2',
        'x-codeman-terminal-start': '100',
        'x-codeman-terminal-end': '120',
        'x-codeman-history-start': '3000',
        'x-codeman-history-end': '4000',
        'x-codeman-history-total': '9000',
        'x-codeman-history-more-before': '1',
        'x-codeman-history-more-after': '1',
        'x-codeman-history-origin': 'pane-1:origin',
      },
    });

    await expect(app._readTerminalSnapshotResponse(response)).resolves.toMatchObject({
      terminalBuffer: 'bounded history page',
      historyPage: {
        start: 3000,
        end: 4000,
        total: 9000,
        hasMoreBefore: true,
        hasMoreAfter: true,
        origin: 'pane-1:origin',
      },
    });
  });

  it('keeps the JSON terminal response as a non-streaming fallback', async () => {
    const { app } = makeApp();
    const response = {
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: { terminalBuffer: 'legacy snapshot', truncated: false } }),
    } as unknown as Response;

    await expect(app._readTerminalSnapshotResponse(response, { paint: true })).resolves.toMatchObject({
      terminalBuffer: 'legacy snapshot',
      truncated: false,
      streamed: false,
      painted: false,
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
