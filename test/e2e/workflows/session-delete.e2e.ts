/**
 * Session Delete E2E Test
 * Tests delete button -> screen killed -> UI updated flow
 *
 * Port: 3185 (see CLAUDE.md test port table)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import {
  createServerFixture,
  destroyServerFixture,
  createBrowserFixture,
  destroyBrowserFixture,
  navigateTo,
  clickElement,
  isVisible,
  getElementCount,
  CleanupTracker,
  type ServerFixture,
  type BrowserFixture,
} from '../fixtures/index.js';
import { E2E_PORTS, E2E_TIMEOUTS, generateCaseName } from '../e2e.config.js';

const PORT = E2E_PORTS.SESSION_DELETE;
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

describe('Session Delete E2E', () => {
  afterAll(async () => {
    if (cleanup) {
      await cleanup.forceCleanupAll();
    }
    if (serverFixture) {
      await destroyServerFixture(serverFixture);
    }
  }, E2E_TIMEOUTS.TEST);

  it('should delete session and kill screen when close button clicked', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('delete');

    try {
      serverFixture = await createServerFixture(PORT);
      cleanup = new CleanupTracker(serverFixture.baseUrl);
      cleanup.trackCase(caseName);

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);
      await createAndSelectCase(serverFixture.baseUrl, page, caseName);
      await clickElement(page, '.btn-claude');

      // Wait for session creation
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Get session ID
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      expect(data.sessions?.length).toBeGreaterThan(0);
      const session = data.sessions.find((s: any) => s.workingDir?.includes(caseName));
      expect(session).toBeDefined();
      const sessionId = session.id;

      // Verify screen exists before deletion
      // Screen name is claudeman-{sessionId.slice(0,8)}
      const screenName = `claudeman-${sessionId.slice(0, 8)}`;
      let screenExists = cleanup.screenExists(screenName);
      expect(screenExists).toBe(true);

      // Click the close button on the tab
      await clickElement(page, '.session-tab .tab-close');

      // Wait for tab to disappear
      await page.waitForSelector('.session-tab', { state: 'detached', timeout: 10000 });

      // Verify tab is gone
      const tabCount = await getElementCount(page, '.session-tab');
      expect(tabCount).toBe(0);

      // CRITICAL: Verify screen was killed
      // Give it a moment for screen cleanup
      await new Promise(r => setTimeout(r, 1000));
      screenExists = cleanup.screenExists(screenName);
      expect(screenExists).toBe(false);

      // Verify API returns no sessions with that ID
      const afterResponse = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const afterData = await afterResponse.json();
      const remainingSessions = afterData.sessions?.filter((s: any) => s.id === sessionId);
      expect(remainingSessions?.length || 0).toBe(0);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should handle deleting middle session of three', async () => {
    let browser: BrowserFixture | null = null;
    const caseNames = [
      generateCaseName('del-first'),
      generateCaseName('del-middle'),
      generateCaseName('del-last'),
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

      // Create cases first via API
      for (const caseName of caseNames) {
        const createRes = await fetch(`${serverFixture.baseUrl}/api/cases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName }),
        });
        expect(createRes.ok).toBe(true);
      }

      // Refresh to get all cases
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Create 3 sessions
      for (let i = 0; i < caseNames.length; i++) {
        await page.selectOption('#quickStartCase', caseNames[i]);
        await clickElement(page, '.btn-claude');
        await page.waitForSelector(`.session-tab:nth-child(${i + 1})`, {
          timeout: E2E_TIMEOUTS.SESSION_CREATE,
        });
        await new Promise(r => setTimeout(r, 1000)); // Wait between creations
      }

      // Verify 3 tabs exist
      let tabCount = await getElementCount(page, '.session-tab');
      expect(tabCount).toBe(3);

      // Get middle session ID
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      const sessions = data.sessions || [];
      sessions.forEach((s: any) => cleanup.trackSession(s.id));

      // Click middle tab to make it active
      await clickElement(page, '.session-tab:nth-child(2)');
      await new Promise(r => setTimeout(r, 500));

      // Delete middle session
      await clickElement(page, '.session-tab:nth-child(2) .tab-close');
      await new Promise(r => setTimeout(r, 1000));

      // Verify only 2 tabs remain
      tabCount = await getElementCount(page, '.session-tab');
      expect(tabCount).toBe(2);

      // Verify remaining tabs still work (click first)
      await clickElement(page, '.session-tab:nth-child(1)');
      await new Promise(r => setTimeout(r, 500));
      expect(await isVisible(page, '.session-tab.active')).toBe(true);

      // Verify terminal is visible for remaining session
      expect(await isVisible(page, '.xterm')).toBe(true);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST * 2); // Double timeout for 3 sessions

  it('should update tab counter after deletion', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = generateCaseName('counter-del');

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

      // Verify counter shows 1
      await new Promise(r => setTimeout(r, 500));
      let count = await page.$eval('#tabCount', el => el.textContent);
      expect(count).toBe('1');

      // Track for cleanup
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const data = await response.json();
      if (data.sessions?.length > 0) {
        cleanup.trackSession(data.sessions[data.sessions.length - 1].id);
      }

      // Delete session
      await clickElement(page, '.session-tab .tab-close');
      await page.waitForSelector('.session-tab', { state: 'detached', timeout: 10000 });

      // Verify counter shows 0
      await new Promise(r => setTimeout(r, 500));
      count = await page.$eval('#tabCount', el => el.textContent);
      expect(count).toBe('0');

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);
});
