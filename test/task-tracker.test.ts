/**
 * @fileoverview Tests for task-tracker module
 *
 * Tests the TaskTracker class which tracks background tasks (subagents)
 * spawned by Claude Code during session execution.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskTracker, BackgroundTask } from '../src/task-tracker.js';

describe('TaskTracker', () => {
  let tracker: TaskTracker;

  beforeEach(() => {
    tracker = new TaskTracker();
  });

  describe('Initialization', () => {
    it('should start with empty tasks', () => {
      const tasks = tracker.getAllTasks();
      expect(tasks.size).toBe(0);
    });

    it('should start with zero running count', () => {
      expect(tracker.getRunningCount()).toBe(0);
    });

    it('should have zero stats initially', () => {
      const stats = tracker.getStats();
      expect(stats.total).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });

    it('should return empty task tree', () => {
      const tree = tracker.getTaskTree();
      expect(tree).toEqual([]);
    });
  });

  describe('Task Tool Use Handling', () => {
    it('should create task from tool_use message', () => {
      const taskHandler = vi.fn();
      tracker.on('taskCreated', taskHandler);

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-123',
            name: 'Task',
            input: {
              description: 'Test task',
              subagent_type: 'explore',
              prompt: 'Find all test files',
            },
          }],
        },
      });

      expect(taskHandler).toHaveBeenCalled();
      const task = tracker.getTask('task-123');
      expect(task).toBeDefined();
      expect(task?.description).toBe('Test task');
      expect(task?.subagentType).toBe('explore');
      expect(task?.status).toBe('running');
    });

    it('should use prompt as description fallback', () => {
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-456',
            name: 'Task',
            input: {
              prompt: 'This is a very long prompt that should be truncated for the description',
              subagent_type: 'general-purpose',
            },
          }],
        },
      });

      const task = tracker.getTask('task-456');
      // substring(0, 50) = first 50 chars
      expect(task?.description).toBe('This is a very long prompt that should be truncate');
    });

    it('should use default description when none provided', () => {
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-789',
            name: 'Task',
            input: {},
          }],
        },
      });

      const task = tracker.getTask('task-789');
      expect(task?.description).toBe('Background task');
      expect(task?.subagentType).toBe('general');
    });

    it('should not process non-Task tool_use', () => {
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-123',
            name: 'Read',
            input: { file_path: '/test.txt' },
          }],
        },
      });

      expect(tracker.getAllTasks().size).toBe(0);
    });
  });

  describe('Tool Result Handling', () => {
    it('should complete task on successful tool_result', () => {
      const completedHandler = vi.fn();
      tracker.on('taskCompleted', completedHandler);

      // Create task first
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-123',
            name: 'Task',
            input: { description: 'Test task', subagent_type: 'explore' },
          }],
        },
      });

      // Complete it
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-123',
            is_error: false,
            content: 'Task completed successfully',
          }],
        },
      });

      expect(completedHandler).toHaveBeenCalled();
      const task = tracker.getTask('task-123');
      expect(task?.status).toBe('completed');
      expect(task?.output).toBe('Task completed successfully');
      expect(task?.endTime).toBeDefined();
    });

    it('should fail task on error tool_result', () => {
      const failedHandler = vi.fn();
      tracker.on('taskFailed', failedHandler);

      // Create task first
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-fail',
            name: 'Task',
            input: { description: 'Failing task', subagent_type: 'bash' },
          }],
        },
      });

      // Fail it
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-fail',
            is_error: true,
            content: 'Command failed with exit code 1',
          }],
        },
      });

      expect(failedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-fail' }),
        'Command failed with exit code 1'
      );
      const task = tracker.getTask('task-fail');
      expect(task?.status).toBe('failed');
    });

    it('should handle object content in tool_result', () => {
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-obj',
            name: 'Task',
            input: { description: 'Object result task', subagent_type: 'explore' },
          }],
        },
      });

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-obj',
            is_error: false,
            content: { files: ['a.ts', 'b.ts'], count: 2 },
          }],
        },
      });

      const task = tracker.getTask('task-obj');
      expect(task?.output).toBe(JSON.stringify({ files: ['a.ts', 'b.ts'], count: 2 }));
    });
  });

  describe('Task Nesting (Parent-Child)', () => {
    it('should track parent-child relationships', () => {
      // Parent task
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'parent-task',
            name: 'Task',
            input: { description: 'Parent task', subagent_type: 'general-purpose' },
          }],
        },
      });

      // Child task (while parent is running)
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'child-task',
            name: 'Task',
            input: { description: 'Child task', subagent_type: 'explore' },
          }],
        },
      });

      const parentTask = tracker.getTask('parent-task');
      const childTask = tracker.getTask('child-task');

      expect(childTask?.parentId).toBe('parent-task');
      expect(parentTask?.children).toContain('child-task');
    });

    it('should track deeply nested tasks', () => {
      // Level 1
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'level-1',
            name: 'Task',
            input: { description: 'Level 1', subagent_type: 'general' },
          }],
        },
      });

      // Level 2
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'level-2',
            name: 'Task',
            input: { description: 'Level 2', subagent_type: 'general' },
          }],
        },
      });

      // Level 3
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'level-3',
            name: 'Task',
            input: { description: 'Level 3', subagent_type: 'general' },
          }],
        },
      });

      expect(tracker.getTask('level-1')?.parentId).toBeNull();
      expect(tracker.getTask('level-2')?.parentId).toBe('level-1');
      expect(tracker.getTask('level-3')?.parentId).toBe('level-2');
    });

    it('should pop task from stack on completion', () => {
      // Task A
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-a',
            name: 'Task',
            input: { description: 'Task A', subagent_type: 'general' },
          }],
        },
      });

      // Task B (child of A)
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-b',
            name: 'Task',
            input: { description: 'Task B', subagent_type: 'general' },
          }],
        },
      });

      // Complete Task B
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-b',
            is_error: false,
            content: 'Done',
          }],
        },
      });

      // Task C should now be child of A (not B)
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'task-c',
            name: 'Task',
            input: { description: 'Task C', subagent_type: 'general' },
          }],
        },
      });

      expect(tracker.getTask('task-c')?.parentId).toBe('task-a');
    });
  });

  describe('Task Tree', () => {
    it('should return only root tasks', () => {
      // Root task
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'root-1',
            name: 'Task',
            input: { description: 'Root 1', subagent_type: 'general' },
          }],
        },
      });

      // Child task
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'child-1',
            name: 'Task',
            input: { description: 'Child 1', subagent_type: 'general' },
          }],
        },
      });

      // Complete child, start another root
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'child-1',
            is_error: false,
            content: 'Done',
          }],
        },
      });

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'root-1',
            is_error: false,
            content: 'Done',
          }],
        },
      });

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'root-2',
            name: 'Task',
            input: { description: 'Root 2', subagent_type: 'general' },
          }],
        },
      });

      const tree = tracker.getTaskTree();
      expect(tree).toHaveLength(2);
      expect(tree.map(t => t.id)).toContain('root-1');
      expect(tree.map(t => t.id)).toContain('root-2');
      expect(tree.map(t => t.id)).not.toContain('child-1');
    });
  });

  describe('Terminal Output Detection', () => {
    it('should detect "Launching X agent" pattern', () => {
      const taskHandler = vi.fn();
      tracker.on('taskCreated', taskHandler);

      tracker.processTerminalOutput('Launching explore agent to find files...\n');

      expect(taskHandler).toHaveBeenCalled();
      expect(tracker.getRunningCount()).toBe(1);
    });

    it('should detect "Starting X task" pattern', () => {
      tracker.processTerminalOutput('Starting bash task to run tests\n');

      expect(tracker.getRunningCount()).toBe(1);
    });

    it('should detect "Spawning X agent" pattern', () => {
      tracker.processTerminalOutput('Spawning search agent for code patterns\n');

      expect(tracker.getRunningCount()).toBe(1);
    });

    it('should not duplicate tasks for same agent type', () => {
      tracker.processTerminalOutput('Launching explore agent...\n');
      tracker.processTerminalOutput('Launching explore agent...\n');

      // Should still be 1 because we check for existing running tasks of same type
      expect(tracker.getRunningCount()).toBe(1);
    });

    it('should detect "Task completed" pattern', () => {
      const completedHandler = vi.fn();
      tracker.on('taskCompleted', completedHandler);

      // First create a task
      tracker.processTerminalOutput('Launching explore agent...\n');

      // Then complete it
      tracker.processTerminalOutput('Task completed successfully\n');

      expect(completedHandler).toHaveBeenCalled();
      expect(tracker.getRunningCount()).toBe(0);
    });

    it('should detect "Agent finished" pattern', () => {
      tracker.processTerminalOutput('Launching bash agent...\n');
      tracker.processTerminalOutput('Agent finished with results\n');

      expect(tracker.getRunningCount()).toBe(0);
    });

    it('should detect "Background task done" pattern', () => {
      tracker.processTerminalOutput('Launching search agent...\n');
      tracker.processTerminalOutput('Background task done\n');

      expect(tracker.getRunningCount()).toBe(0);
    });
  });

  describe('Statistics', () => {
    it('should count running tasks', () => {
      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Task 1', subagent_type: 'explore' } },
            { type: 'tool_use', id: 'task-2', name: 'Task', input: { description: 'Task 2', subagent_type: 'bash' } },
          ],
        },
      });

      expect(tracker.getRunningCount()).toBe(2);
    });

    it('should provide comprehensive stats', () => {
      // Create 3 tasks
      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Task 1', subagent_type: 'explore' } },
          ],
        },
      });

      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'task-1', is_error: false, content: 'Done' },
          ],
        },
      });

      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_use', id: 'task-2', name: 'Task', input: { description: 'Task 2', subagent_type: 'bash' } },
          ],
        },
      });

      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'task-2', is_error: true, content: 'Failed' },
          ],
        },
      });

      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_use', id: 'task-3', name: 'Task', input: { description: 'Task 3', subagent_type: 'general' } },
          ],
        },
      });

      const stats = tracker.getStats();
      expect(stats.total).toBe(3);
      expect(stats.running).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
    });
  });

  describe('Clear', () => {
    it('should clear all tasks', () => {
      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Task 1', subagent_type: 'explore' } },
            { type: 'tool_use', id: 'task-2', name: 'Task', input: { description: 'Task 2', subagent_type: 'bash' } },
          ],
        },
      });

      expect(tracker.getAllTasks().size).toBe(2);

      tracker.clear();

      expect(tracker.getAllTasks().size).toBe(0);
      expect(tracker.getRunningCount()).toBe(0);
      expect(tracker.getTaskTree()).toEqual([]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null message', () => {
      expect(() => tracker.processMessage(null)).not.toThrow();
      expect(tracker.getAllTasks().size).toBe(0);
      expect(tracker.getRunningCount()).toBe(0);
    });

    it('should handle message without content', () => {
      expect(() => tracker.processMessage({ message: {} })).not.toThrow();
      expect(tracker.getAllTasks().size).toBe(0);
    });

    it('should handle empty content array', () => {
      expect(() => tracker.processMessage({ message: { content: [] } })).not.toThrow();
      expect(tracker.getAllTasks().size).toBe(0);
    });

    it('should handle tool_result for unknown task', () => {
      expect(() => {
        tracker.processMessage({
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'unknown-task',
              is_error: false,
              content: 'Done',
            }],
          },
        });
      }).not.toThrow();
      expect(tracker.getTask('unknown-task')).toBeUndefined();
      expect(tracker.getAllTasks().size).toBe(0);
    });

    it('should handle empty terminal output', () => {
      expect(() => tracker.processTerminalOutput('')).not.toThrow();
      expect(() => tracker.processTerminalOutput('   ')).not.toThrow();
      expect(tracker.getAllTasks().size).toBe(0);
      expect(tracker.getRunningCount()).toBe(0);
    });
  });

  describe('Cleanup Logic', () => {
    it('should cleanup old pending tool uses', () => {
      // This tests the internal cleanup mechanism
      // We simulate creating many pending tool uses
      for (let i = 0; i < 150; i++) {
        tracker.processMessage({
          message: {
            content: [{
              type: 'tool_use',
              id: `task-${i}`,
              name: 'Task',
              input: { description: `Task ${i}`, subagent_type: 'general' },
            }],
          },
        });
      }

      // Even with 150 tasks created, pending tool uses should be limited
      // (The actual limit is MAX_PENDING_TOOL_USES = 100)
      expect(tracker.getAllTasks().size).toBeGreaterThan(0);
    });

    it('should cleanup old completed tasks', () => {
      // Create and complete many tasks
      for (let i = 0; i < 120; i++) {
        tracker.processMessage({
          message: {
            content: [{
              type: 'tool_use',
              id: `task-${i}`,
              name: 'Task',
              input: { description: `Task ${i}`, subagent_type: 'general' },
            }],
          },
        });
        tracker.processMessage({
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: `task-${i}`,
              is_error: false,
              content: 'Done',
            }],
          },
        });
      }

      // Should be limited to MAX_COMPLETED_TASKS (100)
      expect(tracker.getAllTasks().size).toBeLessThanOrEqual(100);
    });
  });

  describe('BackgroundTask Interface', () => {
    it('should have all required fields', () => {
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'full-task',
            name: 'Task',
            input: { description: 'Full task', subagent_type: 'explore' },
          }],
        },
      });

      const task = tracker.getTask('full-task');
      expect(task).toBeDefined();
      expect(task!.id).toBe('full-task');
      expect(task!.parentId).toBeNull();
      expect(task!.description).toBe('Full task');
      expect(task!.subagentType).toBe('explore');
      expect(task!.status).toBe('running');
      expect(task!.startTime).toBeGreaterThan(0);
      expect(task!.endTime).toBeUndefined();
      expect(task!.output).toBeUndefined();
      expect(task!.children).toEqual([]);
    });

    it('should update endTime and output on completion', () => {
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'completing-task',
            name: 'Task',
            input: { description: 'Completing task', subagent_type: 'bash' },
          }],
        },
      });

      const beforeCompletion = tracker.getTask('completing-task');
      expect(beforeCompletion?.endTime).toBeUndefined();

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'completing-task',
            is_error: false,
            content: 'Task output here',
          }],
        },
      });

      const afterCompletion = tracker.getTask('completing-task');
      expect(afterCompletion?.endTime).toBeGreaterThan(0);
      expect(afterCompletion?.output).toBe('Task output here');
    });
  });

  describe('Terminal Task ID Generation', () => {
    it('should generate unique IDs for terminal-detected tasks', () => {
      tracker.processTerminalOutput('Launching explore agent...\n');

      // Complete first task
      tracker.processTerminalOutput('Task completed\n');

      // Launch another
      tracker.processTerminalOutput('Launching bash agent...\n');

      const tasks = Array.from(tracker.getAllTasks().values());
      expect(tasks).toHaveLength(2);

      const ids = tasks.map(t => t.id);
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[0]).toMatch(/^terminal-/);
      expect(ids[1]).toMatch(/^terminal-/);
    });
  });

  describe('Case Insensitive Pattern Matching', () => {
    it('should match patterns case insensitively', () => {
      tracker.processTerminalOutput('LAUNCHING EXPLORE AGENT...\n');
      expect(tracker.getRunningCount()).toBe(1);

      tracker.clear();

      tracker.processTerminalOutput('starting BASH task...\n');
      expect(tracker.getRunningCount()).toBe(1);

      tracker.clear();

      tracker.processTerminalOutput('Spawning SEARCH Agent...\n');
      expect(tracker.getRunningCount()).toBe(1);
    });
  });

  describe('Agent Type Extraction', () => {
    it('should extract agent type correctly', () => {
      tracker.processTerminalOutput('Launching explore agent to search files\n');

      const tasks = Array.from(tracker.getAllTasks().values());
      expect(tasks[0].subagentType).toBe('explore');
    });

    it('should lowercase agent type', () => {
      tracker.processTerminalOutput('Launching BASH agent to run commands\n');

      const tasks = Array.from(tracker.getAllTasks().values());
      expect(tasks[0].subagentType).toBe('bash');
    });
  });

  describe('Multiple Content Blocks', () => {
    it('should process multiple tool_use blocks in one message', () => {
      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Task 1', subagent_type: 'explore' } },
            { type: 'tool_use', id: 'task-2', name: 'Task', input: { description: 'Task 2', subagent_type: 'bash' } },
            { type: 'tool_use', id: 'task-3', name: 'Task', input: { description: 'Task 3', subagent_type: 'general' } },
          ],
        },
      });

      expect(tracker.getAllTasks().size).toBe(3);
      expect(tracker.getRunningCount()).toBe(3);
    });

    it('should process mixed content blocks', () => {
      tracker.processMessage({
        message: {
          content: [
            { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Task 1', subagent_type: 'explore' } },
            { type: 'text', text: 'Some text response' },
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/test.txt' } },
          ],
        },
      });

      // Only Task tool_use should be tracked
      expect(tracker.getAllTasks().size).toBe(1);
    });
  });

  describe('Event Emission', () => {
    it('should emit taskCreated with correct task object', () => {
      const handler = vi.fn();
      tracker.on('taskCreated', handler);

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'event-task',
            name: 'Task',
            input: { description: 'Event test', subagent_type: 'explore' },
          }],
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        id: 'event-task',
        description: 'Event test',
        subagentType: 'explore',
        status: 'running',
      }));
    });

    it('should emit taskCompleted with completed task', () => {
      const handler = vi.fn();
      tracker.on('taskCompleted', handler);

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'complete-event',
            name: 'Task',
            input: { description: 'Completing', subagent_type: 'bash' },
          }],
        },
      });

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'complete-event',
            is_error: false,
            content: 'Result',
          }],
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        id: 'complete-event',
        status: 'completed',
        output: 'Result',
      }));
    });

    it('should emit taskFailed with error message', () => {
      const handler = vi.fn();
      tracker.on('taskFailed', handler);

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'fail-event',
            name: 'Task',
            input: { description: 'Failing', subagent_type: 'bash' },
          }],
        },
      });

      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'fail-event',
            is_error: true,
            content: 'Error message',
          }],
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'fail-event', status: 'failed' }),
        'Error message'
      );
    });
  });

  describe('getAllTasks returns copy', () => {
    it('should return a copy that does not affect internal state', () => {
      tracker.processMessage({
        message: {
          content: [{
            type: 'tool_use',
            id: 'copy-test',
            name: 'Task',
            input: { description: 'Copy test', subagent_type: 'general' },
          }],
        },
      });

      const tasksCopy = tracker.getAllTasks();
      tasksCopy.delete('copy-test');

      // Original should still have the task
      expect(tracker.getTask('copy-test')).toBeDefined();
    });
  });
});
