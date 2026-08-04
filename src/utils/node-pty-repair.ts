/**
 * @fileoverview Runtime self-heal for node-pty's macOS `spawn-helper`.
 *
 * node-pty@1.1.0 ships its macOS prebuilt helper as
 * `prebuilds/darwin-<arch>/spawn-helper` with mode 0644 (no execute bit). On
 * macOS every PTY is launched through that helper via posix_spawnp, so a
 * non-executable helper turns every session start into
 * `Error: posix_spawnp failed.` (issues #6 and #204). The bug is macOS-only:
 * `spawn-helper` is an `OS=="mac"` gyp target and pty.cc only spawns it under
 * `#if defined(__APPLE__)`, and node-pty ships no Linux prebuild, so Linux always
 * compiles a correctly-permissioned helper from source.
 *
 * `scripts/fix-node-pty.mjs` fixes this at install time. This module is the
 * safety net for installs that are already broken: the first PTY spawn that
 * fails this way is repaired and retried in-process, so the user never sees a
 * dead session. If the retry still fails, the thrown error carries the manual
 * repair command instead of a bare "posix_spawnp failed".
 *
 * @module utils/node-pty-repair
 */

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** The one-line fix appended to errors we could not repair automatically. */
export const SPAWN_HELPER_FIX_HINT =
  'node-pty cannot execute its spawn-helper. Repair it with: npm run fix:node-pty ' +
  '(or: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper)';

/** Set once a repair has been attempted, so a genuinely broken install cannot chmod-storm. */
let repairAttempted = false;

/**
 * True when an error is node-pty failing to launch its spawn-helper.
 *
 * The native throw site is `throw Napi::Error::New(napiEnv, "posix_spawnp failed.")`
 * in pty.cc, reached only on Apple platforms.
 */
export function isSpawnHelperFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /posix_spawnp|spawn-helper/i.test(message);
}

/** Locates the installed node-pty package root, or null when it can't be resolved. */
export function findNodePtyDir(): string | null {
  // node-pty declares no "exports" map, so the package.json subpath resolves and
  // lands on the package root. require.resolve('node-pty') would return
  // <pkg>/lib/index.js, one level deeper than callers need.
  try {
    return dirname(require.resolve('node-pty/package.json'));
  } catch {
    /* fall through */
  }
  try {
    return join(dirname(require.resolve('node-pty')), '..');
  } catch {
    return null;
  }
}

/**
 * Lists every `spawn-helper` present in a node-pty install.
 *
 * node-pty's loader checks `build/Release`, `build/Debug`, then
 * `prebuilds/<platform>-<arch>`, and takes the helper from whichever directory
 * the native module loaded out of, so every copy has to be executable, not just
 * the one this machine happens to use.
 */
export function listSpawnHelpers(ptyDir: string): string[] {
  const dirs = [join(ptyDir, 'build', 'Release'), join(ptyDir, 'build', 'Debug')];

  const prebuilds = join(ptyDir, 'prebuilds');
  if (existsSync(prebuilds)) {
    try {
      for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(prebuilds, entry.name));
      }
    } catch {
      /* unreadable prebuilds dir: nothing to repair there */
    }
  }

  return dirs.map((d) => join(d, 'spawn-helper')).filter((p) => existsSync(p));
}

/**
 * Adds the execute bit to every `spawn-helper` missing it.
 *
 * @param ptyDir - node-pty package root; resolved automatically when omitted.
 * @returns Paths actually changed (empty when nothing needed repair, or node-pty
 *   is missing, or the files are not writable).
 */
export function repairSpawnHelperPermissions(ptyDir?: string): string[] {
  const dir = ptyDir ?? findNodePtyDir();
  if (!dir) return [];

  const repaired: string[] = [];
  for (const helper of listSpawnHelpers(dir)) {
    try {
      const mode = statSync(helper).mode & 0o777;
      if ((mode & 0o111) === 0o111) continue;
      chmodSync(helper, mode | 0o755);
      repaired.push(helper);
    } catch {
      // Read-only install (or not ours to chmod): fall through to the hint.
    }
  }
  return repaired;
}

/** Wraps an error so the message carries the actionable repair command. */
function withFixHint(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${message}. ${SPAWN_HELPER_FIX_HINT}`, { cause: err });
}

/**
 * Runs a `pty.spawn()` call, repairing a non-executable spawn-helper and
 * retrying once if that is why it failed.
 *
 * Any unrelated spawn error is rethrown untouched, so this stays invisible on
 * every platform but a broken macOS install.
 *
 * @param spawn - The `pty.spawn(...)` call to run.
 * @param ptyDir - node-pty package root; resolved automatically when omitted.
 */
export function spawnPtyWithHelperRepair<T>(spawn: () => T, ptyDir?: string): T {
  try {
    return spawn();
  } catch (err) {
    if (!isSpawnHelperFailure(err)) throw err;
    if (repairAttempted) throw withFixHint(err);

    repairAttempted = true;
    const repaired = repairSpawnHelperPermissions(ptyDir);
    if (repaired.length === 0) throw withFixHint(err);

    console.warn(`[node-pty] spawn-helper was not executable, repaired ${repaired.join(', ')} and retrying`);
    try {
      return spawn();
    } catch (retryErr) {
      throw withFixHint(retryErr);
    }
  }
}

/** Test seam: forget that a repair was already attempted in this process. */
export function resetSpawnHelperRepairState(): void {
  repairAttempted = false;
}
