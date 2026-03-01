/**
 * @fileoverview Tests for CleanupManager utility
 *
 * Verifies centralized resource cleanup: timers, intervals, watchers,
 * listeners, streams, and custom cleanup functions.
 *
 * Port: N/A (unit tests, no server)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CleanupManager } from '../src/utils/cleanup-manager.js';

describe('CleanupManager', () => {
  let cm: CleanupManager;

  beforeEach(() => {
    vi.useFakeTimers();
    cm = new CleanupManager();
  });

  afterEach(() => {
    cm.dispose();
    vi.useRealTimers();
  });

  describe('setTimeout', () => {
    it('fires callback after delay', () => {
      const cb = vi.fn();
      cm.setTimeout(cb, 1000);

      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledOnce();
    });

    it('auto-removes registration after firing', () => {
      const cb = vi.fn();
      cm.setTimeout(cb, 500);

      expect(cm.resourceCount).toBe(1);
      vi.advanceTimersByTime(500);
      expect(cm.resourceCount).toBe(0);
    });

    it('does NOT fire callback after dispose', () => {
      const cb = vi.fn();
      cm.setTimeout(cb, 1000);

      cm.dispose();
      vi.advanceTimersByTime(1000);
      expect(cb).not.toHaveBeenCalled();
    });

    it('returns a string ID', () => {
      const id = cm.setTimeout(() => {}, 100);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('setInterval', () => {
    it('fires repeatedly', () => {
      const cb = vi.fn();
      cm.setInterval(cb, 200);

      vi.advanceTimersByTime(200);
      expect(cb).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(cb).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(200);
      expect(cb).toHaveBeenCalledTimes(3);
    });

    it('stops firing after dispose', () => {
      const cb = vi.fn();
      cm.setInterval(cb, 100);

      vi.advanceTimersByTime(100);
      expect(cb).toHaveBeenCalledTimes(1);

      cm.dispose();
      vi.advanceTimersByTime(500);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('unregister', () => {
    it('cancels a specific timer by ID', () => {
      const cb = vi.fn();
      const id = cm.setTimeout(cb, 1000);

      expect(cm.unregister(id)).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(cb).not.toHaveBeenCalled();
    });

    it('removes the registration from tracking', () => {
      const id = cm.setTimeout(() => {}, 1000);
      expect(cm.resourceCount).toBe(1);

      cm.unregister(id);
      expect(cm.resourceCount).toBe(0);
    });

    it('returns false for unknown ID', () => {
      expect(cm.unregister('nonexistent')).toBe(false);
    });

    it('cancels a specific interval by ID', () => {
      const cb = vi.fn();
      const id = cm.setInterval(cb, 100);

      vi.advanceTimersByTime(100);
      expect(cb).toHaveBeenCalledTimes(1);

      cm.unregister(id);
      vi.advanceTimersByTime(500);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('dispose', () => {
    it('is idempotent — safe to call twice', () => {
      const cb = vi.fn();
      cm.registerCleanup('timer', cb, 'test cleanup');

      cm.dispose();
      cm.dispose();

      expect(cb).toHaveBeenCalledOnce();
    });

    it('clears all registrations', () => {
      cm.setTimeout(() => {}, 1000);
      cm.setInterval(() => {}, 1000);
      cm.registerCleanup('watcher', () => {}, 'test');

      expect(cm.resourceCount).toBe(3);
      cm.dispose();
      expect(cm.resourceCount).toBe(0);
    });
  });

  describe('isStopped / isDisposed', () => {
    it('returns false before dispose', () => {
      expect(cm.isStopped).toBe(false);
      expect(cm.isDisposed).toBe(false);
    });

    it('returns true after dispose', () => {
      cm.dispose();
      expect(cm.isStopped).toBe(true);
      expect(cm.isDisposed).toBe(true);
    });
  });

  describe('resourceCount', () => {
    it('tracks active registrations', () => {
      expect(cm.resourceCount).toBe(0);

      cm.setTimeout(() => {}, 1000);
      expect(cm.resourceCount).toBe(1);

      cm.setInterval(() => {}, 1000);
      expect(cm.resourceCount).toBe(2);

      cm.registerCleanup('watcher', () => {}, 'w');
      expect(cm.resourceCount).toBe(3);
    });

    it('decrements when timer fires naturally', () => {
      cm.setTimeout(() => {}, 500);
      cm.setTimeout(() => {}, 1000);
      expect(cm.resourceCount).toBe(2);

      vi.advanceTimersByTime(500);
      expect(cm.resourceCount).toBe(1);

      vi.advanceTimersByTime(500);
      expect(cm.resourceCount).toBe(0);
    });
  });

  describe('resourceCounts', () => {
    it('returns breakdown by type', () => {
      cm.setTimeout(() => {}, 1000);
      cm.setTimeout(() => {}, 2000);
      cm.setInterval(() => {}, 1000);
      cm.registerCleanup('watcher', () => {}, 'w1');
      cm.registerCleanup('listener', () => {}, 'l1');
      cm.registerCleanup('stream', () => {}, 's1');
      cm.registerCleanup('stream', () => {}, 's2');

      const counts = cm.resourceCounts;
      expect(counts.timer).toBe(2);
      expect(counts.interval).toBe(1);
      expect(counts.watcher).toBe(1);
      expect(counts.listener).toBe(1);
      expect(counts.stream).toBe(2);
    });

    it('returns all zeros when empty', () => {
      const counts = cm.resourceCounts;
      expect(counts.timer).toBe(0);
      expect(counts.interval).toBe(0);
      expect(counts.watcher).toBe(0);
      expect(counts.listener).toBe(0);
      expect(counts.stream).toBe(0);
    });
  });

  describe('registerCleanup', () => {
    it('calls cleanup function on dispose', () => {
      const cleanup = vi.fn();
      cm.registerCleanup('timer', cleanup, 'custom cleanup');

      expect(cleanup).not.toHaveBeenCalled();
      cm.dispose();
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it('returns a registration ID', () => {
      const id = cm.registerCleanup('watcher', () => {}, 'test');
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('registerWatcher', () => {
    it('calls close() on dispose', () => {
      const watcher = { close: vi.fn() };
      cm.registerWatcher(watcher, 'test watcher');

      cm.dispose();
      expect(watcher.close).toHaveBeenCalledOnce();
    });
  });

  describe('registerListener', () => {
    it('calls removeListener on dispose', () => {
      const emitter = { removeListener: vi.fn() };
      const listener = vi.fn();
      cm.registerListener(emitter, 'data', listener, 'test listener');

      cm.dispose();
      expect(emitter.removeListener).toHaveBeenCalledWith('data', listener);
    });

    it('falls back to off() if no removeListener', () => {
      const emitter = { off: vi.fn() };
      const listener = vi.fn();
      cm.registerListener(emitter, 'close', listener, 'test listener');

      cm.dispose();
      expect(emitter.off).toHaveBeenCalledWith('close', listener);
    });
  });

  describe('registerStream', () => {
    it('calls destroy() on dispose', () => {
      const stream = { destroy: vi.fn(), close: vi.fn() };
      cm.registerStream(stream, 'test stream');

      cm.dispose();
      expect(stream.destroy).toHaveBeenCalledOnce();
      expect(stream.close).not.toHaveBeenCalled();
    });

    it('falls back to close() if no destroy', () => {
      const stream = { close: vi.fn() };
      cm.registerStream(stream, 'test stream');

      cm.dispose();
      expect(stream.close).toHaveBeenCalledOnce();
    });
  });

  describe('error resilience', () => {
    it('error in one cleanup does not prevent others', () => {
      const cleanup1 = vi.fn();
      const cleanup2 = vi.fn(() => {
        throw new Error('boom');
      });
      const cleanup3 = vi.fn();

      cm.registerCleanup('timer', cleanup1, 'first');
      cm.registerCleanup('timer', cleanup2, 'exploding');
      cm.registerCleanup('timer', cleanup3, 'third');

      // Suppress console.error from dispose
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      cm.dispose();

      expect(cleanup1).toHaveBeenCalledOnce();
      expect(cleanup2).toHaveBeenCalledOnce();
      expect(cleanup3).toHaveBeenCalledOnce();

      errorSpy.mockRestore();
    });

    it('logs errors during disposal', () => {
      cm.registerCleanup('timer', () => {
        throw new Error('fail');
      }, 'bad cleanup');

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      cm.dispose();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('1 errors during disposal'),
        expect.stringContaining('bad cleanup')
      );

      errorSpy.mockRestore();
    });
  });

  describe('getRegistrations', () => {
    it('returns current registrations for debugging', () => {
      cm.setTimeout(() => {}, 1000, { description: 'my timer' });
      cm.registerCleanup('watcher', () => {}, 'my watcher');

      const regs = cm.getRegistrations();
      expect(regs).toHaveLength(2);
      expect(regs.map((r) => r.description)).toContain('my timer');
      expect(regs.map((r) => r.description)).toContain('my watcher');
    });
  });
});
