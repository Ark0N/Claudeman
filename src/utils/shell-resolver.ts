/**
 * @fileoverview Resolve a real, launchable login shell for `mode: 'shell'` sessions.
 *
 * The tmux pane command for a local shell session used to be the literal string
 * `$SHELL`. That string is embedded in the `bash -c "…"` argument of the
 * `respawn-pane` line, which `execSync` hands to `/bin/sh -c` — so `$SHELL` was
 * expanded by the SERVER process's shell (not the pane's), against the SERVER
 * process's env. Containers and system-level systemd units do not set `SHELL`,
 * so the expansion produced an empty string and the pane command ended in a
 * dangling `&&`:
 *
 *   bash -c "cd \"/case\" && ulimit … && export … && "
 *   -> bash: -c: line 1: syntax error: unexpected end of file
 *
 * The pane then died instantly (status 2) while tmux creation itself reported
 * success, which is exactly what issue #208 saw. Resolving the shell HERE, in
 * Node, removes the shell-expansion layer entirely and guarantees a non-empty
 * absolute path.
 *
 * @module utils/shell-resolver
 */

import { accessSync, constants } from 'node:fs';
import { userInfo } from 'node:os';

/** Last-resort shells, in preference order. `/bin/sh` exists on every POSIX host. */
const FALLBACK_SHELLS = ['/bin/bash', '/bin/zsh', '/bin/sh'];

/**
 * Shells that exist and are executable but immediately exit — a service account's
 * passwd entry commonly points at one, which would look identical to the crash
 * this module exists to prevent.
 */
const NON_INTERACTIVE_SHELLS = new Set(['nologin', 'false', 'true', 'sync']);

/**
 * Shells verified to accept BOTH `-i` and `-l`. Deliberately an allowlist, not a
 * blocklist: a shell that rejects an unknown flag exits immediately, which is the
 * dead-pane-on-arrival failure this module exists to prevent (#208). The passwd
 * entry is user data and can name anything — nushell, elvish, and xonsh all take
 * neither flag in this form, so they get a bare launch instead of a dead tab.
 *
 * csh/tcsh are excluded on purpose: tcsh honors `-l` only when it is the ONLY
 * flag, so `-i -l` would silently not be a login shell there anyway.
 */
const LOGIN_FLAG_SHELLS = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh', 'ksh93', 'mksh', 'pdksh', 'fish']);

function isUsableShell(candidate: string): boolean {
  if (!candidate.startsWith('/')) return false;
  const base = candidate.slice(candidate.lastIndexOf('/') + 1);
  if (NON_INTERACTIVE_SHELLS.has(base)) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an absolute path to an interactive shell, preferring the user's own.
 *
 * Order: `$SHELL` -> the passwd entry -> `/bin/bash` -> `/bin/zsh` -> `/bin/sh`.
 * Every candidate must be an absolute path to an executable that is not a
 * nologin-style stub. Always returns a non-empty string.
 */
export function resolveLocalShell(): string {
  const candidates: string[] = [];

  const envShell = process.env.SHELL?.trim();
  if (envShell) candidates.push(envShell);

  try {
    // Throws when the uid has no /etc/passwd entry (common for `--user` containers).
    const passwdShell = userInfo().shell?.trim();
    if (passwdShell) candidates.push(passwdShell);
  } catch {
    /* no passwd entry — fall through to the static fallbacks */
  }

  candidates.push(...FALLBACK_SHELLS);

  for (const candidate of candidates) {
    if (isUsableShell(candidate)) return candidate;
  }

  // Nothing was verifiable (exotic/read-restricted image). /bin/sh is still the
  // best guess and is far better than emitting an empty command.
  return '/bin/sh';
}

/**
 * Flags that make `shellPath` a login shell, or `''` when it takes none we trust.
 *
 * A tmux pane already hands the shell a tty, so it is interactive with or without
 * `-i` (verified: `$-` contains `i` for a bare `/bin/bash` in a pane, which is why
 * `~/.bashrc` has always been sourced). The flag that actually changes anything is
 * `-l`: it makes the pane a LOGIN shell, matching what tmux itself does when it
 * spawns a pane with no `default-command`, and picking up the `/etc/profile` and
 * `/etc/profile.d/*` PATH entries that a systemd-spawned server never sourced.
 *
 * `-i` is kept alongside it because for bash the two select different files —
 * login reads `~/.bash_profile`, interactive-non-login reads `~/.bashrc` — and
 * asking for both is the closest thing to "the shell the user actually gets".
 *
 * Returns a string ready to append to an already-escaped shell path.
 */
export function loginShellArgs(shellPath: string): string {
  const base = shellPath.slice(shellPath.lastIndexOf('/') + 1);
  return LOGIN_FLAG_SHELLS.has(base) ? ' -i -l' : '';
}
