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
  isSoloWindow: boolean;
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
  applyTabOrientation(): void;
  toggleSessionSidebar(): void;
  updateSidebarCount(): void;
  closeSessionSidebarOnHandheld(): void;
  _isSessionSidebarOverlay(): boolean;
  applySidebarFilter(query?: string): void;
  _fullRenderSessionTabs(): void;
  updateConnectionLines(): void;
  isSessionSidebarRich(): boolean;
  isTabRailRich(): boolean;
  isRichTabRows(): boolean;
  _sidebarRichRow(id: string, session: Record<string, unknown>): RichRow | null;
  _sidebarRichMetaHTML(row: RichRow | null): string;
  _updateSidebarRichRow(tab: Element, id: string, session: Record<string, unknown>): void;
  _startSidebarRichClock(): void;
  _stopSidebarRichClock(): void;
  _tickSidebarRichTimes(): void;
  _sidebarRichClock: ReturnType<typeof setInterval> | null;
  pendingHooks?: Map<string, Set<string>>;
  _mobileOverviewState?: (session: Record<string, unknown>, hooks?: Set<string>) => string;
  _mobileOverviewSince?: (state: string, session: Record<string, unknown>) => { key: string; at: number } | null;
  _mobileOverviewStampText?: (ts: number, fmt: string) => string;
}

interface RichRow {
  state: string;
  pill: string;
  createdAt: number;
  since: { key: string; at: number } | null;
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
    <div class="tab-rail" id="tabRail"></div>
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
  app.isSoloWindow = !!app.soloSessionId;
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

  it('preserves vertical rail ownership when the session-list layout reapplies', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'header', tabOrientation: 'vertical' } });

    app.applySessionListLayout();
    app.applyTabOrientation();
    expect(tabsEl(win).parentElement?.id).toBe('tabRail');

    app.applySessionListLayout();

    expect(tabsEl(win).parentElement?.id).toBe('tabRail');
    expect(tabsEl(win).getAttribute('aria-orientation')).toBe('vertical');
  });

  it('keeps aria orientation synchronized when tab orientation moves hosts', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'header', tabOrientation: 'vertical' } });

    app.applySessionListLayout();
    app.applyTabOrientation();

    expect(tabsEl(win).parentElement?.id).toBe('tabRail');
    expect(tabsEl(win).getAttribute('aria-orientation')).toBe('vertical');

    win.localStorage.setItem(
      'codeman-app-settings',
      JSON.stringify({ sessionListLayout: 'header', tabOrientation: 'horizontal' })
    );
    delete (app as unknown as { _cachedAppSettings?: unknown })._cachedAppSettings;
    app.applyTabOrientation();

    expect(tabsEl(win).parentElement?.id).toBe('sessionTabsHost');
    expect(tabsEl(win).getAttribute('aria-orientation')).toBe('horizontal');
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

  it('forces horizontal tabs in a solo window even when vertical orientation is preferred', () => {
    const { win, app } = boot({
      stored: { sessionListLayout: 'header', tabOrientation: 'vertical' },
      solo: 'sess-1',
    });

    app.applySessionListLayout();
    app.applyTabOrientation();

    expect(win.document.documentElement.dataset.tabOrientation).toBe('horizontal');
    expect(tabsEl(win).parentElement?.id).toBe('sessionTabsHost');
    expect(tabsEl(win).getAttribute('aria-orientation')).toBe('horizontal');
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
    expect(SCHEMAS).toContain("sessionListLayout: z.enum(['header', 'sidebar', 'sidebar-rich']).optional()");
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

/**
 * The rich variant is the SAME sidebar with more on each row, and that is the
 * whole reason it does not get its own `data-session-list` value: every one of
 * the ~25 `isSessionSidebarActive()` call sites and every
 * `html[data-session-list="sidebar"]` rule in styles.css and mobile.css has to
 * keep matching it untouched. `data-session-list stays "sidebar"` below is the
 * assertion that guards that, and it is the one to read first.
 */
describe('rich session sidebar', () => {
  /**
   * The row model is built from mobile-overview.js helpers, which the harness
   * does not eval (it would drag the whole phone overview in for three
   * functions). Stubbing them is also the sharper test: it pins exactly which
   * shared helper each field comes from.
   */
  function stubOverview(app: LayoutApp, state = 'working') {
    app.pendingHooks = new Map();
    app._mobileOverviewState = () => state;
    app._mobileOverviewSince = (s, session) =>
      s === 'working'
        ? { key: 'working', at: Number(session.lastSubmitAt) || 0 }
        : { key: 'idle', at: Number(session.lastActivityAt) || 0 };
    app._mobileOverviewStampText = (ts, fmt) => (ts ? `${fmt}:${ts}` : '—');
  }

  const SESSION = { createdAt: 1000, lastActivityAt: 5000, lastSubmitAt: 4000 };

  it('data-session-list stays "sidebar" so every existing sidebar rule and call site still matches', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    expect(app.getSessionListLayout()).toBe('sidebar-rich');

    app.applySessionListLayout();

    // The load-bearing assertion: the layout attribute is NOT 'sidebar-rich'.
    expect(win.document.documentElement.dataset.sessionList).toBe('sidebar');
    expect(win.document.documentElement.dataset.sidebarDetail).toBe('rich');
    expect(app.isSessionSidebarActive()).toBe(true);
    expect(app.isSessionSidebarRich()).toBe(true);
    // …and everything the simple sidebar does, it still does.
    expect(tabsEl(win).parentElement?.id).toBe('sessionSidebarList');
    expect(tabsEl(win).getAttribute('aria-orientation')).toBe('vertical');
    expect(toggleBtn(win).classList.contains('btn-sidebar-toggle--hidden')).toBe(false);
    expect(app._tallTabsEnabled).toBe(true);
  });

  it('marks the simple sidebar and the header strip as not rich', () => {
    for (const layout of ['sidebar', 'header']) {
      const { win, app } = boot({ stored: { sessionListLayout: layout } });
      app.applySessionListLayout();
      expect(win.document.documentElement.dataset.sidebarDetail).toBe('simple');
      expect(app.isSessionSidebarRich()).toBe(false);
    }
  });

  it('forces a solo window back to the header strip, detail and all', () => {
    // A detached window shows exactly one session: a list of it is noise, and
    // #sessionTabs must never be parked inside the display:none <aside>.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar-rich' }, solo: 'sess-1' });
    expect(app.getSessionListLayout()).toBe('header');
    app.applySessionListLayout();
    expect(win.document.documentElement.dataset.sessionList).toBe('header');
    expect(win.document.documentElement.dataset.sidebarDetail).toBe('simple');
    expect(app.isSessionSidebarRich()).toBe(false);
  });

  it('re-renders when only the DETAIL changes, which the old layout-only test could not see', () => {
    // simple ⟷ rich leaves data-session-list on 'sidebar' both times. The meta
    // line is emitted by the row template, not toggled by CSS, so a missed
    // re-render here means flipping the setting repaints nothing until the next
    // SSE tick.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar' } });
    app.applySessionListLayout();
    (app._fullRenderSessionTabs as unknown as { mockClear(): void }).mockClear();

    win.localStorage.setItem('codeman-app-settings', JSON.stringify({ sessionListLayout: 'sidebar-rich' }));
    delete (app as unknown as { _cachedAppSettings?: unknown })._cachedAppSettings;
    app.applySessionListLayout();

    expect(win.document.documentElement.dataset.sidebarDetail).toBe('rich');
    expect(app._fullRenderSessionTabs).toHaveBeenCalled();
  });

  it('builds the row model from the shared overview helpers, not its own copy', () => {
    const { app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    stubOverview(app);
    const row = app._sidebarRichRow('s1', SESSION)!;
    expect(row.state).toBe('working');
    expect(row.pill).toBe('working');
    expect(row.createdAt).toBe(1000);
    // A working pane repaints ~1/s, so its duration is anchored on the turn's
    // last Enter (lastSubmitAt), never on lastActivityAt.
    expect(row.since).toEqual({ key: 'working', at: 4000 });
  });

  it('degrades to no meta line when mobile-overview.js is missing or stale', () => {
    // iOS Safari serves old JS after a deploy. A missing helper must cost the
    // stamps line, not the whole tab strip.
    const { app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    expect(app._sidebarRichRow('s1', SESSION)).toBeNull();
    expect(app._sidebarRichMetaHTML(null)).toBe('');
  });

  it('renders both stamps and the pill, and parks raw epochs for the clock', () => {
    const { app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    stubOverview(app);
    const html = app._sidebarRichMetaHTML(app._sidebarRichRow('s1', SESSION));

    expect(html).toContain('class="tab-meta"');
    expect(html).toContain('>created<');
    expect(html).toContain('>working<');
    expect(html).toContain('tab-pill--working');
    // Raw epoch-ms on the element is what lets the clock rewrite the text
    // without a re-render — a re-render would restart every load spinner and
    // alert animation in the list, twice a minute.
    expect(html).toContain('data-tab-ts="1000" data-tab-fmt="ago"');
    expect(html).toContain('data-tab-ts="4000" data-tab-fmt="for"');
    // Generated relative times must not be handed to the translator.
    expect(html).toContain('data-i18n-skip');
  });

  it('drops the second stamp when the session has never been active', () => {
    const { app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    stubOverview(app);
    app._mobileOverviewSince = () => null;
    const html = app._sidebarRichMetaHTML(app._sidebarRichRow('s1', { createdAt: 1000 }));
    expect(html).toContain('data-tab-fmt="ago"');
    expect(html).not.toContain('data-tab-fmt="for"');
    // The pill is not optional: it is the row's status word.
    expect(html).toContain('tab-pill--working');
  });

  it('rewrites the stamps in place instead of re-rendering the row', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    stubOverview(app);
    app.applySessionListLayout();
    tabsEl(win).innerHTML = `<div class="session-tab" data-id="s1"><span class="tab-info">${app._sidebarRichMetaHTML(
      app._sidebarRichRow('s1', SESSION)
    )}</span></div>`;
    const metaBefore = tabsEl(win).querySelector('.tab-meta');

    app._mobileOverviewStampText = (ts, fmt) => (ts ? `${fmt}:${ts}:later` : '—');
    app._tickSidebarRichTimes();

    expect(tabsEl(win).querySelector('.tab-meta')).toBe(metaBefore);
    expect(metaBefore!.textContent).toContain('ago:1000:later');
  });

  it('updates the pill and the row accent when the state changes between renders', () => {
    // The clock cannot see this: a state flip changes the pill, the accent class
    // and which stamp the second slot is even measuring.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    stubOverview(app);
    app.applySessionListLayout();
    tabsEl(win).innerHTML = '<div class="session-tab" data-id="s1"><span class="tab-info"></span></div>';
    const tab = tabsEl(win).querySelector('.session-tab')!;

    app._updateSidebarRichRow(tab, 's1', SESSION);
    expect(tab.classList.contains('tab-state-working')).toBe(true);
    expect(tab.querySelector('.tab-pill')!.textContent).toBe('working');

    stubOverview(app, 'idle');
    app._updateSidebarRichRow(tab, 's1', SESSION);
    expect(tab.classList.contains('tab-state-working')).toBe(false);
    expect(tab.classList.contains('tab-state-idle')).toBe(true);
    expect(tab.querySelector('.tab-pill')!.textContent).toBe('idle');
    // Idle is measured from the last byte the pane printed, not from a submit.
    expect(tab.querySelector('[data-tab-fmt="for"]')!.getAttribute('data-tab-ts')).toBe('5000');
  });

  it('skips the DOM write when nothing the row displays has changed', () => {
    // This runs for every session on every SSE tick.
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    stubOverview(app);
    app.applySessionListLayout();
    tabsEl(win).innerHTML = '<div class="session-tab" data-id="s1"><span class="tab-info"></span></div>';
    const tab = tabsEl(win).querySelector('.session-tab')!;

    app._updateSidebarRichRow(tab, 's1', SESSION);
    const meta = tab.querySelector('.tab-meta');
    app._updateSidebarRichRow(tab, 's1', SESSION);
    expect(tab.querySelector('.tab-meta')).toBe(meta);

    // …but a new turn re-stamps lastSubmitAt without changing the state, and
    // that MUST still repaint: the duration is anchored on it.
    app._updateSidebarRichRow(tab, 's1', { ...SESSION, lastSubmitAt: 9000 });
    expect(tab.querySelector('.tab-meta')).not.toBe(meta);
    expect(tab.querySelector('[data-tab-fmt="for"]')!.getAttribute('data-tab-ts')).toBe('9000');
  });

  it('runs the clock only while rich rows are on screen', () => {
    const { win, app } = boot({ stored: { sessionListLayout: 'sidebar-rich' } });
    app.applySessionListLayout();
    expect(app._sidebarRichClock).toBeTruthy();

    win.localStorage.setItem('codeman-app-settings', JSON.stringify({ sessionListLayout: 'sidebar' }));
    delete (app as unknown as { _cachedAppSettings?: unknown })._cachedAppSettings;
    app.applySessionListLayout();
    // A leaked interval would keep rewriting stamps in a list that no longer
    // has any, forever, on every open tab.
    expect(app._sidebarRichClock).toBeNull();
  });

  it('emits the meta line only in the rich row template, and only inside .tab-info', () => {
    // .tab-info is already a flex column, so the line needs no row-level
    // wrapping — and the collapsed 44px rail hides .tab-info wholesale, which is
    // what keeps the stamps out of it for free.
    expect(APP).toContain('const richRows = this.isRichTabRows();');
    expect(APP).toContain('const richMeta = this._sidebarRichMetaHTML(richRow);');
    expect(APP).toContain('${richMeta}\n          </span>');
  });

  it('plumbs the third option through the settings UI and the pre-paint script', () => {
    expect(INDEX_HTML).toContain('<option value="sidebar">Left sidebar simple</option>');
    expect(INDEX_HTML).toContain('<option value="sidebar-rich">Left sidebar</option>');
    // Pre-paint must resolve BOTH sidebar values to the same layout attribute,
    // or the first frame paints a header strip and then jumps.
    expect(INDEX_HTML).toContain("(L==='sidebar'||L==='sidebar-rich')&&!solo");
    expect(INDEX_HTML).toContain("dataset.sidebarDetail=(S&&L==='sidebar-rich')?'rich':'simple'");
    for (const key of ['Left sidebar simple']) expect(I18N).toContain(`'${key}'`);
  });

  it('keeps the desktop rich width out of the handheld drawer', () => {
    // styles.css scopes the 300px column with (0,3,1) — one attribute MORE than
    // mobile.css's (0,2,1) drawer base — so without a matching override in
    // mobile.css it wins there too and pins a 320px phone's drawer to 300px.
    expect(STYLES_CSS).toContain('--sidebar-width-rich');
    expect(STYLES_CSS).toContain('html[data-session-list="sidebar"][data-sidebar-detail="rich"] .session-sidebar {');
    expect(MOBILE_CSS).toContain('html[data-session-list="sidebar"][data-sidebar-detail="rich"] .session-sidebar {');
  });
});

describe('detailed rows in the vertical tab rail', () => {
  /**
   * The rail is the SECOND surface that draws rich rows. Everything about the
   * row itself (model, markup, clock) is shared with the sidebar and covered
   * above; what is new here is only the gate — which attribute turns it on,
   * and the three ways it must turn back off.
   */
  const railBoot = (stored: Record<string, unknown>) => {
    const booted = boot({ stored: { sessionListLayout: 'header', ...stored } });
    booted.app.applySessionListLayout();
    booted.app.applyTabOrientation();
    return booted;
  };

  it('defaults the rail to detailed rows, since a docked column is not a tab strip', () => {
    const { win, app } = railBoot({ tabOrientation: 'vertical' });
    expect(win.document.documentElement.dataset.tabOrientation).toBe('vertical');
    expect(win.document.documentElement.dataset.tabRailDetail).toBe('rich');
    expect(app.isTabRailRich()).toBe(true);
    expect(app.isRichTabRows()).toBe(true);
    // The stamps go stale with no event behind them, so the clock has to run.
    expect(app._sidebarRichClock).toBeTruthy();
  });

  it("honors the 'simple' opt-out", () => {
    const { win, app } = railBoot({ tabOrientation: 'vertical', tabRailDetail: 'simple' });
    expect(win.document.documentElement.dataset.tabRailDetail).toBe('simple');
    expect(app.isTabRailRich()).toBe(false);
    expect(app.isRichTabRows()).toBe(false);
    // Falsy rather than null: _stopSidebarRichClock() returns early when there
    // is no interval to clear, which is the state a rail that never armed one is in.
    expect(app._sidebarRichClock).toBeFalsy();
  });

  it('drops back to simple rows once the rail is dragged into compact width', () => {
    // Below 240px the rail already hides the row actions; three lines of stamps
    // in a ~208px column ellipsize into noise. _setTabRailWidth() re-renders
    // whenever this class flips, so the gate is re-read at the right moment.
    const { win, app } = railBoot({ tabOrientation: 'vertical' });
    expect(app.isTabRailRich()).toBe(true);
    win.document.documentElement.classList.add('tab-rail-compact');
    expect(app.isTabRailRich()).toBe(false);
    expect(app.isRichTabRows()).toBe(false);
  });

  it('never draws stamps in the horizontal header strip', () => {
    // tabRailDetail stays 'rich' in storage while the orientation is horizontal:
    // the gate has to read BOTH, or the header strip inherits a meta line that
    // has nowhere to go.
    const { win, app } = railBoot({ tabOrientation: 'horizontal', tabRailDetail: 'rich' });
    expect(win.document.documentElement.dataset.tabRailDetail).toBe('rich');
    expect(app.isTabRailRich()).toBe(false);
    expect(app.isRichTabRows()).toBe(false);
  });

  it('leaves the simple sidebar simple even with the rail set to detailed', () => {
    // The sidebar owns the tabs whenever it is active, which forces the
    // orientation back to horizontal — so a rail preference must not leak a
    // meta line into a list the user asked to keep compact.
    const { app } = railBoot({ sessionListLayout: 'sidebar', tabOrientation: 'vertical', tabRailDetail: 'rich' });
    expect(app.isSessionSidebarActive()).toBe(true);
    expect(app.isSessionSidebarRich()).toBe(false);
    expect(app.isTabRailRich()).toBe(false);
    expect(app.isRichTabRows()).toBe(false);
  });

  it('re-renders when only the DETAIL changes, orientation untouched', () => {
    const { win, app } = railBoot({ tabOrientation: 'vertical', tabRailDetail: 'simple' });
    (app._fullRenderSessionTabs as unknown as { mockClear(): void }).mockClear();

    win.localStorage.setItem(
      'codeman-app-settings',
      JSON.stringify({ sessionListLayout: 'header', tabOrientation: 'vertical', tabRailDetail: 'rich' })
    );
    delete (app as unknown as { _cachedAppSettings?: unknown })._cachedAppSettings;
    app.applyTabOrientation();

    // The stamps line is emitted by the row template, not toggled by CSS: a
    // missed render here means the setting repaints nothing until the next tick.
    expect(win.document.documentElement.dataset.tabRailDetail).toBe('rich');
    expect(app._fullRenderSessionTabs).toHaveBeenCalled();
    expect(app._sidebarRichClock).toBeTruthy();
  });

  it('plumbs the rail detail through the settings UI, the schema and the pre-paint script', () => {
    expect(INDEX_HTML).toContain('id="appSettingsTabRailDetail"');
    expect(INDEX_HTML).toContain('<option value="rich">Detailed</option>');
    // Pre-paint stamps it with the rest of the layout keys, or a detailed rail
    // paints as a simple one for the first frame and then jumps a row taller.
    expect(INDEX_HTML).toContain("dataset.tabRailDetail=(A.tabRailDetail==='simple')?'simple':'rich'");
    expect(SETTINGS_UI).toContain("document.getElementById('appSettingsTabRailDetail').value");
    const displayKeys = SETTINGS_UI.slice(SETTINGS_UI.indexOf('const displayKeys = new Set(['));
    expect(displayKeys.slice(0, 1800)).toContain("'tabRailDetail'");
    expect(SCHEMAS).toMatch(/tabRailDetail:\s*z\.enum\(\['simple',\s*'rich'\]\)\.optional\(\)/);
  });

  it('gives every rich paint rule a rail twin without raising the sidebar arm', () => {
    // Comma-grouped, never :is() — an :is() list takes its most specific
    // argument, which would lift the sidebar selectors from (0,3,1) to the
    // rail's (0,5,1) and let them outrank rules they never used to.
    const rail = "html[data-tab-orientation='vertical'][data-tab-rail-detail='rich']:not(.tab-rail-compact) .tab-rail";
    for (const suffix of ['.tab-meta', '.tab-meta-key', '.tab-pill', '.tab-pill--working']) {
      expect(STYLES_CSS).toContain(`${rail} ${suffix}`);
    }
    expect(STYLES_CSS).not.toContain(':is(html[data-sidebar-detail="rich"]');
  });
});
