/**
 * @fileoverview Unit tests for the pure unified-session merge/filter service (COD-121).
 *
 * Covers dedup across sources, source precedence, mux-stat merge + meaningfulness
 * floor, sort ordering, and filterAndPaginate (search + paging + clamps).
 * Node env only — no jsdom, no IO.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeUnifiedSessions,
  filterAndPaginate,
  type UnifiedSessionItem,
} from '../../src/services/unified-session-service.js';

describe('mergeUnifiedSessions', () => {
  it('dedupes the same sessionId across live + persisted into one item', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 's1', status: 'working', isWorking: true }],
      persisted: [{ id: 's1', status: 'idle' }],
      history: [{ sessionId: 's1', workingDir: '/w', sizeBytes: 5000, lastModified: '2026-01-01T00:00:00.000Z' }],
    });
    expect(merged).toHaveLength(1);
    const item = merged[0];
    expect(item.sessionId).toBe('s1');
    // sources accumulate from every contributing source (order-insensitive)
    expect([...item.sources].sort()).toEqual(['history', 'live', 'persisted']);
    // live wins for status
    expect(item.status).toBe('working');
    expect(item.isWorking).toBe(true);
  });

  it('lets live status win over persisted (precedence)', () => {
    const merged = mergeUnifiedSessions({
      persisted: [{ id: 's1', status: 'idle', name: 'Persisted Name' }],
      live: [{ id: 's1', status: 'working' }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('working');
    // persisted name survives because live did not provide one
    expect(merged[0].name).toBe('Persisted Name');
  });

  it('merges mux stats onto a live item but drops a mux-only entry with no name', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 's1', status: 'working' }],
      mux: [
        { sessionId: 's1', stats: { memoryMB: 42, cpuPercent: 3.5 }, remote: true },
        { sessionId: 'noise', stats: { memoryMB: 10, cpuPercent: 1 } },
      ],
    });
    expect(merged).toHaveLength(1);
    const item = merged[0];
    expect(item.sessionId).toBe('s1');
    expect(item.stats).toEqual({ memoryMB: 42, cpuPercent: 3.5 });
    expect(item.remote).toBe(true);
  });

  it('drops a lifecycle-only entry with no name/firstPrompt but keeps a history item with firstPrompt', () => {
    const merged = mergeUnifiedSessions({
      lifecycle: [{ sessionId: 'bare', event: 'created', ts: 1000 }],
      history: [
        {
          sessionId: 'hist',
          workingDir: '/w',
          sizeBytes: 9000,
          lastModified: '2026-01-02T00:00:00.000Z',
          firstPrompt: 'do the thing',
        },
      ],
    });
    const ids = merged.map((m) => m.sessionId);
    expect(ids).toContain('hist');
    expect(ids).not.toContain('bare');
  });

  it('sorts by lastActivityAt desc with undefined last', () => {
    const merged = mergeUnifiedSessions({
      live: [
        { id: 'a', status: 'idle', lastActivityAt: 100 },
        { id: 'b', status: 'idle', lastActivityAt: 300 },
        { id: 'c', status: 'idle' }, // no lastActivityAt → sorts last
        { id: 'd', status: 'idle', lastActivityAt: 200 },
      ],
    });
    expect(merged.map((m) => m.sessionId)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('derives lastActivityAt from history lastModified when none better exists', () => {
    const merged = mergeUnifiedSessions({
      history: [{ sessionId: 'h', workingDir: '/w', sizeBytes: 5000, lastModified: '2026-01-01T00:00:00.000Z' }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].lastActivityAt).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
  });
});

describe('filterAndPaginate', () => {
  const items: UnifiedSessionItem[] = [
    { sessionId: 's1', name: 'Alpha build', sources: ['live'], workingDir: '/repo/alpha' },
    { sessionId: 's2', name: 'Beta', firstPrompt: 'fix the login bug', sources: ['history'], workingDir: '/repo/beta' },
    { sessionId: 's3', name: 'Gamma', sources: ['persisted'], workingDir: '/srv/gamma' },
  ];

  it('filters by name (case-insensitive)', () => {
    const r = filterAndPaginate(items, { q: 'alpha' });
    expect(r.total).toBe(1);
    expect(r.sessions[0].sessionId).toBe('s1');
  });

  it('filters by firstPrompt and workingDir', () => {
    expect(filterAndPaginate(items, { q: 'login bug' }).sessions[0].sessionId).toBe('s2');
    expect(filterAndPaginate(items, { q: '/srv/' }).sessions[0].sessionId).toBe('s3');
  });

  it('reports total as the pre-page filtered count', () => {
    const r = filterAndPaginate(items, { q: 'repo', limit: 1 });
    // both s1 and s2 have /repo/ workingDir
    expect(r.total).toBe(2);
    expect(r.sessions).toHaveLength(1);
  });

  it('clamps limit to a max of 500', () => {
    const r = filterAndPaginate(items, { limit: 99999 });
    expect(r.sessions).toHaveLength(items.length);
    // clamp does not throw and returns all 3 (< 500)
    expect(r.total).toBe(3);
  });

  it('clamps limit to a min of 1', () => {
    const r = filterAndPaginate(items, { limit: 0 });
    expect(r.sessions).toHaveLength(1);
  });

  it('paginates with disjoint pages via offset', () => {
    const page1 = filterAndPaginate(items, { offset: 0, limit: 2 });
    const page2 = filterAndPaginate(items, { offset: 2, limit: 2 });
    expect(page1.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(page2.sessions.map((s) => s.sessionId)).toEqual(['s3']);
    const overlap = page1.sessions
      .map((s) => s.sessionId)
      .filter((id) => page2.sessions.map((s2) => s2.sessionId).includes(id));
    expect(overlap).toEqual([]);
  });
});
