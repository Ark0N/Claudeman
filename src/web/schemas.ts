/**
 * @fileoverview Zod validation schemas for API routes
 *
 * This module contains Zod schemas for validating API request bodies.
 * Schemas are used in src/web/server.ts route handlers.
 *
 * @module web/schemas
 */

import { z } from 'zod';

// ========== Session Routes ==========

/**
 * Schema for POST /api/sessions
 * Creates a new session with optional working directory, mode, and name.
 */
export const CreateSessionSchema = z.object({
  workingDir: z.string().optional(),
  mode: z.enum(['claude', 'shell']).optional(),
  name: z.string().max(100).optional(),
  envOverrides: z.record(z.string(), z.string()).optional(),
});

/**
 * Schema for POST /api/sessions/:id/run
 * Runs a prompt in a session.
 */
export const RunPromptSchema = z.object({
  prompt: z.string().min(1).max(100000),
});

/**
 * Schema for POST /api/sessions/:id/input
 * Sends input to an interactive session.
 */
export const SessionInputSchema = z.object({
  input: z.string(),
  useScreen: z.boolean().optional(),
});

/**
 * Schema for POST /api/sessions/:id/resize
 * Resizes a session's terminal.
 */
export const ResizeSchema = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});

// ========== Case Routes ==========

/**
 * Schema for POST /api/cases
 * Creates a new case folder.
 */
export const CreateCaseSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.'),
  description: z.string().max(1000).optional(),
});

// ========== Quick Start ==========

/**
 * Schema for POST /api/quick-start
 * Creates case (if needed) and starts interactive session.
 */
export const QuickStartSchema = z.object({
  caseName: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.').optional(),
  mode: z.enum(['claude', 'shell']).optional(),
});

// ========== Hook Events ==========

/**
 * Schema for POST /api/hook-event
 * Receives Claude Code hook events.
 */
export const HookEventSchema = z.object({
  event: z.enum(['permission_prompt', 'elicitation_dialog', 'idle_prompt', 'stop', 'teammate_idle', 'task_completed']),
  sessionId: z.string().min(1),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});

// ========== Configuration ==========

/**
 * Schema for respawn configuration (partial updates allowed)
 * Used in PUT /api/config and respawn endpoints.
 */
export const RespawnConfigSchema = z.object({
  idleTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  updatePrompt: z.string().max(10000).optional(),
  interStepDelayMs: z.number().int().min(100).max(60000).optional(),
  enabled: z.boolean().optional(),
  sendClear: z.boolean().optional(),
  sendUpdate: z.boolean().optional(),
  sendInit: z.boolean().optional(),
  sendKickstart: z.boolean().optional(),
  kickstartPrompt: z.string().max(10000).optional(),
  aiIdleCheckEnabled: z.boolean().optional(),
  aiIdleCheckTimeoutMs: z.number().int().min(10000).max(300000).optional(),
  aiIdleCheckModel: z.string().max(100).optional(),
  completionConfirmMs: z.number().int().min(1000).max(60000).optional(),
  noOutputTimeoutMs: z.number().int().min(5000).max(600000).optional(),
  maxIterations: z.number().int().min(0).max(10000).optional(),
  stuckStateWarningMs: z.number().int().min(60000).max(3600000).optional(),
  autoAcceptEnabled: z.boolean().optional(),
  autoAcceptDelayMs: z.number().int().min(1000).max(60000).optional(),
  planModeEnabled: z.boolean().optional(),
  planCheckTimeoutMs: z.number().int().min(10000).max(300000).optional(),
  planCheckModel: z.string().max(100).optional(),
}).strict();

/**
 * Schema for PUT /api/config
 * Updates application configuration with whitelist of allowed fields.
 */
export const ConfigUpdateSchema = z.object({
  pollIntervalMs: z.number().int().min(100).max(60000).optional(),
  defaultTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
  maxConcurrentSessions: z.number().int().min(1).max(50).optional(),
  respawn: RespawnConfigSchema.optional(),
}).strict();

/**
 * Schema for PUT /api/settings
 * User settings with allowed fields only.
 */
export const SettingsUpdateSchema = z.object({
  defaultClaudeMdPath: z.string().max(500).optional(),
  lastUsedCase: z.string().max(200).optional(),
  // Add other known settings fields as needed
}).passthrough(); // Allow additional fields but validate known ones

/**
 * Schema for POST /api/sessions/:id/input with length limit
 */
export const SessionInputWithLimitSchema = z.object({
  input: z.string().max(100000), // 100KB max input
  useScreen: z.boolean().optional(),
});

// ========== Session Mutation Routes ==========

/** PUT /api/sessions/:id/name */
export const SessionNameSchema = z.object({
  name: z.string().min(0).max(128),
});

/** PUT /api/sessions/:id/color */
export const SessionColorSchema = z.object({
  color: z.string().max(30),
});

/** POST /api/sessions/:id/ralph-config */
export const RalphConfigSchema = z.object({
  enabled: z.boolean().optional(),
  completionPhrase: z.string().max(500).optional(),
  maxIterations: z.number().int().min(0).max(10000).optional(),
  reset: z.boolean().optional(),
  disableAutoEnable: z.boolean().optional(),
});

/** POST /api/sessions/:id/fix-plan/import */
export const FixPlanImportSchema = z.object({
  content: z.string().max(500000),
});

/** POST /api/sessions/:id/ralph-prompt/write */
export const RalphPromptWriteSchema = z.object({
  content: z.string().max(500000),
});

/** POST /api/sessions/:id/auto-clear */
export const AutoClearSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(0).max(1000000).optional(),
});

/** POST /api/sessions/:id/auto-compact */
export const AutoCompactSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(0).max(1000000).optional(),
  prompt: z.string().max(10000).optional(),
});

/** POST /api/sessions/:id/image-watcher */
export const ImageWatcherSchema = z.object({
  enabled: z.boolean(),
});

/** POST /api/sessions/:id/flicker-filter */
export const FlickerFilterSchema = z.object({
  enabled: z.boolean(),
});

/** POST /api/run */
export const QuickRunSchema = z.object({
  prompt: z.string().min(1).max(100000),
  workingDir: z.string().max(1000).optional(),
});

/** POST /api/scheduled */
export const ScheduledRunSchema = z.object({
  prompt: z.string().min(1).max(100000),
  workingDir: z.string().max(1000).optional(),
  durationMinutes: z.number().int().min(1).max(14400).optional(),
});

/** POST /api/cases/link */
export const LinkCaseSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  path: z.string().min(1).max(1000),
});

/** POST /api/generate-plan */
export const GeneratePlanSchema = z.object({
  taskDescription: z.string().min(1).max(100000),
  detailLevel: z.enum(['brief', 'standard', 'detailed']).optional(),
});

/** POST /api/generate-plan-detailed */
export const GeneratePlanDetailedSchema = z.object({
  taskDescription: z.string().min(1).max(100000),
  caseName: z.string().max(200).optional(),
});

/** POST /api/cancel-plan-generation */
export const CancelPlanSchema = z.object({
  orchestratorId: z.string().max(200).optional(),
});

/** PATCH /api/sessions/:id/plan/task/:taskId */
export const PlanTaskUpdateSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'blocked']).optional(),
  error: z.string().max(10000).optional(),
  incrementAttempts: z.boolean().optional(),
});

/** POST /api/sessions/:id/plan/task (add task) */
export const PlanTaskAddSchema = z.object({
  content: z.string().min(1).max(10000),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  verificationCriteria: z.string().max(10000).optional(),
  dependencies: z.array(z.string().max(200)).optional(),
  insertAfter: z.string().max(200).optional(),
});

/** POST /api/sessions/:id/cpu-limit */
export const CpuLimitSchema = z.object({
  cpuLimit: z.number().int().min(0).max(100).optional(),
  ioClass: z.enum(['idle', 'best-effort', 'realtime']).optional(),
  ioLevel: z.number().int().min(0).max(7).optional(),
});
