/**
 * @fileoverview Pins `config/clis.stock.json` (install.sh's pre-clone, pre-build view of
 * the stock CLI catalog) in sync with the real source of truth,
 * `src/config/cli-registry/stock.ts`. Same pattern as `test/sse-registry-parity.test.ts`.
 *
 * If this fails, run `npm run generate:cli-stock-json` and commit the regenerated file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

describe('config/clis.stock.json', () => {
  it('matches the compiled-in stock catalog', () => {
    const expected = STOCK_CLIS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      stock: true,
      discovery: entry.discovery,
    }));

    const onDisk = JSON.parse(readFileSync(resolve(import.meta.dirname, '../config/clis.stock.json'), 'utf8'));

    expect(onDisk).toEqual(expected);
  });
});
