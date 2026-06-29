# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

| Task | Command |
|------|---------|
| Dev server | `npm run dev` (or `npx tsx src/index.ts web`) |
| Type check | `tsc --noEmit` |
| Lint | `npm run lint` (fix: `npm run lint:fix`) |
| Format | `npm run format` (check: `npm run format:check`) |
| Single test | `npm test -- test/<file>.test.ts` (or `npx vitest run --config config/vitest.config.ts test/<file>.test.ts`) — ⚠ **never** run bare `npm test`, see Testing section |
| Build | `npm run build` (esbuild via `scripts/build.mjs`, NOT tsc — `tsc --noEmit` is type-check only) |
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

The production server caches static files for 1 year, `immutable` (`maxAge: '1y'` in `server.ts`). To avoid stale frontend after a deploy, `renderIndexHtml` runs `cacheBustAssets(html)` — it appends `?v=<mtime>` to **every same-origin `.js`/`.css`** reference (mtime memoized ~1s so a burst of renders is cheap; external/already-versioned/missing refs untouched). Because `index.html` is served `no-cache`, a **normal reload now picks up edited modules/styles — no hard refresh needed** (the gesture bundle is injected separately with its own `?v=`). If you add an asset referenced by an *absolute* URL or from JS rather than a `<script>/<link>` tag, it won't be auto-busted.

## COM Shorthand (Deployment)

Uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) via `@changesets/cli`. What SemVer actually covers (the CLI + documented env vars are public; the HTTP/SSE API, on-disk state, and experimental features are internal/unstable) is defined in `docs/versioning-policy.md`. Security reporting + known limitations live in `SECURITY.md`.

When user says "COM":
1. **Determine bump type**: `COM` = patch (default), `COM minor` = minor, `COM major` = major
2. **Create a changeset file** (no interactive prompts). Write a `.md` file in `.changeset/` with a random filename:
   ```bash
   cat > .changeset/$(openssl rand -hex 4).md << 'CHANGESET'
   ---
   "aicodeman": patch
   ---

   Detailed description of ALL changes since last release (not just the most recent commit — review full git log since last version tag)
   CHANGESET
   ```
   Replace `patch` with `minor` or `major` as needed. Include `"xterm-zerolag-input": patch` on a separate line if that package changed too.
3. **Consume the changeset**: `npm run version-packages` (auto-bumps `package.json` files, updates `CHANGELOG.md`, runs `npm install --package-lock-only`, and verifies lockfile sync via `scripts/check-lockfile-sync.mjs` — all in one command; never hand-edit `CHANGELOG.md` or `package-lock.json` versions)
4. **Sync CLAUDE.md version**: Update the `**Version**` line below to match the new version from `package.json`
5. **Commit and deploy**: `git add -A && git commit -m "chore: version packages" && git push && npm run build && systemctl --user restart codeman-web`
6. **Wait for CI**: after `git push`, find the run with `gh run list -L 1 --json databaseId,headBranch -q '.[0].databaseId'` and watch it with `gh run watch <id> --exit-status`. Confirm all checks pass before considering the release done.

CI runs `npm run check:lockfile` on every push/PR, so lockfile drift fails the build even if the `version-packages` script is bypassed.

**Version**: 1.2.1 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports Claude Code, OpenCode, Codex (OpenAI), and Gemini (Google) CLIs via pluggable CLI resolvers (`SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini'`).

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 22+, Claude CLI, tmux

**Git**: Main branch is `master`. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

## Additional Commands

`npm run dev` = dev server. Default port: `3000` (override with `--port` or the `CODEMAN_PORT` env var). To run this beta isolated alongside a prod Codeman, use `scripts/run-beta.sh` (sets `CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`). Commands not in Quick Reference:

| Task | Command |
|------|---------|
| Dev with TLS | `npx tsx src/index.ts web --https` |
| Override window title hostname | `npx tsx src/index.ts web --title-hostname <name>` (default: `os.hostname()` — `codeman:<name>` is used for tab title, title-flash, and OS desktop notification prefix) |
| Bind a non-loopback host | `npx tsx src/index.ts web --host 0.0.0.0` (or `-H`; env `CODEMAN_HOST`; default `127.0.0.1`). Without `CODEMAN_PASSWORD` it **starts but warns loudly** — see Common Gotchas + `docs/security-architecture.md` |
| Continuous typecheck | `tsc --noEmit --watch` |
| Test coverage | `npm run test:coverage` |
| Dead-code sweep | `npm run knip` (config in `knip.json`) |
| Rebuild gesture overlay | `npm run build:gesture` (esbuild `packages/gesture-control/src/codeman/entry.ts` → `src/web/public/gesture/gesture-codeman.js`; commit the result) |
| Gesture playground | `npm run dev` **in** `packages/gesture-control/` (standalone vite demo, fake tabs) |
| Check public-asset formatting | `npm run check:public-assets` (prettier-checks `src/web/public/**` text assets; `scripts/check-public-assets.mjs`) |
| Frontend JS syntax check | `npm run check:frontend-syntax` (`scripts/check-frontend-syntax.mjs`; runs in CI) |
| CI-equivalent test sweep | `npm run test:ci` (full suite minus browser/perf — see Testing) |
| Production start | `npm run start` |
| Production logs | `journalctl --user -u codeman-web -f` |

**CI**: `.github/workflows/ci.yml` (push to master/main + PRs, Node 22) runs two jobs: **(1)** `check:lockfile`, `typecheck`, `lint`, `check:frontend-syntax`, `format:check`, then a **server boot smoke test** (`tsx src/index.ts web --port 3151` must answer `/api/status` within 30s); **(2)** the **unit/integration test suite** via `npm run test:ci` (`config/vitest.ci.config.ts` — excludes the browser-driven `test/mobile/**` suite, `perf-*` benchmarks, and 3 Playwright tests). Tests are tmux-safe in CI: `TmuxManager` no-ops all shell commands under `VITEST` (see Testing).

**Code style**: Prettier (`singleQuote: true`, `printWidth: 120`, `trailingComma: "es5"`). ESLint flat config (`config/eslint.config.js`) allows `no-console`, warns on `@typescript-eslint/no-explicit-any`. Ignores: `app.js`, `scripts/**/*.mjs`, `src/web/public/vendor/**`, `scripts/remotion/**`.

## Common Gotchas

- **Single-line prompts only** — `writeViaMux()` sends text+Enter separately; multi-line breaks Ink
- **ESM only** — Never `require()`, use `await import()`. `tsx` masks CJS/ESM issues in dev but production breaks
- **Package ≠ product name** — npm: `aicodeman`, product: **Codeman**. Release renames tags accordingly. Both `aicodeman` and `codeman` bin aliases are installed (`package.json` `bin`)
- **Global regex `lastIndex`** — Shared `g`-flag patterns in loops must reset `lastIndex = 0` first, or use the `execPattern()` helper in `utils/regex-patterns.ts` (resets automatically)
- **`envOverrides` flow `CLAUDE_CODE_*` / `OPENCODE_*` / `CODEX_*` / `GEMINI_*` / `GOOGLE_*` env vars** — Set via `POST /api/sessions { envOverrides }`, stored on `Session._envOverrides`, exported by `tmux-manager.buildEnvExports()` at spawn time, persisted in `SessionState.envOverrides`. **Do NOT** write these to `<case>/.claude/settings.local.json` — that's the old path and creates UI/disk drift. (`GOOGLE_*` is the deliberately-broad Vertex-AI namespace for Gemini — see Multi-CLI prefix discipline.)
- **Effort is NOT an env var** — never carry effort as `CLAUDE_CODE_EFFORT_LEVEL`: the env var hard-locks effort and blocks in-session `/effort` switching (incl. ultracode). It flows as the dedicated `effort` payload field → `Session._effort` → `claude --effort <level>` for regular levels incl. `max` (the settings `effortLevel` key is `enum(["low","medium","high","xhigh"]).catch(undefined)` — `max` gets SILENTLY dropped there), or `claude --settings '{"ultracode":true}'` for ultracode (rejected by `--effort`). Both are soft defaults the user can override anytime. Legacy env-var entries are auto-migrated by the Session constructor and unset from tmux sessions in `applyEnvOverrides()`. See `buildEffortCliArgs()` in `session-cli-builder.ts`, tests in `test/effort-injection.test.ts`
- **Model choice flows via `settings.local.json`, NOT `--model` or env** — the App Settings **Claude Model** picker (`claudeModel` in `settings.json`) is read by `session-ui.js` at session create (wins over the legacy 1M-Opus toggles `opusContext1m`/`opusContext1mEnabled`), sent as the `modelOverride` payload field, and `updateCaseModel()` (`hooks-config.ts`) writes/deletes the `model` key in `<case>/.claude/settings.local.json`. This is the intended exception to the envOverrides rule above: model legitimately lives in `settings.local.json` (a soft default — in-session `/model` still works); env vars do not
- **Multi-CLI prefix discipline** — Codeman supports Claude Code, OpenCode, Codex, and Gemini (`claude-cli-resolver.ts` / `opencode-cli-resolver.ts` / `codex-cli-resolver.ts` / `gemini-cli-resolver.ts`); env-var prefix is CLI-specific (`CLAUDE_CODE_*` vs `OPENCODE_*` vs `CODEX_*` vs `GEMINI_*`) and the `ALLOWED_ENV_PREFIXES` allowlist in `schemas.ts` enforces this. Gemini additionally allowlists the **broad `GOOGLE_*`** namespace (intentional — Vertex AI auth uses `GOOGLE_CLOUD_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS`/`GOOGLE_GENAI_USE_VERTEXAI` etc.; it's the loosest allowlist entry, affecting only the user's own spawned CLI). When adding settings, decide which CLI(s) it applies to and gate the env export accordingly — don't blindly forward all prefixes. See `docs/opencode-integration.md` for the resolver design pattern
- **Zod `.optional()` rejects `null`** — accepts `undefined` only. When the frontend builds a request body with `JSON.stringify`, an explicit `null` field is preserved on the wire and fails validation with `INVALID_INPUT`. Convert `null` → `undefined` before stringifying (e.g. `field: value ?? undefined`), or declare the schema `.nullish()`. Real bugs caused: 0.6.4 (`durationMinutes` for ∞ respawn), and the same shape pattern hit `opusContext1mEnabled` in 0.6.3
- **`xterm-zerolag-input` is single-source — edit the package, then rebuild the bundle** — the local-echo overlay source lives ONLY in `packages/xterm-zerolag-input/src/` (`zerolag-input-addon.ts`; also published to npm as a standalone library — see README "Published Packages"). It is bundled (esbuild → IIFE, with appended `window.LocalEchoOverlay` aliases) into the **gitignored** `src/web/public/vendor/xterm-zerolag-input.js` by `scripts/postinstall.js` (for dev/`tsx`) and into `dist/.../vendor/` by `scripts/build.mjs` (the `xterm-zerolag-input` esbuild step, for prod). `app.js` only **consumes** it via `new LocalEchoOverlay(terminal)` — there is NO inline copy to keep in sync. So: change behavior in the package source, then re-run the bundle step (`npm install` reruns postinstall; `npm run build` for prod); **never hand-edit `app.js` for overlay behavior or commit the gitignored vendor bundle**. A public-API break in the package still warrants a separate `xterm-zerolag-input` version bump in the changeset. Always test on mobile after touching it. See `docs/local-echo-overlay-plan.md`.
- **Default bind is loopback-only; non-loopback without a password starts but warns** — since COD-29 (PR #107) the web server defaults to `--host 127.0.0.1` (was `0.0.0.0`). As of **0.9.0** binding a non-loopback host (`--host`/`-H`/`CODEMAN_HOST`) without `CODEMAN_PASSWORD` **no longer refuses to start — it starts and prints a loud warning** listing the fixes (set `CODEMAN_PASSWORD`, bind loopback + tunnel/`tailscale serve`, or `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` to acknowledge → terser note). Host classification is `isLoopbackBindHost()` in `network-auth-policy.ts`; the warn-vs-start logic is in `server.ts` `start()`; flags wired in `cli.ts`. ⚠️ Operational note: the production systemd unit runs `node dist/index.js web --https` with no `--host`, so it binds **localhost only** — reach it remotely via `tailscale serve`/tunnel to `127.0.0.1`, or add `Environment=CODEMAN_HOST=0.0.0.0` + `Environment=CODEMAN_PASSWORD=…` to `~/.config/systemd/user/codeman-web.service`. A loopback bind is reachable through a same-host tunnel (cloudflared/tailscale → `127.0.0.1`) but NOT by a browser hitting the box's LAN IP. Auth user defaults to `admin`. **Full model: `docs/security-architecture.md`.**
- **Instance isolation / multi-instance attach danger** — data dir (`~/.codeman`) and tmux socket (`tmux -L codeman`) are PROCESS-WIDE and shared by every Codeman on the machine, derived from `CODEMAN_INSTANCE` via `src/config/instance.ts` (`getDataDir()`/`dataPath()`/`DEFAULT_TMUX_SOCKET`). ⚠️ A 2nd instance on the SAME socket **discovers and attaches PTYs to the first instance's live sessions** (`tmux -L codeman attach-session …`), resizing/mutating them — `$HOME` isolation is NOT enough (tmux is system-global). To run two instances, give each a distinct `CODEMAN_INSTANCE` (scopes BOTH dir+socket: `~/.codeman-<name>` + `-L codeman-<name>`), or set `CODEMAN_TMUX_SOCKET` + `CODEMAN_DATA_DIR` individually. **`CODEMAN_INSTANCE` defaults to empty = the production layout (`~/.codeman`, `-L codeman`, port 3000)**, so this branch is safe to ship to master without disturbing existing installs. To run THIS beta alongside prod, launch with `scripts/run-beta.sh` (`CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`) — it never collides with prod's data dir/socket/port. Any new `~/.codeman/...` path MUST go through `dataPath()`, never `join(homedir(), '.codeman', …)`.
- **Headless screenshots: `deviceScaleFactor` MUST be 1, and write unique filenames** — `scripts/capture-real-overview.mjs` (drives a live session in headless Chromium → overview PNG). Two traps, both observed 2026-06-14: **(1) DSF=2 doubles the console font.** xterm's WebGL renderer draws terminal glyphs at ~2× their nominal size under `deviceScaleFactor: 2`, while STILL reporting nominal cell dims (`terminal.cols`/`_renderService.dimensions.css.cell` say 8px/187cols — they lie), so it's invisible to any internal measurement and only the pixels reveal it. The HTML chrome (header/toolbar) is unaffected → ONLY the console font looks comically large. Default to **DSF=1** (script does); the image is 1× res but the font is true-to-browser. **(2) Stable filenames → stale renders.** Overwriting a fixed path (`claude-overview.png`) in place leaves OS image viewers (eog/feh) — and any HTTP client behind a long/`immutable` cache — showing the OLD render; the user reads it as "the fix didn't work". The script now mints a timestamped `claude-overview-<ts>.png` per run. ⚠️ This was a LOCAL image-viewer cache, NOT a Codeman serving bug: `file-routes` previews send `Cache-Control: no-cache` and `/api/screenshots/:name` sends none. The one real Codeman-side footgun: `server.ts` serves non-content-hashed static assets `public, max-age=31536000, immutable`, and `cacheBustAssets()` only rewrites `.js`/`.css` refs — a stable-named **image** referenced from public/ would go stale on overwrite. Reflect the per-device UI to match a real device when capturing: seed `localStorage` `codeman:skin`, `codeman-font-size`, and the desktop `codeman-app-settings` blob (the plan-usage chip is a per-device display key deleted from the server payload — a fresh browser hides it unless seeded; close side panels for a full-width terminal).

**Import conventions**: Utils from `./utils`, types from `./types` (barrel), config from specific `./config/*` files.

## Architecture

### Core Files (by domain)

| Domain | Key files | Notes |
|--------|-----------|-------|
| **Entry** | `src/index.ts`, `src/cli.ts` | |
| **Session** | `src/session.ts` ★, `src/session-manager.ts`, `src/session-auto-ops.ts`, `src/session-cli-builder.ts`, `src/session-lifecycle-log.ts`, `src/session-task-cache.ts`, `src/usage-limit-patterns.ts`, `src/usage-telemetry.ts` | |
| **Mux** | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` ★ | |
| **Respawn** | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`) | Read `docs/respawn-state-machine.md` first |
| **Ralph** | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Read `docs/ralph-wiggum-guide.md` first |
| **Orchestrator** | `src/orchestrator-loop.ts`, `src/orchestrator-planner.ts`, `src/orchestrator-verifier.ts` | Read `docs/orchestrator-loop-architecture.md` first |
| **Cron** | `src/cron/cron-service.ts`, `src/cron/cron-time.ts` (pure next-run math), `src/cron/cron-input.ts` | Cron-style `CronJob`s. Read `docs/cron-discovery.md` first; distinct from legacy `ScheduledRun` (`/api/scheduled`) — see Key Patterns |
| **Agents** | `src/subagent-watcher.ts` ★, `src/team-watcher.ts`, `src/bash-tool-parser.ts`, `src/transcript-watcher.ts`, `src/workflow-run-watcher.ts` | `workflow-run-watcher` is STANDALONE (never touches `subagent-watcher`) — see Key Patterns |
| **AI** | `src/ai-checker-base.ts`, `src/ai-idle-checker.ts`, `src/ai-plan-checker.ts` | |
| **Tasks** | `src/task.ts`, `src/task-queue.ts`, `src/task-tracker.ts` | |
| **State** | `src/state-store.ts`, `src/run-summary.ts`, `src/session-lifecycle-log.ts` | |
| **Infra** | `src/hooks-config.ts`, `src/push-store.ts`, `src/tunnel-manager.ts`, `src/image-watcher.ts`, `src/file-stream-manager.ts` | |
| **Attachments** | `src/attachment-registry.ts`, `src/attachment-magic.ts`, `src/session-attachment-history.ts`, `src/document-preview-cache.ts`, `src/document-thumbnailer.ts`, `src/document-conversion-limiter.ts`, `src/config/attachment-guard.ts` | See Key Patterns |
| **Plan** | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/` (`claude-md.ts` + `case-template.md`, the CLAUDE.md scaffold generated into new cases) | |
| **Web** | `src/web/server.ts` ★, `src/web/sse-events.ts`, `src/web/routes/*.ts` (18 route modules + barrel; `session-routes.ts` ★), `src/web/route-helpers.ts`, `src/web/ports/*.ts`, `src/web/middleware/auth.ts`, `src/web/schemas.ts`, `src/web/self-update.ts`, `src/web/plan-usage-latest.ts` | |
| **Frontend** | `src/web/public/app.js` (~4K lines, core) + 6 infra modules (`constants.js`, `mobile-handlers.js`, `voice-input.js`, `notification-manager.js`, `keyboard-accessory.js`, `sanitize-html.js` — DOMPurify mXSS allowlist, COD-56) + 9 domain modules (`terminal-ui.js`, `respawn-ui.js`, `ralph-panel.js`, `orchestrator-panel.js`, `ultracode-panel.js`, `cron-ui.js`, `settings-ui.js`, `panels-ui.js`, `session-ui.js`) + 6 feature modules (`ralph-wizard.js`, `api-client.js`, `subagent-windows.js`, `ultracode-windows.js`, `input-cjk.js`, `image-input.js`) + `sw.js` | `ultracode-windows.js` = floating run windows w/ tab connector lines (additional to the dock panel) |
| **Types** | `src/types/index.ts` (barrel) → 17 domain files (incl. `workflow-run.ts`, `search.ts`); also `src/types.ts` root re-export | See `@fileoverview` in index.ts |

★ = Large, central file (>50KB) — read its `@fileoverview` first. All files have `@fileoverview` JSDoc — read that before diving in. Discovery aid: `grep -l '@fileoverview' src/web/routes/*.ts` lists all route modules; same grep works for `src/types/`, `src/web/public/*.js`.

**Local packages**: `packages/xterm-zerolag-input/` — local echo overlay for xterm.js; single-source, bundled to the gitignored `vendor/xterm-zerolag-input.js` and consumed by `app.js` (see Gotchas). `packages/gesture-control/` (`codeman-gesture-control`) — hand-tracking overlay source; built to `src/web/public/gesture/gesture-codeman.js` via `npm run build:gesture` (see Frontend → Gesture control).

**Config**: `src/config/` — 14 files, no barrel (`index.ts`) exists; import from the specific file.

**Utilities**: `src/utils/` — re-exported via index. Key: `CleanupManager`, `LRUMap`, `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `Debouncer`, `KeyedDebouncer`. Also: `claude-cli-resolver`/`opencode-cli-resolver`/`codex-cli-resolver` (CLI path resolution), `string-similarity` (fuzzy matching), `regex-patterns` (ANSI/token/spinner patterns), `assertNever` (exhaustive checks), `token-validation` (auth tokens), `nice-wrapper` (process priority).

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input**: `session.writeViaMux()` for programmatic/curl input — tmux `send-keys -l` (literal) + `send-keys Enter`. Single-line only (fire-and-once). Interactive **browser** input goes through a durable **exactly-once** layer: each frame carries a stable `clientId` + monotonic per-session `seq`, persisted to localStorage until the server ACKs (`{t:'ia',seq}` over WS, or HTTP 2xx), so a dropped link/reconnect can't lose or double-deliver a prompt.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Auto-resume on usage limit** ("token pause" control, opt-in per session, top of the Respawn tab): when Claude halts on a subscription limit ("5-hour limit reached ∙ resets 8pm" and all 1.0.x–2.1.x variants), `usage-limit-patterns.ts` (pure, unit-tested) parses the reset time from cleaned output; `SessionAutoOps` arms a timer for reset+2min, then sends Esc (dismisses the rate-limit dialog) + `continue`. Still-limited responses re-arm the loop (5-min retry on stale times); a `working` transition cancels it. Claude-mode only (detection rides `_processExpensiveParsers`). Persists/recovers via `SessionState.autoResumeEnabled`/`autoResumeAt`; respawn cycles are blocked while paused (`isLimitPaused` guard in `onIdleDetected` — prevents `/clear` from wiping the paused conversation). Endpoint: `POST /api/sessions/:id/auto-resume`; SSE: `session:limitPauseScheduled`/`limitResume`/`limitResumeCancelled`. Tests: `test/usage-limit-patterns.test.ts`, `test/session-auto-resume.test.ts`.

**Plan-usage chip** (statusLine telemetry, opt-in `showPlanUsageLimits`, default OFF): Claude Code (v2.1.80+) pipes a JSON blob to a configured `statusLine.command` on each render; on Pro/Max it carries a `rate_limits` object (`five_hour`/`seven_day` windows only — no Opus weekly field — each `{used_percentage 0-100, resets_at epoch-SECONDS}`). Codeman injects its OWN statusLine exporter (`generateStatusLineCommand()` in `hooks-config.ts`, identified by the `/api/status-telemetry` marker — it only ever adds/updates/removes a statusLine that is *ours*, never a user's hand-authored one) that POSTs the blob to `POST /api/status-telemetry`. That route (auth-exempt like `/api/hook-event` — localhost-only, hook-secret-gated under a tunnel) parses via `usage-telemetry.ts` (pure, unit-tested), broadcasts SSE `session:statusTelemetry` (de-duped per session by `telemetrySignature` since the statusline fires on every assistant message), and returns a compact plain-text footer for the exporter to **print-through** (so injecting our statusLine doesn't blank the in-terminal footer). `plan-usage-latest.ts` holds the process-wide last value, replayed in the SSE init snapshot (`getLightState`) so the header chip (`#planUsageChip`, toggled by `showPlanUsageLimits` in settings-ui.js) renders immediately on page load / reconnect without per-browser localStorage. Claude-mode only. **Distinct from auto-resume** (which reacts to the limit *message*; this proactively shows the live %). Design: `docs/usage-limits-display-plan.md`. Tests: `test/usage-telemetry.test.ts`.

**Orchestrator**: State machine that turns a user goal into a phased plan and drives it to completion: `idle → planning → approval → executing → verifying → (replanning) → completed/failed`. `OrchestratorLoop` (engine) delegates plan generation to `orchestrator-planner` and per-phase verification gates to `orchestrator-verifier`, executing phases via team agents/`task-queue`. State persists under the `orchestrator` key in `state.json`. Distinct from Ralph (single-session autonomous loop) — orchestrator coordinates multi-phase, multi-agent execution. See `docs/orchestrator-loop-architecture.md`.

**Cron (cron-style `CronJob`s)**: saved, named jobs with a recurring schedule (`once`/`interval`/`daily`/`weekly`), enable/disable, Run Now, next-run calc, and per-job run history (`CronJobRun`). ⚠️ **Distinct from the legacy `ScheduledRun`** (`/api/scheduled`, a run-now duration-bounded autonomous loop) — the two never interact; the legacy concept keeps the `Scheduled*` names, the recurring-job feature is `Cron*`. `CronService` (`src/cron/cron-service.ts`) owns CRUD + the 30s background due-tick (`tickDueJobs`, registered via `cleanup.setInterval` in `server.ts`; `init()` recomputes nextRunAt on boot) and **reuses the existing session layer** (create → `addSession` → `setupSessionListeners` → `startInteractive`/`startShell` → prompt via `writeViaMux`/`write`) rather than rebuilding tmux logic. Next-run math is pure/unit-tested in `cron-time.ts` (SERVER-LOCAL timezone for daily/weekly). Dup-launch guard = `lastDueKey` (jobId:fireTime); schedule is advanced BEFORE launch so a slow launch can't re-trigger. `once` jobs self-disable after firing (`completedOnce`). Persisted via `AppState.cronJobs`/`cronJobRuns` (StateStore accessors). Routes `/api/cron/jobs*` + `/api/cron/runs` (`cron-routes.ts`, `CronPort`); schema `CronJobSchema` (cross-field `superRefine`; the `.partial()` update schema does NOT re-run it); SSE `cron:*`. Frontend `cron-ui.js` (#cronModal). Claude/shell/opencode/codex/gemini agent types. Tests: `test/cron-time.test.ts`, `test/cron-service.test.ts`. Design: `docs/cron-discovery.md`.

**External CLI modes (OpenCode, Codex, Gemini)**: `isExternalCliMode()` in `session.ts` (`mode === 'opencode' || 'codex' || 'gemini'`) gates Claude-specific behavior — Ralph tracker, BashToolParser, token/CLI-info parsing, and ❯-prompt readiness detection are all skipped (these CLIs render their own TUIs; readiness = output stabilization instead). All three modes **require tmux — no direct PTY fallback** — because secrets are injected via `tmux setenv` (socket-scoped `${this.tmux()} setenv`, never on the spawn command line): OpenCode gets `OPENCODE_CONFIG_CONTENT` etc., Codex gets `OPENAI_API_KEY`/`CODEX_API_KEY`/`CODEX_HOME` (`setCodexEnvVars`), Gemini gets `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_CLOUD_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS`/`GOOGLE_GENAI_USE_VERTEXAI` etc. (`setGeminiEnvVars`, all in `tmux-manager.ts`). Codex specifics: command built by `buildCodexCommand()` (`--model`, `resume <id>`, `--dangerously-bypass-approvals-and-sandbox` from the `codexConfig` payload / `codexDangerouslyBypassApprovals` app setting; `renderMode` is schema-coerced to `'hybrid'`, the only supported mode). Gemini specifics: command built by `buildGeminiCommand()` (`--skip-trust` always, `--approval-mode <default|auto_edit|yolo|plan>` defaulting to `yolo` for parity with Claude's `--dangerously-skip-permissions`, `--model`, `--resume` from the `geminiConfig` payload); availability via `GET /api/gemini/status` — session/quick-start routes fail with `OPERATION_FAILED` + install hint (`npm install -g @google/gemini-cli`) when missing. Codex AND Gemini export `COLORTERM=truecolor` + unset `NO_COLOR` (other modes unset `COLORTERM`); Gemini joins `isAltScreenStripMode()` (Codex/Claude/Gemini are Ink TUIs that repaint inline → strip alt-screen/`3J` so scrollback survives). Codex availability via `GET /api/codex/status`. Frontend: run-mode dropdown → `runCodex()`/`runGemini()` in `session-ui.js` ("Run CX"/"Run GM" labels), App Settings → Codex CLI tab; Respawn/Ralph options are Claude-only, so session options open on the Summary tab for external CLI sessions. ⚠️ `run*()` MUST unwrap the `{success,data}` envelope (`(await res.json()).data.available` / `data.data.sessionId`) — reading the raw shape silently breaks the run. Tests: `test/run-mode-ui.test.ts` + `test/gemini-mode.test.ts` (vm-sandbox harness, no real DOM).

**Hook events**: Claude Code hooks trigger via `/api/hook-event`. Key events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`, `teammate_idle`, `task_completed`. See `src/hooks-config.ts`; upstream hook semantics mirrored in `docs/claude-code-hooks-reference.md`.

**Agent Teams**: `TeamWatcher` polls `~/.claude/teams/`, matches to sessions via `leadSessionId`. Teammates are in-process threads appearing as subagents. Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See `docs/agent-teams/`.

**Circuit breaker**: Prevents respawn thrashing. States: `CLOSED` → `HALF_OPEN` → `OPEN`. Reset: `/api/sessions/:id/ralph-circuit-breaker/reset`.

**Self-update** (App Settings → Updates): in-app updater for **git-clone installs** supervised by systemd/launchd. Supervisors: `systemd` (user unit), `launchd` (GUI LaunchAgent, gui-domain kickstart), `launchd-daemon` (KeepAlive system LaunchDaemon on headless Macs — restarts rootlessly by killing the server PID and letting launchd respawn it; detected only when the daemon is bootstrapped AND KeepAlive), else `none` → "restart manually" message; on next boot a manual-restart status auto-completes when the running version matches the target. The update restarts the very process running it, so the real work runs in a DETACHED `scripts/self-update.sh` (`git checkout <release tag> && npm install && npm run build && restart`) that outlives the restart; it writes progress to `dataPath('update-status.json')`, which the browser polls across the connection drop. Channel = latest `codeman@X.Y.Z` release tag; dirty trees are auto-stashed. `src/web/self-update.ts` splits PURE helpers (semver/tag parsing, reconcile decision — unit-tested) from IO wrappers (`getInstallInfo`/`checkForUpdate`/`startUpdate`/`reconcileUpdateOnBoot`). Routes: `GET /api/system/update/check`, `POST /api/system/update`, `GET /api/system/update/status`. Types: `src/types/update.ts`. npm installs report as non-updatable.

**Attachments** (live external document references; COD-37/#119 core, COD-38/#120 previews, COD-39/#121 history): all wiring in `file-routes.ts`. **Registry** (`attachment-registry.ts`): an **in-memory** map of a stable `attachmentId` → an absolute, `realpath`-resolved, extension-allowlisted file path, so browser requests (`GET /api/sessions/:id/attachments/:attachmentId/raw`) never carry arbitrary absolute paths; `POST /api/sessions/:id/attachments` registers one. **Magic links** (`attachment-magic.ts`): parses `codeman://attach?...` out of terminal output — ⚠️ this scanner is prompt-injectable, so the scan path is **force-confined to the session workspace** (a hostile prompt could otherwise make it read arbitrary host files over SSE); emits the `attachment:detected` SSE event. Security gate is an extension **allowlist** (`isSupportedAttachmentExtension`, in the registry/magic modules), not a blocklist; a separate path layer (`config/attachment-guard.ts`) confines reads to the workspace (`attachmentConfineToWorkspace`) and blocks sensitive trees (`/root`, `/etc`). **Previews + thumbnails** (COD-38): `:attachmentId/preview` + `:attachmentId/thumbnail` (and the workspace-file equivalents `file-preview`/`file-thumbnail`) render Office docs/PDFs via external converters (`pdftoppm` / LibreOffice `soffice` / Word-COM `powershell`); `document-preview-cache.ts` is a shared disk cache (de-dups *identical* in-flight inputs), `document-thumbnailer.ts` does best-effort first-page images, and `document-conversion-limiter.ts` is a **global converter-spawn concurrency cap** (`runWithConversionLimit`) — without it, N distinct large docs detected at once fork N multi-minute converter processes = a localhost fork-bomb-shaped resource-exhaustion vector. **History drawer** (COD-39): `session-attachment-history.ts` tracks the last `ATTACHMENT_HISTORY_LIMIT` (100) attachments per session (`Session._attachmentHistory`, persisted via `SessionState.attachmentHistory`, replayed so externals re-register on reconnect); `GET /api/sessions/:id/attachments` is the list endpoint. ⚠️ The history drawer's launcher button is desktop-only — hidden on phones (regression-guarded; see `mobile-header-buttons-policy` test). Session-local files keep using the existing workspace-scoped `file-routes` paths; the registry is only for explicit live externals.

**Ultracode / Workflow-run visualization** (opt-in `showUltracodeAgents`, default OFF; released 1.1.2): the Workflow tool ("ultracode") writes a run-state JSON per run at `~/.claude/projects/<projHash>/<sessionUuid>/workflows/wf_*.json`. `workflow-run-watcher.ts` (STANDALONE — deliberately never imports/touches `subagent-watcher.ts`; disjoint directory tree, separate singleton) globs that tree via periodic poll + per-run chokidar watcher with per-file mtime skip, and broadcasts SSE `workflow:run_discovered`/`run_updated`/`run_removed`. The watcher is started when **either** `showUltracodeAgents` **or** `ultracodeFloatingWindows` is on (`server.ts` `_updateWorkflowWatcher` returns `(showUltracodeAgents ?? false) || (ultracodeFloatingWindows ?? false)`). Served via `GET /api/workflows` (optional `?minutes=` filter) and `GET /api/workflows/:runId`. Frontend `ultracode-panel.js` renders a docked master-detail view (LEFT: runs + phases; RIGHT: per-agent tokens + tool-calls; click an agent card → its live transcript via client-side `agentId` join). **Additionally**, `ultracode-windows.js` auto-pops a draggable **floating window per active run** (gated on a **DEDICATED** `ultracodeFloatingWindows` toggle, default OFF — independent of the dock panel's `showUltracodeAgents`; see `_ultracodeFloatingEnabled()`), connected by a glowing line to the originating session tab (resolved by `session.claudeSessionId === run.sessionUuid`) — same line idiom as subagent windows, drawn into the shared `#connectionLines` SVG from the tail of `_updateConnectionLinesImmediate`. The window auto-closes ~8s after its run finishes; explicit dismissals are remembered. Clicking an agent card opens an **in-page** connected transcript window (not a browser popup); both run and transcript windows minimize **into** the originating session tab as a merged `ULTRA` badge (🧬 runs / 📄 transcripts) with a restore/dismiss dropdown — minimized runs are skipped by auto-pop. Gesture beta: floating subagent/ultracode windows are pinch-draggable (a `window` grab kind in `entry.ts`). Types: `src/types/workflow-run.ts`. Config: `src/config/workflow-config.ts`.

**Cross-session search** (COD-113/#133): `GET /api/search?q=&types=&limit=` federates an **in-memory** search across all live sessions — session metadata (name/workingDir/id), run-summary events, and per-session attachment-history file entries (workspace-relative path only; the server-private `externalPath` is never read). Pure core in `search-service.ts` (`harvestSources()` gathers, `searchSources()` substring-matches with hard per-type caps — no regex, so no ReDoS; no filesystem reads, so no traversal). `SearchQuerySchema` bounds `q` (1–200), allowlists `types` (`session,event,file`), clamps `limit` (1–60). Returns the `{success,data}` envelope. Frontend: history-panel search box in `terminal-ui.js`. Types: `src/types/search.ts`.

**Away digest** (COD-41/#136): `GET /api/away-digest?range=&since=&until=&lastViewed=` aggregates "what happened while you were away" from the lifecycle log + run-summary events + live sessions + daily token stats + recently-completed subagents into needs-attention/completed/still-running/idle/informational sections. Pure aggregator in `web/away-digest.ts` (`resolveAwayDigestRange()` validates the window — `since-last-visit`/`1h`/`today`/`24h`/`custom`, server-local TZ; `buildAwayDigest()` classifies). Header-button modal in `panels-ui.js` (button hidden on phones — regression-guarded). ⚠️ Returns `{success:true,digest}` (a legacy raw-ish shape, consistent with the other raw GET handlers in `system-routes.ts` — `{entries}`/`{config}`/`{files}`/`getSystemStats()`); frontend + tests read `.digest`. Subagent lookback is a fixed 60-min window regardless of range.

**Ralph todo-config** (COD-79/#135): per-session `maxTodos` (FIFO-eviction cap, default 500 = `MAX_TODOS_PER_SESSION`) + `todoExpirationMinutes` (auto-expiry, default 60) set via `POST /api/sessions/:id/ralph-config` (`RalphConfigSchema`, both `.int().positive()`). Stored on the tracker (`setMaxTodos`/`setTodoExpirationMinutes`) and **persisted/read-back via `RalphTrackerState`** (surfaced in the `loopState` getter → `toState()` + SSE broadcast → modal `populateRalphForm`), mirroring how `maxIterations` round-trips. Claude-only (skipped by `isExternalCliMode`).

**Port interfaces**: Routes declare dependencies via port interfaces (`src/web/ports/`). Routes use intersection types (e.g., `SessionPort & EventPort`).

### Frontend

Frontend JS modules have `@fileoverview` with `@dependency`/`@loadorder` tags. Load order: `constants.js`(1) → `mobile-handlers.js`(2) → `voice-input.js`(3) → `notification-manager.js`(4) → `keyboard-accessory.js`(5) → `input-cjk.js`(5.5) → `sanitize-html.js`(5.6) → `app.js`(6) → `terminal-ui.js`(7) → `respawn-ui.js`(8) → `ralph-panel.js`(9) → `orchestrator-panel.js`(9.5) → `settings-ui.js`(10) → `panels-ui.js`(11) → `ultracode-panel.js`(11.5) → `session-ui.js`(12) → `ralph-wizard.js`(13) → `api-client.js`(14) → `subagent-windows.js`(15) → `ultracode-windows.js`(15.5) → `image-input.js`(16). `input-cjk.js` handles CJK IME composition via an always-visible textarea below the terminal (`window.cjkActive` blocks xterm's onData).

**Z-index layers**: subagent windows (1000), plan agents (1100), mobile/tablet fixed header (1200, `mobile.css`), modals on ≤768px (1300 — must beat the fixed header or the modal close button is buried; bug fixed in `b8cb467`), log viewers (2000), image popups (3000), local echo overlay (7).

**Multi-monitor button** (header, top-right; the notification bell it sits beside stays hidden — notifications live in Settings → Notifications). `app.launchMultiMonitor()` (in `panels-ui.js`) POSTs `/api/system/span-displays`, which spawns `scripts/span-codeman.sh` — a fresh, maximized browser `--app` window sized to the union of all displays (macOS; needs "Displays have separate Spaces" OFF). Supports the gesture layer's in-page floating session panels dragging across the physical monitor seam. **Opt-in:** hidden by default; enable under App Settings → Display → **Header Displays** ("Multi-monitor Button", `showMultiMonitorButton`). The button carries a `btn-multimonitor--hidden` class in the template; `renderIndexHtml` strips that class at render when the setting is on (a unique class token, not a brittle match on the aria-label/style copy), and `applyHeaderVisibilitySettings()` toggles the same class live on save. Solo (detached) windows hide it via `body.solo-mode`.

**Response-viewer (eye) button** (header) is likewise **hidden by default** — enable under App Settings → Display → **Response Viewer** (`showResponseViewer`). Purely client-side (no `renderIndexHtml` step): the template ships with `btn-response-viewer-header--hidden` and `applyHeaderVisibilitySettings()` (settings-ui.js) toggles it after settings load. Hiding must go through that marker class — the base rule is `display:inline-flex !important`, so an inline style can't override it. `showResponseViewer` is in the `displayKeys` per-device set (settings-ui.js), so it does NOT sync across devices.

**Gesture control** (the camera hand-tracking overlay) is **opt-in, default OFF**, under App Settings → Display → **Input** (`gestureControlEnabled`). `CODEMAN_GESTURE=1` makes the feature *available* on the instance (CSP widening + `/gesture/` assets) and sets `window.__codemanGestureAvailable` (the Input section only shows when set); the overlay bundle is injected by `renderIndexHtml` **only when the setting is enabled**, so that method is `async` and reads `settings.json` via `readSettings(true)` — the `true` forces a **fresh** read (bypassing the 2s `_settingsCache`), because a post-save reload happens within that TTL and the cached value would otherwise render the pre-toggle state. Toggling the setting reloads the page (the bundle is render-injected).

**Gesture-control source lives in-repo** at `packages/gesture-control/` (workspace package `codeman-gesture-control`, was the standalone `Ark0N/codeman-gesture-control` repo). The transport-agnostic core is `src/gesture/*` (MediaPipe GestureRecognizer → One-Euro-filtered cursor → pinch state machine); `src/codeman/entry.ts` is the Codeman *consumer* that maps grab/drag/drop onto real `.session-tab`/toolbar buttons and is the bundle entry. **Edit there, then run `npm run build:gesture`** (`scripts/build-gesture-bundle.mjs` → esbuild bundles `entry.ts`, MediaPipe JS included, into `src/web/public/gesture/gesture-codeman.js`) and **commit the regenerated bundle** — the committed bundle is what dev/`tsx` serves (no bundler at runtime), and `scripts/build.mjs` reruns the same step so prod always reflects current source. The MediaPipe **wasm + model** are NOT bundled — loaded at runtime from same-origin `/gesture/wasm` + `/gesture/gesture_recognizer.task`, fetched by `scripts/fetch-gesture-assets.mjs` (gitignored, see Gotchas). `entry.ts` mounts `window.__codemanGesture = new GestureBridge()` idempotently at module-eval. A standalone vite playground (`npm run dev` in the package — fake tabs, no Codeman) lets you iterate on gesture *feel* in isolation. ⚠️ Keep `MP_VERSION` in `fetch-gesture-assets.mjs` in sync with `@mediapipe/tasks-vision` in `packages/gesture-control/package.json`.

**Theme skins** (App Settings → Display): the `skin` setting selects a palette via a `data-skin` attribute on `<html>`. Values: `daylight-blue` (default), `daylight-green`, `og` (OG Codeman). CSS lives under `[data-skin="…"]` blocks in `styles.css`. To avoid a flash-of-wrong-theme, an **inline pre-paint script** in `index.html` (`<head>`) reads `localStorage['codeman:skin']` and sets `data-skin` before first paint; `settings-ui.js` `applyTheme()`/`applyTerminalSkin()` apply it live on save and keep the standalone `codeman:skin` key + the settings object in sync. `skin` is a **per-device/client-only** setting — it's destructured OUT of the server payload (settings-ui.js, alongside `localEchoEnabled`/`cjkInputEnabled`/`extendedKeyboardBar`), so it does NOT sync across devices.

**Respawn presets**: `solo-work` (3s/60min), `subagent-workflow` (45s/240min), `team-lead` (90s/480min), `ralph-todo` (8s/480min), `overnight-autonomous` (10s/480min).

**Keyboard shortcuts**: Escape (close), Ctrl+? (help), Ctrl+W (kill), Ctrl+Tab (next), Alt+1-9 (switch tab), Ctrl+Shift+{/} (move tab left/right), Shift+Enter (newline), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl+Shift+V (voice input), Ctrl/Cmd +/- (font).

### Security

**Full model: [`docs/security-architecture.md`](docs/security-architecture.md)** — network binding, auth pipeline, the tunnel caveat, file-serving hardening, supply-chain, instance isolation, and recommended secure setups.

| Layer | Details |
|-------|---------|
| **Auth** | Optional HTTP Basic via `CODEMAN_USERNAME` (defaults to `admin`) / `CODEMAN_PASSWORD` env vars. Active only when `CODEMAN_PASSWORD` is set (`middleware/auth.ts`) |
| **Network bind** | Defaults to `127.0.0.1` (loopback). A non-loopback bind (`--host`/`CODEMAN_HOST`) without `CODEMAN_PASSWORD` **starts but warns loudly** (0.9.0; was fail-closed in COD-29/#107). `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` acknowledges the warning. Classifier: `network-auth-policy.ts` |
| **Host guard** | Always-on Host-header allowlist blocks DNS rebinding (RCE on the default no-auth loopback install). Allows loopback, any IP literal, the bind host, `*.ts.net`/`*.trycloudflare.com`/`*.cfargotunnel.com`, the active managed tunnel, and `CODEMAN_ALLOWED_HOSTS`. ⚠️ **Custom reverse-proxy domains are rejected** unless added via `CODEMAN_ALLOWED_HOSTS=host,.suffix`. `registerHostGuard` in `server.ts`; policy in `network-auth-policy.ts` (`buildHostPolicy`/`isAllowedRequestHost`/`isAllowedRequestOrigin`) |
| **CSRF / Origin** | Always-on cross-site Origin guard rejects state-changing requests from foreign origins (covers self-update, session create/input, settings/tunnel toggles). **A missing Origin is allowed** so curl/CLI and Claude Code hooks keep working. The global body parser keeps `text/plain` RAW (no auto-JSON-parse, which had enabled simple-request CSRF); `/api/crash-diag` self-parses. WebSocket upgrade validates Origin+Host (anti-CSWSH) in `ws-routes.ts`. Added in `c669518` (closes 2026-06-09 review CRITICALs) |
| **QR Auth** | Single-use 6-char tokens (60s TTL) for tunnel login. See `docs/qr-auth-plan.md` |
| **Sessions** | 24h cookie (`codeman_session`), auto-extend, device context audit |
| **Rate limit** | 10 failed auth/IP → 429 (15min decay). QR has separate limiter |
| **Hook bypass** | `/api/hook-event` (and `/api/status-telemetry`, the statusLine exporter) exempt from auth (localhost-only, schema-validated). While the **managed tunnel** runs, the bypass additionally requires the per-instance `X-Codeman-Hook-Secret` header (COD-54, `config/hook-secret.ts`): hook curls cat the secret file at exec time via `$CODEMAN_HOOK_SECRET_FILE` (session env), failures rate-limit in a dedicated bucket (never lock out login). External loopback proxies (own cloudflared/`tailscale serve`) aren't detected — plain bypass still applies there. Tunnel enable **refuses** without `CODEMAN_PASSWORD` unless exposure is acknowledged — via `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` (env, COD-55) **or** the per-request `acknowledgeUnauthTunnel:true` action field (1.1.9): the welcome/settings tunnel toggle pops a security confirm dialog and, on confirm, resends with that flag (server logs a loud warning on every passwordless tunnel start; curl/API stay refused without password/env/flag). The flag is an action field, never persisted |
| **Env vars** | `CODEMAN_MUX` (managed session), `CODEMAN_API_URL` (auto-set for hooks), `CODEMAN_ALLOWED_HOSTS` (extra Host/Origin allowlist entries for reverse proxies, comma-separated; bare `.suffix` matches subdomains) |
| **Validation** | Zod schemas, path allowlist regex, env prefix allowlist (`CLAUDE_CODE_*`/`OPENCODE_*`/`CODEX_*`) |
| **Headers** | CORS localhost-only, CSP, X-Frame-Options, HSTS if HTTPS |

### SSE Event Registry

~127 event types in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). Both must be kept in sync.

### API Routes

~160 handlers across 18 route files in `src/web/routes/`: system (45, incl. self-update `check`/`status`/`POST /api/system/update`, `POST /api/system/span-displays` → spawns `scripts/span-codeman.sh`, `GET /api/codex/status`, `GET /api/gemini/status`, and `GET /api/away-digest`), sessions (29), orchestrator (10), cases (9), ralph (9), plan (8), files (14, incl. attachment register + list/history + `:attachmentId/raw`/`preview`/`thumbnail` + workspace `file-preview`/`file-thumbnail`), respawn (7), mux (5), push (4), scheduled (4, legacy `ScheduledRun`), cron (9, cron-style `CronJob` jobs/runs), teams (2), search (1, `GET /api/search`), hooks (1), clipboard (1), status-telemetry (1, `POST /api/status-telemetry` ← statusLine exporter), ws (1 WebSocket). Each file has `@fileoverview` with endpoint details.

**HTTP contract** (stable since 0.9.x, see `docs/versioning-policy.md`; full envelope/status/error-code/SSE spec in `docs/api-reference.md`): responses use the `ApiResponse<T>` envelope — `{ success: true, data? }` or `{ success: false, error, errorCode }` (`src/types/api.ts`). `/api/v1/*` is a versioned alias of `/api/*` (URL rewrite in `server.ts`).

## Adding Features

- **API endpoint**: Types in `src/types/` domain file, route in `src/web/routes/*-routes.ts`. Return the `ApiResponse` envelope (`{ success: true, data }`; errors via `createErrorResponse()` with proper status code). Validate with Zod schemas in `schemas.ts`.
- **SSE event**: Add to `src/web/sse-events.ts` + `SSE_EVENTS` in `constants.js`, emit via `broadcast()`, handle in `app.js` (`addListener(`)
- **Session setting**: Add to `SessionState`, include in `session.toState()`, call `persistSessionState()`
- **Hook event**: Add to `HookEventType`, add hook in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema`
- **Mobile feature**: Add to relevant singleton, guard with `MobileDetection.isMobile()`
- **New test**: Pick unique port (search `const PORT =`). Route tests use `app.inject()` (no port needed) — see `test/routes/_route-test-utils.ts`.

**Validation**: Zod v4 (different API from v3). Define schemas in `schemas.ts`, use `.parse()`/`.safeParse()`.

## State Files

All in `~/.codeman/`: `state.json` (sessions, settings, respawn), `mux-sessions.json` (tmux recovery), `settings.json` (user prefs), `push-keys.json` (VAPID), `push-subscriptions.json`, `session-lifecycle.jsonl` (audit log), `update-status.json` (self-updater progress, polled across the service restart).

**Generated top-level dirs** (all gitignored — don't edit or commit): `dist/` (esbuild output), `out/`, `coverage/`, `test-results/`, `tmp/`, `screenshots-echo-diag/`. The committed gesture bundle (`src/web/public/gesture/gesture-codeman.js`) IS tracked, but its runtime wasm/model assets (`src/web/public/gesture/wasm/`, `*.task`) are fetched and gitignored.

## Testing

**Never run the bare full suite** (`npm test` with no file argument): the default config includes the browser-driven suites (`test/mobile/**` and 3 other Playwright tests), which need a live server + chromium + environment-specific PNG baselines and will fail/hang locally. Run individual files, or `test:ci` for a broad sweep:

```bash
npm test -- test/<specific-file>.test.ts         # Single file (SAFE, uses config/vitest.config.ts)
npm test -- -t "pattern"                          # By name (SAFE)
npm run test:ci                                   # Everything except browser/perf suites — what CI runs
# npm test                                        # DON'T — includes browser/visual suites
```

Raw `npx vitest` skips `config/vitest.config.ts`; always use `npm test --` or pass `--config config/vitest.config.ts`.

**Config**: Vitest with `globals: true`, `fileParallelism: false`. Timeout 30s, teardown 60s. `config/vitest.ci.config.ts` = same minus the browser/perf excludes — keep the two configs in sync when changing shared options.

**Tmux safety**: under vitest (`VITEST` env var, set automatically), `TmuxManager` no-ops ALL shell commands and becomes a pure in-memory mock — tests physically cannot create/kill/attach real tmux sessions (`IS_TEST_MODE` in `src/tmux-manager.ts`). `test/setup.ts` additionally strips `CODEMAN_PASSWORD`/`CODEMAN_USERNAME` so auth state from the running instance can't leak into tests.

**Ports**: Pick unique ports manually. Search `const PORT =` before adding new tests.

**Respawn tests**: Use `MockSession` from `test/mocks/index.ts` (defined in `test/mocks/mock-session.ts`). **Route tests**: `app.inject({ method, url, payload })` in `test/routes/` — no live port needed. **Mobile tests**: Playwright suite in `test/mobile/` (135 device profiles). Browser-testing infra and practices: `docs/browser-testing-guide.md`.

## Debugging

```bash
tmux list-sessions                                 # List tmux sessions
curl localhost:3000/api/sessions | jq              # Check sessions
curl localhost:3000/api/status | jq                # Full app state
curl localhost:3000/api/subagents | jq             # Background agents
cat ~/.codeman/state.json | jq                     # Persisted state
```

Mobile screenshots: `~/.codeman/screenshots/`, accessed via `GET/POST /api/screenshots`.

## Performance & Limits

Target: 20 sessions, 50 agent windows at 60fps. Limits in `src/config/`: terminal 2MB, text 1MB, messages 1000, max agents 500, max sessions 50, max SSE clients 100. **Image upload** (`image-input.js` / `config/buffer-limits.ts`): up to `_maxBatchImages` 20 images/batch (bounded concurrency 3), per-file `MAX_PASTE_IMAGE_BYTES` 50MB (env `CODEMAN_MAX_PASTE_IMAGE_BYTES`); the mobile camera-roll picker auto-downscales to fit before upload. Use `LRUMap` for bounded caches, `StaleExpirationMap` for TTL cleanup. Anti-flicker pipeline: `docs/terminal-anti-flicker.md`.

**Memory leaks (24+ hour sessions)**: use `CleanupManager`, clear Maps in `stop()`, guard async with `if (this.cleanup.isStopped) return`. Frontend: store handler refs, clean in `close*()`. Verify: `npm test -- test/memory-leak-prevention.test.ts`.

## Scripts & Tunnel

Key scripts: `scripts/tmux-manager.sh` (safe tmux mgmt), `scripts/tunnel.sh start|stop|url` (tunnel). Production services: `scripts/codeman-web.service`, `scripts/codeman-tunnel.service`. **Always set `CODEMAN_PASSWORD`** before exposing via tunnel.
