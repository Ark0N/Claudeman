# Codeman agent base image (built locally by scripts/build-agent-image.mjs).
#
# Contains the agent toolchain (node + the CLIs + git/tmux/ripgrep) but NO
# secrets: credentials are delivered at RUNTIME via bind mounts (~/.claude etc.)
# or name-only `docker exec --env`, never baked in, so `docker save` exports stay
# secret-free. tmux is a HARD prerequisite (the in-container tmux is what makes a
# reconnect durable), so it is installed here and probed before launch.
#
# HOME is made writable by an ARBITRARY host uid via the OpenShift "gid 0,
# group-writable" convention: on Linux we run `--user <hostUid>:0`, so the agent
# uid is the host uid (workspace files stay host-owned) while gid 0 keeps $HOME
# writable even though the uid is not the baked 1000.
FROM node:22-bookworm-slim

# Base toolchain. `curl` is needed for the hook callbacks (`curl -sk $CODEMAN_API_URL`),
# `procps` for `ps`, `tmux` for the durable in-container session.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      tmux \
      ripgrep \
      curl \
      ca-certificates \
      less \
      procps \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

# The agent CLIs (all four backends Codeman supports). Pinning is left to the
# rebuild cadence (see docs/docker-cases-plan.md, user-decision 2).
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      @google/gemini-cli \
      opencode-ai \
 && npm cache clean --force

# `agent` user (gid 0) with an arbitrary-uid-writable HOME. The uid is
# auto-assigned (node:22-slim already occupies uid 1000 with its `node` user); at
# runtime Codeman overrides with `--user <hostUid>:0` on Linux, so the baked uid
# only matters for a hand-run / Docker Desktop container. gid 0 + group-writable
# HOME (OpenShift arbitrary-uid convention) keeps $HOME writable for any uid.
# UTF-8 locale so tmux/Ink render Unicode box-drawing instead of VT100 ACS `q`
# glyphs (C.UTF-8 is built into glibc; no locales package needed). Codeman also
# sets these at run time so containers built before this line still get UTF-8.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
ENV HOME=/home/agent
# `.claude` (+ `.claude/projects` mount point) and `.codex` (+ `.codex/sessions`) are
# pre-created gid-0 group-writable so the container owns its OWN credential config
# dirs: tokens/settings/config are seeded in as writable copies and each CLI's runtime
# state (backups, tasks, refreshed tokens) stays container-local, while ONLY the shared
# transcript/rollout dirs (`.claude/projects`, `.codex/sessions`) are bind-mounted from
# the host. (gemini/gcloud/opencode are whole seed-copies and need no pre-created dir.)
RUN useradd -g 0 -m -d /home/agent -s /bin/bash agent \
 && mkdir -p /home/agent/.npm /home/agent/.cache /home/agent/.config /home/agent/.codeman \
      /home/agent/.claude/projects /home/agent/.codex/sessions \
 && chgrp -R 0 /home/agent \
 && chmod -R g=u /home/agent

USER agent
WORKDIR /home/agent

# Codeman overrides the command with `sleep infinity` at create time; this is the
# fallback so a hand-run container also idles rather than exiting.
CMD ["sleep", "infinity"]
