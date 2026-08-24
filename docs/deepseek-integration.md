# DeepSeek Harness (`dsh`) in Codeman

Codeman can run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
as a session backend, alongside Claude Code, OpenCode, Codex, Gemini,
Antigravity, Pi and Grok. It is the ninth run mode, and the one that is wired
least like the others, for two reasons worth understanding before you use it.

## 1. The agent is a profile, not the binary

`dsh` is a **launcher**, not an agent. It boots a *profile*: an ordered stack of
plugin-bundle patch layers under `$DSH_HOME/profiles/<name>` (`$DSH_HOME`
defaults to `~/.dsh`). DeepSeek ships three bundles and none of them is a
terminal agent:

| Profile      | What it is                        | Can Codeman run it in a tab? |
| ------------ | --------------------------------- | ---------------------------- |
| `web`        | the browser UI, served on :3080   | no — but see §5              |
| `headless`   | answers one task and exits        | no                           |
| (`base`)     | the shared core, no app at all    | no                           |

The interactive terminal front door is **always a third-party plugin**. So
"DeepSeek is installed" and "Codeman can start a DeepSeek session" are different
questions, and Codeman answers both separately:

```bash
curl -s localhost:3000/api/deepseek/status | jq
{
  "available": true,            # the `dsh` binary resolved and proved its identity
  "runnable": false,            # ...but nothing installed can drive a pane
  "path": "/home/you/.local/bin",
  "version": "0.1.1-rc.2",
  "dshHome": "/home/you/.dsh",
  "defaultProfile": null,
  "profiles": [ { "name": "web", "kind": "web", "bundles": [...] } ]
}
```

### Installing a terminal profile

From the UI: open the **Run** dropdown. When `dsh` is installed but no
pane-capable profile is, the menu shows **DeepSeek — add a terminal profile…**.
One click installs one and the normal DeepSeek entry appears.

By hand, or to pick a different front door:

```bash
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
```

Codeman's default is `@deepseek-harness-tui/dsh-tui` because it is by a wide
margin the most used community TUI, it is MIT, and it implements the status
contract described in §3. It is a **default, not a requirement**: any profile
under `$DSH_HOME/profiles` that is not `web` or `headless` shows up in the
inventory and can be launched, including one you compose yourself. The endpoint
accepts any npm package name:

```bash
curl -sX POST localhost:3000/api/deepseek/install-profile \
  -H 'Content-Type: application/json' \
  -d '{"profile":"my-tui","package":"@someone/dsh-tui"}'
```

Installing a plugin is arbitrary code execution on the host, so in multi-user
mode this endpoint requires the can-bypass-permissions grant (the same bar as a
`shell` session).

> **`dsh` is also a Debian program.** `apt install dsh` gives you "dancer's
> shell", a distributed shell, which would answer `--version` convincingly.
> Codeman's resolver therefore demands the harness's own help banner before it
> will point a spawn line at a candidate, and `GET /api/deepseek/status` reports
> `path` and `version` so a misresolution is diagnosable rather than presenting
> as "the mode just doesn't work".

## 2. Permissions are an env var, not a flag

The harness has **no `--dangerously-skip-permissions` equivalent**. Its sandbox
and approval rows are configuration, driven by one documented input,
`DSH_PERMISSION_MODE`, with three presets (read off `dsh --dump-default-config`):

| `DSH_PERMISSION_MODE` | sandbox              | approvals | notes                     |
| --------------------- | -------------------- | --------- | ------------------------- |
| `read-only`           | `read-only`          | ask       |                           |
| `workspace-write`     | `workspace-write`    | ask       | the harness's own default |
| `danger-full-access`  | `danger-full-access` | **never** | what the Run button sends |

Codeman exports it via `tmux setenv`, never on the command line. Because the
harness reads it with `??`, it is a **soft default**: it sets the boot-time
preset and you can still change permission mode inside the session.

Omitting it entirely leaves the harness on `workspace-write`, which still asks —
which is why the multi-user clamp only needs to force a *sent* value down. A
non-granted owner's `danger-full-access` becomes `workspace-write`, not
`read-only`: the clamp removes privilege without breaking the session's ability
to edit its own workspace.

## 3. Real idle detection (the interesting part)

Every other external CLI mode in Codeman is **readiness-guessed**: Codeman
watches the PTY go quiet and infers that a turn ended. Claude is the exception,
because Claude Code fires hooks.

DeepSeek is the second exception. The community terminal front door already
reports its own lifecycle to a supervising process through a generic,
env-var-gated contract (inherited from [Herdr](https://herdr.dev)): when
`HERDR_ENV=1`, `HERDR_BIN_PATH` and `HERDR_PANE_ID` are set, it shells out on
every state change with

```
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
    --source custom:dsh-tui --agent dsh-tui \
    --state idle|working|blocked [--message ...] --seq N
```

Codeman points `HERDR_BIN_PATH` at a small generated shim
(`~/.codeman/dsh-status-shim.mjs`, written at session create) which forwards each
report to `POST /api/hook-event`. The mapping:

| Harness state | Codeman hook event | What you get                                             |
| ------------- | ------------------ | -------------------------------------------------------- |
| `blocked`     | `permission_prompt`| red "needs you" tab alert + an Approvals Inbox item       |
| `idle`        | `stop`             | definitive end-of-turn: respawn triggers, `wait` returns  |
| `working`     | `agent_working`    | clears an alert answered in the terminal, at once         |

So a DeepSeek session gets Claude-grade signals: `GET /api/sessions/:id/wait`
really can block on `stop` and `blocked` for it, and it is the only non-Claude
mode for which that is true (`hooksAvailableForMode`).

This is an interface implementation, not an impersonation — nothing on your
machine executes a real `herdr` binary. If you use a terminal profile that does
*not* implement the contract, the shim is simply never called and the mode falls
back to output-stabilization readiness like its siblings. Turn it off per session
with `deepSeekConfig.statusReporting: false`.

## 4. Starting a session

From the UI, pick **DeepSeek** in the Run dropdown (or the **Run DeepSeek**
welcome button) and press Run. Over the API:

```bash
curl -sX POST localhost:3000/api/quick-start \
  -H 'Content-Type: application/json' \
  -d '{
        "caseName": "myproject",
        "mode": "deepseek",
        "deepSeekConfig": {
          "profile": "dsh-tui",
          "permissionMode": "danger-full-access"
        }
      }'
```

`deepSeekConfig` fields: `profile`, `permissionMode`, `resumeSession`,
`resumeSessionId`, `statusReporting`. Resume prefers an explicit id over the
most-recent form, and both are passed through to the profile's app, which is
where `--resume` is understood.

**Models are not a session field.** The model is a composition entry in the
profile's config tree (`agent-default-model`), not a CLI flag, so Codeman does
not try to set one. Configure it where the harness does: `~/.dsh/settings.yaml`
plus a home-level `~/.dsh/cordis.patch.yml`, or a `--patch` overlay on the
profile. That is also how you point dsh at a local or third-party provider.

**Environment.** `DSH_*` and `DEEPSEEK_*` are allowlisted for `envOverrides`
(so `DSH_HOME`, `DSH_PERMISSION_MODE`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`
all flow through). Provider keys with *other* names are deliberately not: a dsh
`settings.yaml` can nominate any env var as a credential via `apiKeyEnv`, and
Codeman's allowlist is global, so admitting them would widen it for every mode at
once. Authenticate those the way dsh does, from the file or the server's own
environment.

## 5. The web UI as a tab

The browser UI is the one interactive surface DeepSeek ships itself, so it gets a
shortcut rather than a run mode: **Run ▸ DeepSeek web UI…** starts
`dsh web --no-open --host 127.0.0.1 --port 3080 --trusted-host <codeman-host>` in
an ordinary shell session and opens `http://127.0.0.1:3080` as a Codeman web tab.

Nothing bespoke supervises it: the server is a normal shell session (visible,
scrollable, killable, dies with its tab) and the UI is a normal web tab. The
`--trusted-host` flag is load-bearing — dsh fences its `/api` behind a
browser-trust check on the request authority, and a Codeman web tab reaches it
through Codeman's own origin via the webview proxy, not directly. Without it the
page renders and every API call fails.

## 6. Docker and remote cases

Docker cases work: the agent image installs `dsh` and bootstraps a `dsh-tui`
profile into the container. Profiles are deliberately **not** seeded from the
host (each is a per-profile `node_modules` tree, host-arch-specific and far too
large to copy on every container start); only `~/.dsh/.env`, `settings.yaml` and
`cordis.patch.yml` are seeded, which is what carries auth and model composition
in. As with pi and grok, in-container sessions are invisible host-side:
`~/.dsh/sessions` inside a container is that container's own.

Remote SSH cases default to `dsh` through a login shell, which boots the remote
box's default profile. If the remote has several, name one with the per-host
`commands.deepseek` override — the local `deepSeekConfig` does not cross ssh.

## 7. What is not wired

Deliberately minimal, on the same reasoning as the grok integration: the harness
is a fast-moving developer preview and every flag added is a flag validated
forever.

- `--patch` overlays per session (the profile's own layers apply as normal).
- `dsh plugin` management beyond first-time profile install.
- The `headless` profile as a one-shot execution backend for Codeman's own
  internal AI checks (today those are Claude-only).
- Reading `~/.dsh/sessions/**` into the response viewer, the way codex rollouts
  are read back. DeepSeek sessions are JSONL and this is very achievable; it is
  the highest-value follow-up.
- Model/provider selection from Session Options.

## Verified against

`dsh 0.1.1-rc.2` and `@deepseek-harness-tui/dsh-tui 0.9.0`. The permission
presets, the profile layout, and the supervisor contract above were all read off
the live install rather than from documentation.
