import { EventEmitter } from 'node:events';
import { Task, CreateTaskOptions } from './task.js';
import { getStore } from './state-store.js';
import { TaskState } from './types.js';

export interface TaskQueueEvents {
  taskAdded: (task: Task) => void;
  taskRemoved: (taskId: string) => void;
  taskUpdated: (task: Task) => void;
}

export class TaskQueue extends EventEmitter {
  private tasks: Map<string, Task> = new Map();
  private store = getStore();

  constructor() {
    super();
    this.loadFromStore();
  }

  private loadFromStore(): void {
    const storedTasks = this.store.getTasks();
    for (const [id, state] of Object.entries(storedTasks)) {
      const task = Task.fromState(state);
      this.tasks.set(id, task);
    }
  }

  addTask(options: CreateTaskOptions): Task {
    const task = new Task(options);
    this.tasks.set(task.id, task);
    this.store.setTask(task.id, task.toState());
    this.emit('taskAdded', task);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  removeTask(id: string): boolean {
    const removed = this.tasks.delete(id);
    if (removed) {
      this.store.removeTask(id);
      this.emit('taskRemoved', id);
    }
    return removed;
  }

  updateTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.store.setTask(task.id, task.toState());
    this.emit('taskUpdated', task);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getPendingTasks(): Task[] {
    return this.getAllTasks()
      .filter((t) => t.isPending())
      .sort((a, b) => {
        // Sort by priority (higher first), then by creation time (older first)
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      });
  }

  getRunningTasks(): Task[] {
    return this.getAllTasks().filter((t) => t.isRunning());
  }

  getCompletedTasks(): Task[] {
    return this.getAllTasks().filter((t) => t.isCompleted());
  }

  getFailedTasks(): Task[] {
    return this.getAllTasks().filter((t) => t.isFailed());
  }

  hasNext(): boolean {
    return this.getNextAvailable() !== null;
  }

  getNextAvailable(): Task | null {
    const pending = this.getPendingTasks();

    for (const task of pending) {
      if (this.areDependenciesSatisfied(task)) {
        return task;
      }
    }

    return null;
  }

  next(): Task | null {
    return this.getNextAvailable();
  }

  private areDependenciesSatisfied(task: Task): boolean {
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || !dep.isCompleted()) {
        return false;
      }
    }
    return true;
  }

  getTasksBySession(sessionId: string): Task[] {
    return this.getAllTasks().filter((t) => t.assignedSessionId === sessionId);
  }

  getRunningTaskForSession(sessionId: string): Task | null {
    return this.getAllTasks().find(
      (t) => t.isRunning() && t.assignedSessionId === sessionId
    ) || null;
  }

  getCount(): { total: number; pending: number; running: number; completed: number; failed: number } {
    const tasks = this.getAllTasks();
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.isPending()).length,
      running: tasks.filter((t) => t.isRunning()).length,
      completed: tasks.filter((t) => t.isCompleted()).length,
      failed: tasks.filter((t) => t.isFailed()).length,
    };
  }

  clearCompleted(): number {
    let count = 0;
    for (const task of this.getAllTasks()) {
      if (task.isCompleted()) {
        this.removeTask(task.id);
        count++;
      }
    }
    return count;
  }

  clearFailed(): number {
    let count = 0;
    for (const task of this.getAllTasks()) {
      if (task.isFailed()) {
        this.removeTask(task.id);
        count++;
      }
    }
    return count;
  }

  clearAll(): number {
    const count = this.tasks.size;
    for (const id of this.tasks.keys()) {
      this.store.removeTask(id);
    }
    this.tasks.clear();
    return count;
  }

  getStoredTasks(): Record<string, TaskState> {
    return this.store.getTasks();
  }
}

// Singleton instance
let queueInstance: TaskQueue | null = null;

export function getTaskQueue(): TaskQueue {
  if (!queueInstance) {
    queueInstance = new TaskQueue();
  }
  return queueInstance;
}
