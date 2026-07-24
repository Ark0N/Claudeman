#!/usr/bin/env node
/**
 * capture-readme-real.mjs
 *
 * Captures README desktop scenes (multi-session dashboard, monitor, subagent
 * windows) from a REAL Codeman instance — intended to run against an ISOLATED
 * dev/beta instance (CODEMAN_INSTANCE=beta on :5000) seeded from prod's settings,
 * NOT prod itself (never touch prod's live sessions).
 *
 * Reuses the high-quality capture recipe proven in capture-real-overview.mjs:
 *   - DSF=2 + ?nowebgl  → crisp retina at the TRUE font size (WebGL doubles
 *     glyphs under DSF=2; the DOM renderer respects devicePixelRatio).
 *   - per-device localStorage seeding so the capture matches a real device.
 *
 *   SCENE=dashboard|monitor|subagent|all  BASE=http://localhost:5000 \
 *     OUT=screenshots-readme-real/desktop  node scripts/capture-readme-real.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const BASE = process.env.BASE || 'http://localhost:5000';
const OUT = process.env.OUT || 'screenshots-readme-real/desktop';
const SKIN = process.env.SKIN || 'daylight-blue';
const SCENE = process.env.SCENE || 'all';
const FONT = Math.max(10, Math.min(24, Number(process.env.FONT || 13)));
const VIEWPORT = { width: Number(process.env.VW || 1280), height: Number(process.env.VH || 720) };
const DSF = Number(process.env.DSF || 2);
const PLAN_USAGE = process.env.PLAN_USAGE !== '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (extra = '') => {
  const sep = BASE.includes('?') ? '&' : '?';
  const params = [];
  if (DSF > 1) params.push('nowebgl'); // DOM renderer → correct font size at DSF>1
  if (extra) params.push(extra);
  return params.length ? `${BASE}${sep}${params.join('&')}` : BASE;
};

async function newCtx(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    ignoreHTTPSErrors: BASE.startsWith('https'),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript(
    ([skin, planUsage, font]) => {
      try {
        localStorage.setItem('codeman:skin', skin);
        localStorage.setItem('codeman-font-size', String(font));
        const blob = { skin, showFileBrowser: false, showProjectInsights: false, showTokenCount: false };
        // Don't auto-hide subagent windows that belong to a non-active tab — the
        // subagent scene re-homes agents and needs both windows visible at once.
        blob.subagentActiveTabOnly = false;
        if (planUsage) blob.showPlanUsageLimits = true;
        localStorage.setItem('codeman-app-settings', JSON.stringify(blob));
      } catch {
        /* ignore */
      }
    },
    [SKIN, PLAN_USAGE, FONT]
  );
  return { context, page };
}

async function bootstrap(page) {
  await page.waitForFunction(() => window.app && window.app.terminal, { timeout: 20000 });
  await sleep(1200);
}

async function listSessions(page) {
  return page.evaluate(() =>
    Array.from(window.app.sessions.values()).map((s) => ({ id: s.id, name: s.name, mode: s.mode }))
  );
}

async function shoot(page, name) {
  const out = join(OUT, name);
  await page.evaluate((f) => {
    try {
      if (window.app.setFontSize) window.app.setFontSize(f);
    } catch {}
    try {
      window.app.fitAddon && window.app.fitAddon.fit();
    } catch {}
    try {
      window.app.applyHeaderVisibilitySettings && window.app.applyHeaderVisibilitySettings();
    } catch {}
  }, FONT);
  await sleep(1500);
  await page.screenshot({ path: out, fullPage: false });
  console.log('  Saved: ' + out);
}

async function sceneDashboard(browser) {
  console.log('Scene: dashboard');
  const { context, page } = await newCtx(browser);
  await page.goto(url(), { waitUntil: 'domcontentloaded' });
  await bootstrap(page);
  const sessions = await listSessions(page);
  // Select a claude session so the active terminal shows rich content; all tabs render.
  const target = sessions.find((s) => s.mode === 'claude') || sessions[0];
  if (target) await page.evaluate((id) => window.app.selectSession(id), target.id);
  await sleep(4000);
  await shoot(page, 'multi-session-dashboard.png');
  await context.close();
}

async function sceneMonitor(browser) {
  console.log('Scene: monitor');
  const { context, page } = await newCtx(browser);
  await page.goto(url(), { waitUntil: 'domcontentloaded' });
  await bootstrap(page);
  const sessions = await listSessions(page);
  const target = sessions.find((s) => s.mode === 'claude') || sessions[0];
  if (target) await page.evaluate((id) => window.app.selectSession(id), target.id);
  await sleep(2500);
  // toggleMonitorPanel() opens the panel, clears the hidden state, loads REAL
  // mux sessions (/api/mux), starts stats, and renders the task panel.
  await page.evaluate(async () => {
    try {
      await window.app.toggleMonitorPanel();
    } catch {}
  });
  await sleep(3000);
  await shoot(page, 'multi-session-monitor.png');
  await context.close();
}

async function sceneSubagent(browser) {
  console.log('Scene: subagent');
  const { context, page } = await newCtx(browser);
  await page.goto(url(), { waitUntil: 'domcontentloaded' });
  await bootstrap(page);
  // Select the session whose subagents we want (subagentActiveTabOnly means
  // app.subagents only fills for the active tab). Prefer SUBAGENT_SID env.
  const sessions = await listSessions(page);
  const targetId = process.env.SUBAGENT_SID || (sessions.find((s) => s.mode === 'claude') || sessions[0])?.id;
  if (targetId) await page.evaluate((id) => window.app.selectSession(id), targetId);
  // Wait (up to ~45s) for live subagents to arrive via SSE into app.subagents.
  let agents = [];
  for (let i = 0; i < 45; i++) {
    agents = await page.evaluate(() =>
      Array.from(window.app.subagents?.entries?.() || []).map(([id, a]) => ({ id, name: a.name ?? a.agentType ?? '' }))
    );
    if (agents.length >= 1) break;
    await sleep(1000);
  }
  console.log('  live in-browser subagents:', JSON.stringify(agents));
  if (agents.length === 0) {
    console.log('  NO live subagents — skipping (stage a longer subagent task and run this while it runs).');
    await context.close();
    return;
  }
  // The window body renders from app.subagentActivity, which fills ONLY from live
  // SSE tool-call/progress events — a fresh client never gets past activity replayed.
  // So sit connected and wait for live activity to accumulate, then open the two
  // agents that actually have content (otherwise the windows read "No activity yet").
  let active = [];
  for (let i = 0; i < 100; i++) {
    active = await page.evaluate(() =>
      Array.from(window.app.subagentActivity?.entries?.() || [])
        .filter(([, arr]) => Array.isArray(arr) && arr.length >= 1)
        .map(([id, arr]) => ({ id, n: arr.length }))
        .sort((a, b) => b.n - a.n)
    );
    if (active.length >= 2) break;
    // xhigh-effort agents churn in bursts between long thinking pauses, so be
    // patient (~150s); accept a single populated window after ~45s if that's all.
    if (i >= 30 && active.length >= 1) break;
    await sleep(1500);
  }
  console.log('  agents with live activity:', JSON.stringify(active));
  const openIds = (active.length ? active : agents).map((a) => a.id);
  // Capture-only DOM nudge: on fresh dev sessions, a tab's claudeSessionId stays the
  // Codeman id and never becomes the real Claude conversation UUID, so the window
  // open-gate (claudeSessionId === agent.sessionId) + the activeTabOnly hide rule both
  // fail. Re-home the chosen agents onto the active tab and align its claudeSessionId
  // to the agents' (shared) sessionId so the windows open AND show their live activity.
  await page.evaluate(
    (ids) => {
      const activeId = window.app.activeSessionId;
      const tab = window.app.sessions.get(activeId);
      ids.slice(0, 2).forEach((id) => {
        const a = window.app.subagents.get(id);
        if (!a) return;
        a.parentSessionId = activeId;
        if (tab && a.sessionId) tab.claudeSessionId = a.sessionId;
      });
    },
    openIds
  );
  await page.evaluate(
    (ids) => {
      ids.slice(0, 2).forEach((id) => {
        try {
          window.app.openSubagentWindow(id);
        } catch {}
      });
    },
    openIds
  );
  await sleep(2000);
  await page.evaluate(() => {
    // Viewport-relative tiling: center two subagent windows over the terminal so
    // the layout adapts to whatever VW/VH the capture uses (e.g. the HQ 1100×650
    // recipe) instead of overflowing at narrower widths.
    const wins = Array.from(window.app.subagentWindows.values());
    const W = window.innerWidth;
    const H = window.innerHeight;
    const winW = Math.min(440, Math.floor((W - 60) / 2 - 10));
    const winH = Math.min(360, Math.floor(H * 0.56));
    const top = Math.floor(H * 0.16);
    const gap = 16;
    const totalW = winW * 2 + gap;
    const startLeft = Math.max(16, Math.floor((W - totalW) / 2));
    wins.slice(0, 2).forEach((win, i) => {
      const el = win.element;
      // Force visible: a freshly opened window may be hidden by the activeTabOnly
      // rule before we override it (we also seed subagentActiveTabOnly:false).
      win.hidden = false;
      win.minimized = false;
      el.style.display = 'flex';
      el.style.left = startLeft + i * (winW + gap) + 'px';
      el.style.top = top + 'px';
      el.style.width = winW + 'px';
      el.style.height = winH + 'px';
    });
  });
  await sleep(1500);
  await shoot(page, 'subagent-spawn.png');
  await context.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  console.log(`BASE=${BASE} SKIN=${SKIN} DSF=${DSF} VIEWPORT=${VIEWPORT.width}x${VIEWPORT.height} SCENE=${SCENE}`);
  if (SCENE === 'dashboard' || SCENE === 'all') await sceneDashboard(browser);
  if (SCENE === 'monitor' || SCENE === 'all') await sceneMonitor(browser);
  if (SCENE === 'subagent' || SCENE === 'all') await sceneSubagent(browser);
  await browser.close();
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
