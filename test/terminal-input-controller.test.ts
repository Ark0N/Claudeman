import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type ControllerOptions = {
  textarea: FakeTextarea;
  terminal: { input: (data: string) => void };
  overlay: FakeOverlay;
  getSessionId: () => string;
  getSessionMode: () => string;
  isLocalEchoEnabled: () => boolean;
  isRestoringDraft: () => boolean;
  captureDraft: () => void;
  setDraft: (sessionId: string, draft: Record<string, unknown>) => void;
  clearDraft: (sessionId: string) => void;
  deliver: (sessionId: string, data: string) => void;
  preparePaste: (text: string, bracketed: boolean) => string;
  sendNamedKey: (sessionId: string, key: string, delay: number) => void;
  trace: (stage: string, fields?: Record<string, unknown>) => void;
  log: (message: string) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (timer: number) => void;
  now: () => number;
};

type TerminalInputController = {
  beginComposition: () => void;
  updateComposition: (text: string) => void;
  endComposition: (text: string) => void;
  handleTerminalData: (data: string, source?: string) => boolean;
  sendControl: (data: string) => void;
  sendExternalText: (text: string) => void;
  sendCommand: (command: string) => void;
  sendPaste: (text: string, options?: { submit?: boolean }) => void;
  sendModifiedEnter: (key: string) => void;
  clearInput: () => void;
  attachTextarea: (container: FakeEventTarget, options?: { mobile?: boolean }) => boolean;
  reset: (options?: { flushDelivery?: boolean }) => void;
  state: {
    compositionActive: boolean;
    compositionPending: boolean;
    expectedCommit: string | null;
    fallbackCommit: string | null;
  };
};

type TerminalInputControllerConstructor = new (options: ControllerOptions) => TerminalInputController;

type FakeListener = (event: Record<string, any>) => void;

class FakeEventTarget {
  private listeners = new Map<string, FakeListener[]>();

  addEventListener(type: string, listener: FakeListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
    );
  }

  fire(type: string, fields: Record<string, unknown> = {}) {
    const event = {
      target: this,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      ...fields,
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    return event;
  }
}

class FakeTextarea extends FakeEventTarget {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class FakeOverlay {
  pendingText = '';
  compositionText = '';
  flushedText = '';

  addChar(char: string): void {
    this.pendingText += char;
  }

  appendText(text: string): void {
    this.pendingText += text;
  }

  setCompositionText(text: string): void {
    this.compositionText = text;
  }

  commitComposition(text: string): void {
    this.compositionText = '';
    this.pendingText += text;
  }

  clearComposition(): void {
    this.compositionText = '';
  }

  removeChar(): 'pending' | 'flushed' | false {
    if (this.pendingText) {
      this.pendingText = this.pendingText.slice(0, -1);
      return 'pending';
    }
    if (this.flushedText) {
      this.flushedText = this.flushedText.slice(0, -1);
      return 'flushed';
    }
    return false;
  }

  getFlushed(): { count: number; text: string } {
    return {
      count: this.flushedText.length,
      text: this.flushedText,
    };
  }

  clear(): void {
    this.pendingText = '';
    this.compositionText = '';
    this.flushedText = '';
  }

  suppressBufferDetection(): void {}
}

function loadController(): TerminalInputControllerConstructor {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-input-controller.js'), 'utf8');
  const context = vm.createContext({
    console,
    globalThis: {},
  });
  vm.runInContext(source, context, { filename: 'terminal-input-controller.js' });
  return (
    context.globalThis as {
      TerminalInputController: TerminalInputControllerConstructor;
    }
  ).TerminalInputController;
}

function createHarness(localEcho = true) {
  const Controller = loadController();
  const textarea = new FakeTextarea();
  const overlay = new FakeOverlay();
  const deliveries: string[] = [];
  const drafts: Array<Record<string, unknown>> = [];
  const namedKeys: Array<{
    sessionId: string;
    key: string;
    delay: number;
  }> = [];
  const traces: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let controller: TerminalInputController;
  const terminal = {
    input(data: string) {
      controller.handleTerminalData(data, 'terminal-control');
    },
  };
  controller = new Controller({
    textarea,
    terminal,
    overlay,
    getSessionId: () => 'session-a',
    getSessionMode: () => (localEcho ? 'codex' : 'shell'),
    isLocalEchoEnabled: () => localEcho,
    isRestoringDraft: () => false,
    captureDraft: () => {},
    setDraft: (_sessionId, draft) => drafts.push(draft),
    clearDraft: () => {},
    deliver: (_sessionId, data) => deliveries.push(data),
    preparePaste: (text, bracketed) => (bracketed ? `<paste>${text}</paste>` : text),
    sendNamedKey: (sessionId, key, delay) => {
      namedKeys.push({ sessionId, key, delay });
    },
    trace: (stage) => traces.push(stage),
    log: () => {},
    setTimer: (callback) => {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    now: () => 1000,
  });
  return {
    controller,
    textarea,
    overlay,
    deliveries,
    drafts,
    namedKeys,
    traces,
    timers,
  };
}

describe('TerminalInputController', () => {
  it('owns finalized composition reconciliation and clears retained helper context', () => {
    const { controller, textarea, overlay, traces } = createHarness();
    overlay.appendText('cd');

    controller.beginComposition();
    textarea.value = 'hcd home';
    controller.updateComposition(' home');
    controller.endComposition(' home');
    const handled = controller.handleTerminalData('hcd home', 'xterm');

    expect(handled).toBe(true);
    expect(overlay.pendingText).toBe('cd home');
    expect(overlay.compositionText).toBe('');
    expect(textarea.value).toBe('');
    expect(controller.state).toMatchObject({
      compositionActive: false,
      compositionPending: false,
      expectedCommit: null,
      fallbackCommit: ' home',
    });
    expect(traces).toContain('composition-strip-stale-prefix');
  });

  it('keeps repeated composition epochs independent of retained textarea values', () => {
    const { controller, textarea, overlay } = createHarness();

    for (const text of ['cd', ' home', ' cd', ' home']) {
      controller.beginComposition();
      textarea.value = `stale${text}`;
      controller.updateComposition(text);
      controller.endComposition(text);
      controller.handleTerminalData(`stale${text}`, 'xterm');
      expect(textarea.value).toBe('');
    }

    expect(overlay.pendingText).toBe('cd home cd home');
  });

  it('cancels an unfinished composition before applying one local Backspace', () => {
    const { controller, overlay } = createHarness();
    overlay.appendText('cd');
    controller.beginComposition();
    controller.updateComposition('candidate');
    controller.endComposition('candidate');

    controller.handleTerminalData('\x7f', 'beforeinput-delete');

    expect(overlay.pendingText).toBe('c');
    expect(overlay.compositionText).toBe('');
    expect(controller.state).toMatchObject({
      compositionActive: false,
      compositionPending: false,
      expectedCommit: null,
      fallbackCommit: null,
    });
  });

  it('routes ordinary text and Enter through one local-echo submission path', () => {
    const { controller, overlay, deliveries } = createHarness();

    controller.handleTerminalData('cd home', 'xterm');
    controller.sendControl('\r');

    expect(overlay.pendingText).toBe('');
    expect(deliveries).toEqual(['cd home', '\r']);
  });

  it('retains a composition marker across a boundary and drops its delayed replay', () => {
    const { controller, overlay } = createHarness();
    controller.beginComposition();
    controller.updateComposition('home');
    controller.endComposition('home');
    controller.handleTerminalData('home', 'xterm');

    controller.handleTerminalData(' ', 'capture-input');
    controller.handleTerminalData('home', 'capture-input');

    expect(overlay.pendingText).toBe('home ');
    expect(controller.state.fallbackCommit).toBeNull();
  });

  it('delivers immediate-echo composition data only once', () => {
    const { controller, deliveries } = createHarness(false);
    controller.beginComposition();
    controller.updateComposition('home');
    controller.endComposition('home');

    controller.handleTerminalData('home', 'xterm');
    controller.handleTerminalData('home', 'capture-input');

    expect(deliveries).toEqual(['home']);
  });

  it('flushes the editable draft before a modified Enter key', () => {
    const { controller, overlay, deliveries, drafts, namedKeys } = createHarness();
    overlay.appendText('first\nsecond');

    controller.sendModifiedEnter('S-Enter');

    expect(deliveries).toEqual(['first\nsecond']);
    expect(namedKeys).toEqual([
      {
        sessionId: 'session-a',
        key: 'S-Enter',
        delay: 80,
      },
    ]);
    expect(drafts.at(-1)).toMatchObject({
      pendingText: '',
      flushedText: 'first\nsecond\n',
    });
  });

  it('routes multiline paste and submit as two ordered records', () => {
    const { controller, deliveries } = createHarness();

    controller.sendPaste('first\n\nsecond', {
      submit: true,
    });

    expect(deliveries).toEqual(['<paste>first\n\nsecond</paste>', '\r']);
  });

  it('clears flushed local text with one Backspace per character', () => {
    const { controller, overlay, deliveries } = createHarness();
    overlay.flushedText = 'abc';

    controller.clearInput();

    expect(overlay.flushedText).toBe('');
    expect(deliveries).toEqual(['\x7f\x7f\x7f']);
  });

  it('flushes a queued normal-mode character before session reset', () => {
    const { controller, deliveries } = createHarness(false);

    controller.handleTerminalData('a');
    controller.handleTerminalData('b');
    controller.reset();

    expect(deliveries).toEqual(['a', 'b']);
  });

  it('keeps external input on the immediate reliable-delivery path', () => {
    const { controller, deliveries } = createHarness();

    controller.sendExternalText('voice or CJK text');

    expect(deliveries).toEqual(['voice or CJK text']);
  });

  it('submits accessory commands through the current editable draft', () => {
    const { controller, overlay, deliveries } = createHarness();
    overlay.appendText('prefix ');

    controller.sendCommand('/help');

    expect(deliveries).toEqual(['prefix /help', '\r']);
  });

  it('routes real composition events through the attached DOM adapter', () => {
    const { controller, textarea, overlay } = createHarness();
    const container = new FakeEventTarget();
    expect(controller.attachTextarea(container, { mobile: true })).toBe(true);

    textarea.fire('compositionstart');
    textarea.fire('compositionupdate', { data: 'home' });
    textarea.value = 'home';
    container.fire('input', {
      target: textarea,
      inputType: 'insertText',
      data: 'home',
      isComposing: false,
    });
    textarea.fire('compositionend', { data: 'home' });

    expect(overlay.pendingText).toBe('home');
    expect(overlay.compositionText).toBe('');
    expect(textarea.value).toBe('');
  });

  it('routes attached delete and multiline paste events exactly once', () => {
    const { controller, textarea, overlay } = createHarness();
    const container = new FakeEventTarget();
    controller.attachTextarea(container, { mobile: true });
    overlay.appendText('abc');

    const deletion = textarea.fire('beforeinput', {
      inputType: 'deleteContentBackward',
      isComposing: false,
    });
    const paste = textarea.fire('paste', {
      clipboardData: {
        getData: () => 'first\n\nsecond',
      },
    });

    expect(deletion.preventDefault).toHaveBeenCalledOnce();
    expect(paste.preventDefault).toHaveBeenCalledOnce();
    expect(overlay.pendingText).toBe('abfirst\n\nsecond');
  });

  it('drops a compositionend that arrives after session state was reset', () => {
    const { controller, overlay, textarea, timers } = createHarness();
    controller.beginComposition();
    controller.updateComposition('outgoing');

    controller.reset({ flushDelivery: false });
    textarea.value = 'outgoing';
    controller.endComposition('outgoing');
    for (const timer of timers.values()) timer();

    expect(overlay.pendingText).toBe('');
    expect(overlay.compositionText).toBe('');
    expect(textarea.value).toBe('');
    expect(controller.state.compositionPending).toBe(false);
  });
});
