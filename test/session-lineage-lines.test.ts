/**
 * Geometry policy for the session lineage lines (tab → tab it spawned).
 *
 * The renderer in session-lineage.js measures and appends; every decision about
 * WHAT to draw (and whether to draw at all) lives in computeLineagePath, so it can
 * be pinned here without a browser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Rect = { left: number; top: number; width: number; height: number };
type LineagePath = { d: string; endX: number; endY: number; sameRow: boolean } | null;

function loadLineageHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanLineage: {
        computePath: (input: { parent: Rect | null; child: Rect | null; strip?: Rect; depth?: number }) => LineagePath;
        DIP_MIN_PX: number;
        DIP_MAX_PX: number;
        SIBLING_STEP_PX: number;
        COLORS: string[];
      };
    }
  ).CodemanLineage;
}

// A strip wide enough that nothing is clipped unless a test says so.
const STRIP: Rect = { left: 0, top: 0, width: 1200, height: 40 };
const tab = (left: number, top = 4): Rect => ({ left, top, width: 120, height: 30 });

/** Pull the control-point Y values out of `M x y C x y, x y, x y`. */
function controlYs(d: string): number[] {
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  // M x0 y0 C x1 y1, x2 y2, x3 y3  →  indices 3 and 5 are the control Ys
  return [nums[3], nums[5]];
}

describe('lineage line geometry', () => {
  it('bridges two same-row tabs with an arc that hangs BELOW the strip', () => {
    const helper = loadLineageHelper();
    const geom = helper.computePath({ parent: tab(0), child: tab(400), strip: STRIP });

    expect(geom).not.toBeNull();
    expect(geom!.sameRow).toBe(true);
    // Starts at the parent's bottom-center, ends at the child's bottom-center.
    expect(geom!.d.startsWith('M 60 34')).toBe(true);
    expect(geom!.endX).toBe(460);
    expect(geom!.endY).toBe(34);
    // Both control points dip below the tab bottoms — that is what makes it a
    // bracket under the strip rather than a line drawn across the tabs.
    for (const y of controlYs(geom!.d)) expect(y).toBeGreaterThan(34);
  });

  it('deepens the dip with distance, but keeps it inside the clamp', () => {
    const helper = loadLineageHelper();
    const near = helper.computePath({ parent: tab(0), child: tab(140), strip: STRIP })!;
    const far = helper.computePath({ parent: tab(0), child: tab(1000), strip: STRIP })!;

    // The dip hangs from the STRIP's bottom edge (40), not the tab bottoms.
    const nearDip = controlYs(near.d)[0] - 40;
    const farDip = controlYs(far.d)[0] - 40;
    expect(farDip).toBeGreaterThan(nearDip);
    expect(nearDip).toBeGreaterThanOrEqual(helper.DIP_MIN_PX);
    expect(farDip).toBeLessThanOrEqual(helper.DIP_MAX_PX);
  });

  it('nests siblings by depth so two children of one parent do not overprint', () => {
    const helper = loadLineageHelper();
    const first = helper.computePath({ parent: tab(0), child: tab(400), strip: STRIP, depth: 0 })!;
    const second = helper.computePath({ parent: tab(0), child: tab(400), strip: STRIP, depth: 1 })!;

    expect(controlYs(second.d)[0] - controlYs(first.d)[0]).toBe(helper.SIBLING_STEP_PX);
    expect(first.d).not.toBe(second.d);
  });

  it('keeps bending at strip-wide spans instead of flattening into a straight line', () => {
    const helper = loadLineageHelper();
    // A worker the agent skill starts is appended to the END of the strip, so this
    // is the span the feature is actually used at. The corridor has failed in BOTH
    // directions: the first 44px clamp read as a flat thread here (#285), and the
    // 104px clamp that replaced it bowed deep into the terminal (2026-08-15), so this
    // pins the cap exactly rather than just a floor.
    const wide = helper.computePath({ parent: tab(0), child: tab(1300), strip: { ...STRIP, width: 1500 } })!;
    const near = helper.computePath({ parent: tab(0), child: tab(140), strip: STRIP })!;

    const wideDip = controlYs(wide.d)[0] - 40; // from the strip's bottom edge
    const nearDip = controlYs(near.d)[0] - 40;
    expect(wideDip).toBeGreaterThan(nearDip * 2);
    expect(wideDip).toBe(helper.DIP_MAX_PX);
    expect(helper.DIP_MAX_PX).toBe(64);
  });

  it('hangs the dip from the STRIP bottom, so no per-row offset ever stacks on it', () => {
    const helper = loadLineageHelper();
    const twoRowStrip = { left: 0, top: 0, width: 1200, height: 84 }; // rows at y 4-34 and 48-78
    // A wrapped pair (row 1 → row 2) and a same-row pair on ROW 1 of the same strip.
    const wrapped = helper.computePath({ parent: tab(0), child: tab(400, 48), strip: twoRowStrip })!;
    const row1Pair = helper.computePath({ parent: tab(0), child: tab(400), strip: twoRowStrip })!;

    // Both brackets clear the ENTIRE strip: the wrapped one does not add the row
    // offset on top (the 2026-08-15 over-bow), and the row-1 pair does not draw
    // through row 2's tab labels (the retune's own first-draft regression).
    for (const geom of [wrapped, row1Pair]) {
      for (const y of controlYs(geom.d)) {
        expect(y).toBeGreaterThanOrEqual(84 + helper.DIP_MIN_PX);
        expect(y).toBeLessThanOrEqual(84 + helper.DIP_MAX_PX + helper.SIBLING_STEP_PX);
      }
    }
  });

  it('exposes a colour palette whose first entry defers to the skin blue', () => {
    const helper = loadLineageHelper();
    const colors = helper.COLORS;
    expect(Array.isArray(colors)).toBe(true);
    // '' = no override: session-lineage.js sets no inline --lineage-color and the
    // CSS falls back to the skin-tuned --session-blue, so a lone arc stays blue.
    expect(colors[0]).toBe('');
    expect(colors.length).toBeGreaterThanOrEqual(6);
    expect(new Set(colors).size).toBe(colors.length);
    for (const c of colors.slice(1)) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('brackets a wrapped pair BELOW the lower row rather than inside the row gap', () => {
    const helper = loadLineageHelper();
    // The reported bug: with the desktop strip wrapped, a parent on row 1 (bottom 34)
    // and its child on row 2 (top 48) are 14px apart, and a parent-bottom → child-TOP
    // bezier had 14px to bend in, so it drew a flat line hidden in the gap, three
    // siblings overprinting each other. Both ends now anchor on the tab BOTTOM and the
    // curve hangs below the LOWER row, the same bracket the flat strip gets.
    const strip: Rect = { left: 0, top: 0, width: 1200, height: 90 };
    const geom = helper.computePath({ parent: tab(0, 4), child: tab(200, 48), strip })!;

    expect(geom.sameRow).toBe(false);
    expect(geom.d.startsWith('M 60 34')).toBe(true); // parent BOTTOM
    expect(geom.endY).toBe(78); // child BOTTOM, not its top
    // Every control point clears the lower row by at least the minimum dip.
    for (const y of controlYs(geom.d)) expect(y).toBeGreaterThanOrEqual(78 + helper.DIP_MIN_PX);
  });

  it('draws the same bracket when the child sits on the row ABOVE its parent', () => {
    const helper = loadLineageHelper();
    const strip: Rect = { left: 0, top: 0, width: 1200, height: 90 };
    const geom = helper.computePath({ parent: tab(0, 48), child: tab(200, 4), strip })!;

    expect(geom.sameRow).toBe(false);
    expect(geom.d.startsWith('M 60 78')).toBe(true); // parent BOTTOM
    expect(geom.endY).toBe(34); // child BOTTOM
    // The parent's row is the lower one here, so that is what the curve clears.
    for (const y of controlYs(geom.d)) expect(y).toBeGreaterThanOrEqual(78 + helper.DIP_MIN_PX);
  });

  it('skips an edge whose tab is scrolled out of the strip', () => {
    const helper = loadLineageHelper();
    // `.session-tabs` is overflow-x:auto, so a scrolled-out tab still HAS a rect —
    // one lying over the logo or the header buttons. It must not be drawn to.
    const strip: Rect = { left: 200, top: 0, width: 600, height: 40 };

    expect(helper.computePath({ parent: tab(-300), child: tab(400), strip })).toBeNull();
    expect(helper.computePath({ parent: tab(400), child: tab(1400), strip })).toBeNull();
    expect(helper.computePath({ parent: tab(300), child: tab(600), strip })).not.toBeNull();
  });

  it('returns null for a missing or degenerate rect instead of emitting NaN', () => {
    const helper = loadLineageHelper();

    expect(helper.computePath({ parent: null, child: tab(0), strip: STRIP })).toBeNull();
    expect(helper.computePath({ parent: tab(0), child: null, strip: STRIP })).toBeNull();
    expect(
      helper.computePath({ parent: { left: 0, top: 0, width: 0, height: 0 }, child: tab(0), strip: STRIP })
    ).toBeNull();
  });

  it('still draws when no strip rect is supplied (clipping is opt-in)', () => {
    const helper = loadLineageHelper();
    const geom = helper.computePath({ parent: tab(0), child: tab(9000) });

    expect(geom).not.toBeNull();
    expect(geom!.d).not.toContain('NaN');
  });
});
