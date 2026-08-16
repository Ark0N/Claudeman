/**
 * @fileoverview Unit tests for the TUI's SGR-aware preview helpers
 * (toDisplayLines / clipStyledLine / visibleWidth / padDisplay / stripStyles).
 *
 * The invariants under test are the ones a preview pane fails visibly on: color
 * survives, cursor steering does not, a carriage-return repaint collapses to
 * one line, and no clip ever cuts a code point, a wide character or an escape
 * sequence in half.
 */
import { describe, it, expect } from 'vitest';
import {
  clipStyledLine,
  dropSeveredEscape,
  padDisplay,
  stripStyles,
  toDisplayLines,
  visibleWidth,
  charWidth,
} from '../../src/tui/tui-ansi.js';

const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

describe('toDisplayLines', () => {
  it('splits like String.split, trailing newline included', () => {
    expect(toDisplayLines('a\nb')).toEqual(['a', 'b']);
    expect(toDisplayLines('a\n')).toEqual(['a', '']);
    expect(toDisplayLines('')).toEqual(['']);
  });

  it('preserves SGR and closes an open style at end of line', () => {
    expect(toDisplayLines(`${RED}red${RESET} done`)).toEqual([`${RED}red${RESET} done`]);
    expect(toDisplayLines(`${BOLD}bold`)).toEqual([`${BOLD}bold${RESET}`]);
  });

  it('accumulates SGR state across a line', () => {
    expect(toDisplayLines(`${BOLD}a${RED}b`)).toEqual([`${BOLD}a${RESET}${BOLD}${RED}b${RESET}`]);
  });

  it('strips OSC sequences (BEL and ST terminated)', () => {
    expect(toDisplayLines('\x1b]0;window title\x07text')).toEqual(['text']);
    expect(toDisplayLines('\x1b]0;window title\x1b\\text')).toEqual(['text']);
  });

  it('strips DECSET/DECRST, relative cursor movement and charset selection', () => {
    expect(toDisplayLines('\x1b[?25lvisible\x1b[?25h')).toEqual(['visible']);
    expect(toDisplayLines('a\x1b[5Cb')).toEqual(['ab']);
    expect(toDisplayLines('\x1b(0lqk\x1b(B')).toEqual(['lqk']);
    expect(toDisplayLines('\x1b=app\x1b>')).toEqual(['app']);
  });

  it('splits a row-addressed repaint into lines, which is how an Ink TUI paints', () => {
    // Claude Code emits almost no newlines: without this the whole screen is
    // one line and nothing in the preview is readable.
    expect(toDisplayLines('\x1b[1;1Hfirst\x1b[2;1Hsecond\x1b[3;1Hthird')).toEqual(['', 'first', 'second', 'third']);
    // A jump inside a row is a write position, not a new line.
    expect(toDisplayLines('\x1b[1;1Hab\x1b[1;5Hcd')).toEqual(['', 'ab  cd']);
    expect(toDisplayLines('\x1b[1;1Habcdef\x1b[1;2HXY')).toEqual(['', 'aXYdef']);
    // Both parameters default to 1, so a bare CUP is a fresh row.
    expect(toDisplayLines('a\x1b[Hb')).toEqual(['a', 'b']);
    expect(toDisplayLines('a\x1b[3;1fb')).toEqual(['a', 'b']);
  });

  it('refuses to allocate a line for a column no terminal has', () => {
    const lines = toDisplayLines('\x1b[1;99999Hx');
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(1001);
  });

  it('strips C1 controls and their sequences', () => {
    expect(toDisplayLines('a\x9b31mb')).toEqual(['ab']);
    expect(toDisplayLines('a\x9d0;title\x9cb')).toEqual(['ab']);
  });

  it('drops control characters but keeps tabs as spaces', () => {
    expect(toDisplayLines('a\x07b\x00c')).toEqual(['abc']);
    expect(toDisplayLines('a\tb')).toEqual(['a       b']);
    expect(toDisplayLines('\tx')).toEqual(['        x']);
  });

  it('treats a bare \\r as a return to column zero (spinner repaint)', () => {
    expect(toDisplayLines('abcdef\rXY')).toEqual(['XYcdef']);
    expect(toDisplayLines('long line here\rshort')).toEqual(['shortline here']);
    expect(toDisplayLines('\rWorking 1%\rWorking 99%')).toEqual(['Working 99%']);
  });

  it('keeps \\r\\n as a plain newline', () => {
    expect(toDisplayLines('a\r\nb')).toEqual(['a', 'b']);
  });

  it('carries the overwriting text style, not the overwritten one', () => {
    expect(toDisplayLines(`${RED}aaa\r${RESET}b`)).toEqual([`b${RED}aa${RESET}`]);
  });

  it('keeps whole code points and attaches combining marks to their base', () => {
    expect(toDisplayLines('a\u{1f600}b')).toEqual(['a\u{1f600}b']);
    expect(toDisplayLines('éx')).toEqual(['éx']);
  });

  it('does not throw on truncated or malformed escapes', () => {
    expect(toDisplayLines('abc\x1b')).toEqual(['abc']);
    expect(toDisplayLines('abc\x1b[')).toEqual(['abc']);
    expect(toDisplayLines('abc\x1b[31')).toEqual(['abc']);
    expect(toDisplayLines('\x1b]0;no terminator')).toEqual(['']);
    expect(() => toDisplayLines('\x1b\x1b\x1b[[[m')).not.toThrow();
  });
});

describe('dropSeveredEscape', () => {
  it('drops the remains of a sequence a byte-sliced tail starts inside', () => {
    expect(dropSeveredEscape(';1Hstill here')).toBe('still here');
    expect(dropSeveredEscape('12;3Htext')).toBe('text');
    expect(dropSeveredEscape('31mred')).toBe('red');
  });

  it('leaves ordinary text alone', () => {
    expect(dropSeveredEscape('hello world')).toBe('hello world');
    expect(dropSeveredEscape('\x1b[31mred')).toBe('\x1b[31mred');
    expect(dropSeveredEscape('')).toBe('');
  });
});

describe('visibleWidth', () => {
  it('ignores escape sequences', () => {
    expect(visibleWidth(`${RED}abc${RESET}`)).toBe(3);
    expect(visibleWidth('\x1b]0;title\x07abc')).toBe(3);
  });

  it('counts East Asian wide characters as two columns', () => {
    expect(visibleWidth('中文')).toBe(4);
    expect(visibleWidth('a中b')).toBe(4);
    expect(visibleWidth('ｆｕｌｌ')).toBe(8);
    expect(visibleWidth('\u{1f600}')).toBe(2);
  });

  it('counts combining marks and zero-width joiners as nothing', () => {
    expect(visibleWidth('é')).toBe(1);
    expect(visibleWidth('a‍b')).toBe(2);
    expect(visibleWidth('')).toBe(0);
  });

  it('agrees with charWidth on the boundaries', () => {
    expect(charWidth(0x41)).toBe(1);
    expect(charWidth(0x4e00)).toBe(2);
    expect(charWidth(0x0301)).toBe(0);
    expect(charWidth(0x07)).toBe(0);
  });
});

describe('clipStyledLine', () => {
  it('clips plain text by display width', () => {
    expect(clipStyledLine('abcdef', 3)).toBe('abc');
    expect(clipStyledLine('abc', 10)).toBe('abc');
    expect(clipStyledLine('abc', 0)).toBe('');
    expect(clipStyledLine('abc', -4)).toBe('');
  });

  it('keeps the SGR state active at the clip point and closes it', () => {
    expect(clipStyledLine(`${RED}abcdef${RESET}`, 3)).toBe(`${RED}abc${RESET}`);
    expect(clipStyledLine(`${BOLD}${RED}abcdef`, 2)).toBe(`${BOLD}${RED}ab${RESET}`);
  });

  it('adds no reset when the kept part already reset', () => {
    expect(clipStyledLine(`${RED}ab${RESET}cdef`, 4)).toBe(`${RED}ab${RESET}cd`);
  });

  it('never emits half of a double-width character', () => {
    expect(clipStyledLine('中文abc', 3)).toBe('中');
    expect(clipStyledLine('中文', 4)).toBe('中文');
    expect(visibleWidth(clipStyledLine('中文abc', 3))).toBe(2);
  });

  it('never splits a surrogate pair or a combining sequence', () => {
    expect(clipStyledLine('\u{1f600}x', 2)).toBe('\u{1f600}');
    expect(clipStyledLine('\u{1f600}x', 1)).toBe('');
    expect(clipStyledLine('éx', 1)).toBe('é');
  });

  it('drops escape sequences that sit past the clip point', () => {
    expect(clipStyledLine(`ab${RED}cd`, 2)).toBe('ab');
  });
});

describe('padDisplay', () => {
  it('pads short text and clips long text', () => {
    expect(padDisplay('ab', 5)).toBe('ab   ');
    expect(padDisplay('abcdef', 3)).toBe('abc');
    expect(padDisplay('abc', 3)).toBe('abc');
    expect(padDisplay('abc', 0)).toBe('');
  });

  it('pads to the exact display width around a wide-character boundary', () => {
    expect(visibleWidth(padDisplay('中文', 3))).toBe(3);
    expect(padDisplay('中文', 3)).toBe('中 ');
    expect(visibleWidth(padDisplay(`${RED}中${RESET}x`, 6))).toBe(6);
  });
});

describe('stripStyles', () => {
  it('removes every escape sequence and control character', () => {
    expect(stripStyles(`${RED}red${RESET}`)).toBe('red');
    expect(stripStyles('\x1b]0;t\x07a\x1b[?25lb')).toBe('ab');
    expect(stripStyles('a\u{1f600}中')).toBe('a\u{1f600}中');
  });
});
