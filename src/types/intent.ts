/**
 * @fileoverview Read My Mind intent types.
 *
 * An intent profile is per CASE (owner + workingDir), not per session:
 * intentions outlive `/clear`, respawn cycles, and individual sessions.
 * See `docs/readmymind-plan.md`.
 */

/** One captured user prompt, as it appeared in the session transcript. */
export interface IntentPromptEntry {
  /** Capture time (ms epoch). */
  ts: number;
  /** Codeman session the prompt was sent in. */
  sessionId: string;
  /** The prompt text, sanitized and bounded. */
  text: string;
}

/** Per-case profile of what the user is trying to accomplish. */
export interface IntentProfile {
  /** Stable key: sha256(owner + ':' + realpath(workingDir)), first 16 hex chars. */
  key: string;
  /** The case working directory the profile belongs to (realpath-resolved). */
  workingDir: string;
  /** Last mutation (ms epoch). 0 for a never-persisted empty profile. */
  updatedAt: number;
  /** User/agent-stated goals, freeform markdown, bounded. */
  goals: string;
  /** Most recent captured prompts, oldest first, FIFO-capped. */
  recentPrompts: IntentPromptEntry[];
}
