/**
 * @fileoverview Unit tests for the responsive layout math.
 *
 * Two things are pinned here because the renderer trusts them blindly: the
 * regions tile the screen exactly (no gaps, no overlap, full coverage), and no
 * region is ever negative, however small or absurd the terminal gets.
 */
import { describe, it, expect } from 'vitest';
import {
  computeLayout,
  needsBanner,
  NARROW_BREAKPOINT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type TuiLayout,
} from '../../src/tui/tui-layout.js';

function rects(layout: TuiLayout) {
  return [layout.header, layout.banner, layout.body, layout.list, layout.divider, layout.preview, layout.footer];
}

function expectSane(layout: TuiLayout): void {
  for (const rect of rects(layout)) {
    if (!rect) continue;
    expect(rect.width).toBeGreaterThanOrEqual(0);
    expect(rect.height).toBeGreaterThanOrEqual(0);
    expect(rect.row).toBeGreaterThanOrEqual(1);
    expect(rect.col).toBeGreaterThanOrEqual(1);
    expect(rect.col + rect.width - 1).toBeLessThanOrEqual(Math.max(1, layout.cols));
    if (rect.height > 0) expect(rect.row + rect.height - 1).toBeLessThanOrEqual(layout.rows);
  }
  expect(layout.header.height + layout.body.height + layout.footer.height).toBe(layout.rows);
}

describe('computeLayout', () => {
  it('stacks header, body and footer with no gap', () => {
    const layout = computeLayout(100, 30);
    expect(layout.header).toEqual({ row: 1, col: 1, width: 100, height: 1 });
    expect(layout.body.row).toBe(2);
    expect(layout.body.height).toBe(28);
    expect(layout.footer).toEqual({ row: 30, col: 1, width: 100, height: 1 });
    expectSane(layout);
  });

  it('splits a wide body into sidebar, divider and preview covering every column', () => {
    const layout = computeLayout(100, 30);
    expect(layout.narrow).toBe(false);
    expect(layout.rowHeight).toBe(1);
    expect(layout.list.width).toBe(36);
    expect(layout.divider).toEqual({ row: 2, col: 37, width: 1, height: 28 });
    expect(layout.preview).toEqual({ row: 2, col: 38, width: 63, height: 28 });
    expect(layout.list.width + 1 + (layout.preview?.width ?? 0)).toBe(layout.cols);
  });

  it('clamps the sidebar at both ends', () => {
    expect(computeLayout(NARROW_BREAKPOINT, 30).list.width).toBe(SIDEBAR_MIN_WIDTH);
    expect(computeLayout(200, 30).list.width).toBe(SIDEBAR_MAX_WIDTH);
    expect(computeLayout(400, 30).list.width).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('drops the preview and doubles the row height below the breakpoint', () => {
    const narrow = computeLayout(NARROW_BREAKPOINT - 1, 24);
    expect(narrow.narrow).toBe(true);
    expect(narrow.rowHeight).toBe(2);
    expect(narrow.preview).toBeNull();
    expect(narrow.divider).toBeNull();
    expect(narrow.list.width).toBe(NARROW_BREAKPOINT - 1);
    expect(computeLayout(NARROW_BREAKPOINT, 24).narrow).toBe(false);
    expectSane(narrow);
  });

  it('carves the banner out of the top of the body when asked', () => {
    const plain = computeLayout(100, 30);
    const banner = computeLayout(100, 30, { banner: true });
    expect(plain.banner).toBeNull();
    expect(banner.banner).toEqual({ row: 2, col: 1, width: 100, height: 1 });
    expect(banner.body.height).toBe(plain.body.height);
    expect(banner.list.row).toBe(plain.list.row + 1);
    expect(banner.list.height).toBe(plain.list.height - 1);
    expectSane(banner);
  });

  it('degrades on a tiny terminal without producing negative sizes', () => {
    for (const [cols, rows] of [
      [5, 5],
      [1, 1],
      [1, 2],
      [3, 3],
      [80, 2],
      [80, 1],
    ] as const) {
      const layout = computeLayout(cols, rows, { banner: true });
      expectSane(layout);
      // The shape is width-driven, never height-driven: an 80x1 terminal is
      // still a wide one, it just has nowhere to put the body.
      expect(layout.narrow).toBe(cols < NARROW_BREAKPOINT);
    }
    const one = computeLayout(1, 1);
    expect(one.body.height).toBe(0);
    expect(one.footer.height).toBe(0);
    const two = computeLayout(40, 2);
    expect(two.body.height).toBe(0);
    expect(two.banner).toBeNull();
    expect(two.footer.height).toBe(1);
  });

  it('clamps nonsense dimensions to one cell', () => {
    for (const [cols, rows] of [
      [0, 0],
      [-10, -10],
      [Number.NaN, Number.NaN],
    ] as const) {
      const layout = computeLayout(cols, rows);
      expect(layout.cols).toBe(1);
      expect(layout.rows).toBe(1);
      expectSane(layout);
    }
  });

  it('floors fractional dimensions', () => {
    expect(computeLayout(100.9, 30.9).cols).toBe(100);
    expect(computeLayout(100.9, 30.9).rows).toBe(30);
  });
});

describe('needsBanner', () => {
  it('is the caller-side rule for reserving the banner row', () => {
    expect(needsBanner('connected')).toBe(false);
    expect(needsBanner('reconnecting')).toBe(true);
    expect(needsBanner('degraded')).toBe(true);
    expect(needsBanner('down')).toBe(true);
  });
});
