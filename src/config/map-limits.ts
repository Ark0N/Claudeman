/**
 * @fileoverview Centralized Map size limits for memory management.
 *
 * These constants define maximum sizes for Maps that track ephemeral data.
 * Without limits, long-running sessions can accumulate unbounded entries
 * leading to memory leaks.
 *
 * Memory Budget Rationale:
 * - Assuming average entry size of ~1KB
 * - MAX_TRACKED_AGENTS=500 × 1KB = ~500KB for agent tracking
 * - Activity/results per agent × agents = bounded by these limits
 * - Total Map overhead: <50MB even under heavy load
 *
 * @module config/map-limits
 */

// ============================================================================
// Agent Tracking Limits
// ============================================================================

/**
 * Maximum number of agents to track across all sessions.
 * Oldest agents are evicted when limit is exceeded (LRU policy).
 */
export const MAX_TRACKED_AGENTS = 500;

/**
 * Maximum activity entries to keep per agent.
 * Includes tool calls, status updates, progress reports.
 */
export const MAX_SUBAGENT_ACTIVITY_PER_AGENT = 100;

/**
 * Maximum tool results to keep per agent.
 * Prevents memory growth from long-running agents with many tool calls.
 */
export const MAX_TOOL_RESULTS_PER_AGENT = 200;

// ============================================================================
// Hook Event Limits
// ============================================================================

/**
 * Maximum pending hook events to queue.
 * Prevents unbounded growth if hook processing is slow.
 */
export const MAX_PENDING_HOOKS = 50;

// ============================================================================
// Session Tracking Limits
// ============================================================================

/**
 * Maximum concurrent sessions allowed.
 * Each session consumes significant resources (PTY, buffers, watchers).
 */
export const MAX_CONCURRENT_SESSIONS = 50;

/**
 * Maximum session history entries to keep (for analytics).
 */
export const MAX_SESSION_HISTORY = 100;

// ============================================================================
// SSE Client Limits
// ============================================================================

/**
 * Maximum SSE clients per session.
 * Prevents resource exhaustion from many browser tabs.
 */
export const MAX_SSE_CLIENTS_PER_SESSION = 10;

/**
 * Maximum total SSE clients across all sessions.
 */
export const MAX_TOTAL_SSE_CLIENTS = 100;

// ============================================================================
// File Watcher Limits
// ============================================================================

/**
 * Maximum file watchers (FSWatcher) to allow.
 * Linux default max_user_watches is 8192-65536.
 * We warn at 80% capacity and evict idle watchers.
 */
export const MAX_FILE_WATCHERS = 500;

/**
 * Warning threshold as percentage of max watchers.
 */
export const FILE_WATCHER_WARNING_THRESHOLD = 0.8;

// ============================================================================
// Task Tracking Limits
// ============================================================================

/**
 * Maximum tasks to keep in the task queue.
 */
export const MAX_QUEUED_TASKS = 100;

/**
 * Maximum completed tasks to keep for history.
 */
export const MAX_COMPLETED_TASKS_HISTORY = 50;

// ============================================================================
// Todo Item Limits (Ralph Tracker)
// ============================================================================

/**
 * Maximum todo items to track per session.
 */
export const MAX_TODOS_PER_SESSION = 500;

/**
 * TTL for completed todo items before cleanup (1 hour).
 */
export const COMPLETED_TODO_TTL_MS = 60 * 60 * 1000;

// ============================================================================
// Pending Tool Calls Limits
// ============================================================================

/**
 * Maximum pending tool calls to track per subagent.
 * Entries should be cleaned up on tool_result, but this prevents leaks.
 */
export const MAX_PENDING_TOOL_CALLS = 100;

/**
 * TTL for orphaned pending tool calls (5 minutes).
 * If no tool_result received, entry is cleaned up.
 */
export const PENDING_TOOL_CALL_TTL_MS = 5 * 60 * 1000;
