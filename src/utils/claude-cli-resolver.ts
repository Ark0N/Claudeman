/**
 * @fileoverview Claude CLI binary resolution.
 *
 * Thin wrapper over `cli-resolver.ts`'s generic walker, reading its search
 * parameters from the CLI registry's stock catalog. Kept as its own module
 * (rather than folded into a single generic import everywhere) so every
 * existing caller and every `vi.mock('.../claude-cli-resolver.js')` in the
 * test suite keeps working unchanged — see cli-resolver.ts's file header.
 *
 * @module utils/claude-cli-resolver
 */

import { join } from 'node:path';
import {
  augmentPath,
  createDirResolver,
  createRetryingVersionGetter,
  resolveRetryingVersion,
  retryingVersionProbeDelayMs,
  type RetryingVersionProbeState,
} from './cli-resolver.js';
import { getCli } from '../config/cli-registry/registry.js';

/** Preserved name for the exported type; identical shape to RetryingVersionProbeState. */
export type ClaudeVersionProbeState = RetryingVersionProbeState;

/** Preserved name; identical behaviour to the generic retry/backoff delay function. */
export const claudeVersionRetryDelayMs = retryingVersionProbeDelayMs;

/** Preserved name; identical behaviour to the generic retry/backoff cache policy. */
export const resolveClaudeCliVersion = resolveRetryingVersion;

function claudeEntry() {
  const entry = getCli('claude');
  if (!entry) throw new Error('claude is not registered in the CLI registry');
  return entry;
}

const resolver = createDirResolver(claudeEntry().discovery.binaries, claudeEntry().discovery.searchDirs);

/**
 * Returns true if the Claude CLI binary can be located (via `which` or one of
 * the common install directories). Mirrors the sibling resolvers.
 */
export function isClaudeAvailable(): boolean {
  return resolver.isAvailable();
}

/**
 * Finds the directory containing the `claude` binary.
 * Checks `which claude` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function findClaudeDir(): string | null {
  return resolver.resolveDir();
}

/**
 * Returns an absolute path to the `claude` binary, falling back to the bare
 * name `'claude'` when it cannot be located (so PATH resolution still gets a
 * chance).
 *
 * Preferred over passing `'claude'` to `pty.spawn()`: a PTY child resolves the
 * command against the environment it is handed, and an install that lives in
 * `~/.local/bin` or `~/.claude/local` is frequently absent from the PATH the
 * server process inherited (issue #6).
 */
export function getClaudeBinaryPath(): string {
  const dir = findClaudeDir();
  return dir ? join(dir, 'claude') : 'claude';
}

/** Cached augmented PATH string. */
let _augmentedPath: string | null = null;

/**
 * Returns a PATH string that includes the directory containing `claude`.
 *
 * Finds the claude binary (via `which` or common install locations), then
 * prepends its directory to the current PATH if not already present.
 * Result is cached for subsequent calls.
 */
export function getAugmentedPath(): string {
  if (_augmentedPath) return _augmentedPath;
  _augmentedPath = augmentPath(findClaudeDir(), process.env.PATH || '');
  return _augmentedPath;
}

/**
 * Returns the installed Claude CLI version (e.g. `"2.1.210"`), or null if it
 * can't be determined. Runs `claude --version` at most once per successful
 * resolution; failed probes retry with backoff (see `resolveClaudeCliVersion`).
 *
 * This is a deterministic alternative to scraping the interactive startup
 * banner (`parseClaudeCodeInfo` in session.ts): newer Claude Code builds don't
 * reliably print `Claude Code vX.Y.Z` at startup, and resumed sessions never
 * show it, which left `cliVersion` undefined and silently disabled features
 * gated on it (e.g. wheel-forwarding to Claude's transcript — issue #154).
 */
export const getClaudeCliVersion = createRetryingVersionGetter({
  resolveDir: findClaudeDir,
  binaryName: 'claude',
  versionArg: claudeEntry().discovery.version?.arg ?? '--version',
  versionRegex: claudeEntry().discovery.version?.regex,
  getAugmentedPath,
});
