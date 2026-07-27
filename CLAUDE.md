# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Deep implementation detail lives in [`docs/architecture-invariants.md`](docs/architecture-invariants.md). This file holds the rules that prevent mistakes; that file holds the mechanisms, file inventories, and the history behind each rule. Pointers below are written as `→ architecture-invariants#anchor`.
>
> **This file is in `.prettierignore` on purpose.** Prettier's markdown printer escapes underscores inside the glob-heavy paths used throughout (`agent-*.jsonl` became `agent-\_.jsonl`, collapsing backtick spans and corrupting a whole paragraph). Do not remove the ignore entry, and do not run `prettier --write` on it.

## Quick Reference

| Task        | Command                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev server  | `npm run dev` (or `npx tsx src/index.ts web`)                                                                                                                       |
| Type check  | `tsc --noEmit`                                                                                                                                                      |
| Lint        | `npm run lint` (fix: `npm run lint:fix`)                                                                                                                            |
| Format      | `npm run format` (check: `npm run format:check`)                                                                                                                    |
| Single test | `npm test -- test/<file>.test.ts` (or `npx vitest run --config config/vitest.config.ts test/<file>.test.ts`) — ⚠ **never** run bare `npm test`, see Testing section |
| Build       | `npm run build` (esbuild via `scripts/build.mjs`, NOT tsc — `tsc --noEmit` is type-check only)                                                                      |
| Production  | `npm run build && systemctl --user restart codeman-web`                                                                                                             |

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

The production server caches static files for 1 year, `immutable` (`maxAge: '1y'` in `server.ts`). To avoid stale frontend after a deploy, `renderIndexHtml` runs `cacheBustAssets(html)` — it appends `?v=<mtime>` to **every same-origin `.js`/`.css`** reference (mtime memoized ~1s so a burst of renders is cheap; external/already-versioned/missing refs untouched). Because `index.html` is served `no-cache`, a **normal reload now picks up edited modules/styles — no hard refresh needed** (the gesture bundle is injected separately with its own `?v=`). If you add an asset referenced by an _absolute_ URL or from JS rather than a `<script>/<link>` tag, it won't be auto-busted.

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
6. **Wait for CI**: after `git push`, TWO workflows fire per master push — `CI` and `Release` (the npm publish + GitHub release). List both runs for the pushed commit with `gh run list --commit $(git rev-parse HEAD) --json databaseId,workflowName` and watch EACH with `gh run watch <id> --exit-status`. Confirm both pass before considering the release done (`gh run list -L 1` returns only one of the two).

CI runs `npm run check:lockfile` on every push/PR, so lockfile drift fails the build even if the `version-packages` script is bypassed.

**Version**: 1.8.0 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports Claude Code, OpenCode, Codex (OpenAI), and Gemini (Google) CLIs via pluggable CLI resolvers (`SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini'`).

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 22+, Claude CLI, tmux

**Git**: Main branch is `master`. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

## Additional Commands

`npm run dev` = dev server. Default port: `3000` (override with `--port` or the `CODEMAN_PORT` env var). To run this beta isolated alongside a prod Codeman, use `scripts/run-beta.sh` (sets `CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`). Commands not in Quick Reference:

| Task                           | Command                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev with TLS                   | `npx tsx src/index.ts web --https`                                                                                                                                                                             |
| Override window title hostname | `npx tsx src/index.ts web --title-hostname <name>` (default: `os.hostname()` — `codeman:<name>` is used for tab title, title-flash, and OS desktop notification prefix)                                        |
| Bind a non-loopback host       | `npx tsx src/index.ts web --host 0.0.0.0` (or `-H`; env `CODEMAN_HOST`; default `127.0.0.1`). Without `CODEMAN_PASSWORD` it **starts but warns loudly** — see Common Gotchas + `docs/security-architecture.md` |
| Continuous typecheck           | `tsc --noEmit --watch`                                                                                                                                                                                         |
| Watch-mode test                | `npm run test:watch -- test/<file>.test.ts` (always pass a file — bare watch includes the browser suites)                                                                                                      |
| Test coverage                  | `npm run test:coverage`                                                                                                                                                                                        |
| Dead-code sweep                | `npm run knip` (config in `knip.json`)                                                                                                                                                                         |
| Rebuild gesture overlay        | `npm run build:gesture` (esbuild `packages/gesture-control/src/codeman/entry.ts` → `src/web/public/gesture/gesture-codeman.js`; commit the result)                                                             |
| Build the docker agent image   | `node scripts/build-agent-image.mjs` (builds `codeman/agent:base` from `docker/agent.Dockerfile`; prerequisite for Docker cases; `--engine`/`--image`/`--no-cache`)                                            |
| Gesture playground             | `npm run dev` **in** `packages/gesture-control/` (standalone vite demo, fake tabs)                                                                                                                             |
| Check public-asset formatting  | `npm run check:public-assets` (prettier-checks `src/web/public/**` text assets; `scripts/check-public-assets.mjs`)                                                                                             |
| Frontend JS syntax check       | `npm run check:frontend-syntax` (`scripts/check-frontend-syntax.mjs`; runs in CI)                                                                                                                              |
| CI-equivalent test sweep       | `npm run test:ci` (full suite minus browser/perf — see Testing)                                                                                                                                                |
| Production start               | `npm run start`                                                                                                                                                                                                |
| Production logs                | `journalctl --user -u codeman-web -f`                                                                                                                                                                          |

**CI**: `.github/workflows/ci.yml` (push to master/main + PRs, Node 22) runs two jobs: **(1)** `check:lockfile`, `typecheck`, `lint`, `check:frontend-syntax`, `format:check`, then a **server boot smoke test** (`tsx src/index.ts web --port 3151` must answer `/api/status` within 30s); **(2)** the **unit/integration test suite** via `npm run test:ci` (`config/vitest.ci.config.ts` — excludes the browser-driven `test/mobile/**` suite, `perf-*` benchmarks, and 3 Playwright tests). Tests are tmux-safe in CI: `TmuxManager` no-ops all shell commands under `VITEST` (see Testing).

**Code style**: Prettier (`singleQuote: true`, `printWidth: 120`, `trailingComma: "es5"`). ESLint flat config (`config/eslint.config.js`) allows `no-console`, warns on `@typescript-eslint/no-explicit-any`. Ignores: `app.js`, `scripts/**/*.mjs`, `src/web/public/vendor/**`, `scripts/remotion/**`.

**Prettier scope is deliberately narrow.** `npm run format` globs only `src/**/*.ts` and `src/web/public/**`, and `.prettierignore` then exempts most of `src/web/public/*.js` (app.js, styles.css, index.html, and 14 hand-formatted modules) plus `CLAUDE.md`. Those files are hand-formatted by design; `npm run check:public-assets` and `check:frontend-syntax` are what guard them (NUL bytes + JS syntax), not Prettier. Do not "fix" a file by adding it back to Prettier's scope.

## Common Gotchas

- **Single-line prompts only** — `writeViaMux()` sends text+Enter separately; multi-line breaks Ink
- **ESM only** — Never `require()`, use `await import()`. `tsx` masks CJS/ESM issues in dev but production breaks
- **Package ≠ product name** — npm: `aicodeman`, product: **Codeman**. Release renames tags accordingly. Both `aicodeman` and `codeman` bin aliases are installed (`package.json` `bin`)
- **Global regex `lastIndex`** — Shared `g`-flag patterns in loops must reset `lastIndex = 0` first, or use the `execPattern()` helper in `utils/regex-patterns.ts` (resets automatically)
- **`envOverrides` flow `CLAUDE_CODE_*` / `OPENCODE_*` / `CODEX_*` / `GEMINI_*` / `GOOGLE_*` env vars** — Set via `POST /api/sessions { envOverrides }`, stored on `Session._envOverrides`, exported by `tmux-manager.buildEnvExports()` at spawn time, persisted in `SessionState.envOverrides`. **Do NOT** write these to `<case>/.claude/settings.local.json` — that's the old path and creates UI/disk drift. (`GOOGLE_*` is the deliberately-broad Vertex-AI namespace for Gemini — see Multi-CLI prefix discipline.)
- **Effort is NOT an env var** — never carry effort as `CLAUDE_CODE_EFFORT_LEVEL`: the env var hard-locks effort and blocks in-session `/effort` switching (incl. ultracode). It flows as the dedicated `effort` payload field → `Session._effort` → `claude --effort <level>` for regular levels incl. `max` (the settings `effortLevel` key is `enum(["low","medium","high","xhigh"]).catch(undefined)` — `max` gets SILENTLY dropped there), or `claude --settings '{"ultracode":true}'` for ultracode (rejected by `--effort`). Both are soft defaults the user can override anytime. Legacy env-var entries are auto-migrated by the Session constructor and unset from tmux sessions in `applyEnvOverrides()`. See `buildEffortCliArgs()` in `session-cli-builder.ts`, tests in `test/effort-injection.test.ts`
- **Model choice flows via `settings.local.json`, NOT `--model` or env** — the App Settings **Claude Model** picker (`claudeModel` in `settings.json`) is read by `session-ui.js` at session create (wins over the legacy 1M-Opus toggles `opusContext1m`/`opusContext1mEnabled`), sent as the `modelOverride` payload field, and `updateCaseModel()` (`hooks-config.ts`) writes/deletes the `model` key in `<case>/.claude/settings.local.json`. This is the intended exception to the envOverrides rule above: model legitimately lives in `settings.local.json` (a soft default — in-session `/model` still works); env vars do not
- **Multi-CLI prefix discipline** — env-var prefix is CLI-specific (`CLAUDE_CODE_*` vs `OPENCODE_*` vs `CODEX_*` vs `GEMINI_*`) and the `ALLOWED_ENV_PREFIXES` allowlist in `schemas.ts` enforces this. Gemini additionally allowlists the **broad `GOOGLE_*`** namespace (intentional: Vertex AI auth needs `GOOGLE_CLOUD_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS`/`GOOGLE_GENAI_USE_VERTEXAI`; it is the loosest allowlist entry, affecting only the user's own spawned CLI). When adding a setting, decide which CLI(s) it applies to and gate the env export accordingly. Never blanket-forward all prefixes. Resolver design pattern: `docs/opencode-integration.md`
- **Zod `.optional()` rejects `null`** — accepts `undefined` only. When the frontend builds a request body with `JSON.stringify`, an explicit `null` field is preserved on the wire and fails validation with `INVALID_INPUT`. Convert `null` → `undefined` before stringifying (e.g. `field: value ?? undefined`), or declare the schema `.nullish()`. This has caused real shipped bugs twice
- **`xterm-zerolag-input` is single-source** — the local-echo overlay source lives ONLY in `packages/xterm-zerolag-input/src/`, and is bundled into the **gitignored** `src/web/public/vendor/xterm-zerolag-input.js` (dev, by `scripts/postinstall.js`) and `dist/.../vendor/` (prod, by `scripts/build.mjs`). `app.js` only **consumes** it via `new LocalEchoOverlay(terminal)`; there is no inline copy. So: change the package source, then rerun the bundle step (`npm install` for dev, `npm run build` for prod). **Never hand-edit `app.js` for overlay behavior, and never commit the gitignored vendor bundle.** Always test on mobile after touching it. → [architecture-invariants#xterm-zerolag-input-is-single-source](docs/architecture-invariants.md#xterm-zerolag-input-is-single-source), `docs/local-echo-overlay-plan.md`
- **Default bind is loopback-only; non-loopback without a password starts but warns** — the server defaults to `--host 127.0.0.1`. Binding non-loopback (`--host`/`-H`/`CODEMAN_HOST`) without `CODEMAN_PASSWORD` starts anyway but prints a loud warning; `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` acknowledges it. ⚠️ The production systemd unit passes no `--host`, so prod binds **localhost only**: reach it via `tailscale serve`/tunnel to `127.0.0.1`. A loopback bind is reachable through a same-host tunnel but NOT by a browser hitting the box's LAN IP. `install.sh` is separate and prompts for the binding (defaulting to LAN + a password), and preserves the existing binding on re-runs. → [architecture-invariants#default-bind-and-the-non-loopback-warning-path](docs/architecture-invariants.md#default-bind-and-the-non-loopback-warning-path), `docs/security-architecture.md`
- **Instance isolation / multi-instance attach danger** — the data dir (`~/.codeman`) and tmux socket (`tmux -L codeman`) are PROCESS-WIDE and shared by every Codeman on the machine, derived from `CODEMAN_INSTANCE` via `src/config/instance.ts`. ⚠️ A 2nd instance on the SAME socket **discovers and attaches PTYs to the first instance's live sessions**, resizing and mutating them. `$HOME` isolation is NOT enough because tmux is system-global. To run two instances, give each a distinct `CODEMAN_INSTANCE` (scopes dir + socket together), or set `CODEMAN_TMUX_SOCKET` + `CODEMAN_DATA_DIR` individually; `scripts/run-beta.sh` does this for a beta alongside prod. **Any new `~/.codeman/...` path MUST go through `dataPath()`**, never `join(homedir(), '.codeman', …)`. → [architecture-invariants#instance-isolation-and-the-multi-instance-attach-danger](docs/architecture-invariants.md#instance-isolation-and-the-multi-instance-attach-danger)
- **Headless screenshots: `deviceScaleFactor` MUST be 1, and write unique filenames** — under DSF=2 xterm's WebGL renderer draws glyphs at ~2× nominal size while still *reporting* nominal cell dims, so only the pixels reveal it and only the terminal font looks wrong. And overwriting a fixed output path leaves OS image viewers showing the old render, which reads as "the fix didn't work"; `scripts/capture-real-overview.mjs` mints a timestamped filename per run. Seed the per-device `localStorage` keys (`codeman:skin`, `codeman-font-size`, `codeman-app-settings`) so the capture matches a real device. → [architecture-invariants#headless-screenshot-capture](docs/architecture-invariants.md#headless-screenshot-capture)

**Import conventions**: Utils from `./utils`, types from `./types` (barrel), config from specific `./config/*` files.

## Architecture

### Core Files (by domain)

| Domain           | Key files                                                                                              | Notes                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Entry**        | `src/index.ts`, `src/cli.ts`                                                                           |                                                                                                  |
| **Session**      | `src/session.ts` ★, `session-manager`, `session-auto-ops`, `session-cli-builder`, `session-task-cache`, `session-order` (pure), `session-pty-exit-breaker`, `usage-limit-patterns`, `usage-telemetry`; `src/services/unified-session-service.ts` | Pure/unit-tested helpers are split out of `session.ts` on purpose                                 |
| **Mux**          | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` ★                                  |                                                                                                  |
| **Respawn**      | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`)      | Read `docs/respawn-state-machine.md` first                                                       |
| **Ralph**        | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Read `docs/ralph-wiggum-guide.md` first                                                          |
| **Orchestrator** | `src/orchestrator-loop.ts`, `-planner`, `-verifier`                                                    | Read `docs/orchestrator-loop-architecture.md` first                                              |
| **Cron**         | `src/cron/cron-service.ts`, `cron-time.ts` (pure next-run math), `cron-input.ts`                        | Read `docs/cron-discovery.md` first. Distinct from legacy `ScheduledRun` (`/api/scheduled`)      |
| **Agents**       | `src/subagent-watcher.ts` ★, `team-watcher`, `bash-tool-parser`, `transcript-watcher`, `workflow-run-watcher` | `workflow-run-watcher` is STANDALONE and never touches `subagent-watcher`                        |
| **AI**           | `src/ai-checker-base.ts`, `ai-idle-checker.ts`, `ai-plan-checker.ts`                                   |                                                                                                  |
| **Tasks**        | `src/task.ts`, `task-queue.ts`, `task-tracker.ts`                                                      |                                                                                                  |
| **State**        | `src/state-store.ts`, `run-summary.ts`, `session-lifecycle-log.ts`                                     |                                                                                                  |
| **Infra**        | `src/hooks-config.ts`, `push-store`, `tunnel-manager`, `image-watcher`, `file-stream-manager`, `remote-hosts` + `remote-reconnect` (pure), `docker-hosts` + `docker-export` | Remote/docker case overlays; see Key Patterns                                                    |
| **Search**       | `src/search-service.ts`                                                                                | Pure in-memory core for `GET /api/search`                                                        |
| **Attachments**  | `src/attachment-registry.ts`, `attachment-magic`, `generated-artifact-attachments`, `session-attachment-history`, `document-preview-cache`, `document-thumbnailer`, `document-conversion-limiter`, `config/attachment-guard` | See Key Patterns                                                                                 |
| **Plan**         | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/` (`claude-md.ts` + `case-template.md`) | `templates/` holds the CLAUDE.md scaffold generated into new cases                                |
| **Web**          | `src/web/server.ts` ★, `sse-events.ts`, `routes/*.ts` (20 modules + barrel; `session-routes.ts` ★), `route-helpers.ts`, `ports/*.ts`, `middleware/auth.ts`, `schemas.ts`, `self-update.ts`, `plan-usage-latest.ts`, `ws-connection-registry.ts`, `heic-jpeg-converter.ts` + `heic-jpeg-worker.ts` |                                                                                                  |
| **Frontend**     | `src/web/public/app.js` (~5K lines, core) + 23 modules + `sw.js`                                       | See Frontend section for the load order, which is authoritative                                  |
| **Types**        | `src/types/index.ts` (barrel) → 19 domain files; also `src/types.ts` root re-export                    | See `@fileoverview` in index.ts                                                                  |

★ = Large, central file (>50KB) — read its `@fileoverview` first. All files have `@fileoverview` JSDoc — read that before diving in. Discovery aid: `grep -l '@fileoverview' src/web/routes/*.ts` lists all route modules; same grep works for `src/types/`, `src/web/public/*.js`.

**Local packages**: `packages/xterm-zerolag-input/` (local echo overlay, single-source, see Gotchas). `packages/gesture-control/` (`codeman-gesture-control`, hand-tracking overlay source, built via `npm run build:gesture`).

**Config**: `src/config/` — 16 files, no barrel (`index.ts`) exists; import from the specific file.

**Utilities**: `src/utils/` — re-exported via index. Key: `CleanupManager`, `LRUMap` (⚠ NOT in the barrel — import from `./utils/lru-map.js` directly), `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `Debouncer`, `KeyedDebouncer`. Also: `claude-cli-resolver`/`opencode-cli-resolver`/`codex-cli-resolver`/`gemini-cli-resolver` (CLI path resolution), `string-similarity` (fuzzy matching), `regex-patterns` (ANSI/token/spinner patterns), `assertNever` (exhaustive checks), `token-validation` (auth tokens), `nice-wrapper` (process priority).

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input**: `session.writeViaMux()` for programmatic/curl input via tmux `send-keys -l` + `send-keys Enter`, single-line only. Interactive **browser** input goes through a durable **exactly-once** layer: a stable `clientId` + monotonic per-session `seq` persisted to localStorage until the server ACKs, so a dropped link cannot lose or double-deliver a prompt. `ws-connection-registry.ts` supersedes only same-TAB reconnects, so two tabs on one session coexist. → [architecture-invariants#input-delivery-and-ws-resilience](docs/architecture-invariants.md#input-delivery-and-ws-resilience)

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Auto-resume on usage limit** (opt-in per session, top of the Respawn tab): when Claude halts on a subscription limit, `usage-limit-patterns.ts` (pure, unit-tested) parses the reset time and `SessionAutoOps` arms a timer for reset+2min, then sends Esc + `continue`. ⚠️ Respawn cycles are blocked while paused (`isLimitPaused` guard in `onIdleDetected`), which is what prevents `/clear` from wiping the paused conversation. Claude-mode only. → [architecture-invariants#auto-resume-on-usage-limit](docs/architecture-invariants.md#auto-resume-on-usage-limit)

**Plan-usage chip** (statusLine telemetry, opt-in `showPlanUsageLimits`, default OFF): Codeman injects its own `statusLine.command` exporter which POSTs Claude's `rate_limits` blob to `POST /api/status-telemetry`. The exporter is identified by a marker, so it only ever adds/updates/removes a statusLine that is **ours**, never a user's hand-authored one, and it prints the footer through so the in-terminal statusline is not blanked. Claude-mode only; distinct from auto-resume, which reacts to the limit *message* rather than showing live %. → [architecture-invariants#plan-usage-chip-statusline-telemetry](docs/architecture-invariants.md#plan-usage-chip-statusline-telemetry), `docs/usage-limits-display-plan.md`

**Orchestrator**: State machine that turns a user goal into a phased plan and drives it to completion: `idle → planning → approval → executing → verifying → (replanning) → completed/failed`. `OrchestratorLoop` (engine) delegates plan generation to `orchestrator-planner` and per-phase verification gates to `orchestrator-verifier`, executing phases via team agents/`task-queue`. State persists under the `orchestrator` key in `state.json`. Distinct from Ralph (single-session autonomous loop) — orchestrator coordinates multi-phase, multi-agent execution. See `docs/orchestrator-loop-architecture.md`.

**Cron (`CronJob`s)**: saved, named jobs on a recurring schedule (`once`/`interval`/`daily`/`weekly`) with per-job run history. ⚠️ **Distinct from the legacy `ScheduledRun`** (`/api/scheduled`, a run-now duration-bounded loop); the two never interact and keep separate `Scheduled*` / `Cron*` names. `CronService` **reuses the existing session layer** rather than rebuilding tmux logic. Next-run math is pure and unit-tested in `cron-time.ts` (server-local timezone). The schedule is advanced BEFORE launch so a slow launch cannot re-trigger. → [architecture-invariants#cron-jobs](docs/architecture-invariants.md#cron-jobs), `docs/cron-discovery.md`

**Remote sessions + remote SSH cases**: a case can point at a remote host. The agent runs inside a durable remote `tmux -L codeman-remote` (session name `codeman-ssh-<id>`, deliberately failing the remote Codeman's `SAFE_MUX_NAME_PATTERN` so an instance on the target host never adopts it), fronted by a LOCAL tmux pane running `ssh`. Attached (`owned:false`) sessions **detach, never kill** on tab close; owned ones propagate `kill-session`. A bounded-backoff watcher auto-reconnects dropped sessions (`remoteAutoReconnect`, default ON). ⚠️ **Command-injection surface: every ssh command line must flow through `buildSshConnectionArgs()`**, which `shellescape`s every user field. Never hand-build an ssh line elsewhere. ⚠️ Run flows must route remote cases through `POST /api/quick-start`, not `POST /api/sessions` (which stat-validates `workingDir` locally and has no `caseName`). → [architecture-invariants#remote-sessions-over-ssh](docs/architecture-invariants.md#remote-sessions-over-ssh), [#remote-ssh-cases](docs/architecture-invariants.md#remote-ssh-cases), `docs/remote-sessions.md`

**Docker cases**: a case can point at a **container**, with any of the five CLI backends running inside it. Like remote-SSH this is a **LOCATION OVERLAY on cases, never a sixth `SessionMode`**. Exactly one long-lived container **per case**, shared by all its sessions, so killing a session kills only that session's in-container tmux and **never** `docker stop` while siblings remain. The workspace is a real host dir bind-mounted at the **same absolute path**, which is what keeps file-routes/watchers on real host bytes and makes the in-container transcript projHash match the host. Credentials are **seeded** (RO mount, copied into the container once) rather than shared RW, so in-container CLIs never write refreshed tokens back to the host, and bind mounts are excluded from `docker commit` so exports stay secret-free. **NEVER a create-time `-e` for secrets, NEVER `--privileged`, NEVER the docker socket.** Config drift is detected via a label hash and a drifted launch is REFUSED rather than silently launched with stale config. ⚠️ On the loopback-only prod bind a container cannot reach 127.0.0.1, so in-container hooks need `CODEMAN_DOCKER_BRIDGE_HOOKS=1`; otherwise idle detection falls back to output-based. → [architecture-invariants#docker-cases](docs/architecture-invariants.md#docker-cases), `docs/docker-cases.md` (user guide), `docs/docker-cases-plan.md` (design)

**External CLI modes (OpenCode, Codex, Gemini)**: `isExternalCliMode()` in `session.ts` gates Claude-specific behavior off (Ralph tracker, BashToolParser, token/CLI-info parsing, ❯-prompt readiness); these CLIs render their own TUIs, so readiness is output stabilization instead. All three **require tmux with no direct PTY fallback**, because secrets are injected via socket-scoped `tmux setenv` and never on the spawn command line. ⚠️ `run*()` in `session-ui.js` MUST unwrap the `{success,data}` envelope; reading the raw shape silently breaks the run. → [architecture-invariants#external-cli-modes-opencode-codex-gemini](docs/architecture-invariants.md#external-cli-modes-opencode-codex-gemini)

**Run launch synchronization**: the Run entrypoint holds an in-flight lock and disables `#runBtn` for the whole launch (≥500ms), so a double click cannot create duplicate sessions with the same `w<n>-<case>` name. `_ensureCreatedSessionVisible()` runs before `selectSession()`, and `_onSessionCreated()` stays an idempotent upsert, so POST-first and SSE-first ordering both produce exactly one rendered tab. → [architecture-invariants#run-launch-synchronization](docs/architecture-invariants.md#run-launch-synchronization)

**Unified session list**: `GET /api/sessions/unified` merges live sessions, persisted state, lifecycle-log history, and Claude transcript files into one deduped list (pure core in `src/services/unified-session-service.ts`). Transcript rows fold into their owning session via a `claudeSessionId → Codeman id` alias map, so resumed and `/clear`-respawned sessions do not appear twice. No terminal buffers in the response, unlike `/api/sessions`. Backs the Cmd+K Session Manager, plus pinning and cross-device tab order (`PUT /api/session-order`; pure merge helpers in `src/session-order.ts`, pushing device wins and server-only ids are never dropped). → [architecture-invariants#unified-session-list-and-session-manager](docs/architecture-invariants.md#unified-session-list-and-session-manager)

**Hook events**: Claude Code hooks trigger via `/api/hook-event`. Key events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`, `teammate_idle`, `task_completed`. See `src/hooks-config.ts`; upstream hook semantics mirrored in `docs/claude-code-hooks-reference.md`.

**Agent Teams**: `TeamWatcher` polls `~/.claude/teams/`, matches to sessions via `leadSessionId`. Teammates are in-process threads appearing as subagents. Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See `docs/agent-teams/`.

**Circuit breakers**: the Ralph breaker prevents respawn thrashing (`CLOSED` → `HALF_OPEN` → `OPEN`; reset via `/api/sessions/:id/ralph-circuit-breaker/reset`). **Distinct: the PTY-exit breaker** (`session-pty-exit-breaker.ts`) trips after repeated rapid PTY exits and blocks auto-restarts. ⚠️ It resets ONLY via an explicit `{clearBreaker:true}` body on `POST /api/sessions/:id/interactive`; the frontend's auto-reattach in `selectSession()` sends no body and must never clear it. → [architecture-invariants#circuit-breakers-ralph--pty-exit](docs/architecture-invariants.md#circuit-breakers-ralph-and-pty-exit)

**Full-scrollback replay**: `GET /api/sessions/:id/terminal?full=1` returns the entire tmux scrollback, bounded by the configured history limit. On success the capture is returned ALONE (`source='mux-full-history'`), superseding the byte buffer so nothing duplicates. Only the FIRST buffer load after a page load requests `full=1`; tab switches keep the cheap `?tail=` path. → [architecture-invariants#full-scrollback-replay](docs/architecture-invariants.md#full-scrollback-replay)

**Self-update** (App Settings → Updates): in-app updater for git-clone installs supervised by systemd/launchd (`systemd`, `launchd`, `launchd-daemon`, else `none` → "restart manually"). The update restarts the very process running it, so the real work runs in a DETACHED `scripts/self-update.sh` that outlives the restart and writes progress to `update-status.json`, which the browser polls across the connection drop. `src/web/self-update.ts` splits pure helpers (unit-tested) from IO wrappers. npm installs report as non-updatable. → [architecture-invariants#self-update](docs/architecture-invariants.md#self-update)

**Attachments** (live external document references; all wiring in `file-routes.ts`): a **registry** maps a stable `attachmentId` to a realpath-resolved, extension-allowlisted absolute path, so browser requests never carry arbitrary absolute paths. ⚠️ The **magic-link scanner** (`codeman://attach?...` in terminal output) is **prompt-injectable**, so its scan path is force-confined to the session workspace; a hostile prompt could otherwise exfiltrate arbitrary host files over SSE. The security gate is an extension **allowlist**, not a blocklist. `document-conversion-limiter.ts` caps converter spawns globally: without it, N large docs detected at once fork N multi-minute processes, which is a resource-exhaustion vector. → [architecture-invariants#attachments](docs/architecture-invariants.md#attachments)

**Ultracode / workflow-run visualization** (opt-in, default OFF): the Workflow tool writes a completion artifact only at run *end*, so live in-flight runs exist solely as transcript dirs. `workflow-run-watcher.ts` therefore synthesizes ACTIVE runs from transcripts until the completion artifact appears and supersedes them. It is **STANDALONE** and deliberately never imports or touches `subagent-watcher.ts`, despite reading the same tree. Two independent toggles: `showUltracodeAgents` (docked panel) and `ultracodeFloatingWindows` (floating windows); the watcher starts if **either** is on. → [architecture-invariants#ultracode--workflow-run-visualization](docs/architecture-invariants.md#ultracode-and-workflow-run-visualization)

**Cross-session search**: `GET /api/search` federates an in-memory search over session metadata, run-summary events, and attachment-history entries. The pure core `searchSources()` does substring matching with hard per-type caps: **no regex (so no ReDoS) and no filesystem reads (so no traversal)**. The server-private `externalPath` is never read. → [architecture-invariants#cross-session-search](docs/architecture-invariants.md#cross-session-search)

**Multi-user mode** (opt-in `--multiuser` / `CODEMAN_MULTIUSER=1`, OFF by default): named users with scrypt-hashed passwords in `~/.codeman/users.json`. Gated everywhere by `isMultiUserMode()`; when OFF, behavior is byte-identical to single-user because every scoping helper short-circuits. ⚠️ **Not a security boundary at the agent layer**: every session still runs as the SAME OS account. This separates WORKSPACES; it does not sandbox users (Docker cases are the isolation story). Ownership threads through `Session.owner` and is enforced in `findSessionOrFail`, list endpoints, SSE routing (fail-closed), WS, search, and file-preview. → [architecture-invariants#multi-user-mode](docs/architecture-invariants.md#multi-user-mode), `docs/multi-user-plan.md`

**Away digest**: `GET /api/away-digest` aggregates what happened while you were away from the lifecycle log, run-summary events, live sessions, token stats, and recent subagents. Pure aggregator in `web/away-digest.ts`. ⚠️ Returns `{success:true,digest}`, a legacy raw-ish shape consistent with the other raw GET handlers in `system-routes.ts`; frontend and tests read `.digest`. → [architecture-invariants#away-digest](docs/architecture-invariants.md#away-digest)

**Ralph todo-config**: per-session `maxTodos` (FIFO-eviction cap, default 500 = `MAX_TODOS_PER_SESSION`) + `todoExpirationMinutes` (auto-expiry, default 60) set via `POST /api/sessions/:id/ralph-config` (`RalphConfigSchema`, both `.int().positive()`). Stored on the tracker (`setMaxTodos`/`setTodoExpirationMinutes`) and **persisted/read-back via `RalphTrackerState`** (surfaced in the `loopState` getter → `toState()` + SSE broadcast → modal `populateRalphForm`), mirroring how `maxIterations` round-trips. Claude-only (skipped by `isExternalCliMode`).

**Port interfaces**: Routes declare dependencies via port interfaces (`src/web/ports/`). Routes use intersection types (e.g., `SessionPort & EventPort`).

### Frontend

Frontend JS modules have `@fileoverview` with `@dependency`/`@loadorder` tags. Load order: `constants.js`(1) → `i18n.js`(1.5) → `mobile-handlers.js`(2) → `voice-input.js`(3) → `notification-manager.js`(4) → `keyboard-accessory.js`(5) → `input-cjk.js`(5.5) → `sanitize-html.js`(5.6) → `app.js`(6) → `terminal-ui.js`(7) → `respawn-ui.js`(8) → `ralph-panel.js`(9) → `orchestrator-panel.js`(9.5) → `cron-ui.js`(9.7) → `settings-ui.js`(10) → `panels-ui.js`(11) → `ultracode-panel.js`(11.5) → `admin-ui.js`(11.7) → `session-ui.js`(12) → `ralph-wizard.js`(13) → `api-client.js`(14) → `subagent-windows.js`(15) → `ultracode-windows.js`(15.5) → `image-input.js`(16). `i18n.js` translates static + newly inserted application DOM while skipping terminal/response/file/user-name surfaces; `input-cjk.js` handles CJK IME composition via an always-visible textarea below the terminal (`window.cjkActive` blocks xterm's onData).

**Command palette + shortcut registry**: `Ctrl/Cmd/Alt+K` opens the session palette; shortcuts live in a rebindable registry (`DEFAULT_SHORTCUTS`/`getShortcutRegistry()`/`matchesShortcutEvent()` in app.js, overrides in `settings.shortcutOverrides`). ⚠️ Palette-chord keys must ALSO be swallowed in `attachCustomKeyEventHandler` (terminal-ui.js) or xterm writes the control byte (0x0B) into the PTY. ⚠️ `saveAppSettings()` rebuilds settings from the DOM, so keys edited elsewhere (`shortcutOverrides`, `showTokenCount`, `showCost`) need explicit `_prev` carry-over. → [architecture-invariants#command-palette-and-shortcut-registry](docs/architecture-invariants.md#command-palette-and-shortcut-registry)

**Per-device vs synced settings**: the `displayKeys` set in settings-ui.js is a **client-side merge policy**, not a wire filter. A display key seeds from the server only when localStorage has no value for it, which is what prevents one device overwriting another; `showPlanUsageLimits` is additionally `delete`d from the incoming payload outright. Separately, `SettingsUpdateSchema` is `.strict()` and simply **does not declare** `skin`, `showFileViewerButton`, `showCronButton`, `webglRendererEnabled`, `localEchoEnabled`, `cjkInputEnabled`, or `extendedKeyboardBar`, so sending one of those is a validation error. The rest (`showResponseViewer`, `showPlanUsageLimits`, `language`, and most `show*` keys) ARE in the schema and do persist server-side; they are per-device by client policy only. ⚠️ Adding a new per-device setting means deciding **both** questions: membership in `displayKeys`, and presence in the schema.

**Header button visibility**: most header controls are opt-in and hidden by a marker class (`btn-multimonitor--hidden`, `btn-response-viewer-header--hidden`, `btn-file-viewer--hidden`, `btn-cron--hidden`) that `applyHeaderVisibilitySettings()` (settings-ui.js) toggles after settings load; the multi-monitor button is instead stripped at render by `renderIndexHtml`. ⚠️ Hiding must go through the marker class: the base rules are `display:inline-flex !important`, so an inline style cannot override them. Current desktop default is WS/CPU/MEM + File Viewer + gear, with the token chip and lifecycle-log button OFF. ⚠️ New header controls must not leak onto phones; `test/mobile-header-buttons-policy.test.ts` is the static guard. → [architecture-invariants#header-button-visibility-multi-monitor-response-viewer-file-viewer-cron](docs/architecture-invariants.md#header-button-visibility-multi-monitor-response-viewer-file-viewer-cron)

**Gesture control** (camera hand-tracking overlay, opt-in, default OFF): `CODEMAN_GESTURE=1` makes the feature *available*; `gestureControlEnabled` turns it on. The bundle is injected by `renderIndexHtml` only when enabled, which is why that method is `async` and reads settings with `readSettings(true)` (a fresh read: a post-save reload lands inside the 2s cache TTL and would otherwise render the pre-toggle state). **Source lives in `packages/gesture-control/`; edit there, run `npm run build:gesture`, and commit the regenerated bundle** because dev serves the committed bundle with no runtime bundler. The MediaPipe wasm + model are fetched separately and gitignored. ⚠️ Keep `MP_VERSION` in `fetch-gesture-assets.mjs` in sync with `@mediapipe/tasks-vision`. → [architecture-invariants#gesture-control-the-source-package](docs/architecture-invariants.md#gesture-control-the-source-package)

**Theme skins / branding / i18n**: `skin` selects a palette via `data-skin` on `<html>`, applied by an **inline pre-paint script** in `index.html` reading `localStorage['codeman:skin']` to avoid a flash of wrong theme. `displayName` changes user-facing browser branding only and must NEVER rename npm package, CLI, API, storage, CSS, or protocol identifiers. `language` (`en`/`zh-CN`) keeps English as the canonical source so live switching stays reversible. User display names flow through `textContent`/attribute APIs and the server title's HTML escaper, never `innerHTML`. → [architecture-invariants#theme-skins](docs/architecture-invariants.md#theme-skins)

**Foldable settings identity**: responsive layout is width-driven via `MobileDetection.getDeviceType()`, but the localStorage namespace uses `MobileDetection.isHandheldDevice()` so an unfolded Android foldable keeps `codeman-app-settings-mobile`. ⚠️ Do not switch per-device settings namespaces from instantaneous viewport width: a posture-triggered WebView reload would lose opt-in UI. Regression profile: `OPPO Find N5 (unfolded)` in `test/mobile/devices.ts`. → [architecture-invariants#foldable-settings-identity](docs/architecture-invariants.md#foldable-settings-identity)

**WebGL renderer toggle** (`webglRendererEnabled`, per-device): the GPU-stall watchdog's sticky `codeman-webgl-disabled` marker survives page loads and is cleared only by an explicit OFF→ON save or `?webgl=force`. `?nowebgl` forces the DOM renderer per-load. → [architecture-invariants#webgl-renderer-toggle](docs/architecture-invariants.md#webgl-renderer-toggle)

**Z-index layers**: subagent windows (1000), plan agents (1100), mobile/tablet fixed header (1200, `mobile.css`), modals on ≤768px (1300 — must beat the fixed header or the modal close button is buried), log viewers (2000), image popups (3000), local echo overlay (7).

**Respawn presets**: `solo-work` (3s/60min), `subagent-workflow` (45s/240min), `team-lead` (90s/480min), `ralph-todo` (8s/480min), `overnight-autonomous` (10s/480min).

**Keyboard shortcuts**: Escape (close), Ctrl+? (shortcut overlay), Ctrl/Cmd/Alt+K (session palette), Ctrl+W (kill), Ctrl+Tab (next), Alt+[/] (prev/next tab), Alt+1-9 (switch tab), Ctrl+Shift+{/} (move tab left/right), Shift+Enter or Ctrl+Enter (newline), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl+Shift+V (voice input), Ctrl/Cmd +/- (font), Shift+Wheel (local scrollback when mouse passthrough is active). Rebindable via the registry.

### Security

**Full model: [`docs/security-architecture.md`](docs/security-architecture.md)** (network binding, auth pipeline, the tunnel caveat, file-serving hardening, supply-chain, instance isolation, recommended setups). **Layer-by-layer detail with the history behind each: [architecture-invariants#security-layers](docs/architecture-invariants.md#security-layers).**

| Layer             | The rule                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth**          | Optional HTTP Basic via `CODEMAN_USERNAME` (default `admin`) / `CODEMAN_PASSWORD`. Active only when `CODEMAN_PASSWORD` is set (`middleware/auth.ts`)                                                        |
| **Network bind**  | Defaults to loopback. Non-loopback without a password starts but warns loudly. Classifier: `network-auth-policy.ts`                                                                                          |
| **Host guard**    | Always-on Host-header allowlist blocking DNS rebinding. ⚠️ **Custom reverse-proxy domains are rejected** unless added via `CODEMAN_ALLOWED_HOSTS=host,.suffix`                                              |
| **CSRF / Origin** | Always-on cross-site Origin guard on state-changing requests. **A missing Origin is allowed** so curl/CLI and hooks keep working. ⚠️ The body parser keeps `text/plain` RAW; auto-JSON-parsing it enabled simple-request CSRF |
| **QR Auth**       | Single-use 6-char tokens (60s TTL) for tunnel login. See `docs/qr-auth-plan.md`                                                                                                                              |
| **Sessions**      | 24h cookie (`codeman_session`), auto-extend, device context audit                                                                                                                                           |
| **Rate limit**    | 10 failed auth/IP → 429 (15min decay). QR and hook-secret have separate buckets, so neither can lock out login                                                                                              |
| **Hook bypass**   | `/api/hook-event` + `/api/status-telemetry` skip Basic auth (localhost-only, schema-validated), but when auth is active the loopback bypass requires `X-Codeman-Hook-Secret` **unconditionally** (Codeman cannot detect a user's own loopback reverse proxy) |
| **Tunnel**        | Enabling a tunnel **refuses** without `CODEMAN_PASSWORD` unless exposure is acknowledged via `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` or the per-request `acknowledgeUnauthTunnel:true` action field (never persisted) |
| **Validation**    | Zod schemas, Unicode-aware path allowlist regex, env prefix allowlist (`CLAUDE_CODE_*`/`OPENCODE_*`/`CODEX_*`/`GEMINI_*`/`GOOGLE_*`)                                                                        |
| **Headers**       | CORS localhost-only, CSP, X-Frame-Options, HSTS if HTTPS                                                                                                                                                     |

**Security-relevant env vars**: `CODEMAN_MUX` (managed session), `CODEMAN_API_URL` (auto-set for hooks), `CODEMAN_ALLOWED_HOSTS` (extra Host/Origin allowlist entries for reverse proxies; bare `.suffix` matches subdomains), `CODEMAN_DOCKER_BRIDGE_HOOKS=1` (opt-in hooks-only listener on the docker bridge gateway).

### SSE Event Registry

148 event constants in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). **Both must be kept in sync** — they are currently exactly in sync, and the backend file's `@fileoverview` carries the per-category breakdown.

### API Routes

~190 handlers across 20 route files in `src/web/routes/`: system (45), sessions (32), cases (27), files (14), orchestrator (10), ralph (9), cron (9), admin (8), plan (8), respawn (7), mux (5), push (4), scheduled (4, legacy `ScheduledRun`), me (2), teams (2), search (1), hooks (1), clipboard (1), status-telemetry (1), ws (1 WebSocket). Each file has `@fileoverview` with endpoint details.

**HTTP contract** (stable since 0.9.x, see `docs/versioning-policy.md`; full envelope/status/error-code/SSE spec in `docs/api-reference.md`): responses use the `ApiResponse<T>` envelope — `{ success: true, data? }` or `{ success: false, error, errorCode }` (`src/types/api.ts`). `/api/v1/*` is a versioned alias of `/api/*` (URL rewrite in `server.ts`).

## Adding Features

- **API endpoint**: Types in `src/types/` domain file, route in `src/web/routes/*-routes.ts`. Return the `ApiResponse` envelope (`{ success: true, data }`; errors via `createErrorResponse()` with proper status code). Validate with Zod schemas in `schemas.ts`.
- **SSE event**: Add to `src/web/sse-events.ts` + `SSE_EVENTS` in `constants.js`, emit via `broadcast()`, handle in `app.js` (`addListener(`)
- **Session setting**: Add to `SessionState`, include in `session.toState()`, call `persistSessionState()`
- **App setting**: decide per-device vs synced first. Per-device keys go in the `displayKeys` set in settings-ui.js and must NOT be added to `SettingsUpdateSchema` (it is `.strict()`).
- **Hook event**: Add to `HookEventType`, add hook in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema`
- **Mobile feature**: Add to relevant singleton, guard with `MobileDetection.isMobile()`. New header buttons must stay off phones (`test/mobile-header-buttons-policy.test.ts`).
- **New test**: Pick unique port (search `const PORT =`). Route tests use `app.inject()` (no port needed) — see `test/routes/_route-test-utils.ts`.

**Validation**: Zod v4 (different API from v3). Define schemas in `schemas.ts`, use `.parse()`/`.safeParse()`.

## State Files

All in `~/.codeman/`: `state.json` (sessions, settings, respawn, orchestrator, cron jobs/runs), `mux-sessions.json` (tmux recovery), `settings.json` (user prefs), `push-keys.json` + `push-subscriptions.json`, `session-lifecycle.jsonl` (audit log), `update-status.json` (self-updater progress, polled across the service restart), `linked-cases.json`, `remote-hosts.json` + `remote-cases.json`, `docker-hosts.json` + `docker-cases.json` + `docker-exports/`, `subagent-window-states.json` + `subagent-parents.json` (subagent window layout, GET/PUT `/api/subagent-window-states`/`-parents`), `hook-secret` (per-instance), `users.json` (multi-user, mode 0600) + `admin-audit.jsonl`, `certs/` (self-signed TLS for `--https`), `.env` (CODEMAN_USERNAME/PASSWORD fallback for the `codeman attach` CLI). Transient: `self-update-runner.sh`. Multi-user case spaces live OUTSIDE the data dir at `~/codeman-users/<username>/cases` (shared across instances like `~/codeman-cases`, override `CODEMAN_USER_SPACES_DIR`).

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

**Tmux safety**: under vitest (`VITEST` env var, set automatically), `TmuxManager` no-ops ALL shell commands and becomes a pure in-memory mock — tests physically cannot create/kill/attach real tmux sessions (`IS_TEST_MODE` in `src/tmux-manager.ts`). Every docker IO path is no-op'd the same way. `test/setup.ts` additionally strips `CODEMAN_PASSWORD`/`CODEMAN_USERNAME` (so auth state from the running instance can't leak into tests) and `CODEMAN_GESTURE` (a shell-exported gesture flag would flip render-injection assertions).

**Ports**: Pick unique ports manually, 3150+. Search `const PORT =` before adding new tests. Never 3000 (the live instance).

**Respawn tests**: Use `MockSession` from `test/mocks/index.ts` (defined in `test/mocks/mock-session.ts`). **Route tests**: `app.inject({ method, url, payload })` in `test/routes/` — no live port needed. **Mobile tests**: Playwright suite in `test/mobile/` (136 device profiles). Browser-testing infra and practices: `docs/browser-testing-guide.md`.

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

Target: 20 sessions, 50 agent windows at 60fps. Limits live in `src/config/` (terminal 32MB, text 1MB, messages 1000, max agents 500, max sessions 50, max SSE clients 100), most env-overridable.

Two constraints worth knowing before you touch them: the env-derived PTY buffer trim is **clamped to ≤75% of max**, because a trim ≥ max would disable `BufferAccumulator` trimming entirely and make memory unbounded; and browser xterm scrollback is a **separate hardcoded 50k** (`DEFAULT_SCROLLBACK` in constants.js), deliberately lower than tmux's 100k history because 100k per tab is a mobile-memory hazard. The settings keys `terminalScrollbackLines`/`terminalBufferMaxBytes`/`terminalBufferTrimBytes` are schema-validated but **inert**; only `tmuxHistoryLimit` is wired live. → [architecture-invariants#buffers-uploads-and-terminal-history](docs/architecture-invariants.md#buffers-uploads-and-terminal-history), `docs/terminal-anti-flicker.md`

**Memory leaks (24+ hour sessions)**: use `CleanupManager`, clear Maps in `stop()`, guard async with `if (this.cleanup.isStopped) return`. Frontend: store handler refs, clean in `close*()`. Use `LRUMap` for bounded caches, `StaleExpirationMap` for TTL cleanup. Verify: `npm test -- test/memory-leak-prevention.test.ts`.

## Scripts & Tunnel

**`install.sh`** (repo root, 69KB) is the public entry point: `curl -fsSL <raw url> | bash` installs Node/tmux if missing, clones to `~/.codeman/app`, builds, and offers a systemd/launchd service. It prompts for the network binding (LAN default + password prompt) and preserves the existing binding on re-runs via `read_existing_binding()`. `install.sh update` and `install.sh uninstall` also exist; `CODEMAN_NONINTERACTIVE=1` approves system changes for automation.

Other key scripts: `scripts/tmux-manager.sh` (safe tmux mgmt), `scripts/tunnel.sh [quick|named] start|stop|status|url` (quick = random trycloudflare URL, default; `named setup|enable` = fixed-hostname tunnel via `scripts/codeman-tunnel-named.service`; bare `start|stop|url` still means quick), `scripts/run-beta.sh` (isolated beta instance), `scripts/build-agent-image.mjs` (docker base image), `scripts/self-update.sh` (detached updater). Production services: `scripts/codeman-web.service`, `scripts/codeman-tunnel.service`. **Always set `CODEMAN_PASSWORD`** before exposing via tunnel.
