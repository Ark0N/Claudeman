---
"aicodeman": minor
---

Opt-in multi-user mode (`--multiuser` / `CODEMAN_MULTIUSER=1`, off by default).

Named users with individually scrypt-hashed passwords in `~/.codeman/users.json`, per-user case spaces under `~/codeman-users/<name>/cases`, and full ownership scoping of sessions, cases, cron jobs, search, file previews, and real-time SSE/WS streams. Non-admin users default to Claude's classifier-guarded `--permission-mode auto`; raw shell mode, cron `launchCommand`, and skip-permissions require an explicit per-user `canBypassPermissions` grant. Machine-level resources (remote/Docker hosts, tunnel, self-update, settings) are admin-only. Admin API (`/api/admin/users*`) with one-time passwords, last-admin invariants, and an append-only audit log; self-service `/api/me` + password change; a frontend admin Users tab + change-password modal; and `codeman users add|passwd|list|rm` CLI. Also adds a global `auto` Claude startup permission mode. When off, behavior is byte-identical to single-user.

Note: multi-user mode separates workspaces for a trusted team; it is not a security boundary between users (all sessions share the host OS account). Pair with Docker cases for real isolation.

Fixes a `users.json` corruption race by serializing the store's read-modify-write.
