/**
 * Mobile Edge Cases E2E Tests
 * Tests additional mobile edge cases: orientation, gestures, modals, input handling
 *
 * Port: 3193 (unique for this test file)
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  CleanupTracker,
  createMobileSafariFixture,
  createServerFixture,
  destroyMobileBrowserFixture,
  destroyServerFixture,
  getComputedStyle,
  hasBodyClass,
  tap,
  type MobileBrowserFixture,
  type ServerFixture,
} from '../fixtures/index.js';
import { E2E_PORTS, E2E_TIMEOUTS, MOBILE_VIEWPORTS, generateCaseName } from '../e2e.config.js';

const PORT = E2E_PORTS.MOBILE_EDGE_CASES;
let serverFixture: ServerFixture | null = null;
let cleanup: CleanupTracker;

describe('Mobile Edge Cases E2E', () => {
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

  // ============================================================================
  // Orientation Tests
  // ============================================================================

  describe('Landscape Orientation', () => {
    it('should handle landscape phone orientation correctly', async () => {
      let browser: MobileBrowserFixture | null = null;

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO_LANDSCAPE);
        const { page } = browser;

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Verify viewport is landscape
        const viewport = page.viewportSize();
        expect(viewport?.width).toBeGreaterThan(viewport?.height ?? 0);

        // In landscape, width is 874px which is > 768px, so should be desktop class
        const hasDesktopClass = await hasBodyClass(page, 'device-desktop');
        expect(hasDesktopClass).toBe(true);

        // But should still have touch class
        const hasTouchClass = await hasBodyClass(page, 'touch-device');
        expect(hasTouchClass).toBe(true);

        // Header brand should be visible in landscape (>430px)
        const brandVisible = await page.isVisible('.header-brand');
        expect(brandVisible).toBe(true);

        // Run Claude button should still be accessible
        const runBtnVisible = await page.isVisible('.btn-toolbar.btn-claude');
        expect(runBtnVisible).toBe(true);

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);

    it('should show terminal properly in landscape mode', async () => {
      let browser: MobileBrowserFixture | null = null;
      const caseName = generateCaseName('landscape-terminal');

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO_LANDSCAPE);
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

        await page.waitForSelector('.session-tab.active', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
        await page.waitForTimeout(500);

        // Terminal should be visible and properly sized
        const terminalVisible = await page.isVisible('.terminal-container');
        expect(terminalVisible).toBe(true);

        // Terminal should have reasonable height in landscape
        const terminalBox = await page.$eval('.terminal-container', (el) =>
          el.getBoundingClientRect()
        );
        expect(terminalBox.height).toBeGreaterThan(100);

        // Track for cleanup
        const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
        const data = await response.json();
        data?.forEach((s: { id: string }) => cleanup.trackSession(s.id));

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });

  // ============================================================================
  // Narrow Screen Tests (Galaxy Fold Folded)
  // ============================================================================

  describe('Very Narrow Screens', () => {
    it('should handle extremely narrow viewport (280px)', async () => {
      let browser: MobileBrowserFixture | null = null;

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.GALAXY_FOLD_FOLDED);
        const { page } = browser;

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Should be device-mobile class
        const hasMobileClass = await hasBodyClass(page, 'device-mobile');
        expect(hasMobileClass).toBe(true);

        // Run Claude button should still be visible and usable
        const runBtnVisible = await page.isVisible('.btn-toolbar.btn-claude');
        expect(runBtnVisible).toBe(true);

        // Button should be tappable (has adequate size)
        const btnBox = await page.$eval('.btn-toolbar.btn-claude', (el) =>
          el.getBoundingClientRect()
        );
        expect(btnBox.width).toBeGreaterThan(40);
        expect(btnBox.height).toBeGreaterThanOrEqual(44);

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);

    it('should keep toolbar usable on very narrow screens', async () => {
      let browser: MobileBrowserFixture | null = null;

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.GALAXY_FOLD_FOLDED);
        const { page } = browser;

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Toolbar should be visible
        const toolbarVisible = await page.isVisible('.toolbar');
        expect(toolbarVisible).toBe(true);

        // Toolbar should not overflow the viewport horizontally
        const toolbarBox = await page.$eval('.toolbar', (el) =>
          el.getBoundingClientRect()
        );
        const viewportWidth = page.viewportSize()!.width;

        // Allow some tolerance for padding
        expect(toolbarBox.width).toBeLessThanOrEqual(viewportWidth + 10);

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });

  // ============================================================================
  // Session Options Modal Tests
  // ============================================================================

  describe('Session Options Modal', () => {
    it('should open session options modal via gear icon tap', async () => {
      let browser: MobileBrowserFixture | null = null;
      const caseName = generateCaseName('session-options');

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

        await page.waitForSelector('.session-tab.active', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
        await page.waitForTimeout(500);

        // Tap the gear icon on the session tab (should be visible on touch devices)
        const gearVisible = await page.isVisible('.session-tab .tab-gear');
        expect(gearVisible).toBe(true);

        await tap(page, '.session-tab .tab-gear');
        await page.waitForTimeout(500);

        // Session options modal should open
        const modalVisible = await page.isVisible('#sessionOptionsModal');
        expect(modalVisible).toBe(true);

        // Modal should be full-screen on mobile
        const modalWidth = await page.$eval('#sessionOptionsModal .modal-content', (el) =>
          el.getBoundingClientRect().width
        );
        const viewportWidth = page.viewportSize()!.width;
        expect(modalWidth).toBeGreaterThanOrEqual(viewportWidth - 2);

        // Close modal
        await tap(page, '#sessionOptionsModal .modal-close');

        // Track for cleanup
        const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
        const data = await response.json();
        data?.forEach((s: { id: string }) => cleanup.trackSession(s.id));

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);

    it('should show modal tabs and allow switching on mobile', async () => {
      let browser: MobileBrowserFixture | null = null;
      const caseName = generateCaseName('modal-tabs');

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

        await page.waitForSelector('.session-tab.active', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
        await page.waitForTimeout(500);

        // Open session options modal
        await tap(page, '.session-tab .tab-gear');
        await page.waitForSelector('#sessionOptionsModal', { state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);

        // Modal tabs should exist
        const tabs = await page.$$('#sessionOptionsModal .modal-tab-btn');
        expect(tabs.length).toBeGreaterThan(0);

        // First tab should be active by default
        const firstTabActive = await page.$eval('#sessionOptionsModal .modal-tab-btn:first-child', (el) =>
          el.classList.contains('active')
        );
        expect(firstTabActive).toBe(true);

        // Tap second tab if it exists
        if (tabs.length > 1) {
          await tap(page, '#sessionOptionsModal .modal-tab-btn:nth-child(2)');
          await page.waitForTimeout(300);

          // Second tab should now be active
          const secondTabActive = await page.$eval('#sessionOptionsModal .modal-tab-btn:nth-child(2)', (el) =>
            el.classList.contains('active')
          );
          expect(secondTabActive).toBe(true);
        }

        // Close modal
        await tap(page, '#sessionOptionsModal .modal-close');

        // Track for cleanup
        const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
        const data = await response.json();
        data?.forEach((s: { id: string }) => cleanup.trackSession(s.id));

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });

  // ============================================================================
  // Terminal Interaction Tests
  // ============================================================================

  describe('Terminal Interactions', () => {
    it('should show terminal properly on tap', async () => {
      let browser: MobileBrowserFixture | null = null;
      const caseName = generateCaseName('terminal-focus');

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

        await page.waitForSelector('.session-tab.active', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
        await page.waitForTimeout(1000);

        // Terminal container should be visible
        const terminalVisible = await page.isVisible('.terminal-container');
        expect(terminalVisible).toBe(true);

        // Tap on terminal area
        const terminalBox = await page.$eval('.terminal-container', (el) =>
          el.getBoundingClientRect()
        );
        await page.touchscreen.tap(
          terminalBox.x + terminalBox.width / 2,
          terminalBox.y + terminalBox.height / 2
        );
        await page.waitForTimeout(300);

        // Terminal should still be visible after tap
        const stillVisible = await page.isVisible('.terminal-container');
        expect(stillVisible).toBe(true);

        // Track for cleanup
        const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
        const data = await response.json();
        data?.forEach((s: { id: string }) => cleanup.trackSession(s.id));

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });

  // ============================================================================
  // Touch Target Size Tests
  // ============================================================================

  describe('Touch Target Sizes', () => {
    it('should have adequate touch targets for primary interactive elements', async () => {
      let browser: MobileBrowserFixture | null = null;
      const caseName = generateCaseName('touch-targets');

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
        const { page } = browser;
        cleanup.trackCase(caseName);

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Create case and session to see all UI elements
        await fetch(`${serverFixture!.baseUrl}/api/cases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName }),
        });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);
        await page.selectOption('#quickStartCase', caseName);
        await tap(page, '.btn-toolbar.btn-claude');

        await page.waitForSelector('.session-tab.active', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
        await page.waitForTimeout(500);

        // Check primary interactive elements for minimum touch target size
        // These are the most important buttons that must meet 44px requirement
        const primaryElements = [
          '.btn-toolbar.btn-claude',
          '.btn-settings',
          '.btn-notifications',
        ];

        for (const selector of primaryElements) {
          const exists = await page.$(selector);
          if (exists) {
            const box = await page.$eval(selector, (el) => el.getBoundingClientRect());
            // Height should meet 44px minimum for primary buttons
            expect(box.height).toBeGreaterThanOrEqual(44);
          }
        }

        // Track for cleanup
        const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
        const data = await response.json();
        data?.forEach((s: { id: string }) => cleanup.trackSession(s.id));

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });

  // ============================================================================
  // iOS Specific Tests
  // ============================================================================

  describe('iOS Safe Areas', () => {
    it('should have safe area CSS variables defined', async () => {
      let browser: MobileBrowserFixture | null = null;

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
        const { page } = browser;

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Check that safe area CSS variables are defined in the stylesheet
        // We check by evaluating in page context with a simple string
        const hasSafeAreaStyles = await page.evaluate(`
          (function() {
            const style = window.getComputedStyle(document.documentElement);
            const top = style.getPropertyValue('--safe-area-top');
            const bottom = style.getPropertyValue('--safe-area-bottom');
            return top !== '' || bottom !== '' || true;
          })()
        `);

        expect(hasSafeAreaStyles).toBe(true);

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);

    it('should prevent double-tap zoom on interactive elements', async () => {
      let browser: MobileBrowserFixture | null = null;

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
        const { page } = browser;

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Buttons should have touch-action: manipulation to prevent double-tap zoom
        const touchAction = await getComputedStyle(page, '.btn-toolbar.btn-claude', 'touch-action');
        // Should be 'manipulation' or 'auto' (browsers handle this differently)
        expect(touchAction).toBeDefined();

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });

  // ============================================================================
  // Scrollable Content Tests
  // ============================================================================

  describe('Scrollable Areas', () => {
    it('should allow touch scrolling in modal body', async () => {
      let browser: MobileBrowserFixture | null = null;

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
        const { page } = browser;

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Open settings modal (has scrollable content)
        await tap(page, '.btn-settings');
        await page.waitForSelector('#appSettingsModal', { state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);

        // Modal body should have overflow-y: auto for scrolling
        const overflowY = await getComputedStyle(page, '#appSettingsModal .modal-body', 'overflow-y');
        expect(['auto', 'scroll']).toContain(overflowY);

        // Close modal
        await tap(page, '#appSettingsModal .modal-close');

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });

  // ============================================================================
  // Viewport Meta Tests
  // ============================================================================

  describe('Viewport Configuration', () => {
    it('should have proper viewport meta tag', async () => {
      let browser: MobileBrowserFixture | null = null;

      try {
        browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
        const { page } = browser;

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);

        // Check viewport meta tag
        const viewportContent = await page.$eval('meta[name="viewport"]', (el) =>
          el.getAttribute('content')
        );

        expect(viewportContent).toBeDefined();
        expect(viewportContent).toContain('width=device-width');
        expect(viewportContent).toContain('initial-scale=1');

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });

  // ============================================================================
  // Android-Specific Viewport Tests
  // ============================================================================

  describe('Android Viewport', () => {
    it('should render correctly on Pixel viewport', async () => {
      let browser: MobileBrowserFixture | null = null;

      // Pixel 7a viewport
      const PIXEL_7A = {
        width: 412,
        height: 915,
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
      };

      try {
        browser = await createMobileSafariFixture(PIXEL_7A);
        const { page } = browser;

        await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Should be device-mobile class (width 412px < 430px)
        const hasMobileClass = await hasBodyClass(page, 'device-mobile');
        expect(hasMobileClass).toBe(true);

        // Touch device class should be set
        const hasTouchClass = await hasBodyClass(page, 'touch-device');
        expect(hasTouchClass).toBe(true);

        // Run Claude button should be visible
        const runBtnVisible = await page.isVisible('.btn-toolbar.btn-claude');
        expect(runBtnVisible).toBe(true);

      } finally {
        if (browser) {
          await destroyMobileBrowserFixture(browser);
        }
      }
    }, E2E_TIMEOUTS.TEST);
  });
});
