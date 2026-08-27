/**
 * @fileoverview Resolve the real OMP session id for a working directory, so a
 * relaunch can pass `--resume <id>` instead of the ambiguous `--continue`.
 *
 * `omp` persists each conversation as its own file under
 * `~/.omp/agent/sessions/<mangled-workingDir>/<ISO-timestamp>_<session-uuid>.jsonl`
 * (workingDir mangled the same way Claude Code mangles `~/.claude/projects/*`:
 * every `/` replaced with `-`). `--continue` picks whichever file in that
 * directory is newest, which silently drifts to the WRONG conversation the
 * moment two Codeman sessions ever touch the same directory — exactly what a
 * closed-then-resumed row plus a still-running duplicate produces. Resolving
 * the id once and pinning it with `--resume` removes that ambiguity for every
 * later relaunch of the same Codeman session.
 *
 * @module utils/omp-session-resolver
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/** A real OMP session file is `<ISO-ish-timestamp>_<uuid>.jsonl`; only the uuid matters here. */
const OMP_SESSION_FILE_PATTERN = /^.+_([a-zA-Z0-9-]+)\.jsonl$/;

/**
 * Mirrors `omp`'s own directory mangling. Confirmed empirically against real
 * `~/.omp/agent/sessions/` directory names (2026-08-27): unlike Claude Code's
 * `~/.claude/projects/*`, which keeps the home prefix (`-home-user-dev-foo`),
 * omp collapses a home-relative workingDir to its home-relative remainder
 * FIRST (`/home/user/dev/foo` -> `/dev/foo`) and only then dash-replaces
 * (`-dev-foo`) — a path outside $HOME (e.g. `/tmp/...`) is dash-replaced as-is.
 * Getting this wrong doesn't error, it just silently returns an empty
 * directory listing: findLatestOmpSessionId() below then always falls through
 * to null, so continuation pinning quietly degrades to omp's own ambiguous
 * `--continue` for every case under $HOME (i.e. virtually all real Codeman
 * cases) while appearing to work in `/tmp`-based manual testing.
 * Pure so it's unit-testable without touching the filesystem.
 */
export function mangleOmpWorkingDir(workingDir: string): string {
  // UNVERIFIED EDGE CASE: if $HOME is itself a symlink, this compares against
  // the literal homedir() string, not a realpath()-resolved one. Whether that
  // matches omp's own behavior is unconfirmed — we only empirically verified
  // omp strips a literal $HOME prefix (2026-08-27), not that it canonicalizes
  // symlinks first. Do not "fix" this with realpathSync() without confirming
  // omp's actual behavior on a symlinked-home setup; guessing wrong here would
  // trade one silent mismatch for a different one.
  const home = homedir();
  const relative =
    workingDir === home || workingDir.startsWith(home + sep) ? workingDir.slice(home.length) : workingDir;
  return relative.replace(/\//g, '-');
}

/** `~/.omp` — no known env override exists (unlike DSH_HOME); revisit if omp adds one. */
function resolveOmpHome(): string {
  return join(homedir(), '.omp');
}

/**
 * Newest OMP session id for this working directory, or null when the
 * directory doesn't exist yet (never launched) or holds no session files.
 *
 * Deliberately "newest file, full stop" rather than a time-windowed match:
 * callers only invoke this at a moment where that's unambiguous by
 * construction — right after the file that answers it was the only thing
 * that could have just been written (a dead pane's process already exited,
 * or a session being resumed has no live sibling in the same directory yet).
 */
export function findLatestOmpSessionId(workingDir: string): string | null {
  const dir = join(resolveOmpHome(), 'agent', 'sessions', mangleOmpWorkingDir(workingDir));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  let newestMtime = -Infinity;
  let newestId: string | null = null;
  for (const entry of entries) {
    const match = OMP_SESSION_FILE_PATTERN.exec(entry);
    if (!match) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(dir, entry)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > newestMtime) {
      newestMtime = mtimeMs;
      newestId = match[1];
    }
  }
  return newestId;
}
