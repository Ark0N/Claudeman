/**
 * @fileoverview Agent Teams polling and cache configuration.
 *
 * Controls how frequently TeamWatcher polls ~/.claude/teams/
 * and how many teams/tasks are cached in memory.
 *
 * @module config/team-config
 */

/** Team directory poll interval (ms) */
export const TEAM_POLL_INTERVAL_MS = 30_000;

/** Max cached team configs (LRU eviction) */
export const MAX_CACHED_TEAMS = 50;

/** Max cached team tasks and inbox messages (LRU eviction).
 * Used for both teamTasks and inboxCache maps. */
export const MAX_CACHED_TASKS = 200;
