/**
 * @fileoverview Resolve the Codex (OpenAI) CLI binary across common install paths.
 *
 * Mirrors opencode-cli-resolver.ts pattern. Finds the `codex` binary
 * and provides an augmented PATH string for tmux sessions.
 *
 * @module utils/codex-cli-resolver
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCliExecutableResolver, formatCliNotFoundMessage } from './cli-executable-resolver.js';

/** Common directories where the Codex CLI binary may be installed */
const CODEX_SEARCH_DIRS = [
  join(homedir(), '.codex', 'bin'), // Default install location
  join(homedir(), '.local', 'bin'), // Alternative install location
  '/usr/local/bin', // Homebrew / system
  join(homedir(), '.bun', 'bin'), // Bun global
  join(homedir(), '.npm-global', 'bin'), // npm global
  join(homedir(), 'bin'), // User bin
];

const codexResolver = createCliExecutableResolver({ binary: 'codex', searchDirs: CODEX_SEARCH_DIRS });
const CODEX_NOT_FOUND = 'Codex CLI not found. Install with: npm install -g @openai/codex';

/**
 * Finds the directory containing the `codex` binary.
 * Checks `which codex` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function resolveCodexDir(): string | null {
  return codexResolver.resolve()?.directory ?? null;
}

/**
 * Check if Codex CLI is available on the system.
 */
export function isCodexAvailable(): boolean {
  return resolveCodexDir() !== null;
}

export function getCodexNotFoundMessage(): string {
  return formatCliNotFoundMessage(CODEX_NOT_FOUND, codexResolver.diagnostics());
}
