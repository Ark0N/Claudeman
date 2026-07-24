#!/usr/bin/env node
/**
 * capture-real-overview.mjs
 *
 * Captures a REAL claude-overview screenshot from a LIVE Codeman server
 * (no mock injection). Drive a real session to do real work, then run:
 *
 *   SID=<sessionId> BASE=http://localhost:5000 OUT=screenshots-real \
 *     node scripts/capture-real-overview.mjs
 *
 * Skin defaults to daylight-blue (prod default) via the localStorage pre-paint
 * contract in index.html. Output: <OUT>/claude-overview.png at 1280x720 (DSF 2).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const SID = process.env.SID;
const BASE = process.env.BASE || 'http://localhost:5000';
const OUT = process.env.OUT || 'screenshots-real';
const SKIN = process.env.SKIN || 'daylight-blue';
// Unique filename per run (timestamped) so a viewer holding an old render of a
// fixed path can never shadow a fresh capture. Override with NAME=… if needed.
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const NAME = process.env.NAME || `claude-overview-${STAMP}.png`;
const VIEWPORT = { width: Number(process.env.VW || 1512), height: Number(process.env.VH || 812) };
// IMPORTANT: default deviceScaleFactor is 1, NOT 2. xterm's WebGL renderer in
// headless Chromium draws terminal glyphs at ~2× their nominal size when DSF=2
// (while still reporting nominal 8px cell dims internally, so it can't be caught
// by measuring terminal.cols/cell — only the pixels reveal it). The HTML chrome
// is unaffected, so DSF=2 makes ONLY the console font look comically large. DSF=1
// renders the console at its true size, matching a real (non-headless) browser.
const DSF = Number(process.env.DSF || 1);

if (!SID) {
  console.error('SID env var required (the live session id to screenshot)');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    ignoreHTTPSErrors: BASE.startsWith('https'),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Force the skin before any page script runs (pre-paint <head> contract), and
  // seed the PER-DEVICE display blob so the capture reflects what prod actually
  // shows on the user's real device — notably the plan-usage chip, which is a
  // per-device setting (default OFF) deleted from the server payload, so a fresh
  // browser would otherwise hide it. PLAN_USAGE=0 disables.
  const PLAN_USAGE = process.env.PLAN_USAGE !== '0';
  // Terminal console font size. App default is 14px; a fresh headless browser has
  // no saved codeman-font-size, so it renders at 14 — much larger than a real
  // device where the console has been zoomed down. Seed a smaller value (clamped
  // to the app's [10,24] range) so the console font looks normal in the capture.
  const FONT = Math.max(10, Math.min(24, Number(process.env.FONT || 14)));
  await page.addInitScript(
    ([skin, planUsage, font]) => {
      try {
        localStorage.setItem('codeman:skin', skin);
        localStorage.setItem('codeman-font-size', String(font));
        // Desktop app-settings blob (settings-ui.js getSettingsStorageKey()).
        // Present these display keys explicitly so the server merge won't seed
        // side panels open (display keys only seed from server when absent from
        // localStorage). Matches the clean full-width-terminal reference look.
        const blob = {
          skin,
          showFileBrowser: false,
          showMonitor: false,
          showSubagents: false,
          showProjectInsights: false,
          showTokenCount: false,
        };
        if (planUsage) blob.showPlanUsageLimits = true;
        localStorage.setItem('codeman-app-settings', JSON.stringify(blob));
      } catch {
        /* ignore */
      }
    },
    [SKIN, PLAN_USAGE, FONT]
  );

  // At DSF>1, xterm's WebGL renderer draws glyphs at ~2x (see DSF comment above).
  // The app honors a `?nowebgl` URL param that switches to xterm's DOM renderer,
  // which respects devicePixelRatio correctly — so DSF=2 + nowebgl yields a crisp
  // 2x (retina) capture at the TRUE font size. Auto-enable it whenever DSF>1.
  const url = DSF > 1 ? `${BASE}${BASE.includes('?') ? '&' : '?'}nowebgl` : BASE;
  console.log(`Loading ${url} (DSF=${DSF}) ...`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app && window.app.terminal, { timeout: 20000 });
  await sleep(1500);

  console.log(`Selecting session ${SID} ...`);
  await page.evaluate((sid) => window.app.selectSession(sid), SID);

  // Let the terminal buffer stream in + xterm render + any Ink redraw settle.
  await sleep(2000);

  // Force a clean fit (avoids capturing a transient pre-fit frame where the
  // terminal renders at the wrong column count) and re-apply per-device header
  // visibility so the seeded plan-usage chip is shown.
  await page.evaluate((font) => {
    // Force the console font explicitly (setFontSize also re-fits) in case
    // loadFontSize didn't pick up the seeded value before the session rendered.
    try {
      if (window.app.setFontSize) window.app.setFontSize(font);
      else window.app.terminal.options.fontSize = font;
    } catch {}
    try {
      window.app.fitAddon && window.app.fitAddon.fit();
    } catch {}
    try {
      window.dispatchEvent(new Event('resize'));
    } catch {}
    try {
      window.app.applyHeaderVisibilitySettings && window.app.applyHeaderVisibilitySettings();
    } catch {}
  }, FONT);
  await sleep(3000);

  // Optionally scroll the terminal up to frame the rich tool-call region
  // (Read/Write/Bash + green test results) instead of the trailing summary.
  const SCROLL = Number(process.env.SCROLL || 0);
  if (SCROLL) {
    await page.evaluate((n) => {
      const t = window.app && window.app.terminal;
      if (t && t.scrollLines) t.scrollLines(-n);
    }, SCROLL);
    await sleep(800);
  }

  const outPath = join(OUT, NAME);
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`Saved: ${outPath}`);

  await context.close();
  await browser.close();
};

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
