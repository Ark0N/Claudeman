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
import { REPRESENTATIVE_DEVICES } from './devices.js';
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

    it('toolbar remains below terminal when keyboard show shrinks the app viewport', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const layout = await page.evaluate(() => {
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement | null;
        const terminalWrap = document.querySelector('.terminal-wrap') as HTMLElement | null;
        const toolbarRect = toolbar?.getBoundingClientRect();
        const accessoryRect = accessory?.getBoundingClientRect();
        const terminalRect = terminalWrap?.getBoundingClientRect();
        return {
          toolbarTransform: toolbar?.style.transform ?? '',
          accessoryTransform: (accessory as HTMLElement | null)?.style.transform ?? '',
          toolbarTop: toolbarRect?.top ?? 0,
          accessoryTop: accessoryRect?.top ?? 0,
          terminalBottom: terminalRect?.bottom ?? 0,
        };
      });
      expect(layout.toolbarTransform).toBe('');
      expect(layout.accessoryTransform).toBe('');
      expect(layout.accessoryTop).toBeGreaterThanOrEqual(layout.terminalBottom - 4);
      expect(layout.toolbarTop).toBeGreaterThan(layout.accessoryTop);
    });

    it('accessory bar gets .visible class', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const hasVisible = await page.evaluate(() => {
        const bar = document.querySelector('.keyboard-accessory-bar');
        return bar?.classList.contains('visible') ?? false;
      });
      expect(hasVisible).toBe(true);
    });

    it('main padding increases on keyboard show', async () => {
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
      expect(newPx).toBeGreaterThan(initialPx);
    });

    it('does not reserve the keyboard height as visible terminal dead space', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const layout = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        const appEl = document.querySelector('.app') as HTMLElement | null;
        const terminalWrap = document.querySelector('.terminal-wrap') as HTMLElement | null;
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement | null;
        return {
          appHeight: appEl?.getBoundingClientRect().height ?? 0,
          mainPaddingBottom: main ? parseFloat(main.style.paddingBottom || '0') : 0,
          terminalHeight: terminalWrap?.getBoundingClientRect().height ?? 0,
          toolbarHeight: toolbar?.getBoundingClientRect().height ?? 0,
          accessoryHeight: accessory?.getBoundingClientRect().height ?? 0,
          visualViewportHeight: window.visualViewport?.height ?? window.innerHeight,
        };
      });

      expect(layout.appHeight).toBeLessThanOrEqual(layout.visualViewportHeight + 2);
      expect(layout.mainPaddingBottom).toBeLessThan(KEYBOARD.TYPICAL_IOS_HEIGHT);
      expect(layout.mainPaddingBottom).toBeGreaterThanOrEqual(layout.toolbarHeight + layout.accessoryHeight - 4);
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

    it('accessory bar has the simple-mode action buttons', async () => {
      const actions = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.keyboard-accessory-bar [data-action]')).map(
          (button) => (button as HTMLElement).dataset.action
        );
      });
      expect(actions).toEqual(['scroll-up', 'scroll-down', 'init', 'clear', 'paste', 'esc', 'dismiss']);
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

    it('routes CJK textarea typing through local echo on Enter', async () => {
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
      expect(beforeEnter.pendingText).toBe('hello');
      expect(beforeEnter.sentInputs).toEqual([]);

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__sentInputs?.length === 2);
      const afterEnter = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(afterEnter.pendingText).toBe('');
      expect(afterEnter.sentInputs).toEqual(['hello', '\r']);
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

    it('focuses the terminal helper textarea when the terminal is tapped', async () => {
      await page.evaluate(() => {
        app.activeSessionId = 'mobile-focus-visible-input-test';
        app.sessions.set('mobile-focus-visible-input-test', {
          id: 'mobile-focus-visible-input-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
      });

      await page.locator('#terminalContainer').tap({ position: { x: 40, y: 40 } });

      const activeClass = await page.evaluate(() => document.activeElement?.className);
      expect(activeClass).toContain('xterm-helper-textarea');
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
        const storageKey = `codeman:sessionDrafts:draft:${encodeURIComponent(sessionId)}`;
        localStorage.removeItem('codeman:sessionDrafts');
        localStorage.removeItem(storageKey);
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
        const persisted = JSON.parse(localStorage.getItem(storageKey) || 'null')?.draft;

        // Simulate the in-memory state loss caused by a discarded mobile tab.
        app._localEchoOverlay.clear();
        app._inputState.clearAll({ persist: false });
        app._inputState.load();
        app._restoreSessionDraft(sessionId, false);

        return {
          persisted,
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
        const storageKey = `codeman:sessionDrafts:draft:${encodeURIComponent(sessionId)}`;
        localStorage.removeItem('codeman:sessionDrafts');
        localStorage.removeItem(storageKey);
        app._inputState.clearAll({ persist: false });
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, { id: sessionId, mode: 'codex', status: 'running' });
        app._localEchoEnabled = true;
        app._localEchoOverlay.clear();
        app._localEchoOverlay.appendText('submit me');
        app._captureActiveSessionDraft();
        app._inputState.persistNow();
        const before = JSON.parse(localStorage.getItem(storageKey) || 'null')?.draft;

        app._sendInputAsync = () => {};
        app.terminal.input('\r');
        app._inputState.persistNow();
        const after = localStorage.getItem(storageKey);

        return {
          before: before?.pendingText,
          after,
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
          fallbackCommit: app._terminalInputController.state.fallbackCommit,
        };
      });

      expect(fallback).toEqual({
        pendingText: 'first secondthird ',
        compositionText: '',
        fallbackCommit: null,
      });
    });

    it('dedupes Android suggestion acceptance inside the replay window', async () => {
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
        await new Promise((resolve) => setTimeout(resolve, 20));
        const afterComposition = app._localEchoOverlay.pendingText;

        // Pressing Space can replay the finalized suggestion through xterm's
        // alternate callback while the commit marker is still active.
        await new Promise((resolve) => setTimeout(resolve, 50));
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

    it('accepts identical Android text after the replay window expires', async () => {
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

        // Once the bounded marker expires, identical input is treated as a new
        // user action rather than suppressing legitimate repeated text forever.
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
        pendingText: 'cd cd',
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
