/**
 * @fileoverview Bounded in-memory index of PAST sessions, harvested by `GET /api/search`.
 *
 * `GET /api/search` used to build its session corpus from the live in-memory
 * session map alone, so a folder sitting in the home screen's "Resume
 * Conversation" list matched nothing (issue #261). The corpus that list renders
 * comes from `GET /api/sessions/unified`, which reads the lifecycle log and every
 * Claude transcript file — disk I/O the search path deliberately does not do
 * (its no-fs property is what keeps a per-keystroke query cheap and traversal-free).
 *
 * This module is the seam between the two: a capped snapshot of the unified list
 * that the search route reads synchronously, refreshed OUT of the request path.
 * Two things fill it:
 *   1. `/api/sessions/unified` writes it as a side effect (free — it just merged
 *      that list). The home screen calls that endpoint whenever it opens, which
 *      is the same screen the search box lives on, so it is warm in practice.
 *   2. `ensureHistorySessionIndexFresh()` — fire-and-forget, single-flight,
 *      TTL-guarded — kicks the registered refresher when a search finds the
 *      snapshot stale. The caller never awaits it: the current query answers from
 *      the existing snapshot and the next one sees fresh data.
 *
 * OWNERSHIP: each item carries the `owner` of the session it came from, and rows
 * not tied to any live/persisted session (host-wide transcript history) carry
 * `owner: undefined`. `canAccessOwned()` then reproduces the unified route's rule
 * exactly — in multi-user mode a non-admin sees neither other users' sessions nor
 * unowned host-wide history, and in single-user mode every check short-circuits
 * true. The snapshot is written UNSCOPED, so it must never be returned unfiltered.
 *
 * Key exports:
 * - setHistorySessionIndex / getHistorySessionIndex — the snapshot accessors.
 * - buildHistorySessionIndexItems — pure merged-list → index-item projection.
 * - setHistoryIndexRefresher / ensureHistorySessionIndexFresh — the refresh hook.
 */

/** One past-session row in the snapshot. Mirrors what the search corpus needs, nothing more. */
export interface HistorySessionIndexItem {
  /** Codeman session id (the search result's session id and dedupe key). */
  sessionId: string;
  /** Display name, may be empty for a transcript-only row. */
  name: string;
  /** Absolute working directory — the field issue #261 is about matching. */
  workingDir: string;
  /** Claude conversation UUID, when known: what a resume actually replays. */
  claudeSessionId?: string;
  /** Recency timestamp (lastActivityAt, else createdAt). */
  timestamp: number;
  /**
   * Owning user, when the row is tied to a live or persisted session. `undefined`
   * means host-wide transcript history, which only admins (or single-user mode)
   * may see — the same rule `/api/sessions/unified` applies.
   */
  owner?: string;
  /** True when the session is still in the live map (search harvests those directly). */
  live: boolean;
}

/** Hard cap on snapshot size, so a host with thousands of transcripts stays bounded. */
export const HISTORY_INDEX_MAX_ITEMS = 400;

/** How long a snapshot is considered fresh before a search triggers a background refresh. */
export const HISTORY_INDEX_TTL_MS = 60_000;

interface HistorySessionIndexSnapshot {
  items: HistorySessionIndexItem[];
  /** Epoch ms of the last write; 0 when never populated. */
  updatedAt: number;
}

let snapshot: HistorySessionIndexSnapshot = { items: [], updatedAt: 0 };
let refresher: (() => Promise<void>) | null = null;
let refreshInFlight = false;

/** The merged-list shape this module projects from (a subset of `UnifiedSessionItem`). */
export interface MergedSessionLike {
  sessionId: string;
  name?: string;
  workingDir?: string;
  claudeSessionId?: string;
  createdAt?: number;
  lastActivityAt?: number;
}

/**
 * Project a merged unified list into index items. PURE — the caller supplies the
 * owner lookup and the live-id set it already has in hand.
 *
 * Rows with no working directory AND no name are dropped: they can never match a
 * query in a useful way and would only consume the cap.
 *
 * @param merged unified-list items, newest-first (the order the merge returns)
 * @param ownerById owner of a session id, for rows tied to a live/persisted session
 * @param liveIds session ids currently in the live map
 */
export function buildHistorySessionIndexItems(
  merged: MergedSessionLike[],
  ownerById: Map<string, string | undefined>,
  liveIds: Set<string>
): HistorySessionIndexItem[] {
  const items: HistorySessionIndexItem[] = [];
  for (const m of merged) {
    if (items.length >= HISTORY_INDEX_MAX_ITEMS) break;
    const name = m.name ?? '';
    const workingDir = m.workingDir ?? '';
    if (!name && !workingDir) continue;
    items.push({
      sessionId: m.sessionId,
      name,
      workingDir,
      claudeSessionId: m.claudeSessionId,
      timestamp: m.lastActivityAt ?? m.createdAt ?? 0,
      owner: ownerById.get(m.sessionId),
      live: liveIds.has(m.sessionId),
    });
  }
  return items;
}

/** Replace the snapshot. Items are capped defensively even if the caller already did. */
export function setHistorySessionIndex(items: HistorySessionIndexItem[], now = Date.now()): void {
  snapshot = { items: items.slice(0, HISTORY_INDEX_MAX_ITEMS), updatedAt: now };
}

/**
 * Read the snapshot. The returned array is UNSCOPED — callers must apply the
 * per-item ownership check before exposing any of it.
 */
export function getHistorySessionIndex(): HistorySessionIndexSnapshot {
  return snapshot;
}

/** True when the snapshot has never been written, or is older than the TTL. */
export function isHistorySessionIndexStale(now = Date.now(), ttlMs = HISTORY_INDEX_TTL_MS): boolean {
  return snapshot.updatedAt === 0 || now - snapshot.updatedAt > ttlMs;
}

/**
 * Register the rebuild function. Called once by the session routes, which own the
 * transcript scanner and the stores the unified list is merged from.
 */
export function setHistoryIndexRefresher(fn: (() => Promise<void>) | null): void {
  refresher = fn;
}

/**
 * Kick a background rebuild if the snapshot is stale. Returns immediately —
 * NEVER await this from a request handler, that is the whole point: the search
 * path answers from the current snapshot and stays free of disk I/O.
 */
export function ensureHistorySessionIndexFresh(now = Date.now()): void {
  if (refreshInFlight || !refresher || !isHistorySessionIndexStale(now)) return;
  refreshInFlight = true;
  void refresher()
    .catch(() => {
      // A failed rebuild leaves the previous snapshot in place; the next search retries.
    })
    .finally(() => {
      refreshInFlight = false;
    });
}

/** Test hook: drop the snapshot and any registered refresher. */
export function resetHistorySessionIndex(): void {
  snapshot = { items: [], updatedAt: 0 };
  refresher = null;
  refreshInFlight = false;
}
