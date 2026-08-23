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
type Orientation = 'horizontal' | 'vertical';

const lineageJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-lineage.js'), 'utf8');
const stylesCss = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');

function loadLineageHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanLineage: {
        computePath: (input: {
          parent: Rect | null;
          child: Rect | null;
          strip?: Rect;
          depth?: number;
          orientation?: Orientation;
        }) => LineagePath;
        DIP_MIN_PX: number;
        DIP_MAX_PX: number;
        SIBLING_STEP_PX: number;
        COLORS: string[];
      };
    }
  ).CodemanLineage;
}

/** The vm sandbox session-lineage.js was evaluated in, plus an app instance from it. */
type LineageApp = Record<string, Function> & {
  sessions: Map<string, { parentSessionId: string | null; status: string }>;
  sessionOrder: string[];
};
type LineageSandbox = { document: Record<string, Function>; CSS?: { escape: (v: string) => string } };

/**
 * Load session-lineage.js for real, with the globals it declares. The colour memo is
 * plain state on the app instance, so nothing here needs a browser.
 */
function loadLineageApp(): { app: LineageApp; sandbox: LineageSandbox } {
  function CodemanApp(this: unknown) {}
  const sandbox: Record<string, unknown> = {
    window: {},
    globalThis: {},
    CodemanApp,
    MobileDetection: { getDeviceType: () => 'desktop' },
    document: {
      documentElement: { getAttribute: () => 'horizontal' },
      getElementById: () => null,
      createElementNS: () => null,
    },
  };
  const context = vm.createContext(sandbox);
  for (const file of ['constants.js', 'session-lineage.js']) {
    const source = readFileSync(resolve(import.meta.dirname, `../src/web/public/${file}`), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  const app = new (CodemanApp as unknown as new () => LineageApp)();
  app.sessions = new Map();
  app.sessionOrder = [];
  return { app, sandbox: sandbox as unknown as LineageSandbox };
}

/**
 * Drive the real `_appendLineageConnectionLines()` and report the inline
 * `--lineage-color` each arc ended up with, keyed by child.
 *
 * The colour function alone cannot prove this: passing the CHILD id there would still
 * return a stable colour per child and every direct test would pass, which is exactly
 * the regression these tests exist to catch.
 */
function renderLineageColors(sessions: Record<string, string | null>): Record<string, string> {
  const { app, sandbox } = loadLineageApp();
  app.sessions = new Map(
    Object.entries(sessions).map(([id, parentSessionId]) => [id, { parentSessionId, status: 'idle' }])
  );
  app.sessionOrder = Object.keys(sessions);
  app._lineageLinesEnabled = () => true;
  app.isSessionSidebarActive = () => false;

  type Node = { attrs: Record<string, string>; style: Record<string, string> & { setProperty: Function } };
  const made: Node[] = [];
  const ids = Object.keys(sessions);
  const rect = (left: number) => ({ left, top: 4, width: 120, height: 30, right: left + 120, bottom: 34 });
  const strip = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 2000, height: 40, right: 2000, bottom: 40 }),
    querySelector: (sel: string) => {
      const id = /data-id="([^"]+)"/.exec(sel)?.[1];
      const i = id ? ids.indexOf(id) : -1;
      return i < 0 ? null : { getBoundingClientRect: () => rect(i * 140) };
    },
  };
  sandbox.document.getElementById = (id: string) => (id === 'sessionTabs' ? strip : null);
  sandbox.document.createElementNS = () => {
    const style = {} as Record<string, string> & { setProperty: Function };
    style.setProperty = (k: string, v: string) => void (style[k] = v);
    const node: Node = { attrs: {}, style };
    (node as unknown as { setAttribute: Function }).setAttribute = (k: string, v: string) => void (node.attrs[k] = v);
    made.push(node);
    return node;
  };
  sandbox.CSS = { escape: (v: string) => v };

  app._appendLineageConnectionLines({ appendChild: () => {} }, new Map());

  const out: Record<string, string> = {};
  for (const node of made) {
    // Both the path and its end dot carry the child id; they must agree on the colour.
    const child = node.attrs['data-child-tab'];
    if (child) out[child] = node.style['--lineage-color'] ?? '';
  }
  return out;
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

  it('routes vertical tabs through the empty left gutter instead of their shared centerline', () => {
    const helper = loadLineageHelper();
    const strip: Rect = { left: 100, top: 20, width: 320, height: 320 };
    const parent: Rect = { left: 132, top: 40, width: 260, height: 40 };
    const child: Rect = { left: 132, top: 200, width: 260, height: 40 };
    const geom = helper.computePath({ parent, child, strip, orientation: 'vertical' })!;
    const nums = geom.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];

    expect(geom).not.toBeNull();
    expect(nums).toHaveLength(5);
    expect(nums[0]).toBe(parent.left);
    expect(nums[1]).toBe(parent.top + parent.height / 2);
    expect(nums[2]).toBeGreaterThan(strip.left);
    expect(nums[2]).toBeLessThan(parent.left);
    expect(nums[3]).toBe(child.top + child.height / 2);
    expect(nums[4]).toBe(child.left);
    expect(geom.endX).toBe(child.left);
    expect(geom.endY).toBe(child.top + child.height / 2);
  });

  it('offsets vertical sibling tracks without moving either tab endpoint', () => {
    const helper = loadLineageHelper();
    const strip: Rect = { left: 100, top: 20, width: 320, height: 320 };
    const parent: Rect = { left: 132, top: 40, width: 260, height: 40 };
    const child: Rect = { left: 132, top: 200, width: 260, height: 40 };
    const first = helper.computePath({ parent, child, strip, orientation: 'vertical', depth: 0 })!;
    const second = helper.computePath({ parent, child, strip, orientation: 'vertical', depth: 1 })!;
    const numbers = (d: string) => d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];

    expect(numbers(second.d)[2]).toBeGreaterThan(numbers(first.d)[2]);
    expect([second.endX, second.endY]).toEqual([first.endX, first.endY]);
  });

  it('keeps the same gutter shape when the child sits above its parent', () => {
    const helper = loadLineageHelper();
    const strip: Rect = { left: 100, top: 20, width: 320, height: 320 };
    const parent: Rect = { left: 132, top: 220, width: 260, height: 40 };
    const child: Rect = { left: 132, top: 60, width: 260, height: 40 };
    const geom = helper.computePath({ parent, child, strip, orientation: 'vertical' })!;
    const nums = geom.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];

    expect(nums).toEqual([parent.left, 240, expect.any(Number), 80, child.left]);
    expect(nums[2]).toBeGreaterThan(strip.left);
    expect(nums[2]).toBeLessThan(parent.left);
    expect([geom.endX, geom.endY]).toEqual([child.left, 80]);
  });

  it('clips vertical lineage by the visible Y range after rail scrolling', () => {
    const helper = loadLineageHelper();
    const strip: Rect = { left: 100, top: 100, width: 320, height: 300 };
    const visible: Rect = { left: 132, top: 160, width: 260, height: 40 };
    const above: Rect = { left: 132, top: 20, width: 260, height: 40 };
    const below: Rect = { left: 132, top: 460, width: 260, height: 40 };

    expect(helper.computePath({ parent: above, child: visible, strip, orientation: 'vertical' })).toBeNull();
    expect(helper.computePath({ parent: visible, child: below, strip, orientation: 'vertical' })).toBeNull();
    expect(
      helper.computePath({ parent: visible, child: { ...visible, top: 300 }, strip, orientation: 'vertical' })
    ).not.toBeNull();
  });

  it('passes the resolved DOM orientation into geometry and reserves a vertical gutter', () => {
    expect(lineageJs).toContain("getAttribute('data-tab-orientation')");
    expect(lineageJs).toMatch(/compute\(\{[\s\S]{0,180}orientation/);
    const selector = "html[data-tab-orientation='vertical'] .tab-rail .session-tabs {";
    const verticalRailBlock = stylesCss.slice(stylesCss.indexOf(selector), stylesCss.indexOf(selector) + 600);
    expect(verticalRailBlock).toContain('--lineage-vertical-gutter');
    expect(verticalRailBlock).toContain('padding-left');
  });

  it('still draws when no strip rect is supplied (clipping is opt-in)', () => {
    const helper = loadLineageHelper();
    const geom = helper.computePath({ parent: tab(0), child: tab(9000) });

    expect(geom).not.toBeNull();
    expect(geom!.d).not.toContain('NaN');
  });
});

describe('lineage line colours', () => {
  it('gives every arc out of one tab the same colour, however many it spawns', () => {
    const { app } = loadLineageApp();
    // The renderer calls this with the edge's PARENT id, so ten children of w1 all
    // resolve through the same key.
    const forW1 = Array.from({ length: 10 }, () => app._lineageColorFor('w1'));
    expect(new Set(forW1).size).toBe(1);
  });

  it('gives a different spawning tab a different colour', () => {
    const { app } = loadLineageApp();
    expect(app._lineageColorFor('w1')).not.toBe(app._lineageColorFor('w2'));
    expect(app._lineageColorFor('w2')).not.toBe(app._lineageColorFor('w3'));
  });

  it('lets the first spawning tab keep the skin-aware blue', () => {
    // '' = no inline override, so styles.css falls back to --session-blue.
    expect(loadLineageApp().app._lineageColorFor('w1')).toBe('');
  });

  it('changes colour down a chain, since each generation spawns in its own right', () => {
    // w1 -> w2 -> w3: the arc w1->w2 is w1's colour, the arc w2->w3 is w2's.
    const { app } = loadLineageApp();
    expect(app._lineageColorFor('w1')).not.toBe(app._lineageColorFor('w2'));
  });

  it('keeps a tab on its colour across re-renders and interleaved siblings', () => {
    // The SVG is wiped and rebuilt constantly, so the colour must come from a memo
    // rather than draw order.
    const { app } = loadLineageApp();
    const first = app._lineageColorFor('w1');
    app._lineageColorFor('w2');
    app._lineageColorFor('w3');
    expect(app._lineageColorFor('w1')).toBe(first);
  });

  it('cycles the palette once every tab in it has spawned', () => {
    const { app } = loadLineageApp();
    const palette = loadLineageHelper().COLORS;
    const seen = Array.from({ length: palette.length }, (_, i) => app._lineageColorFor(`p${i}`));
    expect(new Set(seen).size).toBe(palette.length);
    expect(app._lineageColorFor(`p${palette.length}`)).toBe(seen[0]);
  });
});

describe('lineage colours, as actually rendered', () => {
  it('paints every arc out of one tab the same colour', () => {
    // w1 spawns three workers; all three arcs must match.
    const colors = renderLineageColors({ w1: null, a: 'w1', b: 'w1', c: 'w1' });
    expect(Object.keys(colors).sort()).toEqual(['a', 'b', 'c']);
    expect(new Set(Object.values(colors)).size).toBe(1);
  });

  it('paints two spawning tabs in different colours', () => {
    const colors = renderLineageColors({ w1: null, w2: null, a: 'w1', b: 'w1', c: 'w2', d: 'w2' });
    expect(colors.a).toBe(colors.b);
    expect(colors.c).toBe(colors.d);
    expect(colors.a).not.toBe(colors.c);
  });

  it('changes colour at each generation of a chain', () => {
    // w1 -> w2 -> w3. Each arc takes the colour of the tab it leaves.
    const colors = renderLineageColors({ w1: null, w2: 'w1', w3: 'w2' });
    expect(colors.w2).not.toBe(colors.w3);
  });
});
