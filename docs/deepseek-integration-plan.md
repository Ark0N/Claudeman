# DeepSeek Harness (`dsh`) integration plan

> **Status**: Executed. This document records the plan, the decision behind each
> wiring point, and what was and was not verified. The user-facing guide is
> [`deepseek-integration.md`](./deepseek-integration.md); the per-decision
> invariants live in
> [`architecture-invariants.md#external-cli-modes-opencode-codex-gemini-antigravity-pi-grok-deepseek`](./architecture-invariants.md#external-cli-modes-opencode-codex-gemini-antigravity-pi-grok-deepseek).
> Template: the grok integration ([`grok-integration-plan.md`](./grok-integration-plan.md)),
> itself calibrated against pi. Every fact below was measured against a live
> **dsh 0.1.1-rc.2** install and **@deepseek-harness-tui/dsh-tui 0.9.0**, not read
> from documentation.

## 1. What the DeepSeek Harness is

[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(open-sourced 2026-08-13, MIT) is a plugin-native agent framework: tools, skills,
sessions, sandboxes and whole APPS are Cordis plugins composed into *profiles*.
`dsh` is the launcher — `dsh --profile <name>` boots
`$DSH_HOME/profiles/<name>`, an ordered stack of plugin-bundle patch layers under
the user's own overrides. State lives in `~/.dsh` (`.env` 0600, `settings.yaml`,
`cordis.patch.yml`, `profiles/`, `sessions/`, `storages/`).

## 2. Shape decisions (why DeepSeek is wired the way it is)

DeepSeek is a ninth run mode. Never a location overlay, never a web tab (the
browser UI is handled separately, §3). Three of its decisions have no precedent
in the six external CLIs before it.

| Question | Decision | Why |
| --- | --- | --- |
| What does a pane run? | `dsh --profile <name>`, profile discovered | **The decision that shapes everything else.** DeepSeek ships `web`, `headless` and `base` — no terminal agent. The interactive front door is always a third-party plugin, so Codeman resolves a binary AND a profile inventory, and "available" means both. `resolveDefaultDeepSeekProfile()` prefers a recognized TUI, then an UNRECOGNIZED profile (anyone can publish an app bundle; a classifier that has not heard of one must not hide it), and refuses `web`/`headless`, which cannot occupy a pane. |
| Which TUI? | none blessed; default for BOOTSTRAP only | `POST /api/deepseek/install-profile` defaults to `@deepseek-harness-tui/dsh-tui` (~27.5k weekly downloads, ~4x the next, MIT, and it speaks the status contract in §2.3), but accepts any npm name and the resolver never assumes that profile exists. Codeman offers a default; it does not pick a winner. |
| Permission bypass | `DSH_PERMISSION_MODE` env export, no flag | The harness has NO command-line permission option; its sandbox/approval rows read one env var with three presets (`read-only` / `workspace-write` / `danger-full-access`, read off `dsh --dump-default-config`). This is the one legitimate exception to the `CLAUDE_CODE_EFFORT_LEVEL` ban: that var hard-locks in-session switching, whereas the harness reads this with `??` as a boot-time DEFAULT, so it stays soft. Exported via `tmux setenv`, never on the command line. The Run button sends `danger-full-access`, matching every sibling Run button. |
| Multi-user clamp branch | only-if-sent, clamped to `workspace-write` | Omitting the export leaves the harness on `workspace-write`, which still ASKS, so an absent config is already safe (the codex/antigravity/grok shape, not pi's materialize). Clamping to `workspace-write` rather than `read-only` is deliberate: the clamp removes privilege, it must not break a session's ability to edit its own workspace. |
| Idle detection | **real hook events via a status shim** | The standout decision. The TUI already reports its lifecycle to a supervising process through a generic env-gated contract inherited from Herdr: `HERDR_ENV=1` + `HERDR_BIN_PATH` + `HERDR_PANE_ID` make it run `<bin> pane report-agent <id> --state idle\|working\|blocked …` on every state change, exit 0 = delivered. `deepseek-status-shim.ts` generates a script into the data dir and points `HERDR_BIN_PATH` at it. So deepseek is the only non-claude mode that passes `hooksAvailableForMode()` — earned by emitting definitive signals, not granted. An interface implementation, not an impersonation: no real `herdr` binary is ever executed, and a TUI that ignores the contract simply falls back to output stabilization. |
| `agent_working` event | new, 157th SSE constant | The one hook event with no Claude Code hook behind it. A harness turn cannot run while its own modal approval is on screen, so "started working" proves a dialog was answered in the terminal. Without it a dsh red alert would survive until the next `stop` — the exact stuck-alert bug the claude path already fixed once, and its pane-capture staleness sweep is Claude-dialog-shaped and cannot help here. |
| Resolver | identity probe THEN version probe | Strictest of the family, and not by preference. `dsh` is not merely a squattable npm name: Debian ships an unrelated `dsh` (dancer's shell, `apt install dsh`) which would answer a version probe convincingly and then be handed a spawn line. `dsh --help` must match `DeepSeek Harness` first. `DEEPSEEK_VERSION_REGEX` keeps the prerelease tail (`0.1.1-rc.2`), since truncating it would report an rc as a release. |
| Env allowlist | `DSH_*` + `DEEPSEEK_*` | `DSH_*` covers the launcher's documented inputs (`DSH_HOME`, `DSH_PERMISSION_MODE`, `DSH_TELEMETRY_MODE`, the `DSH_TUI_*` knobs); `DEEPSEEK_*` is the vendor namespace holding `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`, same reasoning that admitted `XAI_*` for grok. ⚠️ Pi's lesson repeats exactly: a dsh `settings.yaml` can nominate ANY env var as a provider credential (`apiKeyEnv`), and the allowlist is one GLOBAL list, so admitting those would widen every mode at once. They stay out. |
| Model | NOT a session field | The model is a composition entry (`agent-default-model`) in the profile's config tree, set in `~/.dsh/settings.yaml` + `cordis.patch.yml`. Both create paths deliberately resolve no model for this mode rather than inventing a flag. |
| Alt-screen strip | OUT of `isAltScreenStripMode()` | Third-party fullscreen TUIs with their own scrollback and mouse handling — the opencode case, not the Ink case. |
| Local echo | `'buffer'` via the `_updateLocalEchoState` fallthrough | UNMEASURED against a live authenticated session (see §5), same honest gap grok shipped with. The leading TUI's composer supports `@` completion and history search, which *may* make it per-keystroke reactive like codex; if so the fallback is the `'off'` branch. |
| Docker | image installs dsh AND a profile | Profiles are deliberately NOT seeded from the host: each is a per-profile `node_modules` tree, host-arch-specific and far too large to copy per container start. Only `~/.dsh/.env`, `settings.yaml`, `cordis.patch.yml` are seeded (auth + model composition). The profile install rides the `useradd` layer so the closing `chgrp`/`chmod g=u` covers it, which is what keeps it usable under the arbitrary uid the container runs as. |
| Remote SSH | `exec "$SHELL" -i -l -c 'dsh'` | Boots the remote box's default profile; a remote with several needs the per-host `commands.deepseek` override, since `deepSeekConfig` does not cross ssh. |

## 3. The web profile

The browser UI is the only interactive surface DeepSeek ships itself, so it gets
a **shortcut, not a run mode**: `Run ▸ DeepSeek web UI…` starts
`dsh web --no-open --host 127.0.0.1 --port 3080 --trusted-host <codeman-authority>`
in an ordinary shell session and opens the URL as an ordinary web tab.

Built entirely from parts that already exist: the server is a shell session
(visible, scrollable, killable, dies with its tab) and the UI is a web tab.
Nothing new supervises a long-lived HTTP server, because Codeman already does.
`--trusted-host` is load-bearing — dsh fences its `/api` behind a browser-trust
check on the request authority, and a Codeman web tab reaches it through
Codeman's own origin via the webview proxy, not directly.

## 4. Touch points (the checklist)

Backend: `types/session.ts` (SessionMode + `DeepSeekConfig` + SessionState),
`utils/deepseek-cli-resolver.ts` (new) + barrel, `deepseek-status-shim.ts` (new),
`tmux-manager.ts` (`buildDeepSeekCommand`, dispatch, resume flag, PATH export,
truecolor, `_configureDeepSeek`, availability error, plumbing), `session.ts`
(external-mode gate, label, config plumbing, tmux-required error, attach env),
`mux-interface.ts`, `schemas.ts` (prefixes, `DeepSeekConfigSchema`,
`DeepSeekInstallProfileSchema`, both mode enums, remote overrides, cron agentType,
`agent_working`), `session-wait-registry.ts` (`hooksAvailableForMode`),
`hook-event-routes.ts` (`APPROVAL_RESOLVING_EVENTS`), `session-routes.ts` (clamp +
both create paths + `resolveDeepSeekLaunchError`), `system-routes.ts`
(`GET /api/deepseek/status`, `POST /api/deepseek/install-profile`), `server.ts`
(availability inject + mux restore), `sse-events.ts`, `docker-hosts.ts`,
`remote-hosts.ts`, `config/dependency-registry.ts`,
`response-viewer-transcript.ts`, `cron/cron-service.ts` (comment),
`tui/tui-client.ts` + `tui-app.ts`.

Frontend: `index.html` (welcome button, run-mode entry, install affordance, web-UI
shortcut, cron option, clone Brain option), `session-ui.js` (`runDeepSeek()`,
`runDeepSeekWeb()`, `installDeepSeekProfile()`, dispatch, availability, "Run DS"
label, external-CLI gates), `app.js` (label, `ds` tab badge, kill-menu, SSE map),
`settings-ui.js` (welcome gate + `_onHookAgentWorking`), `constants.js`,
`mobile-overview.js`, `home-sessions.js`, `panels-ui.js`, `i18n.js`,
`terminal-ui.js`, `styles.css` + `mobile.css` (brand-indigo identity; the non-og
skin block and the mobile `!important` pair are both load-bearing).

Meta: `docker/agent.Dockerfile`, `install.sh`, `package.json` keyword,
`skills/codeman/reference/*`, CLAUDE.md, `architecture-invariants.md`.

Tests: `test/deepseek-mode.test.ts` + `test/deepseek-cli-resolver.test.ts` (new);
`run-mode-ui`, `render-index-html`, `mobile-overview`, `agent-skill-mode-lists`
(extended).

## 5. Verification performed

See the summary at the end of the implementing session for the live run. In
short: the CI gate green; the resolver, profile inventory, spawn-line and clamp
behaviour covered by 31 new unit tests; and an isolated instance used to exercise
`GET /api/deepseek/status` and a real session against the live dsh install.

**Not verified (honest gaps):**

- The local-echo `'buffer'` policy against the TUI's real composer (§2). If it
  turns out per-keystroke reactive like codex's, flip it to the `'off'` branch;
  teaching `PredictiveEchoAddon` its composer row is the larger follow-up.
- Scrollback/repaint behaviour of a third-party fullscreen TUI under the narrow
  strip during a long session.
- A Docker case with `mode: 'deepseek'` (needs a `--no-cache` agent-image
  rebuild — see the `--no-cache` rule in CLAUDE.md).
- A remote-SSH deepseek case.
- The web-UI shortcut end to end through the webview proxy, in particular whether
  `--trusted-host <codeman-authority>` is the right authority for dsh's `/api`
  fence in every deployment shape (loopback, tailscale, tunnel).

## 6. Follow-ups

- **Response viewer**: read `~/.dsh/sessions/**` (JSONL) the way codex rollouts
  are read back. Highest-value follow-up, and very achievable.
- **`headless` as an execution backend** for Codeman's own AI checks
  (`ai-idle-checker`, `ai-plan-checker`), today Claude-only.
- **Profile/model picker in Session Options**, reading `GET /api/deepseek/status`
  `.profiles`.
- **`--patch` overlays per session**, which is the harness-native way to change
  agent composition without touching the user's profile.
- Measure the local-echo policy and pin the result the way pi did.
