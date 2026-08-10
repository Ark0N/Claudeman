/**
 * @fileoverview Cross-session federated search route (COD-9).
 *
 * Registers `GET /api/search?q=&types=&limit=` — a bounded, in-memory search
 * across three v1 sources, returned in the standard ApiResponse envelope:
 *   1. sessions/cases, name, working directory, session id, for LIVE sessions
 *      plus the past-session snapshot in `session-history-index.ts` (issue #261:
 *      the live map alone made every closed session unfindable by folder name)
 *   2. run-summary events — event title/details (from the live run-summary trackers)
 *   3. file paths — per-session attachment history (workspace-relative paths only)
 *
 * This route is a THIN wrapper: it harvests the source arrays from the live
 * server stores (held on the route context) in a bounded way, then delegates
 * grouping/ranking/capping to the pure `searchSources()` core in
 * `src/search-service.ts`. Terminal-buffer scanning and any persisted index are
 * out of scope for v1.
 *
 * Safety: query input is Zod-validated (length-bounded `q`, allowlisted `types`,
 * numeric `limit`); only workspace-relative file paths are ever exposed (the
 * server-private `externalPath` on attachment history is never read here); and
 * the pure core enforces a per-group and total result cap so a broad query
 * cannot return an unbounded payload. No terminal output is read.
 *
 * Endpoints: GET /api/search
 */

import { FastifyInstance } from 'fastify';
import { canAccessOwned, getAuthUser, parseBody } from '../route-helpers.js';
import { SearchQuerySchema } from '../schemas.js';
import {
  searchSources,
  type SearchSources,
  type SessionSearchInput,
  type EventSearchInput,
  type FileSearchInput,
} from '../../search-service.js';
import type { SearchSourceType } from '../../types/search.js';
import type { SessionPort, InfraPort } from '../ports/index.js';
import { ensureHistorySessionIndexFresh, getHistorySessionIndex } from '../session-history-index.js';

/**
 * Per-source harvest caps. These bound how much in-memory data we hand to the
 * pure core BEFORE it applies its own result caps — they keep the harvest itself
 * cheap on large deployments (e.g. 50 sessions × many events). They are
 * deliberately well above the result caps so ranking still sees enough candidates.
 */
const MAX_EVENTS_PER_SESSION = 500;

interface SessionLike {
  id: string;
  name: string;
  workingDir: string;
  lastActivityAt?: number;
  createdAt?: number;
  attachmentHistory?: Array<{
    id: string;
    fileName: string;
    relativePath?: string;
    timestamp?: number;
    mtimeMs?: number;
  }>;
}

/**
 * Harvest the three source arrays from the live in-memory stores. Reads only
 * bounded, already-loaded data — no disk I/O, no terminal buffers.
 *
 * Past sessions come from the `session-history-index` snapshot, which is built
 * outside the request path for exactly that reason. Live rows are harvested
 * first and win the dedupe, so a session that is both live and in the snapshot
 * keeps its live jump-to (switch to the tab) instead of a resume.
 */
function harvestSources(ctx: SessionPort & InfraPort, canSee?: (owner?: string) => boolean): SearchSources {
  const sessions: SessionSearchInput[] = [];
  const events: EventSearchInput[] = [];
  const files: FileSearchInput[] = [];
  const seenSessionIds = new Set<string>();

  for (const raw of ctx.sessions.values()) {
    const s = raw as unknown as SessionLike & { owner?: string };
    if (canSee && !canSee(s.owner)) continue; // multi-user ownership scope
    const sessionName = s.name ?? '';
    const timestamp = s.lastActivityAt ?? s.createdAt ?? 0;

    seenSessionIds.add(s.id);
    sessions.push({
      sessionId: s.id,
      sessionName,
      workingDir: s.workingDir ?? '',
      timestamp,
    });

    // Files: per-session attachment history. Only the workspace-relative path is
    // surfaced; the server-private externalPath is intentionally never read.
    const history = s.attachmentHistory ?? [];
    for (const item of history) {
      files.push({
        sessionId: s.id,
        sessionName,
        fileName: item.fileName,
        relativePath: item.relativePath,
        timestamp: item.timestamp ?? item.mtimeMs ?? timestamp,
        itemId: item.id,
      });
    }
  }

  // Past sessions: the out-of-band snapshot of the unified list. Unscoped on
  // disk, so every row goes through the same ownership check as a live one,
  // host-wide transcript rows carry no owner and are therefore admin-only in
  // multi-user mode, matching GET /api/sessions/unified.
  for (const item of getHistorySessionIndex().items) {
    if (seenSessionIds.has(item.sessionId)) continue;
    if (canSee && !canSee(item.owner)) continue;
    seenSessionIds.add(item.sessionId);
    sessions.push({
      sessionId: item.sessionId,
      sessionName: item.name,
      workingDir: item.workingDir,
      timestamp: item.timestamp,
      history: true,
      claudeSessionId: item.claudeSessionId,
    });
  }

  // Events: from the live run-summary trackers, keyed by session id.
  for (const [sessionId, tracker] of ctx.runSummaryTrackers) {
    const session = ctx.sessions.get(sessionId) as unknown as (SessionLike & { owner?: string }) | undefined;
    if (canSee && !canSee(session?.owner)) continue; // multi-user ownership scope
    const sessionName = session?.name ?? '';
    const summary = tracker.getSummary();
    // Newest events are most relevant; cap the per-session harvest.
    const evts = summary.events.slice(-MAX_EVENTS_PER_SESSION);
    for (const e of evts) {
      events.push({
        sessionId,
        sessionName,
        eventId: e.id,
        title: e.title,
        details: e.details ?? '',
        timestamp: e.timestamp,
      });
    }
  }

  return { sessions, events, files };
}

export function registerSearchRoutes(app: FastifyInstance, ctx: SessionPort & InfraPort): void {
  app.get('/api/search', async (req) => {
    // Zod-validate the query. parseBody throws a structured 400 on failure.
    const { q, types, limit } = parseBody(SearchQuerySchema, req.query);
    const user = getAuthUser(req);
    const canSee = (owner?: string) => canAccessOwned(user, owner);

    const allowed: Set<SearchSourceType> | null = types
      ? new Set(
          types
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean) as SearchSourceType[]
        )
      : null;

    // Fire-and-forget: a stale past-session snapshot is rebuilt in the
    // background. This query still answers from whatever is already in memory,
    // which is what keeps the request path free of disk I/O.
    ensureHistorySessionIndexFresh();

    const sources = harvestSources(ctx, canSee);

    // Apply the optional source-type filter before searching so excluded
    // sources never contribute to (or consume budget in) the result set.
    const filtered: SearchSources = {
      sessions: !allowed || allowed.has('session') ? sources.sessions : [],
      events: !allowed || allowed.has('event') ? sources.events : [],
      files: !allowed || allowed.has('file') ? sources.files : [],
    };

    const result = searchSources(q, filtered);

    // Optional caller-supplied total cap (always on top of the core's hard caps).
    if (limit !== undefined && result.totalResults > limit) {
      let remaining = limit;
      const cappedGroups = [];
      for (const group of result.groups) {
        if (remaining <= 0) break;
        const slice = group.results.slice(0, remaining);
        remaining -= slice.length;
        cappedGroups.push({ type: group.type, results: slice });
      }
      result.groups = cappedGroups;
      result.totalResults = limit;
      result.truncated = true;
    }

    return { success: true, data: result };
  });
}
