/**
 * @fileoverview Tests for OMP session-id resolution from disk.
 *
 * Pins the home-relative directory mangling bug found 2026-08-27: omp
 * collapses a home-relative workingDir to its home-relative remainder BEFORE
 * dash-replacing (`/home/user/dev/foo` -> `-dev-foo`), unlike Claude Code's
 * `~/.claude/projects/*` convention (`-home-user-dev-foo`) this module was
 * originally written to mirror. Getting this wrong doesn't throw — it just
 * makes findLatestOmpSessionId() silently return null for every case under
 * $HOME (virtually all real Codeman cases), so continuation pinning quietly
 * degraded to omp's own ambiguous `--continue` while appearing to work in
 * manual testing done entirely under /tmp (which sits outside $HOME and was
 * mangled correctly by coincidence).
 *
 * test/setup.ts gives this file its own temp $HOME, so homedir() below is
 * already sandboxed — writing real files under it is safe and exercises the
 * exact home-relative path the bug hid behind.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findLatestOmpSessionId, mangleOmpWorkingDir } from '../src/utils/omp-session-resolver.js';

describe('mangleOmpWorkingDir', () => {
  it('strips the home prefix before dash-replacing a home-relative path', () => {
    const home = homedir();
    expect(mangleOmpWorkingDir(join(home, 'codeman-cases', 'testcase'))).toBe('-codeman-cases-testcase');
  });

  it('dash-replaces a path outside $HOME as-is', () => {
    expect(mangleOmpWorkingDir('/tmp/omp-verify-case')).toBe('-tmp-omp-verify-case');
  });

  it('treats workingDir === home as the empty remainder', () => {
    expect(mangleOmpWorkingDir(homedir())).toBe('');
  });

  it('does not false-positive on a sibling directory sharing a prefix with $HOME', () => {
    const sibling = `${homedir()}-other/dev/foo`;
    expect(mangleOmpWorkingDir(sibling)).toBe(sibling.replace(/\//g, '-'));
  });
});

describe('findLatestOmpSessionId', () => {
  const sessionDir = join(homedir(), '.omp', 'agent', 'sessions', '-codeman-cases-testcase');

  afterEach(() => {
    rmSync(join(homedir(), '.omp'), { recursive: true, force: true });
  });

  it('finds the newest session file under a home-relative workingDir', () => {
    const workingDir = join(homedir(), 'codeman-cases', 'testcase');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '2026-08-27T17-15-57-989Z_older-id.jsonl'), '{}');
    const newer = join(sessionDir, '2026-08-27T17-31-08-001Z_newer-id.jsonl');
    writeFileSync(newer, '{}');
    // Force a deterministic mtime order regardless of filesystem timestamp resolution.
    const now = Date.now() / 1000;
    utimesSync(join(sessionDir, '2026-08-27T17-15-57-989Z_older-id.jsonl'), now, now);
    utimesSync(newer, now + 1, now + 1);

    expect(findLatestOmpSessionId(workingDir)).toBe('newer-id');
  });

  it('returns null when the mangled directory does not exist', () => {
    expect(findLatestOmpSessionId(join(homedir(), 'never-launched'))).toBeNull();
  });
});
