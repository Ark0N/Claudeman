/**
 * Tests for CleanupManager utility.
 *
 * Port: N/A (unit tests, no server)
 */

import { CleanupManager } from '../../src/utils/cleanup-manager.js';

describe('CleanupManager', () => {
  describe('basic state', () => {
    it('should start not disposed', () => {
      const cleanup = new CleanupManager();
      expect(cleanup.isDisposed).toBe(false);
      expect(cleanup.isStopped).toBe(false);
      expect(cleanup.resourceCount).toBe(0);
    });

    it('should track resource counts by type', () => {
      const cleanup = new CleanupManager();

      cleanup.setTimeout(() => {}, 10000);
      cleanup.setInterval(() => {}, 10000);
      cleanup.registerCleanup('watcher', () => {}, 'test watcher');

      const counts = cleanup.resourceCounts;
      expect(counts.timer).toBe(1);
      expect(counts.interval).toBe(1);
      expect(counts.watcher).toBe(1);
      expect(counts.listener).toBe(0);
      expect(counts.stream).toBe(0);

      cleanup.dispose();
    });
  });

  describe('setTimeout', () => {
    it('should execute callback after delay', async () => {
      const cleanup = new CleanupManager();
      let called = false;

      cleanup.setTimeout(() => { called = true; }, 50);

      await new Promise(r => setTimeout(r, 100));

      expect(called).toBe(true);
      cleanup.dispose();
    });

    it('should not execute callback if disposed before delay', async () => {
      const cleanup = new CleanupManager();
      let called = false;

      cleanup.setTimeout(() => { called = true; }, 100);
      cleanup.dispose();

      await new Promise(r => setTimeout(r, 150));

      expect(called).toBe(false);
    });

    it('should remove registration when timer fires naturally', async () => {
      const cleanup = new CleanupManager();

      cleanup.setTimeout(() => {}, 50);
      expect(cleanup.resourceCount).toBe(1);

      await new Promise(r => setTimeout(r, 100));

      expect(cleanup.resourceCount).toBe(0);
      cleanup.dispose();
    });
  });

  describe('setInterval', () => {
    it('should execute callback repeatedly', async () => {
      const cleanup = new CleanupManager();
      let count = 0;

      cleanup.setInterval(() => { count++; }, 30);

      await new Promise(r => setTimeout(r, 100));

      expect(count).toBeGreaterThanOrEqual(2);
      cleanup.dispose();
    });

    it('should stop executing after dispose', async () => {
      const cleanup = new CleanupManager();
      let count = 0;

      cleanup.setInterval(() => { count++; }, 20);

      await new Promise(r => setTimeout(r, 50));
      const countAtDispose = count;
      cleanup.dispose();

      await new Promise(r => setTimeout(r, 100));

      expect(count).toBe(countAtDispose);
    });
  });

  describe('registerCleanup', () => {
    it('should call cleanup function on dispose', () => {
      const cleanup = new CleanupManager();
      let cleaned = false;

      cleanup.registerCleanup('watcher', () => { cleaned = true; }, 'test');
      cleanup.dispose();

      expect(cleaned).toBe(true);
    });

    it('should continue cleanup even if one fails', () => {
      const cleanup = new CleanupManager();
      let secondCleaned = false;

      cleanup.registerCleanup('watcher', () => { throw new Error('fail'); }, 'first');
      cleanup.registerCleanup('watcher', () => { secondCleaned = true; }, 'second');

      // Should not throw
      cleanup.dispose();

      expect(secondCleaned).toBe(true);
    });
  });

  describe('registerWatcher', () => {
    it('should call close() on dispose', () => {
      const cleanup = new CleanupManager();
      let closed = false;
      const watcher = { close: () => { closed = true; } };

      cleanup.registerWatcher(watcher, 'test watcher');
      cleanup.dispose();

      expect(closed).toBe(true);
    });
  });

  describe('registerListener', () => {
    it('should call removeListener on dispose', () => {
      const cleanup = new CleanupManager();
      const listener = () => {};
      let removed = false;
      const emitter = {
        removeListener: (event: string, fn: () => void) => {
          if (event === 'data' && fn === listener) removed = true;
        },
      };

      cleanup.registerListener(emitter, 'data', listener, 'test listener');
      cleanup.dispose();

      expect(removed).toBe(true);
    });

    it('should call off() if removeListener not available', () => {
      const cleanup = new CleanupManager();
      const listener = () => {};
      let removed = false;
      const emitter = {
        off: (event: string, fn: () => void) => {
          if (event === 'data' && fn === listener) removed = true;
        },
      };

      cleanup.registerListener(emitter, 'data', listener, 'test listener');
      cleanup.dispose();

      expect(removed).toBe(true);
    });
  });

  describe('registerStream', () => {
    it('should call destroy() on dispose', () => {
      const cleanup = new CleanupManager();
      let destroyed = false;
      const stream = { destroy: () => { destroyed = true; } };

      cleanup.registerStream(stream, 'test stream');
      cleanup.dispose();

      expect(destroyed).toBe(true);
    });

    it('should call close() if destroy not available', () => {
      const cleanup = new CleanupManager();
      let closed = false;
      const stream = { close: () => { closed = true; } };

      cleanup.registerStream(stream, 'test stream');
      cleanup.dispose();

      expect(closed).toBe(true);
    });
  });

  describe('unregister', () => {
    it('should manually remove and cleanup resource', () => {
      const cleanup = new CleanupManager();
      let cleaned = false;

      const id = cleanup.registerCleanup('watcher', () => { cleaned = true; }, 'test');
      expect(cleanup.resourceCount).toBe(1);

      const result = cleanup.unregister(id);

      expect(result).toBe(true);
      expect(cleaned).toBe(true);
      expect(cleanup.resourceCount).toBe(0);

      cleanup.dispose();
    });

    it('should return false for unknown id', () => {
      const cleanup = new CleanupManager();

      const result = cleanup.unregister('unknown-id');

      expect(result).toBe(false);
      cleanup.dispose();
    });
  });

  describe('dispose', () => {
    it('should be idempotent (safe to call multiple times)', () => {
      const cleanup = new CleanupManager();
      let cleanupCount = 0;

      cleanup.registerCleanup('watcher', () => { cleanupCount++; }, 'test');

      cleanup.dispose();
      cleanup.dispose();
      cleanup.dispose();

      expect(cleanupCount).toBe(1);
    });

    it('should mark as disposed', () => {
      const cleanup = new CleanupManager();

      cleanup.dispose();

      expect(cleanup.isDisposed).toBe(true);
      expect(cleanup.isStopped).toBe(true);
    });

    it('should clear all registrations', () => {
      const cleanup = new CleanupManager();

      cleanup.registerCleanup('watcher', () => {}, 'test1');
      cleanup.registerCleanup('watcher', () => {}, 'test2');
      expect(cleanup.resourceCount).toBe(2);

      cleanup.dispose();

      expect(cleanup.resourceCount).toBe(0);
    });
  });

  describe('isStopped guard pattern', () => {
    it('should allow checking isStopped in callbacks', async () => {
      const cleanup = new CleanupManager();
      let executedAfterStop = false;

      cleanup.setTimeout(() => {
        if (cleanup.isStopped) {
          executedAfterStop = false;
        } else {
          executedAfterStop = true;
        }
      }, 50);

      // Dispose before timer fires
      cleanup.dispose();

      await new Promise(r => setTimeout(r, 100));

      // The callback shouldn't have set this to true
      expect(executedAfterStop).toBe(false);
    });
  });

  describe('getRegistrations', () => {
    it('should return all current registrations', () => {
      const cleanup = new CleanupManager();

      cleanup.setTimeout(() => {}, 10000, { description: 'timer1' });
      cleanup.registerCleanup('watcher', () => {}, 'watcher1');

      const regs = cleanup.getRegistrations();

      expect(regs.length).toBe(2);
      expect(regs.some(r => r.type === 'timer')).toBe(true);
      expect(regs.some(r => r.type === 'watcher')).toBe(true);

      cleanup.dispose();
    });
  });
});
