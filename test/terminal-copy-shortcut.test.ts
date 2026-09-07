/**
 * Smart copy in a real browser (#211).
 *
 * The gate itself is unit-tested in test/terminal-copy-selection.test.ts. What
 * can only be proven in a browser is the half that decides whether the PTY sees
 * an interrupt: xterm calls the custom key handler BEFORE its own cancel(), so
 * returning false does not preventDefault, and a synthetic KeyboardEvent never
 * triggers a browser default action. Both facts mean the copy/interrupt split
 * has to be driven with real key presses.
 *
 * Assertions are on real state: what landed on the clipboard, and what xterm
 * emitted through onData (the bytes that would reach the PTY).
 *
 * Browser-driven, so it is excluded from `npm run test:ci` like the other
 * Playwright suites. Run locally: npm run test:browser -- test/terminal-copy-shortcut.test.ts
 *
 * Port: 3174 (per MEMORY.md, ports 3150+ for tests)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3174;
const BASE_URL = `http://localhost:${PORT}`;
const IME_PUNCTUATION = '，。！？；：“”、《》、（）';

describe('terminal Ctrl+C smart copy', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    // The first write after load can be dropped while the app finishes wiring
    // its render pipeline, so poll until one really lands in the buffer.
    await page.waitForFunction(
      async () => {
        const term = (window as any).app.terminal;
        await new Promise((r) => term.write('\r\nWARMUP\r\n', r));
        const buf = term.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          if (buf.getLine(i)?.translateToString(true).includes('WARMUP')) return true;
        }
        return false;
      },
      null,
      { timeout: 20000, polling: 500 }
    );
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  /** Write a marker line, optionally select it, and reset the capture state. */
  async function setup(line: string, select: boolean, overrides: Record<string, unknown> = {}) {
    await page.evaluate(
      async ({ line, select, overrides }) => {
        const app = (window as any).app;
        const term = app.terminal;
        const settings = app.loadAppSettingsFromStorage();
        settings.shortcutOverrides = overrides;
        app.saveAppSettingsToStorage(settings);
        (window as any).__data = [];
        if (!(window as any).__dataHooked) {
          term.onData((d: string) => (window as any).__data.push(d));
          (window as any).__dataHooked = true;
        }
        await new Promise((r) => term.write('\r\n' + line + '\r\n', r));
        term.clearSelection();
        if (select) {
          const buf = term.buffer.active;
          let row = -1;
          for (let i = 0; i < buf.length; i++) {
            if (buf.getLine(i)?.translateToString(true).includes(line)) row = i;
          }
          if (row === -1) throw new Error('marker line not found in buffer');
          term.select(0, row, line.length);
          if (!(term.getSelection() || '').trim()) throw new Error('selection is empty');
        }
        document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new Event('focus'));
        (document.querySelector('.xterm-helper-textarea') as HTMLElement).focus();
        await navigator.clipboard.writeText('SENTINEL');
      },
      { line, select, overrides }
    );
  }

  async function outcome() {
    await page.waitForTimeout(350);
    return page.evaluate(async () => ({
      data: (window as any).__data as string[],
      clipboard: (await navigator.clipboard.readText()).trim(),
      hasSelection: (window as any).app.terminal.hasSelection(),
    }));
  }

  async function captureImeInput(targetPage: Page) {
    await targetPage.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    await targetPage.evaluate(() => {
      const term = (window as any).app.terminal;
      (window as any).__data = [];
      if (!(window as any).__dataHooked) {
        term.onData((d: string) => (window as any).__data.push(d));
        (window as any).__dataHooked = true;
      }
      (document.querySelector('.xterm-helper-textarea') as HTMLElement).focus();
    });

    const cdp = await targetPage.context().newCDPSession(targetPage);
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '中文' });
    await targetPage.waitForFunction(() => (window as any).__data.join('') === '中文', null, { polling: 10 });

    let expected = '中文';
    for (const punctuation of Array.from(IME_PUNCTUATION)) {
      // Keep keydown -> DOM mutation -> input in one browser task, as a
      // native key default action does. Separate CDP calls can let xterm's
      // zero-delay textarea diff run before Input.insertText reaches the page.
      await targetPage.evaluate((text) => {
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
        const down = new KeyboardEvent('keydown', {
          key: 'Process',
          code: 'Unidentified',
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        Object.defineProperties(down, { keyCode: { value: 229 }, which: { value: 229 } });
        textarea.dispatchEvent(down);
        if (!document.execCommand('insertText', false, text)) throw new Error('browser rejected insertText');
        const up = new KeyboardEvent('keyup', {
          key: 'Process',
          code: 'Unidentified',
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        Object.defineProperties(up, { keyCode: { value: 229 }, which: { value: 229 } });
        textarea.dispatchEvent(up);
      }, punctuation);
      expected += punctuation;
      await targetPage.waitForFunction((text) => (window as any).__data.join('') === text, expected, {
        polling: 10,
      });
    }

    return targetPage.evaluate(() => (window as any).__data as string[]);
  }

  it('copies the selection and sends nothing to the PTY', async () => {
    await setup('COPY-CASE-SELECTED', true);
    await page.keyboard.press('Control+c');
    const res = await outcome();
    expect(res.clipboard).toBe('COPY-CASE-SELECTED');
    expect(res.data).toEqual([]);
    expect(res.hasSelection).toBe(false); // cleared, so a second Ctrl+C interrupts
  });

  it('still interrupts when nothing is selected', async () => {
    await setup('COPY-CASE-UNSELECTED', false);
    await page.keyboard.press('Control+c');
    const res = await outcome();
    expect(res.data).toEqual(['\x03']);
    expect(res.clipboard).toBe('SENTINEL');
  });

  it('copies on the explicit Ctrl+Shift+C chord', async () => {
    await setup('COPY-CASE-EXPLICIT', true);
    await page.keyboard.press('Control+Shift+C');
    const res = await outcome();
    expect(res.clipboard).toBe('COPY-CASE-EXPLICIT');
    expect(res.data).toEqual([]);
  });

  it('never interrupts on Ctrl+Shift+C with an empty selection', async () => {
    await setup('COPY-CASE-EXPLICIT-EMPTY', false);
    await page.keyboard.press('Control+Shift+C');
    const res = await outcome();
    expect(res.data).toEqual([]);
    expect(res.clipboard).toBe('SENTINEL');
  });

  it('restores the plain interrupt when the shortcut is disabled', async () => {
    await setup('COPY-CASE-DISABLED', true, { 'copy-selection': { disabled: true } });
    await page.keyboard.press('Control+c');
    const res = await outcome();
    expect(res.data).toEqual(['\x03']);
    expect(res.clipboard).toBe('SENTINEL');
  });

  it('follows a rebind, and Ctrl+C goes back to pure interrupt', async () => {
    await setup('COPY-CASE-REBOUND', true, { 'copy-selection': { bindings: [{ modifiers: ['alt'], key: 'y' }] } });
    await page.keyboard.press('Alt+y');
    const rebound = await outcome();
    expect(rebound.clipboard).toBe('COPY-CASE-REBOUND');
    expect(rebound.data).toEqual([]);

    await setup('COPY-CASE-REBOUND-2', true, { 'copy-selection': { bindings: [{ modifiers: ['alt'], key: 'y' }] } });
    await page.keyboard.press('Control+c');
    const res = await outcome();
    expect(res.data).toEqual(['\x03']);
  });

  it('leaves Ctrl+V on the paste trap', async () => {
    await setup('COPY-CASE-PASTE', false);
    await page.keyboard.press('Control+v');
    const res = await outcome();
    expect(res.data.join('')).toContain('SENTINEL'); // pasted text, not ^V
    expect(res.data.join('')).not.toContain('\x16');
  });

  it('recovers explicit keyCode 229 input once when the helper textarea never mutates', async () => {
    await setup('KEYCODE-229-RECOVERY', false);
    const result = await page.evaluate(async () => {
      const app = (window as any).app;
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      const originalSessionId = app.activeSessionId;
      const originalLocalEcho = app._localEchoEnabled;
      const originalSendInput = app._sendInputAsync;
      const originalPendingInput = app._pendingInput;
      const originalLastKeystrokeTime = app._lastKeystrokeTime;
      const sent: string[] = [];
      const dispatch229 = (key: string) => {
        for (const type of ['keydown', 'keyup']) {
          const event = new KeyboardEvent(type, {
            key,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          Object.defineProperties(event, { keyCode: { value: 229 }, which: { value: 229 } });
          textarea.dispatchEvent(event);
        }
      };

      try {
        app.activeSessionId = 'cod388-browser-regression';
        app._localEchoEnabled = false;
        app._pendingInput = '';
        app._lastKeystrokeTime = 0;
        app._sendInputAsync = (_sessionId: string, data: string) => sent.push(data);
        textarea.focus();

        dispatch229('x');
        await new Promise((resolveWait) => setTimeout(resolveWait, 30));
        const afterRecovery = [...sent];

        // A browser that supplies its canonical input late must not duplicate
        // the character already recovered for this key token.
        textarea.dispatchEvent(
          new InputEvent('beforeinput', { data: 'x', inputType: 'insertText', bubbles: true, composed: true })
        );
        textarea.value = 'x';
        textarea.dispatchEvent(
          new InputEvent('input', { data: 'x', inputType: 'insertText', bubbles: true, composed: true })
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 0));
        const afterLateInput = [...sent];

        dispatch229('Enter');
        await new Promise((resolveWait) => setTimeout(resolveWait, 30));
        const final = [...sent];

        // Two 229 candidates can overlap while the main thread is busy. A
        // canonical value for the first must resolve that candidate without
        // cancelling the second candidate's fallback.
        const overlapStart = sent.length;
        dispatch229('a');
        dispatch229('b');
        const busyUntil = performance.now() + 25;
        while (performance.now() < busyUntil) {
          // Deliberately hold the browser task so both xterm/fallback timers
          // remain queued while canonical input for `a` is prepared.
        }
        app.terminal._core.coreService.triggerDataEvent('a', true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 30));
        return { afterRecovery, afterLateInput, final, overlap: sent.slice(overlapStart) };
      } finally {
        app.activeSessionId = originalSessionId;
        app._localEchoEnabled = originalLocalEcho;
        app._sendInputAsync = originalSendInput;
        app._pendingInput = originalPendingInput;
        app._lastKeystrokeTime = originalLastKeystrokeTime;
        textarea.value = '';
      }
    });

    expect(result).toEqual({
      afterRecovery: ['x'],
      afterLateInput: ['x'],
      final: ['x', '\r'],
      overlap: ['a', 'b'],
    });
  });

  it('forwards full-width punctuation after a Chinese IME composition', async () => {
    await setup('IME-PUNCTUATION', false);
    const desktopChunks = await captureImeInput(page);
    expect(desktopChunks.join('')).toBe('中文' + IME_PUNCTUATION);

    const touchContext = await browser.newContext({ hasTouch: true });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      const touchChunks = await captureImeInput(touchPage);
      expect(touchChunks.join('')).toBe('中文' + IME_PUNCTUATION);
    } finally {
      await touchContext.close();
    }
  });
});
