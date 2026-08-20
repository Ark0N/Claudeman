/**
 * @fileoverview Resolve the Antigravity CLI (`agy`) binary across common install paths.
 *
 * Mirrors gemini-cli-resolver.ts. Google's installer (antigravity.google/cli/install.sh)
 * places the binary at ~/.local/bin/agy; the other locations cover manual installs.
 *
 * @module utils/antigravity-cli-resolver
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  createCliExecutableResolver,
  formatCliNotFoundMessage,
  type CliResolverHost,
} from './cli-executable-resolver.js';

/** Common directories where the Antigravity CLI binary may be installed */
const ANTIGRAVITY_SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.antigravity', 'bin'),
  '/usr/local/bin',
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), 'bin'),
];

const ANTIGRAVITY_NOT_FOUND =
  'Antigravity CLI not found. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash';

function createAntigravityResolver(host?: CliResolverHost) {
  return createCliExecutableResolver({ binary: 'agy', searchDirs: ANTIGRAVITY_SEARCH_DIRS }, host);
}

/** Creates an isolated Antigravity wrapper around an injected resolver host. */
export function createAntigravityResolverForTest(host: CliResolverHost) {
  return createAntigravityResolver(host);
}

const antigravityResolver = createAntigravityResolver();

/**
 * Finds the directory containing the `agy` binary.
 * Checks `which agy` first, then falls back to common install locations.
 *
 * @returns Directory path, or null if not found
 */
export function resolveAntigravityDir(): string | null {
  return antigravityResolver.resolve()?.directory ?? null;
}

/**
 * Check if the Antigravity CLI is available on the system.
 */
export function isAntigravityAvailable(): boolean {
  return resolveAntigravityDir() !== null;
}

export function getAntigravityNotFoundMessage(): string {
  return formatCliNotFoundMessage(ANTIGRAVITY_NOT_FOUND, antigravityResolver.diagnostics());
}
