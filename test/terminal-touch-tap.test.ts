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
