/**
 * @fileoverview Unit tests for the pure half of the CLI style kit: display-width
 * math, column layout, kv padding, glyph selection, and the spinner's non-TTY
 * behavior. Nothing here needs a terminal.
 */

import { describe, it, expect } from 'vitest';
import {
  GLYPH,
  SPINNER_FRAMES,
  columnWidths,
  confirm,
  displayWidth,
  glyphFor,
  isInteractive,
  kv,
  layoutTable,
  padCell,
  padStyled,
  palette,
  spinner,
  table,
  tint,
  type SpinnerStream,
} from '../src/cli-style.js';

/** Recording stand-in for `process.stderr`. */
function fakeStream(isTTY: boolean): SpinnerStream & { writes: string[] } {
  const writes: string[] = [];
  return {
    isTTY,
    writes,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

describe('displayWidth', () => {
  it('counts printable columns, not bytes', () => {
    expect(displayWidth('tmux')).toBe(4);
    expect(displayWidth('')).toBe(0);
  });

  it('ignores ANSI sequences', () => {
    expect(displayWidth('\x1b[32mok\x1b[39m')).toBe(2);
    expect(displayWidth(palette.ok('ok'))).toBe(2);
  });
});

describe('padCell', () => {
  it('pads to the requested column count', () => {
    expect(padCell('ab', 5)).toBe('ab   ');
    expect(padCell('ab', 5, 'right')).toBe('   ab');
  });

  it('never truncates a cell that is already too wide', () => {
    expect(padCell('Antigravity CLI', 4)).toBe('Antigravity CLI');
  });

  it('pads a colored cell by its printed width', () => {
    const padded = padCell(palette.ok('ok'), 6);
    expect(displayWidth(padded)).toBe(6);
  });
});

describe('padStyled', () => {
  it('keeps the fill outside the paint so trailing space can be trimmed', () => {
    const cell = padStyled('ok', 6, (t) => `<${t}>`);
    expect(cell).toBe('<ok>    ');
    expect(cell.trimEnd()).toBe('<ok>');
  });
});

describe('columnWidths', () => {
  it('measures the widest cell per column', () => {
    expect(
      columnWidths([
        ['tmux', '3.4'],
        ['Antigravity CLI', 'not found'],
      ])
    ).toEqual([15, 9]);
  });

  it('treats missing cells as empty, never as a narrower column', () => {
    expect(columnWidths([['a', 'bbb'], ['a']])).toEqual([1, 3]);
  });
});

describe('layoutTable', () => {
  // The bug this replaces: `padEnd(14)` with a 15-character label ("Antigravity
  // CLI") pushed that row's remaining columns one column right.
  const rows = [
    ['✓', 'tmux', '3.4'],
    ['✓', 'Antigravity CLI', '1.1.12'],
    ['○', 'Pi CLI', 'not found'],
  ];

  it('starts every column at the same offset regardless of cell length', () => {
    const lines = layoutTable(rows, { indent: '  ' });
    expect(lines[0].indexOf('3.4')).toBe(lines[1].indexOf('1.1.12'));
    expect(lines[1].indexOf('1.1.12')).toBe(lines[2].indexOf('not found'));
    // Widest label (15) + indent (2) + glyph column (1) + two gaps.
    expect(lines[1].indexOf('1.1.12')).toBe(2 + 1 + 1 + 15 + 1);
  });

  it('leaves no trailing whitespace on the last column', () => {
    for (const line of layoutTable(rows)) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('honors indent, gap and right alignment', () => {
    const lines = layoutTable(
      [
        ['a', '1'],
        ['bbb', '22'],
      ],
      { indent: '> ', gap: 3, align: ['right'] }
    );
    expect(lines[0]).toBe('>   a   1');
    expect(lines[1]).toBe('> bbb   22');
  });

  it('aligns colored cells by printed width', () => {
    const lines = layoutTable([
      [palette.ok('✓'), palette.emph('tmux'), '3.4'],
      [palette.err('✗'), 'Antigravity CLI', 'not found'],
    ]);
    expect(lines[0].indexOf('3.4')).toBe(lines[1].indexOf('not found'));
  });
});

describe('table', () => {
  it('joins the laid-out rows', () => {
    expect(
      table([
        ['a', 'b'],
        ['cc', 'd'],
      ])
    ).toBe('a  b\ncc d');
  });
});

describe('kv', () => {
  it('indents and appends the colon', () => {
    expect(kv('Status', 'running')).toBe('  Status: running');
  });

  it('aligns a block when a pad width is given', () => {
    const lines = [kv('Daemon pid', '42', 11), kv('Log', '/tmp/web.log', 11)];
    expect(lines[0].indexOf('42')).toBe(lines[1].indexOf('/tmp/web.log'));
  });
});

describe('glyphs', () => {
  it('maps tones to the CLI glyph vocabulary', () => {
    expect(glyphFor('ok')).toBe(GLYPH.ok);
    expect(glyphFor('err')).toBe(GLYPH.fail);
    expect(glyphFor('warn')).toBe(GLYPH.warn);
    expect(glyphFor('idle')).toBe(GLYPH.idle);
    expect(glyphFor('info')).toBe(GLYPH.dot);
  });

  it('tints without changing the printed text', () => {
    expect(displayWidth(tint('err', 'nope'))).toBe(4);
    expect(tint('err', 'nope')).toContain('nope');
  });
});

describe('spinner', () => {
  it('prints the text once and stays silent when the stream is not a TTY', () => {
    const stream = fakeStream(false);
    const handle = spinner('waiting', { stream }).start();
    handle.setText('still waiting');
    handle.stop('done');
    expect(stream.writes).toEqual(['waiting\n']);
  });

  it('animates in place on a TTY and restores the cursor on stop', () => {
    const stream = fakeStream(true);
    const handle = spinner('waiting', { stream, intervalMs: 60_000 }).start();
    expect(stream.writes[0]).toBe('\x1b[?25l');
    expect(stream.writes[1]).toContain(SPINNER_FRAMES[0]);
    expect(stream.writes[1]).toContain('waiting');

    handle.stop();
    const tail = stream.writes.join('');
    expect(tail).toContain('\r\x1b[K');
    expect(tail).toContain('\x1b[?25h');
  });

  it('ignores a second stop', () => {
    const stream = fakeStream(true);
    const handle = spinner('waiting', { stream, intervalMs: 60_000 }).start();
    handle.stop();
    const afterFirst = stream.writes.length;
    handle.stop();
    expect(stream.writes.length).toBe(afterFirst);
  });

  it('does nothing at all when it was never started', () => {
    const stream = fakeStream(true);
    spinner('waiting', { stream }).stop();
    expect(stream.writes).toEqual([]);
  });
});

describe('confirm', () => {
  it('answers no without blocking when stdin is not a TTY', async () => {
    const original = process.stdin.isTTY;
    try {
      process.stdin.isTTY = false;
      expect(isInteractive()).toBe(false);
      await expect(confirm('Reset all Codeman state?')).resolves.toBe(false);
    } finally {
      process.stdin.isTTY = original;
    }
  });
});
