# Docker Cases

Run a case inside its own container instead of directly on your host: for isolation, for a
reproducible toolchain, and for the ability to pick the whole environment up and move it to
another machine.

A docker case is a **location overlay**, not a run mode. All seven run modes work inside a
container. See [Core Concepts](Core-Concepts).

## One-time setup: the base image

The container needs an image carrying the agent toolchain (node, the CLIs, git, tmux). It
builds itself on first use with progress streamed to the UI, or you can build it ahead of
time:

```bash
node scripts/build-agent-image.mjs --no-cache
```

**Always pass `--no-cache`.** The CLIs are installed in a single `npm install -g` layer, so
a plain rebuild reuses that layer from the cache and the CLIs stay frozen at whatever
versions the image was *first* built with. This has shipped a broken CLI while reporting a
successful build.

A zero exit code proves the layers ran, not that the toolchain works. Verify:

```bash
docker run --rm codeman/agent:base bash -lc \
  'for c in claude codex gemini opencode agy pi; do printf "%-9s " $c; $c --version 2>&1 | head -1; done'
```

The image is secret-free. Credentials are delivered at runtime, never baked in, so exports
never leak them. A full image lands around 1.6GB.

Prerequisite: Docker or Podman with a reachable daemon.

## The quick way

On **Add Case → Create New**, tick **🐳 Run in an isolated Docker container**. That alone is
enough: Codeman creates the case folder, spins up a hardened container with sensible
defaults, and starts the session inside it.

Expanding **Container settings** offers a template:

| Template          | Memory | CPUs | GPUs                                  |
| ----------------- | ------ | ---- | ------------------------------------- |
| Small             | 2 GB   | 1    | none                                  |
| Medium (default)  | 4 GB   | 2    | none                                  |
| Large             | 8 GB   | 4    | none                                  |
| GPU               | 8 GB   | 4    | all (needs the NVIDIA container toolkit) |

Disk is elastic: storage grows as data arrives, bounded only by host disk. Changing any
setting creates a dedicated host profile for that case, so it never mutates the shared
default.

## The full way

**Add Case → Docker** exposes everything:

| Field                | Meaning                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| **Case name**        | As usual.                                                                                        |
| **Workspace path**   | A real host directory, bind-mounted into the container at the **same absolute path**.            |
| **Host ID**          | A reusable profile (image, network, resources). Share one across cases to share settings.        |
| **Network**          | `bridge` (internet on, default), `none` (fully isolated), or a custom bridge.                    |
| **Advanced**         | Memory and CPU caps, host credential seeding, and whether to resume the last conversation on relaunch. |

The same-absolute-path bind mount is what keeps the File Viewer, attachments, and watchers
operating on real host bytes rather than a copy.

## One container per case

Exactly one long-lived container per case, shared by every session in it.

- Killing one session kills only that session's in-container tmux. Siblings keep running and
  the container stays up.
- Reconnecting after a Codeman restart lands back in the same live agent.
- A container stop or a host reboot restarts the container and **resumes the last
  conversation** from the bind-mounted transcript.
- Deleting the case removes the container. The workspace on the host survives.

## Credentials

Your existing host logins work inside the container without logging in again. Credentials
are **seeded**: mounted read-only and copied in once at launch, so in-container CLIs never
write refreshed tokens back to your host credential stores. Onboarding and trust prompts are
pre-answered so no wizard appears.

Turn seeding **off** for a sealed sandbox: no host credentials, and with `network: none`, no
outbound access either. That is the profile for genuinely untrusted work; you log in inside
the container instead.

Bind mounts are excluded from image capture, so exports stay secret-free.

One consequence worth knowing: Pi's credentials are seeded per file rather than as a whole
directory, because that directory also holds sessions, extensions, and installed packages,
which can be gigabytes. So in-container Pi sessions are invisible from the host, and `pi -c`
inside a docker case sees only that container's history.

## Isolation

Every container runs hardened by default:

- `--cap-drop ALL`
- `--security-opt no-new-privileges`
- Non-root, running as your host uid so workspace files stay host-owned
- PID limit, memory cap with swap pinned to it, `--init`
- **Never** `--privileged`, and **never** the docker socket

Rootless engines without cgroup-v2 systemd delegation cannot enforce resource caps; linking
such a host warns that the caps are advisory.

## Configuration drift is refused, not ignored

Editing a docker host's configuration (image, memory, network) after a container exists is
detected on the next launch by comparing a configuration hash against the container's label.
A mismatch **refuses the launch** and offers to recreate rather than silently running with
stale configuration.

Recreating is refused while sessions of that case are live. The workspace and the
conversation both survive it.

## Moving a case to another machine

**Export**, from the Docker tab:

| Option                     | Contents                                                                  |
| -------------------------- | ------------------------------------------------------------------------- |
| **Full image + workspace** | The whole toolchain, installed packages, and files, in one `.tgz`.        |
| **Workspace only**         | Just the project files. Fast and small.                                    |

The container is paused across the capture so image and workspace are consistent, free space
is checked first, and the intermediate image is cleaned up. Exports run in the background
and notify you when the bundle is ready.

**Import** on the other machine: copy the `.tgz` into `~/.codeman/docker-exports/` and
import it into a new case. The manifest and per-member checksums are verified, the workspace
tar is extracted with a traversal guard, and the image is loaded under a **quarantined tag**
so it can never overwrite a local image. The destination supplies its own credentials, so
nothing secret crosses machines.

## Hooks need to reach the server

In-container hooks (permission events, idle and stop notifications) call back to Codeman
over the docker bridge gateway. If Codeman binds **loopback only**, which is the default and
the production configuration, the container cannot reach it and **in-container hooks do not
fire**.

The session still works fully: idle detection falls back to output-based detection through
the exec PTY, and with permission prompts skipped there is nothing to forward anyway.

To enable them:

```bash
CODEMAN_DOCKER_BRIDGE_HOOKS=1
```

Codeman then starts a second listener bound to the docker bridge gateway that serves **only**
the hook endpoints and rejects everything else with a 403. The bridge is host-internal, so
this does not widen your network exposure. Add it to the service unit and restart.

## Limits

- Per-session environment overrides, effort, and per-CLI configuration are **rejected** for
  docker cases, because they do not cross into the container. Configure the container through
  the docker host's per-mode command override instead.
- tmux must exist in the base image. It is a hard prerequisite and is probed when linking a
  host.
- On macOS, Docker Desktop takes a dedicated uid path, and memory caps are subject to the
  VM's own ceiling.

## Read next

- [Core Concepts](Core-Concepts) - why this is an overlay rather than a run mode.
- [Security](Security) - where containers fit in the model.
- [Remote SSH Sessions](Remote-SSH-Sessions) - the other overlay.
- [`docs/docker-cases.md`](https://github.com/Ark0N/Codeman/blob/master/docs/docker-cases.md) - the full reference.
