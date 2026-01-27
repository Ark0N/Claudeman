/**
 * Quick Start E2E Test - THE critical test
 * Tests the complete flow: click button -> case created -> session created -> screen created -> terminal visible
 *
 * Port: 3183 (see CLAUDE.md test port table)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import {
  createServerFixture,
  destroyServerFixture,
  createBrowserFixture,
  destroyBrowserFixture,
  navigateTo,
  waitForVisible,
  clickElement,
  getText,
  isVisible,
  CleanupTracker,
  captureAndCompare,
  type ServerFixture,
  type BrowserFixture,
} from '../fixtures/index.js';
import { E2E_PORTS, E2E_TIMEOUTS, generateCaseName } from '../e2e.config.js';

const PORT = E2E_PORTS.QUICK_START;
let serverFixture: ServerFixture | null = null;
let cleanup: CleanupTracker;

/**
 * Helper to create a case via API and select it in the dropdown
 */
async function createAndSelectCase(baseUrl: string, page: any, caseName: string): Promise<void> {
  // Create case via API
  const createRes = await fetch(`${baseUrl}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: caseName }),
  });
  expect(createRes.ok).toBe(true);

  // Refresh page to get updated case list
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // Select the case in dropdown
  await page.selectOption('#quickStartCase', caseName);
}

describe('Quick Start E2E', () => {
  afterAll(async () => {
    if (cleanup) {
      await cleanup.forceCleanupAll();
    }
    if (serverFixture) {
      await destroyServerFixture(serverFixture);
    }
  }, E2E_TIMEOUTS.TEST);

  it('should create session with real screen via quick-start button', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('quickstart');

    try {
      // Start server
      serverFixture = await createServerFixture(PORT);
      cleanup = new CleanupTracker(serverFixture.baseUrl);
      cleanup.trackCase(caseName);

      // Launch browser
      browser = await createBrowserFixture();
      const { page } = browser;

      // Navigate to Claudeman
      await navigateTo(page, serverFixture.baseUrl);

      // Verify page loaded
      const title = await page.title();
      expect(title).toBe('Claudeman');

      // Create case via API and select it
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);

      // Click the Claude button to create session
      await clickElement(page, '.btn-claude');

      // Wait for session tab to appear (this is the critical moment)
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Verify tab is active
      expect(await isVisible(page, '.session-tab.active')).toBe(true);

      // Get session ID from API
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      const session = data.sessions?.find((s: any) => s.workingDir?.includes(caseName));
      expect(session).toBeDefined();
      cleanup.trackSession(session.id);

      // CRITICAL: Verify a real screen was created
      // Screen names are claudeman-{sessionId.slice(0,8)}
      // This is what would have caught the cpulimit bug
      const screenList = execSync('screen -ls 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const sessionIdPrefix = session.id.slice(0, 8);
      const screenMatch = screenList.includes(`claudeman-${sessionIdPrefix}`);
      expect(screenMatch).toBe(true);

      // Track the screen for cleanup
      cleanup.trackScreen(`claudeman-${sessionIdPrefix}`);

      // Wait for terminal to be visible
      await page.waitForSelector('.xterm', { timeout: E2E_TIMEOUTS.TERMINAL_VISIBLE });
      expect(await isVisible(page, '.xterm')).toBe(true);

      // Take screenshot for visual regression
      const screenshotResult = await captureAndCompare(page, 'quick-start-session-created', {
        mask: ['.xterm-screen'], // Mask terminal content as it varies
      });
      expect(screenshotResult.passed).toBe(true);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should show screen exists after session creation', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('screen-verify');

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

      // Wait for session
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Get session from API
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      expect(data.sessions?.length).toBeGreaterThan(0);

      const session = data.sessions.find((s: any) => s.workingDir?.includes(caseName));
      expect(session).toBeDefined();
      cleanup.trackSession(session.id);

      // Verify screen exists using cleanup tracker method
      // Screen name is claudeman-{sessionId.slice(0,8)}
      const screenName = `claudeman-${session.id.slice(0, 8)}`;
      const screenExists = cleanup.screenExists(screenName);
      expect(screenExists).toBe(true);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should display tab counter correctly', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('tab-counter');

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

      // Check initial tab count (may have restored sessions from previous tests)
      const initialCountStr = await getText(page, '#tabCount');
      const initialCount = parseInt(initialCountStr, 10) || 0;

      // Create case and session
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);
      await clickElement(page, '.btn-claude');
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Check tab count increased
      await new Promise(r => setTimeout(r, 500)); // Wait for UI update
      const newCountStr = await getText(page, '#tabCount');
      const newCount = parseInt(newCountStr, 10) || 0;
      expect(newCount).toBeGreaterThan(initialCount);

      // Track for cleanup
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      if (data.sessions?.length > 0) {
        cleanup.trackSession(data.sessions[data.sessions.length - 1].id);
      }

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);
});
