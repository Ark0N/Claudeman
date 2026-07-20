/**
 * @fileoverview Unit tests for session pinning (COD-139) — the pure
 * merge/sort layer in unified-session-service.ts.
 *
 * Pinned sessions float to the top of the unified session list, ordered by
 * pinnedAt descending (most-recently-pinned first). Unpinned sessions keep the
 * existing lastActivityAt-desc ordering. Pin state flows through both the live
 * and persisted inputs so it survives a reload (live → persisted-only on boot).
 */

import { describe, it, expect } from 'vitest';
import { mergeUnifiedSessions } from '../src/services/unified-session-service.js';

describe('mergeUnifiedSessions — pinning (COD-139)', () => {
  it('floats a pinned session above unpinned ones regardless of activity', () => {
    const merged = mergeUnifiedSessions({
      live: [
        { id: 'a', name: 'A', lastActivityAt: 100 },
        { id: 'b', name: 'B', lastActivityAt: 5000, pinned: true, pinnedAt: 200 },
        { id: 'c', name: 'C', lastActivityAt: 9000 },
      ],
    });
    // b is pinned → first, even though c is the most-recently active.
    expect(merged.map((m) => m.sessionId)).toEqual(['b', 'c', 'a']);
    expect(merged[0].pinned).toBe(true);
  });

  it('orders multiple pinned sessions by pinnedAt descending (most recent first)', () => {
    const merged = mergeUnifiedSessions({
      live: [
        { id: 'p1', name: 'P1', lastActivityAt: 1, pinned: true, pinnedAt: 100 },
        { id: 'p2', name: 'P2', lastActivityAt: 2, pinned: true, pinnedAt: 300 },
        { id: 'p3', name: 'P3', lastActivityAt: 3, pinned: true, pinnedAt: 200 },
        { id: 'u', name: 'U', lastActivityAt: 9999 },
      ],
    });
    // Pinned group sorted by pinnedAt desc: p2(300) p3(200) p1(100); then unpinned.
    expect(merged.map((m) => m.sessionId)).toEqual(['p2', 'p3', 'p1', 'u']);
  });

  it('keeps the existing activity-desc order among unpinned sessions', () => {
    const merged = mergeUnifiedSessions({
      live: [
        { id: 'old', name: 'Old', lastActivityAt: 100 },
        { id: 'new', name: 'New', lastActivityAt: 900 },
        { id: 'mid', name: 'Mid', lastActivityAt: 500 },
      ],
    });
    expect(merged.map((m) => m.sessionId)).toEqual(['new', 'mid', 'old']);
  });

  it('surfaces pin state from a persisted-only session (survives reload)', () => {
    // On boot, a live session becomes persisted-only (status stopped). The pin
    // flag must come through the persisted input so it still floats to the top.
    const merged = mergeUnifiedSessions({
      persisted: [
        { id: 'fresh', name: 'Fresh', lastActivityAt: 5000 },
        { id: 'pinned', name: 'Pinned', lastActivityAt: 1, pinned: true, pinnedAt: 42 },
      ],
    });
    expect(merged[0].sessionId).toBe('pinned');
    expect(merged[0].pinned).toBe(true);
    expect(merged[0].pinnedAt).toBe(42);
  });

  it('live pin overrides a stale persisted unpinned value (live precedence)', () => {
    const merged = mergeUnifiedSessions({
      persisted: [{ id: 's', name: 'S', lastActivityAt: 10 }],
      live: [{ id: 's', name: 'S', lastActivityAt: 10, pinned: true, pinnedAt: 77 }],
    });
    const s = merged.find((m) => m.sessionId === 's');
    expect(s?.pinned).toBe(true);
    expect(s?.pinnedAt).toBe(77);
  });

  it('treats pinned:false the same as unpinned', () => {
    const merged = mergeUnifiedSessions({
      live: [
        { id: 'x', name: 'X', lastActivityAt: 100, pinned: false },
        { id: 'y', name: 'Y', lastActivityAt: 900, pinned: false },
      ],
    });
    expect(merged.map((m) => m.sessionId)).toEqual(['y', 'x']);
  });
});
