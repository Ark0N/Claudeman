#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
env_file="$script_dir/.env"
compose_file="$script_dir/docker-compose.yaml"

if [[ ! -f "$env_file" ]]; then
  printf 'Error: Docker environment file is missing: %s\n' "$env_file" >&2
  printf 'Create it from %s/.env.example before starting Codeman.\n' "$script_dir" >&2
  exit 1
fi

compose_command=(docker compose --env-file "$env_file" -f "$compose_file")
appdata_path=$(
  "${compose_command[@]}" config --environment |
    awk -F= '$1 == "CODEMAN_APPDATA_PATH" { sub(/^[^=]*=/, ""); print; exit }'
)
docker_socket=$(
  "${compose_command[@]}" config --environment |
    awk -F= '$1 == "DOCKER_SOCKET" { sub(/^[^=]*=/, ""); print; exit }'
)

if [[ -z "$appdata_path" ]]; then
  printf 'Error: CODEMAN_APPDATA_PATH is not set in %s\n' "$env_file" >&2
  exit 1
fi

if [[ ! -d "$appdata_path" ]]; then
  if [[ "$EUID" == '0' ]]; then
    printf 'Error: Refusing to create CODEMAN_APPDATA_PATH as root: %s\n' "$appdata_path" >&2
    printf 'Create it as the unprivileged account that should run Codeman, then retry.\n' >&2
    exit 1
  fi
  mkdir -p -- "$appdata_path"
fi

if owner_ids=$(stat -c '%u:%g' -- "$appdata_path" 2>/dev/null); then
  :
elif owner_ids=$(stat -f '%u:%g' "$appdata_path" 2>/dev/null); then
  :
else
  printf 'Error: Cannot determine the owner of CODEMAN_APPDATA_PATH: %s\n' "$appdata_path" >&2
  exit 1
fi

export PUID=${owner_ids%%:*}
export PGID=${owner_ids##*:}

if [[ "$PUID" == '0' ]]; then
  printf 'Error: CODEMAN_APPDATA_PATH is owned by root: %s\n' "$appdata_path" >&2
  printf 'Change the directory ownership to the unprivileged account that should run Codeman.\n' >&2
  exit 1
fi

if [[ -z "$docker_socket" || ! -S "$docker_socket" ]]; then
  printf 'Error: DOCKER_SOCKET is not a Unix socket: %s\n' "${docker_socket:-<unset>}" >&2
  exit 1
fi

if socket_ids=$(stat -c '%u:%g' -- "$docker_socket" 2>/dev/null); then
  :
elif socket_ids=$(stat -f '%u:%g' "$docker_socket" 2>/dev/null); then
  :
else
  printf 'Error: Cannot determine the owner of DOCKER_SOCKET: %s\n' "$docker_socket" >&2
  exit 1
fi

export DOCKER_SOCKET_GID=${socket_ids##*:}

exec docker compose --env-file "$env_file" -f "$compose_file" up --build -d
