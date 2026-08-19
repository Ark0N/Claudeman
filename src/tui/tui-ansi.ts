/**
 * @fileoverview Pure ANSI helpers for the TUI preview pane.
 *
 * The preview shows the tail of a session's raw terminal stream, which is
 * xterm-bound bytes: SGR colors, cursor jumps, OSC titles, DECSET modes and
 * carriage-return repaints. This is NOT a terminal emulator. It reconstructs a
 * readable, color-preserving tail: SGR survives, everything else that steers a
 * cursor is dropped, and a `\r` is honored as "back to column 0" so a spinner
 * that repaints its line 200 times contributes one line instead of 200.
 *
 * CURSOR ADDRESSING (`ESC [ r ; c H`) is honored too, and it has to be: an Ink
 * TUI like Claude Code repaints by ROW and emits almost no newlines, so
 * dropping those sequences collapses a whole screen into one unreadable line
 * (measured against a live pane, 2026-08-16). A jump to column 1 starts a new
 * display line, a jump within a row moves the write position, which is the same
 * reading `normalizeCapturedFrame` in `web/approval-inbox.ts` takes of the same
 * kind of frame.
 *
 * Two approximations are deliberate, because the alternative is an emulator:
 * a carriage-return overwrite counts CODE POINTS, not display columns (so a
 * repaint over CJK text can land one cell off), and tab stops are counted the
 * same way. Neither can corrupt output, they only shift a repaint's alignment.
 * Absolute ROW numbers are ignored as well: rows arrive in the order they are
 * painted, which for a tail is the order worth reading.
 *
 * @module tui/tui-ansi
 */

const ESC = 0x1b;
const BEL = 0x07;
const ST_C1 = 0x9c;
const DEL = 0x7f;

/** SGR reset, appended by `clipStyledLine` so a clipped line cannot bleed. */
export const SGR_RESET = '\x1b[0m';

const TAB_WIDTH = 8;
/** Cap on remembered SGR sequences per cell, so a pathological stream cannot grow one unboundedly. */
const MAX_ACTIVE_SGR = 32;
/** Ceiling on a display line's cells: a stream may address column 99999, a terminal has none. */
const MAX_LINE_CELLS = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Escape-sequence scanning
// ─────────────────────────────────────────────────────────────────────────────

interface EscapeScan {
  /** Index just past the sequence; `text.length` for a truncated one. */
  next: number;
  /** The sequence itself, only when it is SGR (`CSI ... m`) and therefore kept. */
  sgr?: string;
  /** 1-based column of a cursor-position sequence (`CSI r ; c H` or `f`). */
  column?: number;
}

/** The column a `CSI r ; c H` addresses. Both parameters default to 1. */
function cursorColumn(params: string): number {
  const parts = params.split(';');
  const column = Number.parseInt(parts[1] ?? '', 10);
  return Number.isSafeInteger(column) && column > 0 ? column : 1;
}

/** Scan a CSI body starting at `from` (params, then intermediates, then a final byte). */
function readCsi(text: string, start: number, from: number, keepSgr: boolean): EscapeScan {
  let j = from;
  while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
  while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
  if (j >= text.length) return { next: text.length };
  const next = j + 1;
  if (keepSgr && text[j] === 'm') return { next, sgr: text.slice(start, next) };
  if (keepSgr && (text[j] === 'H' || text[j] === 'f')) {
    return { next, column: cursorColumn(text.slice(from, j)) };
  }
  return { next };
}

/** Scan an OSC/DCS/PM/APC body: everything up to BEL, C1 ST or `ESC \`. */
function readStringSequence(text: string, from: number): number {
  let j = from;
  while (j < text.length) {
    const code = text.charCodeAt(j);
    if (code === BEL || code === ST_C1) return j + 1;
    if (code === ESC && text[j + 1] === '\\') return j + 2;
    j++;
  }
  return text.length;
}

/** Scan the escape sequence starting at `i` (which must be an ESC). */
function readEscape(text: string, i: number): EscapeScan {
  const second = text[i + 1];
  if (second === undefined) return { next: text.length };
  if (second === '[') return readCsi(text, i, i + 2, true);
  if (second === ']' || second === 'P' || second === 'X' || second === '^' || second === '_') {
    return { next: readStringSequence(text, i + 2) };
  }
  // Charset / character-set selection: one more byte belongs to the sequence.
  if (second === '(' || second === ')' || second === '*' || second === '+' || second === '#' || second === '%') {
    return { next: Math.min(text.length, i + 3) };
  }
  return { next: i + 2 };
}

/** Scan a single-byte C1 control at `i` (0x80-0x9f). */
function readC1(text: string, i: number): number {
  const code = text.charCodeAt(i);
  if (code === 0x9b) return readCsi(text, i, i + 1, false).next;
  if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) return readStringSequence(text, i + 1);
  return i + 1;
}

function isC1(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

/** `CSI 0 m`, `CSI m` and `CSI 0;0 m` all mean "back to plain". */
function isSgrReset(seq: string): boolean {
  const params = seq.slice(2, -1);
  return params === '' || /^0(?:;0)*$/.test(params);
}

/**
 * Fold one SGR sequence into the active set. Sequences accumulate in arrival
 * order (a later color simply wins when replayed), a reset clears them, and a
 * repeat moves rather than duplicates.
 */
function applySgr(active: string[], seq: string): string[] {
  if (isSgrReset(seq)) return [];
  const next = active.filter((s) => s !== seq);
  next.push(seq);
  return next.length > MAX_ACTIVE_SGR ? next.slice(-MAX_ACTIVE_SGR) : next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display width
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Combining marks, variation selectors and other zero-advance code points.
 * Pragmatic, not exhaustive: enough that accents and emoji modifiers do not
 * inflate a measured width.
 */
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
];

/**
 * East Asian Wide + Fullwidth, plus the standalone code points UAX #11 marks
 * Wide because they are emoji-presentation by default. This repo ships a zh-CN
 * locale, so CJK correctness is the point; exhaustive Unicode is not required,
 * but the scattered BMP entries below are not optional either: `✋` (U+270B) is
 * one of them and it is a glyph this TUI draws in every waiting row, so getting
 * it wrong mis-pads a column on every frame.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

/** Columns one code point advances the cursor by: 0, 1 or 2. */
export function charWidth(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= DEL && codePoint <= 0x9f)) return 0;
  if (inRanges(codePoint, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

/** Display width of a string: escape sequences take no columns, CJK takes two. */
export function visibleWidth(text: string): number {
  let width = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ESC) {
      i = readEscape(text, i).next;
      continue;
    }
    if (isC1(code)) {
      i = readC1(text, i);
      continue;
    }
    if (code < 0x20 || code === DEL) {
      i++;
      continue;
    }
    const cp = text.codePointAt(i) as number;
    i += cp > 0xffff ? 2 : 1;
    width += charWidth(cp);
  }
  return width;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw stream to display lines
// ─────────────────────────────────────────────────────────────────────────────

/** One printed code point (plus any combining marks) and the SGR state under it. */
interface Cell {
  text: string;
  sgr: string;
}

/**
 * Replay cells into a string, emitting an SGR change only where the state
 * actually changes and closing the line so it is self-contained.
 */
function renderCells(cells: Cell[]): string {
  let out = '';
  let active = '';
  for (const cell of cells) {
    if (cell.sgr !== active) {
      if (active !== '') out += SGR_RESET;
      out += cell.sgr;
      active = cell.sgr;
    }
    out += cell.text;
  }
  if (active !== '') out += SGR_RESET;
  return out;
}

/**
 * Turn a raw terminal stream into display lines: SGR preserved, every other
 * escape sequence dropped, `\r` treated as a return to column 0 (the following
 * text overwrites what is there), tabs expanded, other control characters
 * dropped.
 *
 * Splitting matches `String.split('\n')`, so `''` yields `['']` and a trailing
 * newline yields a trailing empty line.
 */
/**
 * Glyphs a CLI draws as chrome that a plain terminal font very often has no
 * coverage for, and the ASCII that means the same thing.
 *
 * ⚠️ This is NOT a substitute for the glyph TIER. The tier answers "can this
 * terminal do Unicode at all", which is a locale question, and it says yes for
 * exactly the terminals this table exists for: a beta tester's font rendered
 * `·`, `─`, `│` and `▶` perfectly while drawing claude's `❯` prompt and its
 * `⏵⏵` mode marker as empty boxes. Coverage is per-glyph and undetectable from
 * here, so the rare ones are folded and the common ones are left alone.
 *
 * Kept deliberately SHORT. Every entry is a glyph seen rendering as tofu in a
 * real terminal, not a guess, and each maps to the arrow it already looks like.
 */
const PREVIEW_GLYPH_FOLD: ReadonlyMap<string, string> = new Map([
  ['\u276F', '>'], // ❯ heavy right-pointing angle quotation mark (claude, starship, zsh prompts)
  ['\u276E', '<'], // ❮
  ['\u23F5', '>'], // ⏵ black medium right-pointing triangle (claude's bypass-permissions marker)
  ['\u23F4', '<'], // ⏴
  ['\u23F6', '^'], // ⏶
  ['\u23F7', 'v'], // ⏷
  ['\u2771', '>'], // ❱
  ['\u2770', '<'], // ❰
  // claude's own working/done spinner cycles through these, and they are the
  // same sparse-Dingbats class as `❯`: the animated line is exactly where a
  // reader looks, so tofu there is the most visible kind.
  ['\u2722', '*'], // ✢
  ['\u2733', '*'], // ✳
  ['\u2217', '*'], // ∗
  ['\u273B', '*'], // ✻
  ['\u273D', '*'], // ✽
  ['\u2734', '*'], // ✴
  ['\u26A0', '!'], // ⚠ Misc Symbols, and emoji-presentation on many terminals
]);

/**
 * Replace preview glyphs a plain font is likely to draw as an empty box.
 *
 * Applied to ANOTHER program's output on its way into the preview pane, never
 * to the TUI's own chrome, and skipped at the `nerd` tier where the user has
 * declared a font that can draw anything.
 */
export function foldPreviewGlyphs(line: string): string {
  let out = '';
  for (const char of line) out += PREVIEW_GLYPH_FOLD.get(char) ?? char;
  return out;
}

export function toDisplayLines(raw: string): string[] {
  const lines: string[] = [];
  let cells: Cell[] = [];
  let col = 0;
  let active: string[] = [];
  let sgr = '';

  const endLine = (): void => {
    lines.push(renderCells(cells));
    cells = [];
    col = 0;
  };

  /**
   * Park the write position at a column, padding the gap so the cell array
   * never grows a hole (a hole would crash the replay, and a stream can address
   * any column it likes).
   */
  const moveTo = (column: number): void => {
    const target = Math.min(column, MAX_LINE_CELLS);
    while (cells.length < target) cells.push({ text: ' ', sgr: '' });
    col = target;
  };

  const write = (text: string, width: number): void => {
    if (width === 0) {
      // A combining mark belongs to the character it follows, never to a cell
      // of its own: keeping them together is what stops a clip from severing
      // an accent from its base letter.
      if (col > 0) cells[col - 1].text += text;
      return;
    }
    cells[col] = { text, sgr };
    col++;
  };

  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === ESC) {
      const scan = readEscape(raw, i);
      if (scan.sgr !== undefined) {
        active = applySgr(active, scan.sgr);
        sgr = active.join('');
      } else if (scan.column !== undefined) {
        // Column 1 is a fresh row, which is the only thing a repainting TUI
        // gives us to split lines on.
        if (scan.column <= 1) endLine();
        else moveTo(scan.column - 1);
      }
      i = scan.next;
      continue;
    }
    if (isC1(code)) {
      i = readC1(raw, i);
      continue;
    }
    if (code === 0x0a) {
      endLine();
      i++;
      continue;
    }
    if (code === 0x0d) {
      col = 0;
      i++;
      continue;
    }
    if (code === 0x09) {
      const stop = TAB_WIDTH - (col % TAB_WIDTH);
      for (let n = 0; n < stop; n++) write(' ', 1);
      i++;
      continue;
    }
    if (code < 0x20 || code === DEL) {
      i++;
      continue;
    }
    const cp = raw.codePointAt(i) as number;
    const text = String.fromCodePoint(cp);
    i += text.length;
    write(text, charWidth(cp));
  }
  endLine();
  return lines;
}

/**
 * The parameter bytes plus final byte of a CSI sequence whose `ESC [` was cut
 * off. Requires at least one parameter byte, so ordinary text starting with a
 * letter is never mistaken for one.
 */
const SEVERED_CSI = /^[0-9;?:<>=]+[A-Za-z]/;

/**
 * Drop the remains of an escape sequence a byte-sliced tail begins in the
 * middle of.
 *
 * `GET /api/sessions/:id/terminal?tail=N` cuts the buffer at a byte offset, so
 * a tail can start inside `ESC [ 12 ; 1 H` and hand the parser `;1H` as text,
 * which is exactly what it then prints (observed against a live Claude pane).
 * Only the severed head is dropped, never a whole line.
 */
export function dropSeveredEscape(raw: string): string {
  return raw.replace(SEVERED_CSI, '');
}

/**
 * Drop every escape sequence, keeping the visible text. Needed because the
 * preview carries the session's OWN colors: under NO_COLOR the frame must not
 * smuggle them back in.
 */
export function stripStyles(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ESC) {
      i = readEscape(text, i).next;
      continue;
    }
    if (isC1(code)) {
      i = readC1(text, i);
      continue;
    }
    if (code < 0x20 || code === DEL) {
      i++;
      continue;
    }
    const cp = text.codePointAt(i) as number;
    const size = cp > 0xffff ? 2 : 1;
    out += text.slice(i, i + size);
    i += size;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clipping and padding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clip a line that carries SGR to `width` display columns, keeping the styling
 * that is active up to the clip point and closing it with a reset. Never splits
 * a code point, a combining sequence or an escape sequence, and never emits
 * half of a double-width character (the cell is dropped instead).
 */
export function clipStyledLine(line: string, width: number): string {
  if (width <= 0) return '';
  let out = '';
  let used = 0;
  let active: string[] = [];
  // Styles are emitted lazily, right before the character that wears them, so a
  // sequence sitting exactly on the clip boundary is not carried into a line it
  // no longer styles.
  let emitted = '';
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code === ESC) {
      const scan = readEscape(line, i);
      if (scan.sgr !== undefined) active = applySgr(active, scan.sgr);
      i = scan.next;
      continue;
    }
    if (isC1(code)) {
      i = readC1(line, i);
      continue;
    }
    if (code < 0x20 || code === DEL) {
      i++;
      continue;
    }
    const cp = line.codePointAt(i) as number;
    const w = charWidth(cp);
    if (used + w > width) break;
    const style = active.join('');
    if (style !== emitted) {
      if (emitted !== '') out += SGR_RESET;
      out += style;
      emitted = style;
    }
    out += String.fromCodePoint(cp);
    used += w;
    i += cp > 0xffff ? 2 : 1;
  }
  return emitted !== '' ? out + SGR_RESET : out;
}

/**
 * Pad or clip to exactly `width` display columns. A clip that lands on a
 * double-width boundary leaves one column short, so the pad runs after it.
 */
export function padDisplay(text: string, width: number): string {
  if (width <= 0) return '';
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w < width) return text + ' '.repeat(width - w);
  const clipped = clipStyledLine(text, width);
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}
