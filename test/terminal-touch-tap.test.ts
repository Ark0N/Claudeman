import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  let now = 1_000;
  let keyboardVisible = false;
  let activeElement: unknown = null;
  const context = vm.createContext({
    window: {},
    document: {
      body: { classList: { contains: () => false } },
      get activeElement() {
        return activeElement;
      },
      getElementById: () => null,
    },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => now },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => 'blob:yield',
      revokeObjectURL: () => {},
    },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: {
      isTouchDevice: () => true,
    },
    KeyboardHandler: {
      get keyboardVisible() {
        return keyboardVisible;
      },
    },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  return {
    app,
    setNow: (value: number) => {
      now = value;
    },
    setKeyboardVisible: (visible: boolean) => {
      keyboardVisible = visible;
    },
    setActiveElement: (element: unknown) => {
      activeElement = element;
    },
  };
}

function createElementHarness() {
  const listeners = new Map<string, (ev: any) => void>();
  return {
    element: {
      addEventListener: vi.fn((type: string, listener: (ev: any) => void) => {
        listeners.set(type, listener);
      }),
    },
    dispatch(type: string, event: any) {
      listeners.get(type)?.(event);
    },
  };
}

function createTerminalGrid(lines: string[], cursorY: number, wrappedRows = new Set<number>()) {
  const textarea = {
    classList: { contains: (name: string) => name === 'xterm-helper-textarea' },
    blur: vi.fn(),
  };
  return {
    cols: 80,
    rows: lines.length,
    modes: { mouseTrackingMode: 'none' },
    buffer: {
      active: {
        viewportY: 0,
        baseY: 0,
        cursorY,
        getLine: (row: number) =>
          row >= 0 && row < lines.length
            ? { isWrapped: wrappedRows.has(row), translateToString: () => lines[row] }
            : undefined,
      },
    },
    element: {
      querySelector: (selector: string) =>
        selector === '.xterm-screen' ? { getBoundingClientRect: () => ({ left: 0, top: 0 }) } : null,
    },
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    textarea,
    focus: vi.fn(),
  };
}

describe('terminal touch tap mouse guard', () => {
  it('recognizes focus only when a terminal input owns the active element', () => {
    const { app, setActiveElement } = loadTerminalUiHarness();
    const textarea = { classList: { contains: () => true } };
    app.terminal = { textarea };

    setActiveElement(null);
    expect(app._isMobileTerminalInputFocused()).toBe(false);

    setActiveElement(textarea);
    expect(app._isMobileTerminalInputFocused()).toBe(true);
  });

  it('routes a readback row to the TUI while keeping the prompt row as keyboard input', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'codex' }]]);
    app.terminal = createTerminalGrid(
      ['Agent readback mentions › inline', '  tap to collapse', '', '', '› ask', 'gpt-5 · Context 80% left'],
      4
    );

    expect(app._classifyMobileTerminalTap(9, 1)).toBe('content'); // inline marker is not a prompt
    expect(app._classifyMobileTerminalTap(9, 17)).toBe('content'); // row 2: readback
    expect(app._classifyMobileTerminalTap(9, 65)).toBe('input'); // row 5: prompt
    expect(app._classifyMobileTerminalTap(9, 81)).toBe('content'); // row 6: status
  });

  it('classifies Claude background-agent status as content rather than keyboard input', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.220' }]]);
    app.terminal = createTerminalGrid(
      ['', '', '', '• Working (1m 50s • esc to ', 'interrupt) · 1 background teammate', ''],
      4,
      new Set([4])
    );

    expect(app._classifyMobileTerminalTap(9, 65)).toBe('content');
  });

  it('keeps the live cursor focusable when Claude temporarily omits its prompt glyph', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal = createTerminalGrid(['Prior response', '', 'ready for input', '', 'status footer', ''], 2);

    expect(app._classifyMobileTerminalTap(9, 33)).toBe('input');
    expect(app._classifyMobileTerminalTap(9, 1)).toBe('content');
  });

  it('treats a highlighted numbered choice as TUI content, not an input prompt', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal = createTerminalGrid(['Would you like to proceed?', '', '❯ 1. Yes', '  2. No', '', ''], 2);

    expect(app._classifyMobileTerminalTap(9, 33)).toBe('content');
    expect(app._classifyMobileTerminalTap(9, 49)).toBe('content');
  });

  it('keeps the keyboard reachable while a selection dialog is on screen', () => {
    // The lock this pins: a visible dialog used to make EVERY row of the
    // terminal "actionable" (both menu tests scanned the whole viewport), so
    // every tap blurred and the on-screen keyboard could not be opened until
    // the dialog was answered, leaving tapping an option (the one gesture that
    // commits an answer) as the only thing a phone could do.
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal = createTerminalGrid(
      ['Do you want to proceed?', '', '❯ 1. Yes', '  2. No, tell Claude what to do', '', ''],
      2
    );
    app._sendInputAsync = vi.fn();
    setActiveElement(null);

    // The dialog's own rows stay TUI-owned: report the tap, keep the keyboard down.
    expect(app._isActionableMobileTerminalTap(9, 33)).toBe(true); // ❯ 1. Yes
    expect(app._isActionableMobileTerminalTap(9, 49)).toBe(true); // 2. No, …
    // Everything else is inert, and must still be able to summon the keyboard.
    expect(app._isActionableMobileTerminalTap(9, 1)).toBe(false); // question title
    expect(app._isActionableMobileTerminalTap(9, 65)).toBe(false); // blank row

    app._handleMobileTerminalTap({ clientX: 9, clientY: 1 }, false);
    expect(app.terminal.focus).toHaveBeenCalledOnce();

    app.terminal.focus.mockClear();
    app._handleMobileTerminalTap({ clientX: 9, clientY: 33 }, false);
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('collapses TUI readback content without opening or retaining the keyboard', () => {
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'codex' }]]);
    app.terminal = createTerminalGrid(
      ['Agent readback', '  tap to collapse', '', '', '› ask', 'gpt-5 · Context 80% left'],
      4
    );
    app._sendInputAsync = vi.fn();
    setActiveElement(app.terminal.textarea);

    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 17 }, true)).toBe('content');
    expect(app._sendInputAsync).toHaveBeenCalledWith('sess-1', '\x1b[<0;2;2M\x1b[<0;2;2m');
    expect(app.terminal.textarea.blur).toHaveBeenCalledOnce();
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('keeps the first prompt tap focus-only so it cannot activate a CLI row', () => {
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'codex' }]]);
    app.terminal = createTerminalGrid(
      ['Agent readback', '  tap to collapse', '', '', '› ask', 'gpt-5 · Context 80% left'],
      4
    );
    app._sendInputAsync = vi.fn();
    setActiveElement(null);

    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 65 }, false)).toBe('input');
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app.terminal.focus).toHaveBeenCalledOnce();
  });

  it('closes the keyboard on a second tap of INERT transcript content', () => {
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal = createTerminalGrid(['transcript line', '', '', '', '❯ ', ''], 4);
    app._sendInputAsync = vi.fn();

    // Keyboard DOWN: the tap opens it.
    setActiveElement(null);
    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 1 }, false)).toBe('content');
    expect(app.terminal.focus).toHaveBeenCalledOnce();
    expect(app.terminal.textarea.blur).not.toHaveBeenCalled();

    // Keyboard UP on the same inert row: the tap closes it.
    app.terminal.focus.mockClear();
    setActiveElement(app.terminal.textarea);
    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 1 }, true)).toBe('content');
    expect(app.terminal.textarea.blur).toHaveBeenCalledOnce();
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('keeps the prompt row focusing rather than toggling, so the caret can still be placed', () => {
    // The toggle is scoped to 'content' on purpose: a second tap on the PROMPT
    // must still position the cursor. This is the guarantee that makes the
    // change safe to make, so it is pinned separately.
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal = createTerminalGrid(['transcript line', '', '', '', '❯ ask', ''], 4);
    app._sendInputAsync = vi.fn();

    setActiveElement(app.terminal.textarea);
    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 65 }, true)).toBe('input');
    expect(app.terminal.textarea.blur).not.toHaveBeenCalled();
    expect(app.terminal.focus).toHaveBeenCalledOnce();
  });

  it('suppresses browser trusted compatibility mouse events during the tap window', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    const event = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it('allows the app synthetic mouse event through the tap window', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    const event = {
      isTrusted: false,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('encodes a tap as an SGR press+release when the server strips mouse DECSETs (claude mode)', () => {
    const { app } = loadTerminalUiHarness();
    const sent: Array<{ id: string; data: string }> = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (id: string, data: string) => sent.push({ id, data });
    app.terminal = {
      cols: 80,
      rows: 24,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    expect(app._sessionUsesServerMouseStrip()).toBe(true);
    // touch at x=10+8*20+1, y=20+16*5+1 → col 21, row 6 (1-based)
    app._sendSyntheticSgrTap(171, 101);

    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[<0;21;6M\x1b[<0;21;6m' }]);
  });

  it('clamps SGR tap coordinates to the terminal grid', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = {
      cols: 80,
      rows: 24,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._sendSyntheticSgrTap(-50, 99999);

    expect(sent).toEqual(['\x1b[<0;1;24M\x1b[<0;1;24m']);
  });

  it('does not treat shell sessions as server-mouse-strip mode', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'shell' }]]);

    expect(app._sessionUsesServerMouseStrip()).toBe(false);
  });

  it('desktop click: encodes SGR press+release for a plain left-click in strip mode', () => {
    const { app } = loadTerminalUiHarness();
    const sent: Array<{ id: string; data: string }> = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (id: string, data: string) => sent.push({ id, data });
    app.terminal = {
      cols: 80,
      rows: 24,
      modes: { mouseTrackingMode: 'none' },
      hasSelection: () => false,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._handleDesktopTerminalClick({
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 171,
      clientY: 101,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
    });

    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[<0;21;6M\x1b[<0;21;6m' }]);
  });

  it('desktop click: skips clicks that already have a meaning elsewhere', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    const terminal = () => ({
      cols: 80,
      rows: 24,
      modes: { mouseTrackingMode: 'none' } as { mouseTrackingMode: string },
      hasSelection: () => false,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    });
    const click = (overrides: Record<string, unknown> = {}) => ({
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 50,
      clientY: 50,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
      ...overrides,
    });

    app.terminal = terminal();
    app._handleDesktopTerminalClick(click({ isTrusted: false })); // synthetic
    app._handleDesktopTerminalClick(click({ button: 1 })); // middle button
    app._handleDesktopTerminalClick(click({ detail: 2 })); // double-click word select
    app._handleDesktopTerminalClick(click({ shiftKey: true })); // selection override
    app._handleDesktopTerminalClick(click({ target: { closest: () => null } })); // outside grid

    app.terminal = { ...terminal(), hasSelection: () => true }; // drag-selection just ended
    app._handleDesktopTerminalClick(click());

    app.terminal = { ...terminal(), modes: { mouseTrackingMode: 'vt200' } }; // xterm encoder live
    app._handleDesktopTerminalClick(click());

    app.terminal = terminal();
    app.sessions = new Map([['sess-1', { mode: 'shell' }]]); // not a strip mode
    app._handleDesktopTerminalClick(click());

    expect(sent).toEqual([]);
  });

  it('desktop click: skips the click while a terminal link is hovered (activate() handles it)', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = {
      cols: 80,
      rows: 24,
      modes: { mouseTrackingMode: 'none' },
      hasSelection: () => false,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };
    const click = {
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 50,
      clientY: 50,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
    };

    app._linkHovered = true; // link provider hover() fired — this click opens the link
    app._handleDesktopTerminalClick(click);
    expect(sent).toEqual([]);

    app._linkHovered = false; // leave() fired — plain clicks report again
    app._handleDesktopTerminalClick(click);
    expect(sent).toEqual(['\x1b[<0;7;4M\x1b[<0;7;4m']);
  });

  it('desktop click: skips the compat click that follows a touch tap', () => {
    const { app, setNow } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = {
      cols: 80,
      rows: 24,
      modes: { mouseTrackingMode: 'none' },
      hasSelection: () => false,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };
    const click = {
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 50,
      clientY: 50,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
    };

    app._suppressTrustedTapMouseEvents(); // touchend just handled the tap
    app._handleDesktopTerminalClick(click);
    expect(sent).toEqual([]);

    setNow(10_000); // window expired — a genuine mouse click reports again
    app._handleDesktopTerminalClick(click);
    expect(sent).toEqual(['\x1b[<0;7;4M\x1b[<0;7;4m']);
  });

  it('tap: does nothing while the viewport is scrolled up into local scrollback', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = {
      cols: 80,
      rows: 24,
      buffer: { active: { viewportY: 10, baseY: 50 } }, // scrolled up
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._sendSyntheticSgrTap(50, 50);
    expect(sent).toEqual([]);

    app.terminal.buffer.active.viewportY = 50; // back at the bottom
    app._sendSyntheticSgrTap(50, 50);
    expect(sent).toEqual(['\x1b[<0;7;4M\x1b[<0;7;4m']);
  });

  it('wheel: forwards to the app for verified sessions without Shift, at ANY scroll position', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.187' }]]);
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };

    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
    expect(app._shouldForwardWheelToApp({ shiftKey: true })).toBe(false); // Shift = local scrollback

    // Scrolled up into local scrollback still forwards. Gating this on the
    // viewport being at the bottom is what let a repaint-mode CLI's own prompt
    // box scroll off the screen: scrollToLastNonEmptyLine() parks the viewport
    // above the bottom, so a tab switch silently pinned the wheel to local
    // scrollback full of stale replayed frames. The wheel handler snaps the
    // viewport back to the bottom before encoding the report instead.
    app.terminal.buffer.active.viewportY = 10;
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
    app.terminal.buffer.active.viewportY = 50;

    app.terminal.modes.mouseTrackingMode = 'vt200'; // xterm's own encoder live
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    app.terminal.modes.mouseTrackingMode = 'none';

    app.sessions = new Map([['sess-1', { mode: 'shell' }]]); // not a strip mode
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
  });

  it('wheel: converts deltaMode line/page units instead of assuming pixels', () => {
    const { app } = loadTerminalUiHarness();
    app.terminal = { rows: 40 };

    // DOM_DELTA_PIXEL (Chrome/WebKit, and every trackpad): ~110px per notch.
    expect(app._wheelScrollLines({ deltaY: 110, deltaX: 0, deltaMode: 0, shiftKey: false })).toBe(4);
    // DOM_DELTA_LINE (Firefox mouse wheel): deltaY is already lines. Read as
    // pixels this rounded to 0 and fell through to the ±1 fallback.
    expect(app._wheelScrollLines({ deltaY: 3, deltaX: 0, deltaMode: 1, shiftKey: false })).toBe(3);
    expect(app._wheelScrollLines({ deltaY: -3, deltaX: 0, deltaMode: 1, shiftKey: false })).toBe(-3);
    // DOM_DELTA_PAGE: one page is one screenful.
    expect(app._wheelScrollLines({ deltaY: 1, deltaX: 0, deltaMode: 2, shiftKey: false })).toBe(40);
    // A pure horizontal swipe must not fall through to a phantom -1.
    expect(app._wheelScrollLines({ deltaY: 0, deltaX: 90, deltaMode: 0, shiftKey: false })).toBe(0);
    // Shift + macOS trackpad reports the magnitude on deltaX (issue #154).
    expect(app._wheelScrollLines({ deltaY: 0, deltaX: -100, deltaMode: 0, shiftKey: true })).toBe(-4);
  });

  it('wheel: gates claude forwarding on CLI version 2.1.187+ (unknown or older stays local)', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };
    const withVersion = (cliVersion?: string) => {
      app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion }]]);
      return app._shouldForwardWheelToApp({ shiftKey: false });
    };

    expect(withVersion(undefined)).toBe(false); // banner not parsed yet → assume older
    expect(withVersion('2.1.186')).toBe(false); // last version whose menus capture wheel
    expect(withVersion('2.1.187')).toBe(true); // first version verified safe
    expect(withVersion('2.2.0')).toBe(true);
    expect(withVersion('3.0.0')).toBe(true);
    expect(withVersion('garbage')).toBe(false); // unparseable → assume older
  });

  it('wheel: only claude forwards — codex and gemini keep the local wheel', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };

    // Codex used to forward unconditionally, which is PR #227's regression: measured
    // on codex-cli 0.147.0, it never enables mouse tracking and ignores SGR wheel
    // reports outright, so forwarding ate every tick while its real local scrollback
    // (the codex transcript lives there — inline viewport, no in-app pager) sat unused.
    app.sessions = new Map([['sess-1', { mode: 'codex' }]]);
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    app.sessions = new Map([['sess-1', { mode: 'codex', cliVersion: '9.9.9' }]]); // no version rescues it
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);

    app.sessions = new Map([['sess-1', { mode: 'gemini', cliVersion: '9.9.9' }]]); // unverified TUI
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
  });

  it('wheel: the local-scrollback opt-out pins the plain wheel to local scrollback (issue #154)', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.187' }]]);
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };

    // Default (setting absent) forwards the plain wheel to the CLI transcript.
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);

    // Opt-out ON → the plain wheel stays on xterm's own scrollback (pre-#144).
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: true });
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);

    // OFF again → forwarding resumes.
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: false });
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
  });

  it('wheel: reads the dominant axis under Shift so a macOS trackpad can page scrollback (issue #154)', () => {
    const { app } = loadTerminalUiHarness();

    // Plain vertical wheel: unchanged, driven by deltaY.
    expect(app._wheelScrollLines({ shiftKey: false, deltaX: 0, deltaY: 100 })).toBe(4);
    expect(app._wheelScrollLines({ shiftKey: false, deltaX: 0, deltaY: -50 })).toBe(-2);

    // Shift on a macOS trackpad: deltaY≈0, deltaX carries direction+magnitude.
    // Old code collapsed this to a fixed -1; now it tracks the horizontal delta.
    expect(app._wheelScrollLines({ shiftKey: true, deltaX: -100, deltaY: 0 })).toBe(-4); // scroll up
    expect(app._wheelScrollLines({ shiftKey: true, deltaX: 75, deltaY: 0 })).toBe(3); // scroll down

    // Shift with a real vertical wheel (mouse): deltaY dominates, deltaX ignored.
    expect(app._wheelScrollLines({ shiftKey: true, deltaX: 2, deltaY: 100 })).toBe(4);

    // Sub-25px delta still nudges one line in the gesture's direction.
    expect(app._wheelScrollLines({ shiftKey: true, deltaX: -5, deltaY: 0 })).toBe(-1);
  });

  it('wheel: encodes SGR 64/65 ticks, caps per event, and coalesces into one flush', () => {
    const { app } = loadTerminalUiHarness();
    const sent: Array<{ id: string; data: string }> = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    // Wheel reports flush via the ephemeral (fire-and-forget) path, not the
    // durable queue — so they never show in the pending-bytes indicator (#154).
    app._sendInputEphemeral = (id: string, data: string) => sent.push({ id, data });
    app.terminal = {
      cols: 80,
      rows: 24,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._sendSyntheticSgrWheel(50, 50, -2); // 2 ticks up
    app._sendSyntheticSgrWheel(50, 50, 9); // capped at 5 ticks down
    expect(sent).toEqual([]); // nothing until the flush timer fires

    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[<64;7;4M'.repeat(2) + '\x1b[<65;7;4M'.repeat(5) }]);

    app._flushWheelSgrQueue(); // queue drained — no duplicate send
    expect(sent).toHaveLength(1);
  });

  it('forwarded scrolls (wheel AND touch) snap the viewport home first, then encode SGR ticks', () => {
    const { app } = loadTerminalUiHarness();
    const sent: Array<{ id: string; data: string }> = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputEphemeral = (id: string, data: string) => sent.push({ id, data });
    const scrolledToBottom: boolean[] = [];
    app.terminal = {
      cols: 80,
      rows: 24,
      // Scrolled up into local scrollback: SGR coordinates address the LIVE
      // screen, so the report would hit-test the wrong row without the snap.
      buffer: { active: { viewportY: 10, baseY: 50 } },
      scrollToBottom: () => scrolledToBottom.push(true),
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._forwardScrollToApp(50, 50, -3);
    expect(scrolledToBottom).toEqual([true]);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[<64;7;4M'.repeat(3) }]);

    // Already at the bottom: no snap, just the report.
    app.terminal.buffer.active.viewportY = 50;
    app._forwardScrollToApp(50, 50, 2);
    expect(scrolledToBottom).toHaveLength(1);
    app._flushWheelSgrQueue();
    expect(sent).toHaveLength(2);
  });

  it('allows trusted mouse events after the tap window expires', () => {
    const { app, setNow } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();
    setNow(2_000);

    const event = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});
