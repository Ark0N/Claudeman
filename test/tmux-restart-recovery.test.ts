/**
 * @fileoverview Integration test for tmux session recovery after server restart.
 *
 * Tests the full restart cycle:
 * 1. Create a WebServer with real tmux backend
 * 2. Create a session (tmux)
 * 3. Stop the server (without killing tmux sessions)
 * 4. Start a new server instance
 * 5. Verify session is recovered via reconcileSessions()
 *
 * Port: 3152
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TmuxManager } from '../src/tmux-manager.js';
import { registerTestTmuxSession, unregisterTestTmuxSession } from './setup.js';

// Skip all tests if tmux is not available
const tmuxAvailable = (() => {
  try {
    execSync('which tmux', { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();

const MUX_SESSIONS_FILE = join(homedir(), '.claudeman', 'mux-sessions.json');

describe.skipIf(!tmuxAvailable)('TmuxManager restart recovery', () => {
  // Track tmux sessions for cleanup
  const createdTmuxSessions: string[] = [];
  let originalMuxSessions: string | null = null;

  beforeEach(() => {
    // Back up the current mux-sessions.json if it exists
    if (existsSync(MUX_SESSIONS_FILE)) {
      originalMuxSessions = readFileSync(MUX_SESSIONS_FILE, 'utf-8');
    }
  });

  afterEach(async () => {
    // Kill all tmux sessions created during tests
    for (const name of createdTmuxSessions) {
      try {
        execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { timeout: 5000 });
      } catch {
        // May already be dead
      }
      unregisterTestTmuxSession(name);
    }
    createdTmuxSessions.length = 0;

    // Restore original mux-sessions.json
    if (originalMuxSessions !== null) {
      writeFileSync(MUX_SESSIONS_FILE, originalMuxSessions);
    }

    // Brief wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  it('should recover a tmux session after manager restart', async () => {
    // Step 1: Create a tmux session directly (simulating a session created by old server)
    const sessionName = 'claudeman-de51ecaf';
    execSync(`tmux new-session -ds "${sessionName}" -x 80 -y 24 bash`, { timeout: 5000 });
    registerTestTmuxSession(sessionName);
    createdTmuxSessions.push(sessionName);

    // Step 2: Write session metadata to mux-sessions.json (as if old server persisted it)
    const dir = join(homedir(), '.claudeman');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const sessionData = [{
      sessionId: 'test-recovery-1',
      muxName: sessionName,
      pid: 1, // Stale PID — will be updated during reconcile
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'claude',
      attached: false,
      name: 'Recovery Test',
      respawnConfig: { enabled: true, idleTimeoutMs: 10000, updatePrompt: 'continue', interStepDelayMs: 2000, sendClear: false, sendInit: true },
    }];
    writeFileSync(MUX_SESSIONS_FILE, JSON.stringify(sessionData, null, 2));

    // Step 3: Create a new TmuxManager (simulates server restart — loads from file)
    const manager = new TmuxManager();

    // Verify session was loaded from disk
    const loaded = manager.getSession('test-recovery-1');
    expect(loaded).toBeDefined();
    expect(loaded!.muxName).toBe(sessionName);
    expect(loaded!.name).toBe('Recovery Test');
    expect(loaded!.respawnConfig?.enabled).toBe(true);

    // Step 4: Reconcile — should detect the tmux session is alive
    const result = await manager.reconcileSessions();
    expect(result.alive).toContain('test-recovery-1');
    expect(result.dead).toHaveLength(0);

    // PID should be updated to actual tmux pane PID
    const reconciled = manager.getSession('test-recovery-1');
    expect(reconciled).toBeDefined();
    expect(reconciled!.pid).toBeGreaterThan(1); // Updated from stale PID

    manager.destroy();
  });

  it('should detect dead sessions during reconcile', async () => {
    // Write metadata for a session that doesn't actually exist in tmux
    const dir = join(homedir(), '.claudeman');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const sessionData = [{
      sessionId: 'test-dead-1',
      muxName: 'claudeman-deadbeef',
      pid: 99999,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'claude',
      attached: false,
      name: 'Dead Session',
    }];
    writeFileSync(MUX_SESSIONS_FILE, JSON.stringify(sessionData, null, 2));

    const manager = new TmuxManager();

    // Verify session was loaded
    expect(manager.getSession('test-dead-1')).toBeDefined();

    // Reconcile — should detect the session is dead
    const result = await manager.reconcileSessions();
    expect(result.dead).toContain('test-dead-1');
    expect(result.alive).not.toContain('test-dead-1');

    // Session should be removed after reconcile
    expect(manager.getSession('test-dead-1')).toBeUndefined();

    manager.destroy();
  });

  it('should discover ghost sessions not in metadata', async () => {
    // Create a tmux session directly (not via TmuxManager, no metadata)
    const sessionName = 'claudeman-ab12ef34';
    execSync(`tmux new-session -ds "${sessionName}" -x 80 -y 24 bash`, { timeout: 5000 });
    registerTestTmuxSession(sessionName);
    createdTmuxSessions.push(sessionName);

    // Start with empty metadata
    const dir = join(homedir(), '.claudeman');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(MUX_SESSIONS_FILE, '[]');

    const manager = new TmuxManager();

    // No sessions loaded
    expect(manager.getSessions()).toHaveLength(0);

    // Reconcile should discover the ghost session
    const result = await manager.reconcileSessions();
    expect(result.discovered.length).toBeGreaterThanOrEqual(1);

    // Find the discovered session
    const discoveredId = result.discovered.find(id => id === 'restored-ab12ef34');
    expect(discoveredId).toBeDefined();

    // Verify the discovered session has correct metadata
    const session = manager.getSession(discoveredId!);
    expect(session).toBeDefined();
    expect(session!.muxName).toBe(sessionName);
    expect(session!.mode).toBe('claude');
    expect(session!.pid).toBeGreaterThan(0);

    manager.destroy();
  });

  it('should handle mixed alive, dead, and ghost sessions', async () => {
    // Create a real tmux session (will be "alive")
    const aliveSessionName = 'claudeman-a11eeaaa';
    execSync(`tmux new-session -ds "${aliveSessionName}" -x 80 -y 24 bash`, { timeout: 5000 });
    registerTestTmuxSession(aliveSessionName);
    createdTmuxSessions.push(aliveSessionName);

    // Create a ghost session (real tmux, no metadata)
    const ghostSessionName = 'claudeman-ab05fabf';
    execSync(`tmux new-session -ds "${ghostSessionName}" -x 80 -y 24 bash`, { timeout: 5000 });
    registerTestTmuxSession(ghostSessionName);
    createdTmuxSessions.push(ghostSessionName);

    // Write metadata with alive + dead sessions
    const dir = join(homedir(), '.claudeman');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const sessionData = [
      {
        sessionId: 'alive-session',
        muxName: aliveSessionName,
        pid: 1,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
        name: 'Alive Session',
      },
      {
        sessionId: 'dead-session',
        muxName: 'claudeman-dead0000',
        pid: 99999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
        name: 'Dead Session',
      },
    ];
    writeFileSync(MUX_SESSIONS_FILE, JSON.stringify(sessionData, null, 2));

    const manager = new TmuxManager();
    const result = await manager.reconcileSessions();

    expect(result.alive).toContain('alive-session');
    expect(result.dead).toContain('dead-session');
    expect(result.discovered).toContain('restored-ab05fabf');

    // Verify final session state
    const sessions = manager.getSessions();
    const sessionIds = sessions.map(s => s.sessionId);
    expect(sessionIds).toContain('alive-session');
    expect(sessionIds).not.toContain('dead-session');
    expect(sessionIds).toContain('restored-ab05fabf');

    manager.destroy();
  });
});
