# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

| Task | Command |
|------|---------|
| Dev server | `npx tsx src/index.ts web` |
| Type check | `tsc --noEmit` |
| Lint | `npm run lint` (fix: `npm run lint:fix`) |
| Format | `npm run format` (check: `npm run format:check`) |
| Single test | `npx vitest run test/<file>.test.ts` |
| Production | `npm run build && systemctl --user restart codeman-web` |

## CRITICAL: Session Safety

**You may be running inside a Codeman-managed tmux session.** Before killing ANY tmux or Claude process:

1. Check: `echo $CODEMAN_MUX` - if `1`, you're in a managed session
2. **NEVER** run `tmux kill-session`, `pkill tmux`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/tmux-manager.sh` instead of direct kill commands

## CRITICAL: Always Test Before Deploying

**NEVER COM without verifying your changes actually work.** For every fix:

1. **Backend changes**: Hit the API endpoint with `curl` and verify the response
2. **Frontend changes**: Use Playwright to load the page and assert the UI renders correctly. Use `waitUntil: 'domcontentloaded'` (not `networkidle` — SSE keeps the connection open). Wait 3-4s for polling/async data to populate, then check element visibility, text content, and CSS values
3. **Only after verification passes**, proceed with COM

The production server caches static files for 1 year (`maxAge: '1y'` in `server.ts`). After deploying frontend changes, users may need a hard refresh (Ctrl+Shift+R) to see updates.

## COM Shorthand (Deployment)

Uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) via `@changesets/cli`.

When user says "COM":
1. **Determine bump type**: `COM` = patch (default), `COM minor` = minor, `COM major` = major
2. **Create a changeset file** (no interactive prompts). Write a `.md` file in `.changeset/` with a random filename:
   ```bash
   cat > .changeset/$(openssl rand -hex 4).md << 'CHANGESET'
   ---
   "aicodeman": patch
   ---

   Description of changes
   CHANGESET
   ```
   Replace `patch` with `minor` or `major` as needed. Include `"xterm-zerolag-input": patch` on a separate line if that package changed too.
3. **Consume the changeset**: `npm run version-packages` (bumps versions in `package.json` files and updates `CHANGELOG.md`)
4. **Sync CLAUDE.md version**: Update the `**Version**` line below to match the new version from `package.json`
5. **Commit and deploy**: `git add -A && git commit -m "chore: version packages" && git push && npm run build && systemctl --user restart codeman-web`

**Version**: 0.3.0 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports both Claude Code and OpenCode AI CLIs via pluggable CLI resolvers.

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 18+, Claude CLI, tmux

**Git**: Main branch is `master`. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

## Additional Commands

`npm run dev` = dev server. Default port: `3000`. Commands not in Quick Reference:

| Task | Command |
|------|---------|
| Dev with TLS | `npx tsx src/index.ts web --https` |
| Continuous typecheck | `tsc --noEmit --watch` |
| Test coverage | `npm run test:coverage` |
| Production start | `npm run start` |
| Production logs | `journalctl --user -u codeman-web -f` |

**CI**: `.github/workflows/ci.yml` runs `typecheck`, `lint`, `format:check` on push to master (Node 22). Tests excluded (they spawn tmux).

**Code style**: Prettier (`singleQuote: true`, `printWidth: 120`, `trailingComma: "es5"`). ESLint allows `no-console`, warns on `@typescript-eslint/no-explicit-any`. Does not lint `app.js` or `scripts/**/*.mjs`.

## Common Gotchas

- **Single-line prompts only** — `writeViaMux()` sends text and Enter separately; multi-line breaks Ink
- **Don't kill tmux sessions blindly** — Check `$CODEMAN_MUX` first; you might be inside one
- **Global regex `lastIndex` sharing** — `ANSI_ESCAPE_PATTERN_FULL/SIMPLE` have `g` flag; use `createAnsiPatternFull/Simple()` factory functions for fresh instances in loops
- **DEC 2026 sync blocks** — Never discard incomplete sync blocks (START without END); buffer up to 50ms then flush. See `app.js:extractSyncSegments()`
- **Terminal writes during buffer load** — Live SSE writes are queued while `_isLoadingBuffer` is true to prevent interleaving with historical data
- **Local echo prompt scanning** — Does NOT use `buffer.cursorY` (Ink moves it); scans buffer bottom-up for visible `>` prompt marker
- **ESM dynamic imports** — Never use `require()` in this codebase; it breaks in production ESM builds. Use `await import()` for dynamic imports. (`tsx` masks this in dev by shimming CJS/ESM)
- **Package name vs product name** — npm package is `aicodeman`, product is **Codeman**. Release workflow renames `aicodeman@X.Y.Z` tags to `codeman@X.Y.Z`

## Import Conventions

- **Utilities**: Import from `./utils` (re-exports all): `import { LRUMap, stripAnsi } from './utils'`
- **Types**: Use type imports from barrel: `import type { SessionState } from './types'` (re-exports from `src/types/` domain files)
- **Config**: Import from specific files: `import { MAX_TERMINAL_BUFFER_SIZE } from './config/buffer-limits'`

## Architecture

### Core Files (by domain)

| Domain | Key files | Notes |
|--------|-----------|-------|
| **Entry** | `src/index.ts`, `src/cli.ts` | CLI entry point, global error recovery |
| **Session** | `src/session.ts` ★, `src/session-manager.ts`, `src/session-auto-ops.ts`, `src/session-cli-builder.ts` | PTY wrapper, lifecycle, auto-compact |
| **Mux** | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` | tmux abstraction layer |
| **Respawn** | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`) | Autonomous cycling state machine |
| **Ralph** | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Completion tracking, autonomous task loop |
| **Agents** | `src/subagent-watcher.ts` ★, `src/team-watcher.ts`, `src/bash-tool-parser.ts`, `src/transcript-watcher.ts` | Background agent monitoring |
| **AI** | `src/ai-checker-base.ts`, `src/ai-idle-checker.ts`, `src/ai-plan-checker.ts` | AI-powered idle/plan detection |
| **Tasks** | `src/task.ts`, `src/task-queue.ts`, `src/task-tracker.ts` | Task model, priority queue |
| **State** | `src/state-store.ts`, `src/run-summary.ts`, `src/session-lifecycle-log.ts` | Persistence, timeline, audit log |
| **Infra** | `src/hooks-config.ts`, `src/push-store.ts`, `src/tunnel-manager.ts`, `src/image-watcher.ts`, `src/file-stream-manager.ts` | Hooks, push, tunnel, file watching |
| **Plan** | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/claude-md.ts` | 2-agent plan generation |
| **Web** | `src/web/server.ts`, `src/web/sse-events.ts`, `src/web/routes/*.ts` (13 modules), `src/web/ports/*.ts`, `src/web/middleware/auth.ts`, `src/web/schemas.ts` | Fastify server, SSE event registry, REST API |
| **Frontend** | `src/web/public/app.js` ★ (~11.5K lines) + 8 JS modules | xterm.js UI, tabs, settings |
| **Types** | `src/types/index.ts` → 13 domain files | Barrel re-export, see `@fileoverview` in index.ts |

★ = Large file (>50KB), contains complex state machines. Read `docs/respawn-state-machine.md` before modifying respawn/ralph.

**Local package**: `packages/xterm-zerolag-input/` — instant keystroke feedback overlay for xterm.js. Source of truth for `LocalEchoOverlay`; copy embedded in `app.js`. Build: `npm run build` (tsup).

**Config**: `src/config/` — 9 files (buffer limits, map limits, timeouts, SSE timing, auth, tunnel, terminal, AI, teams). Import from specific files.

**Utilities**: `src/utils/` — re-exported via `src/utils/index.ts`. Key: `CleanupManager`, `LRUMap`, `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `createAnsiPatternFull/Simple()`, `assertNever`, `Debouncer`.

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input**: `session.writeViaMux()` for programmatic input — tmux `send-keys -l` (literal) + `send-keys Enter`. Single-line only.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Hook events**: Claude Code hooks trigger via `/api/hook-event`. Key events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`, `teammate_idle`, `task_completed`. See `src/hooks-config.ts`.

**Agent Teams**: `TeamWatcher` polls `~/.claude/teams/`, matches to sessions via `leadSessionId`. Teammates are in-process threads appearing as subagents. Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See `agent-teams/`.

**Circuit breaker**: Prevents respawn thrashing. States: `CLOSED` → `HALF_OPEN` → `OPEN`. Reset: `/api/sessions/:id/ralph-circuit-breaker/reset`.

**Port interfaces**: Routes declare dependencies via port interfaces (`src/web/ports/`). Routes use intersection types (e.g., `SessionPort & EventPort`).

### Frontend

Frontend JS modules have `@fileoverview` with `@dependency`/`@loadorder` tags. Load order: `constants.js`(1) → `mobile-handlers.js`(2) → `voice-input.js`(3) → `notification-manager.js`(4) → `keyboard-accessory.js`(5) → `app.js`(6) → `ralph-wizard.js`(7) → `api-client.js`(8) → `subagent-windows.js`(9).

**Z-index layers**: subagent windows (1000), plan agents (1100), log viewers (2000), image popups (3000), local echo overlay (7).

**Respawn presets**: `solo-work` (3s/60min), `subagent-workflow` (45s/240min), `team-lead` (90s/480min), `ralph-todo` (8s/480min), `overnight-autonomous` (10s/480min).

**Keyboard shortcuts**: Escape (close), Ctrl+? (help), Ctrl+Enter (quick start), Ctrl+W (kill), Ctrl+Tab (next), Ctrl+K (kill all), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl/Cmd +/- (font).

### Security

| Layer | Details |
|-------|---------|
| **Auth** | Optional HTTP Basic via `CODEMAN_USERNAME`/`CODEMAN_PASSWORD` env vars |
| **QR Auth** | Single-use 6-char tokens (60s TTL) for tunnel login. See `docs/qr-auth-plan.md` |
| **Sessions** | 24h cookie (`codeman_session`), auto-extend, device context audit |
| **Rate limit** | 10 failed auth/IP → 429 (15min decay). QR has separate limiter |
| **Hook bypass** | `/api/hook-event` exempt from auth (localhost-only, schema-validated) |
| **Env vars** | `CODEMAN_MUX` (managed session), `CODEMAN_API_URL` (auto-set for hooks) |
| **Validation** | Zod schemas, path allowlist regex, `CLAUDE_CODE_*` env prefix allowlist |
| **Headers** | CORS localhost-only, CSP, X-Frame-Options, HSTS if HTTPS |

### SSE Event Registry

~100 event types in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). Both must be kept in sync.

### API Route Categories

~111 route handlers in `src/web/routes/`. Key groups:

| Group | Prefix | Count | Key endpoints |
|-------|--------|-------|---------------|
| System | `/api/status`, `/api/stats`, `/api/config`, `/api/settings`, `/api/subagents` | 35 | App state, config, subagents |
| Sessions | `/api/sessions` | 24 | CRUD, input, resize, interactive, shell |
| Ralph | `/api/sessions/:id/ralph-*` | 9 | state, status, config, circuit-breaker |
| Plan | `/api/sessions/:id/plan/*` | 8 | task CRUD, checkpoint, history, rollback |
| Respawn | `/api/sessions/:id/respawn` | 7 | start, stop, enable, config |
| Cases | `/api/cases` | 7 | CRUD, link, fix-plan |
| Files | `/api/sessions/:id/file*`, `tail-file` | 5 | Browser, preview, raw, tail stream |
| Mux | `/api/mux-sessions` | 5 | tmux management, stats |
| Scheduled | `/api/scheduled` | 4 | CRUD for scheduled runs |
| Push | `/api/push` | 4 | VAPID key, subscribe, update prefs, unsubscribe |
| Teams | `/api/teams` | 2 | list teams, get team tasks |
| Hooks | `/api/hook-event` | 1 | Hook event ingestion |

## Adding Features

- **API endpoint**: Types in `src/types/` domain file, route in `src/web/routes/*-routes.ts`, use `createErrorResponse()`. Validate with Zod schemas in `schemas.ts`.
- **SSE event**: Add to `src/web/sse-events.ts` + `SSE_EVENTS` in `constants.js`, emit via `broadcast()`, handle in `app.js` (`addListener(`)
- **Session setting**: Add to `SessionState`, include in `session.toState()`, call `persistSessionState()`
- **Hook event**: Add to `HookEventType`, add hook in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema`
- **Mobile feature**: Add to relevant singleton, guard with `MobileDetection.isMobile()`
- **New test**: Pick unique port (search `const PORT =`). Integration: ports 3099-3211. Route tests: `app.inject()` — see `test/routes/_route-test-utils.ts`.

**Validation**: Zod v4 (different API from v3). Define schemas in `schemas.ts`, use `.parse()`/`.safeParse()`.

## State Files

| File | Purpose |
|------|---------|
| `~/.codeman/state.json` | Sessions, settings, tokens, respawn config |
| `~/.codeman/mux-sessions.json` | Tmux session metadata for recovery |
| `~/.codeman/settings.json` | User preferences |
| `~/.codeman/push-keys.json` | VAPID key pair for Web Push (auto-generated) |
| `~/.codeman/push-subscriptions.json` | Push notification subscriptions |
| `~/.codeman/session-lifecycle.jsonl` | Append-only audit log (QR auth, session events) |

## Default Settings

UI defaults in `app.js` using `??` fallbacks. Edit `openAppSettings()` and `apply*Visibility()` to change. Key defaults: most panels hidden (monitor, subagents shown), notifications on (audio off), subagent tracking on, Ralph tracking off.

## Testing

**CRITICAL: You are running inside a Codeman-managed tmux session.** Never run `npx vitest run` (full suite) — it spawns/kills tmux sessions and will crash your own session. Only run individual files:

```bash
npx vitest run test/<specific-file>.test.ts     # Single file (SAFE)
npx vitest run -t "pattern"                      # By name (SAFE)
# npx vitest run                                 # DANGEROUS — DON'T DO THIS
```

**Config**: Vitest with `globals: true`, `fileParallelism: false`. Timeout 30s, teardown 60s.

**Safety**: `test/setup.ts` snapshots pre-existing tmux sessions and never kills them. Only `registerTestTmuxSession()` sessions get cleaned up.

**Ports**: Pick unique ports manually. Search `const PORT =` before adding new tests.

**Respawn tests**: Use `MockSession` from `test/respawn-test-utils.ts`. **Route tests**: `app.inject()` in `test/routes/`. **Mobile tests**: Playwright suite in `mobile-test/` (135 device profiles).

## Screenshots

"sc"/"screenshot" = uploaded mobile screenshots in `~/.codeman/screenshots/`. View with Read tool. API: `GET /api/screenshots` (list), `POST /api/screenshots` (upload).

## Debugging & Troubleshooting

```bash
tmux list-sessions                                 # List tmux sessions
curl localhost:3000/api/sessions | jq              # Check sessions
curl localhost:3000/api/status | jq                # Full app state
curl localhost:3000/api/subagents | jq             # Background agents
curl localhost:3000/api/sessions/:id/run-summary | jq  # Session timeline
cat ~/.codeman/state.json | jq                     # Persisted state
```

| Problem | Fix |
|---------|-----|
| Session won't start | Kill orphaned tmux sessions, check Claude CLI installed |
| Port 3000 in use | `lsof -i :3000`, kill conflicting process or use `--port` |
| SSE not connecting | Check CORS, ensure server running, check browser console |
| Respawn not triggering | Enable respawn in session settings, check idle timeout |
| Terminal blank on tab switch | Check session exists, restart server |
| Tests failing on session limits | `tmux list-sessions \| grep test \| awk -F: '{print $1}' \| xargs -I{} tmux kill-session -t {}` |

## Performance & Resource Limits

Must stay fast with 20 sessions and 50 agent windows. Key: 60fps terminal (16ms batching + rAF), auto-trimming buffers, debounced state persistence (500ms), SSE adaptive batching (16-50ms), backpressure handling, cached endpoints (1s TTL for `/api/sessions` and `/api/status`).

**Anti-flicker**: `PTY → Server Batching → DEC 2026 Wrap → SSE → Client rAF → xterm.js`. See `docs/terminal-anti-flicker.md`.

**Limits** in `src/config/` (buffer-limits.ts, map-limits.ts, etc.). Key: terminal 2MB/1.5MB trim, text 1MB/768KB, messages 1000/800, max agents 500, max sessions 50, max SSE clients 100. Use `LRUMap` for bounded caches, `StaleExpirationMap` for TTL cleanup.

## References

| Topic | Location |
|-------|----------|
| Respawn state machine | `docs/respawn-state-machine.md` |
| Ralph Loop guide | `docs/ralph-wiggum-guide.md` |
| Claude Code hooks | `docs/claude-code-hooks-reference.md` |
| Terminal anti-flicker | `docs/terminal-anti-flicker.md` |
| Agent Teams | `agent-teams/README.md`, `agent-teams/design.md` |
| OpenCode integration | `docs/opencode-integration.md` |
| QR auth design | `docs/qr-auth-plan.md` |
| SSE events | `src/web/sse-events.ts` + `constants.js` |
| Types architecture | `src/types/index.ts` `@fileoverview` |
| API routes | `src/web/routes/` — each file has `@fileoverview` |

## Scripts

Key: `scripts/tmux-manager.sh` (safe tmux mgmt), `scripts/tunnel.sh` (tunnel start/stop/url), `scripts/monitor-respawn.sh` (respawn monitoring), `scripts/watch-subagents.ts` (transcript watcher). Production services: `scripts/codeman-web.service`, `scripts/codeman-tunnel.service`.

## Memory Leak Prevention

24+ hour sessions require cleanup of all Maps/timers. Backend: use `CleanupManager`, clear Maps in `stop()`, guard async with `if (this.cleanup.isStopped) return`. Frontend: store handler refs, clean in `close*()`, SSE reconnect resets via `handleInit()`. Verify: `npx vitest run test/memory-leak-prevention.test.ts`.

## Common Workflows

**Investigating a bug**: Start dev server, reproduce in browser, check terminal + `~/.codeman/state.json`.

**Adding an API endpoint**: Types in `src/types/*.ts`, route in `src/web/routes/*-routes.ts`, broadcast SSE if needed, handle in `app.js:handleSSEEvent()`.

**Modifying respawn**: Study `docs/respawn-state-machine.md` first. Use `MockSession` from `test/respawn-test-utils.ts`.

**Modifying mobile**: Singletons have `init()`/`cleanup()` lifecycle. Re-initialized after SSE reconnect to prevent stale closures.

## Tunnel Setup

Remote access via Cloudflare quick tunnel: `./scripts/tunnel.sh start|stop|url`. Web UI: Settings → Tunnel. Persistent: `systemctl --user enable --now codeman-tunnel`. **Always set `CODEMAN_PASSWORD`** before exposing via tunnel.
