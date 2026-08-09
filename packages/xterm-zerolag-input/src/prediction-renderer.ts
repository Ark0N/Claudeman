/**
 * Incremental DOM renderer for PredictiveEchoAddon.
 *
 * Unlike overlay-renderer.ts (which paints whole lines with an opaque
 * background out to totalCols), prediction spans cover ONLY the predicted
 * glyph's own cells: anything wider would blank real echo arriving around
 * a prediction. Spans are keyed by prediction seq for O(1) removal.
 */
import type { CellDimensions, FontStyle } from './types.js';

export interface PredictionSpanParams {
  seq: number;
  /** Viewport-relative row (0-based). */
  row: number;
  /** Column (0-based). */
  col: number;
  char: string;
  /** Cell width of the glyph (1 or 2). */
  width: 1 | 2;
  dims: CellDimensions;
  font: FontStyle;
  underline: boolean;
}

export function addPredictionSpan(
  container: HTMLElement,
  map: Map<number, HTMLSpanElement>,
  p: PredictionSpanParams
): void {
  const span = document.createElement('span');
  // cellH+1 height: covers the sub-pixel seam between rows (same trick the
  // buffer overlay renderer ships with). Background covers only this glyph's
  // cells, never a full row.
  span.style.cssText =
    `position:absolute;left:${p.col * p.dims.width}px;top:${p.row * p.dims.height}px;` +
    `width:${p.width * p.dims.width}px;height:${p.dims.height + 1}px;line-height:${p.dims.height}px;` +
    `text-align:center;pointer-events:none;` +
    `font-family:${p.font.fontFamily};font-size:${p.font.fontSize};font-weight:${p.font.fontWeight};` +
    (p.font.letterSpacing ? `letter-spacing:${p.font.letterSpacing};` : '') +
    `color:${p.font.color};background-color:${p.font.backgroundColor};` +
    `font-feature-settings:'liga' 0,'calt' 0;` +
    (p.underline ? 'text-decoration:underline;' : '');
  span.textContent = p.char;
  map.set(p.seq, span);
  container.appendChild(span);
}

export function removePredictionSpan(map: Map<number, HTMLSpanElement>, seq: number): void {
  const span = map.get(seq);
  if (span) {
    span.remove();
    map.delete(seq);
  }
}

export function clearAllSpans(map: Map<number, HTMLSpanElement>): void {
  for (const span of map.values()) span.remove();
  map.clear();
}
