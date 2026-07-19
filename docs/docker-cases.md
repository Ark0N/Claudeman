# Docker cases

Run a case inside an **isolated Docker container** instead of directly on the host. Any number of Codeman sessions can share one container (it is scoped to the case, not the session), so a whole project lives in a sandbox with its own network, resource caps, and filesystem, and you can **export the container to move it to another machine**.

Docker mode is a **location overlay on cases**, the direct analog of [remote SSH cases](./remote-hosts.md): where a remote case runs a local tmux pane doing `ssh host` into a durable remote tmux server, a docker case runs a local tmux pane doing `docker exec -it` into a durable **in-container** tmux server. It is not a separate `SessionMode`, so `claude` / `shell` / `opencode` / `codex` / `gemini` all work inside the container.

## One-time setup: build the base image

The container needs a base image with the agent toolchain (node, the CLIs, git, tmux). Build it locally once:

```bash
node scripts/build-agent-image.mjs          # builds codeman/agent:base
# options: --engine docker|podman  --image <ref>  --no-cache
```

The image is **secret-free**: credentials are delivered at runtime (bind mounts or `docker exec --env`), never baked in, so exports never leak them.

## Create a docker case

App → **New case → Docker** tab:

- **Case Name** / **Workspace Path**: the workspace is a real HOST directory bind-mounted into the container at the same path. Codeman scaffolds `CLAUDE.md` + `.claude/settings.local.json` (hooks) into it, and file previews / attachments work on the real bytes.
- **Host ID**: a reusable docker host profile (image, network, resources). Reuse the same ID across cases to share settings.
- **Network**: `bridge` (internet on, default), `none` (fully isolated), or a `custom` bridge.
- **Advanced**: memory / CPU caps, **Mount host credentials** (on = your existing `~/.claude` login just works; off = a sealed sandbox you log into inside the container), **Resume last conversation on relaunch**.

Then run it like any case (Run Claude / Run Shell / …). The first launch creates the container (`codeman-case-<name>`); subsequent sessions attach to the same one.

Equivalent API:

```bash
curl -X POST localhost:3000/api/docker-hosts -d '{"id":"local","label":"Local","image":"codeman/agent:base"}'
curl -X POST localhost:3000/api/cases/docker-link -d '{"name":"sandbox","hostId":"local","hostWorkspacePath":"/home/you/projects/sandbox"}'
curl -X POST localhost:3000/api/quick-start -d '{"caseName":"sandbox","mode":"claude"}'
```

## Lifecycle

- **Reconnect after a Codeman restart** lands back in the same live agent (the in-container tmux survives).
- **Container stop / host reboot** recreates the container and, when a resume id was captured, **resumes** the last conversation from the bind-mounted transcript.
- **Killing one session** only kills that session's in-container tmux session; the shared container stays up for sibling sessions.
- **Deleting the case** `docker rm -f`s the container (the bind-mounted workspace on the host survives). An instance-scoped boot reaper removes containers whose case is gone.

## Isolation & security

Every container runs hardened: `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root (`--user <hostUid>:0` so workspace files stay host-owned), `--pids-limit`, `--memory` == `--memory-swap`, `--init`. Never `--privileged`, never the docker socket. The default **convenient** profile bind-mounts host credential dirs read-write so the common login just works (creds stay on the host, never captured by `docker commit`); the **sealed** profile (`mountCredentials:false` + `network:none`) is the opt-in for genuinely untrusted work.

Rootless engines without cgroup-v2 systemd delegation cannot enforce resource caps; linking such a host warns that caps are advisory.

## Export / Import (move to another machine)

**Export** (from the Docker tab, or `POST /api/docker-cases/:name/export`): choose

- **Full image + workspace**: `docker commit` the container to an image, `docker save` it, tar the workspace, and a manifest, all into one portable `<case>-<ts>.codeman-container.tgz` (the whole toolchain, installed packages, and files). Runs in the background; you are notified when the bundle is ready.
- **Workspace only**: just the project files (fast, small).

The container is paused across the capture so the image and workspace are consistent; a full `/var/lib/docker` is guarded against with a free-space precheck; the intermediate image is always cleaned up.

**Import** (`POST /api/docker-cases/import`, or the Manage tab): copy the `.tgz` onto the new machine's `~/.codeman/docker-exports/`, then import it into a new case. The manifest and per-member SHA-256 checksums are validated, the workspace tar is extracted with a path-traversal guard, and the image is `docker load`ed and **re-tagged into a quarantined namespace** (`codeman/imported-<case>:<ts>`) so it never overwrites a local tag. The destination supplies its own credentials, so nothing secret crosses machines.

`GET /api/docker-exports` lists bundles; `GET /api/docker-exports/:filename` downloads one; `DELETE` removes one.

## Notes & limits

- Requires Docker (or Podman) with a reachable daemon; tmux must be present in the base image (a hard prerequisite, probed at link time).
- Per-session `envOverrides` / `effort` / per-CLI config are rejected for docker cases (they do not cross into the container); configure the container via the docker host's per-mode command override instead.
- macOS Docker Desktop takes a dedicated uid path (the baked image uid; memory caps are subject to the VM ceiling).

Design + rationale: [`docker-cases-plan.md`](./docker-cases-plan.md).
