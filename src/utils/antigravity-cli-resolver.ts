/**
 * @fileoverview Antigravity CLI binary resolution.
 *
 * The binary is `agy`, not `antigravity` — the registry's `discovery.binaries`
 * carries that split so nothing here (or anywhere else) has to know it by name.
 * Thin wrapper over `cli-resolver.ts`'s generic walker; see claude-cli-resolver.ts's
 * file header for why this stays its own module rather than a bare re-export.
 *
 * @module utils/antigravity-cli-resolver
 */

import { createDirResolver } from './cli-resolver.js';
import { getCli } from '../config/cli-registry/registry.js';

function entry() {
  const e = getCli('antigravity');
  if (!e) throw new Error('antigravity is not registered in the CLI registry');
  return e;
}

const resolver = createDirResolver(entry().discovery.binaries, entry().discovery.searchDirs);

/**
 * Finds the directory containing the `agy` binary.
 * Checks `which agy` first, then falls back to common install locations.
 *
 * @returns Directory path, or null if not found
 */
export function resolveAntigravityDir(): string | null {
  return resolver.resolveDir();
}

/**
 * Check if the Antigravity CLI is available on the system.
 */
export function isAntigravityAvailable(): boolean {
  return resolver.isAvailable();
}
