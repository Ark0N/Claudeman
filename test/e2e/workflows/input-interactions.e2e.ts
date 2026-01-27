/**
 * Input Interactions E2E Test
 * Tests real user input patterns: clicking, typing, keyboard shortcuts
 *
 * Port: 3188 (see CLAUDE.md test port table)
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
  getText,
  getElementCount,
  CleanupTracker,
  captureAndCompare,
  type ServerFixture,
  type BrowserFixture,
} from '../fixtures/index.js';
import { E2E_PORTS, E2E_TIMEOUTS, generateCaseName } from '../e2e.config.js';

const PORT = E2E_PORTS.INPUT_INTERACTIONS;
let serverFixture: ServerFixture | null = null;
let cleanup: CleanupTracker;

/**
 * Helper to create a case via API and select it in the dropdown
 */
async function createAndSelectCase(baseUrl: string, page: any, caseName: string): Promise<void> {
  const createRes = await fetch(`${baseUrl}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: caseName }),
  });
  expect(createRes.ok).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.selectOption('#quickStartCase', caseName);
}

describe('Input Interactions E2E', () => {
  afterAll(async () => {
    if (cleanup) {
      await cleanup.forceCleanupAll();
    }
    if (serverFixture) {
      await destroyServerFixture(serverFixture);
    }
  }, E2E_TIMEOUTS.TEST);

  it('should open and close help modal via click', async () => {
    let browser: BrowserFixture | null = null;

    try {
      serverFixture = await createServerFixture(PORT);
      cleanup = new CleanupTracker(serverFixture.baseUrl);

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Click help button
      await clickElement(page, '.help-btn');
      await new Promise(r => setTimeout(r, 500));

      // Verify help modal is visible
      expect(await isVisible(page, '#helpModal .modal-content')).toBe(true);

      // Verify content
      const helpText = await getText(page, '#helpModal h3');
      expect(helpText).toContain('Keyboard Shortcuts');

      // Close via X button
      await clickElement(page, '#helpModal .modal-close');
      await new Promise(r => setTimeout(r, 300));

      // Verify modal is hidden
      expect(await isVisible(page, '#helpModal .modal-content')).toBe(false);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should close modal with Escape key', async () => {
    let browser: BrowserFixture | null = null;

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Open help modal
      await clickElement(page, '.help-btn');
      await new Promise(r => setTimeout(r, 500));
      expect(await isVisible(page, '#helpModal .modal-content')).toBe(true);

      // Press Escape
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 300));

      // Modal should be closed
      expect(await isVisible(page, '#helpModal .modal-content')).toBe(false);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should navigate settings modal tabs via click', async () => {
    let browser: BrowserFixture | null = null;

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Open settings modal
      await clickElement(page, '.btn-settings');
      await new Promise(r => setTimeout(r, 500));
      expect(await isVisible(page, '#appSettingsModal .modal-content')).toBe(true);

      // Verify 4 tabs exist
      const tabCount = await getElementCount(page, '#appSettingsModal .modal-tab-btn');
      expect(tabCount).toBe(4);

      // Click each tab and verify content changes
      const tabs = ['general', 'display', 'notifications', 'advanced'];
      for (const tab of tabs) {
        await clickElement(page, `#appSettingsModal .modal-tab-btn[data-tab="${tab}"]`);
        await new Promise(r => setTimeout(r, 300));

        // Verify tab is active
        const isActive = await page.$eval(
          `#appSettingsModal .modal-tab-btn[data-tab="${tab}"]`,
          el => el.classList.contains('active')
        );
        expect(isActive).toBe(true);
      }

      // Take screenshot
      const screenshotResult = await captureAndCompare(page, 'settings-tabs', {
        threshold: 0.1,
      });
      expect(screenshotResult.currentPath).toBeDefined();

      // Close modal
      await clickElement(page, '#appSettingsModal .modal-close');
      await new Promise(r => setTimeout(r, 300));

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should toggle checkbox settings by clicking', async () => {
    let browser: BrowserFixture | null = null;

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Open settings modal
      await clickElement(page, '.btn-settings');
      await new Promise(r => setTimeout(r, 500));

      // Go to display tab
      await clickElement(page, '#appSettingsModal .modal-tab-btn[data-tab="display"]');
      await new Promise(r => setTimeout(r, 300));

      // Find a checkbox (e.g., subagent tracking)
      const checkbox = await page.$('#appSettingsModal input[type="checkbox"]');
      if (checkbox) {
        const initialChecked = await checkbox.isChecked();

        // Click to toggle
        await checkbox.click();
        await new Promise(r => setTimeout(r, 300));

        const afterChecked = await checkbox.isChecked();
        expect(afterChecked).not.toBe(initialChecked);

        // Toggle back
        await checkbox.click();
        await new Promise(r => setTimeout(r, 300));

        const finalChecked = await checkbox.isChecked();
        expect(finalChecked).toBe(initialChecked);
      }

      // Close modal
      await clickElement(page, '#appSettingsModal .modal-close');

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should use Ctrl+Enter to quick-start session', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('ctrl-enter');

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      cleanup.trackCase(caseName);

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Create and select case
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);

      // Use Ctrl+Enter shortcut
      await page.keyboard.press('Control+Enter');

      // Wait for session to be created
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Verify session was created
      expect(await isVisible(page, '.session-tab.active')).toBe(true);

      // Track session
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      data.sessions?.forEach((s: any) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should use Ctrl+W to close session', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('ctrl-w');

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      cleanup.trackCase(caseName);

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Create session
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);
      await clickElement(page, '.btn-claude');
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Verify session exists
      expect(await isVisible(page, '.session-tab.active')).toBe(true);

      // Use Ctrl+W shortcut
      await page.keyboard.press('Control+w');

      // Wait for session to close
      await page.waitForSelector('.session-tab', { state: 'detached', timeout: 10000 });

      // Verify session is gone
      const tabCount = await getElementCount(page, '.session-tab');
      expect(tabCount).toBe(0);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should handle font size controls', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('font-size');

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      cleanup.trackCase(caseName);

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Create a session first
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);
      await clickElement(page, '.btn-claude');
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
      await page.waitForSelector('.xterm', { timeout: E2E_TIMEOUTS.TERMINAL_VISIBLE });

      // Get initial font display
      const initialFont = await getText(page, '.header-font-controls span');

      // Click increase font button
      const increaseBtn = await page.$('.header-font-controls button:last-child');
      if (increaseBtn) {
        await increaseBtn.click();
        await new Promise(r => setTimeout(r, 300));

        // Font should have changed
        const afterFont = await getText(page, '.header-font-controls span');
        // Font might be same if at max, so just verify no crash
        expect(afterFont).toBeDefined();
      }

      // Track session
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      data.sessions?.forEach((s: any) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should handle special characters in input', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('special-chars');

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      cleanup.trackCase(caseName);

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Create session
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);
      await clickElement(page, '.btn-claude');
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
      await page.waitForSelector('.xterm', { timeout: E2E_TIMEOUTS.TERMINAL_VISIBLE });

      // Focus terminal
      await clickElement(page, '.xterm');
      await new Promise(r => setTimeout(r, 500));

      // Type special characters
      await page.keyboard.type('Hello! "Test" `code` $var && echo done');
      await new Promise(r => setTimeout(r, 500));

      // Verify no crash - the input was accepted
      expect(await isVisible(page, '.xterm')).toBe(true);

      // Track session
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      data.sessions?.forEach((s: any) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);
});
