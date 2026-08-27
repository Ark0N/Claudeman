# syntax=docker/dockerfile:1

# Build the application from the checkout supplied as the Docker build context.
# No published Codeman application image is required.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/codeman

COPY . .

RUN npm ci \
 && npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm cache clean --force

# The Docker CLI talks to the host daemon through the socket mounted by
# docker/docker-compose.yaml. It does not run a Docker daemon in this container.
FROM node:22-bookworm-slim

ARG CODEMAN_RUNTIME_USER=opencode
ARG PUID=1000
ARG PGID=1000

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      docker.io \
      git \
      openssh-client \
      procps \
      ripgrep \
      tmux \
 && rm -rf /var/lib/apt/lists/*

# Keep credentials out of the image. Users authenticate these CLIs at runtime
# through Codeman sessions, and the configured host bind mount retains state.
RUN npm install --global \
      @anthropic-ai/claude-code \
      @google/gemini-cli \
      @openai/codex \
      opencode-ai \
 && npm cache clean --force

# Keep the web server and every local Codeman session unprivileged. PUID and
# PGID match the host-owned application-data directory mounted by Compose. The
# requested GID may not exist in the base image, and a host UID such as 1000 may
# already belong to the baked `node` account, so handle both cases explicitly.
RUN set -eux; \
    case "${PUID}" in ''|*[!0-9]*) echo "PUID must be numeric" >&2; exit 1;; esac; \
    case "${PGID}" in ''|*[!0-9]*) echo "PGID must be numeric" >&2; exit 1;; esac; \
    if [ "${PUID}" -eq 0 ]; then \
      echo "PUID must identify an unprivileged account, not root" >&2; \
      exit 1; \
    fi; \
    if ! getent group "${PGID}" >/dev/null; then \
      groupadd --gid "${PGID}" codeman-runtime; \
    fi; \
    existing_user="$(getent passwd "${PUID}" | cut -d: -f1 || true)"; \
    if [ -n "${existing_user}" ]; then \
      usermod \
        --login "${CODEMAN_RUNTIME_USER}" \
        --gid "${PGID}" \
        --home "/home/${CODEMAN_RUNTIME_USER}" \
        --move-home \
        --shell /bin/bash \
        "${existing_user}"; \
    else \
      useradd \
        --uid "${PUID}" \
        --gid "${PGID}" \
        --create-home \
        --home-dir "/home/${CODEMAN_RUNTIME_USER}" \
        --shell /bin/bash \
        "${CODEMAN_RUNTIME_USER}"; \
    fi

WORKDIR /opt/codeman

COPY --from=build /opt/codeman /opt/codeman

ENV CODEMAN_PORT=3000 \
    HOME=/home/${CODEMAN_RUNTIME_USER} \
    NODE_ENV=production

EXPOSE 3000

USER ${CODEMAN_RUNTIME_USER}

CMD ["node", "dist/index.js", "web"]
