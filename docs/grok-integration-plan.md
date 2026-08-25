# Grok Build (xAI) integration plan

> **Status**: Executed. This document records the plan, the decision behind each wiring
> point, and what was and was not verified. The user-facing guide is
> [`grok-integration.md`](./grok-integration.md); the per-decision invariants live in
> [`architecture-invariants.md#external-cli-modes-opencode-codex-gemini-antigravity-pi-grok`](./architecture-invariants.md#external-cli-modes-opencode-codex-gemini-antigravity-pi-grok).
> Template: the pi integration (`c5b5963`, [`pi-integration-plan.md`](./pi-integration-plan.md)),
> which was itself calibrated against the four follow-up commits the antigravity
> integration needed. All of grok's facts below were verified against **grok 1.0.5**
> (`grok 1.0.5 (5115b46bc9)`), installed live during the work.

## 1. What Grok Build is

[xai-org/grok-build](https://github.com/xai-org/grok-build) is xAI's coding agent: a
Rust fullscreen-TUI binary named `grok`, installed by
`curl -fsSL https://x.ai/cli/install.sh | bash` into `~/.grok/bin` (with symlinks into
`~/.local/bin`; the installer also ships an `agent` alias). Config lives in
`~/.grok/config.toml`, TUI appearance in `~/.grok/pager.toml`, credentials in
`~/.grok/auth.json` (0600), sessions under `~/.grok/sessions/`. Auth is browser OAuth
on first launch, `grok login --device-auth` for SSH boxes, or `XAI_API_KEY` for
headless use. It has Claude-style permission modes (`default`/`acceptEdits`/`auto`/
`dontAsk`/`bypassPermissions`/`plan`), allow/deny rules, hooks, MCP, subagents, and a
headless `-p` mode.

## 2. Shape decisions (why grok is wired the way it is)

Grok is a seventh run mode, alongside Claude Code, shell, OpenCode, Codex, Gemini,
Antigravity and Pi. Never a location overlay, never a web tab. Its wiring mixes two
existing shapes:

| Question | Decision | Why |
| --- | --- | --- |
| Permission bypass | `GrokConfig.alwaysApprove` -> `--always-approve` | Grok's real flag (verified via `--help`): "Auto-approve all tool executions", i.e. its `bypassPermissions` mode. Config-level deny rules still apply on top. The Run button sends `true`, matching `runAntigravity()` and Claude's own `--dangerously-skip-permissions` default: Codeman sessions exist for autonomous work. |
| Multi-user clamp branch | only-if-sent (codex/antigravity branch) | A bare `grok` spawn is grok's own ask-mode default, which is already safe, so the clamp only needs to force a SENT `alwaysApprove` off. Contrast pi, whose absent default is an answerable prompt and therefore needs the materialize branch. Cron needs nothing for grok for the same reason (`clampCronExternalCliConfigs`). |
| Alt-screen strip | OUT of `isAltScreenStripMode()` | Grok is a fullscreen alternate-screen TUI with mouse support (its own scrollback pane, `pager.toml [terminal] alt_screen`), i.e. the opencode case, not the Ink repaint case. It falls through to the narrow tmux-attach strip like opencode/antigravity/pi. |
| Resolver | version probe, like pi | `grok` has npm squatters (the unrelated `@vibe-kit/grok-cli` installs a `grok` bin). Candidates must pass `grok --version`; `GROK_VERSION_REGEX` is exported and shared with the dependency registry so doctor and run mode cannot disagree. The probe cannot tell two version-printing `grok`s apart, so `GET /api/grok/status` surfaces path AND version. Search dirs: `~/.grok/bin` first (installer target), then `~/.local/bin`, `/usr/local/bin`, `~/bin`. |
| Env allowlist | `GROK_*` + `XAI_*` prefixes | `GROK_*` covers grok's documented inputs (`GROK_HOME`, `GROK_CONFIG`/`GROK_CONFIG_PATH`, `GROK_MEMORY`, `GROK_WORKFLOWS`, `GROK_SANDBOX`, `GROK_OIDC_*`, `GROK_AUTH_PROVIDER_COMMAND`). `XAI_*` is xAI's vendor namespace and carries `XAI_API_KEY`, grok's documented headless auth var: the same narrow-vendor-namespace reasoning that admitted `GOOGLE_*` for gemini. Foreign provider keys stay out, as always. |
| Resume | `--resume <id>` / `--continue`, id-regexed | Grok's `--resume` also matches session TITLES (arbitrary user strings, case-insensitive). The `^[a-zA-Z0-9._-]+$` regex doubles as the no-titles rule, so nothing free-form can reach the `bash -c` spawn line. A valid explicit id wins over `-c`, mirroring pi. |
| Local echo | `'buffer'` via the `_updateLocalEchoState` fallthrough | UNMEASURED against an authenticated session (see §4). If grok's composer turns out per-keystroke reactive like codex's, the fallback is one `'off'` branch; teaching `PredictiveEchoAddon` grok's composer row is the larger follow-up. |
| Truecolor | `COLORTERM=truecolor` + `unset NO_COLOR` | Rust TUI with themes; joins the codex/gemini/antigravity/pi list in `buildEnvExports()` and `buildMuxAttachEnv()`. |
| Docker credentials | per-file seed: `auth.json`, `config.toml`, `pager.toml` | `~/.grok` also holds `sessions/`, `memory/`, `completions/`, `docs/` and the ~160MB binary under `downloads/`; a whole-dir seed would copy all of it on every container start. Same trade-off as pi: in-container sessions are invisible host-side, so `grok -c` in a Docker case sees only that container's history. |
| Docker install | own Dockerfile step | Not an npm package. xAI's installer has no `--dir` override, so the step copies `/root/.grok/bin/grok` (through the symlink, `cp -L`) into `/usr/local/bin` and removes root's `~/.grok` in the same layer. |
| Remote SSH | `exec "$SHELL" -i -l -c 'grok'` | sshd's remote-command PATH does not include `~/.grok/bin`; same login-shell fix as every other agent CLI. |
| What is NOT wired | `--permission-mode`, `--allow`/`--deny`, `-p` headless, `--worktree`, `--sandbox`, `--reasoning-effort`, `-s/--session-id`, `--fork-session`, `--agent`, `--output-format` | Follow-ups. The flag surface is kept minimal on purpose; grok is pre-1.0-style fast-moving and every flag added is a flag validated forever. |

## 3. Touch points (the checklist)

Backend: `types/session.ts` (SessionMode + GrokConfig + SessionState), `utils/grok-cli-resolver.ts` (new)
+ barrel, `tmux-manager.ts` (`buildGrokCommand`, dispatch, resume flag, PATH export, truecolor,
availability error, plumbing), `session.ts` (external-mode gate, label, config plumbing,
tmux-required error, attach env), `mux-interface.ts`, `schemas.ts` (prefixes, `GrokConfigSchema`,
both mode enums, remote command overrides, cron agentType), `session-routes.ts` (clamp + both
create paths), `system-routes.ts` (`GET /api/grok/status`), `server.ts` (availability inject +
mux restore), `docker-hosts.ts`, `remote-hosts.ts`, `config/dependency-registry.ts`,
`cron/cron-service.ts` (comment), `response-viewer-transcript.ts`, `tui/tui-client.ts` + `tui-app.ts`.

Frontend: `index.html` (welcome button, run-mode entry, cron option, clone Brain option),
`session-ui.js` (`runGrok()`, dispatch, availability, "Run GK" label, external-CLI gates,
runMode setter), `app.js` (label, `gk` tab badge, kill-menu), `settings-ui.js`,
`mobile-overview.js`, `home-sessions.js`, `panels-ui.js`, `i18n.js`, `styles.css` +
`mobile.css` (charcoal monochrome identity; the non-og skin block and the mobile
`!important` pair are both load-bearing, see the pi plan's §2.9 cascade trap).

Meta: `docker/agent.Dockerfile`, `install.sh`, `package.json` keyword, changeset,
`skills/codeman/reference/*`, CLAUDE.md, READMEs, `architecture-invariants.md`,
`remote-sessions.md`, `security-architecture.md`, `docker-cases.md`, `cron-guide.md`.

Tests: `test/grok-mode.test.ts` + `test/grok-cli-resolver.test.ts` (new);
`external-cli-bypass-clamp`, `system-routes`, `render-index-html`, `run-mode-ui`,
`mobile-overview`, `local-echo-codex-gating` (extended).

## 4. Verification performed

On this box, with grok 1.0.5 really installed and an isolated
`CODEMAN_INSTANCE=grokwt` server (own data dir, own tmux socket, port 5077):

1. `npm test` (the CI gate): green, 5900+ tests. `typecheck`, `lint`, `format:check`,
   `check:frontend-syntax`, `check:public-assets`, `check:lockfile`: green.
2. `GET /api/grok/status` -> `{available: true, path: "/home/arkon/.local/bin", version: "1.0.5"}`
   through the real resolver and probe.
3. `POST /api/quick-start {mode: "grok", grokConfig: {alwaysApprove: true}}` -> session
   created, tmux pane spawned, real spawn line verified to end in `grok --always-approve`,
   and the actual grok TUI rendered its OAuth device-approval screen in the pane
   (unauthenticated box, so sign-in is exactly where a first run lands).
4. `grokConfig` persisted into the instance's `state.json`.
5. Session deleted by exact id; instance data dir and throwaway case removed.

**Not verified (honest gaps, all requiring an xAI account or more hardware):**
an authenticated conversation end to end; the local-echo buffer policy against grok's
real composer (§2); scrollback/repaint behavior of the fullscreen TUI under the narrow
strip during a long session; a Docker case with `mode: 'grok'` (needs a `--no-cache`
agent-image rebuild); a remote-SSH grok case; cron readiness degradation (expected:
same slow-start-then-send as pi, documented in `cron-guide.md`).

## 5. Follow-ups

- Idle/completion signal: grok has a hooks system (user-guide `10-hooks.md`); a hook
  POSTing to `/api/hook-event` could give grok sessions real idle detection instead of
  output-stabilization. Highest-value follow-up, same slot as pi's `agent_settled` idea.
- Response viewer: sessions are ACP JSONL under `~/.grok/sessions/<encoded-cwd>/<id>/updates.jsonl`;
  `grok -p ... --output-format json | jq -r '.sessionId'` exists for correlation.
- Permission-mode picker (`--permission-mode`, `--allow`/`--deny`) in Session Options.
- Measure the local-echo policy and the fullscreen-TUI scrollback behavior against an
  authenticated session; pin the result in `local-echo-codex-gating` the way pi did.
- `grok doctor` is a built-in terminal-support check worth pointing users at when a
  pane renders oddly.
