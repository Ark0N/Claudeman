/**
 * Manual verification harness for the session-sidebar feature.
 *
 * Renders the real UI in headless Chromium against a testMode WebServer,
 * injects a synthetic 25-session fleet, and screenshots every layout state.
 * Not part of the automated suite — run it by hand:
 *
 *   npx tsx scripts/verify-session-sidebar.mts
 *
 * SAFETY: uses the repo's own test harness (temp HOME, testMode server) on a
 * dedicated port. It never touches a real Codeman instance or tmux socket.
 */
import { chromium } from 'playwright';
import { WebServer } from '../src/web/server.js';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirror test/setup.ts: isolate HOME before the app modules touch state.
process.env.HOME = mkdtempSync(join(tmpdir(), 'codeman-sidebar-verify-'));
process.env.VITEST = 'true';

const PORT = 3299;
const OUT = process.env.SIDEBAR_SHOTS_DIR ?? join(tmpdir(), 'codeman-sidebar-shots');
mkdirSync(OUT, { recursive: true });

// Generic on purpose: these names end up in the harness screenshots, so they
// should not carry one contributor's project list into everyone else's review.
// The mix of CLI modes matters (each renders a different badge); the names do not.
const PROJECTS = [
  ['api-server', 'claude'],
  ['web-client', 'claude'],
  ['mobile-app', 'codex'],
  ['data-pipeline', 'claude'],
  ['shared-lib', 'gemini'],
  ['codeman', 'claude'],
  ['docs-site', 'claude'],
  ['batch-jobs', 'opencode'],
  ['search-index', 'claude'],
];
const STATUSES = ['idle', 'busy', 'idle', 'busy', 'error', 'idle'];

function fleet(n: number) {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const [proj, mode] = PROJECTS[i % PROJECTS.length];
    const status = STATUSES[i % STATUSES.length];
    out.push({
      id: `sess-${String(i).padStart(4, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
      pid: 10000 + i,
      status,
      workingDir: `${tmpdir()}/projects/${proj}`,
      name: `${proj}${i > 8 ? '-' + Math.floor(i / 9) : ''}`,
      mode,
      currentTaskId: null,
      createdAt: Date.now() - i * 60000,
      lastActivityAt: Date.now() - i * 1000,
      isWorking: status === 'busy',
      messageCount: i * 3,
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      color: 'default',
      taskStats: { total: i % 4, running: i % 3 === 0 ? 2 : 0, completed: 0, failed: 0 },
      taskTree: [],
      tokens: { input: 0, output: 0, total: 0 },
      bufferStats: { terminalBufferSize: 0, textOutputSize: 0, messageCount: 0 },
    });
  }
  return out;
}

const SESSIONS = fleet(25);

async function main() {
  const server = new WebServer(PORT, false, true);
  await server.start();
  const browser = await chromium.launch({ headless: true });
  const results: string[] = [];

  async function shot(
    name: string,
    opts: { layout: 'header' | 'sidebar'; collapsed?: boolean; width: number; height: number; touch?: boolean }
  ) {
    const ctx = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      hasTouch: !!opts.touch,
      isMobile: !!opts.touch,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const settings = JSON.stringify({ sessionListLayout: opts.layout });
    const collapsed = opts.collapsed === undefined ? null : opts.collapsed ? '1' : '0';
    await page.addInitScript(
      ([s, c]) => {
        localStorage.setItem('codeman-app-settings', s as string);
        localStorage.setItem('codeman-app-settings-mobile', s as string);
        if (c !== null) localStorage.setItem('codeman-sidebar-collapsed', c as string);
        else localStorage.removeItem('codeman-sidebar-collapsed');
      },
      [settings, collapsed]
    );
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    await page.evaluate((list) => {
      const app = (window as any).app;
      if (!app) throw new Error('no window.app');
      app.sessions.clear();
      for (const s of list as any[]) app.sessions.set(s.id, s);
      // The renderer iterates sessionOrder, not the map.
      app.sessionOrder = (list as any[]).map((s) => s.id);
      app.activeSessionId = (list as any[])[3].id;
      // renderSessionTabs() is debounced; drive the immediate path directly.
      (app._fullRenderSessionTabs ?? app._renderSessionTabsImmediate)?.call(app);
      app.applySessionListLayout?.();
    }, SESSIONS as any);
    await page.waitForTimeout(600);

    const info = await page.evaluate(() => {
      const root = document.documentElement;
      const aside = document.getElementById('sessionSidebar');
      const tabsEl = document.getElementById('sessionTabs');
      const asideBox = aside?.getBoundingClientRect();
      const cs = aside ? getComputedStyle(aside) : null;
      return {
        dataSessionList: root.dataset.sessionList ?? null,
        dataSidebar: root.dataset.sidebar ?? null,
        rows: document.querySelectorAll('.session-tab').length,
        tabsParent: tabsEl?.parentElement?.id || tabsEl?.parentElement?.className || null,
        asideWidth: asideBox ? Math.round(asideBox.width) : null,
        asideVisible: cs ? cs.display !== 'none' && cs.visibility !== 'hidden' : null,
        asideInert: aside?.hasAttribute('inert') ?? null,
        ariaHidden: aside?.getAttribute('aria-hidden') ?? null,
        toggleAriaExpanded: document.getElementById('sidebarToggleBtn')?.getAttribute('aria-expanded') ?? null,
        firstRowText:
          (document.querySelector('.session-tab') as HTMLElement | null)?.innerText
            ?.trim()
            .replace(/\s+/g, ' ')
            .slice(0, 40) ?? null,
        listScrollable: (() => {
          const el = document.getElementById('sessionTabs');
          return el ? el.scrollHeight > el.clientHeight + 2 : null;
        })(),
      };
    });

    await page.waitForTimeout(400);
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    results.push(`${name.padEnd(28)} ${JSON.stringify(info)}`);
    await ctx.close();
    return info;
  }

  await shot('01-header-desktop', { layout: 'header', width: 1600, height: 900 });
  await shot('02-sidebar-expanded', { layout: 'sidebar', collapsed: false, width: 1600, height: 900 });
  await shot('03-sidebar-collapsed-rail', { layout: 'sidebar', collapsed: true, width: 1600, height: 900 });
  await shot('04-sidebar-narrow-1000', { layout: 'sidebar', collapsed: true, width: 1000, height: 800 });
  await shot('05-sidebar-drawer-open-1000', { layout: 'sidebar', collapsed: false, width: 1000, height: 800 });
  await shot('06-sidebar-phone-closed', { layout: 'sidebar', collapsed: true, width: 393, height: 852, touch: true });
  await shot('07-sidebar-phone-open', { layout: 'sidebar', collapsed: false, width: 393, height: 852, touch: true });

  console.log('\n=== RESULTS ===');
  for (const r of results) console.log(r);
  console.log(`\nScreenshots in ${OUT}`);

  await browser.close();
  await server.stop();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
