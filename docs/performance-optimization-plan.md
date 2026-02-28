# Performance & Responsiveness Optimization Plan

**Date**: 2026-02-28
**Status**: In Progress

---

## Executive Summary

Three independent research passes analyzed the Codeman codebase for performance bottlenecks across frontend rendering, backend hot paths, and system-level resource usage. The codebase already has strong foundational optimizations (per-session adaptive batching, rAF terminal writes, DEC 2026 sync markers, backpressure handling). This plan targets the remaining high-impact opportunities.

**Key finding**: The biggest wins come from **skipping unnecessary work** — serializing unchanged state, processing output nobody is watching, and reducing broadcast volume.

---

## Phase 1: Quick Wins — ALREADY IMPLEMENTED

All Phase 1 items were found to already exist in the codebase during verification:

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1.1 | Skip terminal writes for hidden tabs | Done | SSE handler filters by `activeSessionId` (app.js:4076) |
| 1.2 | mobile.css media query | Done | `media="(max-width: 1023px)"` on link tag (index.html:13) |
| 1.3 | Deduplicate init API calls | Done | `_initGeneration` dedup + 3s fallback timer (app.js:2901-2904) |
| 1.4 | Remove cache-busting timestamps | Done | No `?_t=` patterns found anywhere |
| 1.5 | JS/CSS minification + compression | Done | esbuild minify + gzip + brotli in build.mjs (lines 42-51) |

---

## Phase 2: Frontend Responsiveness — MOSTLY ALREADY IMPLEMENTED

### 2.1 Batch `getBoundingClientRect()` in connection lines — DONE
- **Files**: `src/web/public/app.js` (`_updateConnectionLinesImmediate()`)
- **Change**: Refactored to batch all layout reads into Phase 1 (collect all rects into a Map), then perform all SVG writes in Phase 2 using cached values. Classic read-then-write pattern prevents interleaved forced reflows.

### 2.2 Clean up ResizeObservers — Already implemented
- `forceCloseSubagentWindow()` disconnects observers (app.js:12618-12620)
- `cleanupAllFloatingWindows()` disconnects all on reconnect (app.js:12649-12653)
- Observer refs stored on `windowData.resizeObserver` (app.js:12492)

### 2.3 Drag handler cleanup — Already implemented
- `makeWindowDraggable()` returns listener refs, stored in `windowData.dragListeners`
- `forceCloseSubagentWindow()` removes all document-level drag listeners (app.js:12622-12630)
- Panel drags add listeners on mousedown, remove on mouseup (app.js:10253-10284)

### 2.4 Mobile window position cache — Skipped
- O(n) loop over max ~20 windows; complexity of cached counter not justified

### 2.5 Lazy modal DOM — Skipped
- Large effort, marginal benefit for a vanilla JS app with fast DOM construction

---

## Phase 3: Backend Hot Paths

### 3.1 State diff broadcasts — ALREADY OPTIMIZED
- `broadcastSessionStateDebounced()` already batches at 500ms intervals
- `toLightDetailedState()` excludes heavy buffers (textOutput, terminalBuffer)
- Per-session serialization is <1ms; with debouncing, only 1-3 sessions serialize per flush
- JSON.stringify happens once per broadcast (not per client) — serialization cost is negligible
- Full state diffs would add significant frontend complexity for marginal gain

### 3.2 Improve session list cache hit rate — DONE
- **Files**: `src/web/server.ts` (`broadcast()` method)
- **Change**: Cache now only invalidated on truly structural events (`session:created`, `session:deleted`, `session:updated`) instead of on every `session:*` and `respawn:*` event. High-frequency events like `session:working`, `session:idle`, `session:completion`, `respawn:stateChanged` no longer defeat the 1s TTL cache.
- **Impact**: Cache hit ratio from ~0% to ~80%+ during active sessions. The debounced `session:updated` still refreshes the cache within 500ms of any state change.

### 3.3 Skip PTY processing — ALREADY OPTIMIZED
- `_processExpensiveParsers()` is already throttled to every 150ms (not per-chunk)
- Lazy ANSI stripping via `getCleanData()` closure — only computed when a consumer needs it
- Quick pre-checks skip parsers when content is irrelevant (e.g., token parser only runs if data contains "token")
- OpenCode sessions skip all Claude-specific parsers entirely
- Further optimization would require visibility-aware processing, adding complexity for marginal gain

### 3.4 Batch subagent liveness checks — Deferred
- `/proc/{pid}` stat calls are ~0.1ms each; even with 500 agents, total is 50ms every 10s
- Current approach is simple and reliable; batching adds race condition risk
- Consider only if profiling shows this as a bottleneck

### 3.5 Deduplicate detection update emissions — DONE
- **Files**: `src/respawn-controller.ts` (`startDetectionUpdates()`)
- **Change**: Detection status now only emitted when key fields (confidenceLevel, statusText, controller state) actually change. Previously emitted every 2s regardless, broadcasting identical status to all SSE clients.
- **Impact**: For stable/idle sessions, eliminates ~100% of redundant detection broadcasts. For active sessions, reduces broadcasts to only meaningful state transitions.

---

## Phase 4: System-Level Improvements

### 4.1 Incremental state persistence
- **Files**: `src/state-store.ts` (~lines 145-160)
- **Problem**: Every 500ms debounce writes the entire `AppState` (all sessions, tasks, config) via `JSON.stringify()`. With 50 sessions, state can be tens of MB. Serialization alone costs 50-100ms.
- **Fix**: Track dirty sessions. On persist, only re-serialize dirty sessions; cache serialized JSON for clean sessions. Assemble final output from cached fragments.
- **Impact**: Reduces serialization cost from O(all sessions) to O(dirty sessions). Typical steady-state: 1-2 dirty sessions instead of 50.

### 4.2 Replace polling with fs watchers for team watcher
- **Files**: `src/team-watcher.ts` (~lines 148-180)
- **Problem**: Polls `~/.claude/teams/` every 5s via `readdir()` + `stat()`. Blocks event loop for 100-200ms on large directories.
- **Fix**: Use `chokidar` (already a dependency) or `fs.watch()` to react to changes. Keep a 30s fallback poll for reliability.
- **Impact**: Eliminates 5s polling overhead; near-instant team detection.

### 4.3 Consolidate subagent file watchers
- **Files**: `src/subagent-watcher.ts` (~line 229+)
- **Problem**: One chokidar watcher per agent directory. With 500 agents, that's 500 inotify watchers consuming kernel resources.
- **Fix**: Watch at the session level (one watcher per session's subagent directory), not per-agent. Parse events to route to correct agent.
- **Impact**: Reduces inotify watchers from 500 to ~50 (one per session).

### 4.4 Stream transcript files instead of full reads
- **Files**: `src/subagent-watcher.ts` (~lines 959-964)
- **Problem**: `loadTranscript()` reads entire transcript file (can be >100KB). With 500 agents discovered at once, that's 50MB of file reads.
- **Fix**: Only read last 10KB for display (tail). Full file on-demand only (e.g., when user opens transcript viewer).
- **Impact**: Reduces file I/O from 50MB to 5MB for bulk agent discovery.

---

## Phase 5: Long-Term Architectural (Optional)

### 5.1 Worker thread for PTY processing
- **Files**: `src/session.ts`
- **Problem**: ANSI stripping, Ralph tracking, and bash tool parsing all run on the main event loop. At scale (50 busy sessions), this consumes 300-500ms CPU/sec.
- **Fix**: Offload ANSI strip + line processing to a worker thread pool. Main thread receives clean text + parsed events.
- **Impact**: Frees event loop for I/O operations. Most impactful at 10+ concurrent busy sessions.

### 5.2 Per-session SSE subscriptions
- **Files**: `src/web/server.ts`
- **Problem**: Every SSE event is broadcast to all connected clients. A client watching session A still receives events for sessions B through Z.
- **Fix**: Clients subscribe to specific session IDs. Server only sends events to interested clients.
- **Impact**: Reduces SSE broadcast fan-out from N clients to ~1-2 per event. Major improvement at 100 SSE clients.

### 5.3 O(1) LRUMap via doubly-linked list
- **Files**: `src/utils/lru-map.ts` (~lines 98-110)
- **Problem**: `get()` uses delete + re-insert to refresh position — O(n) on Map iteration for delete.
- **Fix**: Implement classic LRU with doubly-linked list + Map for O(1) get/put/evict.
- **Impact**: Low — current sizes (max 500) make this barely measurable. Only worthwhile if LRUMap is used on hot paths.

---

## Priority Matrix (Remaining Work)

| # | Item | Impact | Risk | Effort |
|---|------|--------|------|--------|
| 3.1 | State diff broadcasts | **Very High** | Medium | 3-4h |
| 3.2 | Fix session cache invalidation | **High** | Low | 1h |
| 3.3 | Skip PTY processing for hidden sessions | **High** | Medium | 2-3h |
| 3.5 | Throttle detection broadcasts | **Medium** | Low | 1h |
| 3.4 | Batch liveness checks | **Medium** | Low | 1-2h |
| 4.1 | Incremental state persistence | **Medium** | Medium | 3-4h |
| 4.2 | Team watcher fs events | **Low-Med** | Medium | 2h |
| 4.3 | Consolidate file watchers | **Low-Med** | Medium | 2h |
| 4.4 | Stream transcripts | **Low-Med** | Low | 1h |
| 5.1 | Worker thread PTY | **Med** (at scale) | High | 8h |
| 5.2 | Per-session SSE subs | **Med** (at scale) | High | 4h |
| 5.3 | O(1) LRUMap | **Very Low** | Medium | 2h |

---

## Recommended Execution Order

**Sprint 1** (Phase 3 — Backend Hot Paths): Items 3.1, 3.2, 3.3, 3.5
- Backend serialization and broadcast efficiency
- Highest remaining impact; requires careful testing with multiple active sessions

**Sprint 2** (Phase 4 — System Level): Items 4.1, 3.4, 4.3, 4.4
- State persistence, liveness checks, watcher consolidation
- Medium-complexity refactors

**Sprint 3** (Phase 5 — Architectural): Items 5.1, 5.2 — only if scaling demands it

---

## Measurement

Before starting implementation, establish baselines:

1. **Frontend**: Record Chrome DevTools Performance trace with 10 sessions open. Measure:
   - Frame rate during rapid terminal output
   - Long tasks (>50ms) count per 30s
   - Heap size after 1h session

2. **Backend**: Add `performance.now()` instrumentation around:
   - `flushSessionTerminalBatch()` — time per flush
   - `broadcastSessionStateDebounced()` — serialization time
   - `StateStore.save()` — persist time
   - Event loop lag via `monitorEventLoopDelay()`

3. **First load**: Lighthouse score on desktop and mobile (simulated 3G)
