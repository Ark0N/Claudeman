/**
 * @fileoverview Tests for FileStreamManager
 *
 * Tests stream creation, path validation, concurrent stream limits,
 * cleanup, and inactivity timeout logic.
 *
 * Uses mocked child_process.spawn to avoid real tail processes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs functions
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 1024 })),
  };
});

import { FileStreamManager } from '../src/file-stream-manager.js';
import { existsSync, statSync } from 'node:fs';

/**
 * Creates a mock ChildProcess-like EventEmitter with stdout/stderr streams.
 */
function createMockProcess(pid = 12345): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as Record<string, unknown>).pid = pid;
  (proc as Record<string, unknown>).stdout = new EventEmitter();
  (proc as Record<string, unknown>).stderr = new EventEmitter();
  (proc as Record<string, unknown>).kill = vi.fn();
  return proc;
}

describe('FileStreamManager', () => {
  let manager: FileStreamManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new FileStreamManager();
    mockSpawn.mockReset();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ size: 1024 } as ReturnType<typeof statSync>);
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  // ========== Stream Creation ==========

  describe('createStream', () => {
    it('should create a stream successfully', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(result.streamId).toBeTruthy();
      expect(manager.activeStreamCount).toBe(1);
    });

    it('should call spawn with correct arguments', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'tail',
        ['-f', '-n', '50', expect.stringContaining('/var/log/app.log')],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    });

    it('should use custom lines parameter', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        lines: 100,
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'tail',
        ['-f', '-n', '100', expect.any(String)],
        expect.any(Object),
      );
    });

    it('should reject when file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/nonexistent.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should reject when file is too large', async () => {
      vi.mocked(statSync).mockReturnValue({ size: 200 * 1024 * 1024 } as ReturnType<typeof statSync>);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/huge.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/too large/i);
    });

    it('should reject when process fails to spawn (no PID)', async () => {
      const proc = createMockProcess(0);
      (proc as Record<string, unknown>).pid = undefined;
      mockSpawn.mockReturnValue(proc);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to spawn/);
    });

    it('should forward stdout data to onData callback', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const onData = vi.fn();

      await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData,
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      proc.stdout!.emit('data', Buffer.from('line 1\nline 2\n'));
      expect(onData).toHaveBeenCalledWith('line 1\nline 2\n');
    });

    it('should forward stderr data to onError callback', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const onError = vi.fn();

      await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError,
      });

      proc.stderr!.emit('data', Buffer.from('tail: error\n'));
      expect(onError).toHaveBeenCalledWith('tail: error\n');
    });

    it('should call onEnd when process exits', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const onEnd = vi.fn();

      await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd,
        onError: vi.fn(),
      });

      proc.emit('exit', 0);
      expect(onEnd).toHaveBeenCalled();
    });
  });

  // ========== Concurrent Stream Limits ==========

  describe('concurrent stream limits', () => {
    it('should enforce max 5 streams per session', async () => {
      // Create 5 streams for same session
      for (let i = 0; i < 5; i++) {
        const proc = createMockProcess(1000 + i);
        mockSpawn.mockReturnValue(proc);

        const result = await manager.createStream({
          sessionId: 'session-1',
          filePath: `/var/log/file${i}.log`,
          workingDir: '/var/log',
          onData: vi.fn(),
          onEnd: vi.fn(),
          onError: vi.fn(),
        });
        expect(result.success).toBe(true);
      }

      // 6th should fail
      const proc = createMockProcess(2000);
      mockSpawn.mockReturnValue(proc);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/file5.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Maximum.*5.*concurrent/);
    });

    it('should allow streams for different sessions independently', async () => {
      for (const sessionId of ['session-a', 'session-b']) {
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const result = await manager.createStream({
          sessionId,
          filePath: '/var/log/app.log',
          workingDir: '/var/log',
          onData: vi.fn(),
          onEnd: vi.fn(),
          onError: vi.fn(),
        });
        expect(result.success).toBe(true);
      }

      expect(manager.activeStreamCount).toBe(2);
    });
  });

  // ========== Close Stream ==========

  describe('closeStream', () => {
    it('should close an existing stream', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      const closed = manager.closeStream(result.streamId!);
      expect(closed).toBe(true);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.activeStreamCount).toBe(0);
    });

    it('should return false for non-existent stream', () => {
      expect(manager.closeStream('nonexistent')).toBe(false);
    });

    it('should call onEnd when stream is closed', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const onEnd = vi.fn();

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd,
        onError: vi.fn(),
      });

      manager.closeStream(result.streamId!);
      expect(onEnd).toHaveBeenCalled();
    });
  });

  // ========== Close Session Streams ==========

  describe('closeSessionStreams', () => {
    it('should close all streams for a session', async () => {
      const procs: ChildProcess[] = [];
      for (let i = 0; i < 3; i++) {
        const proc = createMockProcess(1000 + i);
        procs.push(proc);
        mockSpawn.mockReturnValueOnce(proc);

        await manager.createStream({
          sessionId: 'session-1',
          filePath: `/var/log/file${i}.log`,
          workingDir: '/var/log',
          onData: vi.fn(),
          onEnd: vi.fn(),
          onError: vi.fn(),
        });
      }

      const closed = manager.closeSessionStreams('session-1');
      expect(closed).toBe(3);
      expect(manager.activeStreamCount).toBe(0);
    });

    it('should not affect other sessions', async () => {
      for (const sessionId of ['session-1', 'session-2']) {
        const proc = createMockProcess();
        mockSpawn.mockReturnValueOnce(proc);
        await manager.createStream({
          sessionId,
          filePath: '/var/log/app.log',
          workingDir: '/var/log',
          onData: vi.fn(),
          onEnd: vi.fn(),
          onError: vi.fn(),
        });
      }

      manager.closeSessionStreams('session-1');
      expect(manager.activeStreamCount).toBe(1);
    });
  });

  // ========== getSessionStreams ==========

  describe('getSessionStreams', () => {
    it('should return stream info for a session', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      const streams = manager.getSessionStreams('session-1');
      expect(streams).toHaveLength(1);
      expect(streams[0].filePath).toContain('app.log');
      expect(streams[0].id).toBeTruthy();
      expect(streams[0].createdAt).toBeGreaterThan(0);
    });

    it('should return empty array for unknown session', () => {
      expect(manager.getSessionStreams('unknown')).toEqual([]);
    });
  });

  // ========== Path Validation ==========

  describe('path validation', () => {
    it('should reject paths outside allowed directories', async () => {
      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/etc/shadow',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Path must be within/);
    });

    it('should allow paths within working directory', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/sub/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(true);
    });

    it('should allow paths in /var/log', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/syslog',
        workingDir: '/home/user',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(true);
    });

    it('should allow paths in /tmp', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/tmp/test.log',
        workingDir: '/home/user',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(true);
    });

    it('should handle stat errors gracefully', async () => {
      vi.mocked(statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/gone.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found|not accessible/i);
    });
  });

  // ========== Inactivity Cleanup ==========

  describe('inactivity cleanup', () => {
    it('should close streams inactive for 5+ minutes', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const onEnd = vi.fn();

      await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd,
        onError: vi.fn(),
      });

      // Advance past the cleanup interval (1 min) + inactivity timeout (5 min)
      vi.advanceTimersByTime(6 * 60 * 1000);

      expect(manager.activeStreamCount).toBe(0);
      expect(onEnd).toHaveBeenCalled();
    });
  });

  // ========== Destroy ==========

  describe('destroy', () => {
    it('should close all streams and clear state', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await manager.createStream({
        sessionId: 'session-1',
        filePath: '/var/log/app.log',
        workingDir: '/var/log',
        onData: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
      });

      manager.destroy();
      expect(manager.activeStreamCount).toBe(0);
    });
  });
});
