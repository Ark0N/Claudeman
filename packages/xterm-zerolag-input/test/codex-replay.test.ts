/**
 * @vitest-environment jsdom
 *
 * Layer 2 (the load-bearing suite): the REAL algorithm against the REAL xterm
 * parser, fed by fixtures recorded from real codex 0.147 through the
 * production pipeline (tmux + the codex full strip). See
 * scripts/dev/record-codex-frames.mjs in the consuming repo.
 *
 * Every replay ends with the convergence invariant: predictions never outlive
 * their run (outstanding 0, span container empty).
 */
import { describe, expect, it } from 'vitest';
import { PredictiveEchoAddon } from '../src/predictive-echo-addon.js';
import {
  CELL_H,
  CELL_W,
  classifyPredictInput,
  codexComposerGate,
  createReplayTerminal,
  loadFixture,
  type ReplayTerminal,
} from './replay-helpers.js';

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface KeyEvent {
  key: string;
  kind: ReturnType<typeof classifyPredictInput>;
  painted: boolean;
  spansAfter: number;
}

function assertSpansInGrid(rt: ReplayTerminal) {
  for (const s of rt.spans()) {
    const left = parseFloat(s.style.left);
    const width = parseFloat(s.style.width);
    const top = parseFloat(s.style.top);
    expect(left + width).toBeLessThanOrEqual(rt.hybrid.cols * CELL_W);
    expect(top).toBeLessThanOrEqual((rt.hybrid.rows - 1) * CELL_H);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  }
}

async function replay(name: string) {
  const { meta, lines } = loadFixture(name);
  const rt = createReplayTerminal(meta.cols, meta.rows);
  const addon = new PredictiveEchoAddon({ predictWhen: codexComposerGate });
  addon.activate(rt.hybrid);

  const events: KeyEvent[] = [];
  for (const line of lines) {
    if (line.keyAt) {
      const kind = classifyPredictInput(line.data);
      let painted = false;
      if (kind === 'char') painted = addon.predictChar(line.data);
      else if (kind === 'backspace') addon.predictBackspace();
      else addon.clearPredictions(); // 'clear' AND 'text', like the terminal-ui hook
      // Span/record parity and grid bounds hold at every step
      expect(rt.spanCount()).toBe(addon.state.outstanding);
      assertSpansInGrid(rt);
      events.push({ key: line.data, kind, painted, spansAfter: rt.spanCount() });
    } else {
      await rt.write(line.data);
      await flushMicrotasks();
    }
  }
  return { rt, addon, events, meta };
}

/** Convergence invariant: after the last chunk + reconcile (+ TTL if needed),
 *  nothing outlives the run. */
async function converge(rt: ReplayTerminal, addon: PredictiveEchoAddon) {
  addon.reconcile();
  if (addon.state.outstanding > 0) {
    await sleep(1100); // ttlMs default
    addon.reconcile();
  }
  expect(addon.state.outstanding).toBe(0);
  expect(rt.spanCount()).toBe(0);
}

describe('codex replay', () => {
  it('type-hello: all 5 predictions confirm, zero drops, composer converges', async () => {
    const { rt, addon, events } = await replay('type-hello');
    const chars = events.filter((e) => e.kind === 'char');
    expect(chars).toHaveLength(5);
    expect(chars.every((e) => e.painted)).toBe(true);
    await converge(rt, addon);
    expect(addon.state.confirmedTotal).toBe(5);
    expect(addon.state.droppedTotal).toBe(0);
    expect(rt.cursorRowText()).toBe('› hello');
    addon.dispose();
    rt.cleanup();
  }, 15000);

  it('slash-picker: "/" and filter chars confirm; no ghosts while picker rows redraw', async () => {
    const { rt, addon, events } = await replay('slash-picker');
    const chars = events.filter((e) => e.kind === 'char');
    expect(chars.map((e) => e.key)).toEqual(['/', 'm', 'o']);
    expect(chars.every((e) => e.painted)).toBe(true);
    await converge(rt, addon);
    expect(addon.state.confirmedTotal).toBe(3);
    expect(addon.state.droppedTotal).toBe(0);
    addon.dispose();
    rt.cleanup();
  }, 15000);

  it('wrap: predictions stay inside the grid, continuation rows fall back to real echo, buffer converges', async () => {
    const { rt, addon, events } = await replay('wrap');
    // The gate goes false once the cursor is on a wrapped continuation row
    // (2-space indent, no "› "): a tail of keystrokes must be suppressed.
    const chars = events.filter((e) => e.kind === 'char');
    expect(chars.some((e) => !e.painted)).toBe(true);
    expect(chars.some((e) => e.painted)).toBe(true);
    await converge(rt, addon);
    // The composer content is exactly what was typed (word-wrapped)
    const b = rt.term.buffer.active;
    const cursorRow = b.cursorY;
    expect(rt.rowText(cursorRow).trim()).toBe('this line twice over');
    expect(rt.rowText(cursorRow - 1)).toMatch(/^› the quick brown fox/);
    addon.dispose();
    rt.cleanup();
  }, 15000);

  it('streaming-burst: typed predictions confirm; the re-rendered composer keeps its signature', async () => {
    const { rt, addon, events } = await replay('streaming-burst');
    const chars = events.filter((e) => e.kind === 'char');
    expect(chars).toHaveLength(5); // "hello" (the \r is kind 'clear')
    await converge(rt, addon);
    expect(addon.state.confirmedTotal).toBe(5);
    expect(addon.state.droppedTotal).toBe(0);
    // After the 401 burst codex re-renders a fresh composer at the cursor
    expect(rt.cursorRowText()).toMatch(/^› /);
    addon.dispose();
    rt.cleanup();
  }, 15000);

  it('paste-bracketed: typed chars confirm, the paste clears predictions, content intact', async () => {
    const { rt, addon, events } = await replay('paste-bracketed');
    const paste = events.find((e) => e.key.startsWith('\x1b[200~'))!;
    expect(paste.kind).toBe('clear');
    expect(paste.spansAfter).toBe(0);
    await converge(rt, addon);
    expect(addon.state.confirmedTotal).toBe(2); // 'a', 'b'
    expect(rt.cursorRowText()).toContain('abXYZpasted');
    addon.dispose();
    rt.cleanup();
  }, 15000);

  it('trust-modal: the predictWhen gate paints ZERO spans on the modal (ghost eliminator)', async () => {
    const { rt, addon, events } = await replay('trust-modal');
    const x = events.find((e) => e.key === 'x')!;
    expect(x.painted).toBe(false);
    expect(x.spansAfter).toBe(0);
    expect(events.every((e) => e.spansAfter === 0)).toBe(true);
    await converge(rt, addon);
    expect(addon.state.confirmedTotal).toBe(0);
    expect(addon.state.droppedTotal).toBe(0);
    // The transition landed on the real composer afterwards
    expect(rt.cursorRowText()).toMatch(/^› /);
    addon.dispose();
    rt.cleanup();
  }, 15000);
});
