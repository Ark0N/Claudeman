import { resolve } from 'node:path';
import { defineConfig, configDefaults } from 'vitest/config';

const root = resolve(import.meta.dirname, '..');

/**
 * CI test config — same as vitest.config.ts but EXCLUDES the browser-driven
 * mobile suite (test/mobile/**). Those are Playwright visual-regression tests
 * that need a live server + chromium + environment-specific PNG baselines, so
 * they are run/maintained separately and are not part of the CI gate.
 *
 * Keep the rest in sync with config/vitest.config.ts.
 */
export default defineConfig({
  test: {
    root,
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'test/mobile/**', // browser/visual (Playwright + chromium)
      'test/perf-*.test.ts', // timing-sensitive perf benchmarks (flaky in CI)
      'test/inline-rename.test.ts', // browser (Playwright)
      'test/opencode-resize.test.ts', // browser (Playwright)
      'test/terminal-viewport-ownership.test.ts', // browser (Playwright)
      'test/webgl-fallback.test.ts', // browser (Playwright)
    ],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    teardownTimeout: 60000,
  },
});
