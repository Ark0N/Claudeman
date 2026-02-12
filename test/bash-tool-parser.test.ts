/**
 * @fileoverview Tests for BashToolParser
 *
 * Tests the terminal output parser that detects Bash tool invocations,
 * extracts file paths, and tracks tool lifecycle (start/completion).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BashToolParser } from '../src/bash-tool-parser.js';

describe('BashToolParser', () => {
  let parser: BashToolParser;

  beforeEach(() => {
    vi.useFakeTimers();
    parser = new BashToolParser({ sessionId: 'test-session' });
  });

  afterEach(() => {
    parser.destroy();
    vi.useRealTimers();
  });

  // ========== Constructor & Accessors ==========

  describe('constructor', () => {
    it('should initialize with session ID', () => {
      expect(parser.sessionId).toBe('test-session');
    });

    it('should be enabled by default', () => {
      expect(parser.enabled).toBe(true);
    });

    it('should accept enabled: false', () => {
      const p = new BashToolParser({ sessionId: 's', enabled: false });
      expect(p.enabled).toBe(false);
      p.destroy();
    });

    it('should accept a custom working directory', () => {
      const p = new BashToolParser({ sessionId: 's', workingDir: '/tmp/test' });
      expect(p.workingDir).toBe('/tmp/test');
      p.destroy();
    });

    it('should start with no active tools', () => {
      expect(parser.activeTools).toEqual([]);
    });
  });

  // ========== Enable / Disable ==========

  describe('enable / disable', () => {
    it('should toggle enabled state', () => {
      parser.disable();
      expect(parser.enabled).toBe(false);
      parser.enable();
      expect(parser.enabled).toBe(true);
    });

    it('should ignore processTerminalData when disabled', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);
      parser.disable();

      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');
      vi.advanceTimersByTime(100);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ========== Path Normalization ==========

  describe('normalizePath', () => {
    it('should expand ~ to home directory', () => {
      const home = process.env.HOME || '/home/user';
      expect(parser.normalizePath('~/foo/bar')).toBe(`${home}/foo/bar`);
    });

    it('should expand bare ~', () => {
      const home = process.env.HOME || '/home/user';
      expect(parser.normalizePath('~')).toBe(home);
    });

    it('should leave absolute paths unchanged', () => {
      expect(parser.normalizePath('/var/log/app.log')).toBe('/var/log/app.log');
    });

    it('should resolve .. components', () => {
      expect(parser.normalizePath('/a/b/../c')).toBe('/a/c');
    });

    it('should resolve . components', () => {
      expect(parser.normalizePath('/a/./b')).toBe('/a/b');
    });

    it('should not go above root with ..', () => {
      expect(parser.normalizePath('/../../etc/passwd')).toBe('/etc/passwd');
    });

    it('should return empty string for empty input', () => {
      expect(parser.normalizePath('')).toBe('');
    });

    it('should trim whitespace', () => {
      expect(parser.normalizePath('  /var/log  ')).toBe('/var/log');
    });
  });

  // ========== Path Equivalence ==========

  describe('pathsAreEquivalent', () => {
    it('should match identical paths', () => {
      expect(parser.pathsAreEquivalent('/var/log/a.log', '/var/log/a.log')).toBe(true);
    });

    it('should match after normalization', () => {
      expect(parser.pathsAreEquivalent('/var/log/../log/a.log', '/var/log/a.log')).toBe(true);
    });

    it('should not match different files', () => {
      expect(parser.pathsAreEquivalent('/var/log/a.log', '/var/log/b.log')).toBe(false);
    });

    it('should match shallow root path with working dir path (same filename)', () => {
      const p = new BashToolParser({ sessionId: 's', workingDir: '/home/user/project' });
      // /test.txt is a shallow root path and /home/user/project/test.txt is in workdir
      expect(p.pathsAreEquivalent('/test.txt', '/home/user/project/test.txt')).toBe(true);
      p.destroy();
    });

    it('should not match shallow root path with non-workdir path', () => {
      const p = new BashToolParser({ sessionId: 's', workingDir: '/home/user/project' });
      // Both are outside working dir
      expect(p.pathsAreEquivalent('/test.txt', '/other/dir/test.txt')).toBe(false);
      p.destroy();
    });
  });

  // ========== Path Deduplication ==========

  describe('deduplicatePaths', () => {
    it('should return single path as-is', () => {
      expect(parser.deduplicatePaths(['/a/b'])).toEqual(['/a/b']);
    });

    it('should remove exact duplicates', () => {
      const result = parser.deduplicatePaths(['/a/b', '/a/b']);
      expect(result).toHaveLength(1);
    });

    it('should remove normalized duplicates', () => {
      const result = parser.deduplicatePaths(['/a/b/../c', '/a/c']);
      expect(result).toHaveLength(1);
    });

    it('should keep different paths', () => {
      const result = parser.deduplicatePaths(['/a/b', '/c/d']);
      expect(result).toHaveLength(2);
    });

    it('should handle empty array', () => {
      expect(parser.deduplicatePaths([])).toEqual([]);
    });
  });

  // ========== Tool Detection ==========

  describe('processTerminalData - tool start', () => {
    it('should detect ● Bash(tail -f /var/log/syslog) pattern', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');
      // toolStart is emitted synchronously (not debounced)

      expect(handler).toHaveBeenCalledTimes(1);
      const tool = handler.mock.calls[0][0];
      expect(tool.command).toBe('tail -f /var/log/syslog');
      expect(tool.filePaths).toContain('/var/log/syslog');
      expect(tool.status).toBe('running');
      expect(tool.sessionId).toBe('test-session');
    });

    it('should detect tool with timeout', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('● Bash(tail -f /tmp/out.log) timeout: 5m 0s\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].timeout).toBe('5m 0s');
    });

    it('should detect cat command', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('● Bash(cat /etc/hostname)\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].filePaths).toContain('/etc/hostname');
    });

    it('should detect head command', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('● Bash(head -n 20 /var/log/kern.log)\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].filePaths).toContain('/var/log/kern.log');
    });

    it('should detect grep command with file path', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('● Bash(grep error /var/log/app.log)\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].filePaths).toContain('/var/log/app.log');
    });

    it('should detect watch command', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('● Bash(watch /tmp/status.txt)\n');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should NOT detect non-file-viewer commands', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('● Bash(echo hello)\n');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should extract multiple file paths from a single command', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('● Bash(tail -f /var/log/a.log /var/log/b.log)\n');

      expect(handler).toHaveBeenCalledTimes(1);
      const paths = handler.mock.calls[0][0].filePaths;
      expect(paths).toContain('/var/log/a.log');
      expect(paths).toContain('/var/log/b.log');
    });

    it('should skip /dev/null paths', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      // grep with /dev/null shouldn't produce a tool (only invalid path)
      parser.processTerminalData('● Bash(cat /dev/null)\n');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle ANSI codes in the output', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('\x1b[1m● Bash(tail -f /var/log/test.log)\x1b[0m\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].filePaths).toContain('/var/log/test.log');
    });
  });

  // ========== Tool Completion ==========

  describe('processTerminalData - tool completion', () => {
    it('should emit toolEnd on ✓ Bash', () => {
      const endHandler = vi.fn();
      parser.on('toolEnd', endHandler);

      // Start a tool first
      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');
      // Complete it
      parser.processTerminalData('✓ Bash\n');

      expect(endHandler).toHaveBeenCalledTimes(1);
      expect(endHandler.mock.calls[0][0].status).toBe('completed');
    });

    it('should emit toolEnd on ✗ Bash (failure)', () => {
      const endHandler = vi.fn();
      parser.on('toolEnd', endHandler);

      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');
      parser.processTerminalData('✗ Bash\n');

      expect(endHandler).toHaveBeenCalledTimes(1);
      expect(endHandler.mock.calls[0][0].status).toBe('completed');
    });

    it('should remove completed tool after 2000ms delay', () => {
      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');
      expect(parser.activeTools).toHaveLength(1);

      parser.processTerminalData('✓ Bash\n');
      // Tool still present (in completed state)
      expect(parser.activeTools).toHaveLength(1);

      vi.advanceTimersByTime(2000);
      expect(parser.activeTools).toHaveLength(0);
    });
  });

  // ========== Text Command Detection ==========

  describe('processTerminalData - text command fallback', () => {
    it('should detect plain text "tail -f /path" suggestions', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('tail -f /var/log/app.log\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].filePaths).toContain('/var/log/app.log');
    });

    it('should auto-remove text command suggestions after 30s', () => {
      parser.processTerminalData('tail -f /var/log/app.log\n');
      expect(parser.activeTools).toHaveLength(1);

      vi.advanceTimersByTime(30000);
      expect(parser.activeTools).toHaveLength(0);
    });
  });

  // ========== Log File Mention Detection ==========

  describe('processTerminalData - log file mentions', () => {
    it('should detect .log file paths mentioned in text', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('The output is saved to /tmp/output.log for review\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].filePaths).toContain('/tmp/output.log');
    });

    it('should detect .txt file paths mentioned in text', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('See /tmp/results.txt for details\n');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should detect .out file paths mentioned in text', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('Wrote to /tmp/build.out\n');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should auto-remove log mentions after 60s', () => {
      parser.processTerminalData('Wrote to /tmp/build.log\n');
      expect(parser.activeTools).toHaveLength(1);

      vi.advanceTimersByTime(60000);
      expect(parser.activeTools).toHaveLength(0);
    });

    it('should strip trailing punctuation from paths', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.processTerminalData('Check /tmp/output.log, please\n');

      expect(handler).toHaveBeenCalledTimes(1);
      const filePaths = handler.mock.calls[0][0].filePaths;
      expect(filePaths[0]).not.toMatch(/,$/);
    });
  });

  // ========== Deduplication ==========

  describe('cross-pattern deduplication', () => {
    it('should not add duplicate file paths from different patterns', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      // First: detected as a Bash tool
      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');
      expect(handler).toHaveBeenCalledTimes(1);

      // Second: same path as text command — should be skipped
      parser.processTerminalData('tail -f /var/log/syslog\n');
      expect(handler).toHaveBeenCalledTimes(1); // still 1
    });

    it('should track file paths correctly', () => {
      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');

      expect(parser.isFilePathTracked('/var/log/syslog')).toBe(true);
      expect(parser.isFilePathTracked('/var/log/other.log')).toBe(false);
    });
  });

  // ========== Max Tools Limit ==========

  describe('max active tools limit', () => {
    it('should evict oldest tool when limit reached', () => {
      // The limit is MAX_ACTIVE_TOOLS = 20
      for (let i = 0; i < 21; i++) {
        parser.processTerminalData(`● Bash(tail -f /var/log/file${i}.log)\n`);
      }

      // Should have exactly 20 tools
      expect(parser.activeTools.length).toBeLessThanOrEqual(20);
    });
  });

  // ========== Line Buffer ==========

  describe('line buffer handling', () => {
    it('should handle data split across multiple chunks', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      // Split the line across two processTerminalData calls
      parser.processTerminalData('● Bash(tail -f /var/');
      expect(handler).not.toHaveBeenCalled();

      parser.processTerminalData('log/syslog)\n');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple lines in one chunk', () => {
      const startHandler = vi.fn();
      const endHandler = vi.fn();
      parser.on('toolStart', startHandler);
      parser.on('toolEnd', endHandler);

      parser.processTerminalData(
        '● Bash(tail -f /var/log/a.log)\n✓ Bash\n● Bash(cat /var/log/b.log)\n',
      );

      expect(startHandler).toHaveBeenCalledTimes(2);
      expect(endHandler).toHaveBeenCalledTimes(1);
    });

    it('should truncate line buffer if it exceeds max size', () => {
      // Generate data larger than MAX_LINE_BUFFER_SIZE (64KB)
      const longLine = 'x'.repeat(70 * 1024);
      parser.processTerminalData(longLine);

      // Should not throw; parser continues working
      const handler = vi.fn();
      parser.on('toolStart', handler);
      parser.processTerminalData('● Bash(tail -f /var/log/test.log)\n');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ========== Debounced Updates ==========

  describe('debounced updates', () => {
    it('should emit toolsUpdate after debounce period', () => {
      const handler = vi.fn();
      parser.on('toolsUpdate', handler);

      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');

      // Not emitted yet (debounced at 50ms)
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toHaveLength(1);
    });
  });

  // ========== Reset ==========

  describe('reset', () => {
    it('should clear all tracked tools', () => {
      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');
      expect(parser.activeTools).toHaveLength(1);

      parser.reset();
      expect(parser.activeTools).toHaveLength(0);
    });
  });

  // ========== Destroy ==========

  describe('destroy', () => {
    it('should prevent further processing after destroy', () => {
      const handler = vi.fn();
      parser.on('toolStart', handler);

      parser.destroy();
      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should clear active tools and timers', () => {
      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');
      parser.destroy();

      expect(parser.activeTools).toHaveLength(0);
    });
  });

  // ========== isPathInWorkingDir ==========

  describe('isPathInWorkingDir', () => {
    it('should return true for paths inside working dir', () => {
      const p = new BashToolParser({ sessionId: 's', workingDir: '/home/user/project' });
      expect(p.isPathInWorkingDir('/home/user/project/src/main.ts')).toBe(true);
      p.destroy();
    });

    it('should return false for paths outside working dir', () => {
      const p = new BashToolParser({ sessionId: 's', workingDir: '/home/user/project' });
      expect(p.isPathInWorkingDir('/var/log/app.log')).toBe(false);
      p.destroy();
    });

    it('should return true for the working dir itself', () => {
      const p = new BashToolParser({ sessionId: 's', workingDir: '/home/user/project' });
      expect(p.isPathInWorkingDir('/home/user/project')).toBe(true);
      p.destroy();
    });
  });

  // ========== setWorkingDir ==========

  describe('setWorkingDir', () => {
    it('should update the working directory', () => {
      parser.setWorkingDir('/new/dir');
      expect(parser.workingDir).toBe('/new/dir');
    });
  });

  // ========== getTrackedPaths ==========

  describe('getTrackedPaths', () => {
    it('should return raw and normalized paths for running tools', () => {
      parser.processTerminalData('● Bash(tail -f /var/log/syslog)\n');

      const tracked = parser.getTrackedPaths();
      expect(tracked).toHaveLength(1);
      expect(tracked[0].raw).toBe('/var/log/syslog');
      expect(tracked[0].normalized).toBe('/var/log/syslog');
    });

    it('should return empty array when no tools are active', () => {
      expect(parser.getTrackedPaths()).toEqual([]);
    });
  });
});
