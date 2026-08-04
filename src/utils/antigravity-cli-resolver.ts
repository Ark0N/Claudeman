/**
 * @fileoverview Resolve the Antigravity CLI (`agy`) binary across common install paths.
 *
 * Mirrors gemini-cli-resolver.ts. Google's installer (antigravity.google/cli/install.sh)
 * places the binary at ~/.local/bin/agy; the other locations cover manual installs.
 *
 * @module utils/antigravity-cli-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Common directories where the Antigravity CLI binary may be installed */
const ANTIGRAVITY_SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.antigravity', 'bin'),
  '/usr/local/bin',
  join(homedir(), 'bin'),
];

/** Cached directory containing the agy binary (empty string = searched but not found) */
let _antigravityDir: string | null = null;

/**
 * Finds the directory containing the `agy` binary.
 * Checks `which agy` first, then falls back to common install locations.
 *
 * @returns Directory path, or null if not found
 */
export function resolveAntigravityDir(): string | null {
  if (_antigravityDir !== null) return _antigravityDir || null;

  try {
    const result = execSync('which agy', {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (result && existsSync(result)) {
      _antigravityDir = dirname(result);
      return _antigravityDir;
    }
  } catch {
    // agy not in PATH, will check common locations
  }

  for (const dir of ANTIGRAVITY_SEARCH_DIRS) {
    if (existsSync(join(dir, 'agy'))) {
      _antigravityDir = dir;
      return _antigravityDir;
    }
  }

  _antigravityDir = '';
  return null;
}

/**
 * Check if the Antigravity CLI is available on the system.
 */
export function isAntigravityAvailable(): boolean {
  return resolveAntigravityDir() !== null;
}
