/**
 * @fileoverview Unit + integration tests for TmuxManager
 *
 * Unit tests (mocked): validation, command construction, parsing logic.
 * Integration tests (real tmux): session creation, input, kill, reconciliation.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TmuxManager,
  buildRemoteLaunchCommand,
  formatPaneSnapshot,
  parsePaneList,
  resolveActivePaneTarget,
} from '../src/tmux-manager.js';
import { execSync, exec } from 'node:child_process';

// ============================================================================
// Unit Tests (mocked)
// ============================================================================

// Mock child_process
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    exec: vi.fn((_cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (typeof callback === 'function') {
        setImmediate(() => callback(null, '', ''));
      }
      return {
        on: vi.fn(),
        kill: vi.fn(),
        pid: 12345,
      };
    }),
    execSync: vi.fn(),
    spawn: vi.fn(() => ({
      unref: vi.fn(),
      on: vi.fn(),
      pid: 12345,
    })),
  };
});

// Mock fs to avoid file I/O
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFile: vi.fn((_path: string, _data: string, cb: (err: Error | null) => void) => cb(null)),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    writeFile: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
  };
});

describe('TmuxManager (unit)', () => {
  let manager: TmuxManager;
  const mockedExecSync = vi.mocked(execSync);
  const mockedExec = vi.mocked(exec);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: which claude returns /usr/local/bin/claude
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('which claude')) {
        return '/usr/local/bin/claude\n';
      }
      if (typeof cmd === 'string' && cmd.includes('which tmux')) {
        return '/usr/bin/tmux\n';
      }
      return '';
    });
    manager = new TmuxManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('backend', () => {
    it('should report tmux as backend', () => {
      expect(manager.backend).toBe('tmux');
    });
  });

  describe('remote launch command builder', () => {
    it('wraps codex command overrides in ssh with remote tmux launch', () => {
      const command = buildRemoteLaunchCommand({
        mode: 'codex',
        remote: {
          hostId: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          remotePath: '/home/ubuntu/work',
          commands: { codex: 'exec codx personal' },
        },
        sessionId: 'abc123def456',
      });

      expect(command).toContain('ssh');
      expect(command).toContain('BatchMode=yes');
      expect(command).toContain('ubuntu@10.0.0.42');
      expect(command).toContain('/home/ubuntu/work');
      expect(command).toContain('tmux -L codeman new-session -A');
      expect(command).toContain('exec codx personal');
    });

    it('uses default shell command when no override is configured', () => {
      const command = buildRemoteLaunchCommand({
        mode: 'shell',
        remote: {
          hostId: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          remotePath: '/home/ubuntu/work',
        },
        sessionId: 'abc123def456',
      });

      expect(command).toContain('exec bash -l');
    });
  });

  describe('getAttachCommand', () => {
    it('should return tmux', () => {
      expect(manager.getAttachCommand()).toBe('tmux');
    });
  });

  describe('getAttachArgs', () => {
    it('should attach every session through the dedicated Codeman socket', () => {
      const args = manager.getAttachArgs('codeman-abc12345');
      expect(args).toEqual(['-L', 'codeman', 'attach-session', '-t', 'codeman-abc12345']);
    });

    it('should attach registered sessions on the same dedicated socket (no per-session socket)', () => {
      manager.registerSession({
        sessionId: 'some-session',
        muxName: 'codeman-abc12345',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const args = manager.getAttachArgs('codeman-abc12345');
      expect(args).toEqual(['-L', 'codeman', 'attach-session', '-t', 'codeman-abc12345']);
    });
  });

  describe('window sizing', () => {
    it('pins a tmux window to manual sizing before browser attach', () => {
      expect(manager.setManualWindowSize('codeman-abc12345')).toBe(true);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "tmux -L 'codeman' set-window-option -t 'codeman-abc12345' window-size manual",
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('resizes the tmux window when Codeman accepts a desktop resize', () => {
      expect(manager.resizeWindow('codeman-abc12345', 140, 42)).toBe(true);

      // Non-blocking exec (not execSync) on the interactive resize hot path.
      expect(mockedExec).toHaveBeenCalledWith(
        "tmux -L 'codeman' resize-window -t 'codeman-abc12345' -x 140 -y 42",
        expect.objectContaining({ timeout: expect.any(Number) }),
        expect.any(Function)
      );
    });
  });

  describe('environment exports', () => {
    it('keeps COLORTERM unset for OpenCode sessions', () => {
      const exports = (
        manager as unknown as {
          buildEnvExports(sessionId: string, muxName: string, mode: string): string[];
        }
      ).buildEnvExports('session-1', 'codeman-abc12345', 'opencode');

      expect(exports).toContain('unset COLORTERM');
    });
  });

  describe('formatPaneSnapshot', () => {
    it('paints captured rows with absolute cursor positions to avoid newline autowrap scroll', () => {
      const fullWidthLine = 'x'.repeat(10);

      const snapshot = formatPaneSnapshot([fullWidthLine, 'next line'], {
        cols: 10,
        rows: 4,
        cursorX: 2,
        cursorY: 1,
      });

      // Full pane width is painted (10 cols); autowrap is avoided by the
      // absolute cursor positioning, not by dropping the last column.
      expect(snapshot).toBe(`\x1b[1;1H${'x'.repeat(10)}\x1b[2;1Hnext line\x1b[2;3H`);
      expect(snapshot).not.toContain('\n');
    });

    it('preserves the rightmost column of each captured row', () => {
      const snapshot = formatPaneSnapshot(['abcd'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      // Previously truncated to cols - 1 ('abc'); the full width is now kept.
      expect(snapshot).toBe('\x1b[1;1Habcd\x1b[1;1H');
    });

    it('preserves SGR color while stripping non-style pane controls', () => {
      const snapshot = formatPaneSnapshot(['\x1b[32mgreen\x1b[0m\x1b[2K\x1b[10;20Htail'], {
        cols: 40,
        rows: 2,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toContain('\x1b[32mgreen\x1b[0m');
      expect(snapshot).toContain('tail');
      expect(snapshot).not.toContain('\x1b[2K');
      expect(snapshot).not.toContain('\x1b[10;20H');
    });

    it('truncates styled rows by visible columns without cutting SGR escapes', () => {
      const snapshot = formatPaneSnapshot(['\x1b[31mabcdef\x1b[0m'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toBe('\x1b[1;1H\x1b[31mabcd\x1b[0m\x1b[1;1H');
    });

    it('does not let full-width glyphs cross the paint boundary', () => {
      // cols 5 = 'abc' (3) + full-width \u754c (2) fits exactly; with cols 4 the
      // wide glyph would straddle the boundary and is dropped.
      expect(formatPaneSnapshot(['abc\u754cdef'], { cols: 5, rows: 1, cursorX: 0, cursorY: 0 })).toBe(
        '\x1b[1;1Habc\u754c\x1b[1;1H'
      );
      expect(formatPaneSnapshot(['abc\u754cdef'], { cols: 4, rows: 1, cursorX: 0, cursorY: 0 })).toBe(
        '\x1b[1;1Habc\x1b[1;1H'
      );
    });

    it('keeps combining marks attached without consuming a terminal column', () => {
      const snapshot = formatPaneSnapshot(['a\u0301bc'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toBe('\x1b[1;1Ha\u0301bc\x1b[1;1H');
    });
  });

  describe('resolveActivePaneTarget', () => {
    it('selects the active pane instead of assuming pane zero', () => {
      expect(resolveActivePaneTarget('%1:0\n%18:1\n')).toBe('%18');
    });
  });

  describe('isAvailable', () => {
    it('should return true when tmux is found', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          return '/usr/bin/tmux\n';
        }
        return '';
      });
      expect(TmuxManager.isTmuxAvailable()).toBe(true);
    });

    it('should return false when tmux is not found', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          throw new Error('not found');
        }
        return '';
      });
      expect(TmuxManager.isTmuxAvailable()).toBe(false);
    });
  });

  // NOTE: In test mode (VITEST=1), sendInput is a no-op that returns true
  // without calling execSync. This prevents tests from sending input to real tmux.
  describe('sendInput (test mode safety)', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'test-id',
        muxName: 'codeman-1e571234',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should return true for registered session (no-op in test mode)', async () => {
      expect(await manager.sendInput('test-id', '/clear\r')).toBe(true);
    });

    it('should return false for unknown session', async () => {
      expect(await manager.sendInput('nonexistent', 'hello\r')).toBe(false);
    });

    it('should not call any tmux commands in test mode', async () => {
      mockedExecSync.mockClear();
      await manager.sendInput('test-id', 'hello\r');
      const sendKeyCalls = mockedExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('send-keys')
      );
      expect(sendKeyCalls).toHaveLength(0);
    });
  });

  // NOTE: In test mode, reconcileSessions returns all registered sessions as
  // alive without running any real tmux commands. This prevents discovery of
  // or interaction with the user's real tmux sessions.
  describe('reconcileSessions (test mode safety)', () => {
    it('should return all registered sessions as alive', async () => {
      manager.registerSession({
        sessionId: 'alive-1',
        muxName: 'codeman-a11ce111',
        pid: 100,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const result = await manager.reconcileSessions();
      expect(result.alive).toContain('alive-1');
      expect(result.dead).toHaveLength(0);
      expect(result.discovered).toHaveLength(0);
    });

    it('should never discover real tmux sessions', async () => {
      const result = await manager.reconcileSessions();
      expect(result.discovered).toHaveLength(0);
    });

    it('should not call any tmux commands in test mode', async () => {
      mockedExecSync.mockClear();
      await manager.reconcileSessions();
      const tmuxCalls = mockedExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && (cmd.includes('has-session') || cmd.includes('list-sessions'))
      );
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  // NOTE: In test mode, killSession removes from memory without running any
  // real kill commands. The self-kill protection is not needed because no real
  // tmux commands are executed — sessions are only removed from the in-memory map.
  describe('killSession (test mode safety)', () => {
    it('should remove session from memory in test mode', async () => {
      manager.registerSession({
        sessionId: 'kill-test',
        muxName: 'codeman-5e1f1111',
        pid: 999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const result = await manager.killSession('kill-test');
      expect(result).toBe(true);
      expect(manager.getSession('kill-test')).toBeUndefined();
    });

    it('should allow kill when session does NOT match CODEMAN_MUX_NAME', async () => {
      const originalEnv = process.env.CODEMAN_MUX_NAME;
      process.env.CODEMAN_MUX_NAME = 'codeman-0ther1111';

      try {
        manager.registerSession({
          sessionId: 'other-kill-test',
          muxName: 'codeman-d1ff1111',
          pid: 888,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        // Mock the kill flow
        mockedExecSync.mockImplementation(() => '');

        const result = await manager.killSession('other-kill-test');
        expect(result).toBe(true);

        // Session should be removed
        expect(manager.getSession('other-kill-test')).toBeUndefined();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CODEMAN_MUX_NAME;
        } else {
          process.env.CODEMAN_MUX_NAME = originalEnv;
        }
      }
    });

    it('should allow kill when CODEMAN_MUX_NAME is not set', async () => {
      const originalEnv = process.env.CODEMAN_MUX_NAME;
      delete process.env.CODEMAN_MUX_NAME;

      try {
        manager.registerSession({
          sessionId: 'no-env-test',
          muxName: 'codeman-aaa11111',
          pid: 777,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        mockedExecSync.mockImplementation(() => '');

        const result = await manager.killSession('no-env-test');
        expect(result).toBe(true);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CODEMAN_MUX_NAME;
        } else {
          process.env.CODEMAN_MUX_NAME = originalEnv;
        }
      }
    });
  });

  describe('metadata operations', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'meta-test',
        muxName: 'codeman-ae1a1234',
        pid: 300,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should update session name', () => {
      const result = manager.updateSessionName('meta-test', 'My Session');
      expect(result).toBe(true);
      expect(manager.getSession('meta-test')?.name).toBe('My Session');
    });

    it('should return false for unknown session name update', () => {
      const result = manager.updateSessionName('nonexistent', 'Name');
      expect(result).toBe(false);
    });

    it('should set attached status', () => {
      manager.setAttached('meta-test', true);
      expect(manager.getSession('meta-test')?.attached).toBe(true);
      manager.setAttached('meta-test', false);
      expect(manager.getSession('meta-test')?.attached).toBe(false);
    });

    it('should update respawn config', () => {
      const config = {
        enabled: true,
        idleTimeoutMs: 5000,
        updatePrompt: 'test',
        interStepDelayMs: 1000,
        sendClear: true,
        sendInit: true,
      };
      manager.updateRespawnConfig('meta-test', config);
      expect(manager.getSession('meta-test')?.respawnConfig).toEqual(config);
    });

    it('should clear respawn config', () => {
      manager.updateRespawnConfig('meta-test', {
        enabled: true,
        idleTimeoutMs: 5000,
        updatePrompt: 'test',
        interStepDelayMs: 1000,
        sendClear: true,
        sendInit: true,
      });
      manager.clearRespawnConfig('meta-test');
      expect(manager.getSession('meta-test')?.respawnConfig).toBeUndefined();
    });

    it('should update ralph enabled', () => {
      manager.updateRalphEnabled('meta-test', true);
      expect(manager.getSession('meta-test')?.ralphEnabled).toBe(true);
    });
  });

  describe('getSessions', () => {
    it('should return all registered sessions', () => {
      manager.registerSession({
        sessionId: 's1',
        muxName: 'codeman-51111111',
        pid: 1,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
      manager.registerSession({
        sessionId: 's2',
        muxName: 'codeman-52222222',
        pid: 2,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: true,
      });

      const sessions = manager.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionId)).toContain('s1');
      expect(sessions.map((s) => s.sessionId)).toContain('s2');
    });
  });

  describe('stats collection', () => {
    it('should start and stop stats collection', () => {
      manager.startStatsCollection(60000);
      // No error thrown
      manager.stopStatsCollection();
      // No error thrown
    });
  });

  describe('tmux launch cwd hardening', () => {
    async function importWithTmuxCommandsEnabled(): Promise<typeof TmuxManager> {
      const originalVitest = process.env.VITEST;
      vi.resetModules();
      delete process.env.VITEST;
      const module = await import('../src/tmux-manager.js');
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      return module.TmuxManager;
    }

    beforeEach(() => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          return '/usr/bin/tmux\n';
        }
        if (typeof cmd === 'string' && cmd.includes('display-message') && cmd.includes('#{pane_pid}')) {
          return '4242\n';
        }
        return '';
      });
    });

    it('starts new tmux sessions from /tmp and cd-bounces into the requested workspace', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();

      try {
        const session = await nonTestManager.createSession({
          sessionId: 'abc12345-1234-5678-90ab-cdef12345678',
          workingDir: '/mnt/gdrive/project with spaces',
          mode: 'shell',
        });

        expect(session.workingDir).toBe('/mnt/gdrive/project with spaces');
        expect(session.pid).toBe(4242);

        const newSessionCall = mockedExecSync.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' new-session ')
        );
        expect(newSessionCall?.[0]).toBe(`tmux -L 'codeman' new-session -ds "codeman-abc12345" -c /tmp`);
        expect(newSessionCall?.[1]).toEqual(expect.objectContaining({ cwd: '/tmp' }));

        const respawnCall = mockedExecSync.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' respawn-pane ')
        );
        expect(respawnCall?.[0]).toContain(`tmux -L 'codeman' respawn-pane -k -c /tmp -t "codeman-abc12345"`);
        expect(respawnCall?.[0]).toContain('cd \\"/mnt/gdrive/project with spaces\\" &&');
      } finally {
        nonTestManager.destroy();
      }
    });

    it('respawns existing panes from /tmp and cd-bounces into the requested workspace', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'respawn1234',
        muxName: 'codeman-abcd1234',
        pid: 1000,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: false,
      });

      try {
        const pid = await nonTestManager.respawnPane({
          sessionId: 'respawn1234',
          workingDir: '/mnt/gdrive/project',
          mode: 'shell',
        });

        expect(pid).toBe(4242);
        const { exec: currentExec } = await import('node:child_process');
        const respawnCall = vi
          .mocked(currentExec)
          .mock.calls.find(([cmd]) => typeof cmd === 'string' && cmd.includes(' respawn-pane '));
        expect(respawnCall?.[0]).toContain(`tmux -L 'codeman' respawn-pane -k -c /tmp -t "codeman-abcd1234"`);
        expect(respawnCall?.[0]).toContain('cd \\"/mnt/gdrive/project\\" &&');
      } finally {
        nonTestManager.destroy();
      }
    });
  });
});

// ============================================================================
// Parser Tests — locks in the '|' separator contract for `tmux list-panes -F`
// output, guarding against regressions in non-tty execution contexts where
// `\t` in tmux FORMAT strings can be emitted as the literal two characters
// `\` + `t` instead of a tab byte (launchd, systemd without TTYPath, docker
// exec without TTY). See PR #71.
// ============================================================================

describe('parsePaneList', () => {
  it('parses well-formed output into name → pid', () => {
    const out = 'codeman-aaaa|1234\ncodeman-bbbb|5678\nclaudeman-cccc|9999';
    const result = parsePaneList(out);
    expect(result.size).toBe(3);
    expect(result.get('codeman-aaaa')).toBe(1234);
    expect(result.get('codeman-bbbb')).toBe(5678);
    expect(result.get('claudeman-cccc')).toBe(9999);
  });

  it('returns an empty map for empty output', () => {
    expect(parsePaneList('').size).toBe(0);
  });

  it('skips blank lines', () => {
    const result = parsePaneList('\ncodeman-aaaa|100\n\n\ncodeman-bbbb|200\n');
    expect(result.size).toBe(2);
    expect(result.get('codeman-aaaa')).toBe(100);
    expect(result.get('codeman-bbbb')).toBe(200);
  });

  it('skips lines without the separator', () => {
    const result = parsePaneList('codeman-aaaa 1234\ncodeman-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('codeman-bbbb')).toBe(5678);
  });

  it('skips lines with a non-numeric pid', () => {
    const result = parsePaneList('codeman-aaaa|notapid\ncodeman-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('codeman-bbbb')).toBe(5678);
  });

  it('skips lines with an empty session name', () => {
    const result = parsePaneList('|1234\ncodeman-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('codeman-bbbb')).toBe(5678);
  });

  it('treats a literal backslash-t in input as part of the session name, not a delimiter', () => {
    // Reproduces the launchd/systemd regression: under non-tty contexts tmux
    // was emitting FORMAT '\t' as the two characters `\` + `t` rather than a
    // tab byte. With the '|' separator, such literals must not be silently
    // treated as a delimiter — the line is discarded because there is no '|'.
    const literalBackslashT = 'codeman-aaaa\\t1234';
    const result = parsePaneList(literalBackslashT);
    expect(result.size).toBe(0);
  });

  it('splits on the first separator only', () => {
    // Numeric trailing junk after the pid is tolerated by parseInt — proves
    // that splitting on the first '|' leaves the pid extractable even if a
    // future tmux ever appended extra fields.
    const result = parsePaneList('codeman-aaaa|1234|extra-field');
    expect(result.get('codeman-aaaa')).toBe(1234);
  });
});
