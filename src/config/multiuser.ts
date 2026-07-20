/**
 * @fileoverview Multi-user mode gating + limits (opt-in, off by default).
 *
 * Multi-user mode is enabled by `codeman web --multiuser` (which sets
 * `CODEMAN_MULTIUSER=1`) or the env var directly. When OFF, behavior is
 * byte-identical to today: `users.json` is never read and all ownership scoping
 * is bypassed. Everything here is per-instance like the rest of Codeman: a beta
 * instance (`CODEMAN_INSTANCE=beta`) has its own `users.json` via `dataPath()`,
 * and its user spaces live under the same shared `~/codeman-users` as prod (like
 * `~/codeman-cases`), unless `CODEMAN_USER_SPACES_DIR` overrides it.
 *
 * See `docs/multi-user-plan.md` sections 3, 4.2, and 11.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_CONCURRENT_SESSIONS } from './map-limits.js';

/**
 * Whether multi-user mode is active. Read from the environment each call so it is
 * stable for the process lifetime (env does not change after boot) and trivially
 * overridable in tests. Accepts `1` or `true`.
 */
export function isMultiUserMode(): boolean {
  const v = process.env.CODEMAN_MULTIUSER;
  return v === '1' || v === 'true';
}

/**
 * Root of per-user spaces: `~/codeman-users` (sibling of `~/codeman-cases`).
 * Overridable via `CODEMAN_USER_SPACES_DIR` (used by tests). Resolved lazily so a
 * test can point it at a temp dir before the first call.
 */
export function getUserSpacesDir(): string {
  return process.env.CODEMAN_USER_SPACES_DIR || join(homedir(), 'codeman-users');
}

/** Absolute path to a user's top-level space: `<USER_SPACES_DIR>/<username>[/segments]`. */
export function userSpacePath(username: string, ...segments: string[]): string {
  return join(getUserSpacesDir(), username, ...segments);
}

/** Absolute path to a user's cases dir: `<USER_SPACES_DIR>/<username>/cases`. */
export function userCasesDir(username: string): string {
  return join(getUserSpacesDir(), username, 'cases');
}

/** Maximum number of user accounts (default 25, env `CODEMAN_MAX_USERS`). */
export function maxUsers(): number {
  const n = Number(process.env.CODEMAN_MAX_USERS);
  return Number.isInteger(n) && n > 0 ? n : 25;
}

/**
 * Per-user concurrent-session cap (the fairness lever). Defaults to half the
 * global cap; overridable via `CODEMAN_MAX_SESSIONS_PER_USER`. The global cap
 * (MAX_CONCURRENT_SESSIONS) still applies on top and is shared across users.
 */
export function maxSessionsPerUser(): number {
  const n = Number(process.env.CODEMAN_MAX_SESSIONS_PER_USER);
  if (Number.isInteger(n) && n > 0) return n;
  return Math.max(1, Math.floor(MAX_CONCURRENT_SESSIONS / 2));
}
