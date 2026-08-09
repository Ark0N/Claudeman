/**
 * @vitest-environment jsdom
 *
 * Layer 3: seeded property fuzz against the REAL xterm parser. Random
 * interleavings of predictions, backspaces, clears, echo writes (correct,
 * partial, foreign), screen clears, scrolls and cursor jumps; invariants
 * checked after EVERY op:
 *   1. span count === outstanding record count, every span inside the grid
 *   2. no public method throws
 *   3. eventual convergence: after the run settles (TTL elapse + reconcile),
 *      outstanding === 0 and the span container is empty
 *
 * Reproduce a failure with FUZZ_SEED=<seed> FUZZ_ITERS=<n> npx vitest run
 * test/predictive-echo-fuzz.test.ts (the failing seed+iter is in the
 * assertion message).
 */
import { describe, expect, it } from 'vitest';
import { PredictiveEchoAddon } from '../src/predictive-echo-addon.js';
import { CELL_H, CELL_W, createReplayTerminal } from './replay-helpers.js';

const SEED = Number(process.env.FUZZ_SEED ?? 1337);
const TOTAL_ITERS = Number(process.env.FUZZ_ITERS ?? 500);
const BATCHES = 4;
const TTL_MS = 5;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [...'abcdefghij XZ!?', '你', '好', '😀'];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fuzzIteration(iter: number, label: string) {
  const rand = mulberry32(SEED + iter);
  const rt = createReplayTerminal(60, 12);
  const addon = new PredictiveEchoAddon({ ttlMs: TTL_MS });
  addon.activate(rt.hybrid);
  const ctx = `${label} seed=${SEED} iter=${iter}`;

  // Park the cursor mid-screen like a composer would
  await rt.write('\x1b[6;3H');

  const ops = 4 + Math.floor(rand() * 12);
  for (let i = 0; i < ops; i++) {
    const r = rand();
    if (r < 0.35) {
      addon.predictChar(ALPHABET[Math.floor(rand() * ALPHABET.length)]);
    } else if (r < 0.43) {
      addon.predictBackspace();
    } else if (r < 0.48) {
      addon.clearPredictions();
    } else if (r < 0.62) {
      // Correct-ish echo: write a run of random chars at the anchor and
      // leave the cursor advanced (confirms whatever happens to match)
      const a = addon.state.anchor;
      if (a) {
        const n = 1 + Math.floor(rand() * 3);
        let text = '';
        for (let k = 0; k < n; k++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
        await rt.write(`\x1b[${a.row + 1};${a.col + 1}H${text}`);
      }
    } else if (r < 0.72) {
      // Foreign rewrite across the anchor row
      await rt.write(`\x1b[6;1H${'Q'.repeat(1 + Math.floor(rand() * 20))}`);
    } else if (r < 0.8) {
      // Scroll: newlines at the bottom push history
      await rt.write(`\x1b[12;1H${'\r\n'.repeat(1 + Math.floor(rand() * 3))}`);
    } else if (r < 0.85) {
      await rt.write('\x1b[2J\x1b[H'); // clear screen + home
    } else if (r < 0.95) {
      addon.reconcile();
    } else {
      // Cursor jump
      const row = 1 + Math.floor(rand() * 12);
      const col = 1 + Math.floor(rand() * 60);
      await rt.write(`\x1b[${row};${col}H`);
    }
    await Promise.resolve(); // flush the debounced reconcile microtask

    // Invariant 1: span/record parity + grid bounds, after every op
    expect(rt.spanCount(), ctx).toBe(addon.state.outstanding);
    for (const s of rt.spans()) {
      const left = parseFloat(s.style.left);
      const width = parseFloat(s.style.width);
      const top = parseFloat(s.style.top);
      expect(left + width, ctx).toBeLessThanOrEqual(60 * CELL_W);
      expect(top, ctx).toBeLessThanOrEqual(11 * CELL_H);
      expect(left, ctx).toBeGreaterThanOrEqual(0);
    }
  }

  // Invariant 3: eventual convergence via echo/TTL, never via dispose
  if (addon.state.outstanding > 0) {
    await sleep(TTL_MS + 15);
    addon.reconcile();
  }
  expect(addon.state.outstanding, ctx).toBe(0);
  expect(rt.spanCount(), ctx).toBe(0);

  addon.dispose();
  rt.cleanup();
}

describe(`predictive echo fuzz (${TOTAL_ITERS} iterations, seed ${SEED})`, () => {
  const perBatch = Math.ceil(TOTAL_ITERS / BATCHES);
  for (let b = 0; b < BATCHES; b++) {
    it(`batch ${b + 1}/${BATCHES}`, async () => {
      const start = b * perBatch;
      const end = Math.min(start + perBatch, TOTAL_ITERS);
      for (let iter = start; iter < end; iter++) {
        await fuzzIteration(iter, `batch${b + 1}`);
      }
    }, 60000);
  }
});
