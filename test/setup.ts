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
const originalCodemanDataDir = process.env.CODEMAN_DATA_DIR;
const testHome = mkdtempSync(join(tmpdir(), 'codeman-vitest-'));
const testDataDir = join(tmpdir(), `codeman-vitest-data-${process.pid}`);

if (originalPlaywrightBrowsersPath === undefined && originalHome) {
  process.env.PLAYWRIGHT_BROWSERS_PATH =
    process.platform === 'darwin'
      ? join(originalHome, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA || join(originalHome, 'AppData', 'Local'), 'ms-playwright')
        : join(originalHome, '.cache', 'ms-playwright');
}
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.VITEST = 'true';

// SAFETY: `getDataDir()` resolves via `homedir()` → `~/.codeman<INSTANCE_SUFFIX>`.
// Overriding HOME above is NOT enough: on Linux `os.homedir()` reads /etc/passwd,
// not $HOME, so without this a route test that writes `remote-hosts.json` (or
// any state file) into `getDataDir()` silently clobbers the PRODUCTION
// `~/.codeman` tree (found 2026-08-29: `session-routes-workspace-hooks.test.ts`
// overwrote prod `remote-hosts.json` with an `h1/box/10.0.0.5` fixture during a
// bare full-suite run, wiping every user-defined remote host and emptying the
// launch case dropdown). Point every test at a throwaway data dir instead.
process.env.CODEMAN_DATA_DIR = testDataDir;

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

afterAll(async () => {
  // Let in-flight console-log rpc forwards drain before the worker environment
  // tears down. On loaded CI runners the channel otherwise closes while the last
  // "onUserConsoleLog" call is still pending, and that single unhandled
  // EnvironmentTeardownError fails the run after every test has passed
  // (observed twice on the PR #175/#176 merge commit; never locally).
  const { promise: drained, resolve: drainDone } = Promise.withResolvers<void>();
  setTimeout(drainDone, 50);
  await drained;

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  if (originalVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = originalVitest;

  if (originalPlaywrightBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = originalPlaywrightBrowsersPath;

  if (originalCodemanDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = originalCodemanDataDir;

  rmSync(testHome, { recursive: true, force: true });
  rmSync(testDataDir, { recursive: true, force: true });
});

// afterAll never fires for a fully-skipped test file (no tests execute), which
// would leak the temp home created above. The exit hook is the backstop; rmSync
// with force is a no-op when afterAll already removed it.
process.on('exit', () => {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(testDataDir, { recursive: true, force: true });
});
