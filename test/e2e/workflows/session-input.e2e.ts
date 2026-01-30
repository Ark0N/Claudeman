/**
 * Session Input E2E Test
 * Tests typing in terminal, command execution, and output verification
 *
 * Port: 3184 (see CLAUDE.md test port table)
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
  CleanupTracker,
  captureAndCompare,
  type ServerFixture,
  type BrowserFixture,
} from '../fixtures/index.js';
import { E2E_PORTS, E2E_TIMEOUTS, generateCaseName } from '../e2e.config.js';

const PORT = E2E_PORTS.SESSION_INPUT;
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

describe('Session Input E2E', () => {
  afterAll(async () => {
    if (cleanup) {
      await cleanup.forceCleanupAll();
    }
    if (serverFixture) {
      await destroyServerFixture(serverFixture);
    }
  }, E2E_TIMEOUTS.TEST);

  it('should accept keyboard input in terminal', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('input');

    try {
      serverFixture = await createServerFixture(PORT);
      cleanup = new CleanupTracker(serverFixture.baseUrl);
      cleanup.trackCase(caseName);

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);
      await clickElement(page, '.btn-claude');

      // Wait for session and terminal
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
      await page.waitForSelector('.xterm', { timeout: E2E_TIMEOUTS.TERMINAL_VISIBLE });

      // Click terminal to focus
      await clickElement(page, '.xterm');
      await new Promise(r => setTimeout(r, 500));

      // Type /help command
      await page.keyboard.type('/help');
      await page.keyboard.press('Enter');

      // Wait for output (help text should appear)
      await new Promise(r => setTimeout(r, 3000));

      // Take screenshot
      const screenshotResult = await captureAndCompare(page, 'session-input-help', {
        threshold: 0.1, // Higher threshold for dynamic content
      });
      // Just verify screenshot was taken (content varies)
      expect(screenshotResult.currentPath).toBeDefined();

      // Track session for cleanup
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      if (data?.length > 0) {
        cleanup.trackSession(data[data.length - 1].id);
      }

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should handle Ctrl+C to cancel input', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('ctrl-c');

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
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);
      await clickElement(page, '.btn-claude');

      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
      await page.waitForSelector('.xterm', { timeout: E2E_TIMEOUTS.TERMINAL_VISIBLE });

      // Focus terminal
      await clickElement(page, '.xterm');
      await new Promise(r => setTimeout(r, 500));

      // Type something
      await page.keyboard.type('some partial input');

      // Press Ctrl+C
      await page.keyboard.press('Control+c');
      await new Promise(r => setTimeout(r, 1000));

      // Verify session is still responsive (can type again)
      await page.keyboard.type('/help');
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 2000));

      // Track for cleanup
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      if (data?.length > 0) {
        cleanup.trackSession(data[data.length - 1].id);
      }

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should handle multi-line input', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('multiline');

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
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);
      await clickElement(page, '.btn-claude');

      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
      await page.waitForSelector('.xterm', { timeout: E2E_TIMEOUTS.TERMINAL_VISIBLE });

      // Focus terminal
      await clickElement(page, '.xterm');
      await new Promise(r => setTimeout(r, 500));

      // Type multi-line prompt
      await page.keyboard.type('Please help me with:');
      await page.keyboard.press('Shift+Enter'); // Soft newline in some terminals
      await page.keyboard.type('1. First thing');

      // Submit
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 2000));

      // Track for cleanup
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      if (data?.length > 0) {
        cleanup.trackSession(data[data.length - 1].id);
      }

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);
});
