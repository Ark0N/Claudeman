// Port: none (pure logic in a vm context — no browser, no server).
//
// Issue #259: opening or closing the mobile keyboard forced the terminal to the
// bottom, so a user reading scrollback was yanked down to the live output. The
// settle cycle now captures scroll intent BEFORE the keyboard reflow and returns
// to that anchor instead.
//
// This lives outside test/mobile/ deliberately. That suite is Playwright-driven
// and EXCLUDED from `npm run test:ci` (config/vitest.ci.config.ts), so a
// regression guarded only there is invisible to CI — the exact blind spot that
// let the #279/#280 merge land a red mobile suite behind two green checks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const SOURCE = readFileSync(resolve(PUBLIC, 'mobile-handlers.js'), 'utf8');

interface FakeTerminal {
  buffer: { active: { viewportY: number; baseY: number } };
  scrollToBottom: () => void;
  scrollToLine: (line: number) => void;
}

/**
 * Load mobile-handlers.js and hand back its KeyboardHandler.
 *
 * The module declares `const KeyboardHandler = {...}` at top level, and a
 * lexical binding does not survive to the next vm.runInContext call, so the
 * export is appended to the SAME script rather than read back afterwards.
 */
function loadKeyboardHandler(opts: { viewportY: number; baseY: number }) {
  const calls: string[] = [];
  const terminal: FakeTerminal = {
    buffer: { active: { viewportY: opts.viewportY, baseY: opts.baseY } },
    scrollToBottom: () => calls.push('scrollToBottom'),
    scrollToLine: (line: number) => calls.push(`scrollToLine:${line}`),
  };
  const app: any = {
    terminal,
    fitAddon: { fit: () => calls.push('fit') },
    // The real predicate (terminal-ui.js isTerminalAtBottom), reproduced so the
    // test exercises the same tolerance the runtime uses.
    isTerminalAtBottom: () => terminal.buffer.active.viewportY >= terminal.buffer.active.baseY - 2,
    relayoutMobileSubagentWindows: () => {},
  };
  let pendingTimer: (() => void) | null = null;
  const context = vm.createContext({
    console,
    window: { scrollTo: () => {}, matchMedia: () => ({ matches: false }), addEventListener: () => {} },
    document: { body: { classList: { add: () => {}, remove: () => {} } }, addEventListener: () => {} },
    navigator: { userAgent: 'test', maxTouchPoints: 0 },
    app,
    setTimeout: (fn: () => void) => {
      pendingTimer = fn;
      return 1;
    },
    clearTimeout: () => {
      pendingTimer = null;
    },
  });
  vm.runInContext(`${SOURCE}\n;globalThis.__KeyboardHandler = KeyboardHandler;`, context, {
    filename: 'mobile-handlers.js',
  });
  const kh = (context as any).__KeyboardHandler;
  // Stub the layout side effects the settle timer fires alongside the scroll.
  kh._shrinkPaddingToFit = () => {};
  kh._sendTerminalResize = () => {};
  return {
    kh,
    terminal,
    calls,
    /** Run the coalesced settle timer the way the OS animation eventually would. */
    settle: () => {
      const fn = pendingTimer;
      pendingTimer = null;
      fn?.();
    },
  };
}

describe('keyboard settle preserves scroll intent (issue #259)', () => {
  it('scrolls to bottom when the user is following live output', () => {
    const { kh, calls, settle } = loadKeyboardHandler({ viewportY: 500, baseY: 500 });

    kh._scheduleViewportSettle({ restoreScroll: true });
    settle();

    expect(calls).toContain('scrollToBottom');
    expect(calls.some((c) => c.startsWith('scrollToLine'))).toBe(false);
  });

  it('returns to the anchor instead of the bottom when the user is reading history', () => {
    const { kh, calls, settle } = loadKeyboardHandler({ viewportY: 120, baseY: 500 });

    kh._scheduleViewportSettle({ restoreScroll: true });
    settle();

    expect(calls).toContain('scrollToLine:120');
    expect(calls).not.toContain('scrollToBottom');
  });

  it('captures the anchor BEFORE the reflow, not after', () => {
    // The OS emits several viewport heights per animation, so the settle is
    // re-scheduled repeatedly. Only the first capture predates fit(); a later
    // one would read a viewportY the reflow had already moved.
    const { kh, terminal, calls, settle } = loadKeyboardHandler({ viewportY: 120, baseY: 500 });

    kh._scheduleViewportSettle({ restoreScroll: true });
    terminal.buffer.active.viewportY = 480; // reflow drags the viewport down
    kh._scheduleViewportSettle({ restoreScroll: true });
    settle();

    expect(calls).toContain('scrollToLine:120');
  });

  it('clamps an anchor that outlives the buffer it was captured from', () => {
    const { kh, terminal, calls, settle } = loadKeyboardHandler({ viewportY: 400, baseY: 500 });

    kh._scheduleViewportSettle({ restoreScroll: true });
    terminal.buffer.active.baseY = 90; // buffer shrank under us
    settle();

    expect(calls).toContain('scrollToLine:90');
  });

  it('leaves the terminal alone when the settle was not a keyboard transition', () => {
    const { kh, calls, settle } = loadKeyboardHandler({ viewportY: 120, baseY: 500 });

    kh._scheduleViewportSettle({});
    settle();

    expect(calls).toContain('fit');
    expect(calls).not.toContain('scrollToBottom');
    expect(calls.some((c) => c.startsWith('scrollToLine'))).toBe(false);
  });
});

describe('keyboard show/hide route through the intent-preserving path (static guard)', () => {
  it('both transitions ask to restore scroll, never to force the bottom', () => {
    // Slice from the METHOD DEFINITIONS ("\n  name() {"), not the first
    // occurrence of the name — both are called from _checkKeyboard() further up.
    const bodyOf = (name: string) => {
      const start = SOURCE.indexOf(`\n  ${name}() {`);
      expect(start, `${name} definition not found`).toBeGreaterThan(-1);
      return SOURCE.slice(start, SOURCE.indexOf('\n  },', start));
    };
    const show = bodyOf('onKeyboardShow');
    const hide = bodyOf('onKeyboardHide');

    expect(show).toContain('_scheduleViewportSettle({ restoreScroll: true })');
    expect(hide).toContain('_scheduleViewportSettle({ restoreScroll: true })');
    // The old unconditional call must not come back.
    expect(SOURCE).not.toContain('scrollToBottom: true');
  });
});
