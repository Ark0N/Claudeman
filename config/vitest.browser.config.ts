import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BROWSER_TEST_GLOBS } from './test-suites';

const root = resolve(import.meta.dirname, '..');

/**
 * The Playwright-driven suite `npm test` skips — `npm run test:browser`.
 *
 * Needs chromium and, for most of these, a live Codeman server on a real port;
 * codex-predictive-echo also needs a real codex binary. Expect failures where
 * the machine cannot provide those, and read them as "not runnable here", not
 * as a regression.
 *
 * The mobile suite is NOT here: it needs per-machine PNG baselines, serial
 * execution and the `pretest:mobile` vendor step, so it keeps its own config
 * (test/mobile/vitest.config.ts) behind `npm run test:mobile`.
 *
 * fileParallelism stays off for the same reason as every other config in this
 * directory: these bind real ports and drive real tmux sessions, and two files
 * doing that at once fail each other rather than the code.
 */
export default defineConfig({
  test: {
    root,
    globals: true,
    environment: 'node',
    include: BROWSER_TEST_GLOBS,
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    teardownTimeout: 60000,
  },
});
