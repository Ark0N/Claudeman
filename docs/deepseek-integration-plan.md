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
| Multi-user clamp branch | only-if-sent, clamped to `workspace-write`, **plus an env-var half** | Omitting the export leaves the harness on `workspace-write`, which still ASKS, so an absent config is already safe (the codex/antigravity/grok shape, not pi's materialize). Clamping to `workspace-write` rather than `read-only` is deliberate: the clamp removes privilege, it must not break a session's ability to edit its own workspace. ⚠️ Unlike every sibling, clamping the CONFIG is only half the gate: the switch is an env var, `DSH_*` is an allowlisted `envOverrides` prefix, and `applyEnvOverrides()` runs AFTER `_configureDeepSeek()`, so `envOverrides: {DSH_PERMISSION_MODE: 'danger-full-access'}` on the same request would land last and win. `clampEnvOverridesForOwner()` drops `DSH_PERMISSION_MODE` and `DSH_HOME` for a non-granted owner (dropping falls through to the clamped export). `DSH_HOME` because it aims the launcher at a profile tree whose plugin code runs at BOOT, before any approval row. |
| `hooksAvailableForMode()` granularity | per SESSION for deepseek, per mode for everything else | `deepSeekConfig.statusReporting: false` disarms the `HERDR_*` export, and the triple is the only reason a dsh session posts anything, so a mode-only answer would accept `until=stop` where nothing can send one — the infinite-wait the predicate exists to prevent. Call sites pass `sessionHookOptions(session)`; the default stays permissive so a forgotten one degrades to the old behaviour. ⚠️ Profile conformance stays unknowable at request time (an unrecognized profile is deliberately launchable), so a non-conforming TUI still times out on an explicit `stop`; the default set keeps `idle`/`exit` for that. ⚠️ The predicate is NOT "is this claude": Read My Mind and intent capture read Claude's transcript and were silently widened by this change, so they compare `mode === 'claude'` directly now. |
| Profile install spawn | own process group, hand-rolled timeout | `dsh plugin add` fans out into package-manager children, and spawn's built-in `timeout` signals only the direct child: survivors keep the inherited stdio pipes open, `close` never fires, and the held-open request leaks with no route-level deadline. `detached: true` + negative-pid SIGTERM→SIGKILL, the same escalation `runGit()` uses for the same reason, plus a last-resort reap for a grandchild that escaped the group. |
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
`dsh web --no-open --host 127.0.0.1 --port <free> --trusted-host <codeman-authority>`
as a background process and opens the URL as an ordinary web tab.

The server was a **shell session** first, on the reasoning that Codeman already
supervises those (visible, scrollable, killable, dies with its tab) so nothing
new had to own a long-lived HTTP server. That version worked and was still
wrong in use: clicking "open the DeepSeek web UI" put a terminal tab on screen
next to the web tab actually asked for, every single time, and after the first
launch the terminal was pure noise. Opening a dashboard should open one tab.

So `POST /api/deepseek/web` owns it instead (`src/deepseek-web-server.ts`), and
what the session gave away for free is now explicit: exactly one server, reused
rather than raced on a second click; restarted when the requested authority
changes; killed on Codeman shutdown (a detached child would otherwise hold its
port against the next start — the very EADDRINUSE this feature already got
wrong once); and boot output captured, since with no shell tab there is nowhere
else for a stack trace to land. It is fenced at the same bar as the profile
installer: booting a dsh profile executes the plugin code in it, so it requires
the privileged grant in multi-user mode.

`--trusted-host` is load-bearing — dsh fences its `/api` behind a browser-trust
check on the request authority, and a Codeman web tab reaches it through
Codeman's own origin via the webview proxy, not directly. The authority comes
from the CLIENT (`location.host`) because only the browser knows which of a
multi-homed Codeman's origins is actually in play.

Three things about this shortcut are load-bearing and each came from it failing
in exactly that way against a real install:

- **The port is chosen, never hardcoded.** `GET /api/deepseek/web-port` walks
  3080..3119 for a free loopback port. 3080 is dsh's own default, which makes it
  precisely the port a DeepSeek user is most likely to already be serving on:
  binding it unconditionally killed the launch with `EADDRINUSE` against the
  user's own `dsh web`.
- **The tab is opened only after the server answers.** The launch polls
  `POST /api/webviews/probe` until the URL responds, so a server that dies on
  startup reports the failure and points at its shell tab, instead of silently
  persisting a dashboard aimed at nothing.
- **The saved tab is `trusted: true`, and must be.** An untrusted webview is
  sandboxed without `allow-same-origin`, which breaks this dashboard twice: the
  dsh client-runtime reads `localStorage` while loading plugins and dies there,
  and an opaque-origin frame sends `Origin: null`, so dsh's trust check 403s
  every `/api` call regardless of what `--trusted-host` names. Passing
  `location.host` only means anything once the frame actually carries that
  origin. The trade is real — a trusted proxied frame is same-origin with
  Codeman and can reach Codeman's API — and is defensible only because this
  particular dashboard is an agent harness Codeman just started itself on
  loopback, which can already run code as the user. It is not a precedent for
  trusting third-party dashboards generally.

The record is marked `managed: 'deepseek-web'`, which keeps it out of the
saved-dashboard list: the shortcut that maintains it is already a menu entry, so
listing both showed the same dashboard twice. Being managed is also what lets a
relaunch repoint the existing row instead of stacking one dead dashboard per
restart, since the port is now chosen per launch.

The authority baked into `--trusted-host` is the one the launch was clicked
from, and reuse is conditional on it: a running server fenced for a *different*
origin is stopped and restarted rather than reused, because reusing it renders a
page whose every API call 403s — which reads as a broken dashboard rather than a
misconfigured one.

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
- The web-UI shortcut against a tunnel authority. Loopback and a tailnet name are
  both verified end to end through the webview proxy (dashboard renders, its
  `/api` calls succeed, no shell session created).

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
