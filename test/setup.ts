/**
 * @fileoverview Global test setup for Codeman tests
 *
 * SAFETY: The suite gets a temporary HOME and explicitly enables runtime test
 * mode before application modules load. Tests therefore cannot touch the real
 * Codeman state/cases tree or launch external tmux-backed agent sessions.
 *
 * This setup file strips shell-level auth configuration that can leak from a
 * running Codeman instance, then handles mock/timer cleanup between tests.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, vi } from 'vitest';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalVitest = process.env.VITEST;
const originalPlaywrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
const testHome = mkdtempSync(join(tmpdir(), 'codeman-vitest-'));

if (originalPlaywrightBrowsersPath === undefined && originalHome) {
  process.env.PLAYWRIGHT_BROWSERS_PATH =
    process.platform === 'darwin'
      ? join(originalHome, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA || originalHome, 'ms-playwright')
        : join(originalHome, '.cache', 'ms-playwright');
}
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.VITEST = 'true';

delete process.env.CODEMAN_PASSWORD;
delete process.env.CODEMAN_USERNAME;
// Gesture availability changes renderIndexHtml output (injects the
// __codemanGestureAvailable flag), breaking byte-identity assertions
// (test/server-index-title.test.ts) when the shell exports CODEMAN_GESTURE=1.
delete process.env.CODEMAN_GESTURE;

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  if (originalVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = originalVitest;

  if (originalPlaywrightBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = originalPlaywrightBrowsersPath;

  rmSync(testHome, { recursive: true, force: true });
});
