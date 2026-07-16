import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  let now = 1_000;
  const context = vm.createContext({
    window: {},
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

describe('terminal touch tap mouse guard', () => {
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

  it('wheel: forwards to the app only for verified sessions at the buffer bottom without Shift', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.187' }]]);
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };

    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
    expect(app._shouldForwardWheelToApp({ shiftKey: true })).toBe(false); // Shift = local scrollback

    app.terminal.buffer.active.viewportY = 10; // browsing local scrollback
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    app.terminal.buffer.active.viewportY = 50;

    app.terminal.modes.mouseTrackingMode = 'vt200'; // xterm's own encoder live
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    app.terminal.modes.mouseTrackingMode = 'none';

    app.sessions = new Map([['sess-1', { mode: 'shell' }]]); // not a strip mode
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
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

  it('wheel: codex forwards without a version; gemini never forwards', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };

    app.sessions = new Map([['sess-1', { mode: 'codex' }]]); // verified TUI, no version gate
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);

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
