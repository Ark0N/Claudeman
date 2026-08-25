/** @fileoverview Real Chromium coverage for COD-358 rail resize and label geometry. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const settingsUi = readFileSync(resolve(publicDir, 'settings-ui.js'), 'utf8');
const controller = readFileSync(resolve(publicDir, 'tab-rail-resize.js'), 'utf8');

describe('COD-358 vertical rail in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`<!doctype html><html data-tab-orientation="vertical"><head><style>${styles}</style></head>
      <body><header class="header"><div id="sessionTabsHost"></div></header><main class="main" style="width:100%;height:700px">
        <aside class="tab-rail" id="tabRail"><div class="session-tabs" id="sessionTabs"><div class="session-tab active">
          <span class="tab-info"><span class="tab-name-row"><span class="tab-name"><span class="tab-name-prefix">w2-codeman: </span>super-long-unbroken-session-name-for-wrapping</span></span></span>
        </div></div><div id="tabRailResizeHandle" class="tab-rail-resize-handle" role="separator" tabindex="0" aria-valuemin="208" aria-valuemax="360" aria-valuenow="256"></div></aside>
        <div class="terminal-wrap"><iframe title="terminal"></iframe></div></main>
        <div id="tabRailResizeShield" class="tab-rail-resize-shield" hidden></div>
        <select id="appSettingsTabRailWidth"><option value="custom">Custom</option><option value="208">Compact</option><option value="256">Default</option><option value="320">Wide</option><option value="360">Maximum</option></select>
      </body></html>`);
    await page.addScriptTag({ content: constants });
    await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp = CodemanApp;' });
    await page.addScriptTag({ content: settingsUi });
    await page.addScriptTag({ content: controller });
    await page.evaluate(() => {
      const app = new (window as any).CodemanApp();
      const settings = { tabOrientation: 'vertical', tabRailWidth: 256 };
      (window as any).__settings = settings;
      (window as any).__deviceType = 'desktop';
      (window as any).MobileDetection = { getDeviceType: () => (window as any).__deviceType };
      app.activeSessionId = 'session-1';
      app.loadAppSettingsFromStorage = () => settings;
      app.saveAppSettingsToStorage = (next: Record<string, unknown>) => Object.assign(settings, next);
      app.getDefaultSettings = () => ({});
      app.isSessionSidebarActive = () => false;
      app.updateTabOverflowMode = () => undefined;
      app._fullRenderSessionTabs = () => undefined;
      app._updateConnectionLinesImmediate = () => undefined;
      app.fitAddon = { proposeDimensions: () => ({ cols: 80, rows: 24 }), fit: () => undefined };
      app.sendResize = async () => ((window as any).__resizeCount = ((window as any).__resizeCount || 0) + 1);
      app.initTabRailResize();
      (window as any).app = app;
    });
  });

  afterAll(async () => browser.close());

  it('shows the complete label while clamping it to two lines', async () => {
    const metrics = await page.locator('.tab-name').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        clamp: style.getPropertyValue('-webkit-line-clamp'),
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
      };
    });
    expect(metrics.text).toBe('w2-codeman: super-long-unbroken-session-name-for-wrapping');
    expect(metrics.clamp).toBe('2');
    expect(metrics.whiteSpace).toBe('normal');
    expect(metrics.overflowWrap).toBe('anywhere');
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 2 + 1);
  });

  it('resizes from the keyboard and settles once', async () => {
    const handle = page.locator('#tabRailResizeHandle');
    await handle.focus();
    await handle.press('ArrowRight');
    expect(await handle.getAttribute('aria-valuenow')).toBe('264');
    await page.waitForTimeout(180);
    expect(await page.evaluate(() => (window as any).__resizeCount)).toBe(1);
  });

  it('preserves 360px while a narrow viewport applies only an effective clamp', async () => {
    await page.setViewportSize({ width: 700, height: 800 });
    const narrow = await page.evaluate(() => {
      (window as any).__settings.tabRailWidth = 360;
      return { effective: (window as any).app.applyTabRailWidth(), preferred: (window as any).__settings.tabRailWidth };
    });
    expect(narrow).toEqual({ effective: 280, preferred: 360 });
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await page.evaluate(() => (window as any).app.applyTabRailWidth())).toBe(360);
  });

  it('reapplies phone fallback in both directions without changing preferences', async () => {
    await page.evaluate(() => {
      (window as any).__settings.tabRailWidth = 360;
      (window as any).__deviceType = 'mobile';
    });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(130);
    expect(await page.locator('#sessionTabs').evaluate((node) => node.parentElement?.id)).toBe('sessionTabsHost');
    expect(await page.evaluate(() => (window as any).__settings)).toEqual({
      tabOrientation: 'vertical',
      tabRailWidth: 360,
    });

    await page.evaluate(() => ((window as any).__deviceType = 'desktop'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(130);
    expect(await page.locator('#sessionTabs').evaluate((node) => node.parentElement?.id)).toBe('tabRail');
    expect(await page.evaluate(() => (window as any).app._getCurrentTabRailWidth())).toBe(360);
  });
});
