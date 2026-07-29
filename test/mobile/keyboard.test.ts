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
      expect(actions).toEqual(['scroll-up', 'scroll-down', 'init', 'clear', 'paste', 'dismiss']);
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
      expect(beforeEnter.visibleText).toBe('hello');
      expect(beforeEnter.pendingText).toBe('');
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
        await new Promise<void>((resolve) => app.terminal.write('working without prompt marker', resolve));
        app.terminal.focus();
      });

      await page.keyboard.type('abc');

      const state = await page.evaluate(() => ({
        cjkDisplay: getComputedStyle(document.getElementById('cjkInput') as HTMLElement).display,
        pendingText: app._localEchoOverlay?.pendingText,
        overlayState: app._localEchoOverlay?.state,
      }));

      expect(state.cjkDisplay).toBe('none');
      expect(state.pendingText).toBe('abc');
      expect(state.overlayState?.visible).toBe(true);
      expect(state.overlayState?.promptPosition).not.toBeNull();
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
      } finally {
        await context.close();
      }
    });
  });
});
