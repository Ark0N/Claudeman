/**
 * @fileoverview Resolve the Pi CLI (`pi`) binary across common install paths.
 *
 * `pi` is a SHORT, GENERIC name (Raspberry Pi tooling, personal scripts, `$PATH`
 * accidents), so a `which pi` hit is not by itself evidence that the coding agent is
 * installed. Every candidate is therefore sanity-probed with `pi --version` and
 * required to print a semver-shaped string; a binary that fails the probe is treated
 * as absent and the rejected path is logged so a misresolution is diagnosable. See
 * `createVersionGatedResolver()` in cli-resolver.ts, which this is now a thin wrapper
 * over — the walking logic is shared with the pattern's home, but this stays its own
 * module for the same reason as the sibling resolvers (see claude-cli-resolver.ts).
 *
 * @module utils/pi-cli-resolver
 */

import { createVersionGatedResolver } from './cli-resolver.js';
import { getCli } from '../config/cli-registry/registry.js';

/**
 * A real `pi --version` prints a semver-shaped string (e.g. `0.84.1`).
 *
 * Exported and SHARED with the `pi` entry in the CLI registry's stock catalog, so
 * `codeman doctor` and the run mode cannot disagree about what counts as an installed
 * pi. Shape is dictated by the doctor's `extractVersion()`, which returns the first
 * CAPTURE GROUP and scans the whole output: hence a capturing group, and a leading
 * boundary instead of `^` so `pi 0.84.1` matches while `v0.84.1` (some other program)
 * does not. No `g` flag, so there is no shared `lastIndex` to reset.
 */
export const PI_VERSION_REGEX = /(?:^|\s)(\d+\.\d+\.\d+)/;

function entry() {
  const e = getCli('pi');
  if (!e) throw new Error('pi is not registered in the CLI registry');
  return e;
}

const resolver = createVersionGatedResolver(
  entry().discovery.binaries,
  entry().discovery.searchDirs,
  entry().discovery.version ?? { arg: '--version', regex: PI_VERSION_REGEX.source },
  'PiResolver'
);

/**
 * Finds the directory containing a verified `pi` binary.
 * Checks `which pi` first, then falls back to common install locations. Every
 * candidate must pass the `pi --version` sanity probe before it is accepted.
 *
 * @returns Directory path, or null if not found
 */
export function resolvePiDir(): string | null {
  return resolver.resolveDir();
}

/**
 * Check if the Pi CLI is available on the system.
 */
export function isPiAvailable(): boolean {
  return resolver.isAvailable();
}

/**
 * Version reported by the resolved `pi` binary, or null when pi is unavailable
 * (or when the probe was skipped, i.e. under vitest). Surfaced through
 * `GET /api/pi/status` so a misresolution is diagnosable from the UI.
 */
export function getPiCliVersion(): string | null {
  return resolver.getVersion();
}
