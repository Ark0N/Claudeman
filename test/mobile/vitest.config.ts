import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  test: {
    root,
    globals: true,
    environment: 'node',
    include: ['test/mobile/**/*.test.ts'],
    setupFiles: ['./test/setup.ts', './test/mobile/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
  },
});
