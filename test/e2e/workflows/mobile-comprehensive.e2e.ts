/**
 * Comprehensive Mobile E2E Tests
 * Tests mobile-specific UI features, interactions, and usability
 *
 * Port: 3192 (unique for this test file)
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
  getComputedStyle,
  CleanupTracker,
  type ServerFixture,
  type MobileBrowserFixture,
} from '../fixtures/index.js';
import { E2E_TIMEOUTS, MOBILE_VIEWPORTS, generateCaseName } from '../e2e.config.js';

const PORT = 3192;
let serverFixture: ServerFixture | null = null;
let cleanup: CleanupTracker;

describe('Mobile Comprehensive E2E', () => {
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
  // Welcome Overlay Tests
  // ============================================================================

  it('should show welcome overlay with touch-friendly buttons on mobile', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Welcome overlay should be visible
      const overlayVisible = await page.isVisible('.welcome-overlay');
      expect(overlayVisible).toBe(true);

      // Welcome buttons should have touch-friendly size
      const runClaudeBtn = await page.$('.welcome-btn-primary');
      expect(runClaudeBtn).not.toBeNull();

      const box = await runClaudeBtn!.boundingBox();
      expect(box).not.toBeNull();
      // Touch target should be at least 44px tall
      expect(box!.height).toBeGreaterThanOrEqual(44);

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  // ============================================================================
  // Toolbar Tests
  // ============================================================================

  it('should show Run Claude button prominently on mobile toolbar', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Run Claude button should be visible
      const runBtnVisible = await page.isVisible('.btn-toolbar.btn-claude');
      expect(runBtnVisible).toBe(true);

      // Button should have flex: 1 on mobile (takes up space)
      const flexValue = await getComputedStyle(page, '.btn-toolbar.btn-claude', 'flex');
      // flex: 1 computes to "1 1 0%" or similar
      expect(flexValue).toContain('1');

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should show case dropdown on mobile toolbar', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Case dropdown should be visible
      const dropdownVisible = await page.isVisible('#quickStartCase');
      expect(dropdownVisible).toBe(true);

      // Should be able to interact with it
      const options = await page.$$eval('#quickStartCase option', (opts) =>
        opts.map((o) => (o as HTMLOptionElement).value)
      );
      expect(options.length).toBeGreaterThan(0);

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should hide version display on mobile', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Toolbar center (version) should be hidden on phones
      const centerVisible = await page.isVisible('.toolbar-center');
      expect(centerVisible).toBe(false);

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  // ============================================================================
  // Session Tab Tests
  // ============================================================================

  it('should allow horizontal scrolling of session tabs on mobile', async () => {
    let browser: MobileBrowserFixture | null = null;
    const caseName = generateCaseName('mobile-scroll');

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;
      cleanup.trackCase(caseName);

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Create case
      await fetch(`${serverFixture!.baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      await page.selectOption('#quickStartCase', caseName);

      // Create multiple sessions to enable scrolling
      for (let i = 0; i < 3; i++) {
        await tap(page, '.btn-toolbar.btn-claude');
        await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
        await page.waitForTimeout(500);
      }

      // Check that session tabs container allows horizontal scroll
      const overflowX = await getComputedStyle(page, '.session-tabs', 'overflow-x');
      expect(overflowX).toBe('auto');

      // Check scrollbar is hidden (webkit)
      const scrollbarWidth = await page.$eval('.session-tabs', (el) => {
        const style = window.getComputedStyle(el, '::-webkit-scrollbar');
        return style.display;
      });
      // Should be 'none' due to scrollbar-width: none

      // Track sessions for cleanup
      const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
      const data = await response.json();
      data?.forEach((s: { id: string }) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should switch between session tabs on tap', async () => {
    let browser: MobileBrowserFixture | null = null;
    const caseName = generateCaseName('mobile-switch');

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;
      cleanup.trackCase(caseName);

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Create case
      await fetch(`${serverFixture!.baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      await page.selectOption('#quickStartCase', caseName);

      // Create 2 sessions
      await tap(page, '.btn-toolbar.btn-claude');
      await page.waitForSelector('.session-tab.active', { timeout: E2E_TIMEOUTS.SESSION_CREATE });
      await page.waitForTimeout(500);

      await tap(page, '.btn-toolbar.btn-claude');
      await page.waitForTimeout(1000);

      // Get the tabs - should have at least 2
      const tabs = await page.$$('.session-tab');
      expect(tabs.length).toBeGreaterThanOrEqual(2);

      // Tap the first tab
      await tap(page, '.session-tab:first-child');
      await page.waitForTimeout(300);

      // First tab should now be active
      const firstTabActive = await page.$eval('.session-tab:first-child', (el) =>
        el.classList.contains('active')
      );
      expect(firstTabActive).toBe(true);

      // Track sessions for cleanup
      const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
      const data = await response.json();
      data?.forEach((s: { id: string }) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  // ============================================================================
  // Modal Tests
  // ============================================================================

  it('should show full-screen modals on mobile', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Open app settings modal
      await tap(page, '.btn-settings');
      await page.waitForSelector('#appSettingsModal.open, #appSettingsModal:not(.hidden)', { timeout: 5000 });
      await page.waitForTimeout(300);

      // Modal content should be full-width on mobile
      const modalWidth = await page.$eval('#appSettingsModal .modal-content', (el) =>
        el.getBoundingClientRect().width
      );
      const viewportWidth = page.viewportSize()!.width;

      // Modal should be full width (or very close to it)
      expect(modalWidth).toBeGreaterThanOrEqual(viewportWidth - 2);

      // Close modal
      await tap(page, '#appSettingsModal .modal-close');

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should show create case modal on mobile', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Tap the + button to create case
      await tap(page, '.btn-case-add');
      await page.waitForSelector('#createCaseModal', { state: 'visible', timeout: 5000 });

      // Modal should be visible
      const modalVisible = await page.isVisible('#createCaseModal');
      expect(modalVisible).toBe(true);

      // Input should be focusable
      const nameInput = await page.$('#newCaseName');
      expect(nameInput).not.toBeNull();

      // Close modal
      await tap(page, '#createCaseModal .modal-close');

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  // ============================================================================
  // Header Tests
  // ============================================================================

  it('should show notification button on mobile', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Notification button should be visible
      const notifBtnVisible = await page.isVisible('.btn-notifications');
      expect(notifBtnVisible).toBe(true);

      // Should be tappable
      await tap(page, '.btn-notifications');
      await page.waitForTimeout(300);

      // Notification drawer should open
      const drawerVisible = await page.isVisible('#notifDrawer');
      expect(drawerVisible).toBe(true);

      // Close drawer
      await tap(page, '.btn-notifications');

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should show settings button on mobile', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Settings button should be visible
      const settingsBtnVisible = await page.isVisible('.btn-settings');
      expect(settingsBtnVisible).toBe(true);

      // Button should have adequate touch target
      const minHeight = await getMinHeight(page, '.btn-settings');
      expect(minHeight).toBeGreaterThanOrEqual(44);

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  // ============================================================================
  // Close Session Tests
  // ============================================================================

  it('should show close confirmation modal on tap', async () => {
    let browser: MobileBrowserFixture | null = null;
    const caseName = generateCaseName('mobile-close');

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

      // Tap the close button on the tab
      await tap(page, '.session-tab .tab-close');
      await page.waitForTimeout(300);

      // Close confirmation modal should appear
      const modalVisible = await page.isVisible('#closeConfirmModal');
      expect(modalVisible).toBe(true);

      // Cancel to keep session
      await tap(page, '#closeConfirmModal .modal-footer-cancel button');

      // Track session for cleanup
      const response = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
      const data = await response.json();
      data?.forEach((s: { id: string }) => cleanup.trackSession(s.id));

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  // ============================================================================
  // Token Display Tests
  // ============================================================================

  it('should show token count on mobile header', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Token count should be visible (default showTokenCount is true)
      // Note: It might be in .header-tokens
      const tokenDisplayExists = await page.$('.header-tokens');
      expect(tokenDisplayExists).not.toBeNull();

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  // ============================================================================
  // Ralph Wizard Tests
  // ============================================================================

  it('should show Ralph wizard full-screen on mobile', async () => {
    let browser: MobileBrowserFixture | null = null;

    try {
      browser = await createMobileSafariFixture(MOBILE_VIEWPORTS.IPHONE_17_PRO);
      const { page } = browser;

      // Clean up any existing sessions first (from previous tests)
      const sessionsRes = await fetch(`${serverFixture!.baseUrl}/api/sessions`);
      const existingSessions = await sessionsRes.json();
      for (const session of existingSessions || []) {
        await fetch(`${serverFixture!.baseUrl}/api/sessions/${session.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ killScreen: true }),
        });
      }

      await page.goto(`${serverFixture!.baseUrl}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Wait for welcome overlay to be visible (no active sessions)
      await page.waitForSelector('.welcome-overlay.visible', { timeout: 5000 });

      // Tap the Ralph wizard button in welcome overlay
      await tap(page, '.welcome-btn-ralph');
      await page.waitForSelector('#ralphWizardModal', { state: 'visible', timeout: 5000 });

      // Modal should be visible
      const modalVisible = await page.isVisible('#ralphWizardModal');
      expect(modalVisible).toBe(true);

      // Modal should be full-screen on mobile
      const modalWidth = await page.$eval('#ralphWizardModal .modal-content', (el) =>
        el.getBoundingClientRect().width
      );
      const viewportWidth = page.viewportSize()!.width;
      expect(modalWidth).toBeGreaterThanOrEqual(viewportWidth - 2);

      // Close wizard
      await tap(page, '#ralphWizardModal .modal-close');

    } finally {
      if (browser) {
        await destroyMobileBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);
});
