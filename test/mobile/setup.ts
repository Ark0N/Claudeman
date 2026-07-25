import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const previousDataDir = process.env.CODEMAN_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), 'codeman-mobile-test-'));

// Setup files run before each test module is imported, so module-level dataPath()
// constants resolve inside this disposable directory instead of ~/.codeman.
process.env.CODEMAN_DATA_DIR = dataDir;

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});
