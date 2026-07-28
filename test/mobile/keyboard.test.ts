// Port 3200 - Virtual keyboard simulation tests
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Page, BrowserContext } from 'playwright';
import { PORTS, KEYBOARD, SELECTORS, BODY_CLASSES, WAIT } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, getBrowser, closeAllBrowsers } from './helpers/browser.js';
import {
  showKeyboard,
  hideKeyboard,
  showKeyboardViaCDP,
  hideKeyboardViaCDP,
  showKeyboardViaMock,
  hideKeyboardViaMock,
  showKeyboardViaDOM,
  hideKeyboardViaDOM,
  setupViewportMock,
} from './helpers/keyboard-sim.js';
import { getCDP, setVisualViewportHeight } from './helpers/cdp.js';
import {
  assertHasClass,
  assertNotHasClass,
  assertVisible,
  assertHidden,
  getCSSProperty,
} from './helpers/assertions.js';
import { DEVICE_REGISTRY, REPRESENTATIVE_DEVICES } from './devices.js';
import type { WebServer } from '../src/web/server.js';

const PORT = PORTS.KEYBOARD;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Page-global access helpers ───
// KeyboardHandler is a `const` in app.js — NOT on `window`.
// Use string-based page.evaluate() to access it in the global lexical scope.

async function getKeyboardVisible(page: Page): Promise<boolean | undefined> {
  return page.evaluate(`
    typeof KeyboardHandler !== 'undefined' ? KeyboardHandler.keyboardVisible : undefined
  `);
}

async function getKeyboardState(page: Page) {
  return page.evaluate(`({
    exists: typeof KeyboardHandler !== 'undefined',
    keyboardVisible: typeof KeyboardHandler !== 'undefined' ? KeyboardHandler.keyboardVisible : undefined,
    hasViewportHandler: typeof KeyboardHandler !== 'undefined' ? KeyboardHandler._viewportResizeHandler != null : false,
    hasHandleViewportResize: typeof KeyboardHandler !== 'undefined' ? typeof KeyboardHandler.handleViewportResize === 'function' : false,
    initialViewportHeight: typeof KeyboardHandler !== 'undefined' ? KeyboardHandler.initialViewportHeight : 0,
  })`) as Promise<{
    exists: boolean;
    keyboardVisible: boolean | undefined;
    hasViewportHandler: boolean;
    hasHandleViewportResize: boolean;
    initialViewportHeight: number;
  }>;
}

describe('Virtual Keyboard', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await stopTestServer(server);
    await closeAllBrowsers();
  });

  // ── Layer 1 - CDP Metrics Override (Chromium) ──────────────────────────

  describe('Layer 1 - CDP Metrics Override (Chromium)', () => {
    let page: Page;
    let context: BrowserContext;
    const device = REPRESENTATIVE_DEVICES['standard-phone']; // iPhone 14 Pro

    beforeEach(async () => {
      const result = await createDevicePage(device, BASE_URL, 'chromium');
      page = result.page;
      context = result.context;
    });

    afterEach(async () => {
      await context.close();
    });

    it('fires real visualViewport resize event', async () => {
      const success = await showKeyboardViaCDP(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      expect(success).toBe(true);

      const visible = await getKeyboardVisible(page);
      expect(visible).toBe(true);
    });

    it('adds keyboard-visible class to body', async () => {
      await showKeyboardViaCDP(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await assertHasClass(page, 'body', BODY_CLASSES.KEYBOARD_VISIBLE);
    });

    it('show threshold: viewport shrink >150px triggers keyboard', async () => {
      // Shrink by 151px — should trigger
      await showKeyboardViaCDP(page, KEYBOARD.SHOW_THRESHOLD + 1);
      const visible = await getKeyboardVisible(page);
      expect(visible).toBe(true);
    });

    it('hide threshold: viewport shrink <100px triggers hide', async () => {
      // Show keyboard first
      await showKeyboardViaCDP(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      expect(await getKeyboardVisible(page)).toBe(true);

      // Restore viewport (hide keyboard via CDP)
      await hideKeyboardViaCDP(page);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      expect(await getKeyboardVisible(page)).toBe(false);
    });

    it('small viewport changes (<150px) do not trigger keyboard', async () => {
      // Shrink by only 100px — below 150px threshold
      const cdp = await getCDP(page);
      const viewport = page.viewportSize()!;
      await setVisualViewportHeight(cdp, viewport.width, viewport.height - 100, 1);
      await page.waitForTimeout(300);

      const visible = await getKeyboardVisible(page);
      expect(visible).toBe(false);
    });

    it('accumulates incremental keyboard-animation shrink without lowering its baseline', async () => {
      const initial = await getKeyboardState(page);
      const baseline = initial.initialViewportHeight;

      for (const shrink of [70, 140]) {
        await page.evaluate(`(function(height, fullHeight) {
          var vv = window.visualViewport;
          Object.defineProperty(vv, 'height', {
            get: function() { return height; },
            configurable: true,
          });
          Object.defineProperty(window, 'innerHeight', {
            get: function() { return fullHeight; },
            configurable: true,
          });
          KeyboardHandler.handleViewportResize();
        })(${baseline - shrink}, ${baseline})`);
        expect(await getKeyboardVisible(page)).toBe(false);
        expect((await getKeyboardState(page)).initialViewportHeight).toBe(baseline);
      }

      await page.evaluate(`(function(height) {
        var vv = window.visualViewport;
        Object.defineProperty(vv, 'height', {
          get: function() { return height; },
          configurable: true,
        });
        KeyboardHandler.handleViewportResize();
      })(${baseline - 210})`);

      expect(await getKeyboardVisible(page)).toBe(true);
      await assertHasClass(page, 'body', BODY_CLASSES.KEYBOARD_VISIBLE);
    });

    it('dismissing keyboard restores original state', async () => {
      // Show
      await showKeyboardViaCDP(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await assertHasClass(page, 'body', BODY_CLASSES.KEYBOARD_VISIBLE);

      // Hide
      await hideKeyboardViaCDP(page);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      await assertNotHasClass(page, 'body', BODY_CLASSES.KEYBOARD_VISIBLE);

      // Verify resetLayout was called — toolbar transform should be cleared
      const transform = await getCSSProperty(page, SELECTORS.TOOLBAR, 'transform');
      expect(transform === 'none' || transform === '').toBe(true);
    });
  });

  // ── Layer 2 - VisualViewport Mock (cross-engine) ──────────────────────

  describe('Layer 2 - VisualViewport Mock (cross-engine)', () => {
    const device = REPRESENTATIVE_DEVICES['standard-phone'];

    it('mock visualViewport.height triggers handleViewportResize', async () => {
      const { context, page } = await createDevicePage(device, 'about:blank', 'chromium');
      try {
        await setupViewportMock(page);
        await page.goto(BASE_URL, { waitUntil: WAIT.DOM_CONTENT_LOADED });
        await page.waitForTimeout(2000);

        const success = await showKeyboardViaMock(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        expect(success).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('works on Chromium', async () => {
      const { context, page } = await createDevicePage(device, 'about:blank', 'chromium');
      try {
        await setupViewportMock(page);
        await page.goto(BASE_URL, { waitUntil: WAIT.DOM_CONTENT_LOADED });
        await page.waitForTimeout(2000);

        const success = await showKeyboardViaMock(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        expect(success).toBe(true);

        const hasClass = await page.evaluate(() => document.body.classList.contains('keyboard-visible'));
        expect(hasClass).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('works on WebKit', async () => {
      let context: BrowserContext | undefined;
      try {
        const result = await createDevicePage(device, 'about:blank', 'webkit');
        context = result.context;
        await setupViewportMock(result.page);
        await result.page.goto(BASE_URL, { waitUntil: WAIT.DOM_CONTENT_LOADED });
        await result.page.waitForTimeout(2000);

        const success = await showKeyboardViaMock(result.page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        expect(success).toBe(true);
      } catch (e: unknown) {
        // Skip if WebKit libraries not installed on this system
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Missing libraries') || msg.includes('browserType.launch')) {
          console.log('Skipping WebKit test: system libraries not installed');
          return;
        }
        throw e;
      } finally {
        if (context) await context.close();
      }
    });
  });

  // ── Layout Behavior ───────────────────────────────────────────────────

  describe('Layout Behavior', () => {
    let page: Page;
    let context: BrowserContext;
    const device = REPRESENTATIVE_DEVICES['standard-phone'];

    beforeEach(async () => {
      const result = await createDevicePage(device, BASE_URL, 'chromium');
      page = result.page;
      context = result.context;
    });

    afterEach(async () => {
      await context.close();
    });

    it('hides Codeman control rows so the terminal reaches the phone keyboard edge', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const layout = await page.evaluate(() => {
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement | null;
        const terminal = document.getElementById('terminalContainer');
        const appEl = document.querySelector('.app') as HTMLElement | null;
        const main = document.querySelector('.main') as HTMLElement | null;
        const toolbarRect = toolbar?.getBoundingClientRect();
        const accessoryRect = accessory?.getBoundingClientRect();
        const terminalRect = terminal?.getBoundingClientRect();
        const appRect = appEl?.getBoundingClientRect();
        return {
          toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : '',
          accessoryDisplay: accessory ? getComputedStyle(accessory).display : '',
          toolbarTransform: toolbar?.style.transform ?? '',
          accessoryTransform: (accessory as HTMLElement | null)?.style.transform ?? '',
          toolbarHeight: toolbarRect?.height ?? 0,
          accessoryHeight: accessoryRect?.height ?? 0,
          terminalBottom: terminalRect?.bottom ?? 0,
          appBottom: appRect?.bottom ?? 0,
          mainPadding: main ? parseFloat(getComputedStyle(main).paddingBottom) : -1,
        };
      });
      expect(layout.toolbarDisplay).toBe('none');
      expect(layout.accessoryDisplay).toBe('none');
      expect(layout.toolbarTransform).toBe('');
      expect(layout.accessoryTransform).toBe('');
      expect(layout.toolbarHeight).toBe(0);
      expect(layout.accessoryHeight).toBe(0);
      expect(layout.mainPadding).toBe(0);
      expect(Math.abs(layout.terminalBottom - layout.appBottom)).toBeLessThanOrEqual(1);
    });

    it('keeps the accessory bar hidden on phones while the keyboard is open', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const accessoryState = await page.evaluate(() => {
        const bar = document.querySelector('.keyboard-accessory-bar');
        return {
          hasVisibleClass: bar?.classList.contains('visible') ?? false,
          display: bar ? getComputedStyle(bar).display : '',
        };
      });
      expect(accessoryState.hasVisibleClass).toBe(false);
      expect(accessoryState.display).toBe('none');
    });

    it('copies a whole raw response chunk on double-click without stealing control actions', async () => {
      const state = await page.evaluate(async () => {
        const body = document.createElement('div') as HTMLDivElement & {
          _codemanCopyText?: string;
          _rvCopyFeedbackTimer?: ReturnType<typeof setTimeout>;
        };
        body.className = 'response-viewer-body';

        const reply = document.createElement('div') as HTMLDivElement & {
          _codemanCopyText?: string;
          _rvCopyFeedbackTimer?: ReturnType<typeof setTimeout>;
        };
        reply.className = 'rv-message rv-msg-assistant';
        reply._codemanCopyText = '**Raw reply**\n\n```js\nconst answer = 42;\n```';
        reply.innerHTML =
          '<div class="rv-role">Claude</div>' +
          '<div class="rv-text"><p><strong>Rendered reply</strong></p></div>' +
          '<button type="button">Existing action</button>';
        body.appendChild(reply);
        document.body.appendChild(body);

        const copied: string[] = [];
        const originalCopy = app._copyText;
        const originalToast = app.showToast;
        const originalFeedback = MobileTerminalControls.feedback;
        app._copyText = async (text: string) => {
          copied.push(text);
          return true;
        };
        app.showToast = () => {};
        MobileTerminalControls.feedback = () => {};
        app._bindResponseViewerInteractions(body);

        const replyText = reply.querySelector('.rv-text')!;
        const replyDispatchResult = replyText.dispatchEvent(
          new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            detail: 2,
          })
        );
        await Promise.resolve();

        reply.querySelector('button')!.dispatchEvent(
          new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            detail: 2,
          })
        );
        await Promise.resolve();

        const replyFeedback = reply.classList.contains('rv-copy-feedback');
        const touchAction = getComputedStyle(reply).touchAction;
        if (reply._rvCopyFeedbackTimer) clearTimeout(reply._rvCopyFeedbackTimer);

        body.innerHTML = '<p>Rendered last response</p>';
        body._codemanCopyText = '# Raw last response';
        body.querySelector('p')!.dispatchEvent(
          new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            detail: 2,
          })
        );
        await Promise.resolve();

        if (body._rvCopyFeedbackTimer) clearTimeout(body._rvCopyFeedbackTimer);
        app._copyText = originalCopy;
        app.showToast = originalToast;
        MobileTerminalControls.feedback = originalFeedback;
        body.remove();

        return {
          copied,
          replyDefaultPrevented: !replyDispatchResult,
          replyFeedback,
          touchAction,
        };
      });

      expect(state).toEqual({
        copied: ['**Raw reply**\n\n```js\nconst answer = 42;\n```', '# Raw last response'],
        replyDefaultPrevented: true,
        replyFeedback: true,
        touchAction: 'manipulation',
      });
    });

    it('copies a whole response chunk from two real mobile touch taps', async () => {
      await page.evaluate(() => {
        const testWindow = window as typeof window & {
          __rvDoubleTapCopyTest?: {
            copied: string[];
            originalCopy: typeof app._copyText;
            originalToast: typeof app.showToast;
            originalFeedback: typeof MobileTerminalControls.feedback;
          };
        };
        const body = document.createElement('div');
        body.id = 'rv-double-tap-copy-test';
        body.className = 'response-viewer-body';
        body.style.cssText =
          'position:fixed;inset:16px auto auto 16px;width:280px;height:120px;z-index:2147483647;background:#111';

        const reply = document.createElement('div') as HTMLDivElement & {
          _codemanCopyText?: string;
        };
        reply.className = 'rv-message rv-msg-assistant';
        reply._codemanCopyText = 'Raw touch reply';
        reply.innerHTML = '<div class="rv-text">Rendered touch reply</div>';
        body.appendChild(reply);
        document.body.appendChild(body);

        testWindow.__rvDoubleTapCopyTest = {
          copied: [],
          originalCopy: app._copyText,
          originalToast: app.showToast,
          originalFeedback: MobileTerminalControls.feedback,
        };
        app._copyText = async (text: string) => {
          testWindow.__rvDoubleTapCopyTest!.copied.push(text);
          return true;
        };
        app.showToast = () => {};
        MobileTerminalControls.feedback = () => {};
        app._bindResponseViewerInteractions(body);
      });

      try {
        const replyText = page.locator('#rv-double-tap-copy-test .rv-text');
        await replyText.tap();
        await page.waitForTimeout(80);
        await replyText.tap();
        await page.waitForTimeout(50);

        const copied = await page.evaluate(() => {
          const testWindow = window as typeof window & {
            __rvDoubleTapCopyTest?: { copied: string[] };
          };
          return testWindow.__rvDoubleTapCopyTest?.copied ?? [];
        });
        expect(copied).toEqual(['Raw touch reply']);
      } finally {
        await page.evaluate(() => {
          const testWindow = window as typeof window & {
            __rvDoubleTapCopyTest?: {
              originalCopy: typeof app._copyText;
              originalToast: typeof app.showToast;
              originalFeedback: typeof MobileTerminalControls.feedback;
            };
          };
          const state = testWindow.__rvDoubleTapCopyTest;
          if (state) {
            app._copyText = state.originalCopy;
            app.showToast = state.originalToast;
            MobileTerminalControls.feedback = state.originalFeedback;
          }
          document.getElementById('rv-double-tap-copy-test')?.remove();
          delete testWindow.__rvDoubleTapCopyTest;
        });
      }
    });

    it('clears main padding when the phone keyboard opens', async () => {
      const initialPadding = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        return main ? getComputedStyle(main).paddingBottom : '0px';
      });
      const initialPx = parseFloat(initialPadding) || 0;

      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const newPadding = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        return main ? main.style.paddingBottom : '';
      });
      const newPx = parseFloat(newPadding) || 0;
      expect(initialPx).toBeGreaterThan(0);
      expect(newPx).toBe(0);
    });

    it('locks the handheld app as soon as terminal focus requests the keyboard', async () => {
      const state = await page.evaluate(() => {
        const focusTarget = document.createElement('button');
        document.body.appendChild(focusTarget);
        focusTarget.focus();
        KeyboardHandler.keyboardVisible = false;
        KeyboardHandler._terminalInputRequested = false;
        document.body.classList.remove('keyboard-visible', 'keyboard-opening');

        app.terminal.focus();

        const appElement = document.querySelector('.app');
        const result = {
          terminalRequested: KeyboardHandler._terminalInputRequested,
          openingClass: document.body.classList.contains('keyboard-opening'),
          appPosition: appElement ? getComputedStyle(appElement).position : '',
        };
        clearTimeout(KeyboardHandler._keyboardOpeningTimer);
        KeyboardHandler._keyboardOpeningTimer = null;
        focusTarget.remove();
        return result;
      });

      expect(state).toEqual({
        terminalRequested: true,
        openingClass: true,
        appPosition: 'fixed',
      });
    });

    it('marks keyboard-driven resizing as active viewport control', async () => {
      const call = await page.evaluate(`(async function() {
        var originalSendResize = app.sendResize;
        var captured = null;
        app.activeSessionId = 'mobile-keyboard-takeover';
        app.sendResize = function(sessionId, options) {
          captured = { sessionId: sessionId, options: options };
          return Promise.resolve(false);
        };
        try {
          KeyboardHandler._sendTerminalResize();
          await Promise.resolve();
          return captured;
        } finally {
          app.sendResize = originalSendResize;
        }
      })()`);

      expect(call).toEqual({
        sessionId: 'mobile-keyboard-takeover',
        options: { takeControl: true, refit: false },
      });
    });

    it('does not reserve the keyboard height as visible terminal dead space', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const layout = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        const appEl = document.querySelector('.app') as HTMLElement | null;
        const terminalWrap = document.querySelector('.terminal-wrap') as HTMLElement | null;
        const terminal = document.getElementById('terminalContainer');
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement | null;
        return {
          appHeight: appEl?.getBoundingClientRect().height ?? 0,
          appBottom: appEl?.getBoundingClientRect().bottom ?? 0,
          mainPaddingBottom: main ? parseFloat(main.style.paddingBottom || '0') : 0,
          terminalHeight: terminalWrap?.getBoundingClientRect().height ?? 0,
          terminalBottom: terminal?.getBoundingClientRect().bottom ?? 0,
          toolbarHeight: toolbar?.getBoundingClientRect().height ?? 0,
          accessoryHeight: accessory?.getBoundingClientRect().height ?? 0,
          visualViewportHeight: window.visualViewport?.height ?? window.innerHeight,
        };
      });

      expect(layout.appHeight).toBeLessThanOrEqual(layout.visualViewportHeight + 2);
      expect(layout.mainPaddingBottom).toBe(0);
      expect(layout.toolbarHeight + layout.accessoryHeight).toBe(0);
      expect(Math.abs(layout.terminalBottom - layout.appBottom)).toBeLessThanOrEqual(1);
      expect(layout.terminalHeight).toBeGreaterThan(160);
    });

    it('resetLayout clears transforms on hide', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      await hideKeyboard(page);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      // Toolbar transform should be cleared
      const toolbarTransform = await page.evaluate(() => {
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        return toolbar?.style.transform ?? '';
      });
      expect(toolbarTransform).toBe('');

      const mainPadding = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        return main?.style.paddingBottom ?? '';
      });
      expect(mainPadding).toBe('');
    });

    it('reveals and focuses the live terminal input as soon as its keyboard opens', async () => {
      const state = await page.evaluate(() => {
        const originalScrollToBottom = app.terminal.scrollToBottom.bind(app.terminal);
        const originalFocusInput = app._focusMobileTerminalInput.bind(app);
        let bottomRestores = 0;
        let inputFocusRestores = 0;
        app.terminal.scrollToBottom = () => {
          bottomRestores++;
        };
        app._focusMobileTerminalInput = () => {
          inputFocusRestores++;
        };
        app._terminalScrollLocked = true;
        app._wasAtBottomBeforeWrite = false;
        KeyboardHandler.keyboardVisible = true;
        KeyboardHandler._terminalInputRequested = true;
        document.body.classList.add('keyboard-visible');

        KeyboardHandler.onKeyboardShow();
        const immediate = {
          bottomRestores,
          inputFocusRestores,
          scrollLocked: app._terminalScrollLocked,
          followsBottom: app._wasAtBottomBeforeWrite,
        };

        clearTimeout(KeyboardHandler._viewportSettleTimer);
        KeyboardHandler._viewportSettleTimer = null;
        KeyboardHandler._settleScrollToBottom = false;
        KeyboardHandler._settleFocusInput = false;
        app.terminal.scrollToBottom = originalScrollToBottom;
        app._focusMobileTerminalInput = originalFocusInput;
        return immediate;
      });

      expect(state).toEqual({
        bottomRestores: 1,
        inputFocusRestores: 1,
        scrollLocked: false,
        followsBottom: true,
      });
    });

    it('coalesces keyboard animation frames into one final terminal fit', async () => {
      const result = await page.evaluate(async () => {
        const originalFit = app.fitAddon.fit.bind(app.fitAddon);
        const originalSendResize = KeyboardHandler._sendTerminalResize.bind(KeyboardHandler);
        const originalScrollToBottom = app.terminal.scrollToBottom.bind(app.terminal);
        const originalFocusInput = app._focusMobileTerminalInput.bind(app);
        let fits = 0;
        let resizes = 0;
        let bottomRestores = 0;
        let inputFocusRestores = 0;
        app.fitAddon.fit = () => {
          fits++;
        };
        KeyboardHandler._sendTerminalResize = () => {
          resizes++;
        };
        app.terminal.scrollToBottom = () => {
          bottomRestores++;
        };
        app._focusMobileTerminalInput = () => {
          inputFocusRestores++;
        };
        app._terminalScrollLocked = true;
        app._wasAtBottomBeforeWrite = false;
        KeyboardHandler.keyboardVisible = true;
        document.body.classList.add('keyboard-visible');

        KeyboardHandler._scheduleViewportSettle({ scrollToBottom: true, focusInput: true });
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler._scheduleViewportSettle();
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler._scheduleViewportSettle();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const beforeFinalSettle = { fits, resizes, bottomRestores, inputFocusRestores };
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.VIEWPORT_SETTLE_MS));
        const afterFinalSettle = {
          fits,
          resizes,
          bottomRestores,
          inputFocusRestores,
          scrollLocked: app._terminalScrollLocked,
          followsBottom: app._wasAtBottomBeforeWrite,
        };

        app.fitAddon.fit = originalFit;
        KeyboardHandler._sendTerminalResize = originalSendResize;
        app.terminal.scrollToBottom = originalScrollToBottom;
        app._focusMobileTerminalInput = originalFocusInput;
        return { beforeFinalSettle, afterFinalSettle };
      });

      expect(result.beforeFinalSettle).toEqual({
        fits: 0,
        resizes: 0,
        bottomRestores: 0,
        inputFocusRestores: 0,
      });
      expect(result.afterFinalSettle).toEqual({
        fits: 1,
        resizes: 1,
        bottomRestores: 1,
        inputFocusRestores: 1,
        scrollLocked: false,
        followsBottom: true,
      });
    });

    it('does not steal focus or resize the PTY when the keyboard belongs to a form field', async () => {
      const state = await page.evaluate(async () => {
        const originalFocusInput = app._focusMobileTerminalInput.bind(app);
        const originalScrollToBottom = app.terminal.scrollToBottom.bind(app.terminal);
        const originalSendResize = KeyboardHandler._sendTerminalResize.bind(KeyboardHandler);
        let inputFocusRestores = 0;
        let bottomRestores = 0;
        let resizes = 0;
        app._focusMobileTerminalInput = () => {
          inputFocusRestores++;
        };
        app.terminal.scrollToBottom = () => {
          bottomRestores++;
        };
        KeyboardHandler._sendTerminalResize = () => {
          resizes++;
        };
        KeyboardHandler.keyboardVisible = true;
        KeyboardHandler._terminalInputRequested = false;
        document.body.classList.add('keyboard-visible');

        KeyboardHandler.onKeyboardShow();
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.VIEWPORT_SETTLE_MS + 20));

        app._focusMobileTerminalInput = originalFocusInput;
        app.terminal.scrollToBottom = originalScrollToBottom;
        KeyboardHandler._sendTerminalResize = originalSendResize;
        return { inputFocusRestores, bottomRestores, resizes };
      });

      expect(state).toEqual({
        inputFocusRestores: 0,
        bottomRestores: 0,
        resizes: 0,
      });
    });

    it('accessory bar has the unified terminal-control action set', async () => {
      const actions = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.keyboard-accessory-bar [data-action]')).map(
          (button) => (button as HTMLElement).dataset.action
        );
      });
      expect(actions).toEqual([
        'esc',
        'arrow-left',
        'scroll-up',
        'opt-enter',
        'scroll-down',
        'arrow-right',
        'tab',
        'shift-tab',
        'paste',
        'pick-path',
        'clear-input',
        'effort-max',
        'ctrl-o',
        'init',
        'clear',
        'compact',
        'dismiss',
      ]);
    });

    it('double-tap confirm on /clear button', async () => {
      // Make accessory bar visible
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      // handleAction() early-returns if app.activeSessionId is falsy — mock it
      await page.evaluate(`
        if (typeof app !== 'undefined') app.activeSessionId = 'test-session';
      `);

      // Click via JS since the button is positioned outside the viewport
      // by the keyboard CSS transform
      await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(100);

      // Should enter confirming state
      const confirming = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]');
        return btn?.classList.contains('confirming') ?? false;
      });
      expect(confirming).toBe(true);

      // Button text should change to "Tap again"
      const text = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]');
        return btn?.textContent?.trim();
      });
      expect(text).toBe('Tap again');
    });

    it('double-tap expires after 2s', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      await page.evaluate(`
        if (typeof app !== 'undefined') app.activeSessionId = 'test-session';
      `);

      // First tap on clear via JS
      await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(100);

      // Verify confirming state
      const beforeExpiry = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]');
        return btn?.classList.contains('confirming') ?? false;
      });
      expect(beforeExpiry).toBe(true);

      // Wait for confirm timeout to expire (2s + buffer)
      await page.waitForTimeout(KEYBOARD.CONFIRM_TIMEOUT + 500);

      const afterExpiry = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]');
        return btn?.classList.contains('confirming') ?? false;
      });
      expect(afterExpiry).toBe(false);
    });

    it('dismiss button blurs active element', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      // Focus an element
      await page.evaluate(() => {
        const el = document.querySelector('.terminal-container') || document.querySelector('textarea') || document.body;
        if (el instanceof HTMLElement) el.focus();
      });

      // Click dismiss via JS (positioned off-screen by keyboard transform)
      await page.evaluate(() => {
        const btn = document.querySelector('[data-action="dismiss"]') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(100);

      const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
      expect(activeTag).toBe('BODY');
    });

    it('keeps keyboard fits inside the coalesced keyboard settle', async () => {
      // Inject spy on fitAddon.fit
      await page.evaluate(`
        if (typeof app !== 'undefined' && app.fitAddon) {
          window.__fitCallCount = 0;
          window.__fitCallStacks = [];
          var orig = app.fitAddon.fit;
          app.fitAddon.fit = function () {
            window.__fitCallCount++;
            window.__fitCallStacks.push(String(new Error().stack || ''));
            try { orig.call(this); } catch(e) {}
          };
        }
      `);

      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      // Wait for the setTimeout(150) in onKeyboardShow
      await page.waitForTimeout(300);

      const calls = await page.evaluate(() => ({
        count: (window as any).__fitCallCount ?? 0,
        stacks: (window as any).__fitCallStacks ?? [],
      }));
      // One settled fit plus, when needed, one synchronous row-gap correction.
      expect(calls.count).toBeGreaterThanOrEqual(1);
      expect(calls.count).toBeLessThanOrEqual(2);
      expect(calls.stacks.every((stack: string) => stack.includes('mobile-handlers.js'))).toBe(true);
    });

    it('keeps xterm helper textarea focusable near the terminal cursor on touch devices', async () => {
      const styles = await page.evaluate(async () => {
        await new Promise<void>((resolve) => app.terminal.write('prompt', resolve));
        app.terminal.focus();
        app._syncMobileHelperTextareaToCursor?.();
        const textarea = document.querySelector('.xterm-helper-textarea');
        const cursor = document.querySelector('.xterm-cursor');
        const screen = document.querySelector('.xterm-screen');
        if (!(textarea instanceof HTMLElement) || !(cursor instanceof HTMLElement) || !(screen instanceof HTMLElement))
          return null;
        const cs = getComputedStyle(textarea);
        const cursorRect = cursor.getBoundingClientRect();
        const screenRect = screen.getBoundingClientRect();
        return {
          left: cs.left,
          top: cs.top,
          width: cs.width,
          height: cs.height,
          zIndex: cs.zIndex,
          opacity: cs.opacity,
          cursorLeft: `${Math.max(0, Math.round(cursorRect.left - screenRect.left))}px`,
          cursorTop: `${Math.max(0, Math.round(cursorRect.top - screenRect.top))}px`,
        };
      });

      expect(styles).not.toBeNull();
      expect(styles?.left).toBe(styles?.cursorLeft);
      expect(styles?.top).toBe(styles?.cursorTop);
      expect(styles?.cursorLeft).not.toBe('0px');
      expect(styles?.width).toBe('1px');
      expect(styles?.height).toBe('1px');
      expect(styles?.opacity).toBe('0');
      expect(Number(styles?.zIndex)).toBeGreaterThanOrEqual(0);
    });

    it('routes CJK textarea typing directly to session input', async () => {
      await page.evaluate(() => {
        window.__sentInputs = [];
        const sessionId = 'mobile-cjk-local-echo-test';
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, { id: sessionId, mode: 'codex' });
        app._localEchoEnabled = true;
        app._localEchoOverlay = {
          pendingText: '',
          appendText(text: string) {
            this.pendingText += text;
          },
          removeChar() {
            this.pendingText = this.pendingText.slice(0, -1);
            return 'pending';
          },
          clear() {
            this.pendingText = '';
          },
          suppressBufferDetection() {},
        };
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._serverCjkOverride = true;
        app._updateCjkInputState?.();
      });

      await page.locator('#cjkInput').focus();
      await page.keyboard.type('hello');

      const beforeEnter = await page.evaluate(() => ({
        visibleText: (document.getElementById('cjkInput') as HTMLTextAreaElement).value.replace(/\u200B/g, ''),
        pendingText: app._localEchoOverlay.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(beforeEnter.visibleText).toBe('');
      expect(beforeEnter.pendingText).toBe('');
      expect(beforeEnter.sentInputs.join('')).toBe('hello');

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__sentInputs?.join('') === 'hello\r');
      const afterEnter = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(afterEnter.pendingText).toBe('');
      expect(afterEnter.sentInputs.join('')).toBe('hello\r');
    });

    it('shows the CJK textarea on mobile for server override only inside an active session', async () => {
      const state = await page.evaluate(() => {
        const input = document.getElementById('cjkInput');
        if (!(input instanceof HTMLElement)) return null;

        // Welcome screen (no active session): even with the server override on, the
        // fixed-position textarea must stay hidden so it doesn't float over the overlay.
        app.activeSessionId = null;
        app._serverCjkOverride = true;
        app._updateCjkInputState();
        const onWelcomeDisplay = getComputedStyle(input).display;

        // Entering a session reveals it.
        app.activeSessionId = 'cjk-server-override-test';
        app._updateCjkInputState();
        const cs = getComputedStyle(input);
        return {
          onWelcomeDisplay,
          display: cs.display,
          position: cs.position,
          bottom: cs.bottom,
          zIndex: cs.zIndex,
          ariaHidden: input.getAttribute('aria-hidden'),
        };
      });

      expect(state).not.toBeNull();
      expect(state?.onWelcomeDisplay).toBe('none');
      expect(state?.display).not.toBe('none');
      expect(state?.position).toBe('fixed');
      expect(Number(state?.zIndex)).toBeGreaterThan(50);
      expect(state?.ariaHidden).toBe('false');
    });

    it('hides the CJK textarea by default on phones', async () => {
      const state = await page.evaluate(() => {
        localStorage.removeItem(app.getSettingsStorageKey());
        app._cachedAppSettings = null;
        app._updateCjkInputState();

        const input = document.getElementById('cjkInput');
        if (!(input instanceof HTMLElement)) return null;
        const cs = getComputedStyle(input);
        return {
          display: cs.display,
          position: cs.position,
          bodyClass: document.body.classList.contains('cjk-input-visible'),
        };
      });

      expect(state).not.toBeNull();
      expect(state?.display).toBe('none');
      expect(state?.bodyClass).toBe(false);
    });

    it('keeps the CJK textarea hidden even when old phone settings enabled it', async () => {
      const state = await page.evaluate(() => {
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();

        const input = document.getElementById('cjkInput');
        if (!(input instanceof HTMLElement)) return null;
        const cs = getComputedStyle(input);
        return {
          display: cs.display,
          position: cs.position,
          bodyClass: document.body.classList.contains('cjk-input-visible'),
        };
      });

      expect(state).not.toBeNull();
      expect(state?.display).toBe('none');
      expect(state?.bodyClass).toBe(false);
    });

    it('collapses a terminal readback without focusing the hidden textarea', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-readback-tap-test';
        app.sessions.set('mobile-readback-tap-test', {
          id: 'mobile-readback-tap-test',
          mode: 'codex',
          status: 'running',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app.terminal.reset();
        await new Promise<void>((resolve) =>
          app.terminal.write('Agent readback\r\n  tap to collapse\r\n\r\n› ask', resolve)
        );
        app.terminal.focus();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!rect || !cell?.width || !cell?.height) return null;
        return {
          x: rect.left + cell.width * 2,
          y: rect.top + cell.height / 2,
        };
      });
      expect(point).not.toBeNull();

      await page.touchscreen.tap(point!.x, point!.y);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(state.activeClass).not.toContain('xterm-helper-textarea');
      expect(state.sentInputs).toHaveLength(1);
      expect(state.sentInputs[0]).toMatch(/^\x1b\[<0;\d+;1M\x1b\[<0;\d+;1m$/);
    });

    it('prevents Claude subagent status taps from opening the hidden keyboard input', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-claude-subagent-tap-test';
        app.sessions.set('mobile-claude-subagent-tap-test', {
          id: 'mobile-claude-subagent-tap-test',
          mode: 'claude',
          cliVersion: '2.1.220',
          status: 'working',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        app.terminal.reset();
        const statusRow = Math.max(0, app.terminal.rows - 2);
        await new Promise<void>((resolve) =>
          app.terminal.write(
            `${'\r\n'.repeat(statusRow)}• Working (1m 50s • esc to interrupt) · 1 background teammate`,
            resolve
          )
        );
        app.terminal.focus();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!screen || !rect || !cell?.width || !cell?.height) return null;
        const cursorRow = app.terminal.buffer.active.cursorY;
        const x = rect.left + cell.width * 2;
        const y = rect.top + cell.height * (cursorRow + 0.5);
        return {
          x,
          y,
          intent: app._classifyMobileTerminalTap(x, y),
          cursorRow,
          screenBottom: rect.bottom,
        };
      });
      expect(point).toEqual(
        expect.objectContaining({
          intent: 'content',
        })
      );

      const dispatch = await page.evaluate(({ x, y }) => {
        const target = document.querySelector('#terminalContainer .xterm-screen');
        if (!(target instanceof Element)) {
          return { prevented: false, insideTerminal: false, targetClass: null };
        }
        const touch = new Touch({
          identifier: 3,
          target,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
        });
        const allowed = target.dispatchEvent(
          new TouchEvent('touchstart', {
            touches: [touch],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchend', {
            touches: [],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          })
        );
        return {
          prevented: !allowed,
          insideTerminal: Boolean(target.closest('#terminalContainer')),
          targetClass: target.className,
        };
      }, point!);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(dispatch).toEqual(
        expect.objectContaining({
          prevented: true,
          insideTerminal: true,
        })
      );
      expect(state.activeClass).not.toContain('xterm-helper-textarea');
      expect(state.sentInputs).toHaveLength(1);
    });

    it('focuses the terminal helper textarea when the visible prompt is tapped', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-focus-visible-input-test';
        app.sessions.set('mobile-focus-visible-input-test', {
          id: 'mobile-focus-visible-input-test',
          mode: 'codex',
          status: 'running',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app.terminal.reset();
        await new Promise<void>((resolve) =>
          app.terminal.write('Agent readback\r\n  tap to collapse\r\n\r\n› ask', resolve)
        );
        (document.activeElement as HTMLElement | null)?.blur?.();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!rect || !cell?.width || !cell?.height) return null;
        return {
          x: rect.left + cell.width * 2,
          y: rect.top + cell.height * (app.terminal.buffer.active.cursorY + 0.5),
        };
      });
      expect(point).not.toBeNull();

      await page.touchscreen.tap(point!.x, point!.y);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(state.activeClass).toContain('xterm-helper-textarea');
      expect(state.sentInputs).toEqual([]);
    });

    it('focuses the live Claude cursor when a redraw omits the prompt glyph', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-focus-promptless-claude-test';
        app.sessions.set('mobile-focus-promptless-claude-test', {
          id: 'mobile-focus-promptless-claude-test',
          mode: 'claude',
          status: 'running',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('Claude response\r\nready for input', resolve));
        (document.activeElement as HTMLElement | null)?.blur?.();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!rect || !cell?.width || !cell?.height) return null;
        return {
          x: rect.left + cell.width * 2,
          y: rect.top + cell.height * (app.terminal.buffer.active.cursorY + 0.5),
        };
      });
      expect(point).not.toBeNull();

      await page.touchscreen.tap(point!.x, point!.y);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(state.activeClass).toContain('xterm-helper-textarea');
      expect(state.sentInputs).toEqual([]);
    });

    it('keeps terminal touch drag available for scrollback with the visible textarea enabled', async () => {
      const calls = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-touch-scroll-test';
        app.sessions.set('mobile-touch-scroll-test', {
          id: 'mobile-touch-scroll-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._updateCjkInputState();

        const originalScrollLines = app.terminal.scrollLines.bind(app.terminal);
        const scrollCalls: number[] = [];
        app.terminal.scrollLines = (lines: number) => {
          scrollCalls.push(lines);
          return originalScrollLines(lines);
        };

        const target =
          document.querySelector('#terminalContainer .xterm-screen') ?? document.getElementById('terminalContainer');
        if (!target) return scrollCalls;
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const startY = rect.top + Math.min(180, rect.height - 20);
        const endY = startY - 120;

        function createTouch(y: number) {
          return new Touch({
            identifier: 1,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
          });
        }

        target.dispatchEvent(
          new TouchEvent('touchstart', {
            touches: [createTouch(startY)],
            changedTouches: [createTouch(startY)],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchmove', {
            touches: [createTouch(endY)],
            changedTouches: [createTouch(endY)],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchend', {
            touches: [],
            changedTouches: [createTouch(endY)],
            bubbles: true,
            cancelable: true,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        return scrollCalls;
      });

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((lines) => lines !== 0)).toBe(true);
    });

    it('keeps a focused draft visible while a keyboard-open transcript drag reads history', async () => {
      const result = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-focused-draft-scroll-test';
        app.sessions.set('mobile-focused-draft-scroll-test', {
          id: 'mobile-focused-draft-scroll-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        const history = Array.from(
          { length: app.terminal.rows + 20 },
          (_, index) => `conversation line ${index + 1}`
        ).join('\r\n');
        await new Promise<void>((resolve) => app.terminal.write(`${history}\r\n› `, resolve));
        app.terminal.focus();
        app._localEchoOverlay.appendText('draft remains visible');
        KeyboardHandler.keyboardVisible = true;
        KeyboardHandler._terminalInputRequested = true;
        document.body.classList.add('keyboard-visible');

        const target =
          document.querySelector('#terminalContainer .xterm-screen') ?? document.getElementById('terminalContainer');
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const startY = rect.top + Math.min(80, rect.height / 3);
        const endY = Math.min(rect.bottom - 10, startY + 120);

        const createTouch = (y: number) =>
          new Touch({
            identifier: 8,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
          });
        target.dispatchEvent(
          new TouchEvent('touchstart', {
            touches: [createTouch(startY)],
            changedTouches: [createTouch(startY)],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchmove', {
            touches: [createTouch(endY)],
            changedTouches: [createTouch(endY)],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchend', {
            touches: [],
            changedTouches: [createTouch(endY)],
            bubbles: true,
            cancelable: true,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        return {
          keyboardVisible: KeyboardHandler.keyboardVisible,
          terminalFocused: document.activeElement === app.terminal.textarea,
          viewportY: app.terminal.buffer.active.viewportY,
          baseY: app.terminal.buffer.active.baseY,
          pendingText: app._localEchoOverlay.pendingText,
          draftVisible: app._localEchoOverlay.state.visible,
        };
      });

      expect(result).toEqual(
        expect.objectContaining({
          keyboardVisible: true,
          terminalFocused: true,
          pendingText: 'draft remains visible',
          draftVisible: true,
        })
      );
      expect(result!.viewportY).toBeLessThan(result!.baseY);
    });

    it('keeps the previous terminal frame until nonblank Codex output settles', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-keyboard-frame-cover-test';
        app.sessions.set('mobile-keyboard-frame-cover-test', {
          id: 'mobile-keyboard-frame-cover-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('frame before keyboard\r\n› ', resolve));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        KeyboardHandler._beginTerminalFrameCover();
        KeyboardHandler._armTerminalFrameCover();
        const cover = app.terminal.element?.querySelector('.terminal-resize-frame-cover');
        const before = {
          exists: Boolean(cover),
          text: cover?.textContent || '',
        };

        await new Promise<void>((resolve) => app.terminal.write('\x1b[2J\x1b[H', resolve));
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.FRAME_COVER_MIN_MS + 30));
        const survivedBlank = Boolean(app.terminal.element?.querySelector('.terminal-resize-frame-cover'));

        app.batchTerminalWrite('frame after keyboard\r\n› ');
        await new Promise((resolve) => setTimeout(resolve, 100));
        const survivedCodexQuietWindow = Boolean(app.terminal.element?.querySelector('.terminal-resize-frame-cover'));
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.FRAME_COVER_CODEX_QUIET_MS + 80));
        return {
          before,
          survivedBlank,
          survivedCodexQuietWindow,
          removedAfterFrame: !app.terminal.element?.querySelector('.terminal-resize-frame-cover'),
        };
      });

      expect(state.before.exists).toBe(true);
      expect(state.before.text).toContain('frame before keyboard');
      expect(state.survivedBlank).toBe(true);
      expect(state.survivedCodexQuietWindow).toBe(true);
      expect(state.removedAfterFrame).toBe(true);
    });

    it('replaces keyboard resize redraws with the authoritative pane without losing scrollback', async () => {
      const state = await page.evaluate(async () => {
        const sessionId = 'mobile-keyboard-authoritative-pane-test';
        const originalFetch = window.fetch;
        const originalSendResize = app.sendResize;
        const snapshot = `\x1b[1;1HAUTHORITATIVE CURRENT PANE\x1b[${app.terminal.rows};1H› `;
        const snapshotCursor = {
          stream: 'keyboard-frame-stream',
          generation: 1,
          start: 0,
          end: 500,
        };
        const headers = {
          'content-type': 'text/plain; charset=utf-8',
          'x-codeman-terminal-format': 'stream-v1',
          'x-codeman-terminal-stream': snapshotCursor.stream,
          'x-codeman-terminal-generation': String(snapshotCursor.generation),
          'x-codeman-terminal-start': String(snapshotCursor.start),
          'x-codeman-terminal-end': String(snapshotCursor.end),
          'x-codeman-terminal-status': 'idle',
          'x-codeman-terminal-full-size': String(snapshot.length),
          'x-codeman-terminal-truncated': '0',
          'x-codeman-terminal-source': 'mux-visible',
        };
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app.terminal.reset();
        const history = Array.from(
          { length: app.terminal.rows + 20 },
          (_, index) => `KEEP_HISTORY_${String(index).padStart(3, '0')}`
        ).join('\r\n');
        await new Promise<void>((resolve) => {
          app.terminal.write(`${history}\r\nstable frame before resize\r\n› `, resolve);
        });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

        try {
          app.sendResize = async () => true;
          window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes(`/api/sessions/${sessionId}/terminal?latest=1`)) {
              return new Response(snapshot, { status: 200, headers });
            }
            return originalFetch.call(window, input, init);
          }) as typeof window.fetch;

          KeyboardHandler._beginTerminalFrameCover({ restart: true, arm: true });
          const startedAt = performance.now();
          const reconcile = KeyboardHandler._sendTerminalResize();
          const gatedImmediately = app._isLoadingBuffer;
          app.batchTerminalWrite('\x1b[2J\x1b[HSTALE HISTORY REDRAW', {
            stream: snapshotCursor.stream,
            generation: snapshotCursor.generation,
            start: 100,
            end: 130,
          });
          await reconcile;
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });

          const buffer = app.terminal.buffer.active;
          const allText = Array.from(
            { length: buffer.length },
            (_, index) => buffer.getLine(index)?.translateToString(true) || ''
          ).join('\n');
          const visibleText = Array.from(
            { length: app.terminal.rows },
            (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || ''
          ).join('\n');
          return {
            allText,
            elapsedMs: performance.now() - startedAt,
            gatedImmediately,
            removed: !app.terminal.element?.querySelector('.terminal-resize-frame-cover'),
            visibleText,
          };
        } finally {
          window.fetch = originalFetch;
          app.sendResize = originalSendResize;
          KeyboardHandler._discardTerminalFrameCover();
        }
      });

      expect(state.gatedImmediately).toBe(true);
      expect(state.visibleText).toContain('AUTHORITATIVE CURRENT PANE');
      expect(state.visibleText).not.toContain('STALE HISTORY REDRAW');
      expect(state.allText).toContain('KEEP_HISTORY_000');
      expect(state.removed).toBe(true);
      expect(state.elapsedMs).toBeLessThan(1000);
    });

    it('reconciles the pane after a touch decision is submitted without relying on hooks', async () => {
      const state = await page.evaluate(async () => {
        const sessionId = 'mobile-dialogue-authoritative-pane-test';
        const originalFetch = window.fetch;
        const originalReliableSend = app._reliableSend;
        const sent: string[] = [];
        const snapshot = '\x1b[1;1HDIALOGUE RESOLVED\x1b[3;1H› ';
        const snapshotCursor = {
          stream: 'dialogue-frame-stream',
          generation: 2,
          start: 0,
          end: 300,
        };
        const headers = {
          'content-type': 'text/plain; charset=utf-8',
          'x-codeman-terminal-format': 'stream-v1',
          'x-codeman-terminal-stream': snapshotCursor.stream,
          'x-codeman-terminal-generation': String(snapshotCursor.generation),
          'x-codeman-terminal-start': String(snapshotCursor.start),
          'x-codeman-terminal-end': String(snapshotCursor.end),
          'x-codeman-terminal-status': 'idle',
          'x-codeman-terminal-full-size': String(snapshot.length),
          'x-codeman-terminal-truncated': '0',
          'x-codeman-terminal-source': 'mux-visible',
        };

        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => {
          app.terminal.write('Approve this action?\r\n› 1. Approve\r\n  2. Reject\r\nPress enter to confirm', resolve);
        });
        app.terminal.scrollToBottom();

        try {
          app._reliableSend = (_target: string, input: string) => sent.push(input);
          window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes(`/api/sessions/${sessionId}/terminal?latest=1`)) {
              return new Response(snapshot, { status: 200, headers });
            }
            return originalFetch.call(window, input, init);
          }) as typeof window.fetch;

          const decisionDetected = app._hasForegroundTerminalDecision(sessionId);
          app._sendInputAsync(sessionId, '\r');
          const reconcile = app._terminalFrameReconcilePromise;
          const gatedImmediately = app._isLoadingBuffer;
          app.batchTerminalWrite('\x1b[2J\x1b[HOLD DIALOGUE HISTORY', {
            stream: snapshotCursor.stream,
            generation: snapshotCursor.generation,
            start: 100,
            end: 125,
          });
          await reconcile;
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });

          const buffer = app.terminal.buffer.active;
          const visibleText = Array.from(
            { length: app.terminal.rows },
            (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || ''
          ).join('\n');
          return {
            decisionDetected,
            gatedImmediately,
            removed: !app.terminal.element?.querySelector('.terminal-resize-frame-cover'),
            sent,
            visibleText,
          };
        } finally {
          window.fetch = originalFetch;
          app._reliableSend = originalReliableSend;
          KeyboardHandler._discardTerminalFrameCover();
        }
      });

      expect(state.decisionDetected).toBe(true);
      expect(state.gatedImmediately).toBe(true);
      expect(state.sent).toEqual(['\r']);
      expect(state.visibleText).toContain('DIALOGUE RESOLVED');
      expect(state.visibleText).not.toContain('OLD DIALOGUE HISTORY');
      expect(state.removed).toBe(true);
    });

    it('restarts an opening frame cover when keyboard close begins', async () => {
      const state = await page.evaluate(async () => {
        const sessionId = 'mobile-keyboard-close-cover-race-test';
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => {
          app.terminal.write('stable frame before keyboard close\r\n› ', resolve);
        });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

        KeyboardHandler.keyboardVisible = true;
        KeyboardHandler._terminalInputRequested = true;
        document.body.classList.add('keyboard-visible');
        const baseline = KeyboardHandler.initialViewportHeight || window.innerHeight;
        Object.defineProperty(window.visualViewport, 'height', {
          get: () => baseline,
          configurable: true,
        });

        KeyboardHandler._beginTerminalFrameCover();
        KeyboardHandler._armTerminalFrameCover();
        KeyboardHandler._terminalFrameCoverReady = true;
        KeyboardHandler._terminalFrameCoverReadyVersion += 1;
        KeyboardHandler._scheduleTerminalFrameCoverSwap();
        const releaseVersion = KeyboardHandler._terminalFrameCoverReadyVersion;

        KeyboardHandler.handleViewportResize();
        const restartedVersion = KeyboardHandler._terminalFrameCoverReadyVersion;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });

        const cover = app.terminal.element?.querySelector('.terminal-resize-frame-cover');
        return {
          keyboardVisible: KeyboardHandler.keyboardVisible,
          coverExists: Boolean(cover),
          coverText: cover?.textContent || '',
          releaseInvalidated: restartedVersion > releaseVersion,
        };
      });

      expect(state.keyboardVisible).toBe(false);
      expect(state.coverExists).toBe(true);
      expect(state.coverText).toContain('stable frame before keyboard close');
      expect(state.releaseInvalidated).toBe(true);
    });

    it('covers the first keyboard-closing growth before the hidden threshold', async () => {
      const state = await page.evaluate(async () => {
        const sessionId = 'mobile-keyboard-close-growth-cover-test';
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => {
          app.terminal.write('stable frame before viewport growth\r\n› ', resolve);
        });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

        const baseline = KeyboardHandler.initialViewportHeight || window.innerHeight;
        const openHeight = baseline - 300;
        KeyboardHandler.keyboardVisible = true;
        KeyboardHandler._terminalInputRequested = true;
        KeyboardHandler._keyboardOpenMinHeight = openHeight;
        KeyboardHandler._keyboardClosing = false;
        KeyboardHandler.lastViewportHeight = openHeight;
        document.body.classList.add('keyboard-visible');

        Object.defineProperty(window.visualViewport, 'height', {
          get: () => openHeight + 24,
          configurable: true,
        });
        KeyboardHandler.handleViewportResize();
        const ignoredAddressBarDrift = !app.terminal.element?.querySelector('.terminal-resize-frame-cover');

        Object.defineProperty(window.visualViewport, 'height', {
          get: () => openHeight + 60,
          configurable: true,
        });
        KeyboardHandler.handleViewportResize();
        const cover = app.terminal.element?.querySelector('.terminal-resize-frame-cover');
        const result = {
          coverExists: Boolean(cover),
          coverText: cover?.textContent || '',
          ignoredAddressBarDrift,
          keyboardClosing: KeyboardHandler._keyboardClosing,
          keyboardVisible: KeyboardHandler.keyboardVisible,
        };

        if (KeyboardHandler._viewportSettleTimer) {
          clearTimeout(KeyboardHandler._viewportSettleTimer);
          KeyboardHandler._viewportSettleTimer = null;
        }
        KeyboardHandler._settleScrollToBottom = false;
        KeyboardHandler._settleFocusInput = false;
        KeyboardHandler._discardTerminalFrameCover();
        return result;
      });

      expect(state.ignoredAddressBarDrift).toBe(true);
      expect(state.keyboardVisible).toBe(true);
      expect(state.keyboardClosing).toBe(true);
      expect(state.coverExists).toBe(true);
      expect(state.coverText).toContain('stable frame before viewport growth');
    });

    it('keeps the frame opaque through local resize renders and swaps only after terminal output paints', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-keyboard-atomic-frame-test';
        app.sessions.set('mobile-keyboard-atomic-frame-test', {
          id: 'mobile-keyboard-atomic-frame-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('old stable frame\r\n› ', resolve));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        KeyboardHandler._beginTerminalFrameCover();
        KeyboardHandler._armTerminalFrameCover();
        const coverTexts: string[] = [];
        const readCoverText = () => {
          const cover = app.terminal.element?.querySelector('.terminal-resize-frame-cover');
          if (cover) coverTexts.push(cover.textContent || '');
          return cover;
        };
        readCoverText();
        app.terminal.refresh(0, app.terminal.rows - 1);
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.FRAME_COVER_MIN_MS + 80));
        const survivedLocalRender = Boolean(app.terminal.element?.querySelector('.terminal-resize-frame-cover'));

        const opacitySamples: Array<number | null> = [];
        app.batchTerminalWrite('\x1b[2J\x1b[Hnew stable frame\r\n› ');
        for (let frame = 0; frame < 5; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const cover = readCoverText() as HTMLElement | null;
          opacitySamples.push(cover ? Number(getComputedStyle(cover).opacity) : null);
        }
        const survivedInitialCodexFrame = Boolean(app.terminal.element?.querySelector('.terminal-resize-frame-cover'));
        app.batchTerminalWrite('\x1b[2J\x1b[Hfinal stable frame\r\n› ');
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.FRAME_COVER_CODEX_QUIET_MS - 40));
        readCoverText();
        await new Promise((resolve) => setTimeout(resolve, 120));

        return {
          survivedLocalRender,
          survivedInitialCodexFrame,
          coverTexts,
          opacitySamples,
          removedAfterOutput: !app.terminal.element?.querySelector('.terminal-resize-frame-cover'),
        };
      });

      expect(state.survivedLocalRender).toBe(true);
      expect(state.survivedInitialCodexFrame).toBe(true);
      expect(state.coverTexts.length).toBeGreaterThan(2);
      expect(state.coverTexts.every((text) => text.includes('old stable frame'))).toBe(true);
      expect(state.coverTexts.every((text) => !text.includes('new stable frame'))).toBe(true);
      expect(state.coverTexts.every((text) => !text.includes('final stable frame'))).toBe(true);
      expect(state.opacitySamples.every((opacity) => opacity === null || opacity === 1)).toBe(true);
      expect(state.removedAfterOutput).toBe(true);
    });

    it('crops the captured frame in place instead of panning history during keyboard shrink', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-keyboard-frame-motion-test';
        app.sessions.set('mobile-keyboard-frame-motion-test', {
          id: 'mobile-keyboard-frame-motion-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('stable frame before keyboard\r\n› ', resolve));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        KeyboardHandler._beginTerminalFrameCover();
        const cover = app.terminal.element?.querySelector('.terminal-resize-frame-cover') as HTMLElement | null;
        const frame = cover?.querySelector('.terminal-resize-frame') as HTMLElement | null;
        if (!cover || !frame) return null;
        const initialHeight = cover.getBoundingClientRect().height;
        const initialTop = frame.getBoundingClientRect().top;
        const nextHeight = Math.max(180, initialHeight - 180);

        KeyboardHandler.keyboardVisible = true;
        document.body.classList.add('keyboard-visible');
        document.documentElement.style.setProperty('--app-height', `${nextHeight + 42}px`);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const style = getComputedStyle(frame);
        return {
          topDelta: frame.getBoundingClientRect().top - initialTop,
          top: style.top,
          bottom: style.bottom,
          transform: style.transform,
        };
      });

      expect(state).not.toBeNull();
      expect(Math.abs(state!.topDelta)).toBeLessThan(1);
      expect(state!.top).toBe('0px');
      expect(state!.bottom).not.toBe('0px');
      expect(state!.transform).toBe('none');
    });

    it('uses an atomic final-frame swap when the keyboard cover reaches its safety timeout', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-keyboard-frame-timeout-test';
        app.sessions.set('mobile-keyboard-frame-timeout-test', {
          id: 'mobile-keyboard-frame-timeout-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('timeout source frame\r\n› ', resolve));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        const originalMax = KeyboardHandler.FRAME_COVER_MAX_MS;
        KeyboardHandler.FRAME_COVER_MAX_MS = 40;
        try {
          KeyboardHandler._beginTerminalFrameCover();
          KeyboardHandler._armTerminalFrameCover();
          await new Promise<void>((resolve) => app.terminal.write('\x1b[2J\x1b[Htimeout final frame\r\n› ', resolve));
          await new Promise((resolve) => setTimeout(resolve, 20));
          const coverText = app.terminal.element?.querySelector('.terminal-resize-frame-cover')?.textContent || '';
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            coverText,
            removed: !app.terminal.element?.querySelector('.terminal-resize-frame-cover'),
          };
        } finally {
          KeyboardHandler.FRAME_COVER_MAX_MS = originalMax;
          KeyboardHandler._discardTerminalFrameCover();
        }
      });

      expect(state.coverText).toContain('timeout source frame');
      expect(state.coverText).not.toContain('timeout final frame');
      expect(state.removed).toBe(true);
    });

    it('holds the outgoing frame and avoids a second keyboard fit during a tab switch', async () => {
      await page.route('**/api/sessions/*/terminal*', async (route) => {
        const sessionId = new URL(route.request().url()).pathname.split('/')[3];
        if (sessionId === 'smooth-tab-b') {
          await new Promise((resolve) => setTimeout(resolve, 140));
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              terminalBuffer: `${sessionId} stable frame\r\n${sessionId} prompt`,
              truncated: false,
            },
          }),
        });
      });

      const state = await page.evaluate(async () => {
        app._initialFullBufferLoad = false;
        app.sessions.set('smooth-tab-a', {
          id: 'smooth-tab-a',
          name: 'Smooth A',
          mode: 'codex',
          status: 'idle',
          pid: 1,
          workingDir: '/tmp',
        });
        app.sessions.set('smooth-tab-b', {
          id: 'smooth-tab-b',
          name: 'Smooth B',
          mode: 'codex',
          status: 'idle',
          pid: 1,
          workingDir: '/tmp',
        });
        app.sessionOrder = ['smooth-tab-a', 'smooth-tab-b'];
        app.renderSessionTabs();
        await app.selectSession('smooth-tab-a');
        await new Promise<void>((resolve) => app.terminal.write('\r\nsmooth-tab-a outgoing frame\r\n', resolve));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        KeyboardHandler.keyboardVisible = true;
        KeyboardHandler._terminalInputRequested = true;
        document.body.classList.add('keyboard-visible');
        const originalFit = app.fitAddon.fit.bind(app.fitAddon);
        const originalFrameCoverMax = KeyboardHandler.FRAME_COVER_MAX_MS;
        KeyboardHandler.FRAME_COVER_MAX_MS = 60;
        const fitStacks: string[] = [];
        app.fitAddon.fit = () => {
          fitStacks.push(String(new Error().stack || ''));
          originalFit();
        };

        const switching = app.selectSession('smooth-tab-b');
        await new Promise((resolve) => setTimeout(resolve, 90));
        const cover = app.terminal.element?.querySelector('.terminal-resize-frame-cover');
        const duringSwitch = {
          coverVisible: Boolean(cover),
          coverText: cover?.textContent || '',
        };
        await switching;
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.FRAME_COVER_MIN_MS + 30));
        app.fitAddon.fit = originalFit;
        KeyboardHandler.FRAME_COVER_MAX_MS = originalFrameCoverMax;

        return {
          duringSwitch,
          removedAfterTargetFrame: !app.terminal.element?.querySelector('.terminal-resize-frame-cover'),
          keyboardFitCalls: fitStacks.filter((stack) => stack.includes('mobile-handlers.js')).length,
        };
      });

      expect(state.duringSwitch.coverVisible).toBe(true);
      expect(state.duringSwitch.coverText).toContain('smooth-tab-a');
      expect(state.removedAfterTargetFrame).toBe(true);
      expect(state.keyboardFitCalls).toBe(0);
    });

    it('keeps the outgoing frame immutable while bounded target history loads off-screen', async () => {
      const state = await page.evaluate(async () => {
        const sourceId = 'history-replay-source';
        const targetId = 'history-replay-target';
        const originalFetch = window.fetch;
        const originalSendResize = app.sendResize;
        const originalConnectWs = app._connectWs;
        const originalCaptureCover = app._captureTerminalHistoryReplayCover;
        let coverCaptureCount = 0;
        const streamHeaders = (end: number, extra: Record<string, string> = {}) => ({
          'content-type': 'text/plain; charset=utf-8',
          'x-codeman-terminal-format': 'stream-v1',
          'x-codeman-terminal-stream': 'history-replay-stream',
          'x-codeman-terminal-generation': '1',
          'x-codeman-terminal-start': '0',
          'x-codeman-terminal-end': String(end),
          'x-codeman-terminal-status': 'idle',
          'x-codeman-terminal-full-size': String(end),
          'x-codeman-terminal-truncated': '0',
          'x-codeman-terminal-source': 'mux-visible',
          ...extra,
        });
        const latestFrame = 'LATEST TARGET FRAME\r\n› current prompt';
        const historicalChunks = Array.from(
          { length: 4 },
          (_, chunkIndex) =>
            Array.from(
              { length: 90 },
              (_, lineIndex) => `HISTORY_${chunkIndex}_${String(lineIndex).padStart(3, '0')} background scrollback`
            ).join('\r\n') + '\r\n'
        );
        let historyChunksSent = 0;

        try {
          app.sessions.set(sourceId, {
            id: sourceId,
            name: 'Replay source',
            mode: 'codex',
            status: 'idle',
            pid: 1,
            workingDir: '/tmp',
          });
          app.sessions.set(targetId, {
            id: targetId,
            name: 'Replay target',
            mode: 'codex',
            status: 'idle',
            pid: 1,
            workingDir: '/tmp',
          });
          app.sessionOrder = [sourceId, targetId];
          app.activeSessionId = sourceId;
          app._initialFullBufferLoad = false;
          app.terminalBufferCache.delete(targetId);
          app._xtermSnapshots.delete(targetId);
          app._warmTerminalCache.remove(targetId);
          app.renderSessionTabs();
          app.hideWelcome();
          app.terminal.reset();
          await new Promise<void>((resolve) => app.terminal.write('OUTGOING SOURCE FRAME\r\n› source prompt', resolve));
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

          app.sendResize = async () => false;
          app._connectWs = () => {};
          app._captureTerminalHistoryReplayCover = function () {
            const captured = originalCaptureCover.call(this);
            if (captured) coverCaptureCount += 1;
            return captured;
          };
          window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (!url.includes(`/api/sessions/${targetId}/terminal`)) {
              return originalFetch.call(window, input, init);
            }
            if (url.includes('latest=1')) {
              return new Response(latestFrame, {
                status: 200,
                headers: streamHeaders(latestFrame.length),
              });
            }

            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                void (async () => {
                  for (const chunk of historicalChunks) {
                    await new Promise((resolve) => setTimeout(resolve, 70));
                    controller.enqueue(encoder.encode(chunk));
                    historyChunksSent += 1;
                  }
                  controller.close();
                })();
              },
            });
            const totalLength = historicalChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            return new Response(body, {
              status: 200,
              headers: streamHeaders(totalLength, {
                'x-codeman-terminal-source': 'mux-history-page',
                'x-codeman-history-start': '0',
                'x-codeman-history-end': '360',
                'x-codeman-history-total': '360',
                'x-codeman-history-more-before': '0',
                'x-codeman-history-more-after': '0',
                'x-codeman-history-origin': 'mobile-history-origin',
              }),
            });
          }) as typeof window.fetch;

          const switching = app.selectSession(targetId);
          const samples: Array<{
            coverText: string;
            baseY: number;
            viewportY: number;
            coverRight: number;
            screenRight: number;
          }> = [];
          for (let attempt = 0; attempt < 40; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            const cover = app.terminal.element?.querySelector('.terminal-history-replay-cover') as HTMLElement | null;
            if (historyChunksSent < 1 || !cover || !cover.textContent?.includes('OUTGOING SOURCE FRAME')) {
              continue;
            }
            const screen = app.terminal.element?.querySelector('.xterm-screen') as HTMLElement | null;
            const buffer = app.terminal.buffer.active;
            const coverRect = cover.getBoundingClientRect();
            const screenRect = screen?.getBoundingClientRect();
            samples.push({
              coverText: cover.textContent || '',
              baseY: buffer.baseY,
              viewportY: buffer.viewportY,
              coverRight: coverRect.right,
              screenRight: screenRect?.right || 0,
            });
            if (historyChunksSent >= historicalChunks.length - 1) break;
          }

          await switching;
          await new Promise((resolve) => setTimeout(resolve, 180));
          const buffer = app.terminal.buffer.active;
          const visibleRows = Array.from(
            { length: app.terminal.rows },
            (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || ''
          ).join('\n');
          const paging = app._terminalHistoryPaging.get(targetId);

          return {
            samples,
            historyChunksSent,
            finalBaseY: buffer.baseY,
            finalViewportY: buffer.viewportY,
            finalVisibleRows: visibleRows,
            coverCaptureCount,
            paging: paging
              ? {
                  start: paging.start,
                  end: paging.end,
                  total: paging.total,
                  pages: paging.pages.length,
                }
              : null,
            coverRemoved: !app.terminal.element?.querySelector('.terminal-history-replay-cover'),
          };
        } finally {
          window.fetch = originalFetch;
          app.sendResize = originalSendResize;
          app._connectWs = originalConnectWs;
          app._captureTerminalHistoryReplayCover = originalCaptureCover;
        }
      });

      expect(state.historyChunksSent).toBeGreaterThan(2);
      expect(state.samples.length).toBeGreaterThan(2);
      expect(state.samples.every((sample) => sample.coverText.includes('OUTGOING SOURCE FRAME'))).toBe(true);
      expect(state.samples.every((sample) => !sample.coverText.includes('LATEST TARGET FRAME'))).toBe(true);
      expect(state.samples.every((sample) => !sample.coverText.includes('HISTORY_'))).toBe(true);
      expect(state.samples.every((sample) => sample.viewportY === sample.baseY)).toBe(true);
      expect(Math.max(...state.samples.map((sample) => sample.baseY))).toBe(
        Math.min(...state.samples.map((sample) => sample.baseY))
      );
      expect(state.samples.every((sample) => Math.abs(sample.coverRight - sample.screenRight) < 1)).toBe(true);
      expect(state.finalBaseY).toBeGreaterThan(state.samples[0].baseY);
      expect(state.finalViewportY).toBe(state.finalBaseY);
      expect(state.finalVisibleRows).toContain('LATEST TARGET FRAME');
      expect(state.coverCaptureCount).toBe(1);
      expect(state.paging).toEqual({ start: 0, end: 360, total: 360, pages: 1 });
      expect(state.coverRemoved).toBe(true);
    });

    it('does not reset the shared terminal while the previous session is still parsing', async () => {
      await page.route('**/api/sessions/parser-fence-target/terminal*', async (route) => {
        const frame = '\x1b[2J\x1b[HDESTINATION FRAME\r\n› target prompt';
        const end = String(frame.length);
        await route.fulfill({
          status: 200,
          contentType: 'text/plain; charset=utf-8',
          headers: {
            'x-codeman-terminal-format': 'stream-v1',
            'x-codeman-terminal-stream': 'parser-fence-stream',
            'x-codeman-terminal-generation': '1',
            'x-codeman-terminal-start': '0',
            'x-codeman-terminal-end': end,
            'x-codeman-terminal-status': 'idle',
            'x-codeman-terminal-full-size': end,
            'x-codeman-terminal-truncated': '0',
            'x-codeman-terminal-source': route.request().url().includes('historyPage=1')
              ? 'mux-history-page'
              : 'mux-visible',
            ...(route.request().url().includes('historyPage=1')
              ? {
                  'x-codeman-history-start': '0',
                  'x-codeman-history-end': '1',
                  'x-codeman-history-total': '1',
                  'x-codeman-history-more-before': '0',
                  'x-codeman-history-more-after': '0',
                  'x-codeman-history-origin': 'parser-fence-origin',
                }
              : {}),
          },
          body: frame,
        });
      });

      const state = await page.evaluate(async () => {
        const sourceId = 'parser-fence-source';
        const targetId = 'parser-fence-target';
        app.sessions.set(sourceId, {
          id: sourceId,
          name: 'Parser source',
          mode: 'codex',
          status: 'busy',
          pid: 1,
          workingDir: '/tmp',
        });
        app.sessions.set(targetId, {
          id: targetId,
          name: 'Parser target',
          mode: 'codex',
          status: 'idle',
          pid: 1,
          workingDir: '/tmp',
        });
        app.sessionOrder = [sourceId, targetId];
        app.activeSessionId = sourceId;
        app._initialFullBufferLoad = false;
        app._warmTerminalCache.remove(targetId);
        app._xtermSnapshots.delete(targetId);
        app.terminalBufferCache.delete(targetId);
        app.sendResize = async () => false;
        app._connectWs = () => {};
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('SOURCE FRAME\r\n', resolve));

        let releaseParser: ((value: boolean) => void) | null = null;
        let parserEnteredResolve: (() => void) | null = null;
        const parserEntered = new Promise<void>((resolve) => {
          parserEnteredResolve = resolve;
        });
        const parserBlock = new Promise<boolean>((resolve) => {
          releaseParser = resolve;
        });
        const blocker = app.terminal.parser.registerOscHandler(777, () => {
          parserEnteredResolve?.();
          return parserBlock;
        });

        const originalReset = app.terminal.reset.bind(app.terminal);
        let resetCount = 0;
        app.terminal.reset = () => {
          resetCount += 1;
          originalReset();
        };

        try {
          app.batchTerminalWrite('\x1b]777;hold\x07OLD SESSION DATA AFTER BLOCK');
          await parserEntered;

          const switching = app.selectSession(targetId, { takeControl: false });
          await new Promise((resolve) => setTimeout(resolve, 80));
          const resetBeforeRelease = resetCount;

          releaseParser?.(true);
          await switching;
          await new Promise<void>((resolve) => app.terminal.write('', resolve));

          const buffer = app.terminal.buffer.active;
          const visibleRows = Array.from(
            { length: app.terminal.rows },
            (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || ''
          ).join('\n');
          return {
            resetBeforeRelease,
            visibleRows,
          };
        } finally {
          releaseParser?.(true);
          blocker.dispose();
          app.terminal.reset = originalReset;
        }
      });

      expect(state.resetBeforeRelease).toBe(0);
      expect(state.visibleRows).toContain('DESTINATION FRAME');
      expect(state.visibleRows).not.toContain('OLD SESSION DATA AFTER BLOCK');
    });

    it('routes Claude touch drags to its transcript without moving local xterm history', async () => {
      const result = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-claude-scroll-test';
        app.sessions.set('mobile-claude-scroll-test', {
          id: 'mobile-claude-scroll-test',
          mode: 'claude',
          cliVersion: '2.1.220',
          status: 'running',
        });
        app.hideWelcome();

        const sgrCalls: number[] = [];
        const localCalls: number[] = [];
        app._sendSyntheticSgrWheel = (_x: number, _y: number, lines: number) => {
          sgrCalls.push(lines);
        };
        app.terminal.scrollLines = (lines: number) => {
          localCalls.push(lines);
        };

        const target =
          document.querySelector('#terminalContainer .xterm-screen') ?? document.getElementById('terminalContainer');
        if (!target) return { sgrCalls, localCalls };
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const startY = rect.top + Math.min(100, rect.height - 20);
        const endY = startY + 100;

        function createTouch(y: number) {
          return new Touch({
            identifier: 2,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
          });
        }

        target.dispatchEvent(
          new TouchEvent('touchstart', {
            touches: [createTouch(startY)],
            changedTouches: [createTouch(startY)],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchmove', {
            touches: [createTouch(endY)],
            changedTouches: [createTouch(endY)],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchend', {
            touches: [],
            changedTouches: [createTouch(endY)],
            bubbles: true,
            cancelable: true,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { sgrCalls, localCalls };
      });

      expect(result.sgrCalls.some((lines) => lines < 0)).toBe(true);
      expect(result.localCalls).toEqual([]);
    });

    it('keeps typed phone text in the terminal local echo path', async () => {
      await page.evaluate(() => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-visible-input-test';
        app.sessions.set('mobile-visible-input-test', {
          id: 'mobile-visible-input-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.focus();
      });

      await page.locator('#terminalContainer').tap({ position: { x: 40, y: 40 } });
      // The tap itself emits a valid SGR mouse report. This assertion is about
      // typed text, so discard pointer setup traffic before entering text.
      await page.evaluate(() => {
        window.__sentInputs = [];
      });
      await page.keyboard.type('find bug');

      const beforeEnter = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        cjkDisplay: getComputedStyle(document.getElementById('cjkInput') as HTMLElement).display,
        pendingText: app._localEchoOverlay?.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(beforeEnter.activeClass).toContain('xterm-helper-textarea');
      expect(beforeEnter.cjkDisplay).toBe('none');
      expect(beforeEnter.pendingText).toBe('find bug');
      expect(beforeEnter.sentInputs).toEqual([]);

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__sentInputs?.join('') === 'find bug\r');

      const afterEnter = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(afterEnter.pendingText).toBe('');
      expect(afterEnter.sentInputs.join('')).toBe('find bug\r');
    });

    it('rehydrates an unsent session draft after the page is backgrounded', async () => {
      const state = await page.evaluate(() => {
        const sessionId = 'mobile-durable-draft-test';
        localStorage.removeItem('codeman:sessionDrafts');
        app._inputState.clearAll({ persist: false });
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('first paragraph\n\nsecond paragraph');

        window.dispatchEvent(new PageTransitionEvent('pagehide'));
        const persisted = JSON.parse(localStorage.getItem('codeman:sessionDrafts') || '{}');

        // Simulate the in-memory state loss caused by a discarded mobile tab.
        app._localEchoOverlay.clear();
        app._inputState.clearAll({ persist: false });
        app._inputState.load();
        app._restoreSessionDraft(sessionId, false);

        return {
          persisted: persisted.drafts?.[sessionId],
          restored: app._localEchoOverlay.state,
        };
      });

      expect(state.persisted).toMatchObject({
        pendingText: 'first paragraph\n\nsecond paragraph',
        flushedText: '',
        cjkText: '',
      });
      expect(state.restored).toMatchObject({
        pendingText: 'first paragraph\n\nsecond paragraph',
        flushedLength: 0,
        flushedText: '',
      });
    });

    it('preserves a live composition when session replay finishes late', async () => {
      const state = await page.evaluate(() => {
        const sessionId = 'mobile-replay-composition-race-test';
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app._localEchoEnabled = true;
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('cd hom');
        app._localEchoOverlay.setCompositionText('e cd hom');

        // Crash recovery deliberately folds the visible composition into its
        // persisted snapshot. A late session replay must not feed that folded
        // snapshot back into the still-live overlay.
        app._captureActiveSessionDraft();
        const persisted = app._inputState.get(sessionId);
        const restored = app._restoreSessionDraft(sessionId, false, {
          preserveLiveComposition: true,
        });

        return {
          persisted,
          restored,
          overlay: app._localEchoOverlay.state,
        };
      });

      expect(state).toMatchObject({
        persisted: {
          pendingText: 'cd home cd hom',
        },
        restored: true,
        overlay: {
          pendingText: 'cd hom',
          compositionText: 'e cd hom',
        },
      });
    });

    it('does not commit Android DEL as finalized composition text', async () => {
      const state = await page.evaluate(() => {
        const sessionId = 'mobile-composition-delete-test';
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app._localEchoEnabled = true;
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('cd');
        app._localEchoOverlay.setCompositionText('candidate');
        app._terminalInputController.clearCompositionDelivery();
        app._terminalInputController.setCompositionPending(true, 'candidate');

        app.terminal._core.coreService.triggerDataEvent('\x7f', true);

        return {
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
          compositionPending: app._terminalInputController.state.compositionPending,
          fallbackCommit: app._terminalInputController.state.fallbackCommit,
        };
      });

      expect(state).toEqual({
        pendingText: 'c',
        compositionText: '',
        compositionPending: false,
        fallbackCommit: null,
      });
    });

    it('does not append interim xterm data during an active composition', async () => {
      const state = await page.evaluate(async () => {
        const sessionId = 'mobile-active-composition-data-test';
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app._localEchoEnabled = true;
        app._localEchoOverlay.clear();
        app._terminalInputController.clearCompositionDelivery();
        app._terminalInputController.setCompositionPending(false);

        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value = 'home';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'home',
          })
        );
        app.terminal._core.coreService.triggerDataEvent('home', true);
        const duringComposition = app._localEchoOverlay.pendingText;

        textarea.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'home',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));

        return {
          duringComposition,
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
        };
      });

      expect(state).toEqual({
        duringComposition: '',
        pendingText: 'home',
        compositionText: '',
      });
    });

    it('strips a stale helper prefix from finalized Android composition data', async () => {
      const state = await page.evaluate(async () => {
        const sessionId = 'mobile-stale-composition-prefix-test';
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, {
          id: sessionId,
          mode: 'codex',
          status: 'running',
        });
        app._localEchoEnabled = true;
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('cd');
        app._terminalInputController.clearCompositionDelivery();
        app._terminalInputController.setCompositionPending(false);

        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value = 'hcd home';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: ' home',
          })
        );
        textarea.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: ' home',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));

        return {
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
          helperValue: textarea.value,
        };
      });

      expect(state).toEqual({
        pendingText: 'cd home',
        compositionText: '',
        helperValue: '',
      });
    });

    it('keeps a switched-away draft editable after browser state is reloaded', async () => {
      const state = await page.evaluate(() => {
        const firstId = 'mobile-draft-session-a';
        const secondId = 'mobile-draft-session-b';
        localStorage.removeItem('codeman:sessionDrafts');
        app._inputState.clearAll({ persist: false });
        app.sessions.set(firstId, { id: firstId, mode: 'codex', status: 'running' });
        app.sessions.set(secondId, { id: secondId, mode: 'codex', status: 'running' });
        app.activeSessionId = firstId;
        app._localEchoEnabled = true;
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('switch-safe draft');
        const sent: string[] = [];
        app._sendInputAsync = (_sessionId: string, input: string) => sent.push(input);

        app._cleanupPreviousSession(secondId);
        app._inputState.persistNow();

        // Rehydrate the input store exactly as a fresh browser page does.
        app._localEchoOverlay.clear();
        app._inputState.clearAll({ persist: false });
        app._inputState.load();
        app.activeSessionId = firstId;
        app._restoreSessionDraft(firstId, false);
        const restoredDraft = app._inputState.get(firstId);

        return {
          sent,
          restored: app._localEchoOverlay.state,
          flushedOffset: restoredDraft?.flushedText.length,
          flushedText: restoredDraft?.flushedText,
        };
      });

      expect(state).toMatchObject({
        sent: ['switch-safe draft'],
        restored: {
          pendingText: '',
          flushedLength: 'switch-safe draft'.length,
          flushedText: 'switch-safe draft',
        },
        flushedOffset: 'switch-safe draft'.length,
        flushedText: 'switch-safe draft',
      });
    });

    it('removes a persisted draft once Enter submits it', async () => {
      const state = await page.evaluate(() => {
        const sessionId = 'mobile-cleared-draft-test';
        localStorage.removeItem('codeman:sessionDrafts');
        app._inputState.clearAll({ persist: false });
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, { id: sessionId, mode: 'codex', status: 'running' });
        app._localEchoEnabled = true;
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('submit me');
        app._captureActiveSessionDraft();
        app._inputState.persistNow();
        const before = JSON.parse(localStorage.getItem('codeman:sessionDrafts') || '{}');

        app._sendInputAsync = () => {};
        app.terminal.input('\r');
        app._inputState.persistNow();
        const after = JSON.parse(localStorage.getItem('codeman:sessionDrafts') || '{}');

        return {
          before: before.drafts?.[sessionId]?.pendingText,
          after: after.drafts?.[sessionId] ?? null,
        };
      });

      expect(state).toEqual({
        before: 'submit me',
        after: null,
      });
    });

    it('shows and commits each live Android composition after the first word', async () => {
      const preview = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-composition-test';
        app.sessions.set('mobile-composition-test', {
          id: 'mobile-composition-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f ', resolve);
        });
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('first ');

        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value = 'sec';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'sec',
          })
        );

        const overlay = Array.from(app.terminal.element.querySelector('.xterm-screen')?.children || []).find(
          (element) => (element as HTMLElement).style.zIndex === '7'
        );
        return {
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
          visibleText: overlay?.textContent,
        };
      });

      expect(preview).toEqual({
        pendingText: 'first ',
        compositionText: 'sec',
        visibleText: expect.stringContaining('first sec'),
      });

      await page.evaluate(() => {
        const textarea = app.terminal.textarea;
        textarea.value = 'second';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'second',
          })
        );
        textarea.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'second',
          })
        );
      });

      await expect
        .poll(() =>
          page.evaluate(() => ({
            pendingText: app._localEchoOverlay.pendingText,
            compositionText: app._localEchoOverlay.compositionText,
          }))
        )
        .toEqual({
          pendingText: 'first second',
          compositionText: '',
        });

      const nextPreview = await page.evaluate(async () => {
        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'abandoned',
          })
        );
        textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'third',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const nativeComposition = app.terminal.element.querySelector('.composition-view');
        return {
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
          nativeCompositionActive: nativeComposition?.classList.contains('active'),
          nativeCompositionDisplay: nativeComposition ? getComputedStyle(nativeComposition).display : null,
          nativeCompositionOpacity: nativeComposition ? getComputedStyle(nativeComposition).opacity : null,
          nativeCompositionMeasurable: (nativeComposition?.getBoundingClientRect().height || 0) > 0,
          helperLineHeightPositive: parseFloat(app.terminal.textarea.style.lineHeight || '0') > 0,
          localEchoClass: app.terminal.element.classList.contains('codeman-local-echo'),
        };
      });

      expect(nextPreview).toEqual({
        pendingText: 'first second',
        compositionText: 'third',
        nativeCompositionActive: true,
        nativeCompositionDisplay: 'block',
        nativeCompositionOpacity: '0',
        nativeCompositionMeasurable: true,
        helperLineHeightPositive: true,
        localEchoClass: true,
      });

      const fallback = await page.evaluate(async () => {
        const textarea = app.terminal.textarea;
        const coreService = app.terminal._core.coreService;
        const triggerDataEvent = coreService.triggerDataEvent;
        coreService.triggerDataEvent = () => {};
        try {
          textarea.dispatchEvent(
            new CompositionEvent('compositionend', {
              bubbles: true,
              data: 'third',
            })
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
        } finally {
          coreService.triggerDataEvent = triggerDataEvent;
        }
        triggerDataEvent.call(coreService, ' ', true);
        triggerDataEvent.call(coreService, 'third', true);
        return {
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
          fallbackCommit: app._terminalInputController.state.fallbackCommit,
        };
      });

      expect(fallback).toEqual({
        pendingText: 'first secondthird ',
        compositionText: '',
        fallbackCommit: null,
      });
    });

    it('commits an Android word once when a delayed insertText follows composition finalization', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-composition-late-input-test';
        app.sessions.set('mobile-composition-late-input-test', {
          id: 'mobile-composition-late-input-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('\x1b[2J\x1b[H\u276f ', resolve));
        app._localEchoOverlay.clear();

        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value = 'its';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'its',
          })
        );
        textarea.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'its',
          })
        );

        // xterm finalizes composition in a zero-delay task. Some Android
        // keyboards then emit the same committed word as a late insertText.
        await new Promise((resolve) => setTimeout(resolve, 20));
        textarea.value = 'its';
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: false,
            inputType: 'insertText',
            data: 'its',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        return {
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
        };
      });

      expect(state).toEqual({
        pendingText: 'its',
        compositionText: '',
      });
    });

    it('dedupes Android suggestion acceptance after the user pauses before Space', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-composition-paused-space-test';
        app.sessions.set('mobile-composition-paused-space-test', {
          id: 'mobile-composition-paused-space-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();

        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value = 'cd';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'cd',
          })
        );
        textarea.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'cd',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const afterComposition = app._localEchoOverlay.pendingText;

        // The user can pause on a completed Gboard suggestion for any length of
        // time. Pressing Space later may replay that finalized word as insertText.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        app.terminal.input(' ');
        textarea.value = 'cd';
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: false,
            inputType: 'insertText',
            data: 'cd',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        return {
          afterComposition,
          pendingText: app._localEchoOverlay.pendingText,
        };
      });

      expect(state).toEqual({
        afterComposition: 'cd',
        pendingText: 'cd ',
      });
    });

    it('dedupes an Android replay delayed after the accepting Space', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-composition-delayed-replay-test';
        app.sessions.set('mobile-composition-delayed-replay-test', {
          id: 'mobile-composition-delayed-replay-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();

        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value = 'cd';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'cd',
          })
        );
        textarea.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'cd',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        app.terminal.input(' ');

        // Browser/IME scheduling can defer the alternate callback even after
        // Space. Elapsed time must not turn the same finalized word into input.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        textarea.value = 'cd';
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: false,
            inputType: 'insertText',
            data: 'cd',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        return {
          pendingText: app._localEchoOverlay.pendingText,
        };
      });

      expect(state).toEqual({
        pendingText: 'cd ',
      });
    });

    it('does not recommit Android final input when compositionend arrives afterward', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-input-before-compositionend-test';
        app.sessions.set('mobile-input-before-compositionend-test', {
          id: 'mobile-input-before-compositionend-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();

        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value = 'cd';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'cd',
          })
        );

        // Some Android keyboards expose the finalized word as a non-composing
        // input mutation before they dispatch compositionend.
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: false,
            inputType: 'insertText',
            data: 'cd',
          })
        );
        const afterInput = app._localEchoOverlay.pendingText;
        textarea.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'cd',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));

        return {
          afterInput,
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
        };
      });

      expect(state).toEqual({
        afterInput: 'cd',
        pendingText: 'cd',
        compositionText: '',
      });
    });

    it('delivers an Android composition once to an immediate-echo shell', async () => {
      const state = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-shell-composition-test';
        app.sessions.set('mobile-shell-composition-test', {
          id: 'mobile-shell-composition-test',
          mode: 'shell',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();

        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value = 'cd';
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'cd',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        textarea.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'cd',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Gboard can repeat the finalized word as a non-composing input event
        // when the following space accepts its suggestion.
        textarea.value = 'cd';
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: false,
            inputType: 'insertText',
            data: 'cd',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        app.terminal.input(' ');
        await new Promise((resolve) => setTimeout(resolve, 20));

        // xterm's helper textarea is an IME scratch buffer and may retain the
        // earlier command prefix. InputEvent.data still identifies the newly
        // inserted word; routing the whole textarea would resend "cd ".
        textarea.value = 'cd home';
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: false,
            inputType: 'insertText',
            data: 'home',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        return {
          sentInputs: window.__sentInputs,
          localEchoEnabled: app._localEchoEnabled,
          localEchoClass: app.terminal.element?.classList.contains('codeman-local-echo'),
        };
      });

      expect(state).toEqual({
        sentInputs: ['cd', ' ', 'home'],
        localEchoEnabled: false,
        localEchoClass: false,
      });
    });

    it('routes retained Android helper text once for a local-echo agent', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-agent-retained-helper-test';
        app.sessions.set('mobile-agent-retained-helper-test', {
          id: 'mobile-agent-retained-helper-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('cd ');

        const textarea = app.terminal.textarea;
        textarea.value = 'cd home';
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: false,
            inputType: 'insertText',
            data: 'home',
          })
        );
        await Promise.resolve();

        return {
          pendingText: app._localEchoOverlay.pendingText,
          helperValue: textarea.value,
        };
      });

      expect(state).toEqual({
        pendingText: 'cd home',
        helperValue: '',
      });
    });

    it('keeps routing Android textarea text after an interrupted composition', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-null-input-data-test';
        app.sessions.set('mobile-null-input-data-test', {
          id: 'mobile-null-input-data-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f ', resolve);
        });
        app._localEchoOverlay.clear();
        app.terminal._core.coreService.triggerDataEvent('a', true);

        const textarea = app.terminal.textarea;
        for (const data of ['b', 'c']) {
          textarea.value = data;
          textarea.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              inputType: 'insertText',
              data: null,
            })
          );
          await Promise.resolve();
        }

        const firstSequence = app._localEchoOverlay.pendingText;
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'interrupted',
          })
        );
        app._localEchoOverlay.clear();
        textarea.value = 'd';
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: null,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));

        return {
          firstSequence,
          pendingText: app._localEchoOverlay.pendingText,
          helperValue: textarea.value,
        };
      });

      expect(state).toEqual({
        firstSequence: 'abc',
        pendingText: 'd',
        helperValue: '',
      });
    });

    it('applies only the new Android helper-textarea mutation from cumulative values', async () => {
      const state = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-cumulative-input-test';
        app.sessions.set('mobile-cumulative-input-test', {
          id: 'mobile-cumulative-input-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('seed');

        const textarea = app.terminal.textarea;
        const beginMutation = (value: string) => {
          textarea.value = value;
          textarea.setSelectionRange(value.length, value.length);
          textarea.dispatchEvent(
            new KeyboardEvent('keydown', {
              bubbles: true,
              key: 'Process',
              keyCode: 229,
            })
          );
          textarea.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: null,
            })
          );
        };

        beginMutation('seed');
        textarea.value = 'seed next';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertText',
            data: null,
          })
        );
        await Promise.resolve();
        const afterNullData = app._localEchoOverlay.pendingText;

        beginMutation('seed next');
        textarea.value = 'seed next more';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: false,
            inputType: 'insertText',
            data: 'seed next more',
          })
        );
        const immediateAfterCumulative = app._localEchoOverlay.pendingText;
        await Promise.resolve();

        return {
          afterNullData,
          immediateAfterCumulative,
          pendingText: app._localEchoOverlay.pendingText,
          helperValue: textarea.value,
        };
      });

      expect(state).toEqual({
        afterNullData: 'seed next',
        immediateAfterCumulative: 'seed next more',
        pendingText: 'seed next more',
        helperValue: '',
      });
    });

    it('filters xterm status replies without swallowing user navigation keys', async () => {
      const state = await page.evaluate(() => {
        const suppress = window.CodemanTerminalInput.shouldSuppressTerminalQueryResponse;
        return {
          deviceAttributes: suppress('\x1b[>0;276;0c'),
          modeReport: suppress('\x1b[?2026;1$y'),
          windowReport: suppress('\x1b[8;24;80t'),
          statusString: suppress('\x1bP1$r0m\x1b\\'),
          oscColor: suppress('\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),
          arrowUp: suppress('\x1b[A'),
          escape: suppress('\x1b'),
        };
      });

      expect(state).toEqual({
        deviceAttributes: true,
        modeReport: true,
        windowReport: true,
        statusString: true,
        oscColor: true,
        arrowUp: false,
        escape: false,
      });
    });

    it('routes Backspace past a stale autocomplete textarea buffer', async () => {
      const state = await page.evaluate(() => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-autocomplete-delete-test';
        app.sessions.set('mobile-autocomplete-delete-test', {
          id: 'mobile-autocomplete-delete-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('draft');

        const textarea = app.terminal.textarea;
        const dispatchDelete = (inputType: string) => {
          textarea.value = 'invisible autocomplete';
          return textarea.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType,
            })
          );
        };

        const firstAccepted = dispatchDelete('deleteContentBackward');
        const secondAccepted = dispatchDelete('deleteWordBackward');
        const pendingText = app._localEchoOverlay.pendingText;
        app._localEchoOverlay.clear();
        const remoteAccepted = dispatchDelete('deleteContentBackward');
        return {
          firstAccepted,
          secondAccepted,
          remoteAccepted,
          pendingText,
          helperValue: textarea.value,
          sentInputs: window.__sentInputs,
        };
      });

      expect(state).toEqual({
        firstAccepted: false,
        secondAccepted: false,
        remoteAccepted: false,
        pendingText: 'dra',
        helperValue: '',
        sentInputs: ['\x7f'],
      });
    });

    it('keeps a pending phone draft anchored to the prompt after agent output', async () => {
      await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-draft-anchor-test';
        app.sessions.set('mobile-draft-anchor-test', {
          id: 'mobile-draft-anchor-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        window.__draftPromptRow = Math.max(2, app.terminal.rows - 5);
        await new Promise<void>((resolve) => {
          app.terminal.write(`\x1b[2J\x1b[H\x1b[${window.__draftPromptRow + 1};1H\u276f `, resolve);
        });
        app.terminal.focus();
      });

      await page.keyboard.type('keep this draft');
      await expect
        .poll(() => page.evaluate(() => app._localEchoOverlay?.state.promptPosition?.row))
        .toBe(await page.evaluate(() => window.__draftPromptRow));

      await page.evaluate(() => {
        window.__updatedDraftPromptRow = Math.max(2, app.terminal.rows - 4);
        app.batchTerminalWrite(
          `\x1b[2J\x1b[Hagent output\r\ncontinues here\x1b[${window.__updatedDraftPromptRow + 1};1H\u276f `
        );
      });

      await expect
        .poll(() => page.evaluate(() => app._localEchoOverlay?.state.promptPosition?.row))
        .toBe(await page.evaluate(() => window.__updatedDraftPromptRow));
      const state = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(state.pendingText).toBe('keep this draft');
      expect(state.sentInputs).toEqual([]);
    });

    it('submits multiline local echo as one bracketed paste frame', async () => {
      await page.evaluate(() => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-multiline-paste-test';
        app.sessions.set('mobile-multiline-paste-test', {
          id: 'mobile-multiline-paste-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();
        const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvent, 'clipboardData', {
          value: {
            getData: (type: string) => (type === 'text/plain' ? 'first paragraph\n\nsecond paragraph' : ''),
          },
        });
        app.terminal.textarea.dispatchEvent(pasteEvent);
        app.terminal.input('\r');
      });

      await expect
        .poll(() => page.evaluate(() => window.__sentInputs))
        .toEqual(['\x1b[200~first paragraph\r\rsecond paragraph\x1b[201~', '\r']);
    });

    it('captures Android xterm input-only paste before newline segmentation', async () => {
      const pastedText = 'References\nfirst line after references\n\nfinal paragraph';
      const captured = await page.evaluate((text) => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-xterm-input-paste-test';
        app.sessions.set('mobile-xterm-input-paste-test', {
          id: 'mobile-xterm-input-paste-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();

        const textarea = app.terminal.textarea;
        textarea.value = text;
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertFromPaste',
            // Some Android builds expose only the first segment here. The
            // helper textarea still contains the full inserted value.
            data: 'References',
          })
        );
        const pendingText = app._localEchoOverlay.pendingText;
        const helperValue = textarea.value;
        app.terminal.input('\r');
        return { pendingText, helperValue };
      }, pastedText);

      expect(captured).toEqual({
        pendingText: pastedText,
        helperValue: '',
      });
      await expect
        .poll(() => page.evaluate(() => window.__sentInputs))
        .toEqual(['\x1b[200~References\rfirst line after references\r\rfinal paragraph\x1b[201~', '\r']);
    });

    it('confirms Android paste on a line break without duplicating word-space input', async () => {
      const captured = await page.evaluate(() => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-xterm-segmented-paste-test';
        app.sessions.set('mobile-xterm-segmented-paste-test', {
          id: 'mobile-xterm-segmented-paste-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app._localEchoOverlay.clear();

        const textarea = app.terminal.textarea;
        const dispatchMutation = (inputType: string, data: string | null = null) => {
          const accepted = textarea.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType,
              data,
            })
          );
          if (accepted && inputType === 'insertText' && data) {
            app.terminal.input(data);
          }
          return accepted;
        };

        const wordInputAccepted = dispatchMutation('insertText', 'writing');
        const spaceInputAccepted = dispatchMutation('insertText', ' ');
        const typedText = app._localEchoOverlay.pendingText;
        app._localEchoOverlay.clear();

        dispatchMutation('insertText', 'References');
        dispatchMutation('insertLineBreak');
        dispatchMutation('insertText', 'first line after references');
        dispatchMutation('insertLineBreak');
        dispatchMutation('insertLineBreak');
        dispatchMutation('insertText', 'final paragraph');

        const pendingText = app._localEchoOverlay.pendingText;
        const helperValue = textarea.value;
        app.terminal.input('\r');
        return {
          wordInputAccepted,
          spaceInputAccepted,
          typedText,
          pendingText,
          helperValue,
        };
      });

      expect(captured).toEqual({
        wordInputAccepted: true,
        spaceInputAccepted: true,
        typedText: 'writing ',
        pendingText: 'References\nfirst line after references\n\nfinal paragraph',
        helperValue: '',
      });
      await expect
        .poll(() => page.evaluate(() => window.__sentInputs))
        .toEqual(['\x1b[200~References\rfirst line after references\r\rfinal paragraph\x1b[201~', '\r']);
    });

    it('routes the mobile paste dialog through the multiline paste boundary', async () => {
      await page.evaluate(`(() => {
        window.__pasteCalls = [];
        app.activeSessionId = 'mobile-paste-dialog-test';
        app.sendPastedText = (text, options) => {
          window.__pasteCalls.push({ text, options });
        };
        KeyboardAccessoryBar.pasteFromClipboard();
      })()`);

      await page.locator('.paste-textarea').fill('first paragraph\n\nsecond paragraph');
      await page.locator('.paste-send').click();

      await expect
        .poll(() => page.evaluate(() => window.__pasteCalls))
        .toEqual([
          {
            text: 'first paragraph\n\nsecond paragraph',
            options: { submit: true },
          },
        ]);
      expect(await page.locator('.paste-overlay').count()).toBe(0);
    });

    it('keeps multiline paste on the newline-preserving fallback transport', async () => {
      const calls = await page.evaluate(() => {
        const sent = [];
        app.activeSessionId = 'mobile-paste-fallback-test';
        app.sessions.set('mobile-paste-fallback-test', {
          id: 'mobile-paste-fallback-test',
          mode: 'claude',
          status: 'running',
        });
        app._sendInputAsync = (sessionId: string, input: string, options?: { useMux?: boolean }) => {
          sent.push({ sessionId, input, options });
        };
        app.sendPastedText('first\n\nReferences\nmore after references', { submit: true });
        return sent;
      });

      expect(calls).toEqual([
        {
          sessionId: 'mobile-paste-fallback-test',
          input: '\x1b[200~first\r\rReferences\rmore after references\x1b[201~',
          options: { useMux: false },
        },
        {
          sessionId: 'mobile-paste-fallback-test',
          input: '\r',
          options: { useMux: false },
        },
      ]);
    });

    it('keeps back-to-back local echo submissions in text-then-Enter order', async () => {
      await page.evaluate(() => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-rapid-submit-test';
        app.sessions.set('mobile-rapid-submit-test', {
          id: 'mobile-rapid-submit-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.focus();
      });

      await page.keyboard.type('first');
      await page.keyboard.press('Enter');
      await page.keyboard.type('second');
      await page.keyboard.press('Enter');

      await expect.poll(() => page.evaluate(() => window.__sentInputs)).toEqual(['first', '\r', 'second', '\r']);
    });

    it('inserts Android keyCode 229 line-break input into the current draft', async () => {
      const state = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-android-enter-test';
        app.sessions.set('mobile-android-enter-test', {
          id: 'mobile-android-enter-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f ', resolve);
        });
        app._localEchoOverlay.clear();

        app.terminal._core.coreService.triggerDataEvent('stringA stringB', true);
        const textarea = app.terminal.textarea;
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Enter',
            code: 'Enter',
            keyCode: 229,
          })
        );
        textarea.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertLineBreak',
          })
        );
        textarea.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertLineBreak',
          })
        );
        app.terminal._core.coreService.triggerDataEvent('stringC', true);
        await Promise.resolve();

        return {
          sentInputs: window.__sentInputs,
          pendingText: app._localEchoOverlay.pendingText,
        };
      });

      expect(state).toEqual({
        sentInputs: [],
        pendingText: 'stringA stringB\nstringC',
      });
    });

    it('inserts an Android line break when compositionend is omitted', async () => {
      const state = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-android-composing-enter-test';
        app.sessions.set('mobile-android-composing-enter-test', {
          id: 'mobile-android-composing-enter-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f ', resolve);
        });
        app._localEchoOverlay.clear();

        app.terminal._core.coreService.triggerDataEvent('stringA ', true);
        const textarea = app.terminal.textarea;
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            data: 'stringB',
          })
        );
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Enter',
            code: 'Enter',
            keyCode: 229,
            isComposing: true,
          })
        );
        textarea.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertLineBreak',
            isComposing: true,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        app.terminal._core.coreService.triggerDataEvent('stringC', true);

        return {
          sentInputs: window.__sentInputs,
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
        };
      });

      expect(state).toEqual({
        sentInputs: [],
        pendingText: 'stringA stringB\nstringC',
        compositionText: '',
      });
    });

    it('flushes local echo before mobile-control Enter and accepts the next draft', async () => {
      const state = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-control-enter-test';
        app.sessions.set('mobile-control-enter-test', {
          id: 'mobile-control-enter-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.sendResize = async () => false;
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f ', resolve);
        });
        app._localEchoOverlay.clear();

        app.terminal._core.coreService.triggerDataEvent('stringA ', true);
        app._localEchoOverlay.setCompositionText('stringB');
        app.terminal.blur();
        app.sendTerminalKey('\r');
        app.terminal._core.coreService.triggerDataEvent('stringC', true);

        return {
          sentInputs: window.__sentInputs,
          pendingText: app._localEchoOverlay.pendingText,
          compositionText: app._localEchoOverlay.compositionText,
          visible: app._localEchoOverlay.state.visible,
          terminalFocused: document.activeElement === app.terminal.textarea,
        };
      });

      expect(state).toEqual({
        sentInputs: ['stringA stringB', '\r'],
        pendingText: 'stringC',
        compositionText: '',
        visible: true,
        terminalFocused: false,
      });
    });

    it('holds the first phone draft until the initial prompt frame is loaded', async () => {
      await page.evaluate(() => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-initial-draft-test';
        app.sessions.set('mobile-initial-draft-test', {
          id: 'mobile-initial-draft-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        app._beginBufferLoad('mobile-initial-draft-load');
        app.terminal.focus();
      });

      await page.keyboard.type('first draft');

      const loadingState = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        overlayState: app._localEchoOverlay?.state,
        sentInputs: window.__sentInputs,
      }));
      expect(loadingState.pendingText).toBe('first draft');
      expect(loadingState.overlayState?.visible).toBe(false);
      expect(loadingState.overlayState?.promptPosition).toBeNull();
      expect(loadingState.sentInputs).toEqual([]);

      await page.evaluate(async () => {
        window.__loadedPromptRow = Math.max(2, app.terminal.rows - 5);
        await new Promise<void>((resolve) => {
          app.terminal.write(
            `\x1b[2J\x1b[Hagent output\r\nready\x1b[${window.__loadedPromptRow + 1};1H\u203a `,
            resolve
          );
        });
        app._finishBufferLoad('mobile-initial-draft-load');
      });

      await expect
        .poll(() => page.evaluate(() => app._localEchoOverlay?.state.promptPosition?.row))
        .toBe(await page.evaluate(() => window.__loadedPromptRow));
      const readyState = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        visible: app._localEchoOverlay?.state.visible,
        sentInputs: window.__sentInputs,
      }));
      expect(readyState.pendingText).toBe('first draft');
      expect(readyState.visible).toBe(true);
      expect(readyState.sentInputs).toEqual([]);
    });

    it('shows terminal local echo at the cursor when no prompt marker is visible', async () => {
      await page.evaluate(async () => {
        app.activeSessionId = 'mobile-cursor-fallback-test';
        app.sessions.set('mobile-cursor-fallback-test', {
          id: 'mobile-cursor-fallback-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        window.__cursorFallbackRow = Math.max(0, app.terminal.rows - 2);
        await new Promise<void>((resolve) => {
          app.terminal.write(
            `\x1b[2J\x1b[Hworking without prompt marker\x1b[${window.__cursorFallbackRow + 1};1H`,
            resolve
          );
        });
        app.terminal.focus();
      });

      await page.keyboard.type('abc');

      const state = await page.evaluate(() => ({
        cjkDisplay: getComputedStyle(document.getElementById('cjkInput') as HTMLElement).display,
        pendingText: app._localEchoOverlay?.pendingText,
        overlayState: app._localEchoOverlay?.state,
        expectedRow: window.__cursorFallbackRow,
      }));

      expect(state.cjkDisplay).toBe('none');
      expect(state.pendingText).toBe('abc');
      expect(state.overlayState?.visible).toBe(true);
      expect(state.overlayState?.promptPosition?.row).toBe(state.expectedRow);
    });

    it('ignores a stale historical prompt above the live input cursor', async () => {
      await page.evaluate(async () => {
        app.activeSessionId = 'mobile-stale-prompt-test';
        app.sessions.set('mobile-stale-prompt-test', {
          id: 'mobile-stale-prompt-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        app._localEchoOverlay.clear();
        window.__liveInputRow = Math.max(2, app.terminal.rows - 2);
        await new Promise<void>((resolve) => {
          app.terminal.write(
            `\x1b[2J\x1b[H\u276f old submitted input\r\nagent output\r\nworking without prompt marker\x1b[${window.__liveInputRow + 1};1H`,
            resolve
          );
        });
        app.terminal.focus();
      });

      await page.keyboard.type('abc');

      const state = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        promptRow: app._localEchoOverlay?.state.promptPosition?.row,
        expectedRow: window.__liveInputRow,
      }));

      expect(state.pendingText).toBe('abc');
      expect(state.promptRow).toBe(state.expectedRow);
    });

    it('prefers the live cursor when a short keyboard viewport makes a stale prompt look current', async () => {
      await page.evaluate(async () => {
        app.activeSessionId = 'mobile-short-viewport-prompt-test';
        app.sessions.set('mobile-short-viewport-prompt-test', {
          id: 'mobile-short-viewport-prompt-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.resize(app.terminal.cols, 6);
        app.terminal.reset();
        app._localEchoOverlay.clear();
        app._localEchoPromptAnchor = null;
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f old submitted input\x1b[6;3H', resolve);
        });
        app.terminal.focus();
      });

      await page.keyboard.type('abc');

      const state = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        promptRow: app._localEchoOverlay?.state.promptPosition?.row,
        cursorRow: app.terminal.buffer.active.cursorY,
      }));

      expect(state.pendingText).toBe('abc');
      expect(state.promptRow).toBe(state.cursorRow);
      expect(state.cursorRow).toBe(5);
    });

    it('discards a remembered prompt anchor that no longer fits after keyboard shrink', async () => {
      await page.evaluate(async () => {
        app.activeSessionId = 'mobile-invalid-prompt-anchor-test';
        app.sessions.set('mobile-invalid-prompt-anchor-test', {
          id: 'mobile-invalid-prompt-anchor-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.resize(app.terminal.cols, 6);
        app.terminal.reset();
        app._localEchoOverlay.clear();
        app._localEchoPromptAnchor = {
          sessionId: 'mobile-invalid-prompt-anchor-test',
          rowsFromBottom: 7,
          col: 2,
        };
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\x1b[3;1Hagent output\x1b[6;3H', resolve);
        });
        app.terminal.focus();
      });

      await page.keyboard.type('abc');

      const state = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        promptRow: app._localEchoOverlay?.state.promptPosition?.row,
        cursorRow: app.terminal.buffer.active.cursorY,
      }));

      expect(state.pendingText).toBe('abc');
      expect(state.promptRow).toBe(state.cursorRow);
      expect(state.cursorRow).toBe(5);
    });

    it('uses a bottom fallback for the first mobile draft when the replay prompt remains at row zero', async () => {
      await page.evaluate(async () => {
        app.activeSessionId = 'mobile-row-zero-prompt-test';
        app.sessions.set('mobile-row-zero-prompt-test', {
          id: 'mobile-row-zero-prompt-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        app._localEchoOverlay.clear();
        app._localEchoPromptAnchor = null;
        window.__fallbackPromptRow = Math.max(0, app.terminal.rows - 5);
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f replayed prompt\x1b[H', resolve);
        });
        app.terminal.focus();
      });

      await page.keyboard.type('first draft');

      const state = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        promptRow: app._localEchoOverlay?.state.promptPosition?.row,
        expectedRow: window.__fallbackPromptRow,
      }));

      expect(state.pendingText).toBe('first draft');
      expect(state.promptRow).toBe(state.expectedRow);
    });

    it('keeps the first post-Enter draft at the remembered prompt while a resized frame is stale', async () => {
      await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-stale-resize-prompt-test';
        app.sessions.set('mobile-stale-resize-prompt-test', {
          id: 'mobile-stale-resize-prompt-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        app._localEchoOverlay.clear();
        window.__rememberedPromptRow = Math.max(2, app.terminal.rows - 5);
        await new Promise<void>((resolve) => {
          app.terminal.write(`\x1b[2J\x1b[H\x1b[${window.__rememberedPromptRow + 1};1H\u276f `, resolve);
        });
        window.__promptAnchorCaptured = app._captureLocalEchoPromptAnchor?.();
        app.terminal._core.coreService.triggerDataEvent('stringA', true);
        app.terminal._core.coreService.triggerDataEvent('\r', true);

        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f old submitted input\x1b[H', resolve);
        });
        app.terminal.focus();
      });

      await page.keyboard.type('first draft');

      const state = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        promptRow: app._localEchoOverlay?.state.promptPosition?.row,
        expectedRow: window.__rememberedPromptRow,
        captured: window.__promptAnchorCaptured,
        sentInputs: window.__sentInputs,
      }));

      expect(state).toMatchObject({
        pendingText: 'first draft',
        captured: true,
        promptRow: state.expectedRow,
        sentInputs: ['stringA', '\r'],
      });
    });

    it('does not paint a mobile draft over output while the resized prompt frame is pending', async () => {
      await page.evaluate(async () => {
        app.activeSessionId = 'mobile-occupied-anchor-test';
        app.sessions.set('mobile-occupied-anchor-test', {
          id: 'mobile-occupied-anchor-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        app._localEchoOverlay.clear();
        window.__occupiedAnchorRow = Math.max(2, app.terminal.rows - 3);
        await new Promise<void>((resolve) => {
          app.terminal.write(`\x1b[2J\x1b[H\x1b[${window.__occupiedAnchorRow + 1};1H\u276f `, resolve);
        });
        window.__occupiedAnchorCaptured = app._captureLocalEchoPromptAnchor?.();
        await new Promise<void>((resolve) => {
          app.terminal.write(`\x1b[2J\x1b[Hagent output\x1b[${window.__occupiedAnchorRow + 1};1Hstill output`, resolve);
        });
        app.terminal.focus();
      });

      await page.keyboard.type('held draft');

      const pendingFrame = await page.evaluate(() => ({
        captured: window.__occupiedAnchorCaptured,
        pendingText: app._localEchoOverlay.pendingText,
        visible: app._localEchoOverlay.state.visible,
        promptRow: app._localEchoOverlay.state.promptPosition?.row ?? null,
      }));
      expect(pendingFrame).toEqual({
        captured: true,
        pendingText: 'held draft',
        visible: false,
        promptRow: null,
      });

      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          app.terminal.write(`\x1b[2J\x1b[H\x1b[${window.__occupiedAnchorRow + 1};1H\u276f `, resolve);
        });
        app._localEchoOverlay.rerender();
      });

      await expect
        .poll(() => page.evaluate(() => app._localEchoOverlay.state.promptPosition?.row))
        .toBe(await page.evaluate(() => window.__occupiedAnchorRow));
      await expect.poll(() => page.evaluate(() => app._localEchoOverlay.state.visible)).toBe(true);
    });

    it('follows the live mobile cursor when it diverges from a remembered anchor', async () => {
      await page.evaluate(async () => {
        app.activeSessionId = 'mobile-remembered-anchor-drift-test';
        app.sessions.set('mobile-remembered-anchor-drift-test', {
          id: 'mobile-remembered-anchor-drift-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        app._localEchoOverlay.clear();
        window.__stableAnchorRow = Math.max(2, app.terminal.rows - 3);
        window.__driftCursorRow = Math.max(2, app.terminal.rows - 8);
        await new Promise<void>((resolve) => {
          app.terminal.write(`\x1b[2J\x1b[H\x1b[${window.__stableAnchorRow + 1};1H\u276f `, resolve);
        });
        window.__stableAnchorCaptured = app._captureLocalEchoPromptAnchor?.();
        await new Promise<void>((resolve) => {
          app.terminal.write(`\x1b[2J\x1b[Hagent output\x1b[${window.__driftCursorRow + 1};1H`, resolve);
        });
        app.terminal.focus();
      });

      await page.keyboard.type('stable draft');

      const state = await page.evaluate(() => ({
        captured: window.__stableAnchorCaptured,
        promptRow: app._localEchoOverlay.state.promptPosition?.row,
        expectedRow: window.__driftCursorRow,
      }));
      expect(state).toMatchObject({
        captured: true,
        promptRow: state.expectedRow,
      });
    });
  });

  // ── Cross-device keyboard behavior ────────────────────────────────────

  describe('Cross-device keyboard behavior', () => {
    it('phone: full keyboard handling active', async () => {
      const device = REPRESENTATIVE_DEVICES['standard-phone'];
      const { context, page } = await createDevicePage(device, BASE_URL, 'chromium');
      try {
        const state = await getKeyboardState(page);
        expect(state.exists).toBe(true);
        expect(state.hasHandleViewportResize).toBe(true);

        // Show keyboard and verify it works
        await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        expect(await getKeyboardVisible(page)).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('scaled Android phone keeps unified controls flush with the keyboard edge', async () => {
      const device = DEVICE_REGISTRY.find((entry) => entry.name === 'Galaxy S23 Ultra')!;
      const { context, page } = await createDevicePage(device, BASE_URL, 'chromium');
      try {
        expect(await page.evaluate(() => window.innerWidth)).toBeGreaterThan(430);
        expect(await page.evaluate(`MobileDetection.isHandheldDevice()`)).toBe(true);

        await page.evaluate(`
          app.activeSessionId = 'scaled-android-controls-test';
          app.hideWelcome();
          MobileTerminalControls.setEnabled(true);
          MobileTerminalControls.syncVisibility();
        `);

        const viewport = page.viewportSize()!;
        const keyboardViewportHeight = viewport.height - KEYBOARD.TYPICAL_ANDROID_HEIGHT;
        const cdp = await getCDP(page);
        await setVisualViewportHeight(cdp, viewport.width, keyboardViewportHeight, device.deviceScaleFactor);
        await page.waitForTimeout(100);
        await page.evaluate(`KeyboardHandler.handleViewportResize()`);
        await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);
        expect(await getKeyboardVisible(page)).toBe(true);

        const layout = await page.evaluate(() => {
          const appEl = document.querySelector('.app') as HTMLElement | null;
          const main = document.querySelector('.main') as HTMLElement | null;
          const terminal = document.getElementById('terminalContainer');
          const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
          const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement | null;
          const accessoryRect = accessory?.getBoundingClientRect();
          const buttonRects = [...(accessory?.querySelectorAll('button') ?? [])].map((button) =>
            button.getBoundingClientRect()
          );
          return {
            viewportMeta: document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content ?? '',
            hasHandheldClass: document.body.classList.contains('handheld-device'),
            toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : '',
            accessoryDisplay: accessory ? getComputedStyle(accessory).display : '',
            mainPadding: main ? parseFloat(getComputedStyle(main).paddingBottom) : -1,
            terminalBottom: terminal?.getBoundingClientRect().bottom ?? 0,
            accessoryTop: accessoryRect?.top ?? 0,
            accessoryBottom: accessoryRect?.bottom ?? 0,
            accessoryButtonsContained: buttonRects.every(
              (rect) => rect.top >= (accessoryRect?.top ?? 0) - 1 && rect.bottom <= (accessoryRect?.bottom ?? 0) + 1
            ),
            appBottom: appEl?.getBoundingClientRect().bottom ?? 0,
            layoutViewportHeight: window.innerHeight,
            visualViewportHeight: window.visualViewport?.height ?? 0,
          };
        });

        expect(layout.viewportMeta).toContain('interactive-widget=resizes-content');
        expect(layout.hasHandheldClass).toBe(true);
        expect(layout.toolbarDisplay).toBe('none');
        expect(layout.accessoryDisplay).toBe('flex');
        expect(layout.mainPadding).toBeGreaterThan(0);
        expect(layout.accessoryButtonsContained).toBe(true);
        expect(layout.layoutViewportHeight).toBe(keyboardViewportHeight);
        expect(layout.visualViewportHeight).toBe(keyboardViewportHeight);
        expect(Math.abs(layout.appBottom - keyboardViewportHeight)).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.terminalBottom - layout.accessoryTop)).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.accessoryBottom - layout.appBottom)).toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
    });

    it('tablet: keyboard handling active', async () => {
      const device = REPRESENTATIVE_DEVICES['standard-tablet']; // iPad Mini
      const { context, page } = await createDevicePage(device, BASE_URL, 'chromium');
      try {
        const state = await getKeyboardState(page);
        expect(state.exists).toBe(true);
        expect(state.hasHandleViewportResize).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('desktop: KeyboardHandler.init() skips (no touch device)', async () => {
      // Create a non-mobile, non-touch context
      const browser = await getBrowser('chromium');
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        isMobile: false,
        hasTouch: false,
      });
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: WAIT.DOM_CONTENT_LOADED });
        await page.waitForTimeout(1000);

        const state = await getKeyboardState(page);
        // KeyboardHandler object exists (it's a const), but init() is a no-op
        // on non-touch devices, so no viewport handler is registered
        expect(state.exists).toBe(true);
        expect(state.keyboardVisible).toBe(false);
        expect(state.hasViewportHandler).toBe(false);

        const inputState = await page.evaluate(() => {
          app.activeSessionId = 'desktop-input-event-test';
          app.sessions.set('desktop-input-event-test', {
            id: 'desktop-input-event-test',
            mode: 'claude',
            status: 'running',
          });
          const settings = app.loadAppSettingsFromStorage();
          settings.localEchoEnabled = true;
          app.saveAppSettingsToStorage(settings);
          app._updateLocalEchoState();
          app._localEchoOverlay.clear();
          const accepted = app.terminal.textarea.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: 'autocomplete',
            })
          );
          return {
            accepted,
            pendingText: app._localEchoOverlay.pendingText,
          };
        });
        expect(inputState).toEqual({
          accepted: true,
          pendingText: '',
        });
      } finally {
        await context.close();
      }
    });
  });
});
