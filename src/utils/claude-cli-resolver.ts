/**
 * @fileoverview Shared Claude CLI binary resolution.
 *
 * Finds the `claude` binary across common installation paths and provides
 * an augmented PATH string. Used by session.ts and tmux-manager.ts
 * to locate the Claude CLI.
 *
 * @module utils/claude-cli-resolver
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Common directories where the Claude CLI binary may be installed */
const CLAUDE_SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.claude', 'local'),
  '/usr/local/bin',
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), 'bin'),
];

/** Cached directory containing the claude binary (empty string = searched but not found) */
let _claudeDir: string | null = null;

/**
 * Returns true if the Claude CLI binary can be located (via `which` or one of
 * the common install directories). Mirrors `isGeminiAvailable`/`isOpenCodeAvailable`/
 * `isCodexAvailable` in the sibling resolvers.
 */
export function isClaudeAvailable(): boolean {
  return findClaudeDir() !== null;
}

/**
 * Finds the directory containing the `claude` binary.
 * Checks `which claude` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function findClaudeDir(): string | null {
  if (_claudeDir !== null) return _claudeDir || null;

  // Try `which` first (respects current PATH)
  try {
    const result = execSync('which claude', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
    if (result && existsSync(result)) {
      _claudeDir = dirname(result);
      return _claudeDir;
    }
  } catch {
    // Claude not in PATH, will check common locations
  }

  // Fallback: check common installation directories
  for (const dir of CLAUDE_SEARCH_DIRS) {
    if (existsSync(join(dir, 'claude'))) {
      _claudeDir = dir;
      return _claudeDir;
    }
  }

  _claudeDir = ''; // mark as searched, not found
  return null;
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

/** Cached augmented PATH string */
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

  const currentPath = process.env.PATH || '';
  const claudeDir = findClaudeDir();

  if (claudeDir && !currentPath.split(delimiter).includes(claudeDir)) {
    _augmentedPath = `${claudeDir}${delimiter}${currentPath}`;
    return _augmentedPath;
  }

  _augmentedPath = currentPath;
  return _augmentedPath;
}

/** Cached `claude --version` result: string = version, null = probed but unavailable, undefined = not probed */
let _claudeVersion: string | null | undefined = undefined;

/**
 * Returns the installed Claude CLI version (e.g. `"2.1.210"`), or null if it
 * can't be determined. Runs `claude --version` once and caches the result.
 *
 * This is a deterministic alternative to scraping the interactive startup
 * banner (`parseClaudeCodeInfo` in session.ts): newer Claude Code builds don't
 * reliably print `Claude Code vX.Y.Z` at startup, and resumed sessions never
 * show it, which left `cliVersion` undefined and silently disabled features
 * gated on it (e.g. wheel-forwarding to Claude's transcript — issue #154).
 */
export function getClaudeCliVersion(): string | null {
  if (_claudeVersion !== undefined) return _claudeVersion;
  // Keep the test suite hermetic — never spawn a real `claude` subprocess under
  // vitest (matches IS_TEST_MODE in tmux-manager). Tests that need a version set
  // it on the session directly.
  if (process.env.VITEST) {
    _claudeVersion = null;
    return _claudeVersion;
  }
  try {
    const dir = findClaudeDir();
    const bin = dir ? join(dir, 'claude') : 'claude';
    // execFileSync (no shell) — the resolved path may contain spaces, and there
    // is no untrusted input, but avoid a shell either way.
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      env: { ...process.env, PATH: getAugmentedPath() },
    });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    _claudeVersion = match ? match[1] : null;
  } catch {
    _claudeVersion = null;
  }
  return _claudeVersion;
}
