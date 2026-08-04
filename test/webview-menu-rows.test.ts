/**
 * @fileoverview Frontend test for the "Web / URL" rows in the Run dropdown
 * (webview-tabs.js).
 *
 * A saved URL used to render as a single open-button, so the ONLY way to remove one
 * was to open it as a tab and go through the tab's gear, which is a dead end for a
 * URL you no longer want open. These pin the per-row edit/delete affordance and the
 * delete path behind it, because a UI affordance is exactly the kind of thing a
 * later render refactor drops silently.
 *
 * Builds a JSDOM window in-test under the default node env, same shape as
 * test/admin-ui.test.ts. Do NOT declare a per-file jsdom environment: it
 * externalizes node:fs under vite and the readFileSync calls below stop working.
 * ⚠ Do not name that directive in a comment either, vitest matches the string
 * anywhere in the file.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const CONSTANTS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const WEBVIEW_TABS = readFileSync(new URL('../src/web/public/webview-tabs.js', import.meta.url), 'utf-8');

interface AppLike {
  webviews: Map<string, { id: string; name: string; url: string; icon?: string }>;
  webviewOrder: string[];
  activeWebviewId: string | null;
  renderWebviewMenuItems(): void;
  renderSessionTabs(): void;
  deleteWebviewById(id: string): Promise<void>;
  _confirmAndDeleteWebview(id: string): Promise<boolean>;
  _removeWebviewTab(id: string): void;
  _apiDelete(path: string): Promise<{ ok: boolean } | null>;
  showToast?: (msg: string, kind: string) => void;
  showWebviewModal(id?: string): void;
}

function boot(deleteOk = true) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <div class="run-mode-menu active" id="runModeMenu">
        <div class="run-mode-webviews" id="runModeWebviews"></div>
      </div>
      <div id="sessionTabs"></div>
      <div id="webviewLayer"></div>
    </body>`,
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window as unknown as Window &
    typeof globalThis & { app: AppLike; CodemanApp: new () => AppLike; confirm: () => boolean };

  // webview-tabs.js is a prototype mixin, so it needs the class it extends plus the
  // escapeHtml global from constants.js. Everything else it touches is stubbed.
  // One eval, not three: lexical declarations in a global eval do not survive into
  // the next one, and the class must be a window property for the same reason.
  (win as unknown as { eval: (s: string) => void }).eval(
    ['window.CodemanApp = class CodemanApp {};', CONSTANTS, WEBVIEW_TABS].join('\n')
  );

  const deleted: string[] = [];
  const app = new win.CodemanApp();
  app.webviews = new Map([
    ['id-a', { id: 'id-a', name: 'Bio Dashboard', url: 'https://box.ts.net:4000', icon: '📈' }],
    ['id-b', { id: 'id-b', name: 'Grafana', url: 'http://127.0.0.1:3000/d/x' }],
  ]);
  app.webviewOrder = [];
  app.activeWebviewId = null;
  app.renderSessionTabs = () => {};
  app._apiDelete = async (path: string) => {
    deleted.push(path);
    return deleteOk ? { ok: true } : { ok: false };
  };
  win.app = app;
  win.confirm = () => true;
  app.renderWebviewMenuItems();
  return { dom, win, app, deleted };
}

const rows = (win: Window) => win.document.querySelectorAll('#runModeWebviews .run-mode-row--web');

describe('Run dropdown Web/URL rows', () => {
  it('gives every saved URL an open, edit and delete control', () => {
    const { win } = boot();
    expect(rows(win)).toHaveLength(2);
    expect(win.document.querySelectorAll('#runModeWebviews .run-mode-option--web')).toHaveLength(2);
    expect(win.document.querySelectorAll('#runModeWebviews .run-mode-webview-edit')).toHaveLength(2);
    expect(win.document.querySelectorAll('#runModeWebviews .run-mode-webview-delete')).toHaveLength(2);
  });

  it('escapes the name and url rather than interpolating them raw', () => {
    const { win, app } = boot();
    const name = '<img src=x onerror=alert(1)>';
    const url = 'https://h/"onmouseover="x';
    app.webviews.set('id-x', { id: 'id-x', name, url });
    app.renderWebviewMenuItems();

    // Assert on the DOM, not on innerHTML: attribute serialization does not
    // re-escape `<`, so a string check reads as a breakout when there is none.
    expect(win.document.querySelectorAll('#runModeWebviews img')).toHaveLength(0);
    const row = rows(win)[2];
    expect(row.querySelector('.run-mode-option--web')!.textContent).toContain(name);
    expect(row.querySelector('.run-mode-option--web')!.getAttribute('title')).toBe(url);
    expect(row.querySelector('.run-mode-webview-delete')!.getAttribute('aria-label')).toBe(`Delete ${name}`);
  });

  it('stops the delete click from also opening the dashboard', () => {
    const { win, app } = boot();
    let opened = 0;
    (app as unknown as { openWebviewFromMenu: () => void }).openWebviewFromMenu = () => {
      opened++;
    };
    const del = win.document.querySelector<HTMLElement>('#runModeWebviews .run-mode-webview-delete')!;
    expect(del.getAttribute('onclick')).toContain('event.stopPropagation()');
    del.click();
    expect(opened).toBe(0);
  });

  it('deletes server-side and drops the row, leaving the menu open', async () => {
    const { win, app, deleted } = boot();
    app._removeWebviewTab = () => {};
    await app.deleteWebviewById('id-a');
    expect(deleted).toEqual(['/api/webviews/id-a']);
    expect(app.webviews.has('id-a')).toBe(false);
    expect(rows(win)).toHaveLength(1);
    // Deleting one of several URLs should leave you looking at the rest of the list.
    expect(win.document.getElementById('runModeMenu')!.classList.contains('active')).toBe(true);
  });

  it('does nothing when the confirm is declined', async () => {
    const { win, app, deleted } = boot();
    win.confirm = () => false;
    await app.deleteWebviewById('id-a');
    expect(deleted).toEqual([]);
    expect(app.webviews.has('id-a')).toBe(true);
    expect(rows(win)).toHaveLength(2);
  });

  it('keeps the row and warns when the server refuses the delete', async () => {
    const { win, app } = boot(false);
    const toast = vi.fn();
    app.showToast = toast;
    app._removeWebviewTab = () => {};
    await app.deleteWebviewById('id-a');
    expect(toast).toHaveBeenCalledWith('Could not delete URL', 'error');
    expect(app.webviews.has('id-a')).toBe(true);
    expect(rows(win)).toHaveLength(2);
  });

  it('still renders the empty state when nothing is saved', () => {
    const { win, app } = boot();
    app.webviews.clear();
    app.renderWebviewMenuItems();
    expect(rows(win)).toHaveLength(0);
    expect(win.document.querySelector('.run-mode-empty')).toBeTruthy();
  });
});
