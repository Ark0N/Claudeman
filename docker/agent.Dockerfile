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

# The npm-published agent CLIs. Pinning is left to the rebuild cadence (see
# docs/docker-cases-plan.md, user-decision 2).
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      @google/gemini-cli \
      opencode-ai \
 && npm cache clean --force

# Antigravity (`agy`) is NOT on npm — Google ships a standalone binary through its
# own installer, so it needs its own step. `--dir /usr/local/bin` is load-bearing:
# the installer's default target is `$HOME/.local/bin`, which at build time is
# root's home and would be unreachable by the `agent` user the container runs as.
# ⚠️ This binary is ~190MB on its own; it is the single largest layer in the image.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin \
 && chmod 755 /usr/local/bin/agy \
 && agy --version

# Pi (pi.dev). Upstream documents --ignore-scripts (pi needs no lifecycle scripts);
# kept out of the shared npm block above so the flag cannot silently change how the
# other four CLIs install.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
 && npm cache clean --force \
 && pi --version

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
# the host. (gemini/gcloud/opencode are whole seed-copies and need no pre-created dir;
# Antigravity nests its state inside `.gemini/antigravity-cli`, so it rides that seed.)
# `.pi/agent` IS pre-created: pi is seeded per-FILE (auth/settings/trust/models), and a
# per-file seed copy, unlike a whole-dir one, does not create its parent directory.
RUN useradd -g 0 -m -d /home/agent -s /bin/bash agent \
 && mkdir -p /home/agent/.npm /home/agent/.cache /home/agent/.config /home/agent/.codeman \
      /home/agent/.claude/projects /home/agent/.codex/sessions /home/agent/.pi/agent \
 && chgrp -R 0 /home/agent \
 && chmod -R g=u /home/agent

USER agent
WORKDIR /home/agent

# Codeman overrides the command with `sleep infinity` at create time; this is the
# fallback so a hand-run container also idles rather than exiting.
CMD ["sleep", "infinity"]
