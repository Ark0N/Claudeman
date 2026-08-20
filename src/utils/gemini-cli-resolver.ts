/**
 * @fileoverview Gemini CLI binary resolution.
 *
 * Thin wrapper over `cli-resolver.ts`'s generic walker, reading its search
 * parameters from the CLI registry's stock catalog. See claude-cli-resolver.ts's
 * file header for why this stays its own module rather than a bare re-export.
 *
 * @module utils/gemini-cli-resolver
 */

import { createDirResolver } from './cli-resolver.js';
import { getCli } from '../config/cli-registry/registry.js';

function entry() {
  const e = getCli('gemini');
  if (!e) throw new Error('gemini is not registered in the CLI registry');
  return e;
}

const resolver = createDirResolver(entry().discovery.binaries, entry().discovery.searchDirs);

/**
 * Finds the directory containing the `gemini` binary.
 * Checks `which gemini` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function resolveGeminiDir(): string | null {
  return resolver.resolveDir();
}

/**
 * Check if the Gemini CLI is available on the system.
 */
export function isGeminiAvailable(): boolean {
  return resolver.isAvailable();
}
