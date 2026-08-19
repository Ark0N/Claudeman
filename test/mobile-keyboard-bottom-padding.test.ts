// Port: none (pure logic in a vm context — no browser, no server).
//
// On phones the toolbar and the keyboard accessory bar are `position: fixed`, so
// they take no layout space: `main`'s padding-bottom is the ONLY thing reserving
// room for them, and every pixel taken out of it is a pixel of terminal painted
// underneath them.
//
// `_shrinkPaddingToFit` reclaims the sub-row slack left after a keyboard-driven
// re-fit. It used to take the whole slack, which pulled the terminal's bottom edge
// down under those bars — and the row the following re-fit gained was painted
// behind them, clipping the last line of a long wrapped prompt: the bottom half of
// the text being typed. The floor is now the bars' MEASURED height.
//
// Lives outside test/mobile/ deliberately — that suite is Playwright-driven and
// excluded from `npm run test:ci`, so a regression guarded only there is invisible
// to CI (same reasoning as terminal-scroll-intent.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile-handlers.js'), 'utf8');

interface Bar {
  offsetHeight: number;
  hidden?: boolean;
}

interface Setup {
  paddingBottom: string;
  containerHeight: number;
  rows: number;
  cellH: number;
  bars: Partial<Record<'.toolbar' | '.keyboard-accessory-bar' | '#cjkInput.cjk-input-visible', Bar>>;
}

/**
 * Load mobile-handlers.js and hand back its KeyboardHandler plus the fake `main`
 * whose inline padding the function edits.
 *
 * `const KeyboardHandler = {...}` is a lexical binding that does not survive to a
 * second `vm.runInContext`, so the export is appended to the SAME script.
 */
function loadHandler(setup: Setup) {
  const main = { style: { paddingBottom: setup.paddingBottom } };
  const container = { clientHeight: setup.containerHeight };
  let fits = 0;
  const app = {
    terminal: {
      rows: setup.rows,
      _core: { _renderService: { dimensions: { css: { cell: { height: setup.cellH } } } } },
    },
    fitAddon: {
      fit: () => {
        fits++;
      },
    },
  };
  const context = vm.createContext({
    console,
    app,
    navigator: { userAgent: 'test', maxTouchPoints: 1 },
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false }),
      scrollTo: () => {},
      getComputedStyle: (el: Bar) => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible' }),
    },
    document: {
      body: { classList: { add: () => {}, remove: () => {} } },
      addEventListener: () => {},
      getElementById: (id: string) => (id === 'terminalContainer' ? container : null),
      querySelector: (sel: string) =>
        sel === '.main' ? main : (setup.bars as Record<string, Bar | undefined>)[sel] || null,
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  vm.runInContext(`${SOURCE}\nglobalThis.__KH = KeyboardHandler;`, context, { filename: 'mobile-handlers.js' });
  return { handler: (context as { __KH: any }).__KH, main, fits: () => fits };
}

// 10 rows × 19px = 190 in a 200px container → 10px of slack, less than one row.
const BASE: Setup = {
  paddingBottom: '84px',
  containerHeight: 200,
  rows: 10,
  cellH: 19,
  bars: { '.toolbar': { offsetHeight: 40 }, '.keyboard-accessory-bar': { offsetHeight: 44 } },
};

describe('_shrinkPaddingToFit', () => {
  it('reclaims the slack when the reservation over-reserves', () => {
    // Bars really need 60px, 84 is reserved → the 10px of slack is free to take.
    const { handler, main } = loadHandler({
      ...BASE,
      bars: { '.toolbar': { offsetHeight: 30 }, '.keyboard-accessory-bar': { offsetHeight: 30 } },
    });

    handler._shrinkPaddingToFit();

    expect(main.style.paddingBottom).toBe('74px');
  });

  it('never shrinks into the space the bars actually occupy', () => {
    // 40 + 44 = 84: the reservation is exactly right, so there is nothing to take
    // even though the terminal has 10px of slack.
    const { handler, main } = loadHandler(BASE);

    handler._shrinkPaddingToFit();

    expect(main.style.paddingBottom).toBe('84px');
  });

  it('stops part-way when only some of the slack is free', () => {
    // Bars need 78px of the reserved 84 → 6px may be reclaimed, not the full 10.
    const { handler, main } = loadHandler({
      ...BASE,
      bars: { '.toolbar': { offsetHeight: 34 }, '.keyboard-accessory-bar': { offsetHeight: 44 } },
    });

    handler._shrinkPaddingToFit();

    expect(main.style.paddingBottom).toBe('78px');
  });

  it('is a no-op, never a grow, when the bars are taller than the reservation', () => {
    // Growing the padding here would resize the terminal as a side effect of a
    // function that exists to reclaim slack.
    const { handler, main } = loadHandler({
      ...BASE,
      bars: { '.toolbar': { offsetHeight: 60 }, '.keyboard-accessory-bar': { offsetHeight: 60 } },
    });

    handler._shrinkPaddingToFit();

    expect(main.style.paddingBottom).toBe('84px');
  });

  it('does not count a hidden bar', () => {
    // The accessory bar is display:none until the keyboard opens; counting it
    // would block a reclaim that is genuinely free.
    const { handler, main } = loadHandler({
      ...BASE,
      bars: { '.toolbar': { offsetHeight: 40 }, '.keyboard-accessory-bar': { offsetHeight: 44, hidden: true } },
    });

    handler._shrinkPaddingToFit();

    expect(main.style.paddingBottom).toBe('74px');
  });

  it('counts the CJK input strip when it is on screen', () => {
    const { handler, main } = loadHandler({
      ...BASE,
      bars: {
        '.toolbar': { offsetHeight: 30 },
        '.keyboard-accessory-bar': { offsetHeight: 30 },
        '#cjkInput.cjk-input-visible': { offsetHeight: 20 },
      },
    });

    handler._shrinkPaddingToFit();

    expect(main.style.paddingBottom).toBe('80px');
  });

  it('leaves the padding alone when the slack is a whole row or more', () => {
    // A full row of slack means the re-fit will claim it as a row; padding is not
    // the lever here.
    const { handler, main, fits } = loadHandler({ ...BASE, containerHeight: 190 + 19 });

    handler._shrinkPaddingToFit();

    expect(main.style.paddingBottom).toBe('84px');
    expect(fits()).toBe(0);
  });
});
