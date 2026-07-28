/**
 * Repository-aware File Viewer browser tests.
 *
 * Port 3211 is reserved in helpers/constants.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { PORTS } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';

const PORT = PORTS.FILE_VIEWER;
const BASE_URL = `http://localhost:${PORT}`;

describe('Mobile File Viewer', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let page: Page;
  let context: BrowserContext;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await stopTestServer(server);
    await closeAllBrowsers();
  });

  beforeEach(async () => {
    const result = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL, 'chromium');
    page = result.page;
    context = result.context;
  });

  afterEach(async () => {
    await page
      .evaluate(() => {
        const testWindow = window as typeof window & {
          __fileViewerOriginalFetch?: typeof window.fetch;
        };
        if (testWindow.__fileViewerOriginalFetch) {
          window.fetch = testWindow.__fileViewerOriginalFetch;
          delete testWindow.__fileViewerOriginalFetch;
        }
        if (app.fileBrowserAutoRefreshTimer) {
          clearInterval(app.fileBrowserAutoRefreshTimer);
          app.fileBrowserAutoRefreshTimer = null;
        }
        app.closeFilePreview();
      })
      .catch(() => {});
    await context.close();
  });

  it('keeps a rapid tab switch on the new session and defaults to its worktree root', async () => {
    const state = await page.evaluate(async () => {
      const testWindow = window as typeof window & {
        __fileViewerOriginalFetch?: typeof window.fetch;
      };
      testWindow.__fileViewerOriginalFetch = window.fetch;

      const repository = (session: string) => ({
        success: true,
        data: {
          available: true,
          repositoryRoot: `/repos/${session}`,
          selectedScopeId: `${session}-current`,
          worktrees: [
            {
              id: `${session}-current`,
              path: `/repos/${session}`,
              name: session,
              branch: 'main',
              head: 'a'.repeat(40),
              current: true,
              main: true,
              locked: false,
            },
            {
              id: `${session}-sibling`,
              path: `/worktrees/${session}-feature`,
              name: `${session}-feature`,
              branch: 'feature/mobile',
              head: 'b'.repeat(40),
              current: false,
              main: false,
              locked: false,
            },
          ],
          changes: [],
          commits: [],
        },
      });
      const files = (session: string) => ({
        success: true,
        data: {
          root: `/repos/${session}`,
          tree: [
            {
              name: `${session}.txt`,
              path: `${session}.txt`,
              type: 'file',
              size: 12,
              extension: 'txt',
            },
          ],
          totalFiles: 1,
          totalDirectories: 0,
          truncated: false,
        },
      });

      window.fetch = async (input) => {
        const url = String(input);
        const session = url.includes('session-a') ? 'session-a' : 'session-b';
        await new Promise((resolve) => setTimeout(resolve, session === 'session-a' ? 100 : 5));
        const payload = url.includes('/repository?') ? repository(session) : files(session);
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      app.fileBrowserData = null;
      app.fileBrowserSessionId = null;
      app.fileBrowserView = 'files';
      app.activeSessionId = 'session-a';
      const firstLoad = app.loadFileBrowser('session-a');
      app.activeSessionId = 'session-b';
      const secondLoad = app.loadFileBrowser('session-b');
      await Promise.allSettled([firstLoad, secondLoad]);

      const settings = app.loadAppSettingsFromStorage();
      settings.showFileViewerButton = true;
      app.saveAppSettingsToStorage(settings);
      app.applyHeaderVisibilitySettings();
      const fileViewerButton = document.querySelector('.btn-file-viewer');
      const scope = document.getElementById('fileBrowserScope') as HTMLSelectElement;
      return {
        sessionId: app.fileBrowserSessionId,
        scopeId: app.fileBrowserScopeId,
        root: app.fileBrowserData?.root,
        treeText: document.getElementById('fileBrowserTree')?.textContent,
        scopeOptions: Array.from(scope.options).map((option) => option.textContent),
        selectedScope: scope.value,
        fileViewerVisible: fileViewerButton ? getComputedStyle(fileViewerButton).display !== 'none' : false,
      };
    });

    expect(state).toMatchObject({
      sessionId: 'session-b',
      scopeId: 'session-b-current',
      root: '/repos/session-b',
      selectedScope: 'session-b-current',
      fileViewerVisible: true,
    });
    expect(state.treeText).toContain('session-b.txt');
    expect(state.treeText).not.toContain('session-a.txt');
    expect(state.scopeOptions).toHaveLength(2);
    expect(state.scopeOptions[0]).toContain('(root)');
    expect(state.scopeOptions[1]).toContain('(worktree)');
  });

  it('updates repository ownership immediately when switching sessions with the viewer open or closed', async () => {
    const state = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      const originalLoadFileBrowser = app.loadFileBrowser;
      const loads: string[] = [];

      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/terminal?')) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const sessionId = url.split('/')[3];
          return new Response(
            JSON.stringify({
              data: {
                terminalBuffer: `${sessionId} ready`,
                truncated: false,
              },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        return originalFetch(input, init);
      };
      app.loadFileBrowser = async (sessionId: string) => {
        loads.push(sessionId);
      };

      for (const sessionId of ['file-view-a', 'file-view-b']) {
        app.sessions.set(sessionId, {
          id: sessionId,
          name: sessionId,
          mode: 'shell',
          status: 'idle',
          pid: 1,
          workingDir: `/repos/${sessionId}`,
        });
      }
      app.sessionOrder = ['file-view-a', 'file-view-b'];
      app._initialFullBufferLoad = false;
      app.activeSessionId = 'file-view-a';
      app.fileBrowserSessionId = 'file-view-a';
      app.fileBrowserScopeId = 'file-view-a-scope';

      const panel = document.getElementById('fileBrowserPanel')!;
      panel.classList.add('visible');
      const settings = app.loadAppSettingsFromStorage();
      settings.showFileBrowser = true;
      app.saveAppSettingsToStorage(settings);

      const openSwitch = app.selectSession('file-view-b');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const openState = {
        activeSessionId: app.activeSessionId,
        fileBrowserSessionId: app.fileBrowserSessionId,
        scopeId: app.fileBrowserScopeId,
        loads: [...loads],
      };
      await openSwitch;

      panel.classList.remove('visible');
      settings.showFileBrowser = false;
      app.saveAppSettingsToStorage(settings);
      app.fileBrowserSessionId = 'file-view-b';
      app.fileBrowserScopeId = 'file-view-b-scope';

      const closedSwitch = app.selectSession('file-view-a');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const closedState = {
        activeSessionId: app.activeSessionId,
        fileBrowserSessionId: app.fileBrowserSessionId,
        scopeId: app.fileBrowserScopeId,
        loads: [...loads],
      };
      await closedSwitch;

      window.fetch = originalFetch;
      app.loadFileBrowser = originalLoadFileBrowser;

      return { openState, closedState };
    });

    expect(state.openState).toMatchObject({
      activeSessionId: 'file-view-b',
      fileBrowserSessionId: 'file-view-b',
      scopeId: 'current',
      loads: ['file-view-b'],
    });
    expect(state.closedState).toMatchObject({
      activeSessionId: 'file-view-a',
      fileBrowserSessionId: 'file-view-a',
      scopeId: 'current',
      loads: ['file-view-b'],
    });
  });

  it('reassigns the active session work path and reloads the repository at current scope', async () => {
    const state = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      const requests: Array<{ url: string; method: string; body?: string }> = [];
      window.fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || 'GET';
        requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
        if (url.endsWith('/working-directory')) {
          return new Response(JSON.stringify({ success: true, data: { workingDir: '/repos/reassigned' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const repository = {
          success: true,
          data: {
            available: true,
            repositoryRoot: '/repos/reassigned',
            selectedScopeId: 'reassigned-current',
            worktrees: [
              {
                id: 'reassigned-current',
                path: '/repos/reassigned',
                name: 'reassigned',
                branch: 'main',
                head: 'a'.repeat(40),
                current: true,
                main: true,
                locked: false,
              },
            ],
            changes: [],
            commits: [],
          },
        };
        const files = {
          success: true,
          data: {
            root: '/repos/reassigned',
            tree: [],
            totalFiles: 0,
            totalDirectories: 0,
            truncated: false,
          },
        };
        return new Response(JSON.stringify(url.includes('/repository?') ? repository : files), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      app.sessions.set('workdir-session', {
        id: 'workdir-session',
        name: 'Workspace',
        mode: 'claude',
        status: 'idle',
        pid: 1,
        workingDir: '/repos/stale',
      });
      app.activeSessionId = 'workdir-session';
      app.fileBrowserSessionId = 'workdir-session';
      document.getElementById('fileBrowserPanel')?.classList.add('visible');

      app.openFileBrowserWorkingDirectoryEditor();
      const modal = document.getElementById('workingDirectoryModal')!;
      const input = document.getElementById('workingDirectoryInput') as HTMLInputElement;
      const initialValue = input.value;
      input.value = '/repos/reassigned';
      await app.saveFileBrowserWorkingDirectory(new Event('submit'));

      const result = {
        initialValue,
        modalOpen: modal.classList.contains('active'),
        workingDir: app.sessions.get('workdir-session')?.workingDir,
        scopeId: app.fileBrowserScopeId,
        requests,
      };
      window.fetch = originalFetch;
      return result;
    });

    expect(state.initialValue).toBe('/repos/stale');
    expect(state.modalOpen).toBe(false);
    expect(state.workingDir).toBe('/repos/reassigned');
    expect(state.scopeId).toBe('reassigned-current');
    expect(state.requests[0]).toMatchObject({
      url: '/api/sessions/workdir-session/working-directory',
      method: 'PUT',
      body: JSON.stringify({ workingDir: '/repos/reassigned' }),
    });
    expect(state.requests.some((request) => request.url.includes('/repository?scope=current'))).toBe(true);
  });

  it('renders current changes and switches between compact and full diff on a phone', async () => {
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __fileViewerOriginalFetch?: typeof window.fetch;
      };
      testWindow.__fileViewerOriginalFetch = window.fetch;
      window.fetch = async (input) => {
        const url = String(input);
        if (!url.includes('/repository/diff?')) {
          throw new Error(`Unexpected URL: ${url}`);
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              path: 'src/app.ts',
              commit: null,
              label: 'Working tree · src/app.ts',
              patch:
                'diff --git a/src/app.ts b/src/app.ts\n' +
                '--- a/src/app.ts\n' +
                '+++ b/src/app.ts\n' +
                '@@ -1,2 +1,3 @@\n' +
                ' alpha\n' +
                '-old\n' +
                '+new\n' +
                '+extra\n',
              beforeContent: 'alpha\nold\n',
              afterContent: 'alpha\nnew\nextra\n',
              beforeExists: true,
              afterExists: true,
              binary: false,
              truncated: false,
              additions: 2,
              deletions: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      app.activeSessionId = 'diff-session';
      app.fileBrowserSessionId = 'diff-session';
      app.fileBrowserScopeId = 'scope-diff';
      app.fileBrowserRepositoryData = {
        available: true,
        repositoryRoot: '/repo',
        selectedScopeId: 'scope-diff',
        worktrees: [
          {
            id: 'scope-diff',
            path: '/repo',
            name: 'repo',
            branch: 'main',
            head: 'a'.repeat(40),
            current: true,
            main: true,
            locked: false,
          },
        ],
        changes: [
          {
            path: 'src/app.ts',
            code: 'M',
            status: 'modified',
            staged: false,
            unstaged: true,
            additions: 2,
            deletions: 1,
            binary: false,
          },
        ],
        commits: [],
      };
      document.getElementById('fileBrowserPanel')?.classList.add('visible');
      app.switchFileBrowserView('changes');
    });

    await expect.poll(() => page.locator('.repo-change-row').count()).toBe(1);
    await expect.poll(() => page.locator('#fileBrowserChangesCount').textContent()).toBe('1');
    await page.locator('.repo-change-row').click();
    await expect.poll(() => page.locator('.repository-diff').isVisible()).toBe(true);
    await expect.poll(() => page.locator('.repository-diff-line.diff-add').count()).toBe(2);
    await expect.poll(() => page.locator('.repository-diff-line.diff-del').count()).toBe(1);

    await page.locator('.file-preview-mode-btn[data-mode="full"]').click();
    await expect.poll(() => page.locator('.repository-diff-full').isVisible()).toBe(true);
    await expect.poll(() => page.locator('#filePreviewBody').textContent()).toContain('alpha');
    await expect.poll(() => page.locator('#filePreviewBody').textContent()).toContain('old');
    await expect.poll(() => page.locator('#filePreviewBody').textContent()).toContain('new');

    const bounds = await page.evaluate(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const panel = document.getElementById('fileBrowserPanel')!.getBoundingClientRect();
      const preview = document.querySelector('.file-preview-window')!.getBoundingClientRect();
      return {
        viewport,
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
        preview: {
          left: preview.left,
          right: preview.right,
          top: preview.top,
          bottom: preview.bottom,
        },
      };
    });
    expect(bounds.panel.left).toBeGreaterThanOrEqual(0);
    expect(bounds.panel.right).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.panel.bottom).toBeLessThanOrEqual(bounds.viewport.height);
    expect(bounds.preview.left).toBeGreaterThanOrEqual(0);
    expect(bounds.preview.right).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.preview.bottom).toBeLessThanOrEqual(bounds.viewport.height);
  });

  it('expands commit history and opens a committed file diff', async () => {
    const commit = 'c'.repeat(40);
    await page.evaluate((commitHash) => {
      const testWindow = window as typeof window & {
        __fileViewerOriginalFetch?: typeof window.fetch;
      };
      testWindow.__fileViewerOriginalFetch = window.fetch;
      window.fetch = async (input) => {
        const url = String(input);
        const payload = url.includes('/repository/commit?')
          ? {
              success: true,
              data: {
                hash: commitHash,
                shortHash: commitHash.slice(0, 8),
                author: 'Agent',
                authoredAt: '2026-07-27T10:00:00Z',
                subject: 'Add mobile history',
                changes: [
                  {
                    path: 'src/history.ts',
                    code: 'A',
                    status: 'added',
                    staged: true,
                    unstaged: false,
                    additions: null,
                    deletions: null,
                    binary: false,
                  },
                ],
              },
            }
          : {
              success: true,
              data: {
                path: 'src/history.ts',
                commit: commitHash,
                label: `${commitHash.slice(0, 8)} · src/history.ts`,
                patch:
                  'diff --git a/src/history.ts b/src/history.ts\n' +
                  '--- /dev/null\n' +
                  '+++ b/src/history.ts\n' +
                  '@@ -0,0 +1 @@\n' +
                  '+export const history = true;\n',
                beforeContent: null,
                afterContent: 'export const history = true;\n',
                beforeExists: false,
                afterExists: true,
                binary: false,
                truncated: false,
                additions: 1,
                deletions: 0,
              },
            };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      app.activeSessionId = 'history-session';
      app.fileBrowserSessionId = 'history-session';
      app.fileBrowserScopeId = 'scope-history';
      app.fileBrowserCommitCache.clear();
      app.fileBrowserExpandedCommit = null;
      app.fileBrowserRepositoryData = {
        available: true,
        repositoryRoot: '/repo',
        selectedScopeId: 'scope-history',
        worktrees: [
          {
            id: 'scope-history',
            path: '/repo',
            name: 'repo',
            branch: 'main',
            head: commitHash,
            current: true,
            main: true,
            locked: false,
          },
        ],
        changes: [],
        commits: [
          {
            hash: commitHash,
            shortHash: commitHash.slice(0, 8),
            author: 'Agent',
            authoredAt: '2026-07-27T10:00:00Z',
            subject: 'Add mobile history',
          },
        ],
      };
      document.getElementById('fileBrowserPanel')?.classList.add('visible');
      app.switchFileBrowserView('history');
    }, commit);

    await expect.poll(() => page.locator('.repo-commit-summary').textContent()).toContain('Add mobile history');
    await page.locator('.repo-commit-summary').click();
    await expect.poll(() => page.locator('.repo-commit-file').textContent()).toContain('src/history.ts');
    await page.locator('.repo-commit-file').click();
    await expect.poll(() => page.locator('#filePreviewFooter').textContent()).toContain(commit.slice(0, 8));
    await expect.poll(() => page.locator('.repository-diff-line.diff-add').count()).toBe(1);
  });
});
