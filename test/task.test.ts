/**
 * @fileoverview Tests for Task class
 *
 * Tests the Task model including lifecycle states,
 * completion detection, timeout handling, and serialization.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Task, CreateTaskOptions } from '../src/task.js';
import { TaskState } from '../src/types.js';

describe('Task', () => {
  describe('constructor', () => {
    it('should create a task with required options', () => {
      const task = new Task({ prompt: 'Test prompt' });

      expect(task.id).toBeDefined();
      expect(task.prompt).toBe('Test prompt');
      expect(task.workingDir).toBe(process.cwd());
      expect(task.priority).toBe(0);
      expect(task.dependencies).toEqual([]);
      expect(task.completionPhrase).toBeUndefined();
      expect(task.timeoutMs).toBeUndefined();
      expect(task.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('should create a task with all options', () => {
      const options: CreateTaskOptions = {
        prompt: 'Test prompt',
        workingDir: '/tmp/test',
        priority: 10,
        dependencies: ['dep-1', 'dep-2'],
        completionPhrase: 'DONE',
        timeoutMs: 30000,
      };

      const task = new Task(options);

      expect(task.prompt).toBe('Test prompt');
      expect(task.workingDir).toBe('/tmp/test');
      expect(task.priority).toBe(10);
      expect(task.dependencies).toEqual(['dep-1', 'dep-2']);
      expect(task.completionPhrase).toBe('DONE');
      expect(task.timeoutMs).toBe(30000);
    });

    it('should use provided ID if given', () => {
      const task = new Task({ prompt: 'Test' }, 'custom-id');

      expect(task.id).toBe('custom-id');
    });

    it('should generate unique IDs', () => {
      const task1 = new Task({ prompt: 'Task 1' });
      const task2 = new Task({ prompt: 'Task 2' });

      expect(task1.id).not.toBe(task2.id);
    });
  });

  describe('initial state', () => {
    it('should start in pending status', () => {
      const task = new Task({ prompt: 'Test' });

      expect(task.status).toBe('pending');
      expect(task.isPending()).toBe(true);
      expect(task.isRunning()).toBe(false);
      expect(task.isCompleted()).toBe(false);
      expect(task.isFailed()).toBe(false);
      expect(task.isDone()).toBe(false);
    });

    it('should have null for runtime properties', () => {
      const task = new Task({ prompt: 'Test' });

      expect(task.assignedSessionId).toBeNull();
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
      expect(task.output).toBe('');
      expect(task.error).toBeNull();
    });
  });

  describe('assign', () => {
    it('should assign task to a session', () => {
      const task = new Task({ prompt: 'Test' });

      task.assign('session-123');

      expect(task.status).toBe('running');
      expect(task.assignedSessionId).toBe('session-123');
      expect(task.startedAt).toBeLessThanOrEqual(Date.now());
      expect(task.isRunning()).toBe(true);
      expect(task.isPending()).toBe(false);
    });

    it('should throw if task is not pending', () => {
      const task = new Task({ prompt: 'Test' });
      task.assign('session-1');

      expect(() => task.assign('session-2')).toThrow(/Cannot assign task/);
    });
  });

  describe('appendOutput', () => {
    it('should append to output buffer', () => {
      const task = new Task({ prompt: 'Test' });

      task.appendOutput('Hello ');
      task.appendOutput('World');

      expect(task.output).toBe('Hello World');
    });
  });

  describe('setError', () => {
    it('should set error message', () => {
      const task = new Task({ prompt: 'Test' });

      task.setError('Something went wrong');

      expect(task.error).toBe('Something went wrong');
    });
  });

  describe('complete', () => {
    it('should mark task as completed', () => {
      const task = new Task({ prompt: 'Test' });
      task.assign('session-1');

      task.complete();

      expect(task.status).toBe('completed');
      expect(task.completedAt).toBeLessThanOrEqual(Date.now());
      expect(task.isCompleted()).toBe(true);
      expect(task.isDone()).toBe(true);
    });
  });

  describe('fail', () => {
    it('should mark task as failed', () => {
      const task = new Task({ prompt: 'Test' });
      task.assign('session-1');

      task.fail();

      expect(task.status).toBe('failed');
      expect(task.completedAt).toBeLessThanOrEqual(Date.now());
      expect(task.isFailed()).toBe(true);
      expect(task.isDone()).toBe(true);
    });

    it('should set error message when provided', () => {
      const task = new Task({ prompt: 'Test' });
      task.assign('session-1');

      task.fail('Connection lost');

      expect(task.error).toBe('Connection lost');
    });
  });

  describe('reset', () => {
    it('should reset task to pending state', () => {
      const task = new Task({ prompt: 'Test' });
      task.assign('session-1');
      task.appendOutput('Some output');
      task.setError('Some error');
      task.complete();

      task.reset();

      expect(task.status).toBe('pending');
      expect(task.assignedSessionId).toBeNull();
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
      expect(task.output).toBe('');
      expect(task.error).toBeNull();
    });
  });

  describe('checkCompletion', () => {
    it('should detect completion phrase in promise tags', () => {
      const task = new Task({ prompt: 'Test', completionPhrase: 'DONE' });

      expect(task.checkCompletion('Some output <promise>DONE</promise> more text')).toBe(true);
      expect(task.checkCompletion('Some output <promise>NOTDONE</promise>')).toBe(false);
      expect(task.checkCompletion('Some output DONE')).toBe(false);
    });

    it('should detect any promise tag when no completion phrase specified', () => {
      const task = new Task({ prompt: 'Test' });

      expect(task.checkCompletion('Output <promise>COMPLETE</promise>')).toBe(true);
      expect(task.checkCompletion('Output <promise>ANYTHING</promise>')).toBe(true);
      expect(task.checkCompletion('Output without promise tags')).toBe(false);
    });

    it('should not match empty promise tags', () => {
      const task = new Task({ prompt: 'Test' });

      expect(task.checkCompletion('<promise></promise>')).toBe(false);
    });
  });

  describe('isTimedOut', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return false when no timeout specified', () => {
      const task = new Task({ prompt: 'Test' });
      task.assign('session-1');

      expect(task.isTimedOut()).toBe(false);
    });

    it('should return false when not started', () => {
      const task = new Task({ prompt: 'Test', timeoutMs: 1000 });

      expect(task.isTimedOut()).toBe(false);
    });

    it('should return false before timeout', () => {
      const task = new Task({ prompt: 'Test', timeoutMs: 5000 });
      task.assign('session-1');

      vi.advanceTimersByTime(4999);

      expect(task.isTimedOut()).toBe(false);
    });

    it('should return true after timeout', () => {
      const task = new Task({ prompt: 'Test', timeoutMs: 5000 });
      task.assign('session-1');

      vi.advanceTimersByTime(5001);

      expect(task.isTimedOut()).toBe(true);
    });
  });

  describe('toDefinition', () => {
    it('should return task definition without runtime state', () => {
      const task = new Task({
        prompt: 'Test prompt',
        workingDir: '/tmp/test',
        priority: 5,
        dependencies: ['dep-1'],
        completionPhrase: 'DONE',
        timeoutMs: 10000,
      });

      const def = task.toDefinition();

      expect(def).toEqual({
        id: task.id,
        prompt: 'Test prompt',
        workingDir: '/tmp/test',
        priority: 5,
        dependencies: ['dep-1'],
        completionPhrase: 'DONE',
        timeoutMs: 10000,
      });
    });
  });

  describe('toState', () => {
    it('should return full task state', () => {
      const task = new Task({
        prompt: 'Test prompt',
        workingDir: '/tmp/test',
        priority: 5,
      });
      task.assign('session-123');
      task.appendOutput('Output text');
      task.setError('Warning');

      const state = task.toState();

      expect(state.id).toBe(task.id);
      expect(state.prompt).toBe('Test prompt');
      expect(state.workingDir).toBe('/tmp/test');
      expect(state.priority).toBe(5);
      expect(state.status).toBe('running');
      expect(state.assignedSessionId).toBe('session-123');
      expect(state.output).toBe('Output text');
      expect(state.error).toBe('Warning');
      expect(state.createdAt).toBe(task.createdAt);
      expect(state.startedAt).toBe(task.startedAt);
    });
  });

  describe('fromState', () => {
    it('should reconstruct task from state', () => {
      const originalTask = new Task({
        prompt: 'Original prompt',
        workingDir: '/original/dir',
        priority: 7,
        dependencies: ['dep-1', 'dep-2'],
        completionPhrase: 'FINISHED',
        timeoutMs: 20000,
      });
      originalTask.assign('session-xyz');
      originalTask.appendOutput('Saved output');
      originalTask.setError('Saved error');
      originalTask.complete();

      const state = originalTask.toState();
      const restoredTask = Task.fromState(state);

      expect(restoredTask.id).toBe(originalTask.id);
      expect(restoredTask.prompt).toBe(originalTask.prompt);
      expect(restoredTask.workingDir).toBe(originalTask.workingDir);
      expect(restoredTask.priority).toBe(originalTask.priority);
      expect(restoredTask.dependencies).toEqual(originalTask.dependencies);
      expect(restoredTask.completionPhrase).toBe(originalTask.completionPhrase);
      expect(restoredTask.timeoutMs).toBe(originalTask.timeoutMs);
      expect(restoredTask.status).toBe('completed');
      expect(restoredTask.assignedSessionId).toBe('session-xyz');
      expect(restoredTask.output).toBe('Saved output');
      expect(restoredTask.error).toBe('Saved error');
      expect(restoredTask.startedAt).toBe(originalTask.startedAt);
      expect(restoredTask.completedAt).toBe(originalTask.completedAt);
    });

    it('should restore all status types correctly', () => {
      const statuses = ['pending', 'running', 'completed', 'failed'] as const;

      for (const status of statuses) {
        const state: TaskState = {
          id: `task-${status}`,
          prompt: 'Test',
          workingDir: '/tmp',
          priority: 0,
          dependencies: [],
          status,
          assignedSessionId: status === 'pending' ? null : 'session-1',
          createdAt: Date.now(),
          startedAt: status === 'pending' ? null : Date.now(),
          completedAt: ['completed', 'failed'].includes(status) ? Date.now() : null,
          output: '',
          error: null,
        };

        const task = Task.fromState(state);
        expect(task.status).toBe(status);
      }
    });
  });
});
