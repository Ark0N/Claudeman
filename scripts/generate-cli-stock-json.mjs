#!/usr/bin/env node
/**
 * @fileoverview Regenerates `config/clis.stock.json` from the compiled-in stock CLI
 * catalog (`src/config/cli-registry/stock.ts`), which stays the single source of truth.
 *
 * This JSON export exists for ONE consumer: `install.sh`, which runs standalone via
 * `curl | bash` BEFORE the repo is cloned or built, so it cannot import TypeScript (or
 * even reach a git checkout) to learn what CLIs exist, where to look for them, or how to
 * install them. Its own copy is fetched over the network (same raw-file pattern the
 * installer already uses for itself) and parsed with a plain `node -e`/`JSON.parse` — no
 * ts-node/tsx dependency at install time.
 *
 * Only the fields install.sh actually needs are exported (id, label, stock flag, and
 * `discovery`: binaries/searchDirs/install commands) — never `launch`/`capabilities`,
 * which are launch-time concerns the server alone interprets.
 *
 * `test/cli-stock-json-sync.test.ts` pins this file in sync with stock.ts, the same
 * pattern as `test/sse-registry-parity.test.ts` for the SSE event tables. Run
 * `npm run generate:cli-stock-json` after editing stock.ts and commit the result.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { STOCK_CLIS } = await import('../src/config/cli-registry/stock.ts');

const out = STOCK_CLIS.map((entry) => ({
  id: entry.id,
  label: entry.label,
  stock: true,
  discovery: entry.discovery,
}));

const outPath = resolve(here, '../config/clis.stock.json');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`Wrote ${outPath} (${out.length} entries)`);
