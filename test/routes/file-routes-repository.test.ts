/**
 * @fileoverview Repository-aware File Viewer route tests.
 *
 * Uses app.inject() with a real temporary Git repository; no HTTP port needed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

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

describe('file-routes repository browsing', () => {
  let fixtureRoot: string;
  let repositoryRoot: string;
  let harness: RouteTestHarness;

  beforeEach(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'codeman-file-routes-git-'));
    repositoryRoot = join(fixtureRoot, 'repository');
    mkdirSync(repositoryRoot);
    mkdirSync(join(repositoryRoot, 'src'));
    git(repositoryRoot, 'init', '-b', 'main');
    git(repositoryRoot, 'config', 'user.name', 'Codeman Test');
    git(repositoryRoot, 'config', 'user.email', 'codeman@example.invalid');
    writeFileSync(join(repositoryRoot, 'README.md'), 'initial\n');
    writeFileSync(join(repositoryRoot, 'src', 'app.ts'), 'export const initial = true;\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'initial commit');
    writeFileSync(join(repositoryRoot, 'README.md'), 'initial\nchanged\n');

    harness = await createRouteTestHarness(registerFileRoutes);
    harness.ctx._session.workingDir = join(repositoryRoot, 'src');
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('returns repository metadata and roots the scoped file tree at the worktree', async () => {
    const repositoryResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/repository?scope=current`,
    });
    expect(repositoryResponse.statusCode).toBe(200);
    const repository = repositoryResponse.json();
    expect(repository).toMatchObject({
      success: true,
      data: {
        available: true,
        repositoryRoot,
      },
    });
    expect(repository.data.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'README.md', status: 'modified' })])
    );

    const filesResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?scope=current&depth=2`,
    });
    const files = filesResponse.json();
    expect(files.success).toBe(true);
    expect(files.data.root).toBe(repositoryRoot);
    expect(files.data.tree).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'README.md', type: 'file' })])
    );
  });

  it('uses the same worktree scope for file content and diff detail', async () => {
    const legacyResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=README.md`,
    });
    expect(legacyResponse.json().success).toBe(false);

    const scopedResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=README.md&scope=current`,
    });
    expect(scopedResponse.json()).toMatchObject({
      success: true,
      data: {
        content: 'initial\nchanged\n',
      },
    });

    const diffResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/repository/diff?scope=current&path=README.md`,
    });
    expect(diffResponse.json()).toMatchObject({
      success: true,
      data: {
        beforeContent: 'initial\n',
        afterContent: 'initial\nchanged\n',
        additions: 1,
      },
    });
  });

  it('rejects a forged worktree scope', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?scope=forged&depth=2`,
    });
    expect(response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('scope not found'),
    });
  });
});
