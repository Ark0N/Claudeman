/**
 * COD-47: full tmux scrollback replay on reload.
 *
 * Under VITEST, TmuxManager no-ops execSync (IS_TEST_MODE), so we can't drive
 * real tmux. Instead we assert the capture-arg construction directly from
 * source (same approach as tmux-capture-color.test.ts): a full-history capture
 * must use `capture-pane -p -e -S -` and skip the single-screen snapshot
 * repaint, while the visible capture keeps `capture-pane -p -e`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tmux full-history pane capture (COD-47)', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');

  it('capturePaneBuffer accepts a fullHistory option', () => {
    const sig = source.indexOf('capturePaneBuffer(muxName: string');
    expect(sig).toBeGreaterThan(-1);
    // The method signature must carry the opts.fullHistory channel.
    expect(source.slice(sig, sig + 160)).toContain('fullHistory');
  });

  it('full-history mode requests the entire scrollback with -S -', () => {
    expect(source).toContain('capture-pane -p -e -S -');
  });

  it('still offers the visible single-screen capture for fast tab switches', () => {
    expect(source).toContain("'capture-pane -p -e'");
  });

  it('returns full-history capture as raw scrollback (skips the single-screen repaint)', () => {
    const sig = source.indexOf('capturePaneBuffer(muxName: string');
    const body = source.slice(sig, sig + 2400);
    // When fullHistory, return the raw buffer BEFORE the formatPaneSnapshot
    // repaint (which is single-screen and would clip a multi-screen history).
    const earlyReturn = body.indexOf('if (fullHistory)');
    const snapshot = body.indexOf('formatPaneSnapshot(');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(-1);
    expect(earlyReturn).toBeLessThan(snapshot);
  });

  it('captureActivePaneBuffer forwards the fullHistory option', () => {
    const sig = source.indexOf('captureActivePaneBuffer(muxName: string');
    expect(sig).toBeGreaterThan(-1);
    const body = source.slice(sig, sig + 800);
    expect(body).toContain('opts');
    expect(body).toContain('this.capturePaneBuffer(muxName, target, opts)');
  });
});
