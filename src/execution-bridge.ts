/**
 * @fileoverview Execution Bridge - Coordinates parallel task execution.
 *
 * The central coordinator that:
 * - Loads optimized plans from PlanOrchestrator
 * - Converts plans to executable groups via GroupScheduler
 * - Manages parallel execution within groups
 * - Coordinates model selection via ModelSelector
 * - Handles fresh context requirements via ContextManager
 * - Tracks overall execution progress
 * - Integrates with SpawnOrchestrator for session-based execution
 *
 * @module execution-bridge
 */

import { EventEmitter } from 'node:events';
import {
  GroupScheduler,
  getGroupScheduler,
  type ExecutionGroup,
  type GroupTask,
  type ExecutionSchedule,
} from './group-scheduler.js';
import {
  ModelSelector,
  getModelSelector,
  type ModelConfig,
  type ModelSelection,
  type ExecutionMode,
} from './model-selector.js';
import {
  ContextManager,
  getContextManager,
  type SessionWriter,
} from './context-manager.js';
import {
  MAX_PARALLEL_TASKS_PER_GROUP,
  GROUP_TIMEOUT_MS,
  MAX_TASK_RETRIES,
  TASK_RETRY_DELAY_MS,
  EXECUTION_POLL_INTERVAL_MS,
  MAX_EXECUTION_HISTORY,
} from './config/execution-limits.js';

// ========== Types ==========

/** Overall execution status */
export type ExecutionStatus = 'idle' | 'loading' | 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';

/**
 * Execution progress for UI display.
 */
export interface ExecutionProgress {
  /** Current status */
  status: ExecutionStatus;
  /** Current group being executed */
  currentGroup: number | null;
  /** Total groups */
  totalGroups: number;
  /** Completed groups */
  completedGroups: number;
  /** Total tasks */
  totalTasks: number;
  /** Completed tasks */
  completedTasks: number;
  /** Failed tasks */
  failedTasks: number;
  /** Tasks currently running */
  runningTasks: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Estimated remaining time (if available) */
  estimatedRemainingMs?: number;
}

/**
 * Task assignment for spawning.
 */
export interface TaskAssignment {
  /** Task from the schedule */
  task: GroupTask;
  /** Selected model */
  model: ModelSelection;
  /** Execution mode */
  executionMode: ExecutionMode;
  /** Session ID (if session mode) */
  sessionId?: string;
  /** Whether fresh context was requested */
  freshContextRequested: boolean;
}

/**
 * Plan item from PlanOrchestrator (input format).
 */
export interface PlanItem {
  id: string;
  title: string;
  description: string;
  parallelGroup?: number;
  agentType?: string;
  recommendedModel?: string;
  requiresFreshContext?: boolean;
  estimatedTokens?: number;
  inputFiles?: string[];
  outputFiles?: string[];
  dependencies?: string[];
}

/**
 * Execution history entry.
 */
export interface ExecutionHistoryEntry {
  /** Unique execution ID */
  id: string;
  /** When execution started */
  startedAt: number;
  /** When execution ended */
  endedAt?: number;
  /** Final status */
  status: ExecutionStatus;
  /** Task counts */
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  /** Total cost estimate */
  estimatedCost?: number;
}

// ========== Events ==========

export interface ExecutionBridgeEvents {
  /** Plan loaded and schedule built */
  planLoaded: (schedule: ExecutionSchedule) => void;
  /** Execution started */
  started: () => void;
  /** Execution paused */
  paused: () => void;
  /** Execution resumed */
  resumed: () => void;
  /** Execution completed */
  completed: (result: { status: ExecutionStatus; stats: ExecutionProgress }) => void;
  /** Execution cancelled */
  cancelled: (reason: string) => void;
  /** Group started */
  groupStarted: (data: { groupNumber: number; taskCount: number; executionMode: ExecutionMode }) => void;
  /** Group completed */
  groupCompleted: (data: { groupNumber: number; status: string; completedCount: number; failedCount: number }) => void;
  /** Task assigned to execution */
  taskAssigned: (assignment: TaskAssignment) => void;
  /** Task completed */
  taskCompleted: (data: { taskId: string; groupNumber: number; durationMs: number }) => void;
  /** Task failed */
  taskFailed: (data: { taskId: string; groupNumber: number; error: string; willRetry: boolean }) => void;
  /** Fresh context triggered */
  freshContext: (data: { taskId: string; method: string; success: boolean }) => void;
  /** Model selected for task */
  modelSelected: (data: { taskId: string; model: string; reason: string; optimizerSuggested?: string }) => void;
  /** Progress update */
  progress: (progress: ExecutionProgress) => void;
}

// ========== Spawn Interface ==========

/**
 * Interface for spawning agents.
 * Injected to avoid circular dependencies.
 */
export interface AgentSpawner {
  /** Spawn an agent with specific model */
  spawnAgentWithModel(
    taskId: string,
    workingDir: string,
    prompt: string,
    model: string,
    options?: { requiresFreshContext?: boolean }
  ): Promise<{ sessionId: string }>;
  /** Use Task tool for lightweight execution */
  useTaskTool(
    sessionId: string,
    taskId: string,
    prompt: string,
    model: string
  ): Promise<void>;
  /** Check if task is complete */
  isTaskComplete(taskId: string): boolean;
  /** Get task result */
  getTaskResult(taskId: string): { success: boolean; output?: string; error?: string } | null;
}

// ========== Execution Bridge ==========

/**
 * ExecutionBridge - Coordinates parallel task execution.
 *
 * This is the main entry point for the optimized execution system.
 * It bridges the gap between PlanOrchestrator's output and actual
 * task execution, making use of the optimizer's metadata.
 */
export class ExecutionBridge extends EventEmitter {
  private _scheduler: GroupScheduler;
  private _modelSelector: ModelSelector;
  private _contextManager: ContextManager;

  private _status: ExecutionStatus = 'idle';
  private _executionId: string | null = null;
  private _startedAt: number | null = null;
  private _pausedAt: number | null = null;

  private _agentSpawner: AgentSpawner | null = null;
  private _sessionWriter: SessionWriter | null = null;

  private _pollTimer: NodeJS.Timeout | null = null;
  private _groupTimeoutTimers: Map<number, NodeJS.Timeout> = new Map();
  private _retryTimers: Map<string, NodeJS.Timeout> = new Map();
  private _runningTasks: Map<string, { startedAt: number; sessionId?: string }> = new Map();

  private _history: ExecutionHistoryEntry[] = [];
  private _workingDir: string = process.cwd();

  constructor(modelConfig?: Partial<ModelConfig>) {
    super();
    this._scheduler = getGroupScheduler();
    this._modelSelector = getModelSelector(modelConfig);
    this._contextManager = getContextManager();

    // Forward scheduler events
    this._scheduler.on('groupStarted', group => {
      this.emit('groupStarted', {
        groupNumber: group.groupNumber,
        taskCount: group.tasks.length,
        executionMode: group.executionMode,
      });
    });

    this._scheduler.on('groupCompleted', group => {
      // Clear the group timeout timer to prevent memory leak
      const timer = this._groupTimeoutTimers.get(group.groupNumber);
      if (timer) {
        clearTimeout(timer);
        this._groupTimeoutTimers.delete(group.groupNumber);
      }
      this.emit('groupCompleted', {
        groupNumber: group.groupNumber,
        status: group.status,
        completedCount: group.completedCount,
        failedCount: group.failedCount,
      });
    });

    this._scheduler.on('taskStatusChanged', data => {
      if (data.newStatus === 'completed') {
        const runningInfo = this._runningTasks.get(data.taskId);
        const durationMs = runningInfo ? Date.now() - runningInfo.startedAt : 0;
        this._runningTasks.delete(data.taskId);
        this.emit('taskCompleted', { taskId: data.taskId, groupNumber: data.groupNumber, durationMs });
      }
    });
  }

  /**
   * Get current execution status.
   */
  get status(): ExecutionStatus {
    return this._status;
  }

  /**
   * Get current execution progress.
   */
  getProgress(): ExecutionProgress {
    const stats = this._scheduler.getStats();
    const schedule = this._scheduler.schedule;

    return {
      status: this._status,
      currentGroup: schedule?.currentGroupIndex ?? null,
      totalGroups: stats.totalGroups,
      completedGroups: stats.completedGroups,
      totalTasks: stats.totalTasks,
      completedTasks: stats.completedTasks,
      failedTasks: stats.failedTasks,
      runningTasks: this._runningTasks.size,
      elapsedMs: this.calculateElapsedMs(),
    };
  }

  /**
   * Calculate elapsed time, accounting for pauses.
   */
  private calculateElapsedMs(): number {
    if (!this._startedAt) return 0;
    if (this._pausedAt) {
      return this._pausedAt - this._startedAt;
    }
    return Date.now() - this._startedAt;
  }

  /**
   * Set the agent spawner for session-based execution.
   */
  setAgentSpawner(spawner: AgentSpawner): void {
    this._agentSpawner = spawner;
  }

  /**
   * Set the session writer for context management.
   */
  setSessionWriter(writer: SessionWriter): void {
    this._sessionWriter = writer;
    this._contextManager.setSessionWriter(writer);
  }

  /**
   * Set working directory for execution.
   */
  setWorkingDir(dir: string): void {
    this._workingDir = dir;
  }

  /**
   * Update model configuration.
   */
  updateModelConfig(config: Partial<ModelConfig>): void {
    this._modelSelector.updateConfig(config);
  }

  /**
   * Get current model configuration.
   */
  getModelConfig(): ModelConfig {
    return this._modelSelector.config;
  }

  /**
   * Load a plan and build execution schedule.
   */
  loadPlan(items: PlanItem[]): ExecutionSchedule {
    if (this._status === 'running') {
      throw new Error('Cannot load plan while execution is running');
    }

    this._status = 'loading';
    const schedule = this._scheduler.buildSchedule(items);
    this._status = 'idle';

    this.emit('planLoaded', schedule);
    return schedule;
  }

  /**
   * Start execution of the loaded plan.
   */
  async start(): Promise<void> {
    const schedule = this._scheduler.schedule;
    if (!schedule) {
      throw new Error('No plan loaded');
    }

    if (this._status === 'running') {
      return;
    }

    if (!this._agentSpawner) {
      throw new Error('No agent spawner configured');
    }

    this._status = 'running';
    this._executionId = `exec-${Date.now()}`;
    this._startedAt = Date.now();

    // Add to history
    this._history.unshift({
      id: this._executionId,
      startedAt: this._startedAt,
      status: 'running',
      totalTasks: schedule.totalTasks,
      completedTasks: 0,
      failedTasks: 0,
    });

    // Trim history
    if (this._history.length > MAX_EXECUTION_HISTORY) {
      this._history = this._history.slice(0, MAX_EXECUTION_HISTORY);
    }

    this.emit('started');

    // Start the execution loop
    this.startExecutionLoop();
  }

  /**
   * Pause execution.
   */
  pause(): void {
    if (this._status !== 'running') return;

    this._status = 'paused';
    this._pausedAt = Date.now();
    this.stopExecutionLoop();
    this.emit('paused');
  }

  /**
   * Resume paused execution.
   */
  resume(): void {
    if (this._status !== 'paused') return;

    this._status = 'running';
    this._pausedAt = null;
    this.startExecutionLoop();
    this.emit('resumed');
  }

  /**
   * Cancel execution.
   */
  async cancel(reason: string = 'User cancelled'): Promise<void> {
    if (this._status === 'idle' || this._status === 'completed' || this._status === 'cancelled') {
      return;
    }

    this._status = 'cancelled';
    this.stopExecutionLoop();

    // Clear group timeouts
    for (const timer of this._groupTimeoutTimers.values()) {
      clearTimeout(timer);
    }
    this._groupTimeoutTimers.clear();

    // Update history
    this.updateHistoryEntry('cancelled');

    this.emit('cancelled', reason);
  }

  /**
   * Get execution history.
   */
  getHistory(): ExecutionHistoryEntry[] {
    return [...this._history];
  }

  /**
   * Start the main execution loop.
   */
  private startExecutionLoop(): void {
    if (this._pollTimer) return;

    this._pollTimer = setInterval(() => {
      this.tick().catch(err => {
        console.error('[execution-bridge] Tick error:', err);
      });
    }, EXECUTION_POLL_INTERVAL_MS);

    // Run immediately
    this.tick().catch(err => {
      console.error('[execution-bridge] Initial tick error:', err);
    });
  }

  /**
   * Stop the execution loop.
   */
  private stopExecutionLoop(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Main execution tick.
   */
  private async tick(): Promise<void> {
    if (this._status !== 'running') return;

    const schedule = this._scheduler.schedule;
    if (!schedule) return;

    // Check if we're done
    if (schedule.status === 'completed' || schedule.status === 'partial' || schedule.status === 'failed') {
      this.handleExecutionComplete();
      return;
    }

    // Process current group or start next one
    await this.processGroups();

    // Emit progress
    this.emit('progress', this.getProgress());
  }

  /**
   * Process groups - start new ones or continue existing.
   */
  private async processGroups(): Promise<void> {
    const schedule = this._scheduler.schedule;
    if (!schedule) return;

    // Find current running group
    const runningGroup = schedule.groups.find(g => g.status === 'running');

    if (runningGroup) {
      // Continue processing current group
      await this.processGroup(runningGroup);
    } else {
      // Try to start next group
      const nextGroup = this._scheduler.getNextReadyGroup();
      if (nextGroup) {
        await this.startGroup(nextGroup);
      }
    }
  }

  /**
   * Start executing a group.
   */
  private async startGroup(group: ExecutionGroup): Promise<void> {
    this._scheduler.startGroup(group.groupNumber);

    // Set up group timeout
    const timeoutTimer = setTimeout(() => {
      this.handleGroupTimeout(group.groupNumber);
    }, GROUP_TIMEOUT_MS);
    this._groupTimeoutTimers.set(group.groupNumber, timeoutTimer);

    // Start initial tasks
    await this.processGroup(group);
  }

  /**
   * Process tasks within a group.
   */
  private async processGroup(group: ExecutionGroup): Promise<void> {
    if (!this._agentSpawner) return;

    // Get ready tasks
    const readyTasks = this._scheduler.getReadyTasksInGroup(group.groupNumber);
    if (readyTasks.length === 0) return;

    // Limit parallel tasks
    const slotsAvailable = MAX_PARALLEL_TASKS_PER_GROUP - this._runningTasks.size;
    if (slotsAvailable <= 0) return;

    const tasksToStart = readyTasks.slice(0, slotsAvailable);

    for (const task of tasksToStart) {
      await this.assignTask(task, group);
    }
  }

  /**
   * Assign a task for execution.
   */
  private async assignTask(task: GroupTask, group: ExecutionGroup): Promise<void> {
    if (!this._agentSpawner) return;

    // Select model
    const modelSelection = this._modelSelector.selectModel(task.id, {
      estimatedTokens: task.estimatedTokens,
      agentType: task.agentType,
      recommendedModel: task.recommendedModel,
      outputFiles: task.outputFiles,
      inputFiles: task.inputFiles,
    });

    this.emit('modelSelected', {
      taskId: task.id,
      model: modelSelection.model,
      reason: modelSelection.reason,
      optimizerSuggested: modelSelection.optimizerRecommendation,
    });

    // Handle fresh context if required
    let freshContextRequested = false;
    if (task.requiresFreshContext && this._sessionWriter) {
      freshContextRequested = true;
      // Context refresh will be handled by the spawner
    }

    // Mark task as running
    this._scheduler.updateTaskStatus(task.id, 'running');
    this._runningTasks.set(task.id, { startedAt: Date.now() });

    const assignment: TaskAssignment = {
      task,
      model: modelSelection,
      executionMode: group.executionMode,
      freshContextRequested,
    };

    this.emit('taskAssigned', assignment);

    // Execute based on mode
    try {
      if (group.executionMode === 'session') {
        const result = await this._agentSpawner.spawnAgentWithModel(
          task.id,
          this._workingDir,
          task.description,
          modelSelection.model,
          { requiresFreshContext: task.requiresFreshContext }
        );
        assignment.sessionId = result.sessionId;
        this._runningTasks.set(task.id, { startedAt: Date.now(), sessionId: result.sessionId });
      } else {
        // task-tool mode - would use Task tool in main session
        // For now, fall back to session mode
        const result = await this._agentSpawner.spawnAgentWithModel(
          task.id,
          this._workingDir,
          task.description,
          modelSelection.model
        );
        assignment.sessionId = result.sessionId;
        this._runningTasks.set(task.id, { startedAt: Date.now(), sessionId: result.sessionId });
      }

      if (task.requiresFreshContext) {
        this.emit('freshContext', {
          taskId: task.id,
          method: 'session',
          success: true,
        });
      }

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.handleTaskFailure(task, group.groupNumber, error);
    }
  }

  /**
   * Handle task failure.
   */
  private async handleTaskFailure(task: GroupTask, groupNumber: number, error: string): Promise<void> {
    task.retryCount++;
    const willRetry = task.retryCount < MAX_TASK_RETRIES;

    this.emit('taskFailed', {
      taskId: task.id,
      groupNumber,
      error,
      willRetry,
    });

    if (willRetry) {
      // Schedule retry with tracked timer
      const retryTimer = setTimeout(() => {
        this._retryTimers.delete(task.id);
        task.status = 'pending';
        task.error = undefined;
        this._runningTasks.delete(task.id);
      }, TASK_RETRY_DELAY_MS);
      this._retryTimers.set(task.id, retryTimer);
    } else {
      // Mark as permanently failed
      this._scheduler.updateTaskStatus(task.id, 'failed', error);
      this._runningTasks.delete(task.id);

      // Mark dependent tasks as blocked
      this._scheduler.markDependentTasksBlocked(task.id);
    }
  }

  /**
   * Mark a task as complete (called externally when agent finishes).
   */
  markTaskComplete(taskId: string): void {
    const schedule = this._scheduler.schedule;
    if (!schedule) return;

    const groupNum = this.findTaskGroup(taskId);
    if (groupNum === null) return;

    // Clear any pending retry timer for this task
    const retryTimer = this._retryTimers.get(taskId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this._retryTimers.delete(taskId);
    }

    this._scheduler.updateTaskStatus(taskId, 'completed');
    this._runningTasks.delete(taskId);
  }

  /**
   * Mark a task as failed (called externally when agent fails).
   */
  markTaskFailed(taskId: string, error: string): void {
    const schedule = this._scheduler.schedule;
    if (!schedule) return;

    const groupNum = this.findTaskGroup(taskId);
    if (groupNum === null) return;

    // Get the task to check retry count
    for (const group of schedule.groups) {
      const task = group.tasks.find(t => t.id === taskId);
      if (task) {
        this.handleTaskFailure(task, group.groupNumber, error);
        return;
      }
    }
  }

  /**
   * Find which group a task belongs to.
   */
  private findTaskGroup(taskId: string): number | null {
    const schedule = this._scheduler.schedule;
    if (!schedule) return null;

    for (const group of schedule.groups) {
      if (group.tasks.some(t => t.id === taskId)) {
        return group.groupNumber;
      }
    }
    return null;
  }

  /**
   * Handle group timeout.
   */
  private handleGroupTimeout(groupNumber: number): void {
    const schedule = this._scheduler.schedule;
    if (!schedule) return;

    const group = schedule.groups.find(g => g.groupNumber === groupNumber);
    if (!group || group.status !== 'running') return;

    console.warn(`[execution-bridge] Group ${groupNumber} timed out`);

    // Mark running tasks as failed
    for (const task of group.tasks) {
      if (task.status === 'running') {
        this._scheduler.updateTaskStatus(task.id, 'failed', 'Group timeout');
        this._runningTasks.delete(task.id);
      } else if (task.status === 'pending') {
        this._scheduler.updateTaskStatus(task.id, 'skipped', 'Group timeout');
      }
    }

    this._groupTimeoutTimers.delete(groupNumber);
  }

  /**
   * Handle execution complete.
   */
  private handleExecutionComplete(): void {
    this.stopExecutionLoop();

    // Clear timers
    for (const timer of this._groupTimeoutTimers.values()) {
      clearTimeout(timer);
    }
    this._groupTimeoutTimers.clear();

    const schedule = this._scheduler.schedule;
    if (!schedule) return;

    // Map schedule status to execution status
    if (schedule.status === 'completed') {
      this._status = 'completed';
    } else if (schedule.status === 'partial') {
      this._status = 'partial';
    } else {
      this._status = 'failed';
    }

    // Update history
    this.updateHistoryEntry(this._status);

    this.emit('completed', {
      status: this._status,
      stats: this.getProgress(),
    });
  }

  /**
   * Update history entry for current execution.
   */
  private updateHistoryEntry(status: ExecutionStatus): void {
    if (!this._executionId) return;

    const entry = this._history.find(e => e.id === this._executionId);
    if (entry) {
      entry.status = status;
      entry.endedAt = Date.now();
      entry.completedTasks = this._scheduler.getStats().completedTasks;
      entry.failedTasks = this._scheduler.getStats().failedTasks;
    }
  }

  /**
   * Reset the bridge for a new execution.
   */
  reset(): void {
    this.stopExecutionLoop();

    for (const timer of this._groupTimeoutTimers.values()) {
      clearTimeout(timer);
    }
    this._groupTimeoutTimers.clear();

    // Clear any pending retry timers
    for (const timer of this._retryTimers.values()) {
      clearTimeout(timer);
    }
    this._retryTimers.clear();

    this._scheduler.reset();
    this._runningTasks.clear();
    this._status = 'idle';
    this._executionId = null;
    this._startedAt = null;
    this._pausedAt = null;
  }
}

// ========== Singleton ==========

let bridgeInstance: ExecutionBridge | null = null;

/**
 * Get or create the singleton ExecutionBridge instance.
 */
export function getExecutionBridge(modelConfig?: Partial<ModelConfig>): ExecutionBridge {
  if (!bridgeInstance) {
    bridgeInstance = new ExecutionBridge(modelConfig);
  }
  return bridgeInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetExecutionBridge(): void {
  if (bridgeInstance) {
    bridgeInstance.reset();
  }
  bridgeInstance = null;
}
