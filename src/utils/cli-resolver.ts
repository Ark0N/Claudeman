/**
 * @fileoverview Generic CLI binary resolution, shared by every per-CLI resolver
 * (`claude-cli-resolver.ts`, `opencode-cli-resolver.ts`, `codex-cli-resolver.ts`,
 * `gemini-cli-resolver.ts`, `antigravity-cli-resolver.ts`, `pi-cli-resolver.ts`,
 * `grok-cli-resolver.ts`).
 *
 * Those files used to each hand-roll the same `which` + search-dir walk with a
 * module-level cache. They now call into this module and re-export the result under their
 * historical names, so every existing caller (`findClaudeDir()`, `resolvePiDir()`, …) and
 * every `vi.mock('.../opencode-cli-resolver.js')` in the test suite keeps working unchanged
 * — the per-CLI files stay real, separately-mockable modules; only the walking logic moved.
 *
 * Search parameters (binaries, search dirs, version-probe config) come from the CLI
 * registry's stock catalog, so this is also where the resolvers stop duplicating data that
 * `src/config/cli-registry/stock.ts` already declares.
 *
 * **Resolution chain** (ported from upstream Ark0N/Codeman's independently-built
 * `cli-executable-resolver.ts`, PR #329 + follow-up `61251c0b`, into this registry-driven
 * module rather than duplicated per-CLI): PATH (`which`) → declared search dirs → an
 * interactive LOGIN SHELL as the last resort, since that is what finds nvm/Homebrew/
 * user-npm installs when Codeman runs as a systemd/launchd service with a minimal PATH
 * (launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin`). The login-shell step is the only
 * one that spawns anything beyond a `which`, so it stays last.
 *
 * A MISS across the whole chain is negative-cached with a doubling backoff (reusing
 * `resolveRetryingVersion`/`retryingVersionProbeDelayMs` below — the exact mechanism
 * `getClaudeCliVersion` already used for its own version probe, generalized here to the
 * directory-resolution miss path too) rather than either caching it forever (the original
 * bug: a missing CLI re-ran the whole chain, including the synchronous login-shell spawn,
 * on every request, forever) or never caching it at all.
 *
 * Every exec call that carries a `timeout` also carries `killSignal: 'SIGKILL'`:
 * `execFileSync`'s `timeout` option only SENDS the signal and then keeps waiting for the
 * child to exit — the default SIGTERM is ignored by an interactive bash stuck in a blocking
 * `.bash_profile`, which would otherwise survive the timeout and block the server forever.
 *
 * Hermeticity: under `VITEST`, no exec call in this module ever runs for real — the suites
 * must never depend on, or execute, whatever happens to be installed on the machine running
 * them (same rule as `IS_TEST_MODE` in tmux-manager.ts).
 *
 * @module utils/cli-resolver
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { compileVersionRegex } from '../config/cli-registry/patterns.js';
import type { CliVersionProbe } from '../config/cli-registry/types.js';
import { getCli } from '../config/cli-registry/registry.js';
import { loginShellArgs, resolveLocalShell } from './shell-resolver.js';

/** Expand a leading `~` to the current homedir. Search dirs carry no other expansion. */
function expandHome(dir: string): string {
  return dir.startsWith('~') ? join(homedir(), dir.slice(1).replace(/^[/\\]/, '')) : dir;
}

// ---------------------------------------------------------------------------
// Login-shell fallback — the last-resort step in the resolution chain.
// ---------------------------------------------------------------------------

const LOGIN_SHELL_BEGIN_MARKER = '__CODEMAN_CLI_RESOLVE_BEGIN__';
const LOGIN_SHELL_END_MARKER = '__CODEMAN_CLI_RESOLVE_END__';

function loginShellProbeCommand(binary: string): string {
  return [
    `printf '%s\\n' '${LOGIN_SHELL_BEGIN_MARKER}'`,
    `command -v -- ${binary}`,
    `printf '%s\\n' '${LOGIN_SHELL_END_MARKER}'`,
  ].join('; ');
}

/** Only lines BETWEEN the markers, absolute, and matching `binary`'s basename are trusted
 *  — a login shell's `.bash_profile`/`.zshrc` can print arbitrary noise ahead of the result. */
function parseLoginShellResult(output: string, binary: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const begin = lines.indexOf(LOGIN_SHELL_BEGIN_MARKER);
  if (begin === -1) return null;
  const end = lines.indexOf(LOGIN_SHELL_END_MARKER, begin + 1);
  if (end === -1) return null;
  for (const candidate of lines.slice(begin + 1, end)) {
    if (candidate.startsWith('/') && basename(candidate) === binary) return candidate;
  }
  return null;
}

/**
 * Spawn the user's login shell to resolve `binary` via `command -v`. Returns `null` under
 * VITEST (never spawns for real in tests) or on any failure — this is a best-effort last
 * resort, not a required step.
 */
function findInLoginShell(binary: string): string | null {
  if (process.env.VITEST) return null;
  const shellPath = resolveLocalShell();
  const shellArgs = loginShellArgs(shellPath).trim().split(/\s+/).filter(Boolean);
  try {
    const out = execFileSync(shellPath, [...shellArgs, '-c', loginShellProbeCommand(binary)], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      killSignal: 'SIGKILL',
    });
    const candidate = parseLoginShellResult(out, binary);
    return candidate && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** `which <bin>`, VITEST-gated (never spawns for real in tests, matching every other probe
 *  in this module — this call previously had NO such guard, a real hermeticity gap). */
function findOnProcessPath(bin: string): string | null {
  if (process.env.VITEST) return null;
  try {
    const result = execSync(`which ${bin}`, {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }).trim();
    return result && existsSync(result) ? result : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Negative-result caching with backoff — shared by both resolver flavors below via
// `resolveRetryingVersion`, the SAME mechanism claude's own version probe already used
// (see that section further down), rather than a second, duplicated backoff curve.
// ---------------------------------------------------------------------------

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
 * The plain "which, then search dirs, then a login shell" resolver — covers opencode,
 * codex, gemini, antigravity, grok and any future CLI with no version-sanity requirement.
 */
export function createDirResolver(binaries: string[], searchDirs: string[]): DirResolver {
  const dirs = searchDirs.map(expandHome);
  const state: RetryingVersionProbeState = { failures: 0, lastFailureAt: 0 };

  function probeChain(): string | null {
    for (const bin of binaries) {
      const found = findOnProcessPath(bin);
      if (found) return dirname(found);
    }
    for (const dir of dirs) {
      for (const bin of binaries) {
        if (existsSync(join(dir, bin))) return dir;
      }
    }
    for (const bin of binaries) {
      const found = findInLoginShell(bin);
      if (found) return dirname(found);
    }
    return null;
  }

  function resolveDir(): string | null {
    return resolveRetryingVersion(state, Date.now(), probeChain);
  }

  return { resolveDir, isAvailable: () => resolveDir() !== null };
}

/**
 * A resolver whose EVERY candidate must pass a version-sanity probe before being accepted
 * — pi's/grok's behaviour, generalized. For a CLI with a short, generic binary name, a
 * `which` hit is not by itself evidence the right program is installed.
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
  const dirs = searchDirs.map(expandHome);
  const regex = probe.regex ? compileVersionRegex(probe.regex) : null;
  const state: RetryingVersionProbeState = { failures: 0, lastFailureAt: 0 };
  let cachedVersion: string | null = null;

  function probeOne(binPath: string): string | null {
    if (process.env.VITEST) return null;
    try {
      const out = execFileSync(binPath, [probe.arg], {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        killSignal: 'SIGKILL',
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
      cachedVersion = '';
      return dirname(binPath);
    }
    const version = probeOne(binPath);
    if (!version) return null;
    cachedVersion = version;
    return dirname(binPath);
  }

  function probeChain(): string | null {
    for (const bin of binaries) {
      const found = findOnProcessPath(bin);
      if (found) {
        const dir = accept(found);
        if (dir) return dir;
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
    for (const bin of binaries) {
      const found = findInLoginShell(bin);
      if (found) {
        const dir = accept(found);
        if (dir) return dir;
      }
    }
    return null;
  }

  function resolveDir(): string | null {
    return resolveRetryingVersion(state, Date.now(), probeChain);
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
// `test/claude-cli-version-cache.test.ts` already exercises it. Also now the
// shared backoff mechanism for `createDirResolver`/`createVersionGatedResolver`'s
// own directory-miss caching above.
// ---------------------------------------------------------------------------

/**
 * Cache state for a probe with retry/backoff. `version` is only ever set from a
 * SUCCESSFUL probe and then kept for the process lifetime (the binary can't change under a
 * running server without a restart). Failures are tracked separately so they expire.
 *
 * Named for its original use (claude's `--version` probe) but the field holds any
 * successfully-resolved string — a version number OR a resolved directory path, per
 * `createDirResolver`/`createVersionGatedResolver` above.
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
 * Cache policy for a retry/backoff probe. Success is cached forever, failure is not — see
 * claude-cli-resolver.ts's original doc comment (preserved there) for the shipped bug this
 * asymmetry fixes: caching a transient failure forever silently disabled every feature
 * gated on the result for the rest of the process lifetime.
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
      killSignal: 'SIGKILL',
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

// ---------------------------------------------------------------------------
// Not-found diagnostics — bounded, sanitized PATH/login-shell/search-dir info appended to
// a "CLI not found" message, ported from upstream's `formatCliNotFoundMessage`.
// ---------------------------------------------------------------------------

/** Maximum rendered length of each bounded diagnostic field, excluding its label. A
 *  not-found message must never become a vector for dumping arbitrary env data. */
const DIAGNOSTIC_FIELD_MAX_LENGTH = 1024;

function sanitizeDiagnosticField(value: string, emptyMarker: string): string {
  const flattened = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    return isControl || codePoint === 0x2028 || codePoint === 0x2029 ? ' ' : character;
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
  if (!flattened) return emptyMarker;
  if (flattened.length <= DIAGNOSTIC_FIELD_MAX_LENGTH) return flattened;
  return `${flattened.slice(0, DIAGNOSTIC_FIELD_MAX_LENGTH - 1)}…`;
}

/**
 * Append bounded PATH/login-shell/search-dir diagnostics to a base "CLI not found" message,
 * so the error names exactly where resolution looked instead of just what it was looking
 * for. Called from `missingCliMessage()` (registry.ts), so every caller (tmux-manager's
 * spawn throw, session-routes' availability gate) gets it for free.
 */
export function formatCliNotFoundMessage(base: string, id: string): string {
  const entry = getCli(id);
  const searchDirs = (entry?.discovery.searchDirs ?? []).map(expandHome);
  const shellPath = resolveLocalShell();
  const shellArgs = loginShellArgs(shellPath).trim().split(/\s+/).filter(Boolean);
  const processPath = sanitizeDiagnosticField(process.env.PATH ?? '', '(empty)');
  const shell = sanitizeDiagnosticField([shellPath, ...shellArgs].filter(Boolean).join(' '), '(none)');
  const dirs = sanitizeDiagnosticField(searchDirs.join(', '), '(none)');
  return `${base}\nServer PATH: ${processPath}\nLogin shell: ${shell}\nChecked directories: ${dirs}`;
}

/**
 * Generic, memoized-by-id directory resolution for ANY registered CLI. Chooses
 * `createVersionGatedResolver` when the entry's discovery declares
 * `requireVersionMatch` (pi's/grok's shape) and `createDirResolver` otherwise (every other
 * entry today) — so callers that need only a binary DIRECTORY (not a live version,
 * which the six per-CLI resolver modules still own) can look one up for ANY id
 * without a per-mode branch, including a custom CLI that isn't one of the named
 * modules at all.
 *
 * Each id gets its own resolver instance the first time it is requested, cached for
 * the process lifetime exactly like the per-CLI modules already cache themselves
 * — this does not create a second competing cache for claude/opencode/codex/gemini
 * /antigravity/pi/grok, since callers that already import those modules' own functions
 * keep using them; this is for generic code that only has a `CliId` string in hand.
 */
const _dirResolvers = new Map<string, DirResolver>();

/**
 * Drop the memoized resolver for `id`, so the next `resolveCliBinDir`/`resolveCliVersion`
 * call re-probes PATH/searchDirs/login-shell from scratch instead of replaying a cached
 * negative result. `createDirResolver`/`createVersionGatedResolver` already retry a miss on
 * their own doubling backoff (see this file's header), but `cli-installer.ts` calls this
 * right after a successful install so the FIRST post-install check is not stuck waiting out
 * whatever backoff window was already in progress.
 */
export function invalidateCliBinDirCache(id: string): void {
  _dirResolvers.delete(id);
}

export function resolveCliBinDir(id: string): string | null {
  let resolver = _dirResolvers.get(id);
  if (!resolver) {
    const entry = getCli(id);
    if (!entry || entry.discovery.binaries.length === 0) return null; // e.g. `shell`
    resolver = entry.discovery.version?.requireVersionMatch
      ? createVersionGatedResolver(
          entry.discovery.binaries,
          entry.discovery.searchDirs,
          entry.discovery.version,
          `CliResolver:${id}`
        )
      : createDirResolver(entry.discovery.binaries, entry.discovery.searchDirs);
    _dirResolvers.set(id, resolver);
  }
  return resolver.resolveDir();
}

/**
 * Generic version accessor for the SAME memoized resolver `resolveCliBinDir` builds. Only
 * returns a value for an entry whose resolver is version-aware (today: `requireVersionMatch`
 * entries like pi/grok) — claude's separate retry/backoff version getter stays on its own
 * module (`getClaudeCliVersion`), since that behaviour is declared via
 * `retryOnTransientFailure`, not `requireVersionMatch`, and is not (yet) built generically
 * here. Returns null rather than probing blind for an entry with no version-aware resolver.
 */
function isVersionGated(resolver: DirResolver): resolver is VersionGatedResolver {
  return 'getVersion' in resolver;
}

export function resolveCliVersion(id: string): string | null {
  resolveCliBinDir(id); // ensure the resolver for `id` has been created
  const resolver = _dirResolvers.get(id);
  return resolver && isVersionGated(resolver) ? resolver.getVersion() : null;
}
