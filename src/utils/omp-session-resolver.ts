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
import { join } from 'node:path';

/** A real OMP session file is `<ISO-ish-timestamp>_<uuid>.jsonl`; only the uuid matters here. */
const OMP_SESSION_FILE_PATTERN = /^.+_([a-zA-Z0-9-]+)\.jsonl$/;

/**
 * Mirrors `omp`'s own directory mangling: every path separator becomes a
 * dash. Pure so it's unit-testable without touching the filesystem.
 */
export function mangleOmpWorkingDir(workingDir: string): string {
  return workingDir.replace(/\//g, '-');
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
