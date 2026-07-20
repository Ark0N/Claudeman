<!-- Design doc generated via ultracode multi-agent workflow (wf_e3a7498b-26f): 3 architecture proposals -> judge panel -> synthesis -> completeness critic. -->

# Docker Session Mode, Implementation Plan

## Decisions (locked 2026-07-19, by repo owner)

1. **Isolation posture**: CONVENIENT default (bind-mount host `~/.claude` etc. read-write so the existing login just works; network on; still hardened non-root + cap-drop + resource caps). SEALED profile (`mountCredentials:false` + `network:none`) is a per-case opt-in.
2. **Export**: offer BOTH full-image (`commit`+`save`+workspace tar) AND workspace-only, side by side, no default (ask each time).
3. **Base image**: BUILD LOCALLY on first use via `scripts/build-agent-image.mjs` from a repo `docker/agent.Dockerfile`. No registry required. (GHCR pull can be added later.)
4. **Hooks**: WIRE HOOKS NOW. Codeman scaffolds `.claude/settings.local.json` + CLAUDE.md into the linked host workspace dir (same as local cases), enabling in-container permission prompts, hook-idle detection, and the Claude Model picker.

Adopted defaults for the remaining open items (Section 10): resume-on-restart ON; container is per-CASE and shared by multiple sessions (killing one session only kills its in-container tmux session, never `docker stop` while siblings remain; stop/remove only on explicit teardown or case-delete); rootless caps = ship-with-warning (`capsEnforced` surfaced); remote docker daemon = local-first; podman = docker-first best-effort.

## Implementation status (branch `feat/docker-session-mode`)

DONE and END-TO-END VERIFIED against a real docker daemon (create host, link case, quick-start shell in a real container, workspace bind-mount round-trip, hook scaffolding, session-delete keeps the shared container up, case-delete `docker rm`s it):

- Phase 0-1: types (`DockerHost`/`DockerCase`/`SessionDocker`), `src/docker-hosts.ts` (storage, pure `buildDockerBaseArgs`/`buildDockerCreateArgs`, `containerApiUrl`, `hostGatewayAlias`, config-hash, credential-mount resolution, daemon probes), `DockerHostSchema`/`DockerCaseLinkSchema`. 26 unit tests.
- Phase 2: `tmux-manager` `buildDockerLaunchCommand` (image-check -> ensure -> start -> exec, resume-aware), `buildDockerKillCommand` (in-container tmux only, multi-session safe), stop/remove; wired into `createSession`/`respawnPane`/`killSession`. 14 unit tests.
- Phase 3: `Session` threading (`_docker`, toState, option builders, in-container cliVersion probe, `resolveMuxAttachCwd`), `server.ts` recovery round-trip.
- Phase 4: `case-routes` `/api/docker-hosts` CRUD + `/api/cases/docker-link` + listing + docker-unlink; `session-routes` `/api/quick-start` docker branch (rejects per-session config, probes availability + tmux, scaffolds hooks, seeds resume id).
- Phase 5 (partial): `docker/agent.Dockerfile` + `scripts/build-agent-image.mjs` (built + verified: node 22, tmux, claude/codex/gemini/opencode, arbitrary-uid HOME). Host-guard allowlists `host.docker.internal`/`host.containers.internal` for in-container hooks.
- Full CI green (3445 tests).

REMAINING:

- Phase 6: export / import (`docker commit` + `save | gzip` + workspace tar + manifest; `load` + quarantined re-tag), GC / boot reaper, disk-safety prechecks, drift-recreate route, SSE `docker:*` events. THE "move to a new machine" feature.
- Phase 7: frontend Create Case "Docker" tab + `linkDockerCase` + run wiring + case-picker labels + export/import UI.
- Phase 8: CLAUDE.md "Docker cases" Key Pattern + `docs/docker-cases.md` + COM.
- Deferred refinements: in-container model-picker via `settings.local.json`; live mid-run resume-id capture into `DockerCase.lastClaudeSessionId`; rootless/Desktop uid probe (currently a platform heuristic).

## 1. Goal & user stories

Add "Docker cases" to Codeman: a case can point at a container instead of a local or remote-SSH path, and any of the five CLI backends (`claude` / `shell` / `opencode` / `codex` / `gemini`) runs inside that container. It is modeled as a LOCATION OVERLAY on cases, exactly like the remote-SSH feature (COD-94/#145), never as a sixth `SessionMode`.

User stories:

- As the repo owner, I link a case to a per-project container so an autonomous Claude/Ralph run executes in a hardened sandbox (cap-drop, non-root, resource caps) instead of directly on my host, while keeping my existing OAuth login and transcript history working with zero extra setup.
- I set default, per-case-changeable container settings (image, network mode, memory/cpu/pids caps) at link time and edit them later, and edits actually take effect through a recreate-on-drift path (see Section 4).
- I reconnect after a Codeman restart and land back in the SAME running agent with the conversation intact. When the CONTAINER itself was stopped/rebooted/OOM-killed (which destroys the in-container tmux), the next launch RESUMES the last conversation from the bind-mounted transcript rather than starting fresh (durability model in Section 2, Key decision 1).
- I export a finished run's whole environment (toolchain plus workspace) to a portable, secret-free `.tar.gz`, move it to another machine, and import it back into a fresh case in one click.
- The container never accumulates: killing the session stops it, deleting the case removes it, and an instance-scoped boot reaper reaps containers whose case is gone.

Non-goals for the MVP: multi-tenant untrusted-code isolation guarantees (Codeman is loopback-default and single-operator, and the agent already runs `--dangerously-skip-permissions` on the host today), Kubernetes/compose orchestration, and per-command ephemeral containers.

## 2. Chosen architecture and why

The design grafts the strongest idea from each of the three proposals:

- Overlay-not-a-mode + faithful remote-SSH mirror (from "Docker Cases as a Location Overlay"): lowest churn, rides the existing quick-start / mux-sessions / state / recovery plumbing.
- Convenient-but-hardened default with an opt-in sealed profile, plus exec-time name-only secret env (from "Sealed Sandbox"): a strict security improvement over today's on-host execution without the UX tax of forcing an in-container re-login.
- One-artifact export + in-app import route (from "Container-as-Cargo"): the genuinely new, high-value capability Codeman lacks.

### Key decision 1: persistent per-CASE container, durable in-container tmux, AND resume-on-restart (the two-layer durability model)

Exactly one long-lived container per Docker case, named as a pure slug function `codeman-case-<slug>` (Docker charset `^[a-zA-Z0-9][a-zA-Z0-9_.-]+$`; Codeman already slugs case names for tmux), so create-if-missing and boot recovery are idempotent. PID1 is `sleep infinity` under `--init` (tini reaps zombies and forwards `docker stop`'s SIGTERM); the CLI is NOT the container command. The CLI runs inside a DURABLE in-container tmux on a dedicated socket `-L codeman-docker`, session `codeman-dkr-<id8>`, the direct analog of remote's `-L codeman-remote` / `codeman-ssh-<id8>`.

Two DIFFERENT failure surfaces need two DIFFERENT recovery layers, and conflating them is the central flaw the critic caught:

1. Codeman-PROCESS restart while the container stays up: the in-container tmux is still alive, so `tmux new-session -A` (attach-or-create) reattaches the SAME live agent and the paneCommand is ignored. This is the remote-SSH durability idiom and it works unchanged.
2. CONTAINER stop / daemon restart / host reboot / OOM-kill: the in-container tmux is GONE (fresh PID1). `new-session -A` will now CREATE a fresh session and run the paneCommand, which would start a brand-new conversation. This is the case the raw plan silently lost. Because the transcript directory is bind-mounted from the host (Key decision 3), the fix is to launch with RESUME: the paneCommand becomes `exec claude --dangerously-skip-permissions --resume <claudeSessionId>` (codex uses `resume <id>`, gemini `--resume <id>`) whenever a captured `claudeSessionId` exists. The `-A` semantics make this self-selecting: the resume flag only ever executes when tmux is actually re-created, which is exactly when the live session was lost. When tmux is still alive (case 1), attach wins and the flag is inert.

Capturing / persisting / reusing the resume id (the missing mechanism the critic flagged): Codeman already learns `Session.claudeSessionId` from transcript correlation (which works here because projHash matches, Key decision 3) and persists it in `SessionState`. We thread that value into `createSessionOptions` / `respawnPaneOptions` for docker so `buildDockerLaunchCommand` can inject the resume flag on any relaunch. To make a NEW Codeman session (new `id8`) re-launched against the same case resume its predecessor's conversation, we ALSO persist `lastClaudeSessionId` on the `DockerCase` record; the quick-start docker branch seeds the new `Session` with it when the `dockerResumeOnStart` setting is on. First-ever launch has no id, so it starts fresh. This is user-decision 7 (default resume behavior).

Reconciling with stop-on-kill and with the `--restart` policy (the internal inconsistency the critic found): the container is created with `--restart no` uniformly (Codeman's idempotent create-if-missing plus boot recovery is the single recovery mechanism; a restart policy would not preserve the conversation anyway because a restarted container gets a fresh PID1/tmux). Boot recovery re-runs `buildDockerLaunchCommand` from the restored `MuxSession.docker` (`docker inspect || docker create; docker start`, then exec with resume), so a host reboot or daemon restart recreates+starts the container and resumes the conversation instead of the session vanishing. `reconcileSessions` (tmux-manager.ts ~1800-1815) must NOT hard-delete a docker session merely because no LOCAL pane exists after the local `-L codeman` server died; docker (like remote) sessions are restored from `mux-sessions.json` and relaunched. This relaunch path is explicitly part of Phase 4/Phase 3 recovery work, not assumed.

Why this over the alternatives: `docker exec` gets SIGHUP and dies when its client TTY closes, so a bare `docker exec claude` restarts the CLI on every reconnect/respawn. The inner tmux plus resume is what makes reconnect idempotent across BOTH failure surfaces. Because this durability is the single most important design point, tmux-in-image is a HARD gated prerequisite (`checkDockerTmuxAvailable`), never a silent fallback to bare exec. Rejected alternatives: ephemeral-per-run or bare-exec containers (no reattach durability); a literal `'docker'` `SessionMode` (touches dozens of switch/enum sites and diverges from the remote overlay precedent, since Docker is a LOCATION orthogonal to the 5 CLI backends).

### Key decision 2: CLI + auth delivery

One prebuilt base image (built once, contains NO secrets): `node:22-bookworm-slim` + `git tmux ripgrep ca-certificates`, `npm i -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai`, an `agent` user, HOME dirs made writable by an arbitrary host uid via the OpenShift "gid 0, group-writable" convention (Key decision 6). Because the toolchain is baked, export is reproducible and needs no network at import time. The image name/namespace/registry and its refresh cadence are user-decision 2 (the `codeman/agent:base` placeholder implies a Docker Hub org the project may not own).

Credentials are delivered ONLY at runtime, two commit-safe channels, default convenient:

- OAuth/config-file CLIs (Claude Max/Pro, gcloud, opencode): bind-mount the host credential dirs read-write (`~/.claude`, `~/.codex`, `~/.gemini` + `~/.config/gcloud`, `~/.config/opencode`) so the common user "just works" with no in-container login. Because these are bind mounts, `docker commit` (which captures only the container's own writable layer, never bind mounts) physically cannot capture them, so exports stay secret-free.
- API-key CLIs (codex/gemini): exec-time NAME-ONLY `docker exec --env OPENAI_API_KEY --env GEMINI_API_KEY ...` (no `=value`), sourced from Codeman's own process env. Only the key NAME appears in argv (no `ps` leak), and per-exec env is never captured by `docker commit`. This is the technique Codeman already uses via `tmux setenv` for the local Codex/Gemini panes, so it composes with existing machinery.

Per-host `DockerHost.mountCredentials` defaults `true` (convenient); setting it `false` yields a SEALED profile (no host cred mounts, in-container login only) for genuinely untrusted work. CRITICAL sealed-mode export rule (the leak the critic caught): in sealed mode the in-container login writes tokens into the container's OWN writable layer, which `docker commit` DOES capture, so a full-image export of a sealed container would ship credentials. Therefore full-image export is REFUSED for `mountCredentials:false` containers by default; the user may either take a workspace-only export (always safe) or opt into a pre-commit scrub that `docker exec`s `rm -rf ~/.claude ~/.codex ~/.gemini ~/.config/gcloud ~/.config/opencode` inside the container before commit (destructive to the in-container login, which is the point). This is enforced in the export route, not left to a manifest assertion.

Per-session `envOverrides` / `effort` / `codexConfig` / `geminiConfig` / `openCodeConfig` are REJECTED at quick-start exactly like the remote branch (session-routes.ts ~1698-1710). `modelOverride` is the one deliberate difference from remote: because the docker workspace is a REAL bind-mounted host dir that Codeman scaffolds (Key decision 5 and Section 6), `updateCaseModel()` can write the `model` key into `<workspace>/.claude/settings.local.json` and the in-container `claude` reads it, so the App Settings Claude Model picker works for docker cases. `effort` is a `--effort` CLI arg applied only by the local-spawn path we bypass, so it stays rejected (surfaced honestly in the UI, not silently inert). Per-mode command customization goes through `DockerHost.commands.<mode>` (`defaultDockerCommandForMode`, mirror of `defaultRemoteCommandForMode` at remote-hosts.ts:60). NEVER bake secrets into an image layer and NEVER pass a secret via create-time `-e` (both are committed).

Rejected alternative: sealed-by-default. For a single-operator loopback tool where the agent already runs skip-permissions on the host, forcing an in-container OAuth re-login is a UX regression with little real gain. We keep sealed as an opt-in. Rejected alternative: baking a login into the image, which leaks the instant you `docker save`.

### Key decision 3: workspace mount, container CWD, and transcript correlation

Bind-mount the host workspace dir into the container at the SAME absolute path (`dst == src`, mirror the host path), and set both `Session.workingDir` and the container workdir to that host path.

Two problems this solves that the raw proposals got wrong:

- File features: `DockerCase.hostWorkspacePath` is a REAL host directory, so `Session.workingDir = hostWorkspacePath` keeps file-routes, attachments, image-watcher, and previews working on real host bytes (unlike remote, where the path is remote-only and those features no-op). All three proposals wired `casePath = <container path>`; we deliberately diverge and use the host path.
- Transcript correlation: Claude writes transcripts under `~/.claude/projects/<hash-of-CWD>/`. By mirroring the host path as the container CWD, the projHash computed inside the container equals the host-side hash Codeman's transcript/subagent/workflow watchers expect, so correlation keeps working (and, in turn, feeds the resume-id capture in Key decision 1). A `/workspace`-style fixed dst would break it. Mirror-vs-fixed is user-decision 3.

`resolveMuxAttachCwd` still returns `/tmp` for docker sessions (the LOCAL bash pane only runs `docker exec`; it never needs the workspace as its cwd), mirroring remote.

### Key decision 4: network default and the engine-specific host gateway

Default `bridge` (own netns, NAT egress, no inbound), per-case changeable to `none` (offline shell sandbox; warned because it breaks the API CLIs) or `custom` (a user-defined bridge `codeman-net-<slug>`, the chokepoint for a future egress allowlist). `host` networking and any `-p` inbound publish are structurally unrepresentable in the flag builder and schema. Rationale: every API-backed CLI (Claude, Codex, Gemini) plus npm/git needs egress, so `bridge` is the only sane functional default; `none` is reserved for `shell`.

The host-callback gateway alias is ENGINE-SPECIFIC (the critic's podman finding): Docker uses `host.docker.internal`, Podman uses `host.containers.internal` (Docker's alias only exists on recent podman). A helper `hostGatewayAlias(engine)` returns the right name; Section 2.5, the create args, the `CODEMAN_API_URL` rewrite, and the host-guard allowlist all consume it, and BOTH aliases are added to the allowlist so a mixed fleet keeps working.

### Key decision 5: hooks actually reach the host AND are actually installed

Two independent things must both be true for a hook to fire, and the raw plan wired only the first:

1. Network reachability. Claude Code hooks POST to `$CODEMAN_API_URL` (`curl -sk`). Inside a bridge container `localhost` is the container and prod binds `127.0.0.1`, so we set `--add-host <gatewayAlias>:host-gateway` on create (skipped on Docker Desktop, where the alias is native), add the gateway alias to the host guard, and provide `CODEMAN_API_URL` and the hook secret (below).
2. Hook INSTALLATION. Hooks live in `<workspace>/.claude/settings.local.json`, written by the quick-start scaffolding block (around session-routes.ts ~1776) that calls `writeHooksConfig()` / `updateCaseModel()`. The raw plan extended the `!remote` guard to `!remote && !docker`, which would SKIP that block and silently disable ALL hooks regardless of networking. For docker the workspace is a REAL bind-mounted host dir, so the scaffolding block MUST run. Precise fix: extend to `!remote && !docker` ONLY the LOCAL-CLI-availability and local-spawn guards (the ones that stat the local binary or build the local spawn command); leave the workspace-scaffolding guard at `!remote` so it runs for docker. This same decision is what makes `modelOverride` work (Key decision 2). Consequence, surfaced as user-decision 4: linking a docker case now WRITES `.claude/settings.local.json` (and the CLAUDE.md scaffold, matching local-case behavior) into the user's real host directory, a behavioral shift from "link a dir" to "link and scaffold a dir."

`CODEMAN_API_URL` derivation (the wrong-scheme bug the critic caught): prod is HTTPS-only on 3000, and `server.ts` (~2000) auto-sets `process.env.CODEMAN_API_URL = ${protocol}://${apiHost}:${port}`. Hardcoding `http://host.docker.internal:3000` fails every hook. Instead a pure helper `containerApiUrl(process.env.CODEMAN_API_URL, engine)` parses the running URL and substitutes ONLY the hostname with `hostGatewayAlias(engine)`, preserving scheme and port (`https://host.docker.internal:3000`). Unit-tested against http, https, non-default ports, and both engines. Passed as create-time `--env CODEMAN_API_URL=<derived>` (case-stable, non-secret).

Hook secret and session attribution:
- `~/.codeman/hook-secret` is bind-mounted read-only to a container path; `--env CODEMAN_HOOK_SECRET_FILE=<that path>` is create-time (a path is non-secret; the bytes ride the bind mount and are never committed).
- `CODEMAN_SESSION_ID` (which the generated hooks reference at hooks-config.ts:78-80 to attribute events) plus `CODEMAN_MUX=1` are SESSION-scoped, so they are passed at EXEC time via `docker exec --env CODEMAN_SESSION_ID=<id> --env CODEMAN_MUX=1` (non-secret, value inline is fine, and exec env is not committed). Because a `tmux` session started fresh only inherits the invoking env when it starts the SERVER, the launch chain ALSO runs `tmux -L codeman-docker setenv -g CODEMAN_SESSION_ID <id>` (and `CODEMAN_MUX`) so reattaches and newly created panes see the same values. This mirrors how Codeman already injects per-session env into tmux for the external CLIs.

Hooks-in-MVP-vs-deferred stays user-decision 4; if deferred, docker ships as explicitly hook-degraded and we lean on output-based idle detection through the docker-exec PTY.

### Key decision 6: uid / HOME / rootless enforcement / macOS Docker Desktop

The raw plan showed `--user 1000:1000` in one place and `--user "$(id -u):$(id -g)"` in another and never resolved HOME writability; this section fixes all of it.

- Linux native (docker rootful or rootless): run `--user <hostUid>:0` (host uid, GID 0). The image follows the OpenShift arbitrary-uid convention: `HOME=/home/agent`, and `/home/agent` plus the tool cache dirs (`~/.npm`, `~/.cache`, `~/.config`) are owned `root:0` and group-writable (`chmod -R g+w`, `g+s` on dirs) so a process with GID 0 can write HOME even though its UID is not 1000. This keeps workspace files host-owned (the agent's UID is the host UID) AND keeps HOME writable, so the CLIs actually start.
- Podman rootless: use `--userns=keep-id` (maps the host uid to the image's `agent` uid inside the container) instead of `--user`, so `/home/agent` is owned by the running user and workspace files are host-owned. This is a real per-engine branch in `buildDockerCreateArgs`.
- macOS Docker Desktop: `--user <macUid>` (e.g. 501) does not own the image's `/home/agent`, so non-bind HOME writes fail EACCES and the CLIs may not start; Desktop also does its own bind-mount uid translation, provides `host.docker.internal` natively (no `--add-host`), and its VM memory ceiling can cap `--memory`. Detect Desktop via `docker info` (Server OS `linuxkit` / `OperatingString` contains "Docker Desktop") and take a dedicated path: do NOT pass `--user` (run as the image's baked `agent` uid and rely on Desktop's translation for workspace access), skip `--add-host`, and note in the UI that memory caps are subject to the VM ceiling.

Rootless resource-cap enforcement (the silently-inert risk): rootless Docker without cgroup-v2 systemd delegation (`Delegate=yes`) silently IGNORES `--memory`/`--cpus`/`--pids-limit`. The probe checks `docker info` for `CgroupVersion=2` plus rootless plus delegation; if caps cannot be enforced, `checkDockerAvailable` returns `capsEnforced:false` and the link/probe surfaces "resource caps are advisory on this engine." Whether to REQUIRE delegation or ship-with-warning is user-decision 6.

## 3. Data model

New TypeScript types in `src/types/session.ts`, added right after the remote types (lines 46-99). SessionMode (line 44) is UNCHANGED.

```ts
export type DockerCommandMode = Extract<SessionMode, 'shell' | 'claude' | 'opencode' | 'codex' | 'gemini'>;
export type DockerEngine = 'docker' | 'podman';
export type DockerNetworkMode = 'bridge' | 'none' | 'custom'; // never 'host'

export interface DockerResourceLimits {
  memory?: string;    // '4g'  -> --memory 4g --memory-swap 4g (swap==memory: real OOM cap)
  cpus?: string;      // '2'
  pidsLimit?: number; // 512   (fork-bomb guard)
  nofile?: string;    // '4096:8192'
  shmSize?: string;   // optional; only when a tool needs /dev/shm
}

export interface DockerHost {
  id: string;
  label: string;
  engine?: DockerEngine;             // default resolved by probe (docker, else podman)
  image: string;                     // default resolved image ref (see user-decision 2)
  daemonHost?: string;               // advanced: -H ssh://user@host / DOCKER_HOST
  context?: string;                  // advanced: --context <ctx>
  network?: DockerNetworkMode;       // default 'bridge'
  networkName?: string;              // when network === 'custom'
  resources?: DockerResourceLimits;
  mountCredentials?: boolean;        // default true (false = sealed; blocks full-image export)
  hooksEnabled?: boolean;            // default true (host-gateway callback wiring)
  resumeOnStart?: boolean;           // default true (see Key decision 1 / user-decision 7)
  commands?: Partial<Record<DockerCommandMode, string>>;
  extraCreateArgs?: string[];        // validated like extraSshOptions
  extraExecArgs?: string[];
}

export interface DockerCase {
  name: string;
  type: 'docker';
  hostId: string;
  hostWorkspacePath: string;         // absolute HOST dir: bind src + Session.workingDir
  containerWorkdir?: string;         // container path; default = hostWorkspacePath (mirror -> projHash match)
  container?: string;                // default codeman-case-<slug>
  lastClaudeSessionId?: string;      // captured resume id (Key decision 1)
}

export interface SessionDocker {     // flattened, round-trips through mux/state (mirror SessionRemote at 91)
  hostId: string;
  label: string;
  engine: DockerEngine;
  image: string;
  containerName: string;
  hostWorkspacePath: string;
  containerWorkdir: string;
  network: DockerNetworkMode;
  networkName?: string;
  resources?: DockerResourceLimits;
  mountCredentials: boolean;
  hooksEnabled: boolean;
  resumeOnStart: boolean;
  daemonHost?: string;
  context?: string;
  commands?: Partial<Record<DockerCommandMode, string>>;
  extraCreateArgs?: string[];
  extraExecArgs?: string[];
  configHash?: string;               // drift detection (Key decision, Section 4)
}
```

- `SessionState` gains `docker?: SessionDocker` immediately after `remote?` (line 219). It persists automatically because `SessionState` is structural and `state-store.ts` stores `toState()` verbatim.
- `src/mux-interface.ts`: add `docker?: SessionDocker` to `MuxSession` (after line 38), `CreateSessionOptions` (after 81), `RespawnPaneOptions` (after 105). `MuxSession.docker` round-trips through `mux-sessions.json` automatically.
- `src/types/api.ts` `CaseInfo`: add `'docker'` to the `location` union and a `docker?: { hostId; container; image?; path; network }` display block.
- `src/services/unified-session-service.ts`: add a boolean `docker?` flag on `UnifiedSessionItem` and source rows, set from `MuxSession.docker` presence (mirror the `remote` flag at ~line 200 and the harvest at session-routes.ts:2313).

New state files (all via `dataPath()`, mirroring `remote-hosts.json` / `remote-cases.json`):

- `~/.codeman/docker-hosts.json` (reusable engine/image/network/resource profiles).
- `~/.codeman/docker-cases.json` (`name -> DockerCase`, including `lastClaudeSessionId`).
- `~/.codeman/docker-exports/` (dedicated dir for `.image.tar.gz` + `.workspace.tar.gz` + `manifest.json`; never inline in state.json; retention/pruning per Section 5).

No new `state.json` / `mux-sessions.json` files: `SessionState.docker` and `MuxSession.docker` ride the existing serialization.

## 4. Container lifecycle (exact command shapes)

All builders are PURE string functions (directly unit-testable). Host values interpolated into the outer `bash -c "..."` layer (container name, image, workdir, host paths) are `shellescape()`'d and, for user-supplied fields, schema-rejected for `$`/backtick via `NO_SHELL_META`. The escaping chain here is DEEPER than remote's single `ssh '<tmux ...>'`: the whole `docker inspect || docker create <dozens of --mount/--env/shellescaped host paths>` is interpolated into `bash -c "..."` then `JSON.stringify`'d into respawn-pane. This is a known place to get stuck, so it is covered by concrete escaping tests (Section 9), including host workspace paths containing spaces, not just a "we call shellescape" claim.

New in `src/tmux-manager.ts`:

```ts
const DOCKER_TMUX_SOCKET = 'codeman-docker';
// 'dkr' letters deliberately FAIL SAFE_MUX_NAME_PATTERN (^codeman-[a-f0-9-]+$),
// so a Codeman running INSIDE the container never adopts/resizes/respawns our session.
export function dockerTmuxSessionName(id: string): string { return `codeman-dkr-${id.slice(0, 8)}`; }
```

`buildDockerBaseArgs(docker)` (pure, in `docker-hosts.ts`, mirror of `buildSshConnectionArgs`) emits the engine prefix tokens: `docker` (or `podman`) + optional `--context <ctx>` or `-H <daemonHost>`. `buildDockerCreateArgs(docker, sessionId)` emits the `docker create` flag array (with the per-engine uid/userns branch from Key decision 6).

IMAGE PRESENCE (before any create, the auto-pull footgun the critic caught): the launch chain runs `docker image inspect <image> >/dev/null 2>&1` first; on miss it exits with a distinct message ("base image <ref> not present: build with scripts/build-agent-image.mjs or pull it") rather than triggering a blocking multi-GB auto-pull inside the tmux pane. `docker create` carries `--pull=never`. The tmux-availability probe likewise uses `docker run --rm --pull=never <image> sh -lc 'command -v tmux'` and reports the same build/pull hint if the image is absent, so the 15s-bounded probe never hangs on a pull.

CREATE (the ensure step, embedded in the launch string):

```
docker create \
  --name codeman-case-myproj --hostname myproj \
  --label codeman.managed=1 --label codeman.instance=<CODEMAN_INSTANCE> \
  --label codeman.case=myproj --label codeman.session=<id8> \
  --label codeman.confighash=<hash> \
  --pull=never --init --restart no \
  --user 1000:0 \
  --workdir '/home/arkon/cases/myproj' \
  --mount type=bind,src='/home/arkon/cases/myproj',dst='/home/arkon/cases/myproj' \
  --mount type=bind,src='/home/arkon/.claude',dst='/home/agent/.claude' \
  --mount type=bind,src='/home/arkon/.codeman/hook-secret',dst='/home/agent/.codeman/hook-secret',readonly \
  --add-host host.docker.internal:host-gateway \
  --memory 4g --memory-swap 4g --cpus 2 --pids-limit 512 --ulimit nofile=4096:8192 \
  --cap-drop ALL --security-opt no-new-privileges \
  --network bridge \
  --env HOME=/home/agent --env TERM=xterm-256color --env COLORTERM=truecolor \
  --env CODEMAN_API_URL=https://host.docker.internal:3000 \
  --env CODEMAN_HOOK_SECRET_FILE=/home/agent/.codeman/hook-secret \
  codeman/agent:base \
  sleep infinity
```

- `--user 1000:0` shown is the Linux-native form with GID 0 (Key decision 6); it is actually `--user <hostUid>:0`, or `--userns=keep-id` for podman rootless, or omitted on Docker Desktop. The literal is illustrative only.
- Create-time `--env` carries only NON-SESSION, non-secret, case-stable values (safe to be committed): the DERIVED `CODEMAN_API_URL` (https-preserving, Key decision 5) and the hook-secret FILE PATH. `CODEMAN_SESSION_ID`/`CODEMAN_MUX` and the codex/gemini key NAMES are exec-time only.
- `codeman.instance=<CODEMAN_INSTANCE>` is REQUIRED on the label set so the boot reaper is instance-scoped (a beta/second instance must never reap prod's containers).
- `codeman.confighash` is a stable hash of the drift-relevant create args (image, resources, network, mounts, non-session env). Drift detection (user story 2, the config-never-takes-effect gap): on launch the ensure block compares the desired hash to the existing container's label; on mismatch the launch does NOT silently reuse the stale container. Instead the docker route returns a "container config changed, recreate?" action (SSE + UI confirm), and on confirm Codeman `docker rm`'s and recreates. rm destroys in-image (non-bind) state, but the workspace and transcripts survive on their bind mounts and the conversation is restored via `--resume`, so the recreate is safe. Auto-recreate-vs-prompt is a UI choice; the MVP prompts.
- `--restart no` (resolved consistently with Key decision 1; recovery is Codeman's idempotent create-if-missing, not an engine restart policy, which also matters for Podman which has no daemon).

EXEC (`buildDockerLaunchCommand`, the docker analog of `buildRemoteLaunchCommand`, TTY-correct, resume-aware). The whole thing is ONE `bash -c` string that image-checks, ensures, starts, primes tmux env, then execs:

```
docker image inspect codeman/agent:base >/dev/null 2>&1 || { echo 'Codeman: base image codeman/agent:base not present (build or pull it)'; exit 1; } ; \
docker inspect codeman-case-myproj >/dev/null 2>&1 || docker create <all create args above> ; \
docker start codeman-case-myproj >/dev/null 2>&1 || { echo 'Codeman: container codeman-case-myproj failed to start (daemon down?)'; exit 1; } ; \
exec docker exec -it \
  --workdir '/home/arkon/cases/myproj' \
  --env TERM=xterm-256color --env COLORTERM=truecolor \
  --env CODEMAN_SESSION_ID=1a2b3c4d --env CODEMAN_MUX=1 \
  --env OPENAI_API_KEY --env GEMINI_API_KEY \
  codeman-case-myproj \
  sh -lc 'tmux -L codeman-docker setenv -g CODEMAN_SESSION_ID 1a2b3c4d \; setenv -g CODEMAN_MUX 1 \; new-session -A -s codeman-dkr-1a2b3c4d -c '\''/home/arkon/cases/myproj'\'' '\''cd /home/arkon/cases/myproj && exec claude --dangerously-skip-permissions --resume <claudeSessionId>'\'' \; set -t codeman-dkr-1a2b3c4d status off \; set -t codeman-dkr-1a2b3c4d mouse off \; set -t codeman-dkr-1a2b3c4d prefix C-q \; set -s escape-time 0'
```

- `docker exec -it`: `-t` allocates a PTY and forwards SIGWINCH into the container so the Ink TUI re-lays-out on pane resize; `TERM`/`COLORTERM` prevent degraded rendering. `--env OPENAI_API_KEY` (name only) is present only for codex/gemini and is exec-time (never committed). `CODEMAN_SESSION_ID`/`CODEMAN_MUX` are exec-time values plus a `tmux setenv -g` prime so reattaches and new panes inherit them (Key decision 5).
- `--resume <claudeSessionId>` (codex `resume <id>`, gemini `--resume <id>`) is appended to `modeCommand` ONLY when a captured id exists; on first launch it is omitted. `new-session -A` makes the flag inert on a live-tmux reattach and effective only when tmux is re-created (Key decision 1).
- `modeCommand = docker.commands?.[mode] || defaultDockerCommandForMode(mode)` (`exec claude --dangerously-skip-permissions`, `exec bash -l`, etc.), with the resume suffix injected by the builder.
- Escaping survives every layer identically to remote in shape but deeper in nesting: `paneCommand` (`cd ... && exec ...`) is one shellescaped tmux arg, the whole `tmuxInvocation` is one shellescaped `sh -lc` arg, and the outer string is `JSON.stringify()`'d into `bash -c` by respawn-pane (tmux-manager.ts:1329).

Wire-up (extend the two existing seams to 3-way):

- createSession (tmux-manager.ts:1276): `const fullCmd = docker ? buildDockerLaunchCommand({ mode, docker, sessionId, resumeSessionId }) : remote ? buildRemoteLaunchCommand({ mode, remote, sessionId }) : localFullCmd;`
- launchCmd cd-skip (tmux-manager.ts:1327): `const launchCmd = (remote || docker) ? fullCmd : \`cd ${JSON.stringify(workingDir)} && ${fullCmd}\`;`
- respawnPane: same two edits at lines 1524 and 1542.

START / reattach-after-reboot: the ensure block (image-check, `docker inspect || docker create`, `docker start`) is fully idempotent, so boot recovery just re-runs `buildDockerLaunchCommand` from the restored `MuxSession.docker` with the persisted resume id. A rebooted host recreates the container and resumes the conversation.

DOCKER-DOWN surfacing (the PTY-exit-breaker false-trip risk): if `docker start` or `docker exec` cannot attach (daemon down, container missing), the launch prints a docker-specific message and exits, which alone would still count toward `session-pty-exit-breaker` and show a generic "respawn breaker tripped" push. To avoid masking the cause, the docker reattach path runs a fast `checkDockerAvailable` pre-flight: if the daemon/container is unreachable, Codeman broadcasts a docker-specific error (SSE + push, "container <name> is not running / daemon down") and SKIPS the auto-reattach that would trip the breaker, rather than fast-looping `docker exec`.

STOP / KILL (`killSession` Strategy 3c, right after remote's Strategy 3b at tmux-manager.ts:1719, guarded by `IS_TEST_MODE`):

```ts
if (session.docker) {
  // best-effort, fire-and-forget, timeout-bounded so it never blocks the local kill
  execAsync(buildDockerKillCommand({ docker: session.docker, sessionId }), { timeout: EXEC_TIMEOUT_MS }).catch(() => {});
}
```

`buildDockerKillCommand` emits: `docker exec codeman-case-<slug> tmux -L codeman-docker kill-session -t codeman-dkr-<id8> ; docker stop -t 10 codeman-case-<slug>`. Stopping frees CPU/RAM and, per Key decision 1, is safe for conversation continuity because the NEXT launch resumes from the bind-mounted transcript via `--resume`. Whether to stop at all (RAM vs instant live-agent reattach) is user-decision 6/1 (reframed honestly). The bind-mounted workspace and transcripts always survive on the host.

REMOVE: only on explicit case delete (`docker rm -f codeman-case-<slug>`), gated behind an "export first?" UI prompt because rm destroys any in-image (non-bind) state. Instance-scoped boot reaper (fixing the racy/cross-instance reaper): after `docker-cases.json` is loaded AND after `restoreMuxSessions` has run, enumerate `docker ps -a --filter label=codeman.managed=1 --filter label=codeman.instance=<CODEMAN_INSTANCE> --format '{{.Names}}\t{{index .Labels "codeman.case"}}'` and `docker rm -f` only containers whose case is gone from THIS instance's `docker-cases.json`. The instance filter is what stops a beta reaping prod's containers (the exact cross-instance hazard the project memory warns about).

AVAILABILITY PROBE (`docker-hosts.ts`, timeout-bounded like `checkRemoteTmuxAvailable`'s 15s, `IS_TEST_MODE` no-op):

```
docker info --format '{{json .}}'                                  # server up, CgroupVersion, rootless, OS (Desktop detect), cap-delegation
docker image inspect <image> --format '{{.Id}}'                    # image PRESENT (no auto-pull)
docker run --rm --pull=never <image> sh -lc 'command -v tmux'      # tmux-in-image gate (hard prerequisite), only if image present
```

`checkDockerAvailable()` returns `{ ok, engine, rootless, isDesktop, cgroupV2, capsEnforced }` (parse `SecurityOptions` for `name=rootless`, `CgroupVersion`, delegation, and Server OS for Desktop). `checkDockerTmuxAvailable(host)` returns a structured result with a user-facing error and correct install hint (NOT `npm install -g`; the hint is "build/pull the base image" for a missing image and "install docker or podman" for a missing engine).

IN-CONTAINER CLI VERSION (fixing the #154 wheel-forwarding regression): the raw plan skipped the LOCAL `cliVersion` probe for docker (correct, since it reports the HOST claude) but left `cliVersion` undefined, which disables trackpad wheel-forwarding. Instead, for docker sessions Codeman runs an IN-CONTAINER probe `docker exec <container> claude --version` (bounded, `IS_TEST_MODE` no-op) and feeds THAT into `cliVersion`. This also means a stale baked CLI is visible; combined with the rebuild-cadence in user-decision 2, agents are not silently pinned to an old claude.

## 5. Export / Import

EXPORT is a concurrency-bounded job (reuse `runWithConversionLimit` from `document-conversion-limiter.ts` so N simultaneous exports cannot fork-bomb the host). Route `POST /api/docker-cases/:name/export`.

Preconditions (the consistency and leak risks the critic caught):
- Sealed guard: if `mountCredentials:false`, full-image export is REFUSED unless the caller explicitly opts into the pre-commit scrub (Key decision 2). Workspace-only export is always allowed.
- Quiesce + free-space: require the session idle, then `docker pause` the container spanning BOTH the workspace tar AND the commit so the two artifacts are mutually consistent (the raw plan paused only the commit, leaving the bind-mount tar to run against a mid-write agent). Before any heavy step, precheck free space in the exports dir and in `/var/lib/docker`; if below `DOCKER_EXPORT_MIN_FREE_BYTES`, refuse with a clear error (a full `/var/lib/docker` wedges the daemon and breaks EVERY session on the host).

Steps (all cleanup in try/finally so a mid-way failure never orphans an intermediate image or leaves the container paused):

1. `docker commit -c 'LABEL codeman.exported=1' codeman-case-<slug> codeman/export-<slug>:<ts>` (unique tag per export defeats the stale-image trap). Optional pre-commit scrub in sealed mode as above; also blank instance-specific committed env (`-c 'ENV CODEMAN_API_URL='` etc.) so the image carries no stale host references.
2. `docker save codeman/export-<slug>:<ts> | gzip` streamed in fixed 8192-byte chunks to `~/.codeman/docker-exports/<slug>-<ts>.image.tar.gz`. Uses `docker save` (layers + repo:tag + CMD), never `docker export` (flat rootfs), so restore is a trivial `docker load`.
3. `tar --numeric-owner -C <hostWorkspacePath> -czf <slug>-<ts>.workspace.tar.gz .` while paused (the bind-mounted workspace is NOT in the image, so it travels separately and consistently).
4. Write `manifest.json`: schema version, caseName, image tag, engine, containerWorkdir, resource/network config, codeman version, base-image digest, createdAt, per-member sha256, `mountCredentials`, and `secretFree` (true only for convenient-mode or scrubbed-sealed exports).
5. `docker rmi codeman/export-<slug>:<ts>` in the `finally` (delete the intermediate committed image regardless of success), then `docker unpause`.

The three files are wrapped in one bundle `<slug>-<ts>.codeman-container.tgz` and offered as a downloadable artifact through the existing file-routes streaming + attachment-registry handoff.

Retention / disk budget (user-decision 3): `docker-exports/` is capped at `DOCKER_EXPORT_KEEP` most-recent bundles with an auto-prune on each new export, plus the free-space precheck above. Workspace scrub: the WORKSPACE tar gets a scan/warn pass for agent-created `.env` / `.git/credentials` (a distinct leak channel from container creds). A lighter "workspace-only" export (just the workspace tar, no commit/save) is the fast default for 24h+ runs; full-image is the explicit heavier option (user-decision 7 in the original list, now decision on the default button below).

What travels: the baked toolchain image plus any in-image writes, and the workspace tar. What does NOT travel: bind-mounted credentials (physically excluded from commit) and anything that lived only in a bind mount. Secret-free by construction in convenient mode, and enforced (refuse-or-scrub) in sealed mode.

IMPORT `POST /api/docker-cases/import` (untrusted-bundle containment, the traversal/overwrite risk): stream the uploaded bundle, validate every manifest checksum BEFORE any extraction or load. Extract the workspace tar with `tar --no-absolute-names -C <fresh dir>` PLUS per-entry validation rejecting any member whose normalized path escapes the destination (leading `/` or `..` components). `gunzip | docker load` the image, then RE-TAG the loaded image id into a quarantined namespace `codeman/imported-<slug>:<ts>` and NEVER allow the load to overwrite `codeman/agent:base` or any pre-existing tag (capture the loaded id, ignore the bundle's repo:tag). Create a NEW `DockerCase` pointing at the quarantined image with THIS host's mounts/creds and the manifest's resource/network config, and recreate the container hardened (cap-drop ALL, no-new-privileges, non-root, `--pull=never`, CMD overridden to `sleep infinity`). The destination supplies its own login, so credentials never cross machines. Plus `GET /api/docker-exports` (list) and `DELETE /api/docker-exports/:filename`, all behind Codeman's existing auth / loopback-default / host-guard / Origin-CSRF stack.

## 6. Codeman integration (file-by-file, mirroring the remote-SSH feature)

- `src/types/session.ts`: add `DockerCommandMode`, `DockerEngine`, `DockerNetworkMode`, `DockerResourceLimits`, `DockerHost`, `DockerCase`, `SessionDocker` (Section 3). Add `docker?: SessionDocker` to `SessionState` after line 219. SessionMode (line 44) UNCHANGED.
- `src/mux-interface.ts`: add `docker?: SessionDocker` to `MuxSession` (38), `CreateSessionOptions` (81), `RespawnPaneOptions` (105).
- `src/docker-hosts.ts` (NEW, direct mirror of `src/remote-hosts.ts`): `readDockerHosts`/`writeDockerHosts`/`readDockerCases`/`writeDockerCases` (via `dataPath`, including `lastClaudeSessionId` read/write), `defaultDockerCommandForMode` (mirror line 60), `dockerDisplayPath` (`container:/path`, mirror `remoteDisplayPath` at 205), `toSessionDocker(host, case)` (mirror `toSessionRemote` at 212), `buildDockerBaseArgs`/`buildDockerCreateArgs` (per-engine uid/userns branch), `hostGatewayAlias(engine)`, `containerApiUrl(processApiUrl, engine)` (scheme+port-preserving, unit-tested), `checkDockerAvailable`/`checkDockerTmuxAvailable`/`probeDockerCliVersion` (15s-bounded, `IS_TEST_MODE` no-op), a config-hash helper for drift, its own POSIX `shellescape` copy (mirror line 83). `const IS_TEST_MODE = !!process.env.VITEST;` gates every real `docker` invocation.
- `src/tmux-manager.ts`: add `DOCKER_TMUX_SOCKET`, `dockerTmuxSessionName`, `buildDockerLaunchCommand` (resume-aware, image-check, env-prime), `buildDockerKillCommand` (Section 4). Extend the two `fullCmd` ternaries (1276, 1524) and the two `launchCmd` cd-skips (1327, 1542). Add `killSession` Strategy 3c after 1719. Ensure `reconcileSessions` (~1800-1815) does NOT hard-delete docker sessions on local-tmux death (recovery relaunch path).
- `src/session.ts`: add `_docker?: SessionDocker` field (mirror `_remote` at 403), constructor arg (477), assignment (550). Thread `docker: this._docker` and `resumeSessionId: this._claudeSessionId` into BOTH `createSessionOptions` and `respawnPaneOptions` in `startInteractive` (1352/1370) and the second path (1740/1750). Emit `docker: this._docker` in `toState()` (1010). Replace the LOCAL cliVersion probe at 1320 for docker with the IN-CONTAINER `probeDockerCliVersion` (do not merely skip it). Extend `resolveMuxAttachCwd(workingDir, remote, docker)` (215) to return `/tmp` when `docker` is set. On claudeSessionId capture, persist it to the owning `DockerCase.lastClaudeSessionId`.
- `src/web/server.ts`: in `restoreMuxSessions` (2160), add `docker: muxSession.docker ?? savedState?.docker` to the `new Session({...})` call (2195-2216), and skip docker in the same `isExternalCliMode`/Ralph recovery guards as remote. Register the instance-scoped boot reaper to run AFTER docker-cases load and AFTER `restoreMuxSessions`. Ensure `CODEMAN_API_URL` derivation reads the SAME `process.env.CODEMAN_API_URL` the server sets at ~2000.
- `src/web/schemas.ts`: add `DockerHostSchema` and `DockerCaseLinkSchema` (below). The three mode enums (177/373/705) and `QuickStartSchema` (368) UNCHANGED (docker resolves by `caseName` lookup like remote).
- `src/web/routes/session-routes.ts`: import the docker helpers from `../../docker-hosts.js`. Add a docker branch in `/api/quick-start` parallel to the remote branch (1686-1720): `readDockerCases` -> find by `caseName` -> `readDockerHosts` -> find by `hostId`; reject `envOverrides`/`effort`/`codexConfig`/`geminiConfig`/`openCodeConfig` (but ACCEPT `modelOverride`, which flows via scaffolded `settings.local.json`); run `checkDockerAvailable` + `checkDockerTmuxAvailable` (image-present, engine, caps-enforced); surface `capsEnforced:false` and Desktop notes; set `casePath = dockerCase.hostWorkspacePath` (REAL host dir), `docker = toSessionDocker(host, dockerCase)`, and seed `resumeSessionId` from `dockerCase.lastClaudeSessionId` when `resumeOnStart`. Extend the LOCAL-availability and local-spawn guards (around 1796/1810) to `!remote && !docker`, but DO NOT extend the workspace-scaffolding guard (~1776, `writeHooksConfig`/`updateCaseModel`), which MUST run for docker. Pass `docker` into `new Session` (1847); `autoConfigureRalph` (1853) gated on `!docker`. Add `docker: m.docker !== undefined ? true : undefined` to the unified harvest (2313).
- `src/web/routes/case-routes.ts`: import the docker read/write/check helpers + schemas. Add a docker listing loop in `GET /api/cases` (mirror 94-119, `location: 'docker'`, `docker: {...}` via `dockerDisplayPath`). Add `/api/docker-hosts` GET/POST/PUT/DELETE (mirror 168-204) and `POST /api/cases/docker-link` (mirror 206-232; run `checkDockerAvailable`/`checkDockerTmuxAvailable` at link time; broadcast `CaseLinked` with `type: 'docker'`). Add a docker-unlink branch to `DELETE /api/cases/:name` (mirror 288-296; `docker rm -f`; broadcast `CaseDeleted` `type: 'docker-unlinked'`). Add the docker branch to single-case `GET` (mirror 358-368). Add `POST /api/docker-cases/:name/export`, `/import`, `GET/DELETE /api/docker-exports`, and a `POST /api/docker-cases/:name/recreate` (drift confirm) per Sections 4 and 5.
- `src/web/sse-events.ts` + `src/web/public/constants.js`: reuse `CaseLinked`/`CaseDeleted` for CRUD. Add `docker:exportProgress`, `docker:exportComplete`, `docker:importComplete`, `docker:configDrift`, and `docker:containerError` to BOTH registries (kept in sync per CLAUDE.md).
- Frontend `src/web/public/index.html` (~1831): add a Docker `modal-tab-btn` next to Remote; add a `#case-docker` panel mirroring `#case-remote` with `dockerCaseName`, `dockerHostWorkspacePath`, `dockerContainer`, `dockerImage`, `dockerHostId`, and an Advanced `<details>` for network mode, resource caps, `mountCredentials`, `resumeOnStart`, and remote daemon. Surface a "scaffolds .claude into this host dir" note (user-decision 4) and a "resource caps advisory on this engine" warning when `capsEnforced:false`.
- Frontend `src/web/public/session-ui.js`: `formatCasePickerLabel` (48) + `buildCasePickerOptions` (71-73) handle `location === 'docker'` (`name @ container`, add container/image to the search haystack); `resetCaseModalFields` (~1514) add a `dockerFields` array; `switchCaseModalTab` (1573/1580/1597) handle `'case-docker'`; `submitCaseModal` add the docker branch; new `linkDockerCase()` (mirror `linkRemoteCase` at 1689) POSTing `/api/docker-hosts` then `/api/cases/docker-link`, sending omitted optionals as `undefined` (spread `...(x ? {x} : {})`, never `null`, per the Zod `.optional()`-rejects-null gotcha); `runClaude` (520) / `runShell` (702) extend the `location === 'remote'` routing to also match `'docker'`; `runOpenCode`/`runCodex`/`runGemini` (792/846/900) make the `isRemote` checks `isRemoteOrDocker` so local status probes are skipped. In the session-options Summary tab, note that `effort` is inert for docker (rejected) while `model` IS honored via `settings.local.json`.
- Frontend `src/web/public/panels-ui.js` (425-426): add `caseItem?.docker?.path`/`container` to the case-search fields.

Schemas (`src/web/schemas.ts`), mirroring `RemoteHostSchema` (299) / `RemoteCaseLinkSchema` (351):

```ts
export const DockerHostSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid docker host id'),
  label: z.string().min(1).max(100),
  engine: z.enum(['docker', 'podman']).optional(),
  image: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][\w./:@-]*$/, 'Invalid image ref').regex(NO_SHELL_META),
  daemonHost: z.string().max(512).regex(NO_SHELL_META, 'Invalid daemon host').optional(),
  context: z.string().max(128).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid context').optional(),
  network: z.enum(['bridge', 'none', 'custom']).optional(),
  networkName: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/).optional(),
  resources: z.object({
    memory: z.string().regex(/^\d+[bkmg]?$/i).optional(),
    cpus: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    pidsLimit: z.number().int().positive().max(100000).optional(),
    nofile: z.string().regex(/^\d+:\d+$/).optional(),
    shmSize: z.string().regex(/^\d+[bkmg]?$/i).optional(),
  }).strict().optional(),
  mountCredentials: z.boolean().optional(),
  hooksEnabled: z.boolean().optional(),
  resumeOnStart: z.boolean().optional(),
  commands: RemoteCommandOverridesSchema, // reuse the shared shape
  extraCreateArgs: z.array(z.string().min(1).max(1024).regex(NO_SHELL_INJECTION).refine(noCommandSubstitution)).max(32).optional(),
  extraExecArgs: z.array(z.string().min(1).max(1024).regex(NO_SHELL_INJECTION).refine(noCommandSubstitution)).max(32).optional(),
});

export const DockerCaseLinkSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  hostId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid docker host id'),
  hostWorkspacePath: z.string().min(1).max(2000).regex(/^\//, 'Path must be absolute').regex(NO_SHELL_META, 'Invalid characters in workspace path'),
  containerWorkdir: z.string().min(1).max(2000).regex(/^\//).regex(NO_SHELL_META).optional(),
  container: z.string().min(2).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid container name').optional(),
});
```

`NO_SHELL_META` (rejects `$`/backtick, schemas.ts:297) is REQUIRED on `image`, `hostWorkspacePath`, `containerWorkdir`, and `container`, because all four reach the outer `bash -c "..."` double-quote layer where `$(...)`/backtick re-expose, exactly the reason `remotePath`/`identityFile` use it. `--privileged` and any `-v /var/run/docker.sock` are structurally unrepresentable (never emitted by the builder, never accepted by the schema).

## 7. Security model

- Hardening flags on every create: `--cap-drop ALL`, `--security-opt no-new-privileges` (NOT auto-set by rootless Docker or Podman, so always explicit), the uid/userns branch of Key decision 6 (never container-root; workspace files stay host-owned and HOME stays writable via GID 0), `--pids-limit` (fork-bomb guard), `--memory` with `--memory-swap == --memory` (real OOM cap), `--ulimit nofile`, `--init`, `--pull=never`. NEVER `--privileged`, NEVER mount the docker socket into the agent container. `--storage-opt size=` is emitted ONLY after the probe confirms overlay2-on-xfs-pquota or btrfs (the AICE-class silently-ignored trap); otherwise it is omitted and the UI does not advertise a size cap. Resource caps are advertised as ENFORCED only when the probe reports `capsEnforced:true`; under non-delegated rootless they are labeled advisory (user-decision 6).
- Engine: prefer whichever the probe finds, Podman-rootless first for security (a container-root breakout lands as an unprivileged host user). Rootless bind-mount ownership uses `--userns=keep-id` (Podman) vs `--user <hostUid>:0` (Docker), so real per-engine branching lives in `buildDockerCreateArgs`. Docker Desktop takes its own uid path (Key decision 6).
- Blast radius (the combined-posture the critic asked to surface, user-decision 5): the default convenient profile mounts an arbitrary host workspace dir RW (host-owned, mirrored path) AND host `~/.claude`/`~/.codex`/`~/.gemini`/`~/.config/gcloud`/`~/.config/opencode` RW into a NETWORK-ENABLED container. Container-run agent code can therefore read/modify those host trees and reach the network simultaneously. This is still a strict improvement over today's on-host skip-permissions execution, but the user must accept the combined posture explicitly; the sealed profile plus `network:none` is the mitigation for genuinely untrusted work.
- Secret handling: creds arrive ONLY as bind-mounted files (default) or exec-time NAME-ONLY `--env` (codex/gemini keys), NEVER as create-time `-e` and NEVER as an image layer. Sealed-mode export is refuse-or-scrub (Section 5), closing the sealed-leak inversion.
- CLAUDE.md "Multi-CLI prefix discipline": the exec-time name-only env is restricted to the CLI-specific keys per mode (Claude: none with OAuth mount; Codex: `OPENAI_API_KEY`/`CODEX_API_KEY`; Gemini: `GEMINI_API_KEY`/`GOOGLE_*`), never a blanket forward. `envOverrides` is rejected for docker, so the `ALLOWED_ENV_PREFIXES` allowlist is not widened.
- hook-secret: bind-mounted read-only, referenced via `CODEMAN_HOOK_SECRET_FILE` (a path, non-secret); the secret bytes never enter env or the image. Both `host.docker.internal` and `host.containers.internal` are added to the host-guard allowlist so the in-container hook curl's Host header passes on either engine.
- Host guard / instance isolation: the in-container tmux socket (`codeman-docker`) and name (`codeman-dkr-<id8>`) deliberately FAIL a container-internal Codeman's `SAFE_MUX_NAME_PATTERN`, so a nested Codeman never adopts our session (unit-asserted). The boot reaper is instance-scoped by the `codeman.instance` label so a beta never reaps prod. Any remote-daemon (`-H`/`--context`) mode is host-root-equivalent and stays strictly behind the existing auth/loopback/host-guard/Origin-CSRF stack.
- Import containment: untrusted bundles are checksum-validated, extracted with traversal guards, and loaded into a quarantined image namespace (never overwriting the base image), then run with the same hardening.

## 8. Phased implementation (branch: `feat/docker-session-mode`)

Each phase is independently testable; per CLAUDE.md, end-to-end test in the real env before COM. All new docker IO paths carry `const IS_TEST_MODE = !!process.env.VITEST;` and no-op under it; the pure command builders are tested directly.

- Phase 0: base image + engine probe. Author `docker/agent.Dockerfile` (OpenShift arbitrary-uid HOME) and `scripts/build-agent-image.mjs` (build or pull the base image; digest recorded). Add `checkDockerAvailable`/`checkDockerTmuxAvailable`/`containerApiUrl`/`hostGatewayAlias` (IS_TEST_MODE no-op) and `GET /api/docker/status`. Test: probe stub returns available/caps/Desktop flags under VITEST; `containerApiUrl` preserves scheme+port and swaps host per engine; status route returns the envelope.
- Phase 1: types + storage + schemas. Add all types (Section 3), `src/docker-hosts.ts`, `DockerHostSchema`/`DockerCaseLinkSchema`. Test: `docker-hosts.test.ts` (round-trip incl. `lastClaudeSessionId`, display path, config-hash stability); `docker-exec-options.test.ts` (schema rejects `$`/backtick in image/workdir/container).
- Phase 2: tmux-manager builders. Add `DOCKER_TMUX_SOCKET`, `dockerTmuxSessionName`, `buildDockerLaunchCommand` (resume-aware, image-check, env-prime), `buildDockerKillCommand`; wire the two ternaries + two cd-skips + Strategy 3c; harden `reconcileSessions` against docker hard-delete. Test (pure strings): adopt-proof name fails `SAFE_MUX_NAME_PATTERN`; image-check precedes create; `new-session -A` idempotent; resume flag present only when a resume id is passed; `--pull=never` present; instance label present; escaping survives `bash -c` -> `docker exec` -> `sh -lc` -> tmux WITH a host workspace path containing spaces.
- Phase 3: session.ts + mux + recovery. Add `_docker` + `resumeSessionId` threading, in-container cliVersion probe, `resolveMuxAttachCwd`, mux-interface fields, `restoreMuxSessions` passthrough, instance-scoped reaper wiring, claudeSessionId -> `DockerCase.lastClaudeSessionId` persistence, unified flag. Test: `toState()` emits docker; a persisted docker session round-trips through mux/state; a relaunch injects the persisted resume id (mock mux); reaper only targets this instance's orphaned containers.
- Phase 4: routes + first real e2e. case-routes CRUD + listing + drift-recreate; session-routes quick-start branch (scaffolding RUNS, local-availability guards skip, model accepted, effort/config rejected). Manual e2e on a real docker host: docker-host create -> docker-link -> quick-start; confirm the pane runs `claude` in the container, files land host-owned, a Codeman restart reattaches the SAME live agent, and a `docker stop` followed by relaunch RESUMES the conversation.
- Phase 5: hooks connectivity + installation. host-gateway (per engine), derived `CODEMAN_API_URL`, hook-secret mount, `CODEMAN_SESSION_ID`/`CODEMAN_MUX` exec-env + tmux setenv, host-guard allowlist, and the scaffolding write into the real workspace. Manual e2e: trigger a permission prompt from inside the container and confirm it surfaces; verify hook payloads carry the right session id. If deferred, ship docker as explicitly hook-degraded and verify output-based idle detection through the docker-exec PTY.
- Phase 6: export/import + GC + disk safety. quiesce+pause span, free-space precheck, commit+save+gzip + workspace tar + manifest + streaming download; sealed-mode refuse-or-scrub; retention/auto-prune; import with checksum validation + traversal guard + quarantined re-tag; drift-recreate; boot reaper; `runWithConversionLimit` cap; `docker rmi` in finally. Manual e2e: export, `docker load` on a second machine (or fresh case), import, confirm toolchain + workspace restored and NO creds present; attempt a sealed full-image export and confirm it is refused-or-scrubbed; attempt a `../` bundle and confirm it is rejected.
- Phase 7: frontend. Docker tab, `linkDockerCase`, run wiring, case-picker labels, panels search, caps-advisory + scaffold-warning + effort-inert notes. Verify with Playwright (`waitUntil: 'domcontentloaded'`, 3-4s settle) that the Docker tab renders and a linked docker case appears in the picker.
- Phase 8: docs + COM. Update CLAUDE.md (a "Docker cases" Key Pattern paragraph mirroring remote-SSH, plus the new state files, routes counts, and the resume/durability model), `docs/docker-cases.md`, then COM per the standard flow.

## 9. Test plan

- Unit (pure, CI-safe, mirror `test/remote-hosts.test.ts` / `test/remote-ssh-options.test.ts`):
  - `test/docker-hosts.test.ts`: storage round-trip (incl. `lastClaudeSessionId`), `dockerDisplayPath`, `defaultDockerCommandForMode`, `toSessionDocker`, `containerApiUrl` (http/https, custom port, docker vs podman gateway), config-hash stability/drift, `buildDockerCreateArgs` flag ordering (cap-drop/no-new-privileges/memory==memory-swap/instance-label/`--pull=never` present; host/privileged/socket absent; per-engine uid vs `--userns=keep-id`).
  - `test/docker-exec-options.test.ts`: `buildDockerLaunchCommand`/`buildDockerKillCommand` string shape and escaping through `bash -c` -> `docker exec` -> `sh -lc` -> tmux, including a workspace path with spaces; resume flag present only with a resume id; image-presence check precedes create; `dockerTmuxSessionName` fails `SAFE_MUX_NAME_PATTERN`; schema rejects `$`/backtick in image/workdir/container/name; `linkDockerCase`-shaped bodies with omitted optionals validate (no `null` on the wire).
  - Probe no-op: `checkDockerAvailable`/`checkDockerTmuxAvailable`/`probeDockerCliVersion` return canned values under VITEST and never spawn.
- Integration (route tests via `app.inject()`, docker no-op'd): `/api/docker-hosts` CRUD; `/api/cases/docker-link` dup-check + broadcast; `GET /api/cases` includes the docker case with `location: 'docker'`; `/api/quick-start` docker branch rejects `envOverrides`/`effort`/config but ACCEPTS `modelOverride`, runs the workspace-scaffolding path, and constructs a session with `docker` set + seeded resume id; `DELETE /api/cases/:name` docker-unlink; export refuse-or-scrub for sealed; import traversal rejection; reaper instance-scoping (label filter). Pick a unique port only if a live-server test is added (search `const PORT =`; 3150+).
- Manual end-to-end (real docker daemon, the mandatory "always end-to-end test" gate): build the base image; link a docker case; quick-start `claude`; verify OAuth via the mounted `~/.claude`, transcript correlation (subagent/workflow watchers show the session), host-owned files, and a working permission-prompt hook; reattach after a Codeman PROCESS restart (SAME live agent); `docker stop` then relaunch and confirm conversation RESUME; reboot-equivalent (daemon restart) and confirm boot recovery recreates+resumes; change the host's memory/image and confirm the drift-recreate prompt fires; export (convenient) and confirm the tar `docker load`s with no creds; attempt a sealed full-image export and confirm refuse-or-scrub; import into a fresh case; delete the case and confirm `docker rm -f` plus instance-scoped reaper GC; confirm a docker-down state surfaces a docker-specific error and does NOT trip the generic PTY-exit breaker.

## 10. Open decisions for the user

1. Credential + blast-radius posture (combined). Convenient default bind-mounts host `~/.claude` etc. RW AND an arbitrary host workspace RW into a network-enabled container, so container-run agent code can read/modify those host trees and reach the network at the same time. Recommended: convenient default plus a per-host SEALED opt-in (`mountCredentials:false` + `network:none`) for untrusted work. Please confirm you accept the combined arbitrary-workspace-plus-egress-plus-host-creds posture for the default profile (it is still a net improvement over today's on-host skip-permissions execution).
2. Base image ownership, registry, and freshness. The `codeman/agent:base` placeholder implies a Docker Hub org the project may not own. Pick the real registry/namespace (GHCR under the repo is the natural fit), decide digest pinning, and set a REBUILD CADENCE so agents are not stuck on a stale baked `claude` (the in-container version probe surfaces staleness, but something must trigger rebuilds). Choose: pull a pinned published image, build locally on first use via `scripts/build-agent-image.mjs`, or both.
3. Container CWD strategy. Mirror the host workspace path inside the container (recommended: makes transcript projHash correlate, file features and resume capture work) vs a fixed `/workspace` (simpler mount, breaks watcher correlation). Please confirm the mirror approach.
4. Hooks in the MVP AND workspace scaffolding. Making docker hooks fire requires WRITING `.claude/settings.local.json` (and the CLAUDE.md scaffold) into the user's REAL linked host directory, a behavioral shift from "link a dir" to "link and scaffold a dir." Choose: wire hooks + scaffolding now (Phase 5, recommended, and it also enables the model picker), or ship docker as explicitly hook-degraded (no permission prompts / hook-idle) for v1 and add later. Confirm you are OK with Codeman mutating the linked host workspace.
5. Session-kill teardown and RESUME (reframed honestly). `docker stop` on session kill is not merely "free RAM vs instant reattach": it destroys the in-container live agent, and the conversation survives ONLY because the next launch runs `--resume` from the bind-mounted transcript. Choose: keep the container running (costs RAM, preserves the exact live in-flight agent) vs stop and rely on `--resume` (frees RAM, may lose uncommitted in-flight tool state). Case-delete always `docker rm -f`.
6. Rootless enforcement posture. Under rootless without cgroup-v2 systemd delegation, `--memory`/`--cpus`/`--pids-limit` are SILENTLY ignored. Choose: REQUIRE delegation (refuse to link a host that cannot enforce caps) or ship-with-warning ("resource caps are advisory on your engine"). The probe reports `capsEnforced` either way.
7. Default resume behavior. Should a re-linked or re-run docker case default to resuming its last conversation (`resumeOnStart:true`, using `DockerCase.lastClaudeSessionId`) rather than starting clean? This is the crux of making the durability story real and is the recommended default, but it changes user-visible behavior (a new session in an existing case continues the prior conversation).
8. Export defaults and disk budget. Default export button: workspace-only (fast, small, files-only, recommended for 24h+ runs) vs full-image (reproducible env, multi-GB). Also set the retention cap (max retained exports), the auto-prune policy, and the free-space threshold below which export is refused (a full `/var/lib/docker` breaks EVERY session on the host, not just docker ones).
9. Remote docker daemon (`-H ssh://...` / `--context`). Support in the MVP (composes with remote hosts, adds host-root trust surface) or local-daemon-only first.
10. Podman parity depth. Full `--userns=keep-id` plus Quadlet boot-persistence, or Docker-first with Podman as best-effort and boot-persistence via Codeman's idempotent create-if-missing only. Note the podman host alias is `host.containers.internal`, already handled per engine.
