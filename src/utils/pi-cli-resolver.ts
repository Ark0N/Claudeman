/**
 * @fileoverview Resolve the Pi CLI (`pi`) binary across common install paths.
 *
 * Mirrors antigravity-cli-resolver.ts, with one addition the other external-CLI
 * resolvers do not need: `pi` is a SHORT, GENERIC name (Raspberry Pi tooling,
 * personal scripts, `$PATH` accidents), so a `which pi` hit is not by itself
 * evidence that the coding agent is installed. Every candidate is therefore
 * sanity-probed with `pi --version` and required to print a semver-shaped
 * string; a binary that fails the probe is treated as absent and the rejected
 * path is logged so a misresolution is diagnosable.
 *
 * Pi ships as the npm package `@earendil-works/pi-coding-agent`, so the search
 * dirs are the usual global-bin locations (npm/bun/manual installs).
 *
 * @module utils/pi-cli-resolver
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Common directories where the Pi CLI binary may be installed */
const PI_SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/usr/local/bin',
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), 'bin'),
];

/**
 * A real `pi --version` prints a semver-shaped string (e.g. `0.84.1`).
 *
 * Exported and SHARED with the `pi` entry in `config/dependency-registry.ts`, so
 * `codeman doctor` and the run mode cannot disagree about what counts as an installed
 * pi: two copies of this rule would let the Dependencies panel report "Pi CLI ✓" on a
 * box where `resolvePiDir()` rejects the same binary and Run Pi stays hidden.
 *
 * Shape is dictated by the doctor's `extractVersion()`, which returns the first CAPTURE
 * GROUP and scans the whole output: hence a capturing group, and a leading boundary
 * instead of `^` so `pi 0.84.1` matches while `v0.84.1` (some other program) does not.
 * No `g` flag, so there is no shared `lastIndex` to reset.
 */
export const PI_VERSION_REGEX = /(?:^|\s)(\d+\.\d+\.\d+)/;

/** Cached directory containing the pi binary (empty string = searched but not found) */
let _piDir: string | null = null;
/** Cached version string reported by the resolved binary (empty string = probed, unusable) */
let _piVersion: string | null = null;

/**
 * Run `pi --version` on a candidate path and return the trimmed version when it
 * looks like the coding agent. Returns null for anything else — a missing
 * binary, a non-zero exit, a hang (timeout), or output that is not semver-shaped
 * (which is how an unrelated `pi` on PATH gets rejected).
 *
 * Never runs under vitest: the suites must stay hermetic and must not depend on
 * whether the dev box happens to have pi installed.
 */
function probePiVersion(binPath: string): string | null {
  if (process.env.VITEST) return null;
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Upstream prints a bare version today; tolerate a `pi 0.84.1` style prefix too.
    const candidate = PI_VERSION_REGEX.exec(out)?.[1];
    if (candidate) return candidate;
    console.warn(`[PiResolver] Ignoring ${binPath}: "pi --version" printed ${JSON.stringify(out.slice(0, 80))}`);
  } catch (err) {
    console.warn(`[PiResolver] Ignoring ${binPath}: "pi --version" failed (${(err as Error).message})`);
  }
  return null;
}

/**
 * Finds the directory containing a verified `pi` binary.
 * Checks `which pi` first, then falls back to common install locations. Every
 * candidate must pass the `pi --version` sanity probe (§2.6 of the integration
 * plan) before it is accepted.
 *
 * @returns Directory path, or null if not found
 */
export function resolvePiDir(): string | null {
  if (_piDir !== null) return _piDir || null;

  const accept = (binPath: string): string | null => {
    // Under vitest the probe never runs, so existence alone decides (keeps the
    // suites hermetic and matches how the sibling resolvers behave there).
    if (process.env.VITEST) {
      _piDir = dirname(binPath);
      _piVersion = '';
      return _piDir;
    }
    const version = probePiVersion(binPath);
    if (!version) return null;
    _piDir = dirname(binPath);
    _piVersion = version;
    return _piDir;
  };

  try {
    const result = execSync('which pi', {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (result && existsSync(result)) {
      const dir = accept(result);
      if (dir) return dir;
    }
  } catch {
    // pi not in PATH, will check common locations
  }

  for (const dir of PI_SEARCH_DIRS) {
    const binPath = join(dir, 'pi');
    if (!existsSync(binPath)) continue;
    const accepted = accept(binPath);
    if (accepted) return accepted;
  }

  _piDir = '';
  _piVersion = '';
  return null;
}

/**
 * Check if the Pi CLI is available on the system.
 */
export function isPiAvailable(): boolean {
  return resolvePiDir() !== null;
}

/**
 * Version reported by the resolved `pi` binary, or null when pi is unavailable
 * (or when the probe was skipped, i.e. under vitest). Surfaced through
 * `GET /api/pi/status` so a misresolution is diagnosable from the UI.
 */
export function getPiCliVersion(): string | null {
  resolvePiDir();
  return _piVersion || null;
}
