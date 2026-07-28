import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverGitRepository,
  getGitCommitDetails,
  getGitDiffDetail,
  getGitRepositoryOverview,
  resolveRepositoryBrowseRoot,
} from '../src/git-repository-browser.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

describe('git-repository-browser', () => {
  let fixtureRoot: string;
  let mainWorktree: string;
  let featureWorktree: string;
  let nestedWorkingDir: string;
  let initialCommit: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'codeman-git-browser-'));
    mainWorktree = join(fixtureRoot, 'main-repo');
    featureWorktree = join(fixtureRoot, 'feature-worktree');
    mkdirSync(mainWorktree);

    git(mainWorktree, 'init', '-b', 'main');
    git(mainWorktree, 'config', 'user.name', 'Codeman Test');
    git(mainWorktree, 'config', 'user.email', 'codeman@example.invalid');
    mkdirSync(join(mainWorktree, 'src'));
    writeFileSync(join(mainWorktree, 'README.md'), 'initial\n');
    writeFileSync(join(mainWorktree, 'src', 'app.ts'), 'export const value = 1;\n');
    git(mainWorktree, 'add', '.');
    git(mainWorktree, 'commit', '-m', 'initial commit');
    initialCommit = git(mainWorktree, 'rev-parse', 'HEAD');

    git(mainWorktree, 'worktree', 'add', '-b', 'feature/mobile-view', featureWorktree);
    nestedWorkingDir = join(featureWorktree, 'src');
    writeFileSync(join(featureWorktree, 'README.md'), 'initial\nmobile change\n');
    writeFileSync(join(featureWorktree, 'new note.md'), 'untracked line\n');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('discovers the repository root and sibling worktrees from a nested session path', async () => {
    const repository = await discoverGitRepository(nestedWorkingDir);

    expect(repository).not.toBeNull();
    expect(repository?.repositoryRoot).toBe(mainWorktree);
    expect(repository?.worktrees).toHaveLength(2);
    expect(repository?.worktrees.find((worktree) => worktree.main)?.path).toBe(mainWorktree);
    expect(repository?.worktrees.find((worktree) => worktree.current)).toMatchObject({
      path: featureWorktree,
      branch: 'feature/mobile-view',
    });
    await expect(resolveRepositoryBrowseRoot(nestedWorkingDir, 'current')).resolves.toBe(featureWorktree);
  });

  it('returns compact current changes, commit history, and lazy diff content', async () => {
    renameSync(join(featureWorktree, 'src', 'app.ts'), join(featureWorktree, 'src', 'mobile app.ts'));
    git(featureWorktree, 'add', '-A', 'src');
    const overview = await getGitRepositoryOverview(nestedWorkingDir, 'current');

    expect(overview.available).toBe(true);
    expect(overview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'README.md', status: 'modified', code: 'M' }),
        expect.objectContaining({ path: 'new note.md', status: 'untracked', code: '?' }),
        expect.objectContaining({
          path: 'src/mobile app.ts',
          oldPath: 'src/app.ts',
          status: 'renamed',
          code: 'R',
        }),
      ])
    );
    expect(overview.commits[0]).toMatchObject({
      hash: initialCommit,
      subject: 'initial commit',
      author: 'Codeman Test',
    });

    const trackedDiff = await getGitDiffDetail(nestedWorkingDir, 'current', 'README.md');
    expect(trackedDiff).toMatchObject({
      path: 'README.md',
      beforeContent: 'initial\n',
      afterContent: 'initial\nmobile change\n',
      additions: 1,
      deletions: 0,
      binary: false,
    });
    expect(trackedDiff.patch).toContain('+mobile change');

    const untrackedDiff = await getGitDiffDetail(nestedWorkingDir, 'current', 'new note.md');
    expect(untrackedDiff.beforeExists).toBe(false);
    expect(untrackedDiff.afterContent).toBe('untracked line\n');
    expect(untrackedDiff.additions).toBe(1);
    expect(untrackedDiff.patch).toContain('--- /dev/null');

    const renamedDiff = await getGitDiffDetail(nestedWorkingDir, 'current', 'src/mobile app.ts');
    expect(renamedDiff).toMatchObject({
      oldPath: 'src/app.ts',
      beforeContent: 'export const value = 1;\n',
      afterContent: 'export const value = 1;\n',
    });
  });

  it('loads commit file changes and rejects scopes or paths outside the repository', async () => {
    const details = await getGitCommitDetails(nestedWorkingDir, 'current', initialCommit);
    expect(details.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'README.md', status: 'added' }),
        expect.objectContaining({ path: 'src/app.ts', status: 'added' }),
      ])
    );

    const committedDiff = await getGitDiffDetail(nestedWorkingDir, 'current', 'src/app.ts', initialCommit);
    expect(committedDiff.afterContent).toBe('export const value = 1;\n');
    expect(committedDiff.beforeExists).toBe(false);

    await expect(resolveRepositoryBrowseRoot(nestedWorkingDir, 'forged-scope')).rejects.toThrow('scope not found');
    await expect(getGitDiffDetail(nestedWorkingDir, 'current', '../outside.txt')).rejects.toThrow(
      'outside the selected worktree'
    );
  });
});
