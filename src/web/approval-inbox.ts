/**
 * @fileoverview Approvals Inbox: server-side registry of prompts waiting on a human.
 *
 * One cross-session queue of pending Claude prompts (permission dialogs,
 * AskUserQuestion/elicitation questions, idle prompts), fed by `/api/hook-event`
 * and answered via `POST /api/approvals/:id/answer`. Before this store existed,
 * pending prompts lived only in `app.js` memory (SSE-transient, lost on reload)
 * and the push notification Approve/Deny buttons had nothing to act on.
 * Design: `docs/approvals-inbox-plan.md`.
 *
 * Invariants:
 * - At most ONE active item per session: the Claude TUI shows one dialog at a
 *   time, so a new prompt supersedes the session's previous item.
 * - Module-level singleton in the style of `session-wait-registry.ts`: no
 *   `Session` import, no IO; the server injects emit callbacks (`onPending`/
 *   `onUpdated`/`onResolved`), which keeps this unit-testable and cycle-free.
 * - Items are in-memory only. A server restart drops them; the next prompt
 *   re-fires the hook. Claude-mode sessions only (hooks fire for nothing else).
 * - Answer flow is take-then-write: `take()` removes the item BEFORE keystrokes
 *   are sent so a double-tap cannot double-send; `restore()` re-inserts on a
 *   failed write unless a newer prompt arrived meanwhile.
 * - Acknowledgement (`acknowledge()`, idle items only) is NOT resolution: the
 *   item stays pending, it just stops arming the tab alert on every client.
 *
 * @dependencies utils (stripAnsi)
 * @consumedby web/routes/hook-event-routes (notePrompt/resolve), web/routes/approval-routes,
 *   web/session-listener-wiring (working/exit resolution), web/server (emit callbacks + stop)
 *
 * @module web/approval-inbox
 */

import { stripAnsi } from '../utils/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ApprovalKind = 'permission' | 'question' | 'idle';

export type ApprovalResolution =
  | 'answered'
  | 'resolved_in_terminal'
  | 'superseded'
  | 'session_ended'
  | 'dismissed'
  | 'expired';

/** A numbered choice parsed from the captured dialog frame. */
export interface ApprovalOption {
  n: number;
  label: string;
}

export interface ApprovalItem {
  /** `${sessionId}:${seq}`, stable across re-captures, unique per prompt. */
  id: string;
  sessionId: string;
  sessionName: string;
  kind: ApprovalKind;
  createdAt: number;
  /** Sanitized hook fields (already bounded by sanitizeHookData). */
  toolName?: string;
  toolSummary?: string;
  message?: string;
  cwd?: string;
  /** ANSI-stripped tail of the visible pane frame at capture time. */
  context?: string;
  /**
   * Set when a human looked at the session (the web UI selecting its tab). The
   * item stays PENDING and answerable, only its tab alert is spent: clients
   * skip re-arming the alert for an acknowledged item when they seed from
   * `GET /api/approvals`, which is what makes "I checked it" survive a reload
   * and reach the user's other devices. See `acknowledge()`.
   */
  acknowledgedAt?: number;
  /**
   * Present only when the frame parsed confidently. Gates which digits the
   * answer endpoint accepts; absent → only approve('1')/deny(Esc) are allowed.
   */
  options?: ApprovalOption[];
}

export interface ApprovalResolvedInfo {
  id: string;
  sessionId: string;
  kind: ApprovalKind;
  resolution: ApprovalResolution;
}

interface NotePromptArgs {
  sessionId: string;
  sessionName: string;
  kind: ApprovalKind;
  toolName?: string;
  toolSummary?: string;
  message?: string;
  cwd?: string;
  /** Returns the raw (ANSI-bearing) pane frame, or null when unavailable. */
  capture?: () => string | null;
}

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Items older than this are dropped on read: a 12h-old dialog is stale by any measure. */
const ITEM_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * The Notification hook can fire before Ink finishes painting the dialog, so a
 * single delayed re-capture picks up the frame the immediate capture missed.
 */
const RECAPTURE_DELAY_MS = 600;
/** Context kept per item: enough for a dialog plus a few lines above it. */
const MAX_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_LINES = 30;
const MAX_OPTION_LABEL_CHARS = 120;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The visible-frame tmux capture (`formatPaneSnapshot`) carries NO newlines: it
 * repaints every row at its absolute position via `ESC[<row>;<col>H`. Verified
 * against a live dialog: without this conversion the whole frame collapses to
 * one line and no dialog ever parses. Column 1 (or omitted) means a fresh row →
 * newline; a mid-row jump becomes a space so adjacent words don't merge.
 */
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_PATTERN = /\x1b\[(?:(\d+)(?:;(\d+))?)?[Hf]/g;

/**
 * Normalize a raw pane capture into card context: convert row repaints to
 * lines, strip ANSI, right-trim lines, drop trailing blanks, keep the last
 * MAX_CONTEXT_LINES lines.
 */
export function normalizeCapturedFrame(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const rowed = raw.replace(CURSOR_POSITION_PATTERN, (_m, _row, col) => (!col || col === '1' ? '\n' : ' '));
  const lines = stripAnsi(rowed)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  if (lines.length === 0) return undefined;
  const text = lines.slice(-MAX_CONTEXT_LINES).join('\n');
  return text.length > MAX_CONTEXT_CHARS ? text.slice(-MAX_CONTEXT_CHARS) : text;
}

/**
 * Parse the numbered options of a Claude dialog out of a normalized frame.
 *
 * Matches the shapes Ink renders for permission prompts and AskUserQuestion:
 *
 *     ❯ 1. Yes                                 ❯ 1. Red
 *       2. Yes, allow all edits (shift+tab)        Prefer red
 *       3. No, tell Claude what to do (esc)      2. Blue
 *                                                  Prefer blue
 *
 * Options must be consecutively numbered from 1 (2..6 of them); description /
 * wrap / separator lines between options are tolerated up to a small gap
 * (AskUserQuestion puts a description under every option and a ─ separator
 * before its "Chat about this" entry, measured against the live dialog). The
 * LAST complete block in the frame wins (dialogs render at the bottom).
 * Returns undefined when nothing parses; callers then fall back to
 * approve/deny only, so a mis-parse can never route a digit at a dialog that
 * does not have it.
 */
export function parseDialogOptions(context: string | undefined): ApprovalOption[] | undefined {
  if (!context) return undefined;
  const lines = context.split('\n');
  let lastComplete: ApprovalOption[] | undefined;
  let run: ApprovalOption[] = [];
  let gap = 0;
  const commit = () => {
    if (run.length >= 2 && run.length <= 6) lastComplete = run;
    run = [];
    gap = 0;
  };
  for (const line of lines) {
    const m = line.match(/^\s*(?:❯\s*)?(\d)[.)]\s+(.+)$/);
    const n = m ? Number(m[1]) : NaN;
    if (m && n === run.length + 1) {
      run.push({ n, label: m[2].trim().slice(0, MAX_OPTION_LABEL_CHARS) });
      gap = 0;
    } else if (m && n === 1) {
      commit();
      run = [{ n: 1, label: m[2].trim().slice(0, MAX_OPTION_LABEL_CHARS) }];
    } else if (run.length > 0 && ++gap > 3) {
      // Too far past the last option for this to still be its description:
      // the block is over.
      commit();
    }
  }
  commit();
  return lastComplete;
}

// ─── Registry ────────────────────────────────────────────────────────────────

export class ApprovalInbox {
  /** Keyed by sessionId; the one-active-item-per-session invariant lives here. */
  private items = new Map<string, ApprovalItem>();
  private recaptureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Capture callbacks kept for answer-time re-verification; dropped on remove. */
  private captures = new Map<string, () => string | null>();
  private seq = 0;
  private stopped = false;

  /** Emit callbacks, injected by the server (SSE broadcast + push). */
  onPending?: (item: ApprovalItem) => void;
  onUpdated?: (item: ApprovalItem) => void;
  onResolved?: (info: ApprovalResolvedInfo) => void;

  /**
   * Record a prompt for a session, superseding any previous item, and return
   * the new item. Captures context immediately and once more after a short
   * delay (see RECAPTURE_DELAY_MS).
   */
  notePrompt(args: NotePromptArgs): ApprovalItem {
    this.resolveForSession(args.sessionId, 'superseded');
    const item: ApprovalItem = {
      id: `${args.sessionId}:${++this.seq}`,
      sessionId: args.sessionId,
      sessionName: args.sessionName,
      kind: args.kind,
      createdAt: Date.now(),
      toolName: args.toolName,
      toolSummary: args.toolSummary,
      message: args.message,
      cwd: args.cwd,
    };
    this.applyCapture(item, args.capture);
    this.items.set(args.sessionId, item);
    if (args.capture) this.captures.set(args.sessionId, args.capture);
    this.onPending?.(item);
    if (args.capture && !this.stopped) {
      const timer = setTimeout(() => {
        this.recaptureTimers.delete(item.id);
        // Only update the item if it is still the live one for the session.
        if (this.items.get(args.sessionId)?.id !== item.id) return;
        this.applyCapture(item, args.capture);
        this.onUpdated?.(item);
      }, RECAPTURE_DELAY_MS);
      this.recaptureTimers.set(item.id, timer);
    }
    return item;
  }

  /**
   * Answer-time guard: re-capture the pane and check the dialog is still on
   * screen before keystrokes are sent at it. Only conclusive when the ORIGINAL
   * frame parsed options: if a fresh capture then parses none, the dialog is
   * gone (answered in the terminal moments ago), so the item resolves and the
   * answer must be refused, because the digit would land in whatever now has
   * focus. Unparseable-from-the-start items stay answerable (approve/deny
   * only), same risk the terminal user already carries.
   */
  verifyStillAnswerable(id: string): boolean {
    const item = this.getById(id);
    if (!item) return false;
    if (item.kind === 'idle' || !item.options) return true;
    const capture = this.captures.get(item.sessionId);
    if (!capture) return true;
    let raw: string | null = null;
    try {
      raw = capture();
    } catch {
      return true; // capture hiccup: inconclusive, keep the item answerable
    }
    const context = normalizeCapturedFrame(raw);
    if (!context) return true;
    const options = parseDialogOptions(context);
    if (!options) {
      this.remove(item, 'resolved_in_terminal');
      return false;
    }
    item.context = context;
    item.options = options;
    return true;
  }

  /** Pending item for a session, TTL-checked. */
  getForSession(sessionId: string): ApprovalItem | undefined {
    const item = this.items.get(sessionId);
    if (!item) return undefined;
    if (this.isExpired(item)) {
      this.resolveForSession(sessionId, 'expired');
      return undefined;
    }
    return item;
  }

  /** Pending item by id, TTL-checked. */
  getById(id: string): ApprovalItem | undefined {
    const item = this.getForSession(sessionIdOf(id));
    return item?.id === id ? item : undefined;
  }

  /** All pending items, TTL-swept, oldest first. */
  listPending(): ApprovalItem[] {
    for (const sessionId of [...this.items.keys()]) this.getForSession(sessionId);
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Remove the item as `answered` and return it, or undefined if it is no
   * longer pending. Callers send keystrokes AFTER a successful take, and
   * `restore()` on a failed write.
   */
  take(id: string): ApprovalItem | undefined {
    const item = this.getById(id);
    if (!item) return undefined;
    this.remove(item, 'answered');
    return item;
  }

  /** Re-insert a taken item after a failed write, unless superseded meanwhile. */
  restore(item: ApprovalItem): void {
    if (this.stopped || this.items.has(item.sessionId)) return;
    this.items.set(item.sessionId, item);
    this.onPending?.(item);
  }

  /**
   * Mark a session's pending item as SEEN by a human, and return it (undefined
   * when there is nothing to acknowledge or it is already acknowledged). The
   * item is NOT resolved: an idle prompt a human glanced at is still unanswered,
   * so it stays in the inbox, stays answerable, and stays available as Read My
   * Mind context. Only the tab alert it armed is spent.
   *
   * ⚠️ `kinds` defaults to `['idle']` and callers must keep it that narrow:
   * looking at a permission/question dialog does not answer it, so the red
   * "needs you" alert has to survive being viewed.
   */
  acknowledge(sessionId: string, kinds: ApprovalKind[] = ['idle']): ApprovalItem | undefined {
    const item = this.getForSession(sessionId);
    if (!item || !kinds.includes(item.kind) || item.acknowledgedAt) return undefined;
    item.acknowledgedAt = Date.now();
    if (!this.stopped) this.onUpdated?.(item);
    return item;
  }

  /** Remove an item without keystrokes (user chose Dismiss). */
  dismiss(id: string): boolean {
    const item = this.getById(id);
    if (!item) return false;
    this.remove(item, 'dismissed');
    return true;
  }

  /**
   * Resolve a session's pending item, if any (stop hook, exit, ...). `kinds`
   * restricts which item kinds the signal may clear: the heuristic `working`
   * transition passes `['idle']` so a mid-turn flap cannot false-clear a
   * pending permission/question dialog.
   */
  resolveForSession(sessionId: string, resolution: ApprovalResolution, kinds?: ApprovalKind[]): void {
    const item = this.items.get(sessionId);
    if (!item) return;
    if (kinds && !kinds.includes(item.kind)) return;
    this.remove(item, resolution);
  }

  /** Clear all timers (shutdown/tests). Items become inert; no events fire after this. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.recaptureTimers.values()) clearTimeout(timer);
    this.recaptureTimers.clear();
    this.items.clear();
    this.captures.clear();
  }

  private applyCapture(item: ApprovalItem, capture?: () => string | null): void {
    if (!capture) return;
    let raw: string | null = null;
    try {
      raw = capture();
    } catch {
      // Capture is best-effort; the card still renders from hook fields.
    }
    const context = normalizeCapturedFrame(raw);
    if (!context) return;
    item.context = context;
    // Idle prompts are not dialogs; never offer digit answers for them.
    if (item.kind !== 'idle') item.options = parseDialogOptions(context);
  }

  private remove(item: ApprovalItem, resolution: ApprovalResolution): void {
    this.items.delete(item.sessionId);
    this.captures.delete(item.sessionId);
    const timer = this.recaptureTimers.get(item.id);
    if (timer) {
      clearTimeout(timer);
      this.recaptureTimers.delete(item.id);
    }
    if (!this.stopped) {
      this.onResolved?.({ id: item.id, sessionId: item.sessionId, kind: item.kind, resolution });
    }
  }

  private isExpired(item: ApprovalItem): boolean {
    return Date.now() - item.createdAt > ITEM_TTL_MS;
  }
}

function sessionIdOf(itemId: string): string {
  return itemId.slice(0, itemId.lastIndexOf(':'));
}

/** Process-wide singleton, mirroring `sessionWaits`. */
export const approvalInbox = new ApprovalInbox();
