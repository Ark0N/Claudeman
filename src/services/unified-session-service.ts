/**
 * @fileoverview Pure merge/filter logic for the unified session list (COD-121).
 *
 * Combines four read-only views of a session — live (in-memory `Session`),
 * persisted (`state.json`), transcript history (`~/.claude/projects`), and the
 * lifecycle audit log — plus mux process stats, into one de-duplicated list
 * keyed by sessionId. Higher-precedence sources overwrite scalar fields when
 * present (history < lifecycle < persisted < live), while the `sources` array
 * always accumulates every contributing view. A "meaningfulness floor" drops
 * noise (bare lifecycle/mux-only rows with no name and no first prompt).
 *
 * PURE: no fs/IO and no node imports. All IO happens in the route that feeds
 * this module its inputs, which keeps the merge/sort/filter behavior unit-testable.
 */

export type UnifiedSessionItem = {
  sessionId: string;
  name?: string;
  mode?: string;
  status?: string;
  isWorking?: boolean;
  workingDir?: string;
  createdAt?: number;
  lastActivityAt?: number;
  claudeSessionId?: string;
  firstPrompt?: string;
  sizeBytes?: number;
  remote?: boolean;
  sources: string[];
  stats?: { memoryMB: number; cpuPercent: number };
};

/** Live in-memory session view (subset of `Session.toState()`). */
export type LiveSessionInput = {
  id: string;
  name?: string;
  mode?: string;
  status?: string;
  isWorking?: boolean;
  workingDir?: string;
  createdAt?: number;
  lastActivityAt?: number;
  claudeSessionId?: string;
};

/** Persisted session view (subset of `SessionState`). */
export type PersistedSessionInput = {
  id: string;
  name?: string;
  mode?: string;
  status?: string;
  workingDir?: string;
  createdAt?: number;
  lastActivityAt?: number;
};

/** Lifecycle audit-log view. */
export type LifecycleInput = {
  sessionId: string;
  name?: string;
  mode?: string;
  ts: number;
  event?: string;
};

/** Transcript-history view (one `.jsonl` per session). */
export type HistoryInput = {
  sessionId: string;
  workingDir: string;
  sizeBytes: number;
  lastModified: string;
  firstPrompt?: string;
};

/** Mux process-stat view. */
export type MuxStatInput = {
  sessionId: string;
  muxName?: string;
  mode?: string;
  stats?: { memoryMB: number; cpuPercent: number };
  remote?: boolean;
};

export type UnifiedSources = {
  live?: LiveSessionInput[];
  persisted?: PersistedSessionInput[];
  lifecycle?: LifecycleInput[];
  history?: HistoryInput[];
  mux?: MuxStatInput[];
};

/** Push a source tag onto an item exactly once. */
function addSource(item: UnifiedSessionItem, source: string): void {
  if (!item.sources.includes(source)) item.sources.push(source);
}

/** Get-or-create the accumulator item for a sessionId. */
function ensureItem(map: Map<string, UnifiedSessionItem>, sessionId: string): UnifiedSessionItem {
  let item = map.get(sessionId);
  if (!item) {
    item = { sessionId, sources: [] };
    map.set(sessionId, item);
  }
  return item;
}

/** Overwrite a scalar field only when the incoming value is defined. */
function overwrite<K extends keyof UnifiedSessionItem>(
  item: UnifiedSessionItem,
  key: K,
  value: UnifiedSessionItem[K] | undefined
): void {
  if (value !== undefined) item[key] = value;
}

/**
 * Merge all source views into one list, applying precedence
 * (history → lifecycle → persisted → live) and the meaningfulness floor.
 */
export function mergeUnifiedSessions(sources: UnifiedSources): UnifiedSessionItem[] {
  const map = new Map<string, UnifiedSessionItem>();

  // 1) history (lowest precedence)
  for (const h of sources.history ?? []) {
    const item = ensureItem(map, h.sessionId);
    addSource(item, 'history');
    overwrite(item, 'workingDir', h.workingDir);
    overwrite(item, 'sizeBytes', h.sizeBytes);
    overwrite(item, 'firstPrompt', h.firstPrompt);
    const ms = Date.parse(h.lastModified);
    if (!Number.isNaN(ms) && item.lastActivityAt === undefined) item.lastActivityAt = ms;
  }

  // 2) lifecycle
  for (const l of sources.lifecycle ?? []) {
    const item = ensureItem(map, l.sessionId);
    addSource(item, 'lifecycle');
    overwrite(item, 'name', l.name);
    overwrite(item, 'mode', l.mode);
    if (item.lastActivityAt === undefined && typeof l.ts === 'number') item.lastActivityAt = l.ts;
  }

  // 3) persisted
  for (const p of sources.persisted ?? []) {
    const item = ensureItem(map, p.id);
    addSource(item, 'persisted');
    overwrite(item, 'name', p.name);
    overwrite(item, 'mode', p.mode);
    overwrite(item, 'status', p.status);
    overwrite(item, 'workingDir', p.workingDir);
    overwrite(item, 'createdAt', p.createdAt);
    overwrite(item, 'lastActivityAt', p.lastActivityAt);
  }

  // 4) live (highest precedence)
  for (const v of sources.live ?? []) {
    const item = ensureItem(map, v.id);
    addSource(item, 'live');
    overwrite(item, 'name', v.name);
    overwrite(item, 'mode', v.mode);
    overwrite(item, 'status', v.status);
    overwrite(item, 'isWorking', v.isWorking);
    overwrite(item, 'workingDir', v.workingDir);
    overwrite(item, 'createdAt', v.createdAt);
    overwrite(item, 'lastActivityAt', v.lastActivityAt);
    overwrite(item, 'claudeSessionId', v.claudeSessionId);
  }

  // 5) mux stats + remote flag (create item if mux-only)
  for (const m of sources.mux ?? []) {
    const item = ensureItem(map, m.sessionId);
    addSource(item, 'mux');
    overwrite(item, 'mode', m.mode);
    if (m.stats) item.stats = m.stats;
    if (m.remote !== undefined) item.remote = m.remote;
  }

  // Meaningfulness floor: keep real rows, drop bare lifecycle/mux-only noise.
  const kept: UnifiedSessionItem[] = [];
  for (const item of map.values()) {
    const isReal =
      item.sources.includes('live') ||
      item.sources.includes('persisted') ||
      item.sources.includes('history') ||
      (item.firstPrompt !== undefined && item.firstPrompt !== '');
    if (isReal) kept.push(item);
  }

  // Stable sort: lastActivityAt desc (undefined last), createdAt desc, sessionId asc.
  kept.sort((a, b) => {
    const la = a.lastActivityAt;
    const lb = b.lastActivityAt;
    if (la !== lb) {
      if (la === undefined) return 1;
      if (lb === undefined) return -1;
      return lb - la;
    }
    const ca = a.createdAt;
    const cb = b.createdAt;
    if (ca !== cb) {
      if (ca === undefined) return 1;
      if (cb === undefined) return -1;
      return cb - ca;
    }
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  return kept;
}

/**
 * Case-insensitive substring filter (name + firstPrompt + workingDir + sessionId)
 * with offset/limit paging. `total` is the filtered count BEFORE paging.
 */
export function filterAndPaginate(
  items: UnifiedSessionItem[],
  opts: { q?: string; offset?: number; limit?: number }
): { sessions: UnifiedSessionItem[]; total: number } {
  const q = (opts.q ?? '').trim().toLowerCase();
  const filtered = q
    ? items.filter((it) => {
        const hay = [it.name, it.firstPrompt, it.workingDir, it.sessionId]
          .filter((v): v is string => typeof v === 'string')
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
    : items;

  const total = filtered.length;
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)));
  const sessions = filtered.slice(offset, offset + limit);
  return { sessions, total };
}
