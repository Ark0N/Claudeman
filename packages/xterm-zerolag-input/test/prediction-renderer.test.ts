/**
 * @vitest-environment jsdom
 *
 * prediction-renderer unit tests: span geometry math, seam-cover height,
 * ligature suppression, incremental add/remove keyed by seq, and geometry
 * stability under a non-1 devicePixelRatio (all dims are CSS px).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addPredictionSpan, clearAllSpans, removePredictionSpan } from '../src/prediction-renderer.js';
import type { CellDimensions, FontStyle } from '../src/types.js';

const dims: CellDimensions = { width: 9, height: 18, charTop: 1, charHeight: 16 };
const font: FontStyle = {
  fontFamily: 'monospace',
  fontSize: '14px',
  fontWeight: 'normal',
  color: '#e0e0e0',
  backgroundColor: '#101010',
  letterSpacing: '0.5px',
};

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function span(container: HTMLElement, map: Map<number, HTMLSpanElement>, over: Record<string, unknown> = {}) {
  addPredictionSpan(container, map, {
    seq: 1,
    row: 3,
    col: 5,
    char: 'x',
    width: 1,
    dims,
    font,
    underline: false,
    ...over,
  } as never);
  return map.get((over.seq as number) ?? 1)!;
}

describe('prediction-renderer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('positions a width-1 span on the exact cell grid', () => {
    const map = new Map<number, HTMLSpanElement>();
    const s = span(makeContainer(), map);
    expect(s.style.left).toBe(`${5 * 9}px`);
    expect(s.style.top).toBe(`${3 * 18}px`);
    expect(s.style.width).toBe(`${9}px`);
    expect(s.textContent).toBe('x');
  });

  it('positions a width-2 span across two cells', () => {
    const map = new Map<number, HTMLSpanElement>();
    const s = span(makeContainer(), map, { char: '你', width: 2 });
    expect(s.style.width).toBe(`${2 * 9}px`);
  });

  it('covers the row seam: height is cellH+1 with line-height cellH', () => {
    const map = new Map<number, HTMLSpanElement>();
    const s = span(makeContainer(), map);
    expect(s.style.height).toBe(`${18 + 1}px`);
    expect(s.style.lineHeight).toBe('18px');
  });

  it('disables ligatures and pointer events, applies font + letter-spacing', () => {
    const map = new Map<number, HTMLSpanElement>();
    const s = span(makeContainer(), map);
    expect(s.style.cssText).toContain("'liga' 0");
    expect(s.style.cssText).toContain("'calt' 0");
    expect(s.style.pointerEvents).toBe('none');
    expect(s.style.fontFamily).toBe('monospace');
    expect(s.style.letterSpacing).toBe('0.5px');
    expect(s.style.textAlign).toBe('center');
  });

  it('paints an opaque background over only its own cells', () => {
    const map = new Map<number, HTMLSpanElement>();
    const s = span(makeContainer(), map);
    expect(['#101010', 'rgb(16, 16, 16)']).toContain(s.style.backgroundColor);
    // Background is bounded by the span's own width, never a full row
    expect(s.style.width).toBe('9px');
  });

  it('underline renders only when requested', () => {
    const map = new Map<number, HTMLSpanElement>();
    const container = makeContainer();
    const plain = span(container, map, { seq: 1 });
    const lined = span(container, map, { seq: 2, underline: true });
    expect(plain.style.textDecoration).toBe('');
    expect(lined.style.textDecoration).toBe('underline');
  });

  it('adds and removes incrementally, keyed by seq', () => {
    const map = new Map<number, HTMLSpanElement>();
    const container = makeContainer();
    span(container, map, { seq: 1 });
    span(container, map, { seq: 2, col: 6 });
    span(container, map, { seq: 3, col: 7 });
    expect(container.children).toHaveLength(3);

    removePredictionSpan(map, 2);
    expect(container.children).toHaveLength(2);
    expect(map.has(2)).toBe(false);
    expect(map.has(1)).toBe(true);
    expect(map.has(3)).toBe(true);

    removePredictionSpan(map, 999); // unknown seq: no-op
    expect(container.children).toHaveLength(2);
  });

  it('clearAllSpans empties both the DOM and the map', () => {
    const map = new Map<number, HTMLSpanElement>();
    const container = makeContainer();
    span(container, map, { seq: 1 });
    span(container, map, { seq: 2, col: 6 });
    clearAllSpans(map);
    expect(container.children).toHaveLength(0);
    expect(map.size).toBe(0);
  });

  it('geometry is stable under devicePixelRatio 2 (dims are CSS px)', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const map = new Map<number, HTMLSpanElement>();
    const s = span(makeContainer(), map);
    expect(s.style.left).toBe(`${5 * 9}px`);
    expect(s.style.top).toBe(`${3 * 18}px`);
    expect(s.style.width).toBe('9px');
  });
});
