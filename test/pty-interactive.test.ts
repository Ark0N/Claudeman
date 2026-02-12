/**
 * @fileoverview Unit tests for Session state management
 *
 * Tests Session object lifecycle, state transitions, and buffer management.
 * SAFETY: No real Claude CLI processes are spawned. Tests verify in-memory
 * state transitions and API contracts only.
 *
 * Port: N/A (no server or real processes needed)
 */

import { describe, it, expect } from 'vitest';
import { Session } from '../src/session.js';

describe('Session State Management', () => {
  const testDir = '/tmp';

  it('should start in idle state', () => {
    const session = new Session({ workingDir: testDir });
    expect(session.status).toBe('idle');
    expect(session.isIdle()).toBe(true);
    expect(session.isBusy()).toBe(false);
  });

  it('should provide state snapshots', () => {
    const session = new Session({ workingDir: testDir });

    const state = session.toState();
    expect(state).toHaveProperty('id');
    expect(state).toHaveProperty('pid');
    expect(state).toHaveProperty('status');
    expect(state).toHaveProperty('workingDir');
    expect(state).toHaveProperty('createdAt');
    expect(state).toHaveProperty('lastActivityAt');

    const detailedState = session.toDetailedState();
    expect(detailedState).toHaveProperty('totalCost');
    expect(detailedState).toHaveProperty('textOutput');
    expect(detailedState).toHaveProperty('terminalBuffer');
    expect(detailedState).toHaveProperty('messageCount');
  });

  it('should have empty buffers initially', () => {
    const session = new Session({ workingDir: testDir });
    expect(session.terminalBuffer).toBe('');
    expect(session.textOutput).toBe('');
    expect(session.errorBuffer).toBe('');
  });

  it('should clear buffers', () => {
    const session = new Session({ workingDir: testDir });
    session.clearBuffers();
    expect(session.terminalBuffer).toBe('');
    expect(session.textOutput).toBe('');
    expect(session.errorBuffer).toBe('');
  });

  it('should track working directory', () => {
    const session = new Session({ workingDir: '/home/test/project' });
    expect(session.workingDir).toBe('/home/test/project');
  });

  it('should generate unique session IDs', () => {
    const session1 = new Session({ workingDir: testDir });
    const session2 = new Session({ workingDir: testDir });
    expect(session1.id).not.toBe(session2.id);
  });

  it('should accept custom session names', () => {
    const session = new Session({ workingDir: testDir, name: 'My Session' });
    expect(session.name).toBe('My Session');
  });

  it('should use specified mode', () => {
    const claudeSession = new Session({ workingDir: testDir, mode: 'claude' });
    expect(claudeSession.mode).toBe('claude');

    const shellSession = new Session({ workingDir: testDir, mode: 'shell' });
    expect(shellSession.mode).toBe('shell');
  });
});
