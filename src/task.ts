/**
 * @fileoverview Task model for Claude prompt execution
 *
 * Represents a single task (prompt) to be executed by a Claude session.
 * Tasks support priority ordering, dependencies, and completion detection.
 *
 * @module task
 */

import { v4 as uuidv4 } from 'uuid';
import { TaskDefinition, TaskState, TaskStatus } from './types.js';

/**
 * Options for creating a new task.
 */
export interface CreateTaskOptions {
  prompt: string;
  workingDir?: string;
  priority?: number;
  dependencies?: string[];
  completionPhrase?: string;
  timeoutMs?: number;
}

/**
 * A task representing a prompt to be executed by a Claude session.
 *
 * @description
 * Tasks have a lifecycle: pending → running → completed/failed
 * They support priority ordering and dependency chains.
 */
export class Task {
  readonly id: string;
  readonly prompt: string;
  readonly workingDir: string;
  readonly priority: number;
  readonly dependencies: string[];
  readonly completionPhrase: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly createdAt: number;

  private _status: TaskStatus = 'pending';
  private _assignedSessionId: string | null = null;
  private _startedAt: number | null = null;
  private _completedAt: number | null = null;
  private _output: string = '';
  private _error: string | null = null;

  constructor(options: CreateTaskOptions, id?: string) {
    this.id = id || uuidv4();
    this.prompt = options.prompt;
    this.workingDir = options.workingDir || process.cwd();
    this.priority = options.priority ?? 0;
    this.dependencies = options.dependencies || [];
    this.completionPhrase = options.completionPhrase;
    this.timeoutMs = options.timeoutMs;
    this.createdAt = Date.now();
  }

  get status(): TaskStatus {
    return this._status;
  }

  get assignedSessionId(): string | null {
    return this._assignedSessionId;
  }

  get startedAt(): number | null {
    return this._startedAt;
  }

  get completedAt(): number | null {
    return this._completedAt;
  }

  get output(): string {
    return this._output;
  }

  get error(): string | null {
    return this._error;
  }

  isPending(): boolean {
    return this._status === 'pending';
  }

  isRunning(): boolean {
    return this._status === 'running';
  }

  isCompleted(): boolean {
    return this._status === 'completed';
  }

  isFailed(): boolean {
    return this._status === 'failed';
  }

  isDone(): boolean {
    return this._status === 'completed' || this._status === 'failed';
  }

  toDefinition(): TaskDefinition {
    return {
      id: this.id,
      prompt: this.prompt,
      workingDir: this.workingDir,
      priority: this.priority,
      dependencies: this.dependencies,
      completionPhrase: this.completionPhrase,
      timeoutMs: this.timeoutMs,
    };
  }

  toState(): TaskState {
    return {
      ...this.toDefinition(),
      status: this._status,
      assignedSessionId: this._assignedSessionId,
      createdAt: this.createdAt,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      output: this._output,
      error: this._error,
    };
  }

  /** Reconstructs a Task from persisted state. */
  static fromState(state: TaskState): Task {
    const task = new Task(
      {
        prompt: state.prompt,
        workingDir: state.workingDir,
        priority: state.priority,
        dependencies: state.dependencies,
        completionPhrase: state.completionPhrase,
        timeoutMs: state.timeoutMs,
      },
      state.id
    );
    task._status = state.status;
    task._assignedSessionId = state.assignedSessionId;
    task._startedAt = state.startedAt;
    task._completedAt = state.completedAt;
    task._output = state.output;
    task._error = state.error;
    return task;
  }

  /** Assigns this task to a session and marks it as running. */
  assign(sessionId: string): void {
    if (this._status !== 'pending') {
      throw new Error(`Cannot assign task ${this.id}: status is ${this._status}`);
    }
    this._status = 'running';
    this._assignedSessionId = sessionId;
    this._startedAt = Date.now();
  }

  appendOutput(output: string): void {
    this._output += output;
  }

  setError(error: string): void {
    this._error = error;
  }

  complete(): void {
    this._status = 'completed';
    this._completedAt = Date.now();
  }

  fail(error?: string): void {
    this._status = 'failed';
    this._completedAt = Date.now();
    if (error) {
      this._error = error;
    }
  }

  reset(): void {
    this._status = 'pending';
    this._assignedSessionId = null;
    this._startedAt = null;
    this._completedAt = null;
    this._output = '';
    this._error = null;
  }

  /** Checks if output contains the completion phrase. */
  checkCompletion(output: string): boolean {
    if (this.completionPhrase) {
      // Check for exact completion phrase in promise tags
      const pattern = new RegExp(`<promise>${this.completionPhrase}</promise>`);
      return pattern.test(output);
    }
    // Default: check for any promise tag completion
    return /<promise>[^<]+<\/promise>/.test(output);
  }

  /** Returns true if the task has exceeded its timeout. */
  isTimedOut(): boolean {
    if (!this.timeoutMs || !this._startedAt) {
      return false;
    }
    return Date.now() - this._startedAt > this.timeoutMs;
  }
}
