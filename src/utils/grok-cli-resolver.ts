/**
 * @fileoverview Resolve the Grok Build CLI (`grok`, xAI) binary across common install paths.
 *
 * `grok` has a known npm squatter (`@vibe-kit/grok-cli` also installs a `grok` bin), so a
 * `which grok` hit is not by itself evidence that xAI's coding agent is installed — same
 * shape as `pi`. See `createVersionGatedResolver()` in cli-resolver.ts, which this is now a
 * thin wrapper over — the walking logic is shared with the pattern's home, but this stays
 * its own module for the same reason as the sibling resolvers (see claude-cli-resolver.ts).
 *
 * @module utils/grok-cli-resolver
 */

import { createVersionGatedResolver } from './cli-resolver.js';
import { getCli } from '../config/cli-registry/registry.js';

/**
 * A real `grok --version` prints `grok 1.0.5 (5115b46bc9)`.
 *
 * Exported and SHARED with the `grok` entry in the CLI registry's stock catalog, so
 * `codeman doctor` and the run mode cannot disagree about what counts as an installed
 * grok. Shape is dictated by the doctor's `extractVersion()`, which returns the first
 * CAPTURE GROUP and scans the whole output: hence a capturing group, and a leading
 * boundary instead of `^`. No `g` flag, so there is no shared `lastIndex` to reset.
 */
export const GROK_VERSION_REGEX = /(?:^|\s)(\d+\.\d+\.\d+)/;

function entry() {
  const e = getCli('grok');
  if (!e) throw new Error('grok is not registered in the CLI registry');
  return e;
}

const resolver = createVersionGatedResolver(
  entry().discovery.binaries,
  entry().discovery.searchDirs,
  entry().discovery.version ?? { arg: '--version', regex: GROK_VERSION_REGEX.source },
  'GrokResolver'
);

/**
 * Finds the directory containing a verified `grok` binary.
 * Checks `which grok` first, then falls back to common install locations. Every
 * candidate must pass the `grok --version` sanity probe before it is accepted.
 *
 * @returns Directory path, or null if not found
 */
export function resolveGrokDir(): string | null {
  return resolver.resolveDir();
}

/**
 * Check if the Grok CLI is available on the system.
 */
export function isGrokAvailable(): boolean {
  return resolver.isAvailable();
}

/**
 * Version reported by the resolved `grok` binary, or null when grok is unavailable
 * (or when the probe was skipped, i.e. under vitest). Surfaced through
 * `GET /api/cli/grok/status` so a misresolution is diagnosable from the UI.
 */
export function getGrokCliVersion(): string | null {
  return resolver.getVersion();
}
