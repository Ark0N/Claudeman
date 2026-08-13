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

    const nearDip = controlYs(near.d)[0] - 34;
    const farDip = controlYs(far.d)[0] - 34;
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
    // is the span the feature is actually used at. The first shipped clamp (44px)
    // turned it into a flat thread across the terminal.
    const wide = helper.computePath({ parent: tab(0), child: tab(1300), strip: { ...STRIP, width: 1500 } })!;
    const near = helper.computePath({ parent: tab(0), child: tab(140), strip: STRIP })!;

    const wideDip = controlYs(wide.d)[0] - 34;
    const nearDip = controlYs(near.d)[0] - 34;
    expect(wideDip).toBeGreaterThan(nearDip * 2);
    expect(wideDip).toBeGreaterThanOrEqual(80);
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
