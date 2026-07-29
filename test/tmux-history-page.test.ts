import { describe, expect, it, vi } from 'vitest';
import { captureHistoryPageWithRunner, resolveHistoryPageRange } from '../src/tmux-manager.js';

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
  it('captures explicit physical-row ranges without joining wrapped rows', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce('10000\n')
      .mockResolvedValueOnce('row-a\nrow-b\n')
      .mockResolvedValueOnce('oldest-a\noldest-b\n');

    const page = await captureHistoryPageWithRunner('%7', { before: 9000, limit: 1000 }, run);

    expect(page).toMatchObject({
      buffer: 'row-a\r\nrow-b',
      start: 8000,
      end: 9000,
      total: 10000,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    expect(run.mock.calls[1][0]).toEqual(['capture-pane', '-p', '-e', '-S', '-2000', '-E', '-1001', '-t', '%7']);
    expect(run.mock.calls[1][0]).not.toContain('-J');
  });

  it('rejects invalid history-size output without issuing a capture', async () => {
    const run = vi.fn().mockResolvedValue('not-a-number');

    await expect(captureHistoryPageWithRunner('%7', { limit: 1000 }, run)).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
