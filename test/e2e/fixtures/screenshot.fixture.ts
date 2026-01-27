/**
 * Screenshot fixture for E2E tests
 * Captures screenshots and compares against baselines for visual regression testing
 */

import { Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, '..', 'screenshots');
const BASELINES_DIR = join(SCREENSHOTS_DIR, 'baselines');
const CURRENT_DIR = join(SCREENSHOTS_DIR, 'current');
const DIFFS_DIR = join(SCREENSHOTS_DIR, 'diffs');

// Default threshold - percentage of pixels allowed to differ (0-1)
const DEFAULT_THRESHOLD = 0.05; // 5%

export interface ScreenshotOptions {
  /** Threshold for pixel difference (0-1), default 0.05 */
  threshold?: number;
  /** Mask selectors to exclude from comparison */
  mask?: string[];
  /** Full page screenshot vs viewport only */
  fullPage?: boolean;
}

export interface ScreenshotResult {
  /** Whether comparison passed */
  passed: boolean;
  /** Path to baseline image */
  baselinePath: string;
  /** Path to current image */
  currentPath: string;
  /** Path to diff image (only if comparison failed) */
  diffPath?: string;
  /** Number of different pixels */
  diffPixels?: number;
  /** Percentage of different pixels */
  diffPercent?: number;
  /** Whether this is a new baseline (no previous baseline existed) */
  newBaseline: boolean;
}

/**
 * Ensure screenshot directories exist
 */
function ensureDirectories(): void {
  for (const dir of [SCREENSHOTS_DIR, BASELINES_DIR, CURRENT_DIR, DIFFS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Capture a screenshot and compare against baseline
 * @param page - Playwright page
 * @param name - Screenshot name (without extension)
 * @param options - Screenshot options
 * @returns ScreenshotResult with comparison details
 */
export async function captureAndCompare(
  page: Page,
  name: string,
  options: ScreenshotOptions = {}
): Promise<ScreenshotResult> {
  ensureDirectories();

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const baselinePath = join(BASELINES_DIR, `${name}.png`);
  const currentPath = join(CURRENT_DIR, `${name}.png`);
  const diffPath = join(DIFFS_DIR, `${name}.png`);

  // Mask elements if specified (hide dynamic content)
  if (options.mask && options.mask.length > 0) {
    for (const selector of options.mask) {
      await page.evaluate((sel) => {
        const elements = document.querySelectorAll(sel);
        elements.forEach(el => {
          (el as HTMLElement).style.visibility = 'hidden';
        });
      }, selector);
    }
  }

  // Capture current screenshot
  const screenshotBuffer = await page.screenshot({
    path: currentPath,
    fullPage: options.fullPage ?? false,
  });

  // Restore masked elements
  if (options.mask && options.mask.length > 0) {
    for (const selector of options.mask) {
      await page.evaluate((sel) => {
        const elements = document.querySelectorAll(sel);
        elements.forEach(el => {
          (el as HTMLElement).style.visibility = 'visible';
        });
      }, selector);
    }
  }

  // If no baseline exists, create one
  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, screenshotBuffer);
    return {
      passed: true,
      baselinePath,
      currentPath,
      newBaseline: true,
    };
  }

  // Load baseline and current images
  const baselineBuffer = readFileSync(baselinePath);
  const baselineImg = PNG.sync.read(baselineBuffer);
  const currentImg = PNG.sync.read(screenshotBuffer);

  // Check dimensions match
  if (baselineImg.width !== currentImg.width || baselineImg.height !== currentImg.height) {
    // Dimensions changed - save diff and fail
    return {
      passed: false,
      baselinePath,
      currentPath,
      diffPath,
      diffPixels: baselineImg.width * baselineImg.height,
      diffPercent: 1,
      newBaseline: false,
    };
  }

  // Compare images
  const { width, height } = baselineImg;
  const diffImg = new PNG({ width, height });
  const diffPixels = pixelmatch(
    baselineImg.data,
    currentImg.data,
    diffImg.data,
    width,
    height,
    { threshold: 0.1 } // pixelmatch threshold (per-pixel sensitivity)
  );

  const totalPixels = width * height;
  const diffPercent = diffPixels / totalPixels;
  const passed = diffPercent <= threshold;

  // Save diff image if comparison failed
  if (!passed) {
    writeFileSync(diffPath, PNG.sync.write(diffImg));
  }

  return {
    passed,
    baselinePath,
    currentPath,
    diffPath: passed ? undefined : diffPath,
    diffPixels,
    diffPercent,
    newBaseline: false,
  };
}

/**
 * Capture a screenshot without comparison (for debugging)
 * @param page - Playwright page
 * @param name - Screenshot name
 */
export async function captureScreenshot(page: Page, name: string): Promise<string> {
  ensureDirectories();
  const path = join(CURRENT_DIR, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

/**
 * Update baseline with current screenshot
 * @param name - Screenshot name
 */
export function updateBaseline(name: string): boolean {
  const currentPath = join(CURRENT_DIR, `${name}.png`);
  const baselinePath = join(BASELINES_DIR, `${name}.png`);

  if (!existsSync(currentPath)) {
    return false;
  }

  const currentBuffer = readFileSync(currentPath);
  writeFileSync(baselinePath, currentBuffer);
  return true;
}
