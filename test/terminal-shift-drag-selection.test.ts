/**
 * Shift+drag must START a terminal selection, and right-click must copy it.
 *
 * Both halves come from one habit users bring from a native terminal running a
 * mouse-tracking TUI (claude, codex): hold Shift to select locally, then
 * right-click to copy. In Codeman both halves were broken, for two unrelated
 * reasons, and the pair dead-ended the whole gesture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadHarness() {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const windowRef: Record<string, unknown> = {};
  const context = vm.createContext({
    window: windowRef,
    document: { body: { classList: { contains: () => false } }, getElementById: () => null, activeElement: null },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Worker: function Worker(this: { postMessage: () => void }) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => false },
    KeyboardHandler: {},
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8'), context);
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8'), context);
  return new (CodemanApp as unknown as new () => Record<string, (...a: unknown[]) => unknown>)();
}

/** A terminal whose element records the capture-phase mousedown listener we install. */
function makeTerminal(opts: { hasSelection: boolean; viewportY: number }) {
  const selectCalls: Array<[number, number, number]> = [];
  let listener: ((ev: Record<string, unknown>) => void) | null = null;
  const terminal = {
    element: {
      addEventListener: (type: string, fn: (ev: Record<string, unknown>) => void, capture: boolean) => {
        // Capture on the `.xterm` root is what puts us ahead of xterm's own
        // mousedown on the descendant `.xterm-screen`; a bubble-phase listener
        // would run after SelectionService had already decided.
        expect(type).toBe('mousedown');
        expect(capture).toBe(true);
        listener = fn;
      },
      querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    },
    cols: 80,
    rows: 24,
    buffer: { active: { viewportY: opts.viewportY } },
    hasSelection: () => opts.hasSelection,
    select: (c: number, r: number, l: number) => selectCalls.push([c, r, l]),
    _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
  };
  return { terminal, selectCalls, fire: (ev: Record<string, unknown>) => listener?.(ev) };
}

const mousedown = (over: Record<string, unknown> = {}) => ({
  isTrusted: true,
  button: 0,
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  clientX: 35,
  clientY: 50,
  ...over,
});

describe('Shift+drag starts a selection', () => {
  it('plants the anchor xterm never sets, in 0-based ABSOLUTE buffer coordinates', () => {
    // xterm reads Shift as "force selection" only while the app has mouse
    // tracking on, and the server strips those DECSETs for claude/codex/gemini,
    // so Shift instead reaches `_onIncrementalClick` — extend — which is a no-op
    // with no selectionStart. The drag then anchors nothing and selects NOTHING.
    const app = loadHarness();
    const { terminal, selectCalls, fire } = makeTerminal({ hasSelection: false, viewportY: 120 });
    app.terminal = terminal as never;
    app._installShiftDragSelection();
    fire(mousedown());
    // clientX 35 / 10px cells -> viewport col 4 (1-based) -> column 3 (0-based).
    // clientY 50 / 20px cells -> viewport row 3 (1-based) -> row 2, + viewportY.
    expect(selectCalls).toEqual([[3, 2 + 120, 0]]);
  });

  it('uses length 0 so a Shift+CLICK that never drags selects nothing', () => {
    const app = loadHarness();
    const { terminal, selectCalls, fire } = makeTerminal({ hasSelection: false, viewportY: 0 });
    app.terminal = terminal as never;
    app._installShiftDragSelection();
    fire(mousedown());
    expect(selectCalls[0][2]).toBe(0);
  });

  it('leaves a real EXTEND gesture to xterm when a selection is already up', () => {
    const app = loadHarness();
    const { terminal, selectCalls, fire } = makeTerminal({ hasSelection: true, viewportY: 0 });
    app.terminal = terminal as never;
    app._installShiftDragSelection();
    fire(mousedown());
    expect(selectCalls).toEqual([]);
  });

  it('ignores everything that is not a trusted plain-Shift left press', () => {
    const app = loadHarness();
    const { terminal, selectCalls, fire } = makeTerminal({ hasSelection: false, viewportY: 0 });
    app.terminal = terminal as never;
    app._installShiftDragSelection();
    for (const ev of [
      mousedown({ shiftKey: false }),
      mousedown({ button: 2 }),
      mousedown({ isTrusted: false }),
      mousedown({ ctrlKey: true }),
      mousedown({ altKey: true }),
      mousedown({ metaKey: true }),
    ]) {
      fire(ev);
    }
    expect(selectCalls).toEqual([]);
  });

  it('installs exactly once per terminal element', () => {
    const app = loadHarness();
    const { terminal } = makeTerminal({ hasSelection: false, viewportY: 0 });
    let installs = 0;
    terminal.element.addEventListener = () => {
      installs += 1;
    };
    app.terminal = terminal as never;
    app._installShiftDragSelection();
    app._installShiftDragSelection();
    expect(installs).toBe(1);
  });
});

describe('right-click copies the terminal selection', () => {
  // The handler is created inline inside initTerminal (it closes over the
  // long-press timer it shares with the touch path), so this pins the ordering
  // in the shipped source: gesture suppression first, then the no-selection
  // early return, and only then the copy.
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const handler = source.slice(
    source.indexOf("container.addEventListener('contextmenu'"),
    source.indexOf("container.addEventListener('touchcancel'")
  );

  it('suppresses the menu during a touch selection gesture and stops there', () => {
    expect(handler).toMatch(/longPressTimer !== null[\s\S]*?ev\.preventDefault\(\);\s*return;/);
  });

  it('returns BEFORE preventDefault when nothing is selected, keeping the native menu', () => {
    const noSelection = handler.indexOf('hasSelection');
    const prevent = handler.lastIndexOf('ev.preventDefault()');
    expect(noSelection).toBeGreaterThan(-1);
    expect(noSelection).toBeLessThan(prevent);
  });

  it('copies through copyTerminalSelection rather than a second clipboard path', () => {
    expect(handler).toContain('this.copyTerminalSelection(selection)');
  });
});
