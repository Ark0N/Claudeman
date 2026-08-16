/**
 * @fileoverview Shared types for the `codeman tui` pure core.
 *
 * The TUI is a client of the server, never a second brain: its rows are the
 * rows `GET /api/sessions/unified` already returns (`UnifiedSessionItem`) and
 * its blocked states are the items `GET /api/approvals` already parsed
 * (`ApprovalItem`). Both are imported as TYPES only, so nothing here pulls the
 * server, node-pty or the utils barrel into a CLI process.
 *
 * Everything in `src/tui/*` except `tui-app.ts` / `tui-client.ts` is pure:
 * deterministic outputs from inputs, no `process.*`, no timers, no IO.
 *
 * @module tui/tui-types
 */

import type { UnifiedSessionItem } from '../services/unified-session-service.js';
import type { ApprovalItem } from '../web/approval-inbox.js';

/**
 * A unified-list row plus the few live-only extras the dashboard shows.
 *
 * The unified list is the spine (it is the only source that carries history
 * rows), but it has no token counters and no turn-start stamp, so the client
 * merges those from the live session payload (`GET /api/sessions` /
 * `session_updated` SSE) when a row is live. History rows simply lack them.
 */
export interface TuiSessionRow extends UnifiedSessionItem {
  /**
   * Wall-clock ms of the pane's last Enter (`SessionState.lastSubmitAt`). The
   * only usable "working since" anchor: a working pane repaints about once a
   * second, so its `lastActivityAt` is always "now".
   */
  lastSubmitAt?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Row state, in the web UI's vocabulary so both surfaces read the same.
 *
 * There is deliberately no `error` member: an errored session is something a
 * human has to look at, so it classifies as `waiting` and lands in NEEDS YOU
 * rather than growing a fifth color nobody designed.
 */
export type TuiSessionState = 'blocked-question' | 'blocked-permission' | 'waiting' | 'working' | 'idle' | 'recent';

/** The four display groups, in display order. */
export type TuiGroupKey = 'needs-you' | 'working' | 'idle' | 'recent';

/** A classified session: what the cursor moves over and the renderer paints. */
export interface TuiRow {
  session: TuiSessionRow;
  state: TuiSessionState;
  group: TuiGroupKey;
  /** The pending prompt that blocks this session, when it has one. */
  approval?: ApprovalItem;
  /** Epoch ms the session entered `state`; the intra-group sort key. 0 when unknown. */
  since: number;
}

export interface TuiGroup {
  key: TuiGroupKey;
  label: string;
  rows: TuiRow[];
}

/** How the client currently sees the server. */
export type TuiConnectionStatus = 'connected' | 'reconnecting' | 'degraded' | 'down';

/** Which overlay (if any) owns the keyboard. */
export type TuiUiMode = 'list' | 'help' | 'confirm-kill' | 'prompt' | 'search' | 'message';

/**
 * Glyph capability tier. Detection is env-driven and therefore lives in a tiny
 * function the app layer calls (`detectGlyphTier`); the renderer only ever
 * takes the resolved tier as an input.
 */
export type TuiGlyphTier = 'nerd' | 'unicode' | 'ascii';

/** Header facts, all optional: the header degrades to just the product name. */
export interface TuiHeaderInfo {
  hostname?: string;
  instance?: string;
  version?: string;
  /** Plan-usage chip text, e.g. `5h 32% · wk 61%`. */
  planUsage?: string;
}

/** The selected session's terminal tail, already run through `toDisplayLines()`. */
export interface TuiPreview {
  sessionId: string;
  /** Display lines, oldest first. */
  lines: string[];
  /** Set instead of lines when the tail could not be fetched. */
  error?: string;
}

export interface TuiMessage {
  text: string;
  tone: 'info' | 'warn' | 'err';
}

/** Typed-confirmation state for `x` (kill): the user retypes the session name. */
export interface TuiConfirmState {
  sessionId: string;
  name: string;
  typed: string;
}

/**
 * What `renderFrame()` reads. The store implements it; a test can hand-build
 * one, which is what keeps the renderer testable without the model.
 */
export interface TuiRenderModel {
  groups(): TuiGroup[];
  readonly selectedId: string | null;
  readonly connection: TuiConnectionStatus;
  readonly mode: TuiUiMode;
  readonly header: TuiHeaderInfo;
  readonly preview: TuiPreview | null;
  readonly message: TuiMessage | null;
  readonly confirm: TuiConfirmState | null;
  /** Live sessions only (RECENT rows are history, not sessions you have open). */
  readonly sessionCount: number;
}
