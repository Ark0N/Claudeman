/**
 * @fileoverview Shell-specific mobile keyboard bar and its one-shot Ctrl
 * modifier (issue #262).
 *
 * The bar is a `const` singleton in a non-module script, so it is loaded with
 * `vm` against a small fake DOM (no jsdom in this repo), the same approach as
 * test/path-picker-ui.test.ts. What matters here is the state machine: which
 * layout a session gets, when the modifier arms, what byte a keystroke turns
 * into, and every path that must disarm it. Behavior against a real shell
 * (Ctrl+C reaching the PTY) is covered in test/mobile/keyboard.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const keyboardSource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');
const terminalSource = readFileSync(resolve('src/web/public/terminal-ui.js'), 'utf8');

type FakeButton = {
  dataset: { action: string };
  classList: { has: Set<string>; toggle(name: string, on: boolean): void; contains(name: string): boolean };
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
};

function fakeButton(action: string): FakeButton {
  const has = new Set<string>();
  return {
    dataset: { action },
    classList: {
      has,
      toggle(name: string, on: boolean) {
        if (on) has.add(name);
        else has.delete(name);
      },
      contains: (name: string) => has.has(name),
    },
    attrs: {},
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
  };
}

/** Fake bar element: tracks the button set parsed out of the assigned HTML. */
function fakeBarElement() {
  let html = '';
  let buttons = new Map<string, FakeButton>();
  const classes = new Set<string>();
  return {
    className: '',
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(next: string) {
      html = next;
      buttons = new Map();
      for (const match of next.matchAll(/data-action="([^"]+)"/g)) {
        buttons.set(match[1], fakeButton(match[1]));
      }
    },
    get actions() {
      return [...buttons.keys()];
    },
    querySelector(selector: string) {
      const match = /\[data-action="([^"]+)"\]/.exec(selector);
      return match ? (buttons.get(match[1]) ?? null) : null;
    },
    addEventListener: vi.fn(),
  };
}

type Bar = {
  element: ReturnType<typeof fakeBarElement>;
  _mode: string;
  init(): void;
  setMode(mode: string): void;
  refreshForActiveSession(): void;
  handleAction(action: string, btn?: unknown): void;
  isCtrlArmed(): boolean;
  toggleCtrl(): void;
  clearCtrl(): void;
  consumeCtrl(data: string): string;
  ctrlByteFor(char: string): string | null;
  hide(): void;
  show(): void;
};

function loadBar(sessionMode = 'claude') {
  const app = {
    activeSessionId: 'session-1',
    sessions: new Map<string, { mode: string }>([['session-1', { mode: sessionMode }]]),
    terminal: { focus: vi.fn() },
  };
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, catch: () => {} }));
  const barElement = fakeBarElement();
  const context = vm.createContext({
    app,
    MobileDetection: { isTouchDevice: () => true },
    URLSearchParams,
    fetch: fetchMock,
    document: {
      createElement: () => barElement,
      querySelector: () => ({ parentNode: { insertBefore: vi.fn() } }),
    },
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
  vm.runInContext(`${keyboardSource}\nglobalThis.__bar = KeyboardAccessoryBar;`, context, {
    filename: 'keyboard-accessory.js',
  });
  const bar = (context as unknown as { __bar: Bar }).__bar;
  bar.init();
  return { app, bar, barElement, fetchMock };
}

describe('ctrlByteFor: character to control byte', () => {
  const { bar } = loadBar();

  it.each([
    ['c', '\x03'], // interrupt
    ['d', '\x04'], // EOF
    ['z', '\x1a'], // suspend
    ['r', '\x12'], // reverse search
    ['l', '\x0c'], // clear
    ['a', '\x01'],
    ['e', '\x05'],
    ['w', '\x17'],
    ['u', '\x15'],
    ['k', '\x0b'],
  ])('maps %s to its control byte', (char, byte) => {
    expect(bar.ctrlByteFor(char)).toBe(byte);
  });

  it('maps uppercase the same as lowercase (Ctrl+C == Ctrl+c)', () => {
    expect(bar.ctrlByteFor('C')).toBe('\x03');
    expect(bar.ctrlByteFor('D')).toBe('\x04');
  });

  it('maps the punctuation controls a terminal defines', () => {
    expect(bar.ctrlByteFor('@')).toBe('\x00');
    expect(bar.ctrlByteFor('[')).toBe('\x1b'); // Ctrl+[ is Escape
    expect(bar.ctrlByteFor('\\')).toBe('\x1c');
    expect(bar.ctrlByteFor(']')).toBe('\x1d');
    expect(bar.ctrlByteFor('^')).toBe('\x1e');
    expect(bar.ctrlByteFor('_')).toBe('\x1f');
    expect(bar.ctrlByteFor(' ')).toBe('\x00'); // Ctrl+Space = NUL
    expect(bar.ctrlByteFor('?')).toBe('\x7f'); // Ctrl+? = DEL
  });

  it('returns null for characters with no control equivalent', () => {
    // A hardware keyboard types these straight through under Ctrl.
    for (const char of ['1', '9', '.', ',', '/', '-', '=', 'é']) {
      expect(bar.ctrlByteFor(char)).toBeNull();
    }
    expect(bar.ctrlByteFor('ab')).toBeNull();
    expect(bar.ctrlByteFor('')).toBeNull();
  });
});

describe('shell keyboard bar selection', () => {
  it('gives a shell session the terminal bar', () => {
    const { bar, barElement } = loadBar('shell');
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('shell');
    expect(barElement.actions).toEqual([
      'ctrl',
      'esc',
      'tab',
      'scroll-up',
      'scroll-down',
      'arrow-left',
      'arrow-right',
      'paste',
      'dismiss',
    ]);
  });

  it.each(['claude', 'codex', 'opencode', 'gemini', 'antigravity'])('leaves a %s session on the agent bar', (mode) => {
    const { bar, barElement } = loadBar(mode);
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
    expect(barElement.actions).toContain('init');
    expect(barElement.actions).not.toContain('ctrl');
  });

  it('remembers the extended-bar preference across a shell session', () => {
    const { app, bar, barElement } = loadBar('claude');
    bar.setMode('extended');
    expect(bar._mode).toBe('extended');

    app.sessions.set('shell-1', { mode: 'shell' });
    app.activeSessionId = 'shell-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('shell');

    // Settings saved while the shell bar is up must not yank it away...
    bar.setMode('extended');
    expect(bar._mode).toBe('shell');

    // ...and switching back to the agent session restores the user's choice.
    app.activeSessionId = 'session-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('extended');
    expect(barElement.actions).toContain('compact');
  });

  it('falls back to the agent bar with no active session', () => {
    const { app, bar } = loadBar('shell');
    app.activeSessionId = null as unknown as string;
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
  });
});

describe('one-shot Ctrl modifier', () => {
  function shellBar() {
    const loaded = loadBar('shell');
    loaded.bar.refreshForActiveSession();
    return loaded;
  }

  it('is disarmed until the Ctrl key is tapped', () => {
    const { bar } = shellBar();
    expect(bar.isCtrlArmed()).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('arms visibly and rewrites the next character as its control byte', () => {
    const { bar, barElement } = shellBar();
    bar.handleAction('ctrl');

    expect(bar.isCtrlArmed()).toBe(true);
    const button = barElement.querySelector('[data-action="ctrl"]')!;
    expect(button.classList.contains('armed')).toBe(true);
    expect(button.attrs['aria-pressed']).toBe('true');

    expect(bar.consumeCtrl('c')).toBe('\x03');

    // One shot: spent, and the button says so.
    expect(bar.isCtrlArmed()).toBe(false);
    expect(button.classList.contains('armed')).toBe(false);
    expect(button.attrs['aria-pressed']).toBe('false');
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('sends Ctrl+D for the next key too', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('d')).toBe('\x04');
  });

  it('cancels on a second tap of Ctrl', () => {
    const { bar, barElement } = shellBar();
    bar.handleAction('ctrl');
    bar.handleAction('ctrl');
    expect(bar.isCtrlArmed()).toBe(false);
    expect(barElement.querySelector('[data-action="ctrl"]')!.classList.contains('armed')).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('passes a character with no control byte through unchanged, spending the modifier', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('7')).toBe('7');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('spends the modifier on a paste instead of leaving it armed for the next keystroke', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('git status')).toBe('git status');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('is cancelled by any other accessory key', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    bar.handleAction('esc');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('is cancelled by a session switch', () => {
    const { app, bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.isCtrlArmed()).toBe(true);

    app.sessions.set('shell-2', { mode: 'shell' });
    app.activeSessionId = 'shell-2';
    bar.refreshForActiveSession();

    // Same layout, but the modifier must not survive into the next session.
    expect(bar._mode).toBe('shell');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('is cancelled when the keyboard is dismissed', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    bar.hide();
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('drops the armed state when the layout is swapped out from under it', () => {
    const { app, bar } = shellBar();
    bar.handleAction('ctrl');
    app.sessions.set('agent-1', { mode: 'claude' });
    app.activeSessionId = 'agent-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
    expect(bar.isCtrlArmed()).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });
});

describe('terminal input wiring', () => {
  it('applies the modifier in onData after the query-response filter and before the send paths', () => {
    const hook = terminalSource.indexOf('KeyboardAccessoryBar.consumeCtrl(data)');
    const queryFilter = terminalSource.indexOf('shouldSuppressTerminalQueryResponse(data)', hook - 4000);
    const firstSend = terminalSource.indexOf('this._lastTerminalData', hook - 4000);

    expect(hook).toBeGreaterThan(0);
    // xterm answers DA/CPR queries through onData as well; letting one of those
    // spend the modifier would silently eat the user's Ctrl.
    expect(queryFilter).toBeGreaterThan(0);
    expect(queryFilter).toBeLessThan(hook);
    // Every send path (local echo, predictive echo, plain flush) reads `data`
    // after this point, so the control byte reaches the PTY unchanged.
    expect(firstSend).toBeGreaterThan(hook);
  });

  it('guards the hook so a page without the bar (desktop) still types normally', () => {
    expect(terminalSource).toContain("typeof KeyboardAccessoryBar !== 'undefined'");
  });
});
