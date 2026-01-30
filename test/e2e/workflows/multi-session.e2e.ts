/**
 * Multi-Session E2E Test
 * Tests multiple sessions, tab switching, and session isolation
 *
 * Port: 3186 (see CLAUDE.md test port table)
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createServerFixture,
  destroyServerFixture,
  createBrowserFixture,
  destroyBrowserFixture,
  navigateTo,
  clickElement,
  isVisible,
  getElementCount,
  getText,
  CleanupTracker,
  captureAndCompare,
  type ServerFixture,
  type BrowserFixture,
} from '../fixtures/index.js';
import { E2E_PORTS, E2E_TIMEOUTS, generateCaseName } from '../e2e.config.js';

const PORT = E2E_PORTS.MULTI_SESSION;
let serverFixture: ServerFixture | null = null;
let cleanup: CleanupTracker;

/**
 * Helper to create multiple cases via API
 */
async function createCasesViaApi(baseUrl: string, caseNames: string[]): Promise<void> {
  for (const caseName of caseNames) {
    const createRes = await fetch(`${baseUrl}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: caseName }),
    });
    expect(createRes.ok).toBe(true);
  }
}

describe('Multi-Session E2E', () => {
  afterAll(async () => {
    if (cleanup) {
      await cleanup.forceCleanupAll();
    }
    if (serverFixture) {
      await destroyServerFixture(serverFixture);
    }
  }, E2E_TIMEOUTS.TEST);

  it('should create multiple sessions with separate tabs', async () => {
    let browser: BrowserFixture | null = null;
    const caseNames = [
      generateCaseName('multi-1'),
      generateCaseName('multi-2'),
      generateCaseName('multi-3'),
    ];

    try {
      serverFixture = await createServerFixture(PORT);
      cleanup = new CleanupTracker(serverFixture.baseUrl);
      caseNames.forEach(name => cleanup.trackCase(name));

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Create cases via API first
      await createCasesViaApi(serverFixture.baseUrl, caseNames);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Create 3 sessions
      for (let i = 0; i < caseNames.length; i++) {
        await page.selectOption('#quickStartCase', caseNames[i]);
        await clickElement(page, '.btn-claude');
        await page.waitForSelector(`.session-tab:nth-child(${i + 1})`, {
          timeout: E2E_TIMEOUTS.SESSION_CREATE,
        });
        await new Promise(r => setTimeout(r, 1500)); // Wait between creations
      }

      // Verify 3 tabs exist
      const tabCount = await getElementCount(page, '.session-tab');
      expect(tabCount).toBe(3);

      // Verify tab counter
      const counter = await getText(page, '#tabCount');
      expect(counter).toBe('3');

      // Take screenshot
      const screenshotResult = await captureAndCompare(page, 'multi-session-tabs', {
        mask: ['.xterm-screen'], // Mask terminal content
      });
      expect(screenshotResult.currentPath).toBeDefined();

      // Track sessions for cleanup
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      data?.forEach((s: any) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST * 2);

  it('should switch between sessions correctly', async () => {
    let browser: BrowserFixture | null = null;
    const caseNames = [
      generateCaseName('switch-1'),
      generateCaseName('switch-2'),
    ];

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      caseNames.forEach(name => cleanup.trackCase(name));

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Create cases via API first
      await createCasesViaApi(serverFixture.baseUrl, caseNames);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Create 2 sessions
      for (let i = 0; i < caseNames.length; i++) {
        await page.selectOption('#quickStartCase', caseNames[i]);
        await clickElement(page, '.btn-claude');
        await page.waitForSelector(`.session-tab:nth-child(${i + 1})`, {
          timeout: E2E_TIMEOUTS.SESSION_CREATE,
        });
        await new Promise(r => setTimeout(r, 1500));
      }

      // Second tab should be active (most recently created)
      let activeTab = await page.$('.session-tab.active');
      let tabText = activeTab ? await activeTab.textContent() : '';
      expect(tabText).toContain(caseNames[1].split('-')[2]); // Contains timestamp from second case

      // Click first tab
      await clickElement(page, '.session-tab:nth-child(1)');
      await new Promise(r => setTimeout(r, 500));

      // First tab should now be active
      activeTab = await page.$('.session-tab.active');
      tabText = activeTab ? await activeTab.textContent() : '';
      expect(tabText).toContain(caseNames[0].split('-')[2]); // Contains timestamp from first case

      // Verify terminal is visible
      expect(await isVisible(page, '.xterm')).toBe(true);

      // Click second tab
      await clickElement(page, '.session-tab:nth-child(2)');
      await new Promise(r => setTimeout(r, 500));

      // Second tab should be active again
      activeTab = await page.$('.session-tab.active');
      tabText = activeTab ? await activeTab.textContent() : '';
      expect(tabText).toContain(caseNames[1].split('-')[2]);

      // Track sessions
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      data?.forEach((s: any) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST * 2);

  it('should use keyboard shortcut Ctrl+Tab to switch sessions', async () => {
    let browser: BrowserFixture | null = null;
    const caseNames = [
      generateCaseName('kb-1'),
      generateCaseName('kb-2'),
    ];

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      caseNames.forEach(name => cleanup.trackCase(name));

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Create cases via API first
      await createCasesViaApi(serverFixture.baseUrl, caseNames);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Create 2 sessions
      for (let i = 0; i < caseNames.length; i++) {
        await page.selectOption('#quickStartCase', caseNames[i]);
        await clickElement(page, '.btn-claude');
        await page.waitForSelector(`.session-tab:nth-child(${i + 1})`, {
          timeout: E2E_TIMEOUTS.SESSION_CREATE,
        });
        await new Promise(r => setTimeout(r, 1500));
      }

      // Second tab active initially
      let activeIndex = await page.$$eval('.session-tab', tabs =>
        tabs.findIndex(t => t.classList.contains('active'))
      );
      expect(activeIndex).toBe(1);

      // Press Ctrl+Tab
      await page.keyboard.press('Control+Tab');
      await new Promise(r => setTimeout(r, 500));

      // Should switch to first tab (wraps around)
      activeIndex = await page.$$eval('.session-tab', tabs =>
        tabs.findIndex(t => t.classList.contains('active'))
      );
      expect(activeIndex).toBe(0);

      // Press Ctrl+Tab again
      await page.keyboard.press('Control+Tab');
      await new Promise(r => setTimeout(r, 500));

      // Should switch back to second tab
      activeIndex = await page.$$eval('.session-tab', tabs =>
        tabs.findIndex(t => t.classList.contains('active'))
      );
      expect(activeIndex).toBe(1);

      // Track sessions
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      data?.forEach((s: any) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST * 2);

  it('should maintain session isolation after delete', async () => {
    let browser: BrowserFixture | null = null;
    const caseNames = [
      generateCaseName('iso-1'),
      generateCaseName('iso-2'),
      generateCaseName('iso-3'),
    ];

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      caseNames.forEach(name => cleanup.trackCase(name));

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Create cases via API first
      await createCasesViaApi(serverFixture.baseUrl, caseNames);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Create 3 sessions
      for (let i = 0; i < caseNames.length; i++) {
        await page.selectOption('#quickStartCase', caseNames[i]);
        await clickElement(page, '.btn-claude');
        await page.waitForSelector(`.session-tab:nth-child(${i + 1})`, {
          timeout: E2E_TIMEOUTS.SESSION_CREATE,
        });
        await new Promise(r => setTimeout(r, 1500));
      }

      // Track all sessions
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      data?.forEach((s: any) => cleanup.trackSession(s.id));

      // Delete middle session
      await clickElement(page, '.session-tab:nth-child(2)');
      await new Promise(r => setTimeout(r, 500));
      await clickElement(page, '.session-tab:nth-child(2) .tab-close');
      await new Promise(r => setTimeout(r, 1000));

      // Verify 2 tabs remain
      let tabCount = await getElementCount(page, '.session-tab');
      expect(tabCount).toBe(2);

      // Click first remaining tab
      await clickElement(page, '.session-tab:nth-child(1)');
      await new Promise(r => setTimeout(r, 500));

      // Verify it's active and has terminal
      expect(await isVisible(page, '.session-tab.active')).toBe(true);
      expect(await isVisible(page, '.xterm')).toBe(true);

      // Click second remaining tab
      await clickElement(page, '.session-tab:nth-child(2)');
      await new Promise(r => setTimeout(r, 500));

      // Verify it works too
      expect(await isVisible(page, '.session-tab.active')).toBe(true);
      expect(await isVisible(page, '.xterm')).toBe(true);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST * 2);
});
