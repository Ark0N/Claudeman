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
      <div class="modal" id="appSettingsModal"><div class="modal-tabs"></div><div class="modal-body"></div></div>
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
  it('exposes the identity and injects the Users tab for a multi-user admin', async () => {
    const { win } = await bootWith({ username: 'root', role: 'admin', multiUser: true, mustChangePassword: false });
    expect(win.__codemanUser).toMatchObject({ username: 'root', role: 'admin', multiUser: true });
    const btn = win.document.querySelector('[data-tab="settings-users"]');
    expect(btn).toBeTruthy();
    expect(win.document.getElementById('settings-users')).toBeTruthy();
  });

  it('does NOT inject the Users tab for a regular user', async () => {
    const { win } = await bootWith({ username: 'joe', role: 'user', multiUser: true, mustChangePassword: false });
    expect(win.document.querySelector('[data-tab="settings-users"]')).toBeFalsy();
  });

  it('does NOT inject the Users tab in single-user mode', async () => {
    const { win } = await bootWith({ username: 'admin', role: 'admin', multiUser: false, mustChangePassword: false });
    expect(win.document.querySelector('[data-tab="settings-users"]')).toBeFalsy();
  });

  it('shows the change-password modal when mustChangePassword is set', async () => {
    const { win } = await bootWith({ username: 'dave', role: 'user', multiUser: true, mustChangePassword: true });
    const modal = win.document.getElementById('changePasswordModal') as HTMLElement | null;
    expect(modal).toBeTruthy();
    expect(modal!.style.display).toBe('flex');
    // Forced: the cancel button is hidden.
    expect((modal!.querySelector('#cpCancel') as HTMLElement).style.display).toBe('none');
  });
});

describe('index.html wiring', () => {
  it('loads admin-ui.js after settings-ui.js and before session-ui.js', () => {
    const settings = INDEX_HTML.indexOf('settings-ui.js');
    const admin = INDEX_HTML.indexOf('admin-ui.js');
    const session = INDEX_HTML.indexOf('session-ui.js');
    expect(admin).toBeGreaterThan(settings);
    expect(session).toBeGreaterThan(admin);
  });
});
