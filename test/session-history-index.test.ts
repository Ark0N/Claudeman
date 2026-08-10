/**
 * Unit tests for the past-session search index (issue #261).
 *
 * The index is the seam that lets `GET /api/search` match sessions that are no
 * longer running WITHOUT doing disk I/O per keystroke. Three properties matter
 * and are pinned here: the snapshot stays bounded, the refresh never happens on
 * the caller's timeline (fire-and-forget, single-flight, TTL-guarded), and the
 * stored rows carry the owner needed to re-apply multi-user scoping on read,
 * the snapshot is written unscoped, so losing that field would leak one user's
 * folders into another user's search.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildHistorySessionIndexItems,
  ensureHistorySessionIndexFresh,
  getHistorySessionIndex,
  isHistorySessionIndexStale,
  resetHistorySessionIndex,
  setHistoryIndexRefresher,
  setHistorySessionIndex,
  HISTORY_INDEX_MAX_ITEMS,
  HISTORY_INDEX_TTL_MS,
  type MergedSessionLike,
} from '../src/web/session-history-index.js';

beforeEach(() => {
  resetHistorySessionIndex();
});

describe('buildHistorySessionIndexItems', () => {
  const merged: MergedSessionLike[] = [
    { sessionId: 'a', name: 'w1-alpha', workingDir: '/home/u/alpha', lastActivityAt: 300 },
    { sessionId: 'b', name: '', workingDir: '/home/u/beta', claudeSessionId: 'uuid-b', createdAt: 200 },
    { sessionId: 'c', name: 'gamma', workingDir: '', lastActivityAt: 100 },
  ];

  it('projects name, dir, timestamp, owner and liveness', () => {
    const items = buildHistorySessionIndexItems(
      merged,
      new Map([
        ['a', 'alice'],
        ['b', undefined],
      ]),
      new Set(['a'])
    );
    expect(items.map((i) => i.sessionId)).toEqual(['a', 'b', 'c']);
    expect(items[0]).toMatchObject({ owner: 'alice', live: true, timestamp: 300 });
    // Transcript-only row: no owner (host-wide) and not live.
    expect(items[1]).toMatchObject({ owner: undefined, live: false, timestamp: 200, claudeSessionId: 'uuid-b' });
  });

  it('drops rows with neither a name nor a working directory', () => {
    const items = buildHistorySessionIndexItems([{ sessionId: 'empty' }, ...merged], new Map(), new Set());
    expect(items.some((i) => i.sessionId === 'empty')).toBe(false);
  });

  it('caps the projection at HISTORY_INDEX_MAX_ITEMS', () => {
    const many: MergedSessionLike[] = Array.from({ length: HISTORY_INDEX_MAX_ITEMS + 50 }, (_, i) => ({
      sessionId: `s${i}`,
      name: `session ${i}`,
      workingDir: `/home/u/p${i}`,
      lastActivityAt: i,
    }));
    expect(buildHistorySessionIndexItems(many, new Map(), new Set())).toHaveLength(HISTORY_INDEX_MAX_ITEMS);
  });
});

describe('snapshot storage', () => {
  it('starts empty and stale', () => {
    expect(getHistorySessionIndex().items).toEqual([]);
    expect(isHistorySessionIndexStale()).toBe(true);
  });

  it('caps on write even when the caller did not', () => {
    const items = Array.from({ length: HISTORY_INDEX_MAX_ITEMS + 10 }, (_, i) => ({
      sessionId: `s${i}`,
      name: 'x',
      workingDir: '/x',
      timestamp: i,
      live: false,
    }));
    setHistorySessionIndex(items);
    expect(getHistorySessionIndex().items).toHaveLength(HISTORY_INDEX_MAX_ITEMS);
  });

  it('goes stale again once the TTL elapses', () => {
    const t0 = 1_000_000;
    setHistorySessionIndex([{ sessionId: 's', name: 'n', workingDir: '/d', timestamp: 1, live: false }], t0);
    expect(isHistorySessionIndexStale(t0 + HISTORY_INDEX_TTL_MS - 1)).toBe(false);
    expect(isHistorySessionIndexStale(t0 + HISTORY_INDEX_TTL_MS + 1)).toBe(true);
  });
});

describe('ensureHistorySessionIndexFresh', () => {
  it('returns synchronously, the rebuild must never be on the request path', async () => {
    let resolveRefresh: () => void = () => {};
    const refresher = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    setHistoryIndexRefresher(refresher);

    ensureHistorySessionIndexFresh();
    // Called, but the caller is already past it while the rebuild is pending.
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(getHistorySessionIndex().items).toEqual([]);
    resolveRefresh();
    await Promise.resolve();
  });

  it('is single-flight: a second call while a rebuild is pending is a no-op', async () => {
    let resolveRefresh: () => void = () => {};
    const refresher = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    setHistoryIndexRefresher(refresher);

    ensureHistorySessionIndexFresh();
    ensureHistorySessionIndexFresh();
    ensureHistorySessionIndexFresh();
    expect(refresher).toHaveBeenCalledTimes(1);

    resolveRefresh();
    await new Promise((r) => setTimeout(r, 0));
    // Snapshot still stale (the fake refresher wrote nothing) → next call runs again.
    ensureHistorySessionIndexFresh();
    expect(refresher).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild while the snapshot is fresh', () => {
    const refresher = vi.fn(async () => {});
    setHistoryIndexRefresher(refresher);
    setHistorySessionIndex([{ sessionId: 's', name: 'n', workingDir: '/d', timestamp: 1, live: false }]);
    ensureHistorySessionIndexFresh();
    expect(refresher).not.toHaveBeenCalled();
  });

  it('keeps the previous snapshot when a rebuild throws, and retries next time', async () => {
    setHistorySessionIndex([{ sessionId: 'keep', name: 'n', workingDir: '/d', timestamp: 1, live: false }], 1);
    const refresher = vi.fn(async () => {
      throw new Error('scan failed');
    });
    setHistoryIndexRefresher(refresher);

    ensureHistorySessionIndexFresh();
    await new Promise((r) => setTimeout(r, 0));
    expect(getHistorySessionIndex().items[0].sessionId).toBe('keep');

    ensureHistorySessionIndexFresh();
    expect(refresher).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no refresher is registered', () => {
    expect(() => ensureHistorySessionIndexFresh()).not.toThrow();
  });
});
