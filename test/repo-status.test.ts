/**
 * @fileoverview Unit tests for the repository-status pure helpers: ahead/behind
 * + log + symref parsing, env parsing, and the remote-set / role decisions.
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
  resolveRemoteSet,
  roleForRemote,
  isSafeGitPositional,
} from '../src/web/repo-status.js';

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
