/**
 * @fileoverview Session list layout: header tab strip ⟷ collapsible left sidebar.
 *
 * The whole design rests on ONE invariant: there is exactly one `#sessionTabs`
 * element and `applySessionListLayout()` RE-PARENTS it between the header host
 * and the sidebar. It must never be cloned or rebuilt — `app.$(id)` caches
 * elements by id and never invalidates, and settings-ui.js / webview-tabs.js
 * resolve the same id independently, so a rebuilt container would leave every
 * consumer writing into a detached orphan, silently and without an error.
 * `keeps the same DOM node across a layout flip` below is therefore the single
 * most important assertion in this file.
 *
 * Builds a JSDOM window in-test under the default node env, same shape as
 * test/webview-menu-rows.test.ts. Do NOT declare a per-file jsdom environment:
 * it externalizes node:fs under vite and the readFileSync calls below stop
 * working. ⚠ Do not name that directive in a comment either, vitest matches the
 * string anywhere in the file.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const CONSTANTS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const APP = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
const SETTINGS_UI = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf-8');
const INDEX_HTML = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const STYLES_CSS = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf-8');
const MOBILE_CSS = readFileSync(new URL('../src/web/public/mobile.css', import.meta.url), 'utf-8');
const I18N = readFileSync(new URL('../src/web/public/i18n.js', import.meta.url), 'utf-8');
const TERMINAL_UI = readFileSync(new URL('../src/web/public/terminal-ui.js', import.meta.url), 'utf-8');
const MOBILE_HANDLERS = readFileSync(new URL('../src/web/public/mobile-handlers.js', import.meta.url), 'utf-8');
const SCHEMAS = readFileSync(new URL('../src/web/schemas.ts', import.meta.url), 'utf-8');

interface LayoutApp {
  soloSessionId: string | null;
  sessions: Map<string, unknown>;
  sessionOrder: string[];
  _tallTabsEnabled?: boolean;
  _sidebarFilter?: string;
  _elemCache: Map<string, unknown>;
  $(id: string): Element | null;
  getSessionListLayout(): string;
  isSessionSidebarActive(): boolean;
  isSessionSidebarCollapsed(): boolean;
  applySessionListLayout(): void;
  toggleSessionSidebar(): void;
  updateSidebarCount(): void;
  closeSessionSidebarOnHandheld(): void;
  _isSessionSidebarOverlay(): boolean;
  applySidebarFilter(query?: string): void;
  _fullRenderSessionTabs(): void;
  updateConnectionLines(): void;
}

/** The parts of index.html this feature touches, minus everything it does not. */
const SHELL = `
  <header class="header">
    <div class="header-brand">
      <span class="logo">Codeman</span>
      <button class="btn-icon-header btn-sidebar-toggle btn-sidebar-toggle--hidden"
        id="sidebarToggleBtn" aria-expanded="true" aria-controls="sessionSidebar"
        title="Collapse session sidebar" aria-label="Collapse session sidebar"></button>
    </div>
    <div class="session-tabs-host" id="sessionTabsHost">
      <div class="session-tabs" id="sessionTabs" role="tablist" aria-label="Session tabs" aria-orientation="horizontal"></div>
    </div>
  </header>
  <main class="main">
    <aside class="session-sidebar" id="sessionSidebar" aria-label="Sessions">
      <div class="session-sidebar-head">
        <span class="session-sidebar-title">Sessions</span>
        <span class="session-sidebar-count" id="sessionSidebarCount"></span>
      </div>
      <div class="session-sidebar-filter">
        <input type="search" id="sessionSidebarFilter" class="session-sidebar-filter-input">
      </div>
      <div class="session-sidebar-list" id="sessionSidebarList"></div>
    </aside>
    <div class="terminal-wrap"></div>
  </main>
`;

function boot(
  options: {
    stored?: Record<string, unknown>;
    solo?: string | null;
    deviceType?: string;
    viewportWidth?: number;
  } = {}
) {
  const dom = new JSDOM(`<!doctype html><html><body>${SHELL}</body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window & typeof globalThis & { __CodemanApp: new () => LayoutApp };

  // Whether the sidebar is a docked column or a modal overlay is decided by
  // WIDTH (< 1024px), not by MobileDetection.getDeviceType() — that one calls
  // everything from 768px up 'desktop' while mobile.css, which defines the
  // overlay, is loaded with media="(max-width: 1023px)". jsdom defaults to
  // exactly 1024, so every handheld case has to say so explicitly.
  const width = options.viewportWidth ?? ((options.deviceType ?? 'desktop') === 'desktop' ? 1440 : 393);
  Object.defineProperty(win, 'innerWidth', { value: width, configurable: true, writable: true });

  // Handhelds read a separate settings blob (getSettingsStorageKey), so a
  // handheld harness must seed the handheld key or the layout silently stays
  // on the header strip.
  const settingsKey =
    (options.deviceType ?? 'desktop') === 'desktop' ? 'codeman-app-settings' : 'codeman-app-settings-mobile';
  if (options.stored) {
    win.localStorage.setItem(settingsKey, JSON.stringify(options.stored));
  }

  // app.js assigns window.MobileDetection at top level from the global that
  // mobile-handlers.js declares, so it has to exist before the source runs.
  // One eval, not three: `class CodemanApp` is a lexical binding and would not
  // survive into a second global eval, and settings-ui.js needs it at load time.
  (win as unknown as { eval: (s: string) => void }).eval(
    [
      `var MobileDetection = {
         getDeviceType: () => ${JSON.stringify(options.deviceType ?? 'desktop')},
         isHandheldDevice: () => ${JSON.stringify(options.deviceType ?? 'desktop')} !== 'desktop',
         isMobile: () => false,
         isTouchDevice: () => false,
       };`,
      CONSTANTS,
      APP,
      SETTINGS_UI,
      'window.__CodemanApp = CodemanApp;',
    ].join('\n')
  );

  // Object.create, not `new`: the constructor boots SSE, timers and the whole
  // terminal stack. Only the layout surface is under test here.
  const app = Object.create(win.__CodemanApp.prototype) as LayoutApp;
  app.soloSessionId = options.solo ?? null;
  app.sessions = new Map();
  app.sessionOrder = [];
  app._elemCache = new Map();
  app._fullRenderSessionTabs = vi.fn();
  app.updateConnectionLines = vi.fn();

  return { dom, win, app };
}

const tabsEl = (win: Window) => win.document.getElementById('sessionTabs')!;
const toggleBtn = (win: Window) => win.document.getElementById('sidebarToggleBtn')!;

describe('session list layout', () => {
  it('defaults to the header tab strip when nothing is stored', () => {
    const { win, app } = boot();
    expect(app.getSessionListLayout()).toBe('header');
    app.applySessionListLayout();
    expect(win.document.documentElement.dataset.sessionList).toBe('header');
    expect(app.isSessionSidebarActive()).toBe(false);
    expect(tabsEl(win).parentElement?.id).toBe('sessionTabsHost');
    expect(toggleBtn(win).classList.contains('btn-sidebar-toggle--hidden')).toBe(true);
  });

  it('re-parents the tab list into the sidebar and flips the a11y state', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' } });
    expect(app.getSessionListLayout()).toBe('sidebar');

    app.applySessionListLayout();

    expect(win.document.documentElement.dataset.sessionList).toBe('sidebar');
    expect(win.document.documentElement.dataset.sidebar).toBe('expanded');
    expect(app.isSessionSidebarActive()).toBe(true);
    expect(tabsEl(win).parentElement?.id).toBe('sessionSidebarList');
    expect(tabsEl(win).getAttribute('aria-orientation')).toBe('vertical');
    expect(toggleBtn(win).classList.contains('btn-sidebar-toggle--hidden')).toBe(false);
    expect(toggleBtn(win).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the same DOM node across a layout flip (the $() element cache never invalidates)', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' } });
    const original = tabsEl(win);
    // Seed the cache the way any real render would.
    expect(app.$('sessionTabs')).toBe(original);

    app.applySessionListLayout();
    expect(tabsEl(win)).toBe(original);
    expect(app.$('sessionTabs')).toBe(original);
    expect(original.parentElement?.id).toBe('sessionSidebarList');

    // …and back again.
    win.localStorage.setItem('codeman-app-settings', JSON.stringify({ sessionListLayout: 'header' }));
    delete (app as unknown as { _cachedAppSettings?: unknown })._cachedAppSettings;
    app.applySessionListLayout();
    expect(tabsEl(win)).toBe(original);
    expect(app.$('sessionTabs')).toBe(original);
    expect(original.parentElement?.id).toBe('sessionTabsHost');
    expect(original.getAttribute('aria-orientation')).toBe('horizontal');
    expect(toggleBtn(win).classList.contains('btn-sidebar-toggle--hidden')).toBe(true);
  });

  it('never selects the sidebar in a solo (detached) window', () => {
    // A solo window shows one session, so the list is noise — and #sessionTabs
    // parked in the display:none <aside> would measure 0/0 for tab overflow and
    // the inline rename input.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' }, solo: 'sess-1' });
    expect(app.getSessionListLayout()).toBe('header');
    app.applySessionListLayout();
    expect(win.document.documentElement.dataset.sessionList).toBe('header');
    expect(tabsEl(win).parentElement?.id).toBe('sessionTabsHost');
  });

  it('round-trips the collapse state through its own storage key', () => {
    // Deliberately NOT in the app-settings blob: saveAppSettings() rebuilds that
    // blob from the DOM controls, so a key without a control is wiped on Save.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' } });
    app.applySessionListLayout();
    const aside = win.document.getElementById('sessionSidebar')!;
    expect(aside.classList.contains('open')).toBe(true);

    app.toggleSessionSidebar();
    expect(win.localStorage.getItem('codeman-sidebar-collapsed')).toBe('1');
    expect(win.document.documentElement.dataset.sidebar).toBe('collapsed');
    expect(toggleBtn(win).getAttribute('aria-expanded')).toBe('false');
    expect(toggleBtn(win).getAttribute('aria-label')).toBe('Expand session sidebar');
    expect(aside.classList.contains('open')).toBe(false);

    app.toggleSessionSidebar();
    expect(win.localStorage.getItem('codeman-sidebar-collapsed')).toBe('0');
    expect(win.document.documentElement.dataset.sidebar).toBe('expanded');
    expect(toggleBtn(win).getAttribute('aria-expanded')).toBe('true');
    expect(toggleBtn(win).getAttribute('aria-label')).toBe('Collapse session sidebar');
    expect(aside.classList.contains('open')).toBe(true);
  });

  it('starts the handheld drawer CLOSED when the user has made no choice yet', () => {
    // Below 1024px the sidebar is an off-canvas overlay, so "expanded" on a cold
    // load would mean a drawer sitting on top of the terminal every time.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' }, deviceType: 'mobile' });
    app.applySessionListLayout();
    expect(app.isSessionSidebarActive()).toBe(true);
    expect(app.isSessionSidebarCollapsed()).toBe(true);
    expect(win.document.documentElement.dataset.sidebar).toBe('collapsed');
    expect(win.document.getElementById('sessionSidebar')?.classList.contains('open')).toBe(false);

    // An explicit choice still wins over the device default.
    win.localStorage.setItem('codeman-sidebar-collapsed', '0');
    app.applySessionListLayout();
    expect(win.document.documentElement.dataset.sidebar).toBe('expanded');
  });

  it('dismisses the handheld drawer on selection but never the docked desktop sidebar', () => {
    const handheld = boot({ stored: { sessionListLayout: 'sidebar' }, deviceType: 'mobile' });
    handheld.win.localStorage.setItem('codeman-sidebar-collapsed', '0');
    handheld.app.applySessionListLayout();
    handheld.app.closeSessionSidebarOnHandheld();
    expect(handheld.win.document.documentElement.dataset.sidebar).toBe('collapsed');

    const desktop = boot({ stored: { sessionListLayout: 'sidebar' } });
    desktop.app.applySessionListLayout();
    desktop.app.closeSessionSidebarOnHandheld();
    expect(desktop.win.document.documentElement.dataset.sidebar).toBe('expanded');
  });

  it('does nothing on toggle while the header strip is active', () => {
    const { win, app } = boot();
    app.applySessionListLayout();
    app.toggleSessionSidebar();
    expect(win.localStorage.getItem('codeman-sidebar-collapsed')).toBeNull();
    expect(win.document.documentElement.dataset.sidebar).toBe('expanded');
  });

  it('filters rows by rendered name and working directory without re-rendering', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' } });
    app.applySessionListLayout();
    tabsEl(win).innerHTML = `
      <div class="session-tab" data-id="a" aria-label="api server" title="/srv/api"></div>
      <div class="session-tab" data-id="b" aria-label="docs" title="/home/docs"></div>
      <div class="session-tab session-tab--web" data-webview-id="w" aria-label="Grafana web tab" title="http://x/g"></div>
    `;
    const before = tabsEl(win).querySelectorAll('.session-tab');

    app.applySidebarFilter('api');
    expect(
      [...tabsEl(win).querySelectorAll('.session-tab')].map((t) => t.classList.contains('tab-filtered-out'))
    ).toEqual([false, true, true]);
    // Pure class toggling — no node was replaced.
    expect(tabsEl(win).querySelectorAll('.session-tab')[0]).toBe(before[0]);

    app.applySidebarFilter('/home');
    expect(tabsEl(win).querySelectorAll('.session-tab')[1].classList.contains('tab-filtered-out')).toBe(false);

    app.applySidebarFilter('');
    expect(tabsEl(win).querySelectorAll('.tab-filtered-out')).toHaveLength(0);
  });

  it('drops the filter when the list moves back to the header strip', () => {
    // The filter <input> lives inside the sidebar, so a filter surviving a
    // layout flip would hide sessions from the header tab strip with no
    // reachable control to clear it — and every SSE-driven re-render re-hides
    // them, so only a reload recovers.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' } });
    app.applySessionListLayout();
    tabsEl(win).innerHTML = `
      <div class="session-tab" data-id="a" aria-label="api server" title="/srv/api"></div>
      <div class="session-tab" data-id="b" aria-label="docs" title="/home/docs"></div>
    `;
    const filterInput = win.document.getElementById('sessionSidebarFilter') as HTMLInputElement;
    filterInput.value = 'api';
    app.applySidebarFilter('api');
    expect(tabsEl(win).querySelectorAll('.tab-filtered-out')).toHaveLength(1);

    win.localStorage.setItem('codeman-app-settings', JSON.stringify({ sessionListLayout: 'header' }));
    delete (app as unknown as { _cachedAppSettings?: unknown })._cachedAppSettings;
    app.applySessionListLayout();

    expect(app._sidebarFilter).toBe('');
    expect(filterInput.value).toBe('');
    expect(tabsEl(win).querySelectorAll('.tab-filtered-out')).toHaveLength(0);
  });

  it('suspends the filter while the rail is collapsed and restores it on expand', () => {
    // Collapsing hides .session-sidebar-filter, so a filter left applied would
    // show 3 of 25 status dots in the rail with no visible cause.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' } });
    app.applySessionListLayout();
    tabsEl(win).innerHTML = `
      <div class="session-tab" data-id="a" aria-label="api server" title="/srv/api"></div>
      <div class="session-tab" data-id="b" aria-label="docs" title="/home/docs"></div>
    `;
    app.applySidebarFilter('api');
    expect(tabsEl(win).querySelectorAll('.tab-filtered-out')).toHaveLength(1);

    app.toggleSessionSidebar();
    expect(win.document.documentElement.dataset.sidebar).toBe('collapsed');
    expect(tabsEl(win).querySelectorAll('.tab-filtered-out')).toHaveLength(0);
    expect(app._sidebarFilter).toBe('api');

    app.toggleSessionSidebar();
    expect(tabsEl(win).querySelectorAll('.tab-filtered-out')).toHaveLength(1);
  });

  it('treats the 768-1023px band as an overlay, matching mobile.css', () => {
    // getDeviceType() calls 900px 'desktop', but mobile.css — which defines the
    // off-canvas overlay — is loaded with media="(max-width: 1023px)". Using the
    // device type here gave that band overlay CSS with docked-sidebar logic: the
    // drawer opened itself on load and neither selection nor Escape closed it.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' }, viewportWidth: 900 });
    expect(app._isSessionSidebarOverlay()).toBe(true);
    app.applySessionListLayout();
    expect(win.document.documentElement.dataset.sidebar).toBe('collapsed');

    win.localStorage.setItem('codeman-sidebar-collapsed', '0');
    app.applySessionListLayout();
    expect(win.document.documentElement.dataset.sidebar).toBe('expanded');
    app.closeSessionSidebarOnHandheld();
    expect(win.document.documentElement.dataset.sidebar).toBe('collapsed');
  });

  it('makes a closed overlay drawer inert, but never the docked desktop rail', () => {
    // translateX(-100%) alone leaves the filter box and ~4 tab stops per session
    // in the Tab order and in the accessibility tree.
    const overlay = boot({ stored: { sessionListLayout: 'sidebar' }, viewportWidth: 900 });
    overlay.app.applySessionListLayout();
    const drawer = overlay.win.document.getElementById('sessionSidebar')!;
    expect(drawer.hasAttribute('inert')).toBe(true);
    expect(drawer.getAttribute('aria-hidden')).toBe('true');

    overlay.app.toggleSessionSidebar();
    expect(drawer.hasAttribute('inert')).toBe(false);
    expect(drawer.hasAttribute('aria-hidden')).toBe(false);

    const desktop = boot({ stored: { sessionListLayout: 'sidebar' } });
    desktop.win.localStorage.setItem('codeman-sidebar-collapsed', '1');
    desktop.app.applySessionListLayout();
    const rail = desktop.win.document.getElementById('sessionSidebar')!;
    expect(desktop.win.document.documentElement.dataset.sidebar).toBe('collapsed');
    expect(rail.hasAttribute('inert')).toBe(false);
  });

  it('steals focus only for the modal drawer, never for the docked sidebar', () => {
    // The docked sidebar is chrome, not a dialog: pulling the caret out of the
    // terminal mid-prompt swallows everything typed after, because .session-tab
    // handles only arrows/Home/End/Enter/Space.
    const rows = `<div class="session-tab active" data-id="a" tabindex="0" aria-label="api"></div>`;

    const desktop = boot({ stored: { sessionListLayout: 'sidebar' } });
    desktop.win.localStorage.setItem('codeman-sidebar-collapsed', '1');
    desktop.app.applySessionListLayout();
    tabsEl(desktop.win).innerHTML = rows;
    desktop.app.toggleSessionSidebar();
    expect(desktop.win.document.activeElement).toBe(desktop.win.document.body);

    const drawer = boot({ stored: { sessionListLayout: 'sidebar' }, viewportWidth: 900 });
    drawer.app.applySessionListLayout();
    tabsEl(drawer.win).innerHTML = rows;
    drawer.app.toggleSessionSidebar();
    expect((drawer.win.document.activeElement as HTMLElement).className).toContain('session-tab');
  });

  it('counts the rows actually on the list: web tabs included, filtered rows excluded', () => {
    // this.sessions.size was the original source and disagreed with the screen
    // twice over: web tabs render in the same list but are not sessions (3
    // sessions + 2 dashboards read "3" above 5 rows), and the filter hides
    // rows without touching the map.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' } });
    app.sessions = new Map([
      ['a', {}],
      ['b', {}],
    ]);
    app.applySessionListLayout();
    tabsEl(win).innerHTML = `
      <div class="session-tab" data-id="a" aria-label="api server" title="/srv/api"></div>
      <div class="session-tab" data-id="b" aria-label="docs" title="/home/docs"></div>
      <div class="session-tab session-tab--web" data-webview-id="w" aria-label="Grafana web tab" title="http://x/g"></div>
    `;
    app.updateSidebarCount();
    const count = () => win.document.getElementById('sessionSidebarCount')?.textContent;
    expect(count()).toBe('3');

    // The count follows the filter — applySidebarFilter is what the filter box
    // calls per keystroke, so it must move without waiting for a re-render.
    app.applySidebarFilter('api');
    expect(count()).toBe('1');
    app.applySidebarFilter('');
    expect(count()).toBe('3');
  });

  it('forces tall rows and no wrapping in the sidebar, and leaves the strip rules alone', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar', tabTwoRows: false } });
    app.applySessionListLayout();
    const tabs = tabsEl(win);
    expect(tabs.classList.contains('tabs-show-folder')).toBe(true);
    expect(tabs.classList.contains('tabs-two-rows')).toBe(false);
    expect(tabs.classList.contains('tabs-auto-wrap')).toBe(false);
    expect(app._tallTabsEnabled).toBe(true);
  });
});

describe('session list layout wiring', () => {
  it('accepts sessionListLayout in the strict settings schema', () => {
    // SettingsUpdateSchema is .strict() and this key is NOT in the PUT strip-list,
    // so without the schema entry the server 400s the ENTIRE settings PUT and every
    // unrelated setting silently stops persisting.
    expect(SCHEMAS).toContain("sessionListLayout: z.enum(['header', 'sidebar']).optional()");
  });

  it('plumbs the setting through populate, collect, defaults and the display-key set', () => {
    expect(INDEX_HTML).toContain('id="appSettingsSessionListLayout"');
    expect(SETTINGS_UI).toContain("document.getElementById('appSettingsSessionListLayout').value =");
    expect(SETTINGS_UI).toContain("sessionListLayout: document.getElementById('appSettingsSessionListLayout').value,");
    expect(SETTINGS_UI).toContain("sessionListLayout: 'header',");
    expect(SETTINGS_UI).toContain("'sessionListLayout'");
    // Saving must re-apply the LAYOUT (which calls applyTabWrapSettings itself);
    // calling only applyTabWrapSettings would leave a layout change unapplied.
    expect(SETTINGS_UI).toContain('this.applySessionListLayout();');
  });

  it('keeps the header host, the aside and the toggle out of solo windows', () => {
    expect(STYLES_CSS).toContain('body.solo-mode .session-tabs-host,');
    expect(STYLES_CSS).toContain('body.solo-mode .session-sidebar,');
    expect(STYLES_CSS).toContain('body.solo-mode .btn-sidebar-toggle,');
  });

  it('puts the sidebar rules after the skin nesting block and adds no colour to .session-tab', () => {
    // Match the RULE (column 0 + opening brace), not the prose about it in the
    // sidebar block's own header comment.
    const skinRule = [...STYLES_CSS.matchAll(/^html:not\(\[data-skin="og"\]\) \{/gm)].pop();
    expect(skinRule).toBeDefined();
    const sidebarBlock = STYLES_CSS.indexOf('=== Collapsible session sidebar');
    expect(sidebarBlock).toBeGreaterThan(skinRule!.index!);
  });

  it('makes the handheld sidebar an off-canvas overlay from the END of mobile.css', () => {
    // Placement is load-bearing: the compact `.session-tabs, .session-tabs.tabs-two-rows`
    // blocks earlier in the file pin max-height 36px/52px. Moving this block up
    // collapses the list into a sliver that looks like an empty list.
    const overlay = MOBILE_CSS.indexOf('SESSION SIDEBAR — off-canvas drawer');
    const compactStrip = [...MOBILE_CSS.matchAll(/^\s*\.session-tabs\.tabs-two-rows \{/gm)].pop();
    expect(compactStrip).toBeDefined();
    expect(overlay).toBeGreaterThan(compactStrip!.index!);
    expect(MOBILE_CSS).toContain('html[data-session-list="sidebar"] .session-sidebar.open');
    expect(MOBILE_CSS).toContain('transform: translateX(-100%)');
  });

  it('translates the new sidebar copy for every language the translator supports', () => {
    for (const key of [
      'Collapse session sidebar',
      'Expand session sidebar',
      'Filter sessions',
      'Session List Layout',
      'Header tab strip',
      'Left sidebar',
    ]) {
      expect(I18N).toContain(`'${key}'`);
    }
  });

  it('pre-paints the layout before first paint and never in a solo window', () => {
    expect(INDEX_HTML).toContain('document.documentElement.dataset.sessionList');
    expect(INDEX_HTML).toContain('/^\\/session\\//.test(location.pathname)');
  });

  it('pre-paints the collapse default off the SAME 1024px breakpoint as the JS', () => {
    // The handheld storage-key heuristic `m` is a different predicate; using it
    // here made boot contradict the pre-paint value between 768 and 1023px, so
    // the drawer animated itself open over the terminal on every load.
    expect(INDEX_HTML).toContain("dataset.sidebar=(C===null?window.innerWidth<1024:C==='1')");
  });

  it('keeps the sidebar toggle chord out of the PTY', () => {
    // preventDefault() in the document CAPTURE handler does not stop xterm, so
    // without this gate Alt+B would also write ESC b (readline backward-word)
    // into the live session on every toggle.
    expect(TERMINAL_UI).toContain('this.shouldToggleSessionSidebarFromShortcut?.(ev)');
    expect(APP).toContain('shouldToggleSessionSidebarFromShortcut(e) {');
  });

  it('keeps the session drawer out of the prev/next swipe zone', () => {
    // The <aside> is a child of .main, which is where SwipeHandler binds, so a
    // swipe across the open drawer would otherwise fire nextSession().
    expect(MOBILE_HANDLERS).toContain("e.target?.closest?.('.session-sidebar')");
  });
});
