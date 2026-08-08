/**
 * @fileoverview Local-echo gating and input-ordering helpers for codex
 * sessions (issues #218/#219/#220/#222).
 *
 * Codex's composer is interactive per keystroke: typing "/" pops a
 * live-filtering command picker (#222), the composer grows as it wraps
 * (#220), pastes arrive bracketed (#219) and arrows edit server-side state
 * (#218). The buffer-until-Enter local echo overlay starves all of that, so
 * codex-mode sessions must use plain PTY echo like shell. The shared overlay
 * branch (claude/gemini/opencode) additionally flushes typed-but-unsent text
 * before forwarding bracketed pastes and composer nav keys, and hands the
 * session to pass-through after a nav key.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), mirroring
 * test/input-send-order.test.ts. End-to-end behavior was verified against a
 * real codex 0.147.0 TUI in tmux through a headless browser.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type OverlayStub = {
  pendingText: string;
  cleared: number;
  suppressed: number;
  prompts: unknown[];
  clear(): void;
  suppressBufferDetection(): void;
  setPrompt(p: unknown): void;
  appendText: ReturnType<typeof vi.fn>;
};

type AppInstance = {
  activeSessionId: string | null;
  sessions: Map<string, { mode: string }>;
  terminal?: { focus: () => void };
  _localEchoEnabled?: boolean;
  _localEchoOverlay?: OverlayStub;
  _pendingInput: string;
  _flushedOffsets?: Map<string, number>;
  _flushedTexts?: Map<string, string>;
  _echoPassthroughSessions?: Set<string>;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
  sendInput: ReturnType<typeof vi.fn>;
  _updateLocalEchoState(): void;
  _flushLocalEchoPending(): void;
  insertTerminalText(text: string): void;
};

function loadContext() {
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  const windowStub: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn(), documentElement: { dataset: {} } },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: windowStub,
    MobileDetection: {
      isTouchDevice: () => true,
      isHandheldDevice: () => false,
      getDeviceType: () => 'desktop',
    },
  });
  vm.runInContext(
    `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
  return {
    CodemanApp,
    terminalInput: (windowStub as { CodemanTerminalInput?: Record<string, unknown> }).CodemanTerminalInput!,
  };
}

const { CodemanApp, terminalInput } = loadContext();
const isComposerNavKey = terminalInput.isComposerNavKey as (data: string) => boolean;

function makeOverlay(pending = ''): OverlayStub {
  return {
    pendingText: pending,
    cleared: 0,
    suppressed: 0,
    prompts: [],
    clear() {
      this.cleared++;
      this.pendingText = '';
    },
    suppressBufferDetection() {
      this.suppressed++;
    },
    setPrompt(p: unknown) {
      this.prompts.push(p);
    },
    appendText: vi.fn(),
  };
}

function makeApp(mode: string, overlay = makeOverlay()): AppInstance {
  const app = Object.create(CodemanApp.prototype) as AppInstance;
  app.activeSessionId = 's1';
  app.sessions = new Map([['s1', { mode }]]);
  app._localEchoOverlay = overlay;
  app._pendingInput = '';
  app._flushedOffsets = new Map([['s1', 3]]);
  app._flushedTexts = new Map([['s1', 'abc']]);
  app.loadAppSettingsFromStorage = () => ({ localEchoEnabled: true });
  app.sendInput = vi.fn().mockResolvedValue(undefined);
  return app;
}

describe('CodemanTerminalInput.isComposerNavKey', () => {
  it.each([
    '\x1b[A',
    '\x1b[B',
    '\x1b[C',
    '\x1b[D',
    '\x1b[H',
    '\x1b[F',
    '\x1bOA',
    '\x1bOD',
    '\x1bOH',
    '\x1bOF',
    '\x1b[1;5C', // Ctrl+Right
    '\x1b[1;2A', // Shift+Up
    '\x1b[3~', // Delete
    '\x1b[3;5~', // Ctrl+Delete
    '\x1b[5~', // PgUp
    '\x1b[6~', // PgDn
    '\x1b[1~', // Home variant
    '\x1b[4~', // End variant
  ])('classifies %j as a composer nav key', (seq) => {
    expect(isComposerNavKey(seq)).toBe(true);
  });

  it.each([
    '\x1b[?1;2c', // DA1 response
    '\x1b[>0;276;0c', // DA2 response
    '\x1b[12;34R', // CPR response
    '\x1b[1;3R', // CPR response (small coords)
    '\x1b[0n', // DSR response
    '\x1b[15~', // F5 (function keys stay out)
    '\x1b[200~hi\x1b[201~', // bracketed paste
    '\x1b[?u', // kitty keyboard query response
    '\x1bOP', // F1
    '\x1b',
    'a',
    'abc',
    '\r',
  ])('does NOT classify %j as a composer nav key', (seq) => {
    expect(isComposerNavKey(seq)).toBe(false);
  });

  it('exports the bracketed paste prefix xterm puts on terminal.paste()', () => {
    expect(terminalInput.BRACKETED_PASTE_START).toBe('\x1b[200~');
  });
});

describe('_updateLocalEchoState mode gating', () => {
  it('disables the overlay for codex sessions even with the setting ON (issues #218/#219/#220/#222)', () => {
    const overlay = makeOverlay('pending');
    const app = makeApp('codex', overlay);
    app._updateLocalEchoState();
    expect(app._localEchoEnabled).toBe(false);
    expect(overlay.cleared).toBeGreaterThan(0);
  });

  it('disables the overlay for shell sessions (PTY provides its own echo)', () => {
    const app = makeApp('shell');
    app._updateLocalEchoState();
    expect(app._localEchoEnabled).toBe(false);
  });

  it.each(['claude', 'gemini', 'opencode'])('keeps the overlay enabled for %s sessions', (mode) => {
    const overlay = makeOverlay();
    const app = makeApp(mode, overlay);
    app._updateLocalEchoState();
    expect(app._localEchoEnabled).toBe(true);
    expect(overlay.prompts.length).toBeGreaterThan(0);
  });
});

describe('_flushLocalEchoPending', () => {
  it('moves pending text into _pendingInput and resets overlay + flushed tracking', () => {
    const overlay = makeOverlay('hello');
    const app = makeApp('claude', overlay);
    app._flushLocalEchoPending();
    expect(app._pendingInput).toBe('hello');
    expect(overlay.cleared).toBe(1);
    expect(overlay.suppressed).toBe(1);
    expect(app._flushedOffsets!.has('s1')).toBe(false);
    expect(app._flushedTexts!.has('s1')).toBe(false);
  });

  it('appends nothing when the overlay is empty', () => {
    const app = makeApp('claude', makeOverlay(''));
    app._flushLocalEchoPending();
    expect(app._pendingInput).toBe('');
  });
});

describe('insertTerminalText pass-through routing', () => {
  it('appends to the overlay while local echo is buffering', () => {
    const overlay = makeOverlay();
    const app = makeApp('claude', overlay);
    app._localEchoEnabled = true;
    app.insertTerminalText('path.txt');
    expect(overlay.appendText).toHaveBeenCalledWith('path.txt');
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it('sends directly while the session is in nav-key pass-through', () => {
    const overlay = makeOverlay();
    const app = makeApp('claude', overlay);
    app._localEchoEnabled = true;
    app._echoPassthroughSessions = new Set(['s1']);
    app.insertTerminalText('path.txt');
    expect(app.sendInput).toHaveBeenCalledWith('path.txt');
    expect(overlay.appendText).not.toHaveBeenCalled();
  });
});
