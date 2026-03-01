/**
 * @fileoverview Default model and context limits for AI-powered checkers.
 *
 * Centralizes the AI model identifier and context window sizes used by
 * the idle checker, plan checker, respawn controller defaults, and
 * respawn route fallbacks. Change the model here when upgrading.
 *
 * @module config/ai-defaults
 */

/** Default model for AI idle and plan checkers */
export const AI_CHECK_MODEL = 'claude-opus-4-5-20251101';

/** Max context chars for idle checker (~4k tokens) */
export const AI_IDLE_CHECK_MAX_CONTEXT = 16000;

/** Max context chars for plan checker (~2k tokens, plan mode UI is compact) */
export const AI_PLAN_CHECK_MAX_CONTEXT = 8000;
