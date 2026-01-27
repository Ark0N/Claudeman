/**
 * Browser fixture for E2E tests
 * Manages Playwright browser lifecycle with required args for headless Chrome
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';

export interface BrowserFixture {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Create and launch a browser fixture
 * Uses required args for headless Chrome in CI/Linux environments
 * @returns BrowserFixture with browser, context, and page
 */
export async function createBrowserFixture(): Promise<BrowserFixture> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
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
 * Close and cleanup a browser fixture
 * @param fixture - Browser fixture to destroy
 */
export async function destroyBrowserFixture(fixture: BrowserFixture): Promise<void> {
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
 * Navigate to a URL and wait for load
 * Note: Uses 'domcontentloaded' because SSE streams prevent 'networkidle'
 * @param page - Playwright page
 * @param url - URL to navigate to
 */
export async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Wait a bit for JS to initialize
  await page.waitForTimeout(500);
}

/**
 * Wait for an element to be visible
 * @param page - Playwright page
 * @param selector - CSS selector
 * @param timeout - Timeout in ms (default 15000)
 */
export async function waitForVisible(page: Page, selector: string, timeout = 15000): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout });
}

/**
 * Click an element with retry logic
 * @param page - Playwright page
 * @param selector - CSS selector
 */
export async function clickElement(page: Page, selector: string): Promise<void> {
  await page.click(selector);
}

/**
 * Type text into an input element
 * @param page - Playwright page
 * @param selector - CSS selector
 * @param text - Text to type
 */
export async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  await page.fill(selector, text);
}

/**
 * Get text content of an element
 * @param page - Playwright page
 * @param selector - CSS selector
 * @returns Text content or empty string
 */
export async function getText(page: Page, selector: string): Promise<string> {
  try {
    const element = await page.$(selector);
    if (element) {
      return (await element.textContent()) || '';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Check if an element is visible
 * @param page - Playwright page
 * @param selector - CSS selector
 * @returns true if visible, false otherwise
 */
export async function isVisible(page: Page, selector: string): Promise<boolean> {
  try {
    const element = await page.$(selector);
    if (element) {
      return await element.isVisible();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get count of elements matching selector
 * @param page - Playwright page
 * @param selector - CSS selector
 * @returns Number of matching elements
 */
export async function getElementCount(page: Page, selector: string): Promise<number> {
  return await page.locator(selector).count();
}
