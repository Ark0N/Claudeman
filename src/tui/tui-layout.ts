/**
 * @fileoverview Pure responsive layout math for the TUI frame.
 *
 * One rule decides the shape: below 72 columns (Termius, iPhone portrait) the
 * preview pane is gone and rows take two lines, which is the constraint the
 * `sc` chooser was built around and the reason it is still usable on a phone.
 * Above it, a clamped sidebar carries the session list and the preview takes
 * the rest.
 *
 * Rectangles are 1-based (row 1, column 1 is the top-left cell) because that is
 * what `ESC [ <row>;<col> H` takes, and every region is clamped to a
 * non-negative size so a 5x5 terminal degrades instead of producing negative
 * widths that would crash the renderer.
 *
 * @module tui/tui-layout
 */

import type { TuiConnectionStatus } from './tui-types.js';

/** Width at which the preview pane is dropped and rows become two lines. */
export const NARROW_BREAKPOINT = 72;
/** Sidebar clamp: narrower than this and a session name stops being readable. */
export const SIDEBAR_MIN_WIDTH = 34;
/** Sidebar clamp: wider than this is wasted on a list of short names. */
export const SIDEBAR_MAX_WIDTH = 44;
/** A preview thinner than this shows nothing useful, so the layout goes narrow instead. */
export const PREVIEW_MIN_WIDTH = 24;
/** Share of the width the sidebar aims for between the clamps. */
const SIDEBAR_RATIO = 0.36;

export interface TuiRect {
  /** 1-based terminal row of the first line. */
  row: number;
  /** 1-based terminal column of the first cell. */
  col: number;
  width: number;
  height: number;
}

export interface TuiLayoutOptions {
  /**
   * Reserve one line under the header for the connection banner. The caller
   * decides with `needsBanner(model.connection)`, so layout stays pure math.
   */
  banner?: boolean;
}

export interface TuiLayout {
  cols: number;
  rows: number;
  /** No preview pane, two-line rows. */
  narrow: boolean;
  /** Terminal lines one session row occupies. */
  rowHeight: 1 | 2;
  header: TuiRect;
  /** Connection banner, when the caller asked for one and there was room. */
  banner: TuiRect | null;
  /** Everything between header and footer, banner included. */
  body: TuiRect;
  /** The session list. */
  list: TuiRect;
  /** The one-column rule between list and preview; null in narrow mode. */
  divider: TuiRect | null;
  /** The preview pane; null in narrow mode. */
  preview: TuiRect | null;
  footer: TuiRect;
}

/** Which connection states get a banner line under the header. */
export function needsBanner(connection: TuiConnectionStatus): boolean {
  return connection !== 'connected';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Rectangles for one frame at `cols` x `rows`.
 *
 * The header always exists; the footer appears from 2 rows up; the body is
 * whatever is left, which may legitimately be zero lines high.
 */
export function computeLayout(cols: number, rows: number, options: TuiLayoutOptions = {}): TuiLayout {
  const width = Math.max(1, Math.floor(cols) || 1);
  const height = Math.max(1, Math.floor(rows) || 1);

  const headerHeight = 1;
  const footerHeight = height >= 2 ? 1 : 0;
  const bodyHeight = Math.max(0, height - headerHeight - footerHeight);
  const bodyRow = headerHeight + 1;

  const header: TuiRect = { row: 1, col: 1, width, height: headerHeight };
  const footer: TuiRect = { row: height, col: 1, width, height: footerHeight };
  const body: TuiRect = { row: bodyRow, col: 1, width, height: bodyHeight };

  const bannerHeight = options.banner === true && bodyHeight > 0 ? 1 : 0;
  const banner: TuiRect | null = bannerHeight > 0 ? { row: bodyRow, col: 1, width, height: 1 } : null;

  const contentRow = bodyRow + bannerHeight;
  const contentHeight = Math.max(0, bodyHeight - bannerHeight);

  const sidebarTarget = Math.floor(width * SIDEBAR_RATIO);
  const sidebarWidth = clamp(sidebarTarget, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
  const previewWidth = width - sidebarWidth - 1;
  const narrow = width < NARROW_BREAKPOINT || previewWidth < PREVIEW_MIN_WIDTH;

  if (narrow) {
    return {
      cols: width,
      rows: height,
      narrow: true,
      rowHeight: 2,
      header,
      banner,
      body,
      list: { row: contentRow, col: 1, width, height: contentHeight },
      divider: null,
      preview: null,
      footer,
    };
  }

  return {
    cols: width,
    rows: height,
    narrow: false,
    rowHeight: 1,
    header,
    banner,
    body,
    list: { row: contentRow, col: 1, width: sidebarWidth, height: contentHeight },
    divider: { row: contentRow, col: sidebarWidth + 1, width: 1, height: contentHeight },
    preview: { row: contentRow, col: sidebarWidth + 2, width: previewWidth, height: contentHeight },
    footer,
  };
}
