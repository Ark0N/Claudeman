import type { RenderParams, FontStyle, XtermTerminal } from './types.js';

// ─── CJK / fullwidth character width detection ───────────────────────

/**
 * Get visual cell width of a single character.
 * CJK wide characters occupy 2 cells, others occupy 1.
 * Prefers the terminal's Unicode addon when available.
 */
export function charCellWidth(terminal: XtermTerminal | null | undefined, ch: string): number {
  if (terminal?.unicode?.getStringCellWidth) {
    return terminal.unicode.getStringCellWidth(ch);
  }
  // Fallback: detect CJK wide characters by Unicode range
  const code = ch.codePointAt(0);
  if (
    code !== undefined &&
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo
      (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals, Kangxi, Ideographic
      (code >= 0x3040 && code <= 0x33bf) || // Hiragana, Katakana, Bopomofo, CJK Compat
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ext A
      (code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified, Yi
      (code >= 0xa960 && code <= 0xa97c) || // Hangul Jamo Extended-A
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compat Forms
      (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
      (code >= 0x1f000 && code <= 0x1fbff) || // Mahjong, Domino, Emoji
      (code >= 0x20000 && code <= 0x2ffff) || // CJK Unified Ext B-F
      (code >= 0x30000 && code <= 0x3ffff)) // CJK Unified Ext G+
  )
    return 2;
  return 1;
}

/**
 * Get visual cell width of a string (sum of all character widths).
 */
export function stringCellWidth(terminal: XtermTerminal | null | undefined, str: string): number {
  let w = 0;
  for (const ch of str) w += charCellWidth(terminal, ch);
  return w;
}

// ─── Overlay rendering ────────────────────────────────────────────────

/**
 * Render the overlay content into the container element.
 *
 * Creates per-character `<span>` elements positioned on an exact grid
 * matching xterm.js's canvas renderer. This avoids sub-pixel drift that
 * occurs with normal DOM text flow.
 *
 * CJK wide characters are rendered with double-width spans.
 */
export function renderOverlay(container: HTMLDivElement, params: RenderParams): void {
  const {
    lines,
    startCol,
    totalCols,
    cellW,
    cellH,
    charTop,
    charHeight,
    promptRow,
    font,
    showCursor,
    cursorColor,
    terminal,
  } = params;

  // Position container at prompt row.
  container.style.left = '0px';
  container.style.top = promptRow * cellH + 'px';

  // Clear and rebuild (typically 1-3 line divs, negligible cost)
  container.innerHTML = '';
  const fullWidthPx = totalCols * cellW;

  for (let i = 0; i < lines.length; i++) {
    const leftPx = i === 0 ? startCol * cellW : 0;
    const widthPx = i === 0 ? fullWidthPx - leftPx : fullWidthPx;
    const topPx = i * cellH;
    const lineEl = makeLine(lines[i], leftPx, topPx, widthPx, cellH, cellW, charTop, charHeight, font, terminal);
    container.appendChild(lineEl);
  }

  // Block cursor at end of last line (use visual width for CJK support)
  if (showCursor) {
    const lastLine = lines[lines.length - 1];
    const lastLineLeft = lines.length === 1 ? startCol : 0;
    const cursorCol = lastLineLeft + stringCellWidth(terminal, lastLine);
    if (cursorCol < totalCols) {
      const cursor = document.createElement('span');
      cursor.style.cssText = 'position:absolute;display:inline-block';
      cursor.style.left = cursorCol * cellW + 'px';
      cursor.style.top = (lines.length - 1) * cellH + 'px';
      cursor.style.width = cellW + 'px';
      cursor.style.height = cellH + 'px';
      cursor.style.backgroundColor = cursorColor;
      container.appendChild(cursor);
    }
  }

  container.style.display = '';
}

/**
 * Create a styled line `<div>` with per-character grid positioning.
 *
 * Each character gets its own `<span>` positioned by visual column offset.
 * CJK wide characters occupy 2 cell widths.
 */
function makeLine(
  text: string,
  leftPx: number,
  topPx: number,
  widthPx: number,
  cellH: number,
  cellW: number,
  charTop: number,
  charHeight: number,
  font: FontStyle,
  terminal?: XtermTerminal | null
): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;pointer-events:none';
  el.style.backgroundColor = font.backgroundColor;
  el.style.left = leftPx + 'px';
  el.style.top = topPx + 'px';
  el.style.width = widthPx + 'px';
  // Extend background 1px past cell boundary to cover the compositing
  // seam between the overlay layer (z-index:7) and the canvas layer below.
  el.style.height = cellH + 1 + 'px';

  // CJK wide chars occupy 2 cells — position by visual column offset
  let colOffset = 0;
  for (const ch of text) {
    const cw = charCellWidth(terminal, ch);
    const span = document.createElement('span');
    // No ligatures — canvas renders each glyph independently.
    span.style.cssText =
      'position:absolute;display:inline-block;text-align:center;pointer-events:none;' +
      "font-feature-settings:'liga' 0,'calt' 0";
    span.style.left = colOffset * cellW + 'px';
    span.style.top = '0px';
    span.style.width = cw * cellW + 'px';
    span.style.height = cellH + 'px';
    span.style.lineHeight = cellH + 'px';
    span.style.fontFamily = font.fontFamily;
    span.style.fontSize = font.fontSize;
    span.style.fontWeight = font.fontWeight;
    span.style.color = font.color;
    if (font.letterSpacing) span.style.letterSpacing = font.letterSpacing;
    span.textContent = ch;
    el.appendChild(span);
    colOffset += cw;
  }

  return el;
}
