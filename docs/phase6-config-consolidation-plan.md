# Phase 6 Implementation Plan: Config Consolidation

**Source**: `docs/code-structure-findings.md` (Phase 6 — Config Consolidation)
**Estimated effort**: 1 day
**Tasks**: 8 tasks with dependencies (see dependency graph below)

---

## Safety Constraints

Before starting ANY work, read and follow these rules:

1. **Never run `npx vitest run`** (full suite) — it kills tmux sessions. You are running inside a Codeman-managed tmux session.
2. **Run individual tests only**: `npx vitest run test/<file>.test.ts`
3. **Never test on port 3000** — the live dev server runs there. Tests use ports 3150+.
4. **After TypeScript changes**: Run `tsc --noEmit` to verify type checking passes.
5. **Before considering done**: Run `npm run lint` and `npm run format:check` to ensure CI passes.
6. **Never kill tmux sessions** — check `echo $CODEMAN_MUX` first.
7. **Verify the dev server starts**: After each task, run `npx tsx src/index.ts web --port 3099 &` on a non-production port, confirm `curl -s http://localhost:3099/api/status | jq .status` returns `"ok"`, then kill the background process.

---

## Goal

Consolidate ~70 scattered numeric constants from 15+ source files into 6 new domain-focused config files, eliminating cross-file duplicates (including a 5x-duplicated AI model string) and making all tuning knobs discoverable in `src/config/`.

**Non-goal**: Moving every constant. Module-internal implementation details (like regex patterns, algorithm-specific magic numbers, or constants only used once in deeply coupled logic) stay where they are. The goal is discoverability of operational tuning knobs, not mechanical relocation.

---

## Design Decisions

### What gets centralized (and why)

Constants are candidates for centralization when they meet **any** of these criteria:

1. **Duplicated across files** — DRY violation (e.g., `STATS_COLLECTION_INTERVAL_MS` in `server.ts` and `mux-routes.ts`, AI model string in 5 files)
2. **Operational tuning knobs** — values an operator might want to adjust for performance, security, or behavior without understanding the implementation (e.g., SSE health check interval, auth session TTL, rate limits)
3. **Cross-cutting concerns** — values that establish system-wide contracts (e.g., max terminal dimensions used by both server routes and frontend)

### What stays in place (and why)

Constants that are **internal implementation details** of a single module stay where they are:

- **Algorithm parameters** — `TODO_SIMILARITY_THRESHOLD`, `adaptiveCompletionConfirmMs`, confidence weights. These are meaningless without understanding the algorithm.
- **Display/UI formatting** — `TEXT_PREVIEW_LENGTH`, `SMART_TITLE_MAX_LENGTH`, `COMMAND_DISPLAY_LENGTH` in `subagent-watcher.ts`. Only used locally, tightly coupled to rendering logic.
- **Module-internal timing** — `LINE_BUFFER_FLUSH_INTERVAL` in `session.ts`, `AI_CHECK_POLL_INTERVAL` in `ai-checker-base.ts`. Internal implementation of specific features.
- **Frontend constants** — `constants.js` already centralizes frontend values well. Don't mix frontend and backend config.
- **Respawn `DEFAULT_CONFIG`** — these are user-configurable defaults for the respawn config interface, not system constants. They live properly in `respawn-controller.ts`. The AI model/context defaults within it are replaced with imports from the new `ai-defaults.ts` (Task 5).
- **Session auto-ops thresholds** — `AUTO_RETRY_DELAY_MS`, `COMPACT_COOLDOWN_MS`, etc. in `session-auto-ops.ts` are internal to that module's retry logic and already well-documented in place.

### File organization: domain-based, not category-based

A single `timing-config.ts` with 70 unrelated timing values would be worse than the current state — developers would need to grep it just like they grep the whole codebase now. Instead, constants are grouped by **the system they configure**:

| New File | Domain | Developer Question It Answers |
|----------|--------|-------------------------------|
| `server-timing.ts` | Web server performance | "How do I tune SSE batching / terminal throughput?" |
| `auth-config.ts` | Authentication & security | "What are the rate limits and session TTLs?" |
| `tunnel-config.ts` | QR auth & Cloudflare tunnel | "What are the QR token rotation parameters?" |
| `terminal-limits.ts` | Terminal dimensions & input | "What are the max cols/rows/input size?" |
| `ai-defaults.ts` | AI checker model & context | "What model do the AI checkers use? What's the context limit?" |
| `team-config.ts` | Agent Teams polling & caching | "How often does team polling run? What are the cache limits?" |

---

## Task Dependencies

```
Task 1 (server-timing.ts)
Task 2 (auth-config.ts)
Task 3 (tunnel-config.ts)
Task 4 (terminal-limits.ts)
Task 5 (ai-defaults.ts)
Task 6 (team-config.ts)
    └──> Task 7 (Fix remaining duplicates)
         └──> Task 8 (Update CLAUDE.md + final verification)
```

**Tasks 1–6** are independent and can run in parallel.
**Task 7** depends on Tasks 1–6 (needs the new config files to exist).
**Task 8** depends on Task 7.

---

## Task 1: Create `src/config/server-timing.ts`

**Estimated effort**: 30 minutes
**Files created**: `src/config/server-timing.ts`
**Files modified**: `src/web/server.ts`, `src/web/routes/mux-routes.ts`

### Constants to extract from `src/web/server.ts`

| Constant | Value | Purpose |
|----------|-------|---------|
| `TERMINAL_BATCH_INTERVAL` | `16` | Terminal data batching interval (60fps) |
| `TASK_UPDATE_BATCH_INTERVAL` | `100` | Task event batching interval (ms) |
| `STATE_UPDATE_DEBOUNCE_INTERVAL` | `500` | State persistence debounce (ms) |
| `SESSIONS_LIST_CACHE_TTL` | `1000` | Sessions list cache TTL (ms) |
| `SCHEDULED_CLEANUP_INTERVAL` | `300000` | Scheduled runs cleanup check (5 min) |
| `SCHEDULED_RUN_MAX_AGE` | `3600000` | Completed scheduled run max age (1 hour) |
| `SSE_HEALTH_CHECK_INTERVAL` | `30000` | SSE client health check (30s) |
| `SESSION_LIMIT_WAIT_MS` | `5000` | Session limit retry wait (5s) |
| `ITERATION_PAUSE_MS` | `2000` | Scheduled run iteration pause (2s) |
| `BATCH_FLUSH_THRESHOLD` | `32768` | Terminal batch immediate flush threshold (32KB) |
| `STATS_COLLECTION_INTERVAL_MS` | `2000` | Mux stats collection interval (2s) |

### Implementation

1. Create `src/config/server-timing.ts` with all 11 constants, preserving existing JSDoc comments.
2. In `src/web/server.ts`: Remove the 11 local constant declarations (lines ~92–121). Add `import { TERMINAL_BATCH_INTERVAL, ... } from '../config/server-timing.js'`.
3. In `src/web/routes/mux-routes.ts`: Remove the duplicate `STATS_COLLECTION_INTERVAL_MS` (line 10) and its comment. Add `import { STATS_COLLECTION_INTERVAL_MS } from '../../config/server-timing.js'`. This fixes a **duplicate constant** (finding #10).
4. Run `tsc --noEmit`.

### New file template

```typescript
/**
 * @fileoverview Web server performance and scheduling constants.
 *
 * Controls terminal batching throughput, SSE health checking,
 * state persistence debouncing, and scheduled run timing.
 *
 * @module config/server-timing
 */

// ============================================================================
// Terminal & SSE Performance
// ============================================================================

/** Terminal data batching interval — targets 60fps (ms) */
export const TERMINAL_BATCH_INTERVAL = 16;

/** Immediate flush threshold for terminal batches (bytes).
 * Set high (32KB) to allow effective batching; avg Ink events are ~14KB. */
export const BATCH_FLUSH_THRESHOLD = 32 * 1024;

/** Task event batching interval (ms) */
export const TASK_UPDATE_BATCH_INTERVAL = 100;

/** SSE client health check interval (ms) */
export const SSE_HEALTH_CHECK_INTERVAL = 30 * 1000;

// ============================================================================
// State Persistence
// ============================================================================

/** State update debounce — batches expensive toDetailedState() calls (ms) */
export const STATE_UPDATE_DEBOUNCE_INTERVAL = 500;

/** Sessions list cache TTL — avoids re-serializing on every SSE init (ms) */
export const SESSIONS_LIST_CACHE_TTL = 1000;

// ============================================================================
// Scheduled Runs
// ============================================================================

/** Scheduled runs cleanup check interval (ms) */
export const SCHEDULED_CLEANUP_INTERVAL = 5 * 60 * 1000;

/** Completed scheduled run max age before cleanup (ms) */
export const SCHEDULED_RUN_MAX_AGE = 60 * 60 * 1000;

/** Session limit retry wait before retrying (ms) */
export const SESSION_LIMIT_WAIT_MS = 5000;

/** Pause between scheduled run iterations (ms) */
export const ITERATION_PAUSE_MS = 2000;

// ============================================================================
// Mux Stats
// ============================================================================

/** Mux stats collection interval (ms) */
export const STATS_COLLECTION_INTERVAL_MS = 2000;
```

### Verification

```bash
tsc --noEmit
npx tsx src/index.ts web --port 3099 &
curl -s http://localhost:3099/api/status | jq .status  # "ok"
kill %1
```

---

## Task 2: Create `src/config/auth-config.ts`

**Estimated effort**: 20 minutes
**Files created**: `src/config/auth-config.ts`
**Files modified**: `src/web/middleware/auth.ts`, `src/hooks-config.ts`

### Constants to extract from `src/web/middleware/auth.ts`

| Constant | Value | Purpose |
|----------|-------|---------|
| `AUTH_SESSION_TTL_MS` | `86400000` | Auth session cookie TTL (24h) |
| `MAX_AUTH_SESSIONS` | `100` | Max concurrent auth sessions |
| `AUTH_FAILURE_MAX` | `10` | Max failed auth attempts per IP |
| `AUTH_FAILURE_WINDOW_MS` | `900000` | Failed auth tracking window (15 min) |

### Constants to extract from `src/hooks-config.ts`

| Constant | Value | Purpose |
|----------|-------|---------|
| `HOOK_TIMEOUT_MS` | `10000` | Timeout for Claude Code hook commands |

The `timeout: 10000` value is hardcoded 6 times in `hooks-config.ts` as inline literals. Extract to a single named constant.

### Implementation

1. Create `src/config/auth-config.ts` with the 5 constants.
2. In `src/web/middleware/auth.ts`: Remove the 4 local constant declarations (lines 17–25). Add import from `../../config/auth-config.js`. Keep `AUTH_COOKIE_NAME` in place — it's a string identifier, not a tunable numeric constant.
3. In `src/hooks-config.ts`: Replace all 6 inline `timeout: 10000` occurrences with `timeout: HOOK_TIMEOUT_MS`. Add import from `./config/auth-config.js`.
4. Run `tsc --noEmit`.

### New file template

```typescript
/**
 * @fileoverview Authentication, rate limiting, and hook security constants.
 *
 * Controls auth session lifecycle, brute-force protection,
 * and Claude Code hook timeouts.
 *
 * @module config/auth-config
 */

// ============================================================================
// Session Cookies
// ============================================================================

/** Auth session cookie TTL — matches autonomous run length (ms) */
export const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Max concurrent auth sessions per server */
export const MAX_AUTH_SESSIONS = 100;

// ============================================================================
// Rate Limiting
// ============================================================================

/** Max failed auth attempts per IP before 429 rejection */
export const AUTH_FAILURE_MAX = 10;

/** Failed auth attempt tracking window (ms) */
export const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;

// ============================================================================
// Hooks
// ============================================================================

/** Timeout for Claude Code hook curl commands (ms) */
export const HOOK_TIMEOUT_MS = 10000;
```

### Verification

```bash
tsc --noEmit
npm run lint
```

---

## Task 3: Create `src/config/tunnel-config.ts`

**Estimated effort**: 20 minutes
**Files created**: `src/config/tunnel-config.ts`
**Files modified**: `src/tunnel-manager.ts`

### Constants to extract from `src/tunnel-manager.ts`

| Constant | Value | Purpose |
|----------|-------|---------|
| `QR_TOKEN_TTL_MS` | `60000` | QR token auto-rotation interval (60s) |
| `QR_TOKEN_GRACE_MS` | `90000` | Grace period for previous token (90s) |
| `SHORT_CODE_LENGTH` | `6` | Length of QR short code |
| `QR_RATE_LIMIT_MAX` | `30` | Global QR attempt rate limit |
| `QR_RATE_LIMIT_WINDOW_MS` | `60000` | QR rate limit reset window (60s) |
| `URL_TIMEOUT_MS` | `30000` | Cloudflared URL fetch timeout (30s) |
| `RESTART_DELAY_MS` | `5000` | Tunnel restart delay after crash (5s) |
| `FORCE_KILL_MS` | `5000` | SIGTERM → SIGKILL escalation timeout (5s) |

### Implementation

1. Create `src/config/tunnel-config.ts` with all 8 constants.
2. In `src/tunnel-manager.ts`: Remove the 8 local constant declarations (lines ~39–75). Add `import { QR_TOKEN_TTL_MS, ... } from './config/tunnel-config.js'`.
3. Keep the `TUNNEL_URL_REGEX` in `tunnel-manager.ts` — it's a parsing detail, not a tuning knob.
4. Run `tsc --noEmit`.

### New file template

```typescript
/**
 * @fileoverview Cloudflare tunnel and QR authentication constants.
 *
 * Controls QR token rotation timing, rate limiting,
 * and tunnel process lifecycle.
 *
 * @module config/tunnel-config
 */

// ============================================================================
// QR Token Rotation
// ============================================================================

/** QR token auto-rotation interval (ms) */
export const QR_TOKEN_TTL_MS = 60_000;

/** Grace period — previous token still valid during rotation (ms) */
export const QR_TOKEN_GRACE_MS = 90_000;

/** Length of the short code in QR URL path (chars) */
export const SHORT_CODE_LENGTH = 6;

// ============================================================================
// QR Rate Limiting
// ============================================================================

/** Global rate limit for QR auth attempts across all IPs */
export const QR_RATE_LIMIT_MAX = 30;

/** QR rate limit reset window (ms) */
export const QR_RATE_LIMIT_WINDOW_MS = 60_000;

// ============================================================================
// Tunnel Process Lifecycle
// ============================================================================

/** Max time to wait for cloudflared URL before timeout (ms) */
export const URL_TIMEOUT_MS = 30_000;

/** Restart delay after unexpected tunnel exit (ms) */
export const RESTART_DELAY_MS = 5_000;

/** SIGTERM → SIGKILL escalation timeout (ms) */
export const FORCE_KILL_MS = 5_000;
```

### Verification

```bash
tsc --noEmit
```

---

## Task 4: Create `src/config/terminal-limits.ts`

**Estimated effort**: 20 minutes
**Files created**: `src/config/terminal-limits.ts`
**Files modified**: `src/web/routes/session-routes.ts`

### Constants to extract from `src/web/routes/session-routes.ts`

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_INPUT_LENGTH` | `65536` | Max input length per request (64KB) |
| `MAX_TERMINAL_COLS` | `500` | Max terminal columns |
| `MAX_TERMINAL_ROWS` | `200` | Max terminal rows |
| `MAX_SESSION_NAME_LENGTH` | `128` | Max session name length (chars) |

### Why a separate file instead of adding to `buffer-limits.ts`

`buffer-limits.ts` covers memory buffer sizes (2MB terminal, 1MB text). These constants are **validation limits** for API inputs — different concern. A terminal resize request must not exceed `MAX_TERMINAL_COLS`; this has nothing to do with buffer trimming.

### Implementation

1. Create `src/config/terminal-limits.ts` with all 4 constants.
2. In `src/web/routes/session-routes.ts`: Remove the 4 local constant declarations (lines 45–48). Add `import { MAX_INPUT_LENGTH, MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS, MAX_SESSION_NAME_LENGTH } from '../../config/terminal-limits.js'`.
3. Run `tsc --noEmit`.

### New file template

```typescript
/**
 * @fileoverview Terminal dimension and input validation limits.
 *
 * Used by API routes to validate resize, input, and session
 * creation requests. Separate from buffer-limits.ts which
 * controls memory buffer sizes.
 *
 * @module config/terminal-limits
 */

/** Max input length per API request (bytes) */
export const MAX_INPUT_LENGTH = 64 * 1024;

/** Max terminal columns for resize requests */
export const MAX_TERMINAL_COLS = 500;

/** Max terminal rows for resize requests */
export const MAX_TERMINAL_ROWS = 200;

/** Max session name length (chars) */
export const MAX_SESSION_NAME_LENGTH = 128;
```

### Verification

```bash
tsc --noEmit
```

---

## Task 5: Create `src/config/ai-defaults.ts`

**Estimated effort**: 30 minutes
**Files created**: `src/config/ai-defaults.ts`
**Files modified**: `src/respawn-controller.ts`, `src/ai-idle-checker.ts`, `src/ai-plan-checker.ts`, `src/web/routes/respawn-routes.ts`

### Problem: AI model string duplicated 5 times

The model identifier `'claude-opus-4-5-20251101'` appears in 5 places across 4 files. When the model changes, all 5 must be updated — a guaranteed source of bugs. The context limits (`16000`, `8000`) are similarly scattered across 3 files each.

| Constant | Current Value | Duplicated In |
|----------|---------------|---------------|
| `AI_CHECK_MODEL` | `'claude-opus-4-5-20251101'` | `respawn-controller.ts` (×2: idle + plan), `ai-idle-checker.ts`, `ai-plan-checker.ts`, `respawn-routes.ts` (×2: idle + plan) |
| `AI_IDLE_CHECK_MAX_CONTEXT` | `16000` | `respawn-controller.ts`, `ai-idle-checker.ts`, `respawn-routes.ts` |
| `AI_PLAN_CHECK_MAX_CONTEXT` | `8000` | `respawn-controller.ts`, `ai-plan-checker.ts`, `respawn-routes.ts` |

### Implementation

1. Create `src/config/ai-defaults.ts` with the 3 constants.
2. In `src/respawn-controller.ts` `DEFAULT_CONFIG` (line 538): Replace `aiIdleCheckModel: 'claude-opus-4-5-20251101'` with `aiIdleCheckModel: AI_CHECK_MODEL`, `aiIdleCheckMaxContext: 16000` with `aiIdleCheckMaxContext: AI_IDLE_CHECK_MAX_CONTEXT`, `aiPlanCheckModel: 'claude-opus-4-5-20251101'` with `aiPlanCheckModel: AI_CHECK_MODEL`, `aiPlanCheckMaxContext: 8000` with `aiPlanCheckMaxContext: AI_PLAN_CHECK_MAX_CONTEXT`. Add import from `./config/ai-defaults.js`.
3. In `src/ai-idle-checker.ts` `DEFAULT_AI_CHECK_CONFIG` (line 46): Replace `model: 'claude-opus-4-5-20251101'` with `model: AI_CHECK_MODEL`, `maxContextChars: 16000` with `maxContextChars: AI_IDLE_CHECK_MAX_CONTEXT`. Add import from `./config/ai-defaults.js`.
4. In `src/ai-plan-checker.ts` `DEFAULT_PLAN_CHECK_CONFIG` (line 45): Replace `model: 'claude-opus-4-5-20251101'` with `model: AI_CHECK_MODEL`, `maxContextChars: 8000` with `maxContextChars: AI_PLAN_CHECK_MAX_CONTEXT`. Add import from `./config/ai-defaults.js`.
5. In `src/web/routes/respawn-routes.ts` config merge block (lines 173–179): Replace all 4 inline fallback values with imports from `../../config/ai-defaults.js`.
6. Run `tsc --noEmit`.

### New file template

```typescript
/**
 * @fileoverview Default model and context limits for AI-powered checkers.
 *
 * Centralizes the AI model identifier and context window sizes used by
 * the idle checker, plan checker, respawn controller defaults, and
 * respawn route fallbacks. Change the model here when upgrading.
 *
 * @module config/ai-defaults
 */

/** Default model for AI idle and plan checkers */
export const AI_CHECK_MODEL = 'claude-opus-4-5-20251101';

/** Max context chars for idle checker (~4k tokens) */
export const AI_IDLE_CHECK_MAX_CONTEXT = 16000;

/** Max context chars for plan checker (~2k tokens, plan mode UI is compact) */
export const AI_PLAN_CHECK_MAX_CONTEXT = 8000;
```

### Verification

```bash
tsc --noEmit
# Verify no remaining hardcoded model strings
grep -rn 'claude-opus-4-5-20251101' src/  # Should only appear in config/ai-defaults.ts
```

---

## Task 6: Create `src/config/team-config.ts`

**Estimated effort**: 15 minutes
**Files created**: `src/config/team-config.ts`
**Files modified**: `src/team-watcher.ts`

### Constants to extract from `src/team-watcher.ts`

| Constant | Value | Purpose |
|----------|-------|---------|
| `TEAM_POLL_INTERVAL_MS` | `30000` | Team directory poll interval (30s) |
| `MAX_CACHED_TEAMS` | `50` | LRU cache size for team configs |
| `MAX_CACHED_TASKS` | `200` | LRU cache size for team tasks + inboxes |

### Why centralize these

Team polling frequency and cache sizes are operational knobs that affect both performance (polling too often wastes CPU) and responsiveness (polling too rarely means stale team state in the UI). They're also the kind of values a developer tuning for a large team deployment would want to find quickly. `MAX_CACHED_TASKS` is used for both the task cache and inbox cache — worth documenting.

### Implementation

1. Create `src/config/team-config.ts` with the 3 constants.
2. In `src/team-watcher.ts`: Remove the 3 local constants (lines 23–25). Add `import { TEAM_POLL_INTERVAL_MS, MAX_CACHED_TEAMS, MAX_CACHED_TASKS } from './config/team-config.js'`. Note: rename `POLL_INTERVAL_MS` → `TEAM_POLL_INTERVAL_MS` to avoid ambiguity with the identically-named constant in `subagent-watcher.ts`.
3. Update the usage site: `setInterval(... POLL_INTERVAL_MS)` → `setInterval(... TEAM_POLL_INTERVAL_MS)`.
4. Run `tsc --noEmit`.

### New file template

```typescript
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
```

### Verification

```bash
tsc --noEmit
```

---

## Task 7: Fix remaining cross-file duplicates

**Estimated effort**: 30 minutes
**Files modified**: `src/index.ts`, `src/subagent-watcher.ts`

### Duplicate 1: `STATS_COLLECTION_INTERVAL_MS`

Already fixed in Task 1 — both `server.ts` and `mux-routes.ts` now import from `server-timing.ts`.

### Duplicate 2: AI model string

Already fixed in Task 5 — all 5 occurrences now import from `ai-defaults.ts`.

### Duplicate 3: `MAX_SCREENSHOT_SIZE` / `MAX_TEXT_FILE_SIZE` / `MAX_RAW_FILE_SIZE`

These file size limits in `file-routes.ts` and `system-routes.ts` are **API-specific validation limits**. They're only used in their respective route files and aren't duplicated. **Leave in place** — they're local to their route module and well-commented.

### Action A: Move `MAX_CONSECUTIVE_ERRORS` and `ERROR_RESET_MS` to config

`src/index.ts` has two process-level constants that are operational tuning knobs:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_CONSECUTIVE_ERRORS` | `5` | Max consecutive unhandled errors before process exit |
| `ERROR_RESET_MS` | `60000` | Error counter reset interval (1 min) |

These belong in a config file since they control server reliability behavior. Add them to `src/config/server-timing.ts` (they're server operational constants).

1. Add to `src/config/server-timing.ts`:
   ```typescript
   // ============================================================================
   // Process Error Recovery
   // ============================================================================

   /** Max consecutive unhandled errors before auto-restart */
   export const MAX_CONSECUTIVE_ERRORS = 5;

   /** Error counter reset interval — forgives errors after quiet period (ms) */
   export const ERROR_RESET_MS = 60_000;
   ```
2. In `src/index.ts`: Remove lines 19–20, add import from `./config/server-timing.js`.
3. Run `tsc --noEmit`.

### Action B: Fix `MAX_TRACKED_AGENTS` shadow in `subagent-watcher.ts`

`subagent-watcher.ts` defines its own `MAX_TRACKED_AGENTS = 500` locally instead of importing the identical value from `config/map-limits.ts`. This is a latent bug — if someone changes the config value, the subagent watcher's copy stays stale.

1. In `src/subagent-watcher.ts`: Remove the local `MAX_TRACKED_AGENTS` constant. Add `import { MAX_TRACKED_AGENTS } from './config/map-limits.js'` (the value there is `MAX_TODOS_PER_SESSION = 500` — **verify** the map-limits constant is actually named `MAX_TRACKED_AGENTS` or if it needs to be added). If the constant doesn't exist in `map-limits.ts` under that name, add it.
2. Run `tsc --noEmit`.

### Verification

```bash
tsc --noEmit
npm run lint
npm run format:check
```

---

## Task 8: Update CLAUDE.md and final verification

**Estimated effort**: 20 minutes
**Files modified**: `CLAUDE.md`

### Updates to CLAUDE.md

1. **Config Files table** (`src/config/`): Add the 6 new files:

   | File | Purpose |
   |------|---------|
   | `buffer-limits.ts` | Terminal/text buffer size limits |
   | `map-limits.ts` | Global limits for Maps, sessions, watchers |
   | `exec-timeout.ts` | Execution timeout configuration |
   | `server-timing.ts` | Web server batching, SSE, scheduled run timing |
   | `auth-config.ts` | Auth session TTL, rate limits, hook timeout |
   | `tunnel-config.ts` | QR token rotation, tunnel process lifecycle |
   | `terminal-limits.ts` | Terminal dimension and input validation limits |
   | `ai-defaults.ts` | AI checker model and context limits |
   | `team-config.ts` | Agent Teams polling and cache sizes |

2. **Import Conventions** section: Add:
   ```
   - **Config**: Import from specific files: `import { MAX_TERMINAL_COLS } from './config/terminal-limits'`
   ```

3. **Phase 6 status** in `docs/code-structure-findings.md`: Mark as COMPLETE with summary of what was done.

### Final verification checklist

```bash
# Type checking
tsc --noEmit

# Linting
npm run lint

# Formatting
npm run format:check

# Dev server starts
npx tsx src/index.ts web --port 3099 &
curl -s http://localhost:3099/api/status | jq .status  # "ok"
kill %1

# Verify no remaining duplicates
grep -rn 'STATS_COLLECTION_INTERVAL_MS' src/  # Should only appear in config + import sites
grep -rn 'timeout: 10000' src/hooks-config.ts  # Should be 0 — all replaced with HOOK_TIMEOUT_MS
grep -rn 'claude-opus-4-5-20251101' src/       # Should only appear in config/ai-defaults.ts
```

---

## What is NOT in scope (and why)

These constants were considered but deliberately left in their current files:

### Respawn controller defaults (`src/respawn-controller.ts`)

The `DEFAULT_CONFIG` object (lines 538–578) contains ~30 default values for the `RespawnConfig` interface. These are **user-facing configuration defaults**, not system constants — they're the starting values for a config object that users can modify via the API and UI. Centralizing them would break the locality between the config interface definition and its defaults. They already have excellent JSDoc with `@default` tags. The only values extracted are the AI model/context constants (Task 5) which are duplicated in other files.

### Subagent watcher timing (`src/subagent-watcher.ts`)

The 18 constants at lines 129–158 are all internal to the subagent watcher's polling/lifecycle algorithm. Moving them to a config file would force developers to context-switch between two files to understand the polling logic. They're already grouped with clear comments. Exception: `MAX_TRACKED_AGENTS` is consolidated with `map-limits.ts` (Task 7B) since it duplicates a global limit.

### Session auto-ops timing (`src/session-auto-ops.ts`)

The 8 constants at lines 19–40 are internal to the auto-compact/clear retry state machine. They form a coherent group that's meaningless without the surrounding implementation context.

### Run summary constants (`src/run-summary.ts`)

`MAX_EVENTS`, `TRIM_TO_EVENTS`, `TOKEN_MILESTONE_INTERVAL`, `STATE_STUCK_WARNING_MS`, `STATE_STUCK_CHECK_INTERVAL` — all module-internal. The buffer-style limits (`MAX_EVENTS`/`TRIM_TO_EVENTS`) follow the same pattern as `buffer-limits.ts` but are only used in this one file.

### Frontend (`src/web/public/constants.js`)

Already well-centralized. Frontend and backend run in different environments — mixing them in TypeScript config files would create import problems. If frontend constants need expansion, do it in `constants.js`. Note: `app.js` has 2 inline uses of `256 * 1024` that should use the existing `TERMINAL_TAIL_SIZE` from `constants.js` — a minor cleanup that can be done opportunistically but is not worth a task here.

### Tmux manager timing (`src/tmux-manager.ts`)

The 6 constants (lines 65–78) are internal to tmux process lifecycle management. They're low-level retry/wait values that are meaningless without understanding the tmux spawn sequence.

### Process-internal constants

`image-watcher.ts`, `bash-tool-parser.ts`, `transcript-watcher.ts`, `ralph-tracker.ts`, `task-tracker.ts`, `file-stream-manager.ts`, `session-lifecycle-log.ts`, `session-task-cache.ts`, `respawn-metrics.ts`, `respawn-adaptive-timing.ts`, `ai-checker-base.ts` — all have module-local constants that are internal implementation details.

### `localhost:3000` default URL

The string `'http://localhost:3000'` or port `3000` appears as a fallback default in ~5 files (`session-cli-builder.ts`, `tmux-manager.ts`, `tunnel-manager.ts`, `server.ts`, CLI). While technically duplicated, extracting it provides little value — each usage has a different fallback chain (env var → config → hardcoded) and the port is also baked into systemd service files and documentation. The risk of a missed update is low since port 3000 is deeply conventional.

### `SAVE_DEBOUNCE_MS = 500` in `state-store.ts` / `push-store.ts`

Same value (500ms), but they debounce different persistence targets (state.json vs push-subscriptions.json). If one needed faster/slower debouncing, they'd diverge. Coupling them would be misleading.

---

## Summary

| Metric | Before | After |
|--------|--------|-------|
| Config files in `src/config/` | 3 | 9 |
| Constants centralized | ~25 | ~65 |
| Cross-file duplicates | 9+ (`STATS_COLLECTION_INTERVAL_MS`, `timeout: 10000` ×6, AI model ×5, context limits ×3 each, `MAX_TRACKED_AGENTS`) | 0 |
| Files with `timeout: 10000` inline | 1 (6 occurrences) | 0 |
| Files with hardcoded AI model string | 4 (5 occurrences) | 1 (config only) |
| Files modified | — | 11 |
| Files created | — | 6 |
