/**
 * @fileoverview Global test setup for Codeman tests
 *
 * SAFETY: The suite gets a temporary HOME and explicitly enables runtime test
 * mode before application modules load. Tests therefore cannot touch the real
 * Codeman state/cases tree or launch external tmux-backed agent sessions.
 *
 * This setup file strips shell-level configuration that can leak from a running
 * Codeman instance — auth (`CODEMAN_PASSWORD`/`CODEMAN_USERNAME`), the gesture
 * flag, and the three INSTANCE-selection vars that would otherwise point the
 * suite at a real data dir or tmux socket — then handles mock/timer cleanup
 * between tests.
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

// SAFETY: `getDataDir()` is `process.env.CODEMAN_DATA_DIR || join(homedir(), '.codeman<suffix>')`.
// The temp HOME above already redirects the second half (`os.homedir()` follows
// `$HOME`; libuv checks the env var before the passwd entry), but the first half
// is an ABSOLUTE override: a `CODEMAN_DATA_DIR` inherited from the shell (a
// second instance, a beta run) bypasses the temp HOME entirely, and a bare suite
// run then reads and writes the REAL data dir (found 2026-08-29:
// `session-routes-workspace-hooks.test.ts` overwrote the production
// `remote-hosts.json` with an `h1/box/10.0.0.5` fixture, wiping every user-defined
// remote host and emptying the launch case dropdown). Point it at a throwaway dir.
process.env.CODEMAN_DATA_DIR = testDataDir;

delete process.env.CODEMAN_PASSWORD;
delete process.env.CODEMAN_USERNAME;
// Gesture availability changes renderIndexHtml output (injects the
// __codemanGestureAvailable flag), breaking byte-identity assertions
// (test/server-index-title.test.ts) when the shell exports CODEMAN_GESTURE=1.
delete process.env.CODEMAN_GESTURE;

// Instance selection is PROCESS-WIDE and is what `src/config/instance.ts` derives
// both the data dir and the tmux socket from, so a shell that exports any of these
// three reaches straight past the temp HOME above and undoes the isolation this
// file exists to provide:
//
//   - CODEMAN_DATA_DIR is the dangerous one. It is an ABSOLUTE override read in
//     `getDataDir()`, so it bypasses HOME entirely: a developer who exports it
//     (or a shell left over from `codeman web -d`) has the suite reading and
//     WRITING their real `state.json`, `users.json`, `intents.json` and
//     `hook-secret` instead of a throwaway tree.
//   - CODEMAN_INSTANCE moves the data dir to `~/.codeman-<name>` and the socket to
//     `codeman-<name>`. Inside the temp HOME that is not a data-loss risk, but it
//     silently changes the paths tests assert on — and `scripts/run-beta.sh`
//     exports it, so any shell that has run a beta carries it.
//   - CODEMAN_TMUX_SOCKET renames the socket `resolveTmuxSocketName()` returns.
//     `TmuxManager` no-ops its shell commands under vitest, so this is assertion
//     drift rather than a stray `tmux -L` against prod — but it is the same class
//     of leak and the same one-line fix.
//
// ⚠️ These must be deleted HERE rather than in a test, because `CODEMAN_INSTANCE`
// is captured into a module-level const the first time `config/instance.ts` is
// imported. A setup file runs before any application module loads; a beforeEach
// would already be too late.
delete process.env.CODEMAN_INSTANCE;
delete process.env.CODEMAN_DATA_DIR;
delete process.env.CODEMAN_TMUX_SOCKET;

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
