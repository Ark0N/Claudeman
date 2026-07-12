/**
 * COD-47: full tmux scrollback replay on reload.
 *
 * Under VITEST, TmuxManager no-ops execSync (IS_TEST_MODE), so we can't drive
 * real tmux. Instead we assert the capture-arg construction directly from
 * source (same approach as tmux-capture-color.test.ts): a full-history capture
 * must use `capture-pane -p -e -J -S -<N>` (bounded to the configured history
 * limit, with an explicit exec maxBuffer) and skip the single-screen snapshot
 * repaint, while the visible capture keeps `capture-pane -p -e`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tmux full-history pane capture (COD-47)', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');
  const methodStart = source.indexOf('capturePaneBuffer(muxName: string');
  const methodBody = source.slice(methodStart, methodStart + 4000);

  it('capturePaneBuffer accepts pane-capture options with a fullHistory flag', () => {
    expect(methodStart).toBeGreaterThan(-1);
    // The method signature must carry the opts channel...
    expect(source.slice(methodStart, methodStart + 160)).toContain('PaneCaptureOptions');
    // ...and the body must branch on opts.fullHistory.
    expect(methodBody).toContain('opts?.fullHistory === true');
  });

  it('full-history mode captures scrollback bounded to the configured history limit (-J -S -<N>)', () => {
    // `-S -<N>` (not unbounded `-S -`) keeps tmux from serializing more
    // scrollback than the configured history limit retains; `-J` re-joins
    // lines hard-wrapped at the capture-time pane width.
    expect(source).toContain('capture-pane -p -e -J -S -${historyLines}');
  });

  it('full-history exec sets an explicit maxBuffer (default 1MB would ENOBUFS multi-MB dumps)', () => {
    expect(methodBody).toContain('maxBuffer');
    expect(methodBody).toContain('FULL_HISTORY_CAPTURE_SLACK_BYTES');
  });

  it('still offers the visible single-screen capture for fast tab switches', () => {
    expect(source).toContain("'capture-pane -p -e'");
  });

  it('returns full-history capture as raw scrollback (skips the single-screen repaint)', () => {
    // When fullHistory, return the raw buffer BEFORE the formatPaneSnapshot
    // repaint (which is single-screen and would clip a multi-screen history).
    const earlyReturn = methodBody.indexOf('return normalizeScrollbackEol(buffer);');
    const snapshot = methodBody.indexOf('formatPaneSnapshot(');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(-1);
    expect(earlyReturn).toBeLessThan(snapshot);
  });

  it('captureActivePaneBuffer forwards the capture options', () => {
    const sig = source.indexOf('captureActivePaneBuffer(muxName: string');
    expect(sig).toBeGreaterThan(-1);
    const body = source.slice(sig, sig + 800);
    expect(body).toContain('opts');
    expect(body).toContain('this.capturePaneBuffer(muxName, target, opts)');
  });
});
