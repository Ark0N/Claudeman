// Port 3209 - Keyboard-hidden terminal navigation tests
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { WebServer } from '../../src/web/server.js';
import { TmuxManager } from '../../src/tmux-manager.js';
import { DEVICE_REGISTRY } from './devices.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { KEYBOARD, PORTS, SELECTORS } from './helpers/constants.js';
import { getCDP, dispatchTouchEvent } from './helpers/cdp.js';
import { createTestServer, stopTestServer } from './helpers/server.js';

const PORT = PORTS.NAVIGATION_PAD;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_ID = 'mobile-navigation-test';
const PIXEL_8 = DEVICE_REGISTRY.find((device) => device.name === 'Pixel 8')!;
const tmuxAvailableSpy = vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

describe('Mobile Navigation Pad', () => {
  let server: WebServer;
  let context: BrowserContext;
  let page: Page;
  let inputLog: string[];
  let resizeLog: Array<Record<string, unknown>>;
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.CODEMAN_DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), 'codeman-mobile-navigation-'));
    process.env.CODEMAN_DATA_DIR = dataDir;
    server = await createTestServer(PORT);
    ({ context, page } = await createDevicePage(PIXEL_8, BASE_URL, 'chromium'));
    inputLog = [];
    resizeLog = [];
    await page.exposeFunction('__recordMobileNavigationInput', (input: string) => {
      inputLog.push(input);
    });
    await page.exposeFunction('__recordMobileNavigationResize', (options: Record<string, unknown>) => {
      resizeLog.push(options);
    });
  });

  beforeEach(async () => {
    inputLog.length = 0;
    resizeLog.length = 0;
    await page.evaluate(`
      document.getElementById('appSettingsModal')?.classList.remove('active');
      document.body.classList.remove('keyboard-visible', 'keyboard-opening');
      KeyboardHandler.keyboardVisible = false;
      KeyboardHandler._terminalInputRequested = false;
      clearTimeout(KeyboardHandler._keyboardOpeningTimer);
      KeyboardHandler._keyboardOpeningTimer = null;
      KeyboardHandler._discardTerminalFrameCover?.();
      app.sendResize = function(_sessionId, options = {}) {
        window.__recordMobileNavigationResize(options);
        return Promise.resolve(true);
      };
      app._sendInputAsync = function(_sessionId, input) {
        window.__recordMobileNavigationInput(input);
      };
      app.activeSessionId = ${JSON.stringify(SESSION_ID)};
      app.hideWelcome();
      MobileTerminalControls.setEnabled(true);
    `);
  });

  afterAll(async () => {
    await context?.close();
    await closeAllBrowsers();
    if (server) await stopTestServer(server);
    if (previousDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    tmuxAvailableSpy.mockRestore();
  });

  it('fits above the toolbar with accessible touch targets', async () => {
    const navigation = page.locator(SELECTORS.MOBILE_NAVIGATION);
    expect(await navigation.isVisible()).toBe(true);
    expect(await navigation.getAttribute('aria-hidden')).toBe('false');

    const navBox = await navigation.boundingBox();
    const toolbarBox = await page.locator(SELECTORS.TOOLBAR).boundingBox();
    const terminalBox = await page.locator(SELECTORS.TERMINAL_CONTAINER).boundingBox();
    expect(navBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(terminalBox).not.toBeNull();
    expect((terminalBox?.y ?? 0) + (terminalBox?.height ?? 0)).toBeLessThanOrEqual((navBox?.y ?? 0) + 1);
    expect((navBox?.y ?? 0) + (navBox?.height ?? 0)).toBeLessThanOrEqual((toolbarBox?.y ?? 0) + 1);
    expect(navBox?.height).toBe(48);

    expect(await navigation.locator('button').count()).toBe(6);
    expect(await navigation.locator('[data-nav-key="jump-bottom"]').isHidden()).toBe(true);
    const buttons = navigation.locator('button:not([data-nav-key="jump-bottom"])');
    const buttonBoxes = [];
    for (let index = 0; index < 5; index++) {
      const box = await buttons.nth(index).boundingBox();
      buttonBoxes.push(box);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
      expect(box?.height).toBe(48);
      expect(Math.abs((box?.y ?? 0) - (navBox?.y ?? 0))).toBeLessThanOrEqual(1);
    }

    const [escapeBox, upBox, , downBox, tabBox] = buttonBoxes;
    expect((escapeBox?.x ?? 0) - (navBox?.x ?? 0)).toBeLessThanOrEqual(12);
    expect((navBox?.x ?? 0) + (navBox?.width ?? 0) - ((tabBox?.x ?? 0) + (tabBox?.width ?? 0))).toBeLessThanOrEqual(12);
    expect((upBox?.x ?? 0) - ((escapeBox?.x ?? 0) + (escapeBox?.width ?? 0))).toBeGreaterThanOrEqual(24);
    expect((tabBox?.x ?? 0) - ((downBox?.x ?? 0) + (downBox?.width ?? 0))).toBeGreaterThanOrEqual(24);
    const navigationCenter = (navBox?.x ?? 0) + (navBox?.width ?? 0) / 2;
    const directionalCenter = (upBox?.x ?? 0) + ((downBox?.x ?? 0) + (downBox?.width ?? 0) - (upBox?.x ?? 0)) / 2;
    expect(Math.abs(navigationCenter - directionalCenter)).toBeLessThanOrEqual(1);

    const layerStyles = await page.evaluate(() => {
      const main = document.querySelector('.main') as HTMLElement;
      const terminal = document.getElementById('terminalContainer') as HTMLElement;
      const navigation = document.querySelector('.mobile-terminal-nav') as HTMLElement;
      return {
        mainPadding: parseFloat(getComputedStyle(main).paddingBottom),
        mainBackground: getComputedStyle(main).backgroundColor,
        terminalBackground: getComputedStyle(terminal).backgroundColor,
        navigationBackground: getComputedStyle(navigation).backgroundColor,
      };
    });
    expect(layerStyles.mainPadding).toBe(88);
    expect(layerStyles.mainBackground).toBe(layerStyles.terminalBackground);
    expect(layerStyles.navigationBackground).toBe(layerStyles.terminalBackground);

    if (process.env.CODEMAN_NAV_SCREENSHOT) {
      await page.evaluate(`
        app.terminal?.write(
          '\\x1b[2J\\x1b[H' +
          'Select a dispatched agent\\r\\n\\r\\n' +
          '  Agent 1 - research\\r\\n' +
          '  Agent 2 - implementation\\r\\n' +
          '> Agent 3 - review\\r\\n\\r\\n' +
          'Use arrow keys and Enter'
        );
      `);
      await page.waitForTimeout(100);
      await page.screenshot({ path: process.env.CODEMAN_NAV_SCREENSHOT });
    }
  });

  it('shows jump-to-latest above the three central controls only while reading history', async () => {
    const navigation = page.locator(SELECTORS.MOBILE_NAVIGATION);
    const jump = navigation.locator('[data-nav-key="jump-bottom"]');

    await page.evaluate(async () => {
      app.terminal.reset();
      const lines = Array.from({ length: app.terminal.rows + 24 }, (_, index) => `history line ${index + 1}`).join(
        '\r\n'
      );
      await new Promise<void>((resolve) => app.terminal.write(lines, resolve));
    });
    expect(await jump.isHidden()).toBe(true);

    await page.evaluate(() => app._scrollTerminalLines(-8));
    await page.waitForFunction(
      () => !(document.querySelector('[data-nav-key="jump-bottom"]') as HTMLButtonElement)?.hidden
    );

    const navBox = await navigation.boundingBox();
    const jumpBox = await jump.boundingBox();
    const upBox = await navigation.locator('[data-nav-key="up"]').boundingBox();
    const downBox = await navigation.locator('[data-nav-key="down"]').boundingBox();
    expect(navBox).not.toBeNull();
    expect(jumpBox).not.toBeNull();
    expect(jumpBox?.height).toBeGreaterThanOrEqual(44);
    expect((jumpBox?.y ?? 0) + (jumpBox?.height ?? 0)).toBeLessThanOrEqual((navBox?.y ?? 0) - 4);

    const navigationCenter = (navBox?.x ?? 0) + (navBox?.width ?? 0) / 2;
    const centralControlsCenter = (upBox?.x ?? 0) + ((downBox?.x ?? 0) + (downBox?.width ?? 0) - (upBox?.x ?? 0)) / 2;
    const jumpCenter = (jumpBox?.x ?? 0) + (jumpBox?.width ?? 0) / 2;
    expect(Math.abs(navigationCenter - centralControlsCenter)).toBeLessThanOrEqual(1);
    expect(Math.abs(jumpCenter - centralControlsCenter)).toBeLessThanOrEqual(1);

    await jump.click();
    await page.waitForFunction(() => app.isTerminalAtBottom());
    expect(await jump.isHidden()).toBe(true);
  });

  it('sends raw Up without focusing xterm or showing the keyboard', async () => {
    await page.evaluate(`
      app.terminal.focus();
      KeyboardHandler.keyboardVisible = false;
      document.body.classList.remove('keyboard-visible');
      MobileNavigationPad.syncVisibility();
    `);
    const focusedBefore = await page.evaluate(
      () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false
    );
    expect(focusedBefore).toBe(true);

    const viewportHeight = await page.evaluate(() => window.visualViewport?.height);
    const up = page.locator('[data-nav-key="up"]');
    const box = await up.boundingBox();
    expect(box).not.toBeNull();

    const cdp = await getCDP(page);
    await dispatchTouchEvent(cdp, 'touchStart', [
      { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 },
    ]);
    await dispatchTouchEvent(cdp, 'touchEnd', []);
    await vi.waitFor(() => {
      expect(inputLog).toEqual(['\x1b[A']);
    });
    expect(resizeLog).toEqual([
      expect.objectContaining({
        takeControl: true,
        refit: true,
      }),
    ]);
    const state = await page.evaluate(`
      ({
        keyboardVisible: KeyboardHandler.keyboardVisible,
        viewportHeight: window.visualViewport?.height,
        activeTag: document.activeElement?.tagName,
        activeClass: document.activeElement?.className || ''
      })
    `);
    expect(state.keyboardVisible).toBe(false);
    expect(state.viewportHeight).toBe(viewportHeight);
    expect(state.activeTag).not.toBe('TEXTAREA');
    expect(state.activeClass).not.toContain('xterm-helper-textarea');
  });

  it('sends raw Escape and Tab without opening the keyboard', async () => {
    const viewportHeight = await page.evaluate(() => window.visualViewport?.height);

    await page.locator('[data-nav-key="esc"]').click();
    await page.locator('[data-nav-key="tab"]').click();
    await vi.waitFor(() => {
      expect(inputLog).toEqual(['\x1b', '\t']);
    });

    const state = await page.evaluate(`({
      keyboardVisible: KeyboardHandler.keyboardVisible,
      viewportHeight: window.visualViewport?.height,
      terminalFocused: document.activeElement?.classList.contains('xterm-helper-textarea') || false
    })`);
    expect(state.keyboardVisible).toBe(false);
    expect(state.viewportHeight).toBe(viewportHeight);
    expect(state.terminalFocused).toBe(false);
  });

  it('maps Up+Down to one Enter and supports swipes on the surrounding band', async () => {
    await page.evaluate(`
      (function() {
        const nav = document.querySelector(${JSON.stringify(SELECTORS.MOBILE_NAVIGATION)});
        const up = nav.querySelector('[data-nav-key="up"]');
        const down = nav.querySelector('[data-nav-key="down"]');
        const emit = (target, type, pointerId, clientY = 0) => {
          target.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: 'touch',
            isPrimary: pointerId === 1,
            clientY
          }));
        };

        emit(up, 'pointerdown', 1);
        emit(down, 'pointerdown', 2);
        emit(up, 'pointerup', 1);
        emit(down, 'pointerup', 2);
      })()
    `);
    await page.waitForTimeout(50);
    expect(inputLog).toEqual(['\r']);

    inputLog.length = 0;
    await page.evaluate(`
      (function() {
        const nav = document.querySelector(${JSON.stringify(SELECTORS.MOBILE_NAVIGATION)});
        const rect = nav.getBoundingClientRect();
        const x = rect.left + 12;
        nav.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 3,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: rect.bottom - 4
        }));
        nav.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 3,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: rect.top + 4
        }));
      })()
    `);
    await page.waitForTimeout(50);
    expect(inputLog).toEqual(['\x1b[A']);
  });

  it('uses volume-key DOM events when the browser exposes them', async () => {
    await page.evaluate(`
      document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'AudioVolumeDown',
        code: 'AudioVolumeDown',
        bubbles: true,
        cancelable: true
      }));
      document.body.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'AudioVolumeDown',
        code: 'AudioVolumeDown',
        bubbles: true,
        cancelable: true
      }));
    `);
    await page.waitForTimeout(50);
    expect(inputLog).toEqual(['\x1b[B']);

    inputLog.length = 0;
    await page.evaluate(`
      for (const [type, key] of [
        ['keydown', 'AudioVolumeUp'],
        ['keydown', 'AudioVolumeDown'],
        ['keyup', 'AudioVolumeUp'],
        ['keyup', 'AudioVolumeDown']
      ]) {
        document.body.dispatchEvent(new KeyboardEvent(type, {
          key,
          code: key,
          bubbles: true,
          cancelable: true
        }));
      }
    `);
    await page.waitForTimeout(50);
    expect(inputLog).toEqual(['\r']);
  });

  it('is controlled from the mobile App Settings Input options', async () => {
    await page.evaluate(`app.openAppSettings()`);
    const settingRow = page.locator('#appSettingsMobileTerminalControlsItem');
    const setting = page.locator('#appSettingsMobileTerminalControls');
    const settingSlider = settingRow.locator('.slider');
    const hapticsRow = page.locator('#appSettingsMobileControlHapticsItem');
    const haptics = hapticsRow.locator('#appSettingsMobileControlHaptics');
    const soundRow = page.locator('#appSettingsMobileControlSoundItem');
    const sound = soundRow.locator('#appSettingsMobileControlSound');
    expect(await page.locator(SELECTORS.MOBILE_NAVIGATION).isVisible()).toBe(false);
    expect(await settingRow.isVisible()).toBe(true);
    expect(await settingSlider.isVisible()).toBe(true);
    expect(await setting.isChecked()).toBe(true);
    expect(await hapticsRow.isVisible()).toBe(true);
    expect(await hapticsRow.locator('.slider').isVisible()).toBe(true);
    expect(await haptics.isChecked()).toBe(true);
    expect(await soundRow.isVisible()).toBe(true);
    expect(await soundRow.locator('.slider').isVisible()).toBe(true);
    expect(await sound.isChecked()).toBe(false);
    expect(await settingRow.locator('.settings-item-label').textContent()).toBe('Mobile Terminal Controls');
    expect(await page.locator('#appSettingsExtendedKeyboardBar').count()).toBe(0);
    if (process.env.CODEMAN_NAV_MODAL_SCREENSHOT) {
      await page.screenshot({ path: process.env.CODEMAN_NAV_MODAL_SCREENSHOT });
    }

    await settingSlider.click();
    expect(await setting.isChecked()).toBe(false);
    await page.evaluate(`app.saveAppSettings()`);
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem('codeman-app-settings-mobile') || '{}');
      return saved.mobileTerminalControlsEnabled === false;
    });
    expect(
      await page.evaluate(
        `MobileTerminalControls.enabled === false &&
          MobileNavigationPad.enabled === false &&
          KeyboardAccessoryBar.enabled === false`
      )
    ).toBe(true);
    expect(await page.locator(SELECTORS.MOBILE_NAVIGATION).isVisible()).toBe(false);

    await page.evaluate(`app.openAppSettings()`);
    expect(await setting.isChecked()).toBe(false);
    await settingSlider.click();
    expect(await setting.isChecked()).toBe(true);
    await page.evaluate(`app.saveAppSettings()`);
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem('codeman-app-settings-mobile') || '{}');
      return saved.mobileTerminalControlsEnabled === true;
    });
    expect(
      await page.evaluate(
        `MobileTerminalControls.enabled === true &&
          MobileNavigationPad.enabled === true &&
          KeyboardAccessoryBar.enabled === true`
      )
    ).toBe(true);
    expect(await page.locator(SELECTORS.MOBILE_NAVIGATION).isVisible()).toBe(true);
  });

  it('switches to the extended accessory bar while the phone keyboard is visible', async () => {
    const viewportHeight = await page.evaluate(() => window.visualViewport?.height);
    await page.evaluate(`
      KeyboardHandler.keyboardVisible = true;
      KeyboardHandler._terminalInputRequested = true;
      document.body.classList.add('keyboard-visible');
      KeyboardHandler.onKeyboardShow();
    `);
    expect(await page.locator(SELECTORS.MOBILE_NAVIGATION).isVisible()).toBe(false);
    expect(await page.locator(SELECTORS.KEYBOARD_ACCESSORY).isVisible()).toBe(true);
    expect(await page.locator('.keyboard-accessory-bar [data-action="arrow-left"]').isVisible()).toBe(true);
    expect(await page.locator('.toolbar').isVisible()).toBe(false);
    const keyboardLayout = await page.evaluate(() => {
      const appEl = document.querySelector('.app') as HTMLElement;
      const main = document.querySelector('.main') as HTMLElement;
      const terminal = document.getElementById('terminalContainer') as HTMLElement;
      const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement;
      const appBox = appEl.getBoundingClientRect();
      const terminalBox = terminal.getBoundingClientRect();
      const accessoryBox = accessory.getBoundingClientRect();
      return {
        mainPadding: parseFloat(getComputedStyle(main).paddingBottom),
        appBottom: appBox.bottom,
        terminalBottom: terminalBox.bottom,
        accessoryTop: accessoryBox.top,
        accessoryBottom: accessoryBox.bottom,
        accessoryScrollLeft: accessory.scrollLeft,
        primaryButtonsContained: [
          'esc',
          'arrow-left',
          'scroll-up',
          'opt-enter',
          'scroll-down',
          'arrow-right',
          'tab',
        ].every((action) => {
          const button = accessory.querySelector(`[data-action="${action}"]`);
          if (!(button instanceof HTMLElement)) return false;
          const box = button.getBoundingClientRect();
          return box.left >= accessoryBox.left - 1 && box.right <= accessoryBox.right + 1;
        }),
      };
    });
    expect(keyboardLayout.mainPadding).toBeGreaterThan(0);
    expect(keyboardLayout.terminalBottom).toBeLessThanOrEqual(keyboardLayout.accessoryTop + 1);
    expect(Math.abs(keyboardLayout.accessoryBottom - keyboardLayout.appBottom)).toBeLessThanOrEqual(1);
    expect(keyboardLayout.accessoryScrollLeft).toBe(0);
    expect(keyboardLayout.primaryButtonsContained).toBe(true);

    await vi.waitFor(() => {
      expect(resizeLog).toContainEqual(
        expect.objectContaining({
          takeControl: true,
          refit: false,
        })
      );
    });
    resizeLog.length = 0;
    inputLog.length = 0;
    await page.locator('.keyboard-accessory-bar [data-action="arrow-left"]').click();
    await vi.waitFor(() => {
      expect(inputLog).toEqual(['\x1b[D']);
    });
    expect(resizeLog).toEqual([
      expect.objectContaining({
        takeControl: true,
        refit: false,
      }),
    ]);
    const afterKey = await page.evaluate(`({
      keyboardVisible: KeyboardHandler.keyboardVisible,
      viewportHeight: window.visualViewport?.height,
      terminalFocused: document.activeElement?.classList.contains('xterm-helper-textarea') || false
    })`);
    expect(afterKey.keyboardVisible).toBe(true);
    expect(afterKey.viewportHeight).toBe(viewportHeight);
    expect(afterKey.terminalFocused).toBe(true);

    await page.evaluate(`
      KeyboardHandler.keyboardVisible = false;
      document.body.classList.remove('keyboard-visible');
      KeyboardHandler.onKeyboardHide();
    `);
    await page.waitForTimeout(KEYBOARD.ANIMATION_DELAY);
    expect(await page.locator(SELECTORS.KEYBOARD_ACCESSORY).isVisible()).toBe(false);
    expect(await page.locator(SELECTORS.MOBILE_NAVIGATION).isVisible()).toBe(true);
    expect(await page.locator('.toolbar').isVisible()).toBe(true);
  });

  it('removes the keyboard-open reservation when mobile controls are disabled', async () => {
    await page.evaluate(`
      MobileTerminalControls.setEnabled(false);
      KeyboardHandler.keyboardVisible = true;
      document.body.classList.add('keyboard-visible');
      KeyboardHandler.onKeyboardShow();
    `);

    expect(await page.locator(SELECTORS.KEYBOARD_ACCESSORY).isVisible()).toBe(false);
    const layout = await page.evaluate(() => {
      const appBox = document.querySelector('.app')!.getBoundingClientRect();
      const terminalBox = document.getElementById('terminalContainer')!.getBoundingClientRect();
      return {
        hasReservation: document.body.classList.contains('keyboard-accessory-visible'),
        mainPadding: parseFloat(getComputedStyle(document.querySelector('.main')!).paddingBottom),
        appBottom: appBox.bottom,
        terminalBottom: terminalBox.bottom,
      };
    });
    expect(layout.hasReservation).toBe(false);
    expect(layout.mainPadding).toBe(0);
    expect(Math.abs(layout.terminalBottom - layout.appBottom)).toBeLessThanOrEqual(1);
  });

  it('removes both keyboard control surfaces while a dialog is open', async () => {
    await page.evaluate(`
      KeyboardHandler.keyboardVisible = true;
      document.body.classList.add('keyboard-visible');
      KeyboardHandler.onKeyboardShow();
    `);
    expect(await page.locator(SELECTORS.KEYBOARD_ACCESSORY).isVisible()).toBe(true);

    await page.evaluate(`app.openAppSettings()`);
    await page.waitForFunction(() => !document.body.classList.contains('keyboard-accessory-visible'));
    expect(await page.locator(SELECTORS.KEYBOARD_ACCESSORY).isVisible()).toBe(false);
    expect(await page.locator(SELECTORS.MOBILE_NAVIGATION).isVisible()).toBe(false);
    expect(
      await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.main')!).paddingBottom))
    ).toBe(0);

    await page.evaluate(`app.closeAppSettings()`);
    await page.waitForFunction(() => document.body.classList.contains('keyboard-accessory-visible'));
    expect(await page.locator(SELECTORS.KEYBOARD_ACCESSORY).isVisible()).toBe(true);
  });

  it('removes the navigation-band reservation during an incremental keyboard animation', async () => {
    const state = await page.evaluate(`(function() {
      var vv = window.visualViewport;
      var baseline = KeyboardHandler.initialViewportHeight;
      Object.defineProperty(window, 'innerHeight', {
        get: function() { return baseline; },
        configurable: true,
      });

      for (const shrink of [70, 140, 210]) {
        Object.defineProperty(vv, 'height', {
          get: function() { return baseline - shrink; },
          configurable: true,
        });
        KeyboardHandler.handleViewportResize();
      }

      return {
        keyboardVisible: KeyboardHandler.keyboardVisible,
        keyboardClass: document.body.classList.contains('keyboard-visible'),
        navigationClass: document.body.classList.contains('mobile-nav-visible'),
        mainPadding: parseFloat(getComputedStyle(document.querySelector('.main')).paddingBottom),
        toolbarDisplay: getComputedStyle(document.querySelector('.toolbar')).display,
        accessoryDisplay: getComputedStyle(document.querySelector('.keyboard-accessory-bar')).display,
        toolbarTransform: document.querySelector('.toolbar').style.transform,
        accessoryTransform: document.querySelector('.keyboard-accessory-bar').style.transform,
        appBottom: document.querySelector('.app').getBoundingClientRect().bottom,
        terminalBottom: document.getElementById('terminalContainer').getBoundingClientRect().bottom,
        accessoryTop: document.querySelector('.keyboard-accessory-bar').getBoundingClientRect().top,
        accessoryBottom: document.querySelector('.keyboard-accessory-bar').getBoundingClientRect().bottom,
      };
    })()`);

    expect(state.keyboardVisible).toBe(true);
    expect(state.keyboardClass).toBe(true);
    expect(state.navigationClass).toBe(false);
    expect(state.mainPadding).toBeGreaterThan(0);
    expect(state.toolbarDisplay).toBe('none');
    expect(state.accessoryDisplay).toBe('flex');
    expect(state.toolbarTransform).toBe('');
    expect(state.accessoryTransform).toBe('');
    expect(state.terminalBottom).toBeLessThanOrEqual(state.accessoryTop + 1);
    expect(Math.abs(state.accessoryBottom - state.appBottom)).toBeLessThanOrEqual(1);
    expect(await page.locator(SELECTORS.MOBILE_NAVIGATION).isVisible()).toBe(false);
  });
});
