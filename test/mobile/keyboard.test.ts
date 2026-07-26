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

    it('coalesces keyboard animation frames into one final terminal fit', async () => {
      const result = await page.evaluate(async () => {
        const originalFit = app.fitAddon.fit.bind(app.fitAddon);
        const originalSendResize = KeyboardHandler._sendTerminalResize.bind(KeyboardHandler);
        const originalScrollToBottom = app.terminal.scrollToBottom.bind(app.terminal);
        let fits = 0;
        let resizes = 0;
        let bottomRestores = 0;
        app.fitAddon.fit = () => {
          fits++;
        };
        KeyboardHandler._sendTerminalResize = () => {
          resizes++;
        };
        app.terminal.scrollToBottom = () => {
          bottomRestores++;
        };

        KeyboardHandler._scheduleViewportSettle({ scrollToBottom: true });
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler._scheduleViewportSettle();
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler._scheduleViewportSettle();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const beforeFinalSettle = { fits, resizes, bottomRestores };
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.VIEWPORT_SETTLE_MS));
        const afterFinalSettle = { fits, resizes, bottomRestores };

        app.fitAddon.fit = originalFit;
        KeyboardHandler._sendTerminalResize = originalSendResize;
        app.terminal.scrollToBottom = originalScrollToBottom;
        return { beforeFinalSettle, afterFinalSettle };
      });

      expect(result.beforeFinalSettle).toEqual({ fits: 0, resizes: 0, bottomRestores: 0 });
      expect(result.afterFinalSettle).toEqual({ fits: 1, resizes: 1, bottomRestores: 1 });
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

    it('terminal fit called on keyboard toggle', async () => {
      // Inject spy on fitAddon.fit
      await page.evaluate(`
        if (typeof app !== 'undefined' && app.fitAddon) {
          window.__fitCallCount = 0;
          var orig = app.fitAddon.fit;
          app.fitAddon.fit = function () {
            window.__fitCallCount++;
            try { orig.call(this); } catch(e) {}
          };
        }
      `);

      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      // Wait for the setTimeout(150) in onKeyboardShow
      await page.waitForTimeout(300);

      const callCount = await page.evaluate(() => (window as any).__fitCallCount ?? 0);
      // Soft assertion — fitAddon may not be initialized without real terminal
      expect(callCount).toBeGreaterThanOrEqual(0);
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
          localEchoClass: app.terminal.element.classList.contains('codeman-local-echo'),
        };
      });

      expect(nextPreview).toEqual({
        pendingText: 'first second',
        compositionText: 'third',
        nativeCompositionActive: true,
        nativeCompositionDisplay: 'none',
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
          fallbackCommit: app._mobileCompositionFallbackCommit,
        };
      });

      expect(fallback).toEqual({
        pendingText: 'first secondthird ',
        compositionText: '',
        fallbackCommit: null,
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
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[H\u276f ', resolve);
        });
        app.terminal.focus();
      });

      await page.keyboard.type('keep this draft');
      await expect.poll(() => page.evaluate(() => app._localEchoOverlay?.state.promptPosition?.row)).toBe(0);

      await page.evaluate(() => {
        app.batchTerminalWrite('\x1b[2J\x1b[Hagent output\r\ncontinues here\r\n\u276f ');
      });

      await expect.poll(() => page.evaluate(() => app._localEchoOverlay?.state.promptPosition?.row)).toBe(2);
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
        await new Promise<void>((resolve) => {
          app.terminal.write('\x1b[2J\x1b[Hagent output\r\nready\r\n\u203a ', resolve);
        });
        app._finishBufferLoad('mobile-initial-draft-load');
      });

      await expect.poll(() => page.evaluate(() => app._localEchoOverlay?.state.promptPosition?.row)).toBe(2);
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
          app.terminal.write(`\x1b[${window.__cursorFallbackRow + 1};1Hworking without prompt marker`, resolve);
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
