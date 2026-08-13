# CRON_DISCOVERY.md

Phase 1 deliverable for the "Add Scheduling to Codeman" build brief.
This documents the existing Codeman architecture and the smallest integration
points for a cron. **No session/tmux logic will be rebuilt** —
the new code is purely a trigger + persistence + history layer on top of the
existing primitives.

Stack: `aicodeman` v1.2.1 — Fastify 5 backend, `node-pty` + tmux sessions,
vanilla-JS SPA frontend served as static assets, JSON file state store, zod
validation, ports-based dependency injection.

---

## 0. Critical finding: an existing `ScheduledRun` is NOT a cron

Codeman already has a `ScheduledRun` concept (`/api/scheduled`,
`src/web/ports/infra-port.ts:14-26`, `src/web/server.ts:1480-1605`). It is a
**run-now, duration-bounded autonomous loop**: given `{prompt, workingDir,
durationMinutes}` it immediately spawns/kills throwaway sessions in a loop until
the duration elapses. It has **no** time-based triggering, recurrence
(once/interval/daily/weekly), enable/disable, next-run calculation, run history,
or persistence across restarts.

Therefore the brief's core (the calendar/cron trigger layer) does **not** exist
and must be built. The execution primitives it sits on top of **do** exist and
will be reused. To honor brief §16 ("do not rename existing core concepts"), the
new feature is named **`CronJob`** (with **`CronJobRun`** history
records), kept distinct from the existing `ScheduledRun`.

---

## 1. Where session creation happens

- Canonical create flow: `POST /api/sessions`,
  `src/web/routes/session-routes.ts:262-438`.
  - `new Session({ workingDir, mode, ... })` (`src/session.ts:421-570`)
  - `ctx.addSession(session)` → `ctx.setupSessionListeners(session)` →
    `ctx.persistSessionState(session)` (all via `SessionPort`).
- `SessionPort` interface: `src/web/ports/session-port.ts:8-16`.
- **Integration point:** the cron service will mirror this exact sequence
  (create → addSession → setupSessionListeners → start) via `SessionPort`,
  not reimplement it.

## 2. Where agent/session types are defined

- `type SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini' | 'antigravity' | 'pi'`
  (`src/types/session.ts:43-44`). `shell` covers the brief's "Terminal/custom".
- CLI availability resolvers in `src/utils/{claude,codex,gemini,antigravity,opencode,pi}-cli-resolver.ts`.
- **Integration point:** the job's `agentType` reuses `SessionMode` verbatim.

## 3. Where input is sent into a session

- Raw / paste: `session.write(data)` (`src/session.ts:2243-2247`) — direct PTY write.
- Typed (recommended): `session.writeViaMux(data)` (`src/session.ts:2301-2311`)
  — tmux `send-keys`, falls back to PTY. Submit requires trailing `\r`.
- **Integration point:** prompt delivery uses `writeViaMux` (typed) by default,
  `write` (paste) as the alternate `input_mode`.

## 4. Where active sessions are listed

- `ctx.sessions: ReadonlyMap<string, Session>` (`SessionPort`).
- Filters: `Array.from(ctx.sessions.values()).filter(s => s.mode === X)` and
  `.isBusy()` / `.isIdle()` (`src/session-manager.ts:220-247`).
- **Integration point:** the §8 multi-session warning queries this map.

## 5. Where session kill/delete is handled

- `ctx.cleanupSession(sessionId, killMux?, reason?)`
  (`SessionPort`; impl `src/web/server.ts:997-1152`). Underlying
  `session.stop(killMux)` at `src/session.ts:2498-2585`.
- The cron does **not** kill sessions it launches (the brief wants them
  visible in the normal session UI); cleanup stays user-driven.
  _Superseded post-review:_ recurring jobs now default to
  `autoClosePreviousSession: true` — the previous run's still-open session is
  closed via `cleanupSession` when the next run fires (see
  `docs/cron-guide.md` §8); opt out per job for fully user-driven cleanup.

## 6. How session state is stored / 7. Existing persistence

- JSON file store: `~/.codeman/state.json` (+ `state-inner.json` for Ralph).
  `StateStore` class `src/state-store.ts:71`; `AppState` interface
  `src/types/app-state.ts:99-114`.
- Pattern: declare a field on `AppState`, add typed get/set methods on
  `StateStore` that mutate in-memory state and call the debounced `save()`
  (500ms debounce, atomic temp-file+rename, `.bak` backup, circuit breaker).
- **Integration point:** add `cronJobs?: Record<string, CronJob>` and
  `cronJobRuns?: Record<string, CronJobRun>` to `AppState`, with
  matching `StateStore` accessors. No new DB (brief §6 forbids Postgres/Redis).

## 8. Where backend routes live

- Route modules: `src/web/routes/*.ts`; barrel `src/web/routes/index.ts`;
  registered in `WebServer.setupRoutes()` `src/web/server.ts:858-876` with a
  single `ctx` object from `createRouteContext()` (`src/web/server.ts:553-613`)
  that satisfies all port interfaces.
- Validation: zod schemas in `src/web/schemas.ts`, applied via
  `parseBody(Schema, req.body)` (`src/web/route-helpers.ts:101-111`).
- Errors: `createErrorResponse(ApiErrorCode.X, msg)` / `ApiResponse`
  (`src/types/api.ts`), auto-mapped to HTTP status by a `preSerialization` hook
  (`src/web/server.ts:644-659`).
- SSE: `ctx.broadcast(SseEvent.X, data)` (`EventPort`,
  `src/web/sse-events.ts`); frontend mirror in `src/web/public/constants.js`.
- **Integration point:** new `cron-routes.ts` registered alongside the
  others; new zod schema; new `SseEvent` constants for job list/run changes.

## 9. Where frontend pages/components live

- Vanilla-JS SPA: single `src/web/public/index.html` + feature mixin files
  (`Object.assign(CodemanApp.prototype, {...})`). API via `api-client.js`
  (`_apiJson/_apiPost/_apiDelete`). Build = esbuild minify + content-hash, no
  bundler (`scripts/build.mjs`).
- UI is panels/modals toggled by JS classes; forms use `.form-row` / `.modal`
  conventions (`styles.css`). SSE handler map in `app.js`.
- **Integration point:** add a new `cron-ui.js` mixin + a panel/modal in
  `index.html` + nav entry, following the orchestrator/respawn panel pattern.

## 10. Background-loop pattern (for the due-checker)

- Established pattern: `this.cleanup.setInterval(fn, intervalMs, {description})`
  in `WebServer.start()` (`src/web/server.ts:~1942-1966`), auto-disposed in
  `WebServer.stop()` via `this.cleanup.dispose()` (`src/web/server.ts:2336`).
  RalphLoop (`src/ralph-loop.ts:268-286`) shows the self-rescheduling guard idiom.
- **Integration point:** register a 30s cron tick via `cleanup.setInterval`;
  no manual shutdown wiring needed.

---

## Smallest integration points (summary)

| New piece | Reuses | Location |
| --- | --- | --- |
| `CronJob` / `CronJobRun` types | — (new) | `src/types/cron.ts` |
| Persistence | `StateStore` / `AppState` | `src/types/app-state.ts`, `src/state-store.ts` |
| Next-run time math | — (new, pure, unit-tested) | `src/cron/cron-time.ts` |
| Launch + send prompt | `SessionPort` (`addSession`/listeners/`writeViaMux`) | `src/cron/cron-service.ts` |
| Background due loop | `cleanup.setInterval` pattern | `src/cron/cron-loop.ts` |
| Routes + schema | route/ports/zod/SSE patterns | `src/web/routes/cron-routes.ts`, `src/web/schemas.ts`, `src/web/sse-events.ts` |
| UI | panel/modal/mixin conventions | `src/web/public/cron-ui.js`, `index.html` |

Nothing in the session, tmux, persistence, routing, or SSE subsystems is
rewritten — the cron is additive and calls existing services.
