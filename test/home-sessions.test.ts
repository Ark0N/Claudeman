// Port: none (pure model + static markup assertions — no browser, no server).
//
// The desktop home screen's tab column (src/web/public/home-sessions.js) fills
// the welcome overlay's left gutter. Two things about it can silently go wrong
// and are pinned here: the row ORDER (it mirrors the tab strip, unlike the phone
// overview which sorts by urgency, and the number badges are only correct if it
// does), and the WIDTH GATE, which lives in two places at once — the JS constant
// and a CSS media query — because the column is absolutely positioned and would
// overlap the search panel in a narrow window.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

/** Minimal fake DOM node — enough surface for the programmatic row builders. */
function fakeElement(): any {
  const el: any = {
    className: '',
    type: '',
    title: '',
    textContent: '',
    dataset: {},
    style: {},
    children: [] as any[],
    setAttribute() {},
    appendChild(child: any) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

/**
 * home-sessions.js reuses `_mobileOverviewState` / `_mobileOverviewCaseFor` /
 * `shouldUseMobileOverview` from mobile-overview.js, so both files run in the
 * same context — which is also the point: if that reuse ever breaks, these
 * tests stop loading rather than quietly testing a divergent copy.
 */
function loadHomeSessionsApp(overrides: Record<string, any> = {}, innerWidth = 1512) {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    console,
    window: { innerWidth },
    document: {
      getElementById: () => null,
      createElement: () => fakeElement(),
      createElementNS: () => fakeElement(),
    },
    MobileDetection: { getDeviceType: () => (innerWidth < 430 ? 'mobile' : 'desktop') },
  });
  for (const file of ['mobile-overview.js', 'home-sessions.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }

  const app = new (CodemanApp as any)();
  app.getSessionName = (session: any) => session.name || session.id.slice(0, 8);
  app._shortenHomePath = (p: string) => (p || '').replace(/^\/home\/[^/]+\//, '~/');
  app.loadAppSettingsFromStorage = () => ({});
  Object.assign(app, overrides);
  return app;
}

const CASES = [{ name: 'claudeman', path: '/home/arkon/default/claudeman', location: 'local' }];

function sessionMap(list: Array<Record<string, any>>) {
  return new Map(
    list.map((over) => {
      const s = { id: 'x', status: 'idle', mode: 'claude', workingDir: '/home/arkon/default/claudeman', ...over };
      return [s.id, s];
    })
  );
}

describe('home sessions column: model', () => {
  it('lists rows in TAB order, not by urgency, so the number badges match Alt+1..9', () => {
    // The phone overview would hoist 'needy' to the top; this surface must not,
    // because its badges are the Alt+N indices.
    const app = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'first' }, { id: 'needy' }, { id: 'third' }]),
      sessionOrder: ['first', 'needy', 'third'],
      cases: CASES,
      pendingHooks: new Map([['needy', new Set(['permission_prompt'])]]),
    });

    const rows = app.buildHomeSessionRows();
    expect(rows.map((r: any) => r.id)).toEqual(['first', 'needy', 'third']);
    expect(rows.map((r: any) => r.index)).toEqual([0, 1, 2]);
    expect(rows[1].state).toBe('needs');
    expect(rows[1].pill).toBe('needs you');
  });

  it('shows a session that is not in the order list yet', () => {
    // A freshly created session exists in this.sessions before the order array
    // catches up; its tab is already on screen, so its row must be too.
    const app = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'known' }, { id: 'fresh' }]),
      sessionOrder: ['known'],
      cases: CASES,
    });

    expect(app.buildHomeSessionRows().map((r: any) => r.id)).toEqual(['known', 'fresh']);
  });

  it('classifies state through the shared phone-overview helper', () => {
    const app = loadHomeSessionsApp({
      sessions: sessionMap([
        { id: 'w', status: 'busy' },
        { id: 'i', status: 'idle' },
        { id: 'd', status: 'stopped' },
        { id: 'e', status: 'error' },
      ]),
      sessionOrder: ['w', 'i', 'd', 'e'],
      cases: CASES,
    });

    expect(app.buildHomeSessionRows().map((r: any) => [r.state, r.pill])).toEqual([
      ['working', 'working'],
      ['idle', 'idle'],
      ['done', 'done'],
      ['error', 'error'],
    ]);
  });

  it('labels a row with its case and a short backend badge', () => {
    const app = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'a', name: 'w1-claudeman', mode: 'codex' }]),
      sessionOrder: ['a'],
      cases: CASES,
    });

    const [row] = app.buildHomeSessionRows();
    expect(row.caseName).toBe('claudeman');
    expect(row.modeBadge).toBe('cx');
    // claude is the default backend and gets no badge — the strip does the same.
    const plain = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'a', mode: 'claude' }]),
      sessionOrder: ['a'],
      cases: CASES,
    });
    expect(plain.buildHomeSessionRows()[0].modeBadge).toBe('');
  });
});

describe('home sessions column: gate', () => {
  it('renders on a wide desktop', () => {
    const app = loadHomeSessionsApp({}, 1512);
    expect(app.shouldShowHomeSessions()).toBe(true);
  });

  it('stays out of a window too narrow to hold it beside the centered content', () => {
    // Absolutely positioned: below the gate it would overlap the search panel
    // rather than push it aside.
    expect(loadHomeSessionsApp({}, 1100).shouldShowHomeSessions()).toBe(false);
    expect(loadHomeSessionsApp({}, 1179).shouldShowHomeSessions()).toBe(false);
    expect(loadHomeSessionsApp({}, 1180).shouldShowHomeSessions()).toBe(true);
  });

  it('yields to the phone overview, which already lists the same sessions', () => {
    const app = loadHomeSessionsApp({}, 390);
    expect(app.shouldUseMobileOverview()).toBe(true);
    expect(app.shouldShowHomeSessions()).toBe(false);
  });

  it('stays out of a popped-out solo window', () => {
    expect(loadHomeSessionsApp({ isSoloWindow: true }, 1512).shouldShowHomeSessions()).toBe(false);
  });
});

describe('home sessions column: wiring', () => {
  const js = readFileSync(resolve(PUBLIC, 'home-sessions.js'), 'utf8');
  const css = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');
  const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');

  it('keeps the JS width gate and the CSS media query in agreement', () => {
    // Two gates for one decision: the JS one hides the element, the CSS one is
    // the backstop for a resize that outruns the matchMedia listener. Drift
    // means a column that overlaps the welcome content at some widths.
    const jsMin = Number(/HOME_SESSIONS_MIN_WIDTH = (\d+)/.exec(js)?.[1]);
    const cssMax = Number(/@media \(max-width: (\d+)px\) \{\s*\.home-sessions \{/.exec(css)?.[1]);
    expect(jsMin).toBeGreaterThan(0);
    expect(cssMax).toBe(jsMin - 1);
  });

  it('re-asserts [hidden] over the flex display', () => {
    // .home-sessions is display:flex, which defeats the `hidden` attribute — the
    // module's only visibility lever — unless this rule exists.
    expect(css).toMatch(/\.home-sessions\[hidden\]\s*\{\s*display:\s*none;/);
  });

  it('reuses the tab-load spinner rather than declaring a second one', () => {
    // The working ring is the same motion a tab shows while it loads, on both
    // home screens. Re-declaring the keyframes here is how they drift apart.
    expect(js).toContain('tab-load-spin');
    expect(css).toMatch(/\.home-sessions-dot--working::after[\s\S]*?animation: tab-load-spin/);
    expect(css).not.toMatch(/@keyframes home-sessions-load-spin/);
    const mobileCss = readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8');
    expect(mobileCss).toMatch(/\.mobile-overview-dot--working::after[\s\S]*?animation: tab-load-spin/);
  });

  it('gives the working dot the same green halo on both home screens', () => {
    const halo = /box-shadow: 0 0 8px 2px color-mix\(in srgb, var\(--green\) 55%, transparent\)/;
    expect(css).toMatch(halo);
    expect(readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8')).toMatch(halo);
  });

  it('ships the container hidden, inside the welcome overlay, loaded after mobile-overview.js', () => {
    expect(html).toMatch(/<aside class="home-sessions" id="homeSessions" hidden><\/aside>/);
    const overlayStart = html.indexOf('id="welcomeOverlay"');
    const aside = html.indexOf('id="homeSessions"');
    const content = html.indexOf('class="welcome-content"');
    expect(overlayStart).toBeGreaterThan(-1);
    expect(aside).toBeGreaterThan(overlayStart);
    expect(aside).toBeLessThan(content);
    // Load order: the module reuses prototype methods installed by
    // mobile-overview.js. Compare the <script> tags, not any mention: both
    // files are named in explanatory comments earlier in the document.
    expect(html.indexOf('src="home-sessions.js"')).toBeGreaterThan(html.indexOf('src="mobile-overview.js"'));
  });
});
