/**
 * @fileoverview Tests for TaskQueue
 *
 * Tests the priority queue functionality for managing tasks
 * including adding, removing, ordering, and dependency handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the state-store before importing task-queue
vi.mock('../src/state-store.js', () => ({
  getStore: vi.fn(() => ({
    getTasks: vi.fn(() => ({})),
    setTask: vi.fn(),
    removeTask: vi.fn(),
  })),
}));

// Import after mocking
import { TaskQueue, getTaskQueue } from '../src/task-queue.js';
import { Task } from '../src/task.js';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    // Create fresh queue for each test
    queue = new TaskQueue();
  });

  describe('addTask', () => {
    it('should add a task to the queue', () => {
      const task = queue.addTask({ prompt: 'Test prompt' });

      expect(task).toBeInstanceOf(Task);
      expect(task.prompt).toBe('Test prompt');
      expect(queue.getTask(task.id)).toBe(task);
    });

    it('should emit taskAdded event', () => {
      const handler = vi.fn();
      queue.on('taskAdded', handler);

      const task = queue.addTask({ prompt: 'Test prompt' });

      expect(handler).toHaveBeenCalledWith(task);
    });

    it('should accept optional parameters', () => {
      const task = queue.addTask({
        prompt: 'Test prompt',
        workingDir: '/tmp/test',
        priority: 5,
        dependencies: ['dep-1', 'dep-2'],
        completionPhrase: 'DONE',
        timeoutMs: 30000,
      });

      expect(task.prompt).toBe('Test prompt');
      expect(task.workingDir).toBe('/tmp/test');
      expect(task.priority).toBe(5);
      expect(task.dependencies).toEqual(['dep-1', 'dep-2']);
      expect(task.completionPhrase).toBe('DONE');
      expect(task.timeoutMs).toBe(30000);
    });
  });

  describe('getTask', () => {
    it('should return undefined for non-existent task', () => {
      expect(queue.getTask('non-existent')).toBeUndefined();
    });

    it('should return the correct task by ID', () => {
      const task1 = queue.addTask({ prompt: 'Task 1' });
      const task2 = queue.addTask({ prompt: 'Task 2' });

      expect(queue.getTask(task1.id)).toBe(task1);
      expect(queue.getTask(task2.id)).toBe(task2);
    });
  });

  describe('removeTask', () => {
    it('should remove a task from the queue', () => {
      const task = queue.addTask({ prompt: 'Test prompt' });

      const removed = queue.removeTask(task.id);

      expect(removed).toBe(true);
      expect(queue.getTask(task.id)).toBeUndefined();
    });

    it('should return false for non-existent task', () => {
      expect(queue.removeTask('non-existent')).toBe(false);
    });

    it('should emit taskRemoved event', () => {
      const handler = vi.fn();
      queue.on('taskRemoved', handler);

      const task = queue.addTask({ prompt: 'Test prompt' });
      queue.removeTask(task.id);

      expect(handler).toHaveBeenCalledWith(task.id);
    });
  });

  describe('updateTask', () => {
    it('should update a task and emit event', () => {
      const handler = vi.fn();
      queue.on('taskUpdated', handler);

      const task = queue.addTask({ prompt: 'Test prompt' });
      task.assign('session-1');
      queue.updateTask(task);

      expect(handler).toHaveBeenCalledWith(task);
      expect(queue.getTask(task.id)?.status).toBe('running');
    });
  });

  describe('getAllTasks', () => {
    it('should return empty array when no tasks', () => {
      expect(queue.getAllTasks()).toEqual([]);
    });

    it('should return all tasks', () => {
      const task1 = queue.addTask({ prompt: 'Task 1' });
      const task2 = queue.addTask({ prompt: 'Task 2' });
      const task3 = queue.addTask({ prompt: 'Task 3' });

      const tasks = queue.getAllTasks();

      expect(tasks).toHaveLength(3);
      expect(tasks).toContain(task1);
      expect(tasks).toContain(task2);
      expect(tasks).toContain(task3);
    });
  });

  describe('getPendingTasks', () => {
    it('should return only pending tasks', () => {
      const task1 = queue.addTask({ prompt: 'Task 1' });
      const task2 = queue.addTask({ prompt: 'Task 2' });
      task2.assign('session-1');

      const pending = queue.getPendingTasks();

      expect(pending).toHaveLength(1);
      expect(pending[0]).toBe(task1);
    });

    it('should sort by priority (higher first)', () => {
      const lowPriority = queue.addTask({ prompt: 'Low', priority: 1 });
      const highPriority = queue.addTask({ prompt: 'High', priority: 10 });
      const medPriority = queue.addTask({ prompt: 'Med', priority: 5 });

      const pending = queue.getPendingTasks();

      expect(pending[0]).toBe(highPriority);
      expect(pending[1]).toBe(medPriority);
      expect(pending[2]).toBe(lowPriority);
    });

    it('should sort by creation time when priority is equal', async () => {
      const first = queue.addTask({ prompt: 'First', priority: 5 });
      // Small delay to ensure different createdAt
      await new Promise((r) => setTimeout(r, 10));
      const second = queue.addTask({ prompt: 'Second', priority: 5 });

      const pending = queue.getPendingTasks();

      expect(pending[0]).toBe(first);
      expect(pending[1]).toBe(second);
    });
  });

  describe('getRunningTasks', () => {
    it('should return only running tasks', () => {
      const task1 = queue.addTask({ prompt: 'Task 1' });
      const task2 = queue.addTask({ prompt: 'Task 2' });
      task1.assign('session-1');

      const running = queue.getRunningTasks();

      expect(running).toHaveLength(1);
      expect(running[0]).toBe(task1);
    });
  });

  describe('getCompletedTasks', () => {
    it('should return only completed tasks', () => {
      const task1 = queue.addTask({ prompt: 'Task 1' });
      const task2 = queue.addTask({ prompt: 'Task 2' });
      task1.assign('session-1');
      task1.complete();

      const completed = queue.getCompletedTasks();

      expect(completed).toHaveLength(1);
      expect(completed[0]).toBe(task1);
    });
  });

  describe('getFailedTasks', () => {
    it('should return only failed tasks', () => {
      const task1 = queue.addTask({ prompt: 'Task 1' });
      const task2 = queue.addTask({ prompt: 'Task 2' });
      task1.assign('session-1');
      task1.fail('Some error');

      const failed = queue.getFailedTasks();

      expect(failed).toHaveLength(1);
      expect(failed[0]).toBe(task1);
    });
  });

  describe('hasNext and next', () => {
    it('should return false/null when no pending tasks', () => {
      expect(queue.hasNext()).toBe(false);
      expect(queue.next()).toBeNull();
    });

    it('should return true/task when pending tasks exist', () => {
      const task = queue.addTask({ prompt: 'Test' });

      expect(queue.hasNext()).toBe(true);
      expect(queue.next()).toBe(task);
    });

    it('should respect dependencies', () => {
      const dep = queue.addTask({ prompt: 'Dependency' });
      const dependent = queue.addTask({
        prompt: 'Dependent',
        dependencies: [dep.id],
      });

      // Should return dep first, not dependent
      expect(queue.next()).toBe(dep);

      // Complete the dependency
      dep.assign('session-1');
      dep.complete();
      queue.updateTask(dep);

      // Now dependent should be available
      expect(queue.next()).toBe(dependent);
    });

    it('should skip tasks with unsatisfied dependencies', () => {
      // Create dependency first but assign it so it's not pending
      const dep = queue.addTask({ prompt: 'Dependency' });
      dep.assign('session-1'); // Make it running, not pending

      const dependent = queue.addTask({
        prompt: 'Dependent',
        dependencies: [dep.id],
        priority: 100, // Higher priority but blocked
      });
      const independent = queue.addTask({ prompt: 'Independent', priority: 1 });

      // Should return independent even though dependent has higher priority
      // because dependent is blocked by unsatisfied dependency (dep is running, not completed)
      const next = queue.next();
      expect(next?.prompt).toBe('Independent');
    });
  });

  describe('getTasksBySession', () => {
    it('should return tasks assigned to a specific session', () => {
      const task1 = queue.addTask({ prompt: 'Task 1' });
      const task2 = queue.addTask({ prompt: 'Task 2' });
      const task3 = queue.addTask({ prompt: 'Task 3' });

      task1.assign('session-1');
      task2.assign('session-2');
      task3.assign('session-1');

      const session1Tasks = queue.getTasksBySession('session-1');

      expect(session1Tasks).toHaveLength(2);
      expect(session1Tasks).toContain(task1);
      expect(session1Tasks).toContain(task3);
    });
  });

  describe('getRunningTaskForSession', () => {
    it('should return the running task for a session', () => {
      const task1 = queue.addTask({ prompt: 'Task 1' });
      const task2 = queue.addTask({ prompt: 'Task 2' });

      task1.assign('session-1');
      task2.assign('session-2');

      expect(queue.getRunningTaskForSession('session-1')).toBe(task1);
      expect(queue.getRunningTaskForSession('session-2')).toBe(task2);
    });

    it('should return null if no running task for session', () => {
      expect(queue.getRunningTaskForSession('session-1')).toBeNull();
    });
  });

  describe('getCount', () => {
    it('should return correct counts', () => {
      const task1 = queue.addTask({ prompt: 'Pending' });
      const task2 = queue.addTask({ prompt: 'Running' });
      const task3 = queue.addTask({ prompt: 'Completed' });
      const task4 = queue.addTask({ prompt: 'Failed' });

      task2.assign('session-1');
      task3.assign('session-2');
      task3.complete();
      task4.assign('session-3');
      task4.fail('Error');

      const counts = queue.getCount();

      expect(counts.total).toBe(4);
      expect(counts.pending).toBe(1);
      expect(counts.running).toBe(1);
      expect(counts.completed).toBe(1);
      expect(counts.failed).toBe(1);
    });
  });

  describe('clearCompleted', () => {
    it('should remove all completed tasks', () => {
      const task1 = queue.addTask({ prompt: 'Completed 1' });
      const task2 = queue.addTask({ prompt: 'Completed 2' });
      const task3 = queue.addTask({ prompt: 'Pending' });

      task1.assign('session-1');
      task1.complete();
      task2.assign('session-2');
      task2.complete();

      const removed = queue.clearCompleted();

      expect(removed).toBe(2);
      expect(queue.getAllTasks()).toHaveLength(1);
      expect(queue.getTask(task3.id)).toBe(task3);
    });
  });

  describe('clearFailed', () => {
    it('should remove all failed tasks', () => {
      const task1 = queue.addTask({ prompt: 'Failed 1' });
      const task2 = queue.addTask({ prompt: 'Failed 2' });
      const task3 = queue.addTask({ prompt: 'Pending' });

      task1.assign('session-1');
      task1.fail('Error 1');
      task2.assign('session-2');
      task2.fail('Error 2');

      const removed = queue.clearFailed();

      expect(removed).toBe(2);
      expect(queue.getAllTasks()).toHaveLength(1);
      expect(queue.getTask(task3.id)).toBe(task3);
    });
  });

  describe('clearAll', () => {
    it('should remove all tasks', () => {
      queue.addTask({ prompt: 'Task 1' });
      queue.addTask({ prompt: 'Task 2' });
      queue.addTask({ prompt: 'Task 3' });

      const removed = queue.clearAll();

      expect(removed).toBe(3);
      expect(queue.getAllTasks()).toHaveLength(0);
    });
  });
});

describe('circular dependency detection', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  it('should throw error for direct cycle (A depends on B, B depends on A)', () => {
    // Create Task A that depends on task-b (which will be created next)
    const taskA = Task.fromState({
      id: 'task-a',
      prompt: 'Task A',
      workingDir: '/tmp',
      priority: 0,
      dependencies: ['task-b'], // A depends on B
      status: 'pending',
      assignedSessionId: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      output: '',
      error: null,
    });

    // Create Task B that depends on task-a
    const taskB = Task.fromState({
      id: 'task-b',
      prompt: 'Task B',
      workingDir: '/tmp',
      priority: 0,
      dependencies: ['task-a'], // B depends on A - this creates a cycle!
      status: 'pending',
      assignedSessionId: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      output: '',
      error: null,
    });

    // Manually add task A to the queue
    // @ts-expect-error - accessing private property for testing
    queue.tasks.set('task-a', taskA);

    // Now try to add task B - since B depends on A, and A depends on B,
    // we need to check validateDependencies manually since addTask generates new IDs
    // Let's directly test the wouldCreateCycle method

    // Add task B too
    // @ts-expect-error - accessing private property for testing
    queue.tasks.set('task-b', taskB);

    // Now the graph has a cycle: A -> B -> A
    // Test that if we try to add a task C that depends on A,
    // the cycle through B -> A -> B would be detected if we were A
    // Actually, this tests that the existing cycle causes issues for new tasks

    // The real test: check wouldCreateCycle directly
    // @ts-expect-error - accessing private method for testing
    const hasCycle = queue.wouldCreateCycle('task-a', 'task-b');
    expect(hasCycle).toBe(true);

    // @ts-expect-error - accessing private method for testing
    const hasCycleReverse = queue.wouldCreateCycle('task-b', 'task-a');
    expect(hasCycleReverse).toBe(true);
  });

  it('should throw error for indirect cycle (A -> B -> C -> A)', () => {
    // Create the chain where A -> B -> C -> A
    // A depends on B, B depends on C, C depends on A (completing the cycle)

    const taskA = Task.fromState({
      id: 'task-a',
      prompt: 'Task A',
      workingDir: '/tmp',
      priority: 0,
      dependencies: ['task-b'], // A depends on B
      status: 'pending',
      assignedSessionId: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      output: '',
      error: null,
    });

    const taskB = Task.fromState({
      id: 'task-b',
      prompt: 'Task B',
      workingDir: '/tmp',
      priority: 0,
      dependencies: ['task-c'], // B depends on C
      status: 'pending',
      assignedSessionId: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      output: '',
      error: null,
    });

    const taskC = Task.fromState({
      id: 'task-c',
      prompt: 'Task C',
      workingDir: '/tmp',
      priority: 0,
      dependencies: ['task-a'], // C depends on A - completes the cycle!
      status: 'pending',
      assignedSessionId: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      output: '',
      error: null,
    });

    // @ts-expect-error - accessing private property for testing
    queue.tasks.set('task-a', taskA);
    // @ts-expect-error - accessing private property for testing
    queue.tasks.set('task-b', taskB);
    // @ts-expect-error - accessing private property for testing
    queue.tasks.set('task-c', taskC);

    // Test the cycle detection: A -> B -> C -> A
    // @ts-expect-error - accessing private method for testing
    expect(queue.wouldCreateCycle('task-a', 'task-b')).toBe(true);
    // @ts-expect-error - accessing private method for testing
    expect(queue.wouldCreateCycle('task-b', 'task-c')).toBe(true);
    // @ts-expect-error - accessing private method for testing
    expect(queue.wouldCreateCycle('task-c', 'task-a')).toBe(true);
  });

  it('should allow valid dependency chains without cycles', () => {
    // Linear chain: A -> B -> C (C depends on B, B depends on A)
    const taskA = queue.addTask({ prompt: 'Task A' });
    const taskB = queue.addTask({ prompt: 'Task B', dependencies: [taskA.id] });
    const taskC = queue.addTask({ prompt: 'Task C', dependencies: [taskB.id] });

    expect(queue.getAllTasks()).toHaveLength(3);

    // Diamond pattern: D depends on both E and F, E and F both depend on G
    const taskG = queue.addTask({ prompt: 'Task G' });
    const taskE = queue.addTask({ prompt: 'Task E', dependencies: [taskG.id] });
    const taskF = queue.addTask({ prompt: 'Task F', dependencies: [taskG.id] });
    const taskD = queue.addTask({ prompt: 'Task D', dependencies: [taskE.id, taskF.id] });

    expect(queue.getAllTasks()).toHaveLength(7);
  });

  it('should handle multiple dependencies without cycles', () => {
    const task1 = queue.addTask({ prompt: 'Task 1' });
    const task2 = queue.addTask({ prompt: 'Task 2' });
    const task3 = queue.addTask({ prompt: 'Task 3', dependencies: [task1.id, task2.id] });

    // task3 depends on both task1 and task2 - no cycle
    expect(queue.getTask(task3.id)?.dependencies).toEqual([task1.id, task2.id]);
  });

  it('should allow dependencies on non-existent tasks (just unsatisfied, not a cycle)', () => {
    // Dependencies on non-existent tasks are valid - they just won't be satisfied
    const task = queue.addTask({ prompt: 'Task D', dependencies: ['non-existent-id'] });
    expect(queue.getAllTasks()).toHaveLength(1);
    expect(task.dependencies).toEqual(['non-existent-id']);
    // Task is blocked by unsatisfied dependency, so next() should return null
    expect(queue.next()).toBeNull();
  });

  it('should detect self-dependency when task references itself', () => {
    // Manually create a task that depends on its own ID
    const selfDepTask = Task.fromState({
      id: 'self-ref-task',
      prompt: 'Self-referencing task',
      workingDir: '/tmp',
      priority: 0,
      dependencies: ['self-ref-task'], // Depends on itself
      status: 'pending',
      assignedSessionId: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      output: '',
      error: null,
    });

    // Add to queue manually
    // @ts-expect-error - accessing private property for testing
    queue.tasks.set('self-ref-task', selfDepTask);

    // Test that the self-reference is detected
    // @ts-expect-error - accessing private method for testing
    expect(queue.wouldCreateCycle('self-ref-task', 'self-ref-task')).toBe(true);

    // Also test that validateDependencies catches it
    expect(() => {
      // @ts-expect-error - accessing private method for testing
      queue.validateDependencies('self-ref-task', ['self-ref-task']);
    }).toThrow(/Circular dependency detected/);
  });

  it('should handle complex valid DAG (directed acyclic graph)', () => {
    // Build a complex but valid dependency graph:
    //       A
    //      / \
    //     B   C
    //    /|   |\
    //   D E   F G
    //    \|   |/
    //     H   I
    //      \ /
    //       J

    const A = queue.addTask({ prompt: 'A' });
    const B = queue.addTask({ prompt: 'B', dependencies: [A.id] });
    const C = queue.addTask({ prompt: 'C', dependencies: [A.id] });
    const D = queue.addTask({ prompt: 'D', dependencies: [B.id] });
    const E = queue.addTask({ prompt: 'E', dependencies: [B.id] });
    const F = queue.addTask({ prompt: 'F', dependencies: [C.id] });
    const G = queue.addTask({ prompt: 'G', dependencies: [C.id] });
    const H = queue.addTask({ prompt: 'H', dependencies: [D.id, E.id] });
    const I = queue.addTask({ prompt: 'I', dependencies: [F.id, G.id] });
    const J = queue.addTask({ prompt: 'J', dependencies: [H.id, I.id] });

    expect(queue.getAllTasks()).toHaveLength(10);
    expect(queue.getTask(J.id)?.dependencies).toEqual([H.id, I.id]);
  });
});

describe('getTaskQueue singleton', () => {
  it('should return a TaskQueue instance', () => {
    const queue = getTaskQueue();
    expect(queue).toBeInstanceOf(TaskQueue);
  });
});
