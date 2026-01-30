/**
 * Mobile Safari E2E Tests
 * Tests mobile-specific UI adaptations on iPhone 17 Pro Safari (402x874, 3x DPR)
 *
 * Port: 3191 (see CLAUDE.md test port table)
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  createServerFixture,
  destroyServerFixture,
  createMobileSafariFixture,
  destroyMobileBrowserFixture,
  hasBodyClass,
  getMinHeight,
  tap,
  CleanupTracker,
  type ServerFixture,
  type MobileBrowserFixture,
} from '../fixtures/index.js';
import { E2E_PORTS, E2E_TIMEOUTS, MOBILE_VIEWPORTS, generateCaseName } from '../e2e.config.js';

const PORT = E2E_PORTS.MOBILE_SAFARI;
let serverFixture: ServerFixture | null = null;
let cleanup: CleanupTracker;

describe('Mobile Safari E2E', () => {
  beforeAll(async () => {
    serverFixture = await createServerFixture(PORT);
    cleanup = new CleanupTracker(serverFixture.baseUrl);
  }, E2E_TIMEOUTS.BROWSER_SETUP);

  afterAll(async () => {
    if (cleanup) {
      await cleanup.forceCleanupAll();
    }
    if (serverFixture) {
      await destroyServerFixture(serverFixture);
    }
  }, E2E_TIMEOUTS.TEST);

  it('should render touch-friendly UI on mobile viewport', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      // Launch WebKit with iPhone 17 Pro viewport
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      // Navigate to Claudeman
      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000); // Wait for JS initialization and MobileDetection

      // Verify page loaded
      const title = await page.title();
      expect(title).toBe('Claudeman');

      // Check body has touch-device class
      const hasTouchClass = await hasBodyClass(page, 'touch-device');
      expect(hasTouchClass).toBe(true);

      // Check body has device-mobile class (width < 430px)
      const hasMobileClass = await hasBodyClass(page, 'device-mobile');
      expect(hasMobileClass).toBe(true);

      // Verify viewport size is correct
      const viewport = page.viewportSize();
      expect(viewport?.width).toBe(402);
      expect(viewport?.height).toBe(874);

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should have 44px minimum touch targets on buttons', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Check button min-height is at least 44px (touch target minimum)
      // The .btn-toolbar.btn-claude is the main Run Claude button
      const claudeButtonMinHeight = await getMinHeight(page, '.btn-toolbar.btn-claude');
      expect(claudeButtonMinHeight).toBeGreaterThanOrEqual(44);

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should handle tap gestures for session creation', async () => {
    let browser: MobileBrowserFixture | null = null;
    const caseName = generateCaseName('mobile-tap');

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;
      cleanup.trackCase(caseName);

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Create case via API
      const createRes = await fetch(`${serverFixture!.baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });
      expect(createRes.ok).toBe(true);

      // Refresh to get case list
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Select case
      await page.selectOption('#quickStartCase', caseName);

      // Use tap instead of click for the Claude button
      await tap(page, '.btn-toolbar.btn-claude');

      // Wait for session tab to appear
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Verify tab is visible
      const tabVisible = await page.isVisible('.session-tab.active');
      expect(tabVisible).toBe(true);

      // Track session for cleanup
      const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
      const data = await response.json();
      const session = data?.find((s: any) => s.workingDir?.includes(caseName));
      if (session) {
        cleanup.trackSession(session.id);
      }

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should show always-visible close buttons on session tabs', async () => {
    let browser: MobileBrowserFixture | null = null;
    const caseName = generateCaseName('mobile-close-btn');

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;
      cleanup.trackCase(caseName);

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Create case and session
      await fetch(`${serverFixture!.baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      await page.selectOption('#quickStartCase', caseName);
      await tap(page, '.btn-toolbar.btn-claude');

      // Wait for session tab
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // On touch devices, close button should always be visible (opacity: 1)
      // Check that the close button exists and is visible
      const closeButtonVisible = await page.isVisible('.session-tab .tab-close');
      expect(closeButtonVisible).toBe(true);

      // Verify opacity is 1 (always visible, not hover-dependent)
      const opacity = await page.$eval('.session-tab .tab-close', (el) =>
        window.getComputedStyle(el).opacity
      );
      expect(parseFloat(opacity)).toBe(1);

      // Track for cleanup
      const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
      const data = await response.json();
      if (data?.length > 0) {
        cleanup.trackSession(data[data.length - 1].id);
      }

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should hide header brand and stats on small screens', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Header brand should be hidden on phones (<430px)
      const brandVisible = await page.isVisible('.header-brand');
      expect(brandVisible).toBe(false);

      // System stats should be hidden on phones
      const statsVisible = await page.isVisible('.header-system-stats');
      expect(statsVisible).toBe(false);

      // Font controls should be hidden on phones
      const fontControlsVisible = await page.isVisible('.header-font-controls');
      expect(fontControlsVisible).toBe(false);

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should render properly on tablet viewport', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      // Use iPad Pro 11" viewport (tablet size)
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPAD_PRO_11);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Check body has tablet class (width 430-768px... wait, iPad is 834px wide, so it's desktop)
      // Actually iPad Pro 11" at 834px is > 768px so it would be device-desktop
      // Let's check what class it gets
      const hasDesktopClass = await hasBodyClass(page, 'device-desktop');
      expect(hasDesktopClass).toBe(true);

      // But it should still have touch-device class
      const hasTouchClass = await hasBodyClass(page, 'touch-device');
      expect(hasTouchClass).toBe(true);

      // Verify viewport
      const viewport = page.viewportSize();
      expect(viewport?.width).toBe(834);
      expect(viewport?.height).toBe(1194);

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);
});
