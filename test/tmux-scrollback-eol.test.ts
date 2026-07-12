/**
 * COD-138: shell terminal staircase / diagonal replay after reload.
 *
 * Root cause: the full-history tmux capture (`capture-pane -p -e -S -`) returns
 * scrollback lines joined by a BARE `\n` (no `\r`). The visible/tab-switch path
 * repaints each row with an absolute cursor CSI via `formatPaneSnapshot`, so it
 * never staircases — but the full-history path returns the raw buffer. The
 * browser xterm is created with the default `convertEol: false` (correct for the
 * live PTY stream, which carries real `\r\n`), so on a full page reload each
 * bare `\n` drops a row WITHOUT returning the cursor to column 0. Every replayed
 * line then starts one column further right → the diagonal staircase.
 *
 * Fix: normalize the full-history scrollback to `\r\n` line endings before it is
 * shipped to the browser, so a fresh xterm starts every replayed line at col 0.
 *
 * This exercises the pure transform (`normalizeScrollbackEol`). Under VITEST,
 * TmuxManager no-ops execSync (IS_TEST_MODE), so the real capture path can't be
 * driven end-to-end here; the transform is the load-bearing seam.
 */
import { describe, expect, it } from 'vitest';
import { normalizeScrollbackEol } from '../src/tmux-manager.js';

describe('normalizeScrollbackEol (COD-138 staircase fix)', () => {
  it('adds carriage returns so bare-LF scrollback lines start at column 0', () => {
    // tmux capture-pane joins rows with bare \n. Without a preceding \r, xterm
    // (convertEol:false) keeps the column → staircase.
    const raw = 'line one\nline two\nline three';
    expect(normalizeScrollbackEol(raw)).toBe('line one\r\nline two\r\nline three');
  });

  it('every newline in the result is preceded by a carriage return', () => {
    const raw = 'a\nb\nc\nd';
    const out = normalizeScrollbackEol(raw);
    // The staircase invariant: no LF may appear without a CR immediately before it.
    expect(/(?<!\r)\n/.test(out)).toBe(false);
  });

  it('does not double up carriage returns on already-CRLF input', () => {
    const raw = 'line one\r\nline two\r\nline three';
    expect(normalizeScrollbackEol(raw)).toBe('line one\r\nline two\r\nline three');
  });

  it('normalizes a mix of CRLF and bare LF to uniform CRLF', () => {
    const raw = 'crlf\r\nbare\ncrlf2\r\nbare2';
    expect(normalizeScrollbackEol(raw)).toBe('crlf\r\nbare\r\ncrlf2\r\nbare2');
  });

  it('preserves a lone trailing carriage return (in-line overwrite, not an EOL)', () => {
    // A bare \r not followed by \n is a column-0 reset the TUI emitted on purpose;
    // it must survive untouched so we do not corrupt an overwrite.
    const raw = 'progress\rdone';
    expect(normalizeScrollbackEol(raw)).toBe('progress\rdone');
  });

  it('is a no-op on content without newlines', () => {
    expect(normalizeScrollbackEol('single frame')).toBe('single frame');
    expect(normalizeScrollbackEol('')).toBe('');
  });
});
