/**
 * Mobile settings test - verifies:
 * 1. Mobile uses separate storage key
 * 2. Mobile defaults are applied correctly
 * 3. Notifications are disabled by default on mobile
 */
import { chromium } from 'playwright';

const MOBILE_VIEWPORT = {
  width: 402,
  height: 874,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const DESKTOP_VIEWPORT = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
};

async function testMobileSettings() {
  console.log('=== Mobile Settings Test ===\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    // Test 1: Mobile device
    console.log('1. Testing MOBILE view...');
    const mobileContext = await browser.newContext({
      viewport: { width: MOBILE_VIEWPORT.width, height: MOBILE_VIEWPORT.height },
      deviceScaleFactor: MOBILE_VIEWPORT.deviceScaleFactor,
      isMobile: MOBILE_VIEWPORT.isMobile,
      hasTouch: MOBILE_VIEWPORT.hasTouch,
    });
    const mobilePage = await mobileContext.newPage();
    mobilePage.setDefaultTimeout(15000);

    await mobilePage.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
    // Clear localStorage to test fresh defaults
    await mobilePage.evaluate(() => localStorage.clear());
    // Reload to apply fresh defaults
    await mobilePage.reload({ waitUntil: 'domcontentloaded' });
    await mobilePage.waitForSelector('.toolbar', { timeout: 10000 });
    await mobilePage.waitForTimeout(500);

    // Check device type detection
    const mobileDeviceType = await mobilePage.evaluate(() => {
      // @ts-ignore
      return window.MobileDetection?.getDeviceType() || 'unknown';
    });
    console.log(`   Device type detected: ${mobileDeviceType}`);

    // Check storage key used
    const mobileStorageKeys = await mobilePage.evaluate(() => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes('claudeman')) {
          keys.push(key);
        }
      }
      return keys;
    });
    console.log(`   LocalStorage keys: ${mobileStorageKeys.join(', ') || 'none'}`);

    // Check default settings (before server merge)
    const mobileDefaults = await mobilePage.evaluate(() => {
      // @ts-ignore
      return window.app?.getDefaultSettings() || {};
    });
    console.log(`   Default settings (mobile-specific):`);
    console.log(`     showSystemStats: ${mobileDefaults.showSystemStats}`);
    console.log(`     showMonitor: ${mobileDefaults.showMonitor}`);
    console.log(`     subagentTrackingEnabled: ${mobileDefaults.subagentTrackingEnabled}`);

    // Check loaded settings (after server merge)
    const mobileSettings = await mobilePage.evaluate(() => {
      // @ts-ignore
      return window.app?.loadAppSettingsFromStorage() || {};
    });
    console.log(`   Settings loaded (after server merge):`);
    console.log(`     showSystemStats: ${mobileSettings.showSystemStats}`);
    console.log(`     showMonitor: ${mobileSettings.showMonitor}`);
    console.log(`     subagentTrackingEnabled: ${mobileSettings.subagentTrackingEnabled}`);

    // Check notification settings
    const mobileNotifPrefs = await mobilePage.evaluate(() => {
      // @ts-ignore
      return window.app?.notificationManager?.preferences || {};
    });
    console.log(`   Notification prefs:`);
    console.log(`     enabled: ${mobileNotifPrefs.enabled}`);
    console.log(`     browserNotifications: ${mobileNotifPrefs.browserNotifications}`);

    // Check header visibility
    const headerStatsVisible = await mobilePage.evaluate(() => {
      const el = document.getElementById('headerSystemStats');
      return el ? window.getComputedStyle(el).display !== 'none' : 'not found';
    });
    console.log(`   Header system stats visible: ${headerStatsVisible}`);

    // Check active tab is first
    const tabs = await mobilePage.$$('.session-tab');
    const firstTabActive = tabs.length > 0 ? await tabs[0].evaluate(el => el.classList.contains('active')) : 'no tabs';
    console.log(`   Active tab first: ${firstTabActive} (${tabs.length} tabs)`);

    // Take screenshot
    await mobilePage.screenshot({ path: 'test/mobile-settings-test.png' });
    console.log('   Screenshot: test/mobile-settings-test.png\n');

    await mobileContext.close();

    // Test 2: Desktop device for comparison
    console.log('2. Testing DESKTOP view...');
    const desktopContext = await browser.newContext({
      viewport: { width: DESKTOP_VIEWPORT.width, height: DESKTOP_VIEWPORT.height },
      deviceScaleFactor: DESKTOP_VIEWPORT.deviceScaleFactor,
      isMobile: DESKTOP_VIEWPORT.isMobile,
      hasTouch: DESKTOP_VIEWPORT.hasTouch,
    });
    const desktopPage = await desktopContext.newPage();
    desktopPage.setDefaultTimeout(15000);

    await desktopPage.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
    // Clear localStorage to test fresh defaults
    await desktopPage.evaluate(() => localStorage.clear());
    // Reload to apply fresh defaults
    await desktopPage.reload({ waitUntil: 'domcontentloaded' });
    await desktopPage.waitForSelector('.toolbar', { timeout: 10000 });
    await desktopPage.waitForTimeout(500);

    const desktopDeviceType = await desktopPage.evaluate(() => {
      // @ts-ignore
      return window.MobileDetection?.getDeviceType() || 'unknown';
    });
    console.log(`   Device type detected: ${desktopDeviceType}`);

    // Check default settings
    const desktopDefaults = await desktopPage.evaluate(() => {
      // @ts-ignore
      return window.app?.getDefaultSettings() || {};
    });
    console.log(`   Default settings (desktop = empty, uses ?? fallbacks):`);
    console.log(`     isEmpty: ${Object.keys(desktopDefaults).length === 0}`);

    // Check loaded settings (after server merge)
    const desktopSettings = await desktopPage.evaluate(() => {
      // @ts-ignore
      return window.app?.loadAppSettingsFromStorage() || {};
    });
    console.log(`   Settings loaded (after server merge):`);
    console.log(`     showSystemStats: ${desktopSettings.showSystemStats ?? 'undefined (default: true)'}`);
    console.log(`     showMonitor: ${desktopSettings.showMonitor ?? 'undefined (default: true)'}`);

    const desktopNotifPrefs = await desktopPage.evaluate(() => {
      // @ts-ignore
      return window.app?.notificationManager?.preferences || {};
    });
    console.log(`   Notification prefs:`);
    console.log(`     enabled: ${desktopNotifPrefs.enabled}`);
    console.log(`     browserNotifications: ${desktopNotifPrefs.browserNotifications}`);

    await desktopPage.screenshot({ path: 'test/desktop-settings-test.png' });
    console.log('   Screenshot: test/desktop-settings-test.png\n');

    await desktopContext.close();

    console.log('=== Test Complete ===');

  } finally {
    await browser.close();
  }
}

testMobileSettings().catch(console.error);
