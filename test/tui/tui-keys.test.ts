/**
 * @fileoverview Unit tests for the raw-mode key parser.
 *
 * The two failure modes that matter are covered explicitly: a sequence that
 * arrives split across reads must decode identically at EVERY split position
 * (a terminal is free to break a chunk anywhere), and an unknown sequence must
 * be swallowed rather than leaked as typed text.
 */
import { describe, it, expect } from 'vitest';
import { createKeyParser, type TuiInputEvent } from '../../src/tui/tui-keys.js';

/** Feed a whole sequence in one go. */
function decode(input: string | Buffer): TuiInputEvent[] {
  return createKeyParser().feed(input);
}

/** Feed the same bytes split at `at`, so a torn read must not change the result. */
function decodeSplit(bytes: Buffer, at: number): TuiInputEvent[] {
  const parser = createKeyParser();
  return [...parser.feed(bytes.subarray(0, at)), ...parser.feed(bytes.subarray(at))];
}

describe('printable input', () => {
  it('emits one event per code point', () => {
    expect(decode('ab')).toEqual([
      { type: 'char', value: 'a' },
      { type: 'char', value: 'b' },
    ]);
  });

  it('decodes multi-byte UTF-8', () => {
    expect(decode('é中')).toEqual([
      { type: 'char', value: 'é' },
      { type: 'char', value: '中' },
    ]);
    expect(decode('\u{1f600}')).toEqual([{ type: 'char', value: '\u{1f600}' }]);
  });

  it('holds a UTF-8 character split across chunks', () => {
    const bytes = Buffer.from('中', 'utf8');
    const parser = createKeyParser();
    expect(parser.feed(bytes.subarray(0, 1))).toEqual([]);
    expect(parser.pending()).toBe(1);
    expect(parser.feed(bytes.subarray(1, 2))).toEqual([]);
    expect(parser.feed(bytes.subarray(2))).toEqual([{ type: 'char', value: '中' }]);
    expect(parser.pending()).toBe(0);
  });

  it('decodes a 4-byte character at every split position', () => {
    const bytes = Buffer.from('\u{1f600}', 'utf8');
    for (let at = 0; at <= bytes.length; at++) {
      expect(decodeSplit(bytes, at)).toEqual([{ type: 'char', value: '\u{1f600}' }]);
    }
  });

  it('swallows invalid UTF-8 rather than typing a replacement character', () => {
    expect(decode(Buffer.from([0xc3, 0x28]))).toEqual([{ type: 'char', value: '(' }]);
  });
});

describe('control keys', () => {
  it('maps Enter, Tab and Backspace', () => {
    expect(decode('\r')).toEqual([{ type: 'enter' }]);
    expect(decode('\n')).toEqual([{ type: 'enter' }]);
    expect(decode('\t')).toEqual([{ type: 'tab' }]);
    expect(decode('\x7f')).toEqual([{ type: 'backspace' }]);
    expect(decode('\x08')).toEqual([{ type: 'backspace' }]);
  });

  it('maps Ctrl+letter, keeping Ctrl+I and Ctrl+M as Tab and Enter', () => {
    expect(decode('\x03')).toEqual([{ type: 'ctrl', key: 'c' }]);
    expect(decode('\x17')).toEqual([{ type: 'ctrl', key: 'w' }]);
    expect(decode('\x01')).toEqual([{ type: 'ctrl', key: 'a' }]);
    expect(decode('\x09')).toEqual([{ type: 'tab' }]);
    expect(decode('\x0d')).toEqual([{ type: 'enter' }]);
    expect(decode('\x00')).toEqual([{ type: 'ctrl', key: '@' }]);
  });
});

describe('escape sequences', () => {
  it('decodes CSI arrows, Home and End', () => {
    expect(decode('\x1b[A')).toEqual([{ type: 'key', name: 'up' }]);
    expect(decode('\x1b[B')).toEqual([{ type: 'key', name: 'down' }]);
    expect(decode('\x1b[C')).toEqual([{ type: 'key', name: 'right' }]);
    expect(decode('\x1b[D')).toEqual([{ type: 'key', name: 'left' }]);
    expect(decode('\x1b[H')).toEqual([{ type: 'key', name: 'home' }]);
    expect(decode('\x1b[F')).toEqual([{ type: 'key', name: 'end' }]);
  });

  it('decodes the SS3 variants application-cursor mode sends', () => {
    expect(decode('\x1bOA')).toEqual([{ type: 'key', name: 'up' }]);
    expect(decode('\x1bOD')).toEqual([{ type: 'key', name: 'left' }]);
    expect(decode('\x1bOH')).toEqual([{ type: 'key', name: 'home' }]);
    expect(decode('\x1bOP')).toEqual([]);
  });

  it('decodes the numbered CSI keys', () => {
    expect(decode('\x1b[2~')).toEqual([{ type: 'key', name: 'insert' }]);
    expect(decode('\x1b[3~')).toEqual([{ type: 'key', name: 'delete' }]);
    expect(decode('\x1b[5~')).toEqual([{ type: 'key', name: 'pageup' }]);
    expect(decode('\x1b[6~')).toEqual([{ type: 'key', name: 'pagedown' }]);
    expect(decode('\x1b[1~')).toEqual([{ type: 'key', name: 'home' }]);
    expect(decode('\x1b[4~')).toEqual([{ type: 'key', name: 'end' }]);
  });

  it('ignores modifiers on an arrow rather than dropping the key', () => {
    expect(decode('\x1b[1;5A')).toEqual([{ type: 'key', name: 'up' }]);
  });

  it('swallows unknown sequences instead of leaking them as text', () => {
    expect(decode('\x1b[Z')).toEqual([]);
    expect(decode('\x1b[999~')).toEqual([]);
    expect(decode('\x1b[?1049h')).toEqual([]);
    expect(decode('\x1b[200~hi\x1b[201~')).toEqual([
      { type: 'char', value: 'h' },
      { type: 'char', value: 'i' },
    ]);
  });

  it('consumes the payload of an X10 mouse report', () => {
    expect(decode('\x1b[M !!x')).toEqual([{ type: 'char', value: 'x' }]);
  });

  it('reads ESC followed by a letter as the Alt chord it is', () => {
    // Changed deliberately: this used to decode as Escape + `x`, which made
    // Alt+N unreachable. A lone Esc is still separable because it is HELD until
    // the caller's timer flushes it (see the 'lone escape' suite).
    expect(decode('\x1bx')).toEqual([{ type: 'alt', value: 'x' }]);
  });
});

describe('lone escape', () => {
  it('holds a trailing ESC until the caller flushes', () => {
    const parser = createKeyParser();
    expect(parser.feed('\x1b')).toEqual([]);
    expect(parser.pending()).toBe(1);
    expect(parser.flush()).toEqual([{ type: 'escape' }]);
    expect(parser.pending()).toBe(0);
  });

  it('completes the sequence instead when the rest arrives', () => {
    const parser = createKeyParser();
    expect(parser.feed('\x1b')).toEqual([]);
    expect(parser.feed('[A')).toEqual([{ type: 'key', name: 'up' }]);
    expect(parser.flush()).toEqual([]);
  });

  it('turns a half-typed sequence into Escape plus its characters', () => {
    const parser = createKeyParser();
    expect(parser.feed('\x1b[')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: 'escape' }, { type: 'char', value: '[' }]);
  });
});

describe('SGR mouse', () => {
  it('decodes press and release with 1-based coordinates', () => {
    expect(decode('\x1b[<0;12;34M')).toEqual([{ type: 'mouse', kind: 'press', x: 12, y: 34, button: 0 }]);
    expect(decode('\x1b[<0;12;34m')).toEqual([{ type: 'mouse', kind: 'release', x: 12, y: 34, button: 0 }]);
  });

  it('decodes the wheel', () => {
    expect(decode('\x1b[<64;3;4M')).toEqual([{ type: 'mouse', kind: 'wheel-up', x: 3, y: 4, button: 64 }]);
    expect(decode('\x1b[<65;3;4M')).toEqual([{ type: 'mouse', kind: 'wheel-down', x: 3, y: 4, button: 65 }]);
  });

  it('swallows drag/motion reports', () => {
    expect(decode('\x1b[<32;5;6M')).toEqual([]);
  });

  it('swallows a malformed report', () => {
    expect(decode('\x1b[<0;12M')).toEqual([]);
  });
});

describe('torn reads', () => {
  const cases: Array<[string, TuiInputEvent[]]> = [
    ['\x1b[A', [{ type: 'key', name: 'up' }]],
    ['\x1b[6~', [{ type: 'key', name: 'pagedown' }]],
    ['\x1b[<64;3;4M', [{ type: 'mouse', kind: 'wheel-up', x: 3, y: 4, button: 64 }]],
    ['\x1bOB', [{ type: 'key', name: 'down' }]],
    ['\x1b[1;5C', [{ type: 'key', name: 'right' }]],
  ];

  for (const [sequence, expected] of cases) {
    it(`decodes ${JSON.stringify(sequence)} at every split position`, () => {
      const bytes = Buffer.from(sequence, 'utf8');
      for (let at = 0; at <= bytes.length; at++) {
        expect(decodeSplit(bytes, at)).toEqual(expected);
      }
    });
  }

  it('decodes a mixed burst split anywhere', () => {
    const bytes = Buffer.from('a\x1b[Bx\r\x1b[<65;1;1M', 'utf8');
    const expected: TuiInputEvent[] = [
      { type: 'char', value: 'a' },
      { type: 'key', name: 'down' },
      { type: 'char', value: 'x' },
      { type: 'enter' },
      { type: 'mouse', kind: 'wheel-down', x: 1, y: 1, button: 65 },
    ];
    for (let at = 0; at <= bytes.length; at++) {
      expect(decodeSplit(bytes, at)).toEqual(expected);
    }
  });

  it('drops a garbage burst whole instead of wedging or leaking it', () => {
    const parser = createKeyParser();
    expect(parser.feed(`\x1b[${'1'.repeat(200)}`)).toEqual([]);
    expect(parser.pending()).toBe(0);
    expect(parser.feed('\x1b[A')).toEqual([{ type: 'key', name: 'up' }]);
  });
});

describe('Alt chords', () => {
  it('reads ESC + a printable character in one read as Alt+that key', () => {
    expect(decode('\x1b1')).toEqual([{ type: 'alt', value: '1' }]);
    expect(decode('\x1bk')).toEqual([{ type: 'alt', value: 'k' }]);
  });

  it('never steals the sequence introducers, or every arrow key would break', () => {
    // ESC [ is CSI and ESC O is SS3: both are Up, not Alt+[ / Alt+O.
    expect(decode('\x1b[A')).toEqual([{ type: 'key', name: 'up' }]);
    expect(decode('\x1bOA')).toEqual([{ type: 'key', name: 'up' }]);
  });

  it('leaves ESC ] alone, so a terminal colour reply is never read as a chord', () => {
    // OSC introducer: decoded as Escape then `]`, exactly as before.
    expect(decode('\x1b]')).toEqual([{ type: 'escape' }, { type: 'char', value: ']' }]);
  });

  it('keeps a lone ESC held, which is what separates it from a chord', () => {
    const parser = createKeyParser();
    expect(parser.feed('\x1b')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: 'escape' }]);
  });

  it('decodes a chord torn across two reads as Escape then the character', () => {
    // The unavoidable ambiguity, resolved the standard way: same read = chord.
    const parser = createKeyParser();
    expect(parser.feed('\x1b')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: 'escape' }]);
    expect(parser.feed('1')).toEqual([{ type: 'char', value: '1' }]);
  });
});
