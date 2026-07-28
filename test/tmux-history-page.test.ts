import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveHistoryPageRange } from '../src/tmux-manager.js';

describe('tmux history page ranges', () => {
  it('returns the newest bounded page by default', () => {
    expect(resolveHistoryPageRange(10_000, { limit: 1_000 })).toEqual({
      start: 9_000,
      end: 10_000,
      total: 10_000,
      hasMoreBefore: true,
      hasMoreAfter: false,
    });
  });

  it('walks backward and forward using absolute history rows', () => {
    expect(resolveHistoryPageRange(10_000, { before: 9_000, limit: 1_000 })).toEqual({
      start: 8_000,
      end: 9_000,
      total: 10_000,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    expect(resolveHistoryPageRange(10_000, { after: 2_000, limit: 1_000 })).toEqual({
      start: 2_000,
      end: 3_000,
      total: 10_000,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
  });

  it('clamps empty and out-of-range requests without producing invalid tmux coordinates', () => {
    expect(resolveHistoryPageRange(0, { limit: 1_000 })).toEqual({
      start: 0,
      end: 0,
      total: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    expect(resolveHistoryPageRange(100, { before: 500, limit: 1_000 })).toEqual({
      start: 0,
      end: 100,
      total: 100,
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });
});

describe('tmux history page capture', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');

  it('captures explicit physical-row ranges without joining wrapped rows', () => {
    const start = source.indexOf('capturePaneHistoryPage(');
    const body = source.slice(start, start + 5_000);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('capture-pane -p -e -S ${startLine} -E ${endLine}');
    expect(body).not.toContain('capture-pane -p -e -J');
  });

  it('resolves the active pane before capturing a page', () => {
    const start = source.indexOf('captureActivePaneHistoryPage(');
    const body = source.slice(start, start + 1_200);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('resolveActivePaneTarget');
    expect(body).toContain('this.capturePaneHistoryPage');
  });
});
