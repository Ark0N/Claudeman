/**
 * @fileoverview Resolve the `cloudflared` binary across common install paths.
 *
 * Mirrors the CLI resolvers (antigravity-cli-resolver.ts et al), for the same reason
 * they exist: the welcome screen should not offer a button whose only possible
 * outcome is an error toast.
 *
 * The search list is deliberately the SAME one `TunnelManager.resolveCloudflared()`
 * has always used, and that method now delegates here so the two can never drift.
 * The difference is the fallback: this module answers "is it installed?" honestly
 * with null, while the tunnel manager keeps falling back to the bare name so a
 * cloudflared that only exists somewhere on the tunnel process's PATH still
 * starts. A stricter answer there would turn a working tunnel into a refusal.
 *
 * @module utils/cloudflared-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Common directories where the cloudflared binary may be installed */
const CLOUDFLARED_SEARCH_DIRS = [join(homedir(), '.local', 'bin'), '/usr/local/bin'];

/** Cached path to the cloudflared binary (empty string = searched but not found) */
let _cloudflaredPath: string | null = null;

/**
 * Finds the `cloudflared` binary.
 *
 * @returns Absolute path, or null if not found
 */
export function resolveCloudflaredPath(): string | null {
  if (_cloudflaredPath !== null) return _cloudflaredPath || null;

  for (const dir of CLOUDFLARED_SEARCH_DIRS) {
    const candidate = join(dir, 'cloudflared');
    if (existsSync(candidate)) {
      _cloudflaredPath = candidate;
      return candidate;
    }
  }

  try {
    const result = execSync('which cloudflared', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
    if (result && existsSync(result)) {
      _cloudflaredPath = result;
      return result;
    }
  } catch {
    // Not on PATH either.
  }

  _cloudflaredPath = ''; // mark as searched, not found
  return null;
}

/**
 * Check if cloudflared is available on the system.
 */
export function isCloudflaredAvailable(): boolean {
  return resolveCloudflaredPath() !== null;
}
