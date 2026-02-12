/**
 * @fileoverview Tests for ImageWatcher
 *
 * Tests image file detection, burst throttling, debounce behavior,
 * session management, and cleanup.
 *
 * Uses mocked chokidar to avoid real filesystem watching.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Create a mock watcher factory
const mockWatchers = new Map<string, EventEmitter>();

vi.mock('chokidar', () => ({
  watch: vi.fn((path: string) => {
    const watcher = new EventEmitter();
    (watcher as Record<string, unknown>).close = vi.fn();
    mockWatchers.set(path, watcher);
    return watcher;
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    statSync: vi.fn(() => ({ size: 2048 })),
  };
});

import { ImageWatcher } from '../src/image-watcher.js';
import { statSync } from 'node:fs';

describe('ImageWatcher', () => {
  let watcher: ImageWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatchers.clear();
    watcher = new ImageWatcher();
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
  });

  // ========== Start / Stop ==========

  describe('start / stop', () => {
    it('should not be running initially', () => {
      expect(watcher.isRunning()).toBe(false);
    });

    it('should be running after start()', () => {
      watcher.start();
      expect(watcher.isRunning()).toBe(true);
    });

    it('should not be running after stop()', () => {
      watcher.start();
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should be idempotent on double start', () => {
      watcher.start();
      watcher.start();
      expect(watcher.isRunning()).toBe(true);
    });
  });

  // ========== Session Watching ==========

  describe('watchSession', () => {
    it('should auto-start when watchSession is called', () => {
      watcher.watchSession('session-1', '/home/user/project');
      expect(watcher.isRunning()).toBe(true);
    });

    it('should track watched sessions', () => {
      watcher.watchSession('session-1', '/home/user/project');
      expect(watcher.getWatchedSessions()).toContain('session-1');
    });

    it('should not double-watch the same session with same dir', () => {
      watcher.watchSession('session-1', '/home/user/project');
      watcher.watchSession('session-1', '/home/user/project');
      // Only one watcher should be created
      expect(watcher.getWatchedSessions()).toHaveLength(1);
    });

    it('should replace watcher when working directory changes', () => {
      watcher.watchSession('session-1', '/home/user/project-a');
      watcher.watchSession('session-1', '/home/user/project-b');

      expect(watcher.getWatchedSessions()).toHaveLength(1);
      // Should have created watcher for both paths
      expect(mockWatchers.has('/home/user/project-a')).toBe(true);
      expect(mockWatchers.has('/home/user/project-b')).toBe(true);
    });
  });

  // ========== Unwatch Session ==========

  describe('unwatchSession', () => {
    it('should remove a watched session', () => {
      watcher.watchSession('session-1', '/home/user/project');
      watcher.unwatchSession('session-1');
      expect(watcher.getWatchedSessions()).not.toContain('session-1');
    });

    it('should close the chokidar watcher', () => {
      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;
      watcher.unwatchSession('session-1');
      expect(chokidarWatcher.close).toHaveBeenCalled();
    });

    it('should be safe to call for non-watched session', () => {
      expect(() => watcher.unwatchSession('nonexistent')).not.toThrow();
    });

    it('should clear pending debounce timers for the session', () => {
      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      // Trigger an image detection (starts debounce timer)
      chokidarWatcher.emit('add', '/home/user/project/screenshot.png');

      // Unwatch should clear the timer without emitting
      const handler = vi.fn();
      watcher.on('image:detected', handler);
      watcher.unwatchSession('session-1');

      // Advance past debounce period
      vi.advanceTimersByTime(500);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ========== Image Detection ==========

  describe('image detection', () => {
    it('should emit image:detected for .png files', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      chokidarWatcher.emit('add', '/home/user/project/screenshot.png');
      vi.advanceTimersByTime(300); // past debounce (200ms)

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.sessionId).toBe('session-1');
      expect(event.fileName).toBe('screenshot.png');
      expect(event.filePath).toBe('/home/user/project/screenshot.png');
      expect(event.relativePath).toBe('screenshot.png');
      expect(event.size).toBe(2048);
    });

    it('should emit for .jpg files', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      chokidarWatcher.emit('add', '/home/user/project/photo.jpg');
      vi.advanceTimersByTime(300);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit for .jpeg files', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      mockWatchers.get('/home/user/project')!.emit('add', '/home/user/project/img.jpeg');
      vi.advanceTimersByTime(300);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit for .gif files', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      mockWatchers.get('/home/user/project')!.emit('add', '/home/user/project/anim.gif');
      vi.advanceTimersByTime(300);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit for .webp files', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      mockWatchers.get('/home/user/project')!.emit('add', '/home/user/project/img.webp');
      vi.advanceTimersByTime(300);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit for .svg files', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      mockWatchers.get('/home/user/project')!.emit('add', '/home/user/project/icon.svg');
      vi.advanceTimersByTime(300);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should NOT emit for non-image files', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      chokidarWatcher.emit('add', '/home/user/project/readme.md');
      vi.advanceTimersByTime(300);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should NOT emit for .ts files', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      mockWatchers.get('/home/user/project')!.emit('add', '/home/user/project/index.ts');
      vi.advanceTimersByTime(300);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should compute relative path from working directory', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      mockWatchers.get('/home/user/project')!.emit('add', '/home/user/project/assets/img.png');
      vi.advanceTimersByTime(300);

      expect(handler.mock.calls[0][0].relativePath).toBe('assets/img.png');
    });
  });

  // ========== Debounce Behavior ==========

  describe('debounce', () => {
    it('should debounce rapid events for the same file', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      // Rapid adds of the same file
      chokidarWatcher.emit('add', '/home/user/project/screenshot.png');
      vi.advanceTimersByTime(100); // not yet past debounce
      chokidarWatcher.emit('add', '/home/user/project/screenshot.png');
      vi.advanceTimersByTime(100);
      chokidarWatcher.emit('add', '/home/user/project/screenshot.png');
      vi.advanceTimersByTime(300); // now past debounce from last emit

      // Should only emit once (the last debounced one)
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should allow events for different files concurrently', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      chokidarWatcher.emit('add', '/home/user/project/a.png');
      chokidarWatcher.emit('add', '/home/user/project/b.png');
      vi.advanceTimersByTime(300);

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  // ========== Burst Throttling ==========

  describe('burst throttling', () => {
    it('should throttle after 20 images in 10 seconds', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      // Emit 25 unique images in quick succession
      for (let i = 0; i < 25; i++) {
        chokidarWatcher.emit('add', `/home/user/project/img${i}.png`);
        vi.advanceTimersByTime(250); // past debounce, within burst window
      }

      // Only 20 should get through (BURST_LIMIT = 20)
      expect(handler).toHaveBeenCalledTimes(20);
    });

    it('should reset burst counter after window expires', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      // Fill up burst limit
      for (let i = 0; i < 20; i++) {
        chokidarWatcher.emit('add', `/home/user/project/img${i}.png`);
        vi.advanceTimersByTime(250);
      }
      expect(handler).toHaveBeenCalledTimes(20);

      // Wait for burst window to expire (10 seconds)
      vi.advanceTimersByTime(11_000);

      // Should accept new images
      chokidarWatcher.emit('add', '/home/user/project/new.png');
      vi.advanceTimersByTime(300);

      expect(handler).toHaveBeenCalledTimes(21);
    });
  });

  // ========== Error Handling ==========

  describe('error handling', () => {
    it('should emit image:error on chokidar error', () => {
      const errorHandler = vi.fn();
      watcher.on('image:error', errorHandler);

      watcher.watchSession('session-1', '/home/user/project');
      const chokidarWatcher = mockWatchers.get('/home/user/project')!;

      const testError = new Error('watch failed');
      chokidarWatcher.emit('error', testError);

      expect(errorHandler).toHaveBeenCalledWith(testError, 'session-1');
    });

    it('should emit image:error if statSync fails during emission', () => {
      vi.mocked(statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const errorHandler = vi.fn();
      const detectHandler = vi.fn();
      watcher.on('image:error', errorHandler);
      watcher.on('image:detected', detectHandler);

      watcher.watchSession('session-1', '/home/user/project');
      mockWatchers.get('/home/user/project')!.emit('add', '/home/user/project/deleted.png');
      vi.advanceTimersByTime(300);

      expect(detectHandler).not.toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalled();

      // Restore
      vi.mocked(statSync).mockReturnValue({ size: 2048 } as ReturnType<typeof statSync>);
    });
  });

  // ========== Stop / Cleanup ==========

  describe('stop', () => {
    it('should close all chokidar watchers', () => {
      watcher.watchSession('session-1', '/home/user/project-a');
      watcher.watchSession('session-2', '/home/user/project-b');

      watcher.stop();

      for (const w of mockWatchers.values()) {
        expect(w.close).toHaveBeenCalled();
      }
    });

    it('should clear all maps', () => {
      watcher.watchSession('session-1', '/home/user/project');
      watcher.stop();

      expect(watcher.getWatchedSessions()).toHaveLength(0);
      expect(watcher.isRunning()).toBe(false);
    });

    it('should clear debounce timers so no events fire after stop', () => {
      const handler = vi.fn();
      watcher.on('image:detected', handler);

      watcher.watchSession('session-1', '/home/user/project');
      mockWatchers.get('/home/user/project')!.emit('add', '/home/user/project/screenshot.png');

      // Stop before debounce fires
      watcher.stop();
      vi.advanceTimersByTime(500);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
