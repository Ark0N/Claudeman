/**
 * @fileoverview File Viewer "show hidden" toggle (issue #221).
 *
 * Hidden (dot-prefixed) entries are filtered SERVER-side by
 * `GET /api/sessions/:id/files`, which has always accepted `showHidden=true`;
 * the frontend simply hardcoded `showHidden=false`. So the whole feature is the
 * client honouring a persisted per-device flag, and the things that can silently
 * break it are:
 *
 *   1. the request going out with the wrong `showHidden` value (the toggle looks
 *      dead: the button lights up, the tree does not change),
 *   2. the toggle re-rendering the cached tree instead of re-fetching (same
 *      symptom, and no request in the network tab to explain it),
 *   3. toggling collapsing the tree the user just navigated,
 *   4. the flag not surviving a reload, or a `localStorage` throw (Safari private
 *      mode) taking the whole panel down with it.
 *
 * Loaded via `vm` with a stubbed context (no jsdom; see connection-indicator.test.ts).
 * `CodemanApp`'s real constructor calls `init()`, so the prototype is exercised on
 * a bare object instead of a real instance; the app.js wiring that seeds the flag
 * is pinned statically at the bottom.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const panelsJs = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');
const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
const indexHtml = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const stylesCss = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');

const STORAGE_KEY = 'codeman:fileBrowserShowHidden';

interface FakeElement {
  innerHTML: string;
  textContent: string;
  classes: Set<string>;
  attrs: Record<string, string>;
  classList: { toggle: (name: string, on: boolean) => void };
  setAttribute: (name: string, value: string) => void;
}

function fakeElement(): FakeElement {
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  return {
    innerHTML: '',
    textContent: '',
    classes,
    attrs,
    classList: {
      toggle(name: string, on: boolean) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name: string, value: string) {
      attrs[name] = value;
    },
  };
}

/** Load panels-ui.js's mixin onto a bare object, with a stubbed DOM + storage. */
function loadPanel(store: Map<string, string> | null) {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, unknown>;
  const localStorage = {
    getItem: (key: string) => {
      if (!store) throw new Error('localStorage is disabled');
      return store.has(key) ? store.get(key) : null;
    },
    setItem: (key: string, value: string) => {
      if (!store) throw new Error('localStorage is disabled');
      store.set(key, value);
    },
    removeItem: (key: string) => store?.delete(key),
  };
  const context = vm.createContext({
    CodemanApp,
    console,
    localStorage,
    escapeHtml: (s: string) => String(s),
    document: { getElementById: () => null, addEventListener: vi.fn() },
    window: { addEventListener: vi.fn() },
    setTimeout,
    clearTimeout,
    fetch: () => {
      throw new Error('fetch not stubbed');
    },
  });
  vm.runInContext(panelsJs, context, { filename: 'panels-ui.js' });

  const elements: Record<string, FakeElement> = {
    fileBrowserTree: fakeElement(),
    fileBrowserStatus: fakeElement(),
    fileBrowserHiddenBtn: fakeElement(),
  };
  const requests: string[] = [];
  const app = new CodemanApp() as Record<string, any>;
  app.$ = (id: string) => elements[id] ?? null;
  app.activeSessionId = 'sess-1';
  app.fileBrowserData = null;
  app.fileBrowserExpandedDirs = new Set<string>();
  app.fileBrowserFilter = '';
  app.fileBrowserShowHidden = app._loadFileBrowserShowHidden();
  // Mirror app.js: fetch is a global in the browser, a per-app stub here.
  context.fetch = async (url: string) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: { tree: [], totalFiles: 3, totalDirectories: 1, truncated: false },
      }),
    };
  };
  return { app, elements, requests };
}

describe('File Viewer show-hidden toggle', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
  });

  it('requests showHidden=false by default', async () => {
    const { app, requests } = loadPanel(store);
    expect(app.fileBrowserShowHidden).toBe(false);

    await app.loadFileBrowser('sess-1');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('showHidden=false');
  });

  it('restores an enabled toggle from localStorage and requests showHidden=true', async () => {
    store.set(STORAGE_KEY, '1');
    const { app, requests } = loadPanel(store);
    expect(app.fileBrowserShowHidden).toBe(true);

    await app.loadFileBrowser('sess-1');

    expect(requests[0]).toContain('showHidden=true');
  });

  it('re-fetches the tree when toggled, since hidden entries are filtered server-side', async () => {
    const { app, requests } = loadPanel(store);
    await app.loadFileBrowser('sess-1');
    expect(requests[0]).toContain('showHidden=false');

    await app.toggleFileBrowserHidden();

    expect(app.fileBrowserShowHidden).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain('showHidden=true');
    expect(store.get(STORAGE_KEY)).toBe('1');
  });

  it('toggles back off and persists the off state', async () => {
    store.set(STORAGE_KEY, '1');
    const { app, requests } = loadPanel(store);

    await app.toggleFileBrowserHidden();

    expect(app.fileBrowserShowHidden).toBe(false);
    expect(store.get(STORAGE_KEY)).toBe('0');
    expect(requests[0]).toContain('showHidden=false');
  });

  it('keeps expanded directories across a toggle', async () => {
    const { app } = loadPanel(store);
    app.fileBrowserExpandedDirs.add('src');
    app.fileBrowserExpandedDirs.add('src/web');

    await app.toggleFileBrowserHidden();

    expect([...app.fileBrowserExpandedDirs]).toEqual(['src', 'src/web']);
  });

  it('reflects state on the button and in the status line', async () => {
    const { app, elements } = loadPanel(store);
    const btn = elements.fileBrowserHiddenBtn;

    await app.loadFileBrowser('sess-1');
    expect(btn.classes.has('active')).toBe(false);
    expect(btn.attrs['aria-pressed']).toBe('false');
    expect(btn.attrs.title).toBe('Show hidden files and folders');
    expect(elements.fileBrowserStatus.textContent).not.toContain('hidden shown');

    await app.toggleFileBrowserHidden();
    expect(btn.classes.has('active')).toBe(true);
    expect(btn.attrs['aria-pressed']).toBe('true');
    expect(btn.attrs.title).toBe('Hide hidden files and folders');
    expect(btn.attrs['aria-label']).toBe('Hide hidden files and folders');
    expect(elements.fileBrowserStatus.textContent).toContain('hidden shown');
  });

  it('survives a localStorage that throws (private browsing)', async () => {
    const { app, requests } = loadPanel(null);
    expect(app.fileBrowserShowHidden).toBe(false);

    await app.toggleFileBrowserHidden();

    expect(app.fileBrowserShowHidden).toBe(true);
    expect(requests[0]).toContain('showHidden=true');
  });

  it('does not reset the preference on a panel refresh', async () => {
    store.set(STORAGE_KEY, '1');
    const { app, requests } = loadPanel(store);

    app.refreshFileBrowser();
    await Promise.resolve();

    expect(app.fileBrowserShowHidden).toBe(true);
    expect(requests[0]).toContain('showHidden=true');
  });
});

describe('File Viewer show-hidden wiring', () => {
  it('exposes the toggle in the file browser header', () => {
    expect(indexHtml).toContain('onclick="app.toggleFileBrowserHidden()"');
    expect(indexHtml).toContain('id="fileBrowserHiddenBtn"');
    expect(indexHtml).toContain('aria-pressed="false"');
  });

  it('seeds the flag from storage when the app is constructed', () => {
    expect(appJs).toMatch(/this\.fileBrowserShowHidden\s*=\s*this\._loadFileBrowserShowHidden\?\.\(\)/);
  });

  it('styles the active state so the toggle reads as on', () => {
    expect(stylesCss).toContain('.btn-file-browser-hidden.active');
  });
});
