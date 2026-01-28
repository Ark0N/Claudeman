/**
 * @fileoverview Model Selector - Routes tasks to appropriate Claude models.
 *
 * Handles model selection based on:
 * - User-configured default model
 * - Optimizer recommendations (advisory)
 * - Agent type mappings
 * - Per-task overrides
 *
 * @module model-selector
 */

import { EventEmitter } from 'node:events';
import {
  DEFAULT_MODEL,
  TOKEN_THRESHOLD_HAIKU,
  TOKEN_THRESHOLD_FOR_SESSION_MODE,
} from './config/execution-limits.js';

// ========== Types ==========

/** Supported Claude model tiers */
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

/** Agent types that influence model selection */
export type AgentType = 'explore' | 'implement' | 'test' | 'review' | 'general';

/** Execution mode for tasks */
export type ExecutionMode = 'session' | 'task-tool';

/**
 * User-configurable model settings.
 * Stored in settings.json and editable via App Settings.
 */
export interface ModelConfig {
  /** User's preferred default model */
  defaultModel: ModelTier;
  /** Whether to show optimizer recommendations in UI (advisory only) */
  showRecommendations: boolean;
  /** Override map for specific agent types */
  agentTypeOverrides: Partial<Record<AgentType, ModelTier>>;
}

/**
 * Model selection result with reasoning.
 */
export interface ModelSelection {
  /** The model to use */
  model: ModelTier;
  /** Why this model was selected */
  reason: string;
  /** What the optimizer recommended (if different) */
  optimizerRecommendation?: ModelTier;
  /** Was user default used? */
  usedUserDefault: boolean;
}

/**
 * Execution mode selection result.
 */
export interface ExecutionModeSelection {
  /** How to execute this task */
  mode: ExecutionMode;
  /** Why this mode was selected */
  rationale: string;
}

/**
 * Task characteristics for selection decisions.
 */
export interface TaskCharacteristics {
  /** Estimated token usage */
  estimatedTokens?: number;
  /** Agent type */
  agentType?: AgentType;
  /** Optimizer's recommended model */
  recommendedModel?: ModelTier;
  /** Files task will modify */
  outputFiles?: string[];
  /** Files task will read */
  inputFiles?: string[];
  /** Task complexity hint */
  complexity?: 'low' | 'medium' | 'high';
}

// ========== Events ==========

export interface ModelSelectorEvents {
  /** Emitted when model is selected */
  modelSelected: (data: { taskId: string; selection: ModelSelection }) => void;
  /** Emitted when config changes */
  configUpdated: (config: ModelConfig) => void;
}

// ========== Default Configuration ==========

/**
 * Default optimizer recommendations by agent type.
 * These are advisory - user default always wins.
 */
const DEFAULT_RECOMMENDATIONS: Record<AgentType, ModelTier> = {
  explore: 'haiku',
  implement: 'sonnet',
  test: 'sonnet',
  review: 'opus',
  general: 'sonnet',
};

/**
 * Creates default model configuration.
 */
export function createDefaultModelConfig(): ModelConfig {
  return {
    defaultModel: DEFAULT_MODEL,
    showRecommendations: true,
    agentTypeOverrides: {},
  };
}

// ========== Model Selector ==========

/**
 * ModelSelector - Manages model selection for task execution.
 *
 * User preferences always take precedence. Optimizer recommendations
 * are shown in the UI for awareness but don't override user settings.
 */
export class ModelSelector extends EventEmitter {
  private _config: ModelConfig;

  constructor(config?: Partial<ModelConfig>) {
    super();
    this._config = { ...createDefaultModelConfig(), ...config };
  }

  /**
   * Get current configuration.
   */
  get config(): ModelConfig {
    return { ...this._config };
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<ModelConfig>): void {
    Object.assign(this._config, config);
    this.emit('configUpdated', this._config);
  }

  /**
   * Select model for a task.
   *
   * Priority order:
   * 1. User's agent type override (if set)
   * 2. User's default model
   * 3. Optimizer recommendation (only if no user preference)
   */
  selectModel(taskId: string, characteristics: TaskCharacteristics): ModelSelection {
    const { agentType, recommendedModel } = characteristics;

    let model: ModelTier;
    let reason: string;
    let usedUserDefault = false;

    // Check for agent type override
    if (agentType && this._config.agentTypeOverrides[agentType]) {
      model = this._config.agentTypeOverrides[agentType]!;
      reason = `User override for ${agentType} tasks`;
    } else {
      // Use user's default model
      model = this._config.defaultModel;
      reason = 'User default model';
      usedUserDefault = true;
    }

    // Determine what optimizer would have recommended
    const optimizerRecommendation = recommendedModel ||
      (agentType ? DEFAULT_RECOMMENDATIONS[agentType] : undefined);

    const selection: ModelSelection = {
      model,
      reason,
      usedUserDefault,
    };

    // Include optimizer recommendation if different (for UI display)
    if (optimizerRecommendation && optimizerRecommendation !== model) {
      selection.optimizerRecommendation = optimizerRecommendation;
      if (this._config.showRecommendations) {
        selection.reason += ` (optimizer suggested ${optimizerRecommendation})`;
      }
    }

    this.emit('modelSelected', { taskId, selection });
    return selection;
  }

  /**
   * Select execution mode for a task.
   *
   * Decision based on task characteristics:
   * - High token estimate → session mode (needs full context)
   * - Complex agent types → session mode (dedicated Claude)
   * - Low token estimate → task-tool mode (efficient)
   * - Multiple output files → session mode (avoid conflicts)
   * - Read-only tasks → task-tool mode (no side effects)
   */
  selectExecutionMode(characteristics: TaskCharacteristics): ExecutionModeSelection {
    const { estimatedTokens, agentType, outputFiles, inputFiles, complexity } = characteristics;

    // High token estimate needs session mode
    if (estimatedTokens && estimatedTokens > TOKEN_THRESHOLD_FOR_SESSION_MODE) {
      return {
        mode: 'session',
        rationale: `High token estimate (${estimatedTokens} > ${TOKEN_THRESHOLD_FOR_SESSION_MODE})`,
      };
    }

    // Complex agent types benefit from session mode
    if (agentType === 'implement' || agentType === 'review') {
      return {
        mode: 'session',
        rationale: `Complex agent type (${agentType}) benefits from dedicated context`,
      };
    }

    // Multiple output files need session mode to avoid conflicts
    if (outputFiles && outputFiles.length > 2) {
      return {
        mode: 'session',
        rationale: `Multiple output files (${outputFiles.length}) - avoid conflicts`,
      };
    }

    // High complexity tasks need session mode
    if (complexity === 'high') {
      return {
        mode: 'session',
        rationale: 'High complexity task needs dedicated context',
      };
    }

    // Low token tasks can use task-tool mode
    if (estimatedTokens && estimatedTokens < TOKEN_THRESHOLD_HAIKU) {
      return {
        mode: 'task-tool',
        rationale: `Low token estimate (${estimatedTokens} < ${TOKEN_THRESHOLD_HAIKU})`,
      };
    }

    // Explore tasks typically work well with task-tool
    if (agentType === 'explore') {
      return {
        mode: 'task-tool',
        rationale: 'Explore tasks efficient with shared context',
      };
    }

    // Read-only tasks (input files only) can use task-tool
    if (inputFiles && inputFiles.length > 0 && (!outputFiles || outputFiles.length === 0)) {
      return {
        mode: 'task-tool',
        rationale: 'Read-only task (no output files)',
      };
    }

    // Default to session mode for safety
    return {
      mode: 'session',
      rationale: 'Default to session mode for reliability',
    };
  }

  /**
   * Get optimizer's recommendation for an agent type (for UI display).
   */
  getOptimizerRecommendation(agentType: AgentType): ModelTier {
    return DEFAULT_RECOMMENDATIONS[agentType];
  }

  /**
   * Get model cost multiplier (relative to sonnet).
   * Used for cost estimation in UI.
   */
  getModelCostMultiplier(model: ModelTier): number {
    switch (model) {
      case 'opus': return 5.0;    // ~5x more expensive
      case 'sonnet': return 1.0;  // baseline
      case 'haiku': return 0.04;  // ~25x cheaper
      default: {
        // Exhaustive check - if new ModelTier added, this will catch it
        const _exhaustive: never = model;
        console.warn(`[ModelSelector] Unknown model tier: ${_exhaustive}, using sonnet multiplier`);
        return 1.0;
      }
    }
  }
}

// ========== Singleton ==========

let selectorInstance: ModelSelector | null = null;

/**
 * Get or create the singleton ModelSelector instance.
 */
export function getModelSelector(config?: Partial<ModelConfig>): ModelSelector {
  if (!selectorInstance) {
    selectorInstance = new ModelSelector(config);
  }
  return selectorInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetModelSelector(): void {
  selectorInstance = null;
}
