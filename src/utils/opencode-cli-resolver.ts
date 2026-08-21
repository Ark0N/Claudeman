/**
 * @fileoverview Resolve the OpenCode CLI binary across common install paths.
 *
 * Mirrors claude-cli-resolver.ts pattern. Finds the `opencode` binary
 * and provides an augmented PATH string for tmux sessions.
 *
 * @module utils/opencode-cli-resolver
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCliExecutableResolver, formatCliNotFoundMessage } from './cli-executable-resolver.js';

/** Common directories where the OpenCode CLI binary may be installed */
const OPENCODE_SEARCH_DIRS = [
  join(homedir(), '.opencode', 'bin'), // Default install location
  join(homedir(), '.local', 'bin'), // Alternative install location
  '/usr/local/bin', // Homebrew / system
  join(homedir(), 'go', 'bin'), // Go install
  join(homedir(), '.bun', 'bin'), // Bun global
  join(homedir(), '.npm-global', 'bin'), // npm global
  join(homedir(), 'bin'), // User bin
];

const openCodeResolver = createCliExecutableResolver({ binary: 'opencode', searchDirs: OPENCODE_SEARCH_DIRS });
const OPENCODE_NOT_FOUND = 'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash';

/**
 * Finds the directory containing the `opencode` binary.
 * Checks `which opencode` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function resolveOpenCodeDir(): string | null {
  return openCodeResolver.resolve()?.directory ?? null;
}

/**
 * Check if OpenCode CLI is available on the system.
 */
export function isOpenCodeAvailable(): boolean {
  return resolveOpenCodeDir() !== null;
}

export function getOpenCodeNotFoundMessage(): string {
  return formatCliNotFoundMessage(OPENCODE_NOT_FOUND, openCodeResolver.diagnostics());
}
