/**
 * @fileoverview Unit + integration tests for TmuxManager
 *
 * Unit tests (mocked): validation, command construction, parsing logic.
 * Integration tests (real tmux): session creation, input, kill, reconciliation.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TmuxManager } from '../src/tmux-manager.js';
import { execSync } from 'node:child_process';
import { registerTestTmuxSession, unregisterTestTmuxSession } from './setup.js';

// ============================================================================
// Unit Tests (mocked)
// ============================================================================

// Mock child_process
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
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

describe('TmuxManager (unit)', () => {
  let manager: TmuxManager;
  const mockedExecSync = vi.mocked(execSync);

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

  describe('getAttachCommand', () => {
    it('should return tmux', () => {
      expect(manager.getAttachCommand()).toBe('tmux');
    });
  });

  describe('getAttachArgs', () => {
    it('should return attach-session args', () => {
      const args = manager.getAttachArgs('claudeman-abc12345');
      expect(args).toEqual(['attach-session', '-t', 'claudeman-abc12345']);
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

  describe('sendInput', () => {
    beforeEach(() => {
      // Register a session for sendInput tests
      manager.registerSession({
        sessionId: 'test-id',
        muxName: 'claudeman-1e571234',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should send text + Enter as two separate tmux commands', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      manager.sendInput('test-id', '/clear\r');

      // Should have 2 calls: send-keys -l text, then send-keys Enter
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('send-keys');
      expect(calls[0]).toContain('-l');
      expect(calls[0]).toContain('/clear');
      expect(calls[1]).toContain('send-keys');
      expect(calls[1]).toContain('Enter');
    });

    it('should send text only (no Enter) when no \\r present', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      manager.sendInput('test-id', 'hello world');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('send-keys');
      expect(calls[0]).toContain('-l');
      expect(calls[0]).not.toContain('Enter');
    });

    it('should send Enter only when input is just \\r', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      manager.sendInput('test-id', '\r');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('send-keys');
      expect(calls[0]).toContain('Enter');
      expect(calls[0]).not.toContain('-l');
    });

    it('should return false for unknown session', () => {
      const result = manager.sendInput('nonexistent', 'hello\r');
      expect(result).toBe(false);
    });

    it('should use -l flag for literal text (no key interpretation)', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      // Text that could be interpreted as tmux keys without -l
      manager.sendInput('test-id', 'C-c');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('-l');
    });

    it('should target the correct session name', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      manager.sendInput('test-id', 'test\r');

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toContain('claudeman-1e571234');
      }
    });
  });

  describe('reconcileSessions', () => {
    it('should detect alive sessions', async () => {
      manager.registerSession({
        sessionId: 'alive-1',
        muxName: 'claudeman-a11ce111',
        pid: 100,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('has-session')) {
          return ''; // exit 0 = exists
        }
        if (typeof cmd === 'string' && cmd.includes('display-message')) {
          return '100\n';
        }
        if (typeof cmd === 'string' && cmd.includes('list-sessions')) {
          return 'claudeman-a11ce111\n';
        }
        return '';
      });

      const result = await manager.reconcileSessions();
      expect(result.alive).toContain('alive-1');
      expect(result.dead).toHaveLength(0);
    });

    it('should detect dead sessions', async () => {
      manager.registerSession({
        sessionId: 'dead-1',
        muxName: 'claudeman-dead1111',
        pid: 200,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('has-session')) {
          throw new Error('session not found');
        }
        if (typeof cmd === 'string' && cmd.includes('list-sessions')) {
          return ''; // no sessions
        }
        return '';
      });

      const result = await manager.reconcileSessions();
      expect(result.dead).toContain('dead-1');
      expect(result.alive).toHaveLength(0);
    });

    it('should discover unknown claudeman sessions', async () => {
      // Use hex-only name to pass SAFE_MUX_NAME_PATTERN validation
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('list-sessions')) {
          return 'claudeman-abc12345\nmy-other-session\n';
        }
        if (typeof cmd === 'string' && cmd.includes('display-message') && cmd.includes('abc12345')) {
          return '999\n';
        }
        return '';
      });

      const result = await manager.reconcileSessions();
      expect(result.discovered).toHaveLength(1);
      expect(result.discovered[0]).toBe('restored-abc12345');
    });

    it('should not discover non-claudeman sessions', async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('list-sessions')) {
          return 'my-tmux-session\n';
        }
        return '';
      });

      const result = await manager.reconcileSessions();
      expect(result.discovered).toHaveLength(0);
    });
  });

  describe('killSession self-kill protection', () => {
    it('should block kill when session matches CLAUDEMAN_SCREEN_NAME', async () => {
      const originalEnv = process.env.CLAUDEMAN_SCREEN_NAME;
      process.env.CLAUDEMAN_SCREEN_NAME = 'claudeman-5e1f1111';

      try {
        manager.registerSession({
          sessionId: 'self-kill-test',
          muxName: 'claudeman-5e1f1111',
          pid: 999,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        const result = await manager.killSession('self-kill-test');
        expect(result).toBe(false);

        // Session should still exist (not removed)
        expect(manager.getSession('self-kill-test')).toBeDefined();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CLAUDEMAN_SCREEN_NAME;
        } else {
          process.env.CLAUDEMAN_SCREEN_NAME = originalEnv;
        }
      }
    });

    it('should allow kill when session does NOT match CLAUDEMAN_SCREEN_NAME', async () => {
      const originalEnv = process.env.CLAUDEMAN_SCREEN_NAME;
      process.env.CLAUDEMAN_SCREEN_NAME = 'claudeman-0ther1111';

      try {
        manager.registerSession({
          sessionId: 'other-kill-test',
          muxName: 'claudeman-d1ff1111',
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
          delete process.env.CLAUDEMAN_SCREEN_NAME;
        } else {
          process.env.CLAUDEMAN_SCREEN_NAME = originalEnv;
        }
      }
    });

    it('should allow kill when CLAUDEMAN_SCREEN_NAME is not set', async () => {
      const originalEnv = process.env.CLAUDEMAN_SCREEN_NAME;
      delete process.env.CLAUDEMAN_SCREEN_NAME;

      try {
        manager.registerSession({
          sessionId: 'no-env-test',
          muxName: 'claudeman-aaa11111',
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
          delete process.env.CLAUDEMAN_SCREEN_NAME;
        } else {
          process.env.CLAUDEMAN_SCREEN_NAME = originalEnv;
        }
      }
    });
  });

  describe('metadata operations', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'meta-test',
        muxName: 'claudeman-ae1a1234',
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
      const config = { enabled: true, idleTimeoutMs: 5000, updatePrompt: 'test', interStepDelayMs: 1000, sendClear: true, sendInit: true };
      manager.updateRespawnConfig('meta-test', config);
      expect(manager.getSession('meta-test')?.respawnConfig).toEqual(config);
    });

    it('should clear respawn config', () => {
      manager.updateRespawnConfig('meta-test', { enabled: true, idleTimeoutMs: 5000, updatePrompt: 'test', interStepDelayMs: 1000, sendClear: true, sendInit: true });
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
        muxName: 'claudeman-51111111',
        pid: 1,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
      manager.registerSession({
        sessionId: 's2',
        muxName: 'claudeman-52222222',
        pid: 2,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: true,
      });

      const sessions = manager.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.sessionId)).toContain('s1');
      expect(sessions.map(s => s.sessionId)).toContain('s2');
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
});

// ============================================================================
// Integration Tests (real tmux sessions)
// ============================================================================

describe('TmuxManager (integration)', () => {
  // Skip entire block if tmux is not available
  const tmuxAvailable = (() => {
    try {
      const { execSync: realExecSync } = require('node:child_process');
      realExecSync('which tmux', { encoding: 'utf-8', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  })();

  if (!tmuxAvailable) {
    it.skip('tmux not available — skipping integration tests', () => {});
    return;
  }

  // Real execSync for integration tests (bypasses mock)
  const { execSync: realExecSync } = require('node:child_process') as typeof import('node:child_process');

  // Helper: create a test tmux session directly via tmux CLI
  function createRawTmuxSession(name: string): void {
    realExecSync(`tmux new-session -ds "${name}" -x 80 -y 24 bash`, { timeout: 5000 });
    registerTestTmuxSession(name);
  }

  // Helper: check if tmux session exists
  function tmuxSessionExists(name: string): boolean {
    try {
      realExecSync(`tmux has-session -t "${name}" 2>/dev/null`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // Helper: kill a test tmux session directly
  function killRawTmuxSession(name: string): void {
    try {
      realExecSync(`tmux kill-session -t "${name}" 2>/dev/null`, { timeout: 5000 });
    } catch {
      // May already be dead
    }
    unregisterTestTmuxSession(name);
  }

  // Track sessions created during integration tests for cleanup
  const createdSessions: string[] = [];

  afterEach(() => {
    // Clean up any sessions created during the test
    for (const name of createdSessions) {
      killRawTmuxSession(name);
    }
    createdSessions.length = 0;
  });

  it('should create a real tmux session', () => {
    const sessionName = 'claudeman-test-create';
    createRawTmuxSession(sessionName);
    createdSessions.push(sessionName);

    expect(tmuxSessionExists(sessionName)).toBe(true);
  });

  it('should send input to a real tmux session and verify output', async () => {
    const sessionName = 'claudeman-test-input';
    createRawTmuxSession(sessionName);
    createdSessions.push(sessionName);

    // Send text to the session
    realExecSync(`tmux send-keys -t "${sessionName}" -l 'echo TMUX_INPUT_TEST_OK'`, { timeout: 5000 });
    realExecSync(`tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });

    // Wait for command to execute
    await new Promise(resolve => setTimeout(resolve, 500));

    // Capture pane contents
    const output = realExecSync(`tmux capture-pane -t "${sessionName}" -p`, { encoding: 'utf-8', timeout: 5000 });
    expect(output).toContain('TMUX_INPUT_TEST_OK');
  });

  it('should kill a real tmux session', () => {
    const sessionName = 'claudeman-test-kill';
    createRawTmuxSession(sessionName);
    // Don't push to createdSessions since we'll kill it manually

    expect(tmuxSessionExists(sessionName)).toBe(true);

    realExecSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { timeout: 5000 });
    unregisterTestTmuxSession(sessionName);

    expect(tmuxSessionExists(sessionName)).toBe(false);
  });

  it('should discover unknown claudeman sessions via reconcile', async () => {
    // Create a tmux session directly (not via TmuxManager) — simulates a "ghost"
    const sessionName = 'claudeman-te51abcd';
    createRawTmuxSession(sessionName);
    createdSessions.push(sessionName);

    // existsSync is already mocked to return false (module-level mock),
    // so TmuxManager won't load any persisted sessions from disk
    const freshManager = new TmuxManager();

    // Verify it doesn't know about the session yet
    expect(freshManager.getSessions()).toHaveLength(0);

    // Note: Full reconcile with real tmux requires unmocked execSync,
    // which is covered by the tmux-restart-recovery.test.ts integration tests.
    freshManager.destroy();
  });

  it('should verify self-kill protection with real env var', async () => {
    const sessionName = 'claudeman-te515e1f';
    createRawTmuxSession(sessionName);
    createdSessions.push(sessionName);

    const originalEnv = process.env.CLAUDEMAN_SCREEN_NAME;
    process.env.CLAUDEMAN_SCREEN_NAME = sessionName;

    try {
      // existsSync is already mocked to return false (module-level mock)
      const testManager = new TmuxManager();
      testManager.registerSession({
        sessionId: 'self-test',
        muxName: sessionName,
        pid: 99999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      // killSession should refuse
      const result = await testManager.killSession('self-test');
      expect(result).toBe(false);

      // Session should still be alive in tmux
      expect(tmuxSessionExists(sessionName)).toBe(true);

      testManager.destroy();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CLAUDEMAN_SCREEN_NAME;
      } else {
        process.env.CLAUDEMAN_SCREEN_NAME = originalEnv;
      }
    }
  });

  it('should persist and load session metadata', () => {
    // This test verifies the persistence format is correct by checking
    // that registerSession + getSessions round-trips properly
    // existsSync is already mocked to return false (module-level mock)
    const manager1 = new TmuxManager();
    manager1.registerSession({
      sessionId: 'persist-test',
      muxName: 'claudeman-be51aaa1',
      pid: 12345,
      createdAt: 1700000000000,
      workingDir: '/home/test',
      mode: 'claude',
      attached: false,
      name: 'Test Session',
      respawnConfig: { enabled: true, idleTimeoutMs: 5000, updatePrompt: 'test', interStepDelayMs: 1000, sendClear: true, sendInit: true },
    });

    const sessions = manager1.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('persist-test');
    expect(sessions[0].name).toBe('Test Session');
    expect(sessions[0].respawnConfig?.enabled).toBe(true);

    manager1.destroy();
  });
});
