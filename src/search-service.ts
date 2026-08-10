/**
 * @fileoverview Pure cross-session federated search core (COD-9).
 *
 * `searchSources()` is the testable heart of `GET /api/search`: it takes a
 * normalized query plus already-collected, in-memory source data and returns
 * grouped, ranked, and capped results. It performs NO I/O — the route wrapper
 * (`src/web/routes/search-routes.ts`) is responsible for harvesting the source
 * arrays from the live server stores (sessions, run-summary trackers, attachment
 * histories) in a bounded way before calling this.
 *
 * v1 scope (do not expand here): three sources — sessions/cases, run-summary
 * events, file paths. Terminal-buffer scanning and any persisted index are
 * explicitly deferred.
 *
 * Ranking: results are grouped by source type in the fixed order
 * sessions → events → files. Within each group, exact (case-insensitive)
 * name/path matches come first, then recency (newest timestamp first) as the
 * tiebreak. There is no relevance-scoring pass in v1.
 *
 * Safety: file results only ever expose a workspace-relative path — server-
 * private absolute paths are never placed in a result. Per-group and total caps
 * bound the output so a broad query cannot return an unbounded payload.
 *
 * Key exports:
 * - searchSources() — the pure core.
 * - SEARCH_TOTAL_CAP / SEARCH_PER_GROUP_CAP — the output bounds.
 * - SearchSources and the *Input row types — the source-data contract.
 */

import type { SearchResult, SearchResultGroup, SearchResponseData, SearchSourceType } from './types/search.js';

/** Maximum results returned across all groups combined. */
export const SEARCH_TOTAL_CAP = 60;
/** Maximum results returned within any single source group. */
export const SEARCH_PER_GROUP_CAP = 25;
/** Maximum characters in a result snippet. */
export const SEARCH_SNIPPET_MAX = 200;

/** A session row harvested for the session/case source (live or past). */
export interface SessionSearchInput {
  sessionId: string;
  sessionName: string;
  workingDir: string;
  /** Recency timestamp (e.g. lastActivityAt or createdAt). */
  timestamp: number;
  /**
   * True for a session that is no longer running (issue #261 — past sessions come
   * from the history index, not the live map). Such a result resumes the
   * conversation instead of switching to a tab that no longer exists.
   */
  history?: boolean;
  /** Claude conversation UUID to resume, when it differs from the Codeman id. */
  claudeSessionId?: string;
}

/** A run-summary timeline event harvested for the event source. */
export interface EventSearchInput {
  sessionId: string;
  sessionName: string;
  eventId: string;
  title: string;
  details: string;
  timestamp: number;
}

/** A per-session attachment harvested for the file source. */
export interface FileSearchInput {
  sessionId: string;
  sessionName: string;
  fileName: string;
  /** Workspace-relative path, if known. Absolute/external paths are never passed in. */
  relativePath: string | undefined;
  timestamp: number;
  /** Attachment history item id, used as the jump-to target. */
  itemId: string;
}

/** The full set of in-memory source data the pure core searches over. */
export interface SearchSources {
  sessions: SessionSearchInput[];
  events: EventSearchInput[];
  files: FileSearchInput[];
}

/** Fixed group/render order. */
const GROUP_ORDER: SearchSourceType[] = ['session', 'event', 'file'];

function truncate(text: string, max = SEARCH_SNIPPET_MAX): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

/**
 * Sort a group's results: exact matches first, then newest timestamp first.
 * Stable for equal keys.
 */
function sortGroup(rows: SearchResult[]): SearchResult[] {
  return rows
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      if (a.result.exactMatch !== b.result.exactMatch) {
        return a.result.exactMatch ? -1 : 1;
      }
      if (a.result.timestamp !== b.result.timestamp) {
        return b.result.timestamp - a.result.timestamp;
      }
      return a.index - b.index;
    })
    .map((r) => r.result);
}

/**
 * Search the provided in-memory sources for `query`.
 *
 * @param query Raw query string (already length-validated by the route). Blank
 *   queries return an empty result set.
 * @param sources Harvested, bounded source arrays.
 */
export function searchSources(query: string, sources: SearchSources): SearchResponseData {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return { query: query.trim(), groups: [], totalResults: 0, truncated: false };
  }

  const contains = (s: string | undefined): boolean => !!s && s.toLowerCase().includes(needle);
  const isExact = (s: string | undefined): boolean => !!s && s.toLowerCase() === needle;

  // -- Source: sessions/cases --
  const sessionRows: SearchResult[] = [];
  for (const s of sources.sessions) {
    if (contains(s.sessionName) || contains(s.workingDir) || contains(s.sessionId)) {
      const label = s.sessionName || s.workingDir.split('/').pop() || s.sessionId;
      sessionRows.push({
        type: 'session',
        sessionId: s.sessionId,
        sessionName: label,
        timestamp: s.timestamp,
        snippet: truncate(s.workingDir ? `${label} — ${s.workingDir}` : label),
        exactMatch: isExact(s.sessionName),
        // A resume needs a directory to run in, so a history row without one
        // stays a plain session target rather than an action that cannot work.
        jumpTo:
          s.history && s.workingDir
            ? {
                kind: 'resume-session',
                sessionId: s.sessionId,
                claudeSessionId: s.claudeSessionId,
                workingDir: s.workingDir,
              }
            : { kind: 'session', sessionId: s.sessionId },
      });
    }
  }

  // -- Source: run-summary events --
  const eventRows: SearchResult[] = [];
  for (const e of sources.events) {
    if (contains(e.title) || contains(e.details)) {
      const snippetBase = e.details && contains(e.details) ? `${e.title}: ${e.details}` : e.title;
      eventRows.push({
        type: 'event',
        sessionId: e.sessionId,
        sessionName: e.sessionName,
        timestamp: e.timestamp,
        snippet: truncate(snippetBase),
        exactMatch: isExact(e.title),
        jumpTo: { kind: 'run-summary', sessionId: e.sessionId, targetId: e.eventId },
      });
    }
  }

  // -- Source: file paths --
  const fileRows: SearchResult[] = [];
  for (const f of sources.files) {
    if (contains(f.fileName) || contains(f.relativePath)) {
      fileRows.push({
        type: 'file',
        sessionId: f.sessionId,
        sessionName: f.sessionName,
        timestamp: f.timestamp,
        snippet: truncate(f.relativePath ?? f.fileName),
        // Exact match keys off the safe path (or filename) — never an absolute path.
        exactMatch: isExact(f.relativePath) || isExact(f.fileName),
        jumpTo: {
          kind: 'file-preview',
          sessionId: f.sessionId,
          targetId: f.itemId,
          // Only ever expose a relative path; absolute/external paths are not passed in.
          relativePath: f.relativePath,
        },
      });
    }
  }

  const byType: Record<SearchSourceType, SearchResult[]> = {
    session: sortGroup(sessionRows),
    event: sortGroup(eventRows),
    file: sortGroup(fileRows),
  };

  const groups: SearchResultGroup[] = [];
  let total = 0;
  let truncated = false;

  for (const type of GROUP_ORDER) {
    const all = byType[type];
    if (all.length === 0) continue;

    // Per-group cap.
    let capped = all.slice(0, SEARCH_PER_GROUP_CAP);
    if (all.length > capped.length) truncated = true;

    // Total cap (never exceed the global budget).
    const remaining = SEARCH_TOTAL_CAP - total;
    if (capped.length > remaining) {
      capped = capped.slice(0, Math.max(0, remaining));
      truncated = true;
    }
    if (capped.length === 0) continue;

    groups.push({ type, results: capped });
    total += capped.length;
  }

  return { query: query.trim(), groups, totalResults: total, truncated };
}
