/**
 * Mobile browser fixture for E2E tests
 * Manages Playwright browser lifecycle with mobile viewport emulation
 * Uses Chromium with mobile emulation (WebKit requires system dependencies)
 */

import { chromium, webkit, Browser, BrowserContext, Page } from 'playwright';
import { MOBILE_VIEWPORTS } from '../e2e.config.js';

export interface MobileBrowserFixture {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface MobileViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

/**
 * Create and launch a mobile browser fixture using Chromium with mobile emulation
 * Falls back from WebKit to Chromium since WebKit requires system dependencies
 * Defaults to iPhone 17 Pro viewport
 * @param viewport - Optional viewport configuration (defaults to iPhone 17 Pro)
 * @returns MobileBrowserFixture with browser, context, and page
 */
export async function createMobileSafariFixture(
  viewport: MobileViewport = MOBILE_VIEWPORTS.IPHONE_17_PRO
): Promise<MobileBrowserFixture> {
  // Try WebKit first, fall back to Chromium if WebKit dependencies missing
  let browser: Browser;
  let userAgent: string;

  try {
    browser = await webkit.launch({ headless: true });
    userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  } catch {
    // WebKit failed (missing dependencies), use Chromium with mobile emulation
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  }

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    ignoreHTTPSErrors: true,
    userAgent,
  });

  const page = await context.newPage();

  // Set default timeout for all operations
  page.setDefaultTimeout(15000);

  return {
    browser,
    context,
    page,
  };
}

/**
 * Close and cleanup a mobile browser fixture
 * @param fixture - Mobile browser fixture to destroy
 */
export async function destroyMobileBrowserFixture(fixture: MobileBrowserFixture): Promise<void> {
  if (fixture.page) {
    await fixture.page.close().catch(() => {});
  }
  if (fixture.context) {
    await fixture.context.close().catch(() => {});
  }
  if (fixture.browser) {
    await fixture.browser.close().catch(() => {});
  }
}

/**
 * Simulate a tap gesture (touch start + touch end)
 * @param page - Playwright page
 * @param selector - CSS selector or x,y coordinates
 */
export async function tap(page: Page, selectorOrCoords: string | { x: number; y: number }): Promise<void> {
  if (typeof selectorOrCoords === 'string') {
    await page.tap(selectorOrCoords);
  } else {
    await page.touchscreen.tap(selectorOrCoords.x, selectorOrCoords.y);
  }
}

/**
 * Simulate a swipe gesture
 * @param page - Playwright page
 * @param startX - Starting X coordinate
 * @param startY - Starting Y coordinate
 * @param endX - Ending X coordinate
 * @param endY - Ending Y coordinate
 * @param duration - Duration in ms (default 100ms for fast swipe)
 */
export async function swipe(
  page: Page,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  duration = 100
): Promise<void> {
  // Calculate steps based on duration (roughly 16ms per step for 60fps)
  const steps = Math.max(Math.floor(duration / 16), 2);

  // Start touch
  await page.touchscreen.tap(startX, startY);

  // Move through intermediate points
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    const x = startX + (endX - startX) * ratio;
    const y = startY + (endY - startY) * ratio;
    await page.touchscreen.tap(x, y);
  }
}

/**
 * Simulate a horizontal swipe (for tab switching)
 * @param page - Playwright page
 * @param direction - 'left' or 'right'
 * @param distance - Swipe distance in pixels (default 100)
 */
export async function swipeHorizontal(
  page: Page,
  direction: 'left' | 'right',
  distance = 100
): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return;

  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;

  if (direction === 'left') {
    await swipe(page, centerX + distance / 2, centerY, centerX - distance / 2, centerY);
  } else {
    await swipe(page, centerX - distance / 2, centerY, centerX + distance / 2, centerY);
  }
}

/**
 * Simulate a long press gesture
 * @param page - Playwright page
 * @param selector - CSS selector
 * @param duration - Hold duration in ms (default 500ms)
 */
export async function longPress(page: Page, selector: string, duration = 500): Promise<void> {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);

  const box = await element.boundingBox();
  if (!box) throw new Error(`Element has no bounding box: ${selector}`);

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Simulate long press with mouse (touch events are more complex)
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(duration);
  await page.mouse.up();
}

/**
 * Get computed style property for an element
 * @param page - Playwright page
 * @param selector - CSS selector
 * @param property - CSS property name
 * @returns The computed style value
 */
export async function getComputedStyle(
  page: Page,
  selector: string,
  property: string
): Promise<string> {
  return await page.$eval(
    selector,
    (el, prop) => window.getComputedStyle(el).getPropertyValue(prop),
    property
  );
}

/**
 * Check if body has a specific class
 * @param page - Playwright page
 * @param className - Class name to check
 * @returns true if class exists
 */
export async function hasBodyClass(page: Page, className: string): Promise<boolean> {
  return await page.evaluate((cls) => document.body.classList.contains(cls), className);
}

/**
 * Get the minimum height of an element
 * @param page - Playwright page
 * @param selector - CSS selector
 * @returns Minimum height in pixels
 */
export async function getMinHeight(page: Page, selector: string): Promise<number> {
  const minHeightStr = await getComputedStyle(page, selector, 'min-height');
  return parseInt(minHeightStr) || 0;
}
