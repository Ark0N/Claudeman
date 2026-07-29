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
  isInteractionPrompt: (sessionId: string) => boolean;
  captureDraft: () => void;
  setDraft: (sessionId: string, draft: Record<string, unknown>) => void;
  clearDraft: (sessionId: string) => void;
  deliver: (sessionId: string, data: string, options?: { useMux?: boolean }) => void;
  preparePaste: (text: string, bracketed: boolean) => string;
  trace: (stage: string, fields?: Record<string, unknown>) => void;
  log: (message: string) => void;
  onTab: (context: Record<string, unknown>) => boolean;
  onTabCancel: () => void;
  onInteractionControl: (sessionId: string, data: string) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (timer: number) => void;
  now: () => number;
  commitReplayWindowMs?: number;
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
  flushDraftText: (text: string, sessionId?: string) => boolean;
  clearInput: () => void;
  resolveTabCompletion: () => void;
  isPtyEditing: (sessionId?: string) => boolean;
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
  eventParent: FakeEventTarget | null = null;

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
    let immediatePropagationStopped = false;
    let propagationStopped = false;
    const event: Record<string, any> = {
      target: this,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(() => {
        propagationStopped = true;
      }),
      stopImmediatePropagation: vi.fn(() => {
        immediatePropagationStopped = true;
        propagationStopped = true;
      }),
      ...fields,
    };
    const dispatch = (target: FakeEventTarget) => {
      for (const listener of target.listeners.get(type) ?? []) {
        listener(event);
        if (immediatePropagationStopped) break;
      }
    };
    if (this.eventParent) dispatch(this.eventParent);
    if (!propagationStopped) {
      immediatePropagationStopped = false;
      dispatch(this);
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

  private removeLastInputUnit(text: string): string {
    if (!text) return '';
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    });
    const last = segmenter.segment(text).containing(text.length - 1);
    return text.slice(0, last?.index ?? 0);
  }

  removeChar(): 'pending' | 'flushed' | false {
    if (this.pendingText) {
      this.pendingText = this.removeLastInputUnit(this.pendingText);
      return 'pending';
    }
    if (this.flushedText) {
      this.flushedText = this.removeLastInputUnit(this.flushedText);
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

  setFlushed(_count: number, text: string): void {
    this.flushedText = text;
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

function createHarness(
  localEcho = true,
  options: {
    commitReplayWindowMs?: number;
    interactionPrompt?: boolean;
  } = {}
) {
  const Controller = loadController();
  const textarea = new FakeTextarea();
  const container = new FakeEventTarget();
  textarea.eventParent = container;
  const overlay = new FakeOverlay();
  const deliveries: string[] = [];
  const deliveryEvents: Array<{
    sessionId: string;
    data: string;
    options?: { useMux?: boolean };
  }> = [];
  const drafts: Array<Record<string, unknown>> = [];
  const clearedDrafts: string[] = [];
  const traces: string[] = [];
  const tabContexts: Array<Record<string, unknown>> = [];
  const tabCancels: number[] = [];
  const interactionControls: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let now = 1000;
  let sessionId = 'session-a';
  let interactionPrompt = options.interactionPrompt === true;
  const terminalInput = vi.fn();
  const terminal = {
    input: terminalInput,
  };
  const controller = new Controller({
    textarea,
    terminal,
    overlay,
    getSessionId: () => sessionId,
    getSessionMode: () => (localEcho ? 'codex' : 'shell'),
    isLocalEchoEnabled: () => localEcho,
    isRestoringDraft: () => false,
    isInteractionPrompt: () => interactionPrompt,
    captureDraft: () => {},
    setDraft: (_sessionId, draft) => drafts.push(draft),
    clearDraft: (targetSessionId) => clearedDrafts.push(targetSessionId),
    deliver: (targetSessionId, data, options) => {
      deliveries.push(data);
      deliveryEvents.push({
        sessionId: targetSessionId,
        data,
        options,
      });
    },
    preparePaste: (text, bracketed) => (bracketed ? `<paste>${text}</paste>` : text),
    trace: (stage) => traces.push(stage),
    log: () => {},
    onTab: (tabContext) => {
      tabContexts.push(tabContext);
      return true;
    },
    onTabCancel: () => {
      tabCancels.push(now);
    },
    onInteractionControl: (_sessionId, data) => {
      interactionControls.push(data);
      if (/^[\r\n]+$/.test(data) || data === '\x1b' || data === '\x03') {
        interactionPrompt = false;
      }
    },
    setTimer: (callback) => {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    now: () => now,
    commitReplayWindowMs: options.commitReplayWindowMs,
  });
  return {
    controller,
    container,
    textarea,
    overlay,
    deliveries,
    deliveryEvents,
    drafts,
    clearedDrafts,
    traces,
    tabContexts,
    tabCancels,
    interactionControls,
    terminalInput,
    timers,
    advanceTime: (milliseconds: number) => {
      now += milliseconds;
    },
    setSessionId: (nextSessionId: string) => {
      sessionId = nextSessionId;
    },
    setInteractionPrompt: (active: boolean) => {
      interactionPrompt = active;
    },
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

  it('processes a semantic CJK control without re-entering the xterm gate', () => {
    const { controller, overlay, deliveries, terminalInput } = createHarness();
    overlay.appendText('你好');

    controller.sendControl('\r');

    expect(terminalInput).not.toHaveBeenCalled();
    expect(deliveries).toEqual(['你好', '\r']);
  });

  it('preserves a local draft while an interaction prompt owns controls', () => {
    const { controller, overlay, deliveries, interactionControls, clearedDrafts } = createHarness(true, {
      interactionPrompt: true,
    });
    overlay.appendText('keep this draft');

    controller.sendControl('\x1b[B');
    controller.sendControl('\r');

    expect(deliveries).toEqual(['\x1b[B', '\r']);
    expect(interactionControls).toEqual(['\x1b[B', '\r']);
    expect(overlay.pendingText).toBe('keep this draft');
    expect(clearedDrafts).toEqual([]);

    controller.sendControl('\r');

    expect(deliveries).toEqual(['\x1b[B', '\r', 'keep this draft', '\r']);
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

  it('expires a composition replay marker before accepting later identical text', () => {
    const { controller, overlay, timers, advanceTime } = createHarness(true, {
      commitReplayWindowMs: 120,
    });
    controller.beginComposition();
    controller.updateComposition('home');
    controller.endComposition('home');
    for (const timer of [...timers.values()]) timer();

    controller.handleTerminalData(' ', 'capture-input');
    advanceTime(121);
    controller.handleTerminalData('home', 'capture-input');

    expect(overlay.pendingText).toBe('home home');
    expect(controller.state.fallbackCommit).toBeNull();
  });

  it('drops one fragmented replay of a fallback composition commit', () => {
    const { controller, overlay, timers } = createHarness();
    controller.beginComposition();
    controller.updateComposition('home');
    controller.endComposition('home');
    for (const timer of [...timers.values()]) timer();

    controller.handleTerminalData('h', 'xterm');
    controller.handleTerminalData('om', 'xterm');
    controller.handleTerminalData('e', 'xterm');

    expect(overlay.pendingText).toBe('home');
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
    const { controller, overlay, deliveries, drafts } = createHarness();
    overlay.appendText('first\nsecond');

    controller.sendModifiedEnter('S-Enter');

    expect(deliveries).toEqual(['<paste>first\nsecond</paste>', '\n']);
    expect(drafts.at(-1)).toMatchObject({
      pendingText: '',
      flushedText: 'first\nsecond\n',
    });
  });

  it('merges an existing editable draft into a submitted paste', () => {
    const { controller, overlay, deliveries, clearedDrafts } = createHarness();
    overlay.appendText('prefix ');

    controller.sendPaste('first\n\nsecond', {
      submit: true,
    });

    expect(deliveries).toEqual(['<paste>prefix first\n\nsecond</paste>', '\r']);
    expect(overlay.pendingText).toBe('');
    expect(clearedDrafts).toEqual(['session-a']);
  });

  it('hands cursor navigation to the PTY instead of appending to a stale overlay', () => {
    const { controller, overlay, deliveries, drafts, clearedDrafts } = createHarness();
    overlay.appendText('cla');

    controller.sendControl('\x1b[D');
    controller.handleTerminalData('X');

    expect(deliveries).toEqual(['cla', '\x1b[D', 'X']);
    expect(overlay.pendingText).toBe('');
    expect(overlay.flushedText).toBe('');
    expect(drafts.at(-1)).toMatchObject({
      pendingText: '',
      flushedText: '',
      ptyOwned: true,
    });

    controller.sendControl('\r');
    controller.handleTerminalData('Z');

    expect(deliveries).toEqual(['cla', '\x1b[D', 'X', '\r']);
    expect(overlay.pendingText).toBe('Z');
    expect(clearedDrafts).toContain('session-a');
  });

  it('keeps history navigation and its following edit PTY-owned', () => {
    const { controller, overlay, deliveries } = createHarness();
    overlay.appendText('draft');

    controller.sendControl('\x1b[A');
    controller.handleTerminalData('!');

    expect(deliveries).toEqual(['draft', '\x1b[A', '!']);
    expect(overlay.pendingText).toBe('');
  });

  it('sends Escape without flushing or relinquishing the editable draft', () => {
    const { controller, overlay, deliveries } = createHarness();
    overlay.appendText('keep me');

    controller.sendControl('\x1b');
    controller.handleTerminalData('!');

    expect(deliveries).toEqual(['\x1b']);
    expect(overlay.pendingText).toBe('keep me!');
  });

  it('keeps an existing PTY-owned navigation edit through Escape', () => {
    const { controller, overlay, deliveries } = createHarness();
    overlay.appendText('draft');

    controller.sendControl('\x1b[A');
    controller.sendControl('\x1b');
    controller.handleTerminalData('fresh');

    expect(deliveries).toEqual(['draft', '\x1b[A', '\x1b', 'fresh']);
    expect(overlay.pendingText).toBe('');
    expect(controller.isPtyEditing()).toBe(true);
  });

  it('retains PTY-owned editing across session switches', () => {
    const { controller, overlay, deliveries, setSessionId } = createHarness();
    overlay.appendText('draft');
    controller.sendControl('\x1b[A');

    controller.reset();
    setSessionId('session-b');
    overlay.clear();
    controller.handleTerminalData('local');
    expect(overlay.pendingText).toBe('local');

    overlay.clear();
    controller.reset();
    setSessionId('session-a');
    controller.handleTerminalData('!');

    expect(deliveries).toEqual(['draft', '\x1b[A', '!']);
    expect(overlay.pendingText).toBe('');
  });

  it('frames a multiline draft before accessory and generic controls', () => {
    const { controller, overlay, deliveryEvents } = createHarness();
    overlay.appendText('first\n\nsecond');

    controller.sendControl('\x1b[A');

    expect(deliveryEvents).toEqual([
      {
        sessionId: 'session-a',
        data: '<paste>first\n\nsecond</paste>',
        options: { useMux: false },
      },
      {
        sessionId: 'session-a',
        data: '\x1b[A',
        options: undefined,
      },
    ]);

    controller.sendControl('\r');
    overlay.appendText('third\nfourth');
    controller.sendControl('\x03');

    expect(deliveryEvents.slice(-2)).toEqual([
      {
        sessionId: 'session-a',
        data: '<paste>third\nfourth</paste>',
        options: { useMux: false },
      },
      {
        sessionId: 'session-a',
        data: '\x03',
        options: undefined,
      },
    ]);
  });

  it('clears flushed local text with one Backspace per grapheme', () => {
    const { controller, overlay, deliveryEvents } = createHarness();
    overlay.flushedText = 'A👨‍👩‍👧‍👦e\u0301';

    controller.clearInput();

    expect(overlay.flushedText).toBe('');
    expect(deliveryEvents).toEqual([
      {
        sessionId: 'session-a',
        data: '\x7f\x7f\x7f',
        options: { useMux: false },
      },
    ]);
  });

  it('flushes a queued normal-mode character before session reset', () => {
    const { controller, deliveries } = createHarness(false);

    controller.handleTerminalData('a');
    controller.handleTerminalData('b');
    controller.reset();

    expect(deliveries).toEqual(['a', 'b']);
  });

  it('orders external input after the existing editable draft', () => {
    const { controller, overlay, deliveries, drafts } = createHarness();
    overlay.appendText('hello ');

    controller.sendExternalText('world');

    expect(deliveries).toEqual(['hello world']);
    expect(overlay.pendingText).toBe('');
    expect(overlay.flushedText).toBe('hello world');
    expect(drafts.at(-1)).toMatchObject({
      pendingText: '',
      flushedText: 'hello world',
    });
  });

  it('frames multiline external and session-handoff text at the delivery boundary', () => {
    const { controller, overlay, deliveryEvents } = createHarness();
    overlay.appendText('first\n');

    controller.sendExternalText('second');
    controller.flushDraftText('third\nfourth');

    expect(deliveryEvents).toEqual([
      {
        sessionId: 'session-a',
        data: '<paste>first\nsecond</paste>',
        options: { useMux: false },
      },
      {
        sessionId: 'session-a',
        data: '<paste>third\nfourth</paste>',
        options: { useMux: false },
      },
    ]);
    expect(overlay.flushedText).toBe('first\nsecond');
  });

  it('preserves prior flushed ownership across Tab completion', () => {
    const { controller, overlay, deliveries, drafts, tabContexts } = createHarness();
    overlay.flushedText = 'hello ';
    overlay.pendingText = 'wor';

    controller.handleTerminalData('\t');

    expect(tabContexts).toHaveLength(1);
    expect(tabContexts[0]).toMatchObject({
      sessionId: 'session-a',
      text: 'wor',
      flushedText: 'hello wor',
    });
    expect(deliveries).toEqual(['wor', '\t']);
    expect(overlay.pendingText).toBe('');
    expect(overlay.flushedText).toBe('hello wor');
    expect(drafts.at(-1)).toMatchObject({
      pendingText: '',
      flushedText: 'hello wor',
    });
  });

  it('cancels stale Tab completion tracking before later input', () => {
    const { controller, overlay, deliveries, tabCancels } = createHarness();
    overlay.pendingText = 'wor';

    controller.handleTerminalData('\t');
    controller.sendControl('\x1b[A');
    controller.handleTerminalData('!');

    expect(tabCancels).toHaveLength(1);
    expect(deliveries).toEqual(['wor', '\t', '\x1b[A', '!']);
    expect(controller.isPtyEditing()).toBe(true);
  });

  it('submits accessory commands through the current editable draft', () => {
    const { controller, overlay, deliveries } = createHarness();
    overlay.appendText('prefix ');

    controller.sendCommand('/help');

    expect(deliveries).toEqual(['prefix /help', '\r']);
  });

  it('routes real composition events through the attached DOM adapter', () => {
    const { controller, container, textarea, overlay } = createHarness();
    expect(controller.attachTextarea(container, { mobile: true })).toBe(true);

    textarea.fire('compositionstart');
    textarea.fire('compositionupdate', { data: 'home' });
    textarea.value = 'home';
    textarea.fire('input', {
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
    const { controller, container, textarea, overlay } = createHarness();
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

  it('prevents xterm from replaying a captured textarea mutation', () => {
    const { controller, container, textarea, overlay } = createHarness();
    controller.attachTextarea(container, { mobile: true });
    const downstreamInput = vi.fn();
    textarea.addEventListener('input', downstreamInput);
    textarea.value = 'home';

    const event = textarea.fire('input', {
      inputType: 'insertText',
      data: 'home',
      isComposing: false,
    });

    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(downstreamInput).not.toHaveBeenCalled();
    expect(overlay.pendingText).toBe('home');
  });

  it('consumes a delayed DOM echo only after matching xterm delivery', () => {
    const { controller, container, textarea, overlay, advanceTime } = createHarness();
    controller.attachTextarea(container, { mobile: true });

    textarea.fire('keydown', {
      key: 'a',
      keyCode: 65,
      isComposing: false,
    });
    controller.handleTerminalData('a', 'xterm');
    advanceTime(5000);
    textarea.value = 'a';
    textarea.fire('input', {
      inputType: 'insertText',
      data: 'a',
      isComposing: false,
    });

    expect(overlay.pendingText).toBe('a');
  });

  it('does not drop unrelated input after an unhandled keydown candidate', () => {
    const { controller, container, textarea, overlay } = createHarness();
    controller.attachTextarea(container, { mobile: true });

    textarea.fire('keydown', {
      key: 'a',
      keyCode: 65,
      isComposing: false,
    });
    textarea.value = '你';
    textarea.fire('input', {
      inputType: 'insertText',
      data: '你',
      isComposing: false,
    });

    expect(overlay.pendingText).toBe('你');
  });

  it('coalesces segmented Android paste input without duplicating later segments', () => {
    const { controller, container, textarea, overlay } = createHarness();
    controller.attachTextarea(container, { mobile: true });

    textarea.value = 'References';
    textarea.fire('input', {
      inputType: 'insertText',
      data: 'References',
      isComposing: false,
    });
    textarea.fire('input', {
      inputType: 'insertLineBreak',
      data: null,
      isComposing: false,
    });
    textarea.value = 'more';
    textarea.fire('input', {
      inputType: 'insertText',
      data: 'more',
      isComposing: false,
    });

    expect(overlay.pendingText).toBe('References\nmore');
  });

  it('applies a replacement deletion once per visible grapheme', () => {
    const { controller, container, textarea, overlay } = createHarness();
    controller.attachTextarea(container, { mobile: true });
    overlay.pendingText = 'Ae\u0301';
    textarea.value = 'e\u0301';
    textarea.selectionStart = 0;
    textarea.selectionEnd = textarea.value.length;

    textarea.fire('beforeinput', {
      inputType: 'insertReplacementText',
      data: 'x',
      isComposing: false,
    });
    textarea.value = 'x';
    textarea.fire('input', {
      inputType: 'insertReplacementText',
      data: 'x',
      isComposing: false,
    });

    expect(overlay.pendingText).toBe('Ax');
  });

  it('keeps a queued normal-mode character owned by its original session', () => {
    const { controller, deliveries, deliveryEvents, setSessionId } = createHarness(false);

    controller.handleTerminalData('a');
    controller.handleTerminalData('b');
    setSessionId('session-b');
    controller.reset();

    expect(deliveries).toEqual(['a', 'b']);
    expect(deliveryEvents.map((event) => event.sessionId)).toEqual(['session-a', 'session-a']);
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
