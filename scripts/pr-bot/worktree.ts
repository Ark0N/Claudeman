/**
 * @fileoverview Per-PR checkouts for the review sessions.
 *
 * The maintainer's checkout is SHARED with other agent sessions (CLAUDE.md, Session
 * Safety), so the bot never runs `git checkout` there. It fetches the PR head into a
 * private ref (`refs/pr-bot/<n>`) of the main repository, which anchors the objects,
 * and checks the PR out in a private clone under the bot's own data dir; every
 * in-tree git command runs with `-C <clone>`.
 *
 * Why a `git clone --shared` and not a linked worktree: Claude Code resolves a linked
 * worktree's project settings through the git common dir, i.e. the MAIN checkout's
 * `.claude/settings.local.json`, whose model pin then silently overrides anything
 * written into the worktree (measured 2026-09-05: a worktree pinned to
 * `claude-fable-5-1` reported `claude-opus-5[1m]`). A shared clone has its own
 * project root, so Codeman's `modelOverride` and hooks land where the CLI reads them,
 * while `objects/info/alternates` keeps the object store shared (no duplication).
 *
 * Dependencies: a clone has no `node_modules`. When the PR leaves the lockfile
 * untouched, `node_modules` is a SYMLINK to the main checkout's tree (read-only use:
 * tsc, vitest, eslint). When the PR changes dependencies, the symlink is unlinked
 * first and `npm ci` installs a real tree, so npm can never write through the link
 * into the live server's modules. `src/web/public/vendor` is COPIED per file, never
 * linked: postinstall regenerates it in place, and a link would let a PR's bundle
 * overwrite the bundle the production server is serving.
 */
import { execFile } from 'child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  dir: string;
  headSha: string;
  mergeBase: string;
  deps: 'linked' | 'installed' | 'kept';
}

export type Logger = (msg: string) => void;

async function git(args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
  return stdout;
}

export function prRef(prNumber: number): string {
  return `refs/pr-bot/${prNumber}`;
}

/** The upstream master, as fetched into the main repository, mirrored into the clone. */
const MASTER_REF = 'refs/remotes/origin/master';

export function worktreeDirFor(worktreesDir: string, prNumber: number): string {
  return join(worktreesDir, `pr-${prNumber}`);
}

const DEP_FILES = [
  'package.json',
  'package-lock.json',
  'packages/xterm-zerolag-input/package.json',
  'packages/gesture-control/package.json',
];

async function originUrl(mainCheckout: string): Promise<string> {
  return (await git(['remote', 'get-url', 'origin'], mainCheckout)).trim();
}

/** A linked worktree from the first version of this file: `.git` is a FILE there. */
function isLegacyWorktree(dir: string): boolean {
  const dotGit = join(dir, '.git');
  try {
    return statSync(dotGit).isFile();
  } catch {
    return false;
  }
}

function isOwnClone(dir: string): boolean {
  try {
    return statSync(join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/** Fetch the PR head, (re)create the clone at it, and make node_modules usable. */
export async function preparePrWorktree(opts: {
  mainCheckout: string;
  worktreesDir: string;
  prNumber: number;
  /** Reset a reused clone to the fetched head (drops edits a follow-up may have made). */
  reset: boolean;
  log: Logger;
}): Promise<WorktreeInfo> {
  const { mainCheckout, worktreesDir, prNumber, log } = opts;
  const ref = prRef(prNumber);
  const dir = worktreeDirFor(worktreesDir, prNumber);
  mkdirSync(worktreesDir, { recursive: true });

  log(`fetching origin master + pull/${prNumber}/head`);
  await git(
    ['fetch', '--quiet', 'origin', `+refs/heads/master:${MASTER_REF}`, `+refs/pull/${prNumber}/head:${ref}`],
    mainCheckout,
    300_000
  );
  const headSha = (await git(['rev-parse', ref], mainCheckout)).trim();

  if (existsSync(dir) && isLegacyWorktree(dir)) {
    log(`replacing the linked worktree at ${dir} with a clone`);
    await git(['worktree', 'remove', '--force', dir], mainCheckout).catch(() =>
      rmSync(dir, { recursive: true, force: true })
    );
    await git(['worktree', 'prune'], mainCheckout);
  }
  if (existsSync(dir) && !isOwnClone(dir)) {
    log(`removing stale directory ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  }
  if (!existsSync(dir)) {
    log(`cloning (shared objects) into ${dir}`);
    await git(['clone', '--quiet', '--shared', '--no-checkout', mainCheckout, dir], mainCheckout, 300_000);
    // `origin` of the clone should mean GitHub, like everywhere else, not the main
    // checkout's path; the refs below are fetched from the main checkout by path.
    await git(['remote', 'set-url', 'origin', await originUrl(mainCheckout)], dir);
  }
  // Mirror the two refs from the main repository (objects are already reachable via
  // alternates, so this only moves refs). `+` because both can move backwards.
  await git(['fetch', '--quiet', mainCheckout, `+${MASTER_REF}:${MASTER_REF}`, `+${ref}:${ref}`], dir);
  const current = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir).catch(() => '')).trim();
  if (current !== headSha) {
    log(`checking out ${headSha.slice(0, 8)}${current ? ` (was ${current.slice(0, 8)})` : ''}`);
    await git(['checkout', '--quiet', '--detach', ref], dir);
  }
  if (opts.reset) {
    await git(['reset', '--hard', '--quiet', ref], dir);
  }

  const mergeBase = (await git(['merge-base', MASTER_REF, 'HEAD'], dir)).trim();
  const deps = await ensureDependencies({ mainCheckout, dir, ref, mergeBase, log });
  ensureVendorCopy(mainCheckout, dir, log);
  return { dir, headSha, mergeBase, deps };
}

/** Written into a clone's own node_modules once `npm ci` has finished; its absence means a half install. */
const INSTALL_MARKER = '.pr-bot-installed';

async function ensureDependencies(opts: {
  mainCheckout: string;
  dir: string;
  ref: string;
  mergeBase: string;
  log: Logger;
}): Promise<WorktreeInfo['deps']> {
  const { mainCheckout, dir, ref, mergeBase, log } = opts;
  const target = join(dir, 'node_modules');
  // Against the MERGE BASE, not master: master's own version bumps since the PR
  // branched would otherwise make every older PR look like a dependency change and
  // cost a full npm ci each. Only what the PR itself did to the dependency files counts.
  let depsChanged = false;
  try {
    await git(['diff', '--quiet', mergeBase, ref, '--', ...DEP_FILES], mainCheckout);
  } catch {
    depsChanged = true;
  }

  let existing = existsSync(target) || isSymlink(target) ? lstatSync(target) : null;
  if (existing?.isDirectory() && !existsSync(join(target, INSTALL_MARKER))) {
    // A real tree without the marker is an install that was interrupted (service
    // restart mid `npm ci`); never trust it.
    log('discarding an incomplete node_modules install');
    rmSync(target, { recursive: true, force: true });
    existing = null;
  }
  if (!depsChanged) {
    if (existing?.isSymbolicLink()) return 'linked';
    if (existing?.isDirectory()) return 'kept';
    symlinkSync(join(mainCheckout, 'node_modules'), target, 'dir');
    log('node_modules linked to the main checkout (dependencies unchanged by the PR)');
    return 'linked';
  }

  // The PR changes dependencies: a real install, and NEVER through the symlink.
  if (existing?.isSymbolicLink()) unlinkSync(target);
  if (existing?.isDirectory()) return 'kept';
  log('the PR changes dependencies: running npm ci in the clone (this can take minutes)');
  await execFileAsync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    timeout: 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(join(target, INSTALL_MARKER), new Date().toISOString());
  return 'installed';
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureVendorCopy(mainCheckout: string, dir: string, log: Logger): void {
  const rel = join('src', 'web', 'public', 'vendor');
  const src = join(mainCheckout, rel);
  const dst = join(dir, rel);
  if (!existsSync(src)) return;
  // Two of the vendor files are tracked in git, so the directory already exists in a
  // fresh checkout; copy whatever is MISSING (the postinstall-built xterm bundles).
  mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(src)) {
    const target = join(dst, entry);
    if (existsSync(target)) continue;
    cpSync(join(src, entry), target, { recursive: true });
    copied++;
  }
  if (copied) log(`${copied} vendor bundle(s) copied from the main checkout`);
}

export async function removePrWorktree(opts: {
  mainCheckout: string;
  worktreesDir: string;
  prNumber: number;
  log: Logger;
}): Promise<void> {
  const dir = worktreeDirFor(opts.worktreesDir, opts.prNumber);
  if (existsSync(dir)) {
    opts.log(`removing ${dir}`);
    if (isLegacyWorktree(dir)) {
      await git(['worktree', 'remove', '--force', dir], opts.mainCheckout).catch(() => undefined);
      await git(['worktree', 'prune'], opts.mainCheckout).catch(() => undefined);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    await git(['update-ref', '-d', prRef(opts.prNumber)], opts.mainCheckout);
  } catch {
    // The ref may never have been created; nothing to delete.
  }
}
