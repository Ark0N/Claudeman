/**
 * @fileoverview Frontend test for admin-ui.js (multi-user identity boot + admin
 * Users tab + change-password modal). Builds a JSDOM window in-test under the
 * default node env (constructing the DOM in-test avoids the vitest environment
 * comment-directive gotcha) and evaluates the real module against it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ADMIN_UI = readFileSync(new URL('../src/web/public/admin-ui.js', import.meta.url), 'utf-8');
const INDEX_HTML = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');

function resp(status: number, body: unknown) {
  const r = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    clone() {
      return r;
    },
  };
  return r;
}

async function bootWith(me: Record<string, unknown>) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <button id="adminPanelBtn" class="btn-admin-panel btn-admin-panel--hidden"></button>
      <div class="modal" id="appSettingsModal"><nav class="set-rail"><div class="set-rail-items"></div></nav><div class="set-doc" id="appSettingsDoc"></div></div>
    </body>`,
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window as unknown as Window & typeof globalThis & { __codemanUser?: Record<string, unknown> };
  win.fetch = (async (path: string) => {
    if (path === '/api/me') return resp(200, { success: true, data: me });
    if (path === '/api/admin/users') return resp(200, { success: true, data: [] });
    return resp(200, { success: true });
  }) as unknown as typeof fetch;
  (win as unknown as { eval: (s: string) => void }).eval(ADMIN_UI);
  // Let the async boot() (fetch /api/me → DOM inject) settle.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  return { dom, win };
}

describe('admin-ui boot', () => {
  it('exposes the identity and injects the Users section for a multi-user admin', async () => {
    const { win } = await bootWith({ username: 'root', role: 'admin', multiUser: true, mustChangePassword: false });
    expect(win.__codemanUser).toMatchObject({ username: 'root', role: 'admin', multiUser: true });
    // The settings modal is a rail over one document: a rail entry, not a tab.
    const btn = win.document.querySelector('[data-section="settings-users"]');
    expect(btn).toBeTruthy();
    expect(win.document.getElementById('settings-users')).toBeTruthy();
  });

  it('does NOT inject the Users section for a regular user', async () => {
    const { win } = await bootWith({ username: 'joe', role: 'user', multiUser: true, mustChangePassword: false });
    expect(win.document.querySelector('[data-section="settings-users"]')).toBeFalsy();
  });

  it('does NOT inject the Users tab in single-user mode', async () => {
    const { win } = await bootWith({ username: 'admin', role: 'admin', multiUser: false, mustChangePassword: false });
    expect(win.document.querySelector('[data-section="settings-users"]')).toBeFalsy();
  });

  it('shows the change-password modal when mustChangePassword is set', async () => {
    const { win } = await bootWith({ username: 'dave', role: 'user', multiUser: true, mustChangePassword: true });
    const modal = win.document.getElementById('changePasswordModal') as HTMLElement | null;
    expect(modal).toBeTruthy();
    expect(modal!.style.display).toBe('flex');
    // Forced: the cancel button is hidden.
    expect((modal!.querySelector('#cpCancel') as HTMLElement).style.display).toBe('none');
  });

  it('reveals the header Admin Panel button for a multi-user admin only', async () => {
    const hidden = (w: Window) =>
      w.document.getElementById('adminPanelBtn')!.classList.contains('btn-admin-panel--hidden');
    const a = await bootWith({ username: 'root', role: 'admin', multiUser: true, mustChangePassword: false });
    expect(hidden(a.win)).toBe(false);
    const b = await bootWith({ username: 'joe', role: 'user', multiUser: true, mustChangePassword: false });
    expect(hidden(b.win)).toBe(true);
    const c = await bootWith({ username: 'admin', role: 'admin', multiUser: false, mustChangePassword: false });
    expect(hidden(c.win)).toBe(true);
  });
});

describe('admin panel modal', () => {
  it('opens for an admin, renders users, and shows the case-folder drawer', async () => {
    const { win } = await bootWith({ username: 'root', role: 'admin', multiUser: true, mustChangePassword: false });
    win.fetch = (async (path: string) => {
      if (path === '/api/admin/users')
        return resp(200, {
          success: true,
          data: [
            {
              username: 'root',
              role: 'admin',
              disabled: false,
              mustChangePassword: false,
              canBypassPermissions: true,
              createdAt: 1,
              lastLoginAt: 2,
              stats: { liveSessions: 1, activeSessions: 2, caseCount: 1 },
            },
          ],
        });
      if (path === '/api/admin/users/root/cases')
        return resp(200, {
          success: true,
          data: { dir: '/tmp/spaces/root/cases', cases: [{ name: 'proj1', modifiedAt: 3, liveSessions: 0 }] },
        });
      return resp(200, { success: true });
    }) as unknown as typeof fetch;

    (win as unknown as { codemanAdmin: { openAdminPanel: () => void } }).codemanAdmin.openAdminPanel();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    const modal = win.document.getElementById('adminPanelModal') as HTMLElement;
    expect(modal).toBeTruthy();
    expect(modal.style.display).toBe('flex');
    expect(modal.querySelector('#apTable')!.textContent).toContain('root');

    (modal.querySelector('button[data-act="cases"]') as HTMLButtonElement).click();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    expect(modal.textContent).toContain('proj1');
    expect(modal.textContent).toContain('/tmp/spaces/root/cases');
  });

  it('does NOT open for a regular user', async () => {
    const { win } = await bootWith({ username: 'joe', role: 'user', multiUser: true, mustChangePassword: false });
    (win as unknown as { codemanAdmin: { openAdminPanel: () => void } }).codemanAdmin.openAdminPanel();
    expect(win.document.getElementById('adminPanelModal')).toBeFalsy();
  });
});

describe('index.html wiring', () => {
  it('loads admin-ui.js after settings-ui.js and before session-ui.js', () => {
    // Match the SCRIPT TAG, not the bare filename: modal markup earlier in the
    // document cites these modules in comments ("session-ui.js: openSessionOptions"),
    // and a bare indexOf finds the comment instead of the load order.
    const at = (file: string) => {
      const i = INDEX_HTML.indexOf(`src="${file}"`);
      expect(i, `no <script src="${file}"> in index.html`).toBeGreaterThan(-1);
      return i;
    };
    expect(at('admin-ui.js')).toBeGreaterThan(at('settings-ui.js'));
    expect(at('session-ui.js')).toBeGreaterThan(at('admin-ui.js'));
  });

  it('ships the header Admin Panel button hidden by default', () => {
    expect(INDEX_HTML).toContain('id="adminPanelBtn"');
    expect(INDEX_HTML).toContain('btn-admin-panel--hidden');
  });
});
