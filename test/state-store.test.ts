/**
 * @fileoverview Tests for StateStore
 *
 * Tests the persistent JSON state storage including
 * debounced saves, state CRUD operations, and inner state management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import types before mocking
import type { AppState, SessionState, TaskState, InnerSessionState } from '../src/types.js';

// We need to import without mocking to test the actual implementation
import { StateStore, getStore } from '../src/state-store.js';

describe('StateStore', () => {
  const testDir = join(tmpdir(), 'claudeman-test-' + Date.now());
  const testFilePath = join(testDir, 'state.json');
  const testInnerPath = join(testDir, 'state-inner.json');

  beforeEach(() => {
    // Create test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // Clean up any existing test files
    try {
      if (existsSync(testFilePath)) unlinkSync(testFilePath);
      if (existsSync(testInnerPath)) unlinkSync(testInnerPath);
    } catch (e) {
      // Ignore cleanup errors
    }

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();

    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create initial state when no file exists', () => {
      const store = new StateStore(testFilePath);

      const state = store.getState();
      expect(state).toBeDefined();
      expect(state.sessions).toBeDefined();
      expect(state.tasks).toBeDefined();
      expect(state.config).toBeDefined();
    });

    it('should set state file path in config', () => {
      const store = new StateStore(testFilePath);

      expect(store.getConfig().stateFilePath).toBe(testFilePath);
    });
  });

  describe('save and saveNow', () => {
    it('should debounce saves by default', () => {
      const store = new StateStore(testFilePath);

      store.setSession('test-1', createMockSessionState('test-1'));
      store.setSession('test-2', createMockSessionState('test-2'));

      // File should not exist yet (debounced)
      expect(existsSync(testFilePath)).toBe(false);

      // Advance past debounce time
      vi.advanceTimersByTime(600);

      // Now file should exist
      expect(existsSync(testFilePath)).toBe(true);
    });

    it('should write immediately with saveNow', () => {
      const store = new StateStore(testFilePath);

      store.setSession('test-1', createMockSessionState('test-1'));
      store.saveNow();

      expect(existsSync(testFilePath)).toBe(true);
    });

    it('should flush pending saves', () => {
      const store = new StateStore(testFilePath);

      store.setSession('test-1', createMockSessionState('test-1'));
      store.flush();

      expect(existsSync(testFilePath)).toBe(true);
    });
  });

  describe('session operations', () => {
    it('should set and get sessions', () => {
      const store = new StateStore(testFilePath);
      const sessionState = createMockSessionState('session-1');

      store.setSession('session-1', sessionState);

      expect(store.getSession('session-1')).toEqual(sessionState);
    });

    it('should return null for non-existent session', () => {
      const store = new StateStore(testFilePath);

      expect(store.getSession('non-existent')).toBeNull();
    });

    it('should remove sessions', () => {
      const store = new StateStore(testFilePath);
      store.setSession('session-1', createMockSessionState('session-1'));

      store.removeSession('session-1');

      expect(store.getSession('session-1')).toBeNull();
    });

    it('should get all sessions', () => {
      const store = new StateStore(testFilePath);
      store.setSession('session-1', createMockSessionState('session-1'));
      store.setSession('session-2', createMockSessionState('session-2'));

      const sessions = store.getSessions();

      expect(Object.keys(sessions)).toHaveLength(2);
      expect(sessions['session-1']).toBeDefined();
      expect(sessions['session-2']).toBeDefined();
    });
  });

  describe('task operations', () => {
    it('should set and get tasks', () => {
      const store = new StateStore(testFilePath);
      const taskState = createMockTaskState('task-1');

      store.setTask('task-1', taskState);

      expect(store.getTask('task-1')).toEqual(taskState);
    });

    it('should return null for non-existent task', () => {
      const store = new StateStore(testFilePath);

      expect(store.getTask('non-existent')).toBeNull();
    });

    it('should remove tasks', () => {
      const store = new StateStore(testFilePath);
      store.setTask('task-1', createMockTaskState('task-1'));

      store.removeTask('task-1');

      expect(store.getTask('task-1')).toBeNull();
    });

    it('should get all tasks', () => {
      const store = new StateStore(testFilePath);
      store.setTask('task-1', createMockTaskState('task-1'));
      store.setTask('task-2', createMockTaskState('task-2'));

      const tasks = store.getTasks();

      expect(Object.keys(tasks)).toHaveLength(2);
    });
  });

  describe('Ralph Loop state', () => {
    it('should get and set Ralph Loop state', () => {
      const store = new StateStore(testFilePath);

      store.setRalphLoopState({ status: 'running', startedAt: 12345 });

      const state = store.getRalphLoopState();
      expect(state.status).toBe('running');
      expect(state.startedAt).toBe(12345);
    });

    it('should merge partial updates', () => {
      const store = new StateStore(testFilePath);

      store.setRalphLoopState({ status: 'running' });
      store.setRalphLoopState({ tasksCompleted: 5 });

      const state = store.getRalphLoopState();
      expect(state.status).toBe('running');
      expect(state.tasksCompleted).toBe(5);
    });
  });

  describe('config operations', () => {
    it('should get and set config', () => {
      const store = new StateStore(testFilePath);

      store.setConfig({ maxConcurrentSessions: 10 });

      expect(store.getConfig().maxConcurrentSessions).toBe(10);
    });

    it('should merge partial updates', () => {
      const store = new StateStore(testFilePath);
      const originalPollInterval = store.getConfig().pollIntervalMs;

      store.setConfig({ maxConcurrentSessions: 10 });

      expect(store.getConfig().maxConcurrentSessions).toBe(10);
      expect(store.getConfig().pollIntervalMs).toBe(originalPollInterval);
    });
  });

  describe('reset', () => {
    it('should reset state to initial values', () => {
      const store = new StateStore(testFilePath);

      store.setSession('session-1', createMockSessionState('session-1'));
      store.setTask('task-1', createMockTaskState('task-1'));

      store.reset();

      expect(store.getSession('session-1')).toBeNull();
      expect(store.getTask('task-1')).toBeNull();
      expect(store.getAllInnerStates().size).toBe(0);
    });

    it('should preserve state file path in config', () => {
      const store = new StateStore(testFilePath);

      store.reset();

      expect(store.getConfig().stateFilePath).toBe(testFilePath);
    });
  });

  describe('inner state operations', () => {
    it('should get and set inner state', () => {
      const store = new StateStore(testFilePath);
      const innerState = createMockInnerState('session-1');

      store.setInnerState('session-1', innerState);

      expect(store.getInnerState('session-1')).toEqual(innerState);
    });

    it('should return null for non-existent inner state', () => {
      const store = new StateStore(testFilePath);

      expect(store.getInnerState('non-existent')).toBeNull();
    });

    it('should update inner state with partial merge', () => {
      const store = new StateStore(testFilePath);

      store.setInnerState('session-1', createMockInnerState('session-1'));
      const updated = store.updateInnerState('session-1', { totalTodos: 10 });

      expect(updated.totalTodos).toBe(10);
      expect(updated.sessionId).toBe('session-1');
    });

    it('should create initial state on update if none exists', () => {
      const store = new StateStore(testFilePath);

      const state = store.updateInnerState('new-session', { totalTodos: 5 });

      expect(state.sessionId).toBe('new-session');
      expect(state.totalTodos).toBe(5);
    });

    it('should remove inner state', () => {
      const store = new StateStore(testFilePath);
      store.setInnerState('session-1', createMockInnerState('session-1'));

      store.removeInnerState('session-1');

      expect(store.getInnerState('session-1')).toBeNull();
    });

    it('should get all inner states', () => {
      const store = new StateStore(testFilePath);
      store.setInnerState('session-1', createMockInnerState('session-1'));
      store.setInnerState('session-2', createMockInnerState('session-2'));

      const allStates = store.getAllInnerStates();

      expect(allStates.size).toBe(2);
      expect(allStates.has('session-1')).toBe(true);
      expect(allStates.has('session-2')).toBe(true);
    });
  });

  describe('flushAll', () => {
    it('should flush both main and inner state', () => {
      const store = new StateStore(testFilePath);

      store.setSession('session-1', createMockSessionState('session-1'));
      store.setInnerState('session-1', createMockInnerState('session-1'));

      store.flushAll();

      expect(existsSync(testFilePath)).toBe(true);
      expect(existsSync(testInnerPath)).toBe(true);
    });
  });

  describe('persistence', () => {
    it('should persist and restore state across instances', () => {
      // Create and save state
      const store1 = new StateStore(testFilePath);
      store1.setSession('session-1', createMockSessionState('session-1'));
      store1.setTask('task-1', createMockTaskState('task-1'));
      store1.setInnerState('session-1', createMockInnerState('session-1'));
      store1.flushAll();

      // Create new instance and verify state is loaded
      const store2 = new StateStore(testFilePath);

      expect(store2.getSession('session-1')).toBeDefined();
      expect(store2.getTask('task-1')).toBeDefined();
      expect(store2.getInnerState('session-1')).toBeDefined();
    });
  });
});

// Helper functions to create mock state objects
function createMockSessionState(id: string): SessionState {
  return {
    id,
    workingDir: '/tmp/test',
    status: 'running',
    pid: 12345,
    createdAt: Date.now(),
    caseName: 'test-case',
    mode: 'claude',
  };
}

function createMockTaskState(id: string): TaskState {
  return {
    id,
    prompt: 'Test prompt',
    workingDir: '/tmp/test',
    priority: 0,
    dependencies: [],
    status: 'pending',
    assignedSessionId: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    output: '',
    error: null,
  };
}

function createMockInnerState(sessionId: string): InnerSessionState {
  return {
    sessionId,
    enabled: true,
    loopActive: false,
    totalTodos: 0,
    completedTodos: 0,
    completionPhrase: null,
    expectedPhrase: null,
    todoItems: [],
    lastUpdated: Date.now(),
    messageId: null,
  };
}
