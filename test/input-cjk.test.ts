/**
 * @fileoverview Unit tests for the CJK IME input module (input-cjk.js).
 *
 * Loads the browser module into a vm sandbox (no real DOM) and drives fake
 * composition/keydown/input event sequences against a stub textarea.
 * Focus: the intermittent "Chinese characters silently lost" failure modes —
 * stuck composition state, deferred flush racing the next composition, and
 * the keydown-echo suppression window swallowing a real IME commit.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PHANTOM = '​';

interface FakeTextarea {
  value: string;
  valueWrites: number;
  blur: () => void;
  focus: () => void;
  classList: { contains: (c: string) => boolean };
  setSelectionRange: () => void;
  addEventListener: (ev: string, fn: (e?: unknown) => void) => void;
  removeEventListener: (ev: string, fn: (e?: unknown) => void) => void;
  fire: (ev: string, arg?: Record<string, unknown>) => void;
}

function makeTextarea(): FakeTextarea {
  const listeners = new Map<string, Array<(e?: unknown) => void>>();
  let val = '';
  return {
    get value() {
      return val;
    },
    set value(v: string) {
      this.valueWrites++;
      val = v;
    },
    valueWrites: 0,
    blur: () => {},
    focus: () => {},
    classList: { contains: (c: string) => c === 'cjk-input-visible' },
    setSelectionRange: () => {},
    addEventListener: (ev, fn) => {
      const list = listeners.get(ev) ?? [];
      listeners.set(ev, [...list, fn]);
    },
    removeEventListener: (ev, fn) => {
      const list = listeners.get(ev) ?? [];
      listeners.set(
        ev,
        list.filter((f) => f !== fn)
      );
    },
    fire(ev, arg = {}) {
      const base = { preventDefault: () => {}, stopPropagation: () => {}, ...arg };
      for (const fn of listeners.get(ev) ?? []) fn(base);
    },
  };
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

function loadCjkHarness({ ua = ANDROID_UA }: { ua?: string } = {}) {
  const textarea = makeTextarea();
  const sent: string[] = [];
  const controls: string[] = [];
  const pasted: string[] = [];
  const draftValues: string[] = [];
  const windowObj: Record<string, unknown> = {};
  const documentObj = {
    getElementById: (id: string) => (id === 'cjkInput' ? textarea : null),
    activeElement: null as unknown,
  };

  // Delegating closures so vitest fake timers (which patch the test realm's
  // globals) govern the vm context's timers/clock too.
  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    navigator: { userAgent: ua },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    performance: { now: () => performance.now() },
    console,
  });

  const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/input-cjk.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'input-cjk.js' });
  const CjkInput = vm.runInContext('CjkInput', context);

  CjkInput.init({
    sendText: (text: string) => sent.push(text),
    sendControl: (data: string) => controls.push(data),
    paste: (text: string) => pasted.push(text),
    draftChanged: () => draftValues.push(textarea.value),
  });
  textarea.fire('focus');

  return { CjkInput, textarea, sent, controls, pasted, draftValues, windowObj, documentObj };
}

describe('CJK input module', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends committed text after a normal composition cycle', () => {
    const { textarea, sent } = loadCjkHarness();

    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好';
    textarea.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    textarea.fire('compositionend');
    vi.advanceTimersByTime(10);

    expect(sent).toEqual(['你好']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('recovers committed text when compositionend never fires (stuck composition)', () => {
    const { textarea, sent } = loadCjkHarness();

    // IME fires compositionstart but never compositionend (WeChat/Sogou quirk).
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好';
    // The commit arrives as a plain input event outside composition.
    textarea.fire('input', { isComposing: false, inputType: 'insertText' });
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['你好']);
  });

  it('does not flush or reset the textarea while the next composition is active', () => {
    const { textarea, sent } = loadCjkHarness();

    // Word 1 commits; the deferred flush is queued but has not run yet.
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好';
    textarea.fire('compositionend');
    // Word 2 composition begins immediately (fast continuous typing).
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好世界';

    // Deferred flush from word 1 fires now — it must NOT touch the textarea
    // (a programmatic reset here cancels the live IME composition on iOS).
    vi.advanceTimersByTime(10);
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM + '你好世界');

    textarea.fire('compositionend');
    vi.advanceTimersByTime(10);
    expect(sent).toEqual(['你好世界']);
  });

  it('does not discard an IME commit landing inside the keydown echo window', () => {
    const { textarea, sent } = loadCjkHarness();

    // English char goes out immediately via keydown.
    textarea.fire('keydown', { key: 'a', ctrlKey: false, altKey: false, metaKey: false });
    expect(sent).toEqual(['a']);

    // Within 100ms the IME commits Chinese via a bare input event.
    vi.advanceTimersByTime(50);
    textarea.value = PHANTOM + '你好';
    textarea.fire('input', { isComposing: false, inputType: 'insertText' });
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['a', '你好']);
  });

  it('still suppresses the true textarea echo of a keydown-sent character', () => {
    const { textarea, sent } = loadCjkHarness();

    textarea.fire('keydown', { key: 'a', ctrlKey: false, altKey: false, metaKey: false });
    expect(sent).toEqual(['a']);

    // Third-party IME ignored preventDefault — the same char echoes into
    // the textarea. It must be dropped, not sent twice.
    vi.advanceTimersByTime(10);
    textarea.value = PHANTOM + 'a';
    textarea.fire('input', { isComposing: false, inputType: 'insertText' });
    vi.advanceTimersByTime(300);

    expect(sent).toEqual(['a']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('routes multiline clipboard text through the dedicated paste boundary', () => {
    const { textarea, sent, pasted } = loadCjkHarness();
    const preventDefault = vi.fn();

    textarea.fire('paste', {
      preventDefault,
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? 'first\n\nsecond' : ''),
      },
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(pasted).toEqual(['first\n\nsecond']);
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('routes Android input-only paste events through the dedicated paste boundary', () => {
    const { textarea, sent, pasted } = loadCjkHarness();
    textarea.value = PHANTOM + 'first\n\nReferences\nmore after references';

    textarea.fire('input', {
      isComposing: false,
      inputType: 'insertFromPaste',
    });

    expect(pasted).toEqual(['first\n\nReferences\nmore after references']);
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('keeps multiline text bracketed when Enter wins the race with the paste event', () => {
    const { textarea, sent, controls, pasted } = loadCjkHarness();
    textarea.value = PHANTOM + 'first\n\nReferences\nmore after references';

    textarea.fire('keydown', {
      key: 'Enter',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });

    expect(pasted).toEqual(['first\n\nReferences\nmore after references']);
    expect(sent).toEqual([]);
    expect(controls).toEqual(['\r']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('re-tapping the focused empty field restarts the IME session (wedged-IME recovery)', () => {
    const { textarea, documentObj } = loadCjkHarness();
    documentObj.activeElement = textarea;
    let blurred = 0;
    let focused = 0;
    textarea.blur = () => {
      blurred++;
    };
    textarea.focus = () => {
      focused++;
    };

    textarea.fire('pointerdown');
    expect(blurred).toBe(1);
    vi.advanceTimersByTime(10);
    expect(focused).toBe(1);

    // First tap on an unfocused field must NOT cycle (normal focus flow).
    documentObj.activeElement = null;
    textarea.fire('pointerdown');
    expect(blurred).toBe(1);
  });

  it('does not run the wedged-IME pointerdown recovery on iOS (Android-only)', () => {
    // On iOS, tapping the focused empty field is normal (paste callout,
    // habitual tap), and the async refocus runs outside the user-gesture
    // stack — the blur→focus cycle must never fire there.
    const { textarea, documentObj } = loadCjkHarness({ ua: IOS_UA });
    documentObj.activeElement = textarea;
    let blurred = 0;
    let focused = 0;
    textarea.blur = () => {
      blurred++;
    };
    textarea.focus = () => {
      focused++;
    };

    textarea.fire('pointerdown');
    vi.advanceTimersByTime(10);
    expect(blurred).toBe(0);
    expect(focused).toBe(0);
  });

  it('never records typed content in the diagnostic trace (privacy)', () => {
    // The trace mirrors into crash-diag, which persists to localStorage and
    // beacons to the server — it must stay content-free: lengths, key
    // classes, and event names only. Drive every path that formerly embedded
    // the value or key literal (composition, keydown send, input, blur).
    const { CjkInput, textarea, sent } = loadCjkHarness();

    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '秘密口令';
    textarea.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    textarea.fire('compositionend');
    vi.advanceTimersByTime(10);

    textarea.fire('keydown', { key: '囍', ctrlKey: false, altKey: false, metaKey: false });
    textarea.value = PHANTOM + '秘密';
    textarea.fire('blur');
    expect(sent).toEqual(['秘密口令', '囍']);

    const trace = CjkInput.getTrace().join('\n');
    for (const ch of '秘密口令囍') expect(trace).not.toContain(ch);
    // Lengths and key classes are still traced for diagnostics.
    expect(trace).toContain('flush send len=4');
    expect(trace).toContain('keydown printable');
  });

  it('skips redundant textarea writes when already reset (Android IME desync guard)', () => {
    const { CjkInput, textarea } = loadCjkHarness();
    const before = textarea.valueWrites;

    // Value is already the phantom — external clears (session switch / SSE
    // reconnect) must not rewrite it, or they race the IME session setup.
    CjkInput.clear();
    CjkInput.clear();

    expect(textarea.valueWrites).toBe(before);
  });

  it('round-trips a restored CJK draft without submitting it', () => {
    const { CjkInput, textarea, sent, pasted } = loadCjkHarness();

    CjkInput.restorePendingText('未提交\n草稿');

    expect(CjkInput.getPendingText()).toBe('未提交\n草稿');
    expect(textarea.value).toBe(PHANTOM + '未提交\n草稿');
    expect(sent).toEqual([]);
    expect(pasted).toEqual([]);

    CjkInput.clear();
    expect(CjkInput.getPendingText()).toBe('');
    expect(textarea.value).toBe(PHANTOM);
  });

  it('notifies the draft owner before a CJK input mutation is debounced', () => {
    const { textarea, sent, draftValues } = loadCjkHarness();
    draftValues.length = 0;
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '未提交';

    textarea.fire('input', {
      isComposing: true,
      inputType: 'insertCompositionText',
    });

    expect(draftValues).toEqual([PHANTOM + '未提交']);
    expect(sent).toEqual([]);
  });

  it('routes terminal.focus() to the CJK field while it is visible (focus router)', () => {
    // Regression guard for the intermittent "Chinese input goes nowhere" bug:
    // session-select / SSE-reconnect paths call terminal.focus(), which lands
    // on xterm's hidden textarea; with the CJK gate active, everything typed
    // there is swallowed. terminal-ui must (a) route focus() to the CJK field
    // when visible and (b) self-heal inside the onData gate.
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

    expect(src).toContain('Focus router');
    expect(src).toMatch(/this\.terminal\.focus = \(\) => \{/);
    expect(src).toContain("cjkEl?.classList.contains('cjk-input-visible')");
    expect(src).toContain('CJK regain-focus (onData swallowed input)');

    // The self-heal must only fire for GENUINE typed input: onData also fires
    // for xterm's self-generated query replies (DA/DSR/CPR/OSC during Ink
    // redraws), which arrive while e.g. the rename input or search box has
    // focus — refocusing on those steals focus mid-typing. Guard: focus must
    // be on xterm's own textarea AND the data must not be a query reply.
    expect(src).toMatch(
      /document\.activeElement === this\.terminal\.textarea[\s\S]*?!window\.CodemanTerminalInput\?\.shouldSuppressTerminalQueryResponse\([\s\S]*?data[\s\S]*?\)[\s\S]*?CJK regain-focus \(onData swallowed input\)/
    );
  });

  it('routes Enter text and control through separate semantic callbacks', () => {
    const { textarea, sent, controls } = loadCjkHarness();

    textarea.value = PHANTOM + '你好';
    textarea.fire('keydown', { key: 'Enter' });

    expect(sent).toEqual(['你好']);
    expect(controls).toEqual(['\r']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('flushes pending CJK text before routing a control action', () => {
    const { textarea, sent, controls } = loadCjkHarness();
    textarea.value = PHANTOM + 'draft';

    textarea.fire('keydown', {
      key: 'c',
      ctrlKey: true,
    });

    expect(sent).toEqual(['draft']);
    expect(controls).toEqual(['\x03']);
    expect(textarea.value).toBe(PHANTOM);
  });
});
