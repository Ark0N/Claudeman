/**
 * screenshot-capture.test.ts
 *
 * Verification test for the README screenshot capture script.
 * Runs the capture script and verifies output files exist with valid dimensions.
 *
 * Port: 3199 (shared with capture script — not run simultaneously)
 *
 * Usage: RUN_SCREENSHOT_TESTS=1 npx vitest run test/screenshot-capture.test.ts
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

const PROJECT_ROOT = join(__dirname, '..');

const EXPECTED_SCREENSHOTS = [
  { path: 'docs/images/claude-overview.png', minSize: 10_000 },
  { path: 'docs/images/subagent-spawn.png', minSize: 10_000 },
  { path: 'docs/images/ralph-tracker-8tasks-44percent.png', minSize: 10_000 },
  { path: 'docs/screenshots/multi-session-dashboard.png', minSize: 10_000 },
  { path: 'docs/screenshots/multi-session-monitor.png', minSize: 10_000 },
];

const EXPECTED_WIDTH = 1280;
const EXPECTED_HEIGHT = 720;

/**
 * Parse PNG IHDR chunk to extract width and height.
 * PNG format: 8-byte signature, then chunks.
 * IHDR is the first chunk: 4-byte length, 4-byte "IHDR", 4-byte width (BE), 4-byte height (BE).
 * Width is at bytes 16-19, height at bytes 20-23.
 */
function parsePngDimensions(filePath: string): { width: number; height: number } {
  const buf = readFileSync(filePath);

  // Verify PNG signature (first 8 bytes)
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.subarray(0, 8).compare(pngSignature) !== 0) {
    throw new Error(`Not a valid PNG file: ${filePath}`);
  }

  // IHDR chunk: width at offset 16, height at offset 20 (big-endian uint32)
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

describe.skipIf(!process.env.RUN_SCREENSHOT_TESTS)('Screenshot Capture', () => {
  beforeAll(() => {
    console.log('Running capture script... (this may take 15-30 seconds)');
    execSync('node scripts/capture-readme-screenshots.mjs', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: 60_000,
    });
  }, 90_000); // 90s timeout for beforeAll

  for (const screenshot of EXPECTED_SCREENSHOTS) {
    const fullPath = join(PROJECT_ROOT, screenshot.path);

    it(`${screenshot.path} exists and is not empty`, () => {
      expect(existsSync(fullPath)).toBe(true);
      const stat = readFileSync(fullPath);
      expect(stat.length).toBeGreaterThan(screenshot.minSize);
    });

    it(`${screenshot.path} has ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT} dimensions`, () => {
      const { width, height } = parsePngDimensions(fullPath);
      expect(width).toBe(EXPECTED_WIDTH);
      expect(height).toBe(EXPECTED_HEIGHT);
    });
  }
});
