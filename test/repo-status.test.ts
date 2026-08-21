/**
 * @fileoverview Unit tests for the repository-status pure helpers: ahead/behind
 * + log + symref parsing, env parsing, the remote-set / role / tracking-remote
 * decisions, credential redaction of the returned fields, and the single-flight
 * TTL cache that keeps the async status computation off the git hot path.
 * No IO, no git, no port — safe to run individually.
 *
 * npm test -- test/repo-status.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  parseAheadBehind,
  parseLogLines,
  parseSymrefDefaultBranch,
  parseRemotesEnv,
  parseTrackingRemote,
  resolveRemoteSet,
  roleForRemote,
  isSafeGitPositional,
  redactRemoteStatus,
  createSingleFlightCache,
} from '../src/web/repo-status.js';
import { redactGitCredentials } from '../src/git-clone.js';
import type { RepoRemoteStatus } from '../src/types/update.js';

describe('parseAheadBehind', () => {
  it('parses tab-separated left/right counts as ahead/behind', () => {
    expect(parseAheadBehind('3\t14')).toEqual({ ahead: 3, behind: 14 });
  });
  it('parses space-separated counts', () => {
    expect(parseAheadBehind('0 0')).toEqual({ ahead: 0, behind: 0 });
  });
  it('tolerates surrounding whitespace/newline', () => {
    expect(parseAheadBehind('  5   2 \n')).toEqual({ ahead: 5, behind: 2 });
  });
  it('returns null on malformed output', () => {
    expect(parseAheadBehind('')).toBeNull();
    expect(parseAheadBehind('abc')).toBeNull();
    expect(parseAheadBehind('1')).toBeNull();
  });
});

describe('parseLogLines', () => {
  it('splits each line into sha + subject', () => {
    const out = 'a1b2c3 fix: thing\nd4e5f6 COD-9 add digest';
    expect(parseLogLines(out)).toEqual([
      { sha: 'a1b2c3', subject: 'fix: thing' },
      { sha: 'd4e5f6', subject: 'COD-9 add digest' },
    ]);
  });
  it('handles a subject with no space (sha only)', () => {
    expect(parseLogLines('deadbee')).toEqual([{ sha: 'deadbee', subject: '' }]);
  });
  it('ignores blank lines', () => {
    expect(parseLogLines('\n  \nabc123 hi\n')).toEqual([{ sha: 'abc123', subject: 'hi' }]);
  });
  it('returns [] for empty input', () => {
    expect(parseLogLines('')).toEqual([]);
  });
});

describe('parseSymrefDefaultBranch', () => {
  it('extracts the default branch from ls-remote --symref output', () => {
    const out = 'ref: refs/heads/master\tHEAD\n0123abc\tHEAD';
    expect(parseSymrefDefaultBranch(out)).toBe('master');
  });
  it('handles main', () => {
    expect(parseSymrefDefaultBranch('ref: refs/heads/main\tHEAD')).toBe('main');
  });
  it('returns null when no symref line present', () => {
    expect(parseSymrefDefaultBranch('0123abc\tHEAD')).toBeNull();
  });
  it('rejects a hostile branch that would smuggle a git flag (argv injection)', () => {
    // A malicious remote sets HEAD to a `-`-leading "branch"; the capture must
    // not start with `-`, so this yields null rather than `--upload-pack=...`.
    expect(parseSymrefDefaultBranch('ref: refs/heads/--upload-pack=touch\tHEAD')).toBeNull();
  });
});

describe('isSafeGitPositional', () => {
  it('accepts normal remote/branch names', () => {
    expect(isSafeGitPositional('origin')).toBe(true);
    expect(isSafeGitPositional('feature/foo')).toBe(true);
  });
  it('rejects flag-injecting and empty values', () => {
    expect(isSafeGitPositional('--upload-pack=touch /tmp/x')).toBe(false);
    expect(isSafeGitPositional('-x')).toBe(false);
    expect(isSafeGitPositional('')).toBe(false);
    expect(isSafeGitPositional(null)).toBe(false);
    expect(isSafeGitPositional(undefined)).toBe(false);
  });
});

describe('parseRemotesEnv', () => {
  it('splits comma list, trims, drops empties', () => {
    expect(parseRemotesEnv('origin, bitbucket ,, fork')).toEqual(['origin', 'bitbucket', 'fork']);
  });
  it('returns [] for null/undefined/empty', () => {
    expect(parseRemotesEnv(null)).toEqual([]);
    expect(parseRemotesEnv(undefined)).toEqual([]);
    expect(parseRemotesEnv('')).toEqual([]);
  });
});

describe('resolveRemoteSet', () => {
  it('defaults to tracking-remote first, then origin (the maintainer-fork layout)', () => {
    // local branch tracks bitbucket; origin is the canonical upstream.
    const set = resolveRemoteSet({
      existingRemotes: ['bitbucket', 'fork', 'origin'],
      trackingRemote: 'bitbucket',
      envRemotes: [],
    });
    expect(set).toEqual(['bitbucket', 'origin']);
  });

  it('collapses to a single entry when origin IS the tracking remote', () => {
    const set = resolveRemoteSet({
      existingRemotes: ['origin'],
      trackingRemote: 'origin',
      envRemotes: [],
    });
    expect(set).toEqual(['origin']);
  });

  it('falls back to just origin when there is no tracking remote', () => {
    const set = resolveRemoteSet({
      existingRemotes: ['origin', 'fork'],
      trackingRemote: null,
      envRemotes: [],
    });
    expect(set).toEqual(['origin']);
  });

  it('honors CODEMAN_UPDATE_REMOTES order and filters to existing remotes', () => {
    const set = resolveRemoteSet({
      existingRemotes: ['origin', 'bitbucket', 'fork'],
      trackingRemote: 'bitbucket',
      envRemotes: ['fork', 'origin', 'ghost'],
    });
    expect(set).toEqual(['fork', 'origin']); // 'ghost' dropped (does not exist)
  });

  it('returns [] when env names none of the existing remotes', () => {
    const set = resolveRemoteSet({
      existingRemotes: ['origin'],
      trackingRemote: null,
      envRemotes: ['nope'],
    });
    expect(set).toEqual([]);
  });
});

describe('roleForRemote', () => {
  it('labels the tracking remote as tracking even if named origin', () => {
    expect(roleForRemote('origin', 'origin')).toBe('tracking');
    expect(roleForRemote('bitbucket', 'bitbucket')).toBe('tracking');
  });
  it('labels origin/upstream (when not tracking) as upstream', () => {
    expect(roleForRemote('origin', 'bitbucket')).toBe('upstream');
    expect(roleForRemote('upstream', 'origin')).toBe('upstream');
  });
  it('labels anything else as other', () => {
    expect(roleForRemote('fork', 'bitbucket')).toBe('other');
  });
});

describe('parseTrackingRemote', () => {
  it('extracts the remote name from a remote-tracking short ref', () => {
    expect(parseTrackingRemote('origin/master')).toBe('origin');
    expect(parseTrackingRemote('bitbucket/feature/nested')).toBe('bitbucket');
  });
  it('returns null for a LOCAL-branch upstream (ref with no slash)', () => {
    // `git branch -u otherbranch` makes @{upstream} a bare branch name; the old
    // slice(0, indexOf('/')) turned "master" into "maste" here.
    expect(parseTrackingRemote('master')).toBeNull();
    expect(parseTrackingRemote('main')).toBeNull();
  });
  it('returns null for null/empty/degenerate refs', () => {
    expect(parseTrackingRemote(null)).toBeNull();
    expect(parseTrackingRemote(undefined)).toBeNull();
    expect(parseTrackingRemote('')).toBeNull();
    expect(parseTrackingRemote('/leading-slash')).toBeNull();
  });
});

describe('credential redaction', () => {
  it('redactGitCredentials masks scheme://user:secret@host pairs', () => {
    expect(redactGitCredentials('https://user:ghp_token123@github.com/o/r.git')).toBe(
      'https://***:***@github.com/o/r.git'
    );
    expect(redactGitCredentials('plain text, no url')).toBe('plain text, no url');
    expect(redactGitCredentials('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });

  it('redactRemoteStatus masks the url field', () => {
    const status: RepoRemoteStatus = {
      name: 'origin',
      url: 'https://alice:s3cret@example.com/repo.git',
      role: 'upstream',
      compareRef: 'origin/master',
      ahead: 1,
      behind: 2,
      incoming: [{ sha: 'abc', subject: 'hi' }],
    };
    const out = redactRemoteStatus(status);
    expect(out.url).toBe('https://***:***@example.com/repo.git');
    // Everything else passes through untouched.
    expect(out.name).toBe('origin');
    expect(out.compareRef).toBe('origin/master');
    expect(out.ahead).toBe(1);
    expect(out.behind).toBe(2);
    expect(out.incoming).toEqual([{ sha: 'abc', subject: 'hi' }]);
    expect(out.error).toBeUndefined();
  });

  it('redactRemoteStatus masks credentials echoed into the error string by git stderr', () => {
    const status: RepoRemoteStatus = {
      name: 'origin',
      url: 'https://alice:s3cret@example.com/repo.git',
      role: 'upstream',
      compareRef: '',
      ahead: 0,
      behind: 0,
      incoming: [],
      error: "Could not reach origin: fatal: unable to access 'https://alice:s3cret@example.com/repo.git/'",
    };
    const out = redactRemoteStatus(status);
    expect(out.error).toBe("Could not reach origin: fatal: unable to access 'https://***:***@example.com/repo.git/'");
    expect(out.error).not.toContain('s3cret');
    expect(out.url).not.toContain('s3cret');
  });
});

describe('createSingleFlightCache', () => {
  it('shares one in-flight computation across concurrent callers', async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const cache = createSingleFlightCache(60_000, () => {
      calls++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const a = cache.get();
    const b = cache.get();
    release('result');
    expect(await a).toBe('result');
    expect(await b).toBe('result');
    expect(calls).toBe(1);
  });

  it('serves a fresh-enough cached result without recomputing', async () => {
    let calls = 0;
    const cache = createSingleFlightCache(60_000, async () => ++calls);
    expect(await cache.get()).toBe(1);
    expect(await cache.get()).toBe(1);
    expect(calls).toBe(1);
  });

  it('recomputes once the TTL has elapsed', async () => {
    let calls = 0;
    const cache = createSingleFlightCache(60_000, async () => ++calls);
    expect(await cache.get()).toBe(1);
    // Inject a "now" past the TTL instead of sleeping.
    expect(await cache.get(Date.now() + 60_001)).toBe(2);
    expect(calls).toBe(2);
  });

  it('does not cache a rejected computation — the next call retries', async () => {
    let calls = 0;
    const cache = createSingleFlightCache(60_000, async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    });
    await expect(cache.get()).rejects.toThrow('boom');
    expect(await cache.get()).toBe('ok');
    expect(calls).toBe(2);
  });
});
