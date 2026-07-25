// Port 3208 - Header button visibility (real-browser E2E).
//
// Companion to the CI static guard (test/mobile-header-buttons-policy.test.ts).
// Renders the real app and asserts ACTUAL computed visibility, catching CSS/layout
// regressions the static parser can't see. Two behaviours are covered:
//   1. The minimal phone header hides the settings gear + lifecycle log.
//   2. The attachments button (COD-39) is OPT-IN — default-hidden everywhere, shown
//      only when App Settings → Display → "Attachments Button" is enabled. It first
//      shipped always-visible (mobile, then desktop), which is the regression here.
import { describe, it, beforeAll, afterAll } from 'vitest';
import type { WebServer } from '../../src/web/server.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { assertHidden, assertVisible } from './helpers/assertions.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import { PORTS, WAIT } from './helpers/constants.js';

const PORT = PORTS.HEADER_BUTTONS;
const BASE_URL = `http://localhost:${PORT}`;

describe('Header button visibility (E2E)', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  it('hides the settings gear + lifecycle log on a standard phone (iPhone 14 Pro)', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertHidden(page, '.btn-icon-header.btn-settings');
    await assertHidden(page, '.btn-icon-header.btn-lifecycle-log');
    await assertVisible(page, '#instanceShutdownBtn');
  });

  it('confirms instance shutdown without restoring terminal keyboard focus', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);

    await page.locator('.xterm-helper-textarea').focus();
    await page.locator('#instanceShutdownBtn').click();
    await assertVisible(page, '#instanceShutdownModal');

    const opened = await page.evaluate(() => ({
      activeId: document.activeElement?.id || '',
      terminalFocused: document.activeElement?.classList.contains('xterm-helper-textarea') || false,
      modalZ: Number.parseInt(getComputedStyle(document.getElementById('instanceShutdownModal')!).zIndex, 10),
      headerZ: Number.parseInt(getComputedStyle(document.querySelector('.header')!).zIndex, 10),
    }));
    expect(opened.activeId).toBe('instanceShutdownCancelBtn');
    expect(opened.terminalFocused).toBe(false);
    expect(opened.modalZ).toBeGreaterThan(opened.headerZ);

    await page.locator('#instanceShutdownCancelBtn').click();
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') || false)
    ).toBe(false);

    await page.locator('#instanceShutdownBtn').click();
    const responsePromise = page.waitForResponse(
      (response) => response.url().endsWith('/api/system/shutdown') && response.request().method() === 'POST'
    );
    await page.locator('#instanceShutdownConfirmBtn').click();
    expect((await responsePromise).status()).toBe(202);
    await page.waitForFunction(() =>
      document.getElementById('instanceShutdownStatus')?.textContent?.includes('Codeman is stopping')
    );
  });

  it('keeps the opt-in attachments button HIDDEN by default on a desktop-class viewport', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertHidden(page, '#attachmentsHistoryBtn');
    await assertVisible(page, '#instanceShutdownBtn');
  });

  it('shows the attachments button once the setting is enabled', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], BASE_URL);
    // Desktop-class devices use the non-mobile settings blob.
    await page.evaluate(() => {
      const cur = JSON.parse(localStorage.getItem('codeman-app-settings') || '{}');
      cur.showAttachmentsButton = true;
      localStorage.setItem('codeman-app-settings', JSON.stringify(cur));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertVisible(page, '#attachmentsHistoryBtn');
  });
});
