/**
 * @fileoverview Cross-session federated search types (COD-9).
 *
 * Defines the typed shapes for `GET /api/search` — a bounded, in-memory
 * federated search across three v1 sources: live sessions/cases, run-summary
 * timeline events, and per-session attachment file paths. Terminal-buffer scans
 * and any persisted index are explicitly out of scope for v1.
 *
 * Key exports:
 * - SearchSourceType — the federated source kinds, also the group order key.
 * - SearchResult — a single typed result card (source, session id/name,
 *   timestamp, snippet, jump-to action target).
 * - SearchJumpTarget — where the frontend should navigate when a card is opened.
 * - SearchResponseData — grouped result payload returned in the ApiResponse envelope.
 *
 * No I/O, no dependencies on other domain modules. The pure search core lives
 * in `src/search-service.ts`; the route wrapper in `src/web/routes/search-routes.ts`.
 */

/** Federated source kinds. Group/render order is sessions → events → files. */
export type SearchSourceType = 'session' | 'event' | 'file';

/** Where the frontend should jump when a result card is activated. */
export interface SearchJumpTarget {
  /**
   * Kind of navigation target. `resume-session` marks a session that is no longer
   * running: selecting it has to REPLAY the conversation rather than switch to a
   * tab that does not exist.
   */
  kind: 'session' | 'run-summary' | 'file-preview' | 'resume-session';
  /** Owning Codeman session id (always present — every result is session-scoped). */
  sessionId: string;
  /**
   * Secondary identifier for the target:
   * - kind 'run-summary': the run-summary event id
   * - kind 'file-preview': the attachment history item id
   * - kind 'session' / 'resume-session': undefined (the sessionId is sufficient)
   */
  targetId?: string;
  /**
   * Workspace-relative path for file-preview targets. Never an absolute path —
   * server-private external paths are intentionally omitted to avoid leakage.
   */
  relativePath?: string;
  /**
   * `resume-session` only: the Claude conversation UUID to resume, when it differs
   * from the Codeman session id (resumed and `/clear`-respawned sessions).
   */
  claudeSessionId?: string;
  /**
   * `resume-session` only: the directory to resume in. Already visible in the
   * result snippet for session rows, so this exposes nothing new.
   */
  workingDir?: string;
}

/** A single typed search result card. */
export interface SearchResult {
  /** Which federated source produced this result. */
  type: SearchSourceType;
  /** Owning Codeman session id. */
  sessionId: string;
  /** Display name of the owning session / case. */
  sessionName: string;
  /** Millisecond timestamp used for recency ranking and display. */
  timestamp: number;
  /** Short, already-truncated snippet describing the match. */
  snippet: string;
  /** True when the query matched the primary name/path exactly (case-insensitive). */
  exactMatch: boolean;
  /** Navigation target for the jump-to action. */
  jumpTo: SearchJumpTarget;
}

/** A group of results for one source type, in render order. */
export interface SearchResultGroup {
  type: SearchSourceType;
  results: SearchResult[];
}

/** Payload returned as `data` inside the standard ApiResponse envelope. */
export interface SearchResponseData {
  /** The normalized query that was executed. */
  query: string;
  /** Results grouped by source type, ordered sessions → events → files. */
  groups: SearchResultGroup[];
  /** Total number of results across all groups (after caps applied). */
  totalResults: number;
  /** True if any group or the total was capped (more matches existed). */
  truncated: boolean;
}
