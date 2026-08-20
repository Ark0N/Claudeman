/**
 * @fileoverview Generic CLI binary resolution, shared by every per-CLI resolver
 * (`claude-cli-resolver.ts`, `opencode-cli-resolver.ts`, `codex-cli-resolver.ts`,
 * `gemini-cli-resolver.ts`, `antigravity-cli-resolver.ts`, `pi-cli-resolver.ts`).
 *
 * Those six files used to each hand-roll the same `which` + search-dir walk with a
 * module-level cache. They now call into this module and re-export the result under their
 * historical names, so every existing caller (`findClaudeDir()`, `resolvePiDir()`, …) and
 * every `vi.mock('.../opencode-cli-resolver.js')` in the test suite keeps working unchanged
 * — the per-CLI files stay real, separately-mockable modules; only the walking logic moved.
 *
 * Search parameters (binaries, search dirs, version-probe config) come from the CLI
 * registry's stock catalog, so this is also where the resolvers stop duplicating data that
 * `src/config/cli-registry/stock.ts` already declares.
 *
 * @module utils/cli-resolver
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { compileVersionRegex } from '../config/cli-registry/patterns.js';
import type { CliVersionProbe } from '../config/cli-registry/types.js';

/** Expand a leading `~` to the current homedir. Search dirs carry no other expansion. */
function expandHome(dir: string): string {
  return dir.startsWith('~') ? join(homedir(), dir.slice(1).replace(/^[/\\]/, '')) : dir;
}

/**
 * A resolver instance for one CLI. Each call to `createDirResolver()` returns its own
 * closured cache, exactly like the six hand-written modules each had their own
 * module-level `let _xDir`.
 */
export interface DirResolver {
  resolveDir(): string | null;
  isAvailable(): boolean;
}

/**
 * The plain "which, then search dirs" resolver — covers opencode, codex, gemini and
 * antigravity today, and any future CLI with no version-sanity requirement.
 */
export function createDirResolver(binaries: string[], searchDirs: string[]): DirResolver {
  let cached: string | null = null; // '' = searched, not found
  const dirs = searchDirs.map(expandHome);

  function resolveDir(): string | null {
    if (cached !== null) return cached || null;

    for (const bin of binaries) {
      try {
        const result = execSync(`which ${bin}`, { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
        if (result && existsSync(result)) {
          cached = dirname(result);
          return cached;
        }
      } catch {
        // not on PATH via `which`; fall through to the search dirs
      }
    }

    for (const dir of dirs) {
      for (const bin of binaries) {
        if (existsSync(join(dir, bin))) {
          cached = dir;
          return cached;
        }
      }
    }

    cached = '';
    return null;
  }

  return { resolveDir, isAvailable: () => resolveDir() !== null };
}

/**
 * A resolver whose EVERY candidate must pass a version-sanity probe before being accepted
 * — pi's behaviour, generalized. For a CLI with a short, generic binary name, a `which` hit
 * is not by itself evidence the right program is installed.
 *
 * Under `VITEST` the probe never runs (existence alone decides), matching every resolver's
 * hermetic-test behaviour: the suites must not depend on what happens to be on the dev box.
 */
export interface VersionGatedResolver extends DirResolver {
  getVersion(): string | null;
}

export function createVersionGatedResolver(
  binaries: string[],
  searchDirs: string[],
  probe: CliVersionProbe,
  logPrefix: string
): VersionGatedResolver {
  let cachedDir: string | null = null; // '' = searched, not found
  let cachedVersion: string | null = null;
  const dirs = searchDirs.map(expandHome);
  const regex = probe.regex ? compileVersionRegex(probe.regex) : null;

  function probeOne(binPath: string): string | null {
    if (process.env.VITEST) return null;
    try {
      const out = execFileSync(binPath, [probe.arg], {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const candidate = regex ? regex.exec(out)?.[1] : out || null;
      if (candidate) return candidate;
      console.warn(`[${logPrefix}] Ignoring ${binPath}: "${probe.arg}" printed ${JSON.stringify(out.slice(0, 80))}`);
    } catch (err) {
      console.warn(`[${logPrefix}] Ignoring ${binPath}: "${probe.arg}" failed (${(err as Error).message})`);
    }
    return null;
  }

  function accept(binPath: string): string | null {
    if (process.env.VITEST) {
      cachedDir = dirname(binPath);
      cachedVersion = '';
      return cachedDir;
    }
    const version = probeOne(binPath);
    if (!version) return null;
    cachedDir = dirname(binPath);
    cachedVersion = version;
    return cachedDir;
  }

  function resolveDir(): string | null {
    if (cachedDir !== null) return cachedDir || null;

    for (const bin of binaries) {
      try {
        const result = execSync(`which ${bin}`, { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
        if (result && existsSync(result)) {
          const dir = accept(result);
          if (dir) return dir;
        }
      } catch {
        // not on PATH via `which`
      }
    }

    for (const dir of dirs) {
      for (const bin of binaries) {
        const binPath = join(dir, bin);
        if (!existsSync(binPath)) continue;
        const accepted = accept(binPath);
        if (accepted) return accepted;
      }
    }

    cachedDir = '';
    cachedVersion = '';
    return null;
  }

  return {
    resolveDir,
    isAvailable: () => resolveDir() !== null,
    getVersion: () => {
      resolveDir();
      return cachedVersion || null;
    },
  };
}

// ---------------------------------------------------------------------------
// Claude's retry/backoff version probe. Pure apart from the `state` it mutates
// and the injected `probe`, so it stays directly unit-testable exactly as
// `test/claude-cli-version-cache.test.ts` already exercises it.
// ---------------------------------------------------------------------------

/**
 * Cache state for a `--version` probe with retry/backoff. `version` is only ever set from a
 * SUCCESSFUL probe and then kept for the process lifetime (the binary can't change under a
 * running server without a restart). Failures are tracked separately so they expire.
 */
export interface RetryingVersionProbeState {
  /** Successful probe result; `undefined` until one succeeds. */
  version?: string;
  /** Consecutive failed probes (drives the retry backoff). */
  failures: number;
  /** Timestamp of the most recent failed probe. */
  lastFailureAt: number;
}

/** First retry window after a failed probe. */
const VERSION_PROBE_BASE_RETRY_MS = 60_000;
/** Ceiling for the doubling backoff, so a permanently missing binary settles down. */
const VERSION_PROBE_MAX_RETRY_MS = 15 * 60_000;

/**
 * How long to wait before re-probing after `failures` consecutive failures:
 * 1min, 2min, 4min… capped at 15min.
 */
export function retryingVersionProbeDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(VERSION_PROBE_BASE_RETRY_MS * 2 ** (failures - 1), VERSION_PROBE_MAX_RETRY_MS);
}

/**
 * Cache policy for a retry/backoff version probe. Success is cached forever, failure is not
 * — see claude-cli-resolver.ts's original doc comment (preserved there) for the shipped bug
 * this asymmetry fixes: caching a transient failure forever silently disabled every feature
 * gated on the version for the rest of the process lifetime.
 */
export function resolveRetryingVersion(
  state: RetryingVersionProbeState,
  now: number,
  probe: () => string | null
): string | null {
  if (state.version !== undefined) return state.version;
  if (state.failures > 0 && now - state.lastFailureAt < retryingVersionProbeDelayMs(state.failures)) return null;

  let version: string | null = null;
  try {
    version = probe();
  } catch {
    version = null;
  }

  if (version) {
    state.version = version;
    state.failures = 0;
    state.lastFailureAt = 0;
    return version;
  }
  state.failures += 1;
  state.lastFailureAt = now;
  return null;
}

/**
 * Build a retry/backoff version getter for a resolved binary, bound to its own cache state
 * and PATH-augmentation. `getAugmentedPath` is injected because only claude currently needs
 * PATH augmentation ahead of the probe (its binary dir may not be on the inherited PATH).
 */
export function createRetryingVersionGetter(opts: {
  resolveDir: () => string | null;
  binaryName: string;
  versionArg: string;
  versionRegex?: string;
  getAugmentedPath?: () => string;
}): () => string | null {
  const state: RetryingVersionProbeState = { failures: 0, lastFailureAt: 0 };
  const regex = opts.versionRegex ? compileVersionRegex(opts.versionRegex) : null;

  function probeOnce(): string | null {
    const dir = opts.resolveDir();
    const bin = dir ? join(dir, opts.binaryName) : opts.binaryName;
    const out = execFileSync(bin, [opts.versionArg], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      env: { ...process.env, PATH: opts.getAugmentedPath ? opts.getAugmentedPath() : process.env.PATH },
    });
    const match = regex ? regex.exec(out) : null;
    return match ? match[1] : null;
  }

  return () => {
    // Keep the test suite hermetic — never spawn a real subprocess under vitest. Tests that
    // need a version set it directly on the session. Deliberately does NOT touch `state`:
    // recording a phantom failure here would be the very cache-poisoning this fixes.
    if (process.env.VITEST) return null;
    return resolveRetryingVersion(state, Date.now(), probeOnce);
  };
}

/** Build a PATH string that includes `dir`, if not already present. Cached by the caller. */
export function augmentPath(dir: string | null, currentPath: string): string {
  if (dir && !currentPath.split(delimiter).includes(dir)) {
    return `${dir}${delimiter}${currentPath}`;
  }
  return currentPath;
}
