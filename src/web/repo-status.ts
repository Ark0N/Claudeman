/**
 * @fileoverview Repository-status check (App Settings → Updates → "Repository
 * status").
 *
 * INFORMATIONAL companion to the release-tag self-updater (`self-update.ts`).
 * Where the updater answers "is there a newer published release tag, and do you
 * want to `git checkout` it", this module answers "where does my local checkout
 * sit relative to the upstream project AND my own fork" — by commit ahead/behind
 * count plus a short list of the incoming commits.
 *
 * This needs the actual commits locally, so it does a READ-ONLY `git fetch` of
 * the compared ref per remote (updates only remote-tracking refs under `.git`,
 * never the working tree), then `git rev-list`/`git log`. Works uniformly for
 * GitHub and non-GitHub remotes (e.g. Bitbucket) — no release tags required.
 *
 * Remote selection (generalizable): by default the union of `origin` and the
 * current branch's `@{upstream}` tracking remote, deduped. Override with the
 * `CODEMAN_UPDATE_REMOTES` env var (comma-separated remote names) for any other
 * layout (e.g. the common `origin`=fork / `upstream`=canonical convention).
 *
 * Split PURE helpers (parsing + remote-set/role/compare-ref decisions, unit
 * tested) from the IO wrapper `getRepositoryStatus()` (touches git).
 *
 * @module web/repo-status
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { getInstallInfo } from './self-update.js';
import type { RepoIncomingCommit, RepoRemoteRole, RepoRemoteStatus, RepositoryStatusResult } from '../types/update.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json') as { version: string };

/** Network/git timeout for the fetch path (longer than EXEC_TIMEOUT_MS — hits network). */
const FETCH_TIMEOUT_MS = 15_000;
/** Max incoming commit subjects to list per remote. */
const MAX_INCOMING = 10;

// ─────────────────────────────────────────────────────────────────────────────
// PURE helpers (unit tested, no IO)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse `git rev-list --left-right --count HEAD...<ref>` output.
 * Git prints two tab-separated counts: LEFT (commits in HEAD not in ref → ahead)
 * and RIGHT (commits in ref not in HEAD → behind). Returns null on malformed input.
 */
export function parseAheadBehind(out: string): { ahead: number; behind: number } | null {
  const m = out.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { ahead: parseInt(m[1], 10), behind: parseInt(m[2], 10) };
}

/**
 * Parse `git log --oneline` output into commits. Each non-empty line is
 * `<sha> <subject>`; the first whitespace-delimited token is the SHA.
 */
export function parseLogLines(out: string): RepoIncomingCommit[] {
  const commits: RepoIncomingCommit[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(' ');
    if (idx === -1) {
      commits.push({ sha: trimmed, subject: '' });
    } else {
      commits.push({ sha: trimmed.slice(0, idx), subject: trimmed.slice(idx + 1).trim() });
    }
  }
  return commits;
}

/**
 * Extract the default branch name from `git ls-remote --symref <remote> HEAD`
 * output (a line like `ref: refs/heads/master\tHEAD`). Returns null if absent.
 *
 * SECURITY: this parses UNTRUSTED remote output, and the result flows into a
 * later `git fetch <remote> <branch>` positional. The capture is constrained to
 * start with an alphanumeric (no leading `-`) so a hostile remote can't return
 * `ref: refs/heads/--upload-pack=<cmd>\tHEAD` and smuggle an argv flag (RCE) —
 * see `isSafeGitPositional` for the defense-in-depth re-check at the call site.
 */
export function parseSymrefDefaultBranch(out: string): string | null {
  const m = out.match(/^ref:\s+refs\/heads\/([A-Za-z0-9_./][A-Za-z0-9_./+-]*)\s+HEAD$/m);
  return m ? m[1] : null;
}

/**
 * Reject a value that would be unsafe as a git positional argument (remote name
 * or branch). A leading `-` lets untrusted ls-remote/symref output or a stray
 * `CODEMAN_UPDATE_REMOTES` entry inject an option (e.g. `--upload-pack=<cmd>`)
 * into a subsequent `git fetch`. Empty values are rejected too.
 */
export function isSafeGitPositional(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-');
}

/** Split a comma-separated env value into trimmed, non-empty names. */
export function parseRemotesEnv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decide which remote NAMES the status view covers, in display order.
 *
 * - If `envRemotes` is non-empty, use exactly those that actually exist (order
 *   preserved). This is the full-control escape hatch.
 * - Otherwise the union of `origin` (if it exists) and the tracking remote (if
 *   any), deduped. The tracking remote is listed first when it isn't `origin`,
 *   so "your fork" leads and "upstream" follows.
 */
export function resolveRemoteSet(opts: {
  existingRemotes: string[];
  trackingRemote: string | null;
  envRemotes: string[];
}): string[] {
  const exists = new Set(opts.existingRemotes);
  if (opts.envRemotes.length > 0) {
    return dedupe(opts.envRemotes.filter((n) => exists.has(n)));
  }
  const out: string[] = [];
  if (opts.trackingRemote && exists.has(opts.trackingRemote) && opts.trackingRemote !== 'origin') {
    out.push(opts.trackingRemote);
  }
  if (exists.has('origin')) out.push('origin');
  if (opts.trackingRemote && exists.has(opts.trackingRemote)) out.push(opts.trackingRemote);
  return dedupe(out);
}

/** Classify a remote's role relative to the tracking remote. */
export function roleForRemote(name: string, trackingRemote: string | null): RepoRemoteRole {
  if (trackingRemote && name === trackingRemote) return 'tracking';
  if (name === 'origin' || name === 'upstream') return 'upstream';
  return 'other';
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
}

// ─────────────────────────────────────────────────────────────────────────────
// IO wrapper
// ─────────────────────────────────────────────────────────────────────────────

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run git non-interactively (no credential or SSH prompts — a missing key/cred
 * fails fast instead of hanging). Returns captured stdout/stderr and ok flag.
 */
function runGit(args: string[], cwd: string, timeout = EXEC_TIMEOUT_MS): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
      },
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout).trim() : '',
      stderr: e.stderr ? String(e.stderr).trim() : '',
    };
  }
}

/** First line of stderr, trimmed — a compact human-readable failure reason. */
function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? 'git command failed'
  );
}

/** Compute ahead/behind + incoming commits for one already-selected remote. */
function statusForRemote(
  dir: string,
  name: string,
  trackingRemote: string,
  trackingRef: string | null
): RepoRemoteStatus {
  const role = roleForRemote(name, trackingRemote);
  const url = runGit(['remote', 'get-url', name], dir).stdout || '';
  const base: RepoRemoteStatus = { name, url, role, compareRef: '', ahead: 0, behind: 0, incoming: [] };

  // SECURITY: the remote name reaches git as a positional; reject a `-` prefix
  // (e.g. a stray CODEMAN_UPDATE_REMOTES entry) before it can act as a flag.
  if (!isSafeGitPositional(name)) {
    return { ...base, error: `Refusing unsafe remote name "${name}".` };
  }

  // Resolve the compare ref + the remote branch to fetch.
  let branch: string | null;
  if (role === 'tracking' && trackingRef) {
    // e.g. trackingRef = "bitbucket/local" → branch = "local"
    branch = trackingRef.slice(name.length + 1) || null;
  } else {
    const symref = runGit(['ls-remote', '--symref', name, 'HEAD'], dir, FETCH_TIMEOUT_MS);
    branch = symref.ok ? parseSymrefDefaultBranch(symref.stdout) : null;
    if (!branch && !symref.ok) {
      return { ...base, error: `Could not reach ${name}: ${firstLine(symref.stderr)}` };
    }
    branch = branch ?? 'master';
  }
  if (!branch) return { ...base, error: `Could not resolve a branch on ${name}.` };
  // SECURITY: defense-in-depth — `branch` may come from untrusted symref output
  // or a tracking-ref slice; never let a `-`-prefixed value reach `git fetch`.
  if (!isSafeGitPositional(branch)) {
    return { ...base, error: `Refusing unsafe branch name "${branch}" from ${name}.` };
  }
  const compareRef = `${name}/${branch}`;

  // Read-only fetch of just that ref so the local rev-list/log can see it.
  // `--` ends option parsing so neither `name` nor `branch` can be read as a flag.
  const fetched = runGit(['fetch', '--no-tags', name, '--', branch], dir, FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    return { ...base, compareRef, error: `Could not fetch ${compareRef}: ${firstLine(fetched.stderr)}` };
  }

  const counts = runGit(['rev-list', '--left-right', '--count', `HEAD...${compareRef}`], dir);
  if (!counts.ok) {
    return { ...base, compareRef, error: `Could not compare against ${compareRef}: ${firstLine(counts.stderr)}` };
  }
  const ab = parseAheadBehind(counts.stdout);
  if (!ab) return { ...base, compareRef, error: `Unexpected git output comparing ${compareRef}.` };

  const log = runGit(['log', '--oneline', '-n', String(MAX_INCOMING), `HEAD..${compareRef}`], dir);
  const incoming = log.ok ? parseLogLines(log.stdout) : [];

  return { ...base, compareRef, ahead: ab.ahead, behind: ab.behind, incoming };
}

/**
 * Inspect how the local checkout sits relative to the configured remotes.
 * Each remote is fetched + compared independently; a single unreachable remote
 * surfaces as that card's `error` and never fails the whole call.
 */
export function getRepositoryStatus(): RepositoryStatusResult {
  const checkedAt = Date.now();
  const info = getInstallInfo();
  const base: RepositoryStatusResult = {
    checkedAt,
    isGit: info.installKind === 'git',
    currentVersion: info.currentVersion || APP_VERSION,
    remotes: [],
  };
  if (info.installKind !== 'git') {
    return { ...base, error: 'Not a git install — repository status is unavailable.' };
  }

  const dir = info.installDir;

  // Tracking ref of the current branch, e.g. "bitbucket/local" (empty if none).
  const trackingRef = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], dir).stdout || null;
  const trackingRemote = trackingRef ? trackingRef.slice(0, trackingRef.indexOf('/')) || null : null;

  const remotesOut = runGit(['remote'], dir);
  const existingRemotes = remotesOut.ok
    ? remotesOut.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const selected = resolveRemoteSet({
    existingRemotes,
    trackingRemote,
    envRemotes: parseRemotesEnv(process.env.CODEMAN_UPDATE_REMOTES),
  });

  if (selected.length === 0) {
    return { ...base, error: 'No comparable remotes found (set CODEMAN_UPDATE_REMOTES to choose).' };
  }

  const remotes = selected.map((name) => statusForRemote(dir, name, trackingRemote ?? '', trackingRef));
  return { ...base, remotes };
}
