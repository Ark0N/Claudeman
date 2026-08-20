/**
 * @fileoverview Codex CLI binary resolution.
 *
 * Thin wrapper over `cli-resolver.ts`'s generic walker, reading its search
 * parameters from the CLI registry's stock catalog. See claude-cli-resolver.ts's
 * file header for why this stays its own module rather than a bare re-export.
 *
 * @module utils/codex-cli-resolver
 */

import { createDirResolver } from './cli-resolver.js';
import { getCli } from '../config/cli-registry/registry.js';

function entry() {
  const e = getCli('codex');
  if (!e) throw new Error('codex is not registered in the CLI registry');
  return e;
}

const resolver = createDirResolver(entry().discovery.binaries, entry().discovery.searchDirs);

/**
 * Finds the directory containing the `codex` binary.
 * Checks `which codex` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function resolveCodexDir(): string | null {
  return resolver.resolveDir();
}

/**
 * Check if the Codex CLI is available on the system.
 */
export function isCodexAvailable(): boolean {
  return resolver.isAvailable();
}
