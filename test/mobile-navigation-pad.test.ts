import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(new URL('../src/web/public/keyboard-accessory.js', import.meta.url), 'utf8');

type NavigationPad = {
  element: HTMLElement | null;
  init: (enabled: boolean) => void;
  syncVisibility: () => void;
  syncJumpVisibility: () => void;
};

type AccessoryBar = {
  element: HTMLElement | null;
};

type MobileControls = {
  init: (enabled: boolean) => void;
  cleanup: () => void;
  configureFeedback: (settings?: Record<string, unknown>, defaults?: Record<string, unknown>) => void;
  feedback: (action: string) => void;
  resolveEnabled: (
    settings?: Record<string, unknown>,
    defaults?: Record<string, unknown>,
    isTouchDevice?: boolean
  ) => boolean;
};

function dispatchPointer(win: JSDOM['window'], target: Element, type: string, pointerId: number, clientY = 0): void {
  const event = new win.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY,
    detail: 1,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  target.dispatchEvent(event);
}

function dispatchVolumeKey(win: JSDOM['window'], type: 'keydown' | 'keyup', key: string): KeyboardEvent {
  const event = new win.KeyboardEvent(type, {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
  });
  win.document.body.dispatchEvent(event);
  return event;
}

function loadHarness() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window &
    typeof globalThis & {
      MobileDetection: {
        isTouchDevice: () => boolean;
        getDeviceType: () => string;
      };
      KeyboardHandler: { keyboardVisible: boolean };
      app: {
        activeSessionId: string | null;
        terminal: {
          focus: ReturnType<typeof vi.fn>;
          scrollToBottom: ReturnType<typeof vi.fn>;
        };
        sendTerminalKey: ReturnType<typeof vi.fn>;
        jumpTerminalToLatest: ReturnType<typeof vi.fn>;
        isTerminalAtBottom: ReturnType<typeof vi.fn>;
      };
    };

  win.MobileDetection = {
    isTouchDevice: () => true,
    getDeviceType: () => 'mobile',
  };
  win.KeyboardHandler = { keyboardVisible: false };
  const vibrate = vi.fn();
  Object.defineProperty(win.navigator, 'vibrate', {
    configurable: true,
    value: vibrate,
  });
  win.app = {
    activeSessionId: 'session-1',
    terminal: {
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
    },
    sendTerminalKey: vi.fn(),
    jumpTerminalToLatest: vi.fn(),
    isTerminalAtBottom: vi.fn(() => true),
  };
  win.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  win.eval(`
    ${SOURCE}
    window.__testMobileNavigationPad = MobileNavigationPad;
    window.__testKeyboardAccessoryBar = KeyboardAccessoryBar;
    window.__testMobileTerminalControls = MobileTerminalControls;
  `);

  const pad = (win as unknown as { __testMobileNavigationPad: NavigationPad }).__testMobileNavigationPad;
  const accessory = (win as unknown as { __testKeyboardAccessoryBar: AccessoryBar }).__testKeyboardAccessoryBar;
  const controls = (win as unknown as { __testMobileTerminalControls: MobileControls }).__testMobileTerminalControls;
  controls.init(true);

  return {
    dom,
    win,
    pad,
    accessory,
    controls,
    sendKey: win.app.sendTerminalKey,
    vibrate,
  };
}

describe('MobileTerminalControls settings migration', () => {
  let harness: ReturnType<typeof loadHarness>;

  beforeEach(() => {
    harness = loadHarness();
  });

  afterEach(() => {
    harness?.controls.cleanup();
    harness?.dom.window.close();
  });

  it.each([
    [{ mobileTerminalControlsEnabled: true }, {}, true, true],
    [{ mobileTerminalControlsEnabled: false }, {}, true, false],
    [{ mobileNavigationPadEnabled: true }, {}, true, true],
    [{ mobileNavigationPadEnabled: false }, { mobileTerminalControlsEnabled: true }, true, false],
    [{ extendedKeyboardBar: true }, {}, false, true],
    [{ extendedKeyboardBar: false }, {}, true, false],
    [{ extendedKeyboardBar: false }, {}, false, false],
    [{}, { mobileTerminalControlsEnabled: true }, false, true],
  ])(
    'resolves canonical and legacy settings without changing old false semantics',
    (settings, defaults, touchDevice, expected) => {
      expect(harness.controls.resolveEnabled(settings, defaults, touchDevice)).toBe(expected);
    }
  );
});

describe('MobileNavigationPad', () => {
  let harness: ReturnType<typeof loadHarness>;

  beforeEach(() => {
    harness = loadHarness();
  });

  afterEach(() => {
    harness?.controls.cleanup();
    harness?.dom.window.close();
  });

  it('shows only for an active phone session while the keyboard is hidden', () => {
    const { pad, win } = harness;
    expect(pad.element?.classList.contains('visible')).toBe(true);
    expect(win.document.body.classList.contains('mobile-nav-visible')).toBe(true);
    expect(pad.element?.getAttribute('aria-hidden')).toBe('false');

    win.KeyboardHandler.keyboardVisible = true;
    pad.syncVisibility();
    expect(pad.element?.classList.contains('visible')).toBe(false);

    win.KeyboardHandler.keyboardVisible = false;
    win.app.activeSessionId = null;
    pad.syncVisibility();
    expect(pad.element?.classList.contains('visible')).toBe(false);
  });

  it('hides behind active dialogs and restores itself when they close', async () => {
    const { pad, win } = harness;
    const modal = win.document.createElement('div');
    modal.className = 'modal';
    win.document.body.appendChild(modal);

    modal.classList.add('active');
    await Promise.resolve();
    expect(pad.element?.classList.contains('visible')).toBe(false);
    expect(pad.element?.getAttribute('aria-hidden')).toBe('true');
    expect(win.document.body.classList.contains('mobile-nav-visible')).toBe(false);

    modal.classList.remove('active');
    await Promise.resolve();
    expect(pad.element?.classList.contains('visible')).toBe(true);
    expect(pad.element?.getAttribute('aria-hidden')).toBe('false');
  });

  it('tracks dynamically inserted and inline-display dialogs', async () => {
    const { pad, win } = harness;
    const dynamicModal = win.document.createElement('div');
    dynamicModal.className = 'modal active';
    win.document.body.appendChild(dynamicModal);
    await Promise.resolve();
    expect(pad.element?.classList.contains('visible')).toBe(false);

    dynamicModal.remove();
    await Promise.resolve();
    expect(pad.element?.classList.contains('visible')).toBe(true);

    const inlineModal = win.document.createElement('div');
    inlineModal.className = 'modal';
    inlineModal.style.display = 'flex';
    win.document.body.appendChild(inlineModal);
    await Promise.resolve();
    expect(pad.element?.classList.contains('visible')).toBe(false);

    inlineModal.style.display = 'none';
    await Promise.resolve();
    expect(pad.element?.classList.contains('visible')).toBe(true);
  });

  it('sends one arrow on release without focusing the terminal', () => {
    const { pad, sendKey, win } = harness;
    const up = pad.element!.querySelector('[data-nav-key="up"]')!;

    dispatchPointer(win, up, 'pointerdown', 1);
    expect(sendKey).not.toHaveBeenCalled();
    dispatchPointer(win, up, 'pointerup', 1);

    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(sendKey).toHaveBeenCalledWith('\x1b[A');
    expect(win.app.terminal.focus).not.toHaveBeenCalled();
  });

  it('provides configurable haptic feedback for accepted controls', () => {
    const { controls, pad, vibrate, win } = harness;
    const up = pad.element!.querySelector('[data-nav-key="up"]')!;

    controls.configureFeedback({
      mobileControlHaptics: true,
      mobileControlSound: false,
    });
    dispatchPointer(win, up, 'pointerdown', 1);
    dispatchPointer(win, up, 'pointerup', 1);
    expect(vibrate).toHaveBeenCalledWith(10);

    controls.configureFeedback({
      mobileControlHaptics: false,
      mobileControlSound: false,
    });
    dispatchPointer(win, up, 'pointerdown', 2);
    dispatchPointer(win, up, 'pointerup', 2);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('plays an optional short Web Audio tone', () => {
    const { controls, win } = harness;
    const start = vi.fn();
    const stop = vi.fn();
    const setFrequency = vi.fn();
    const setGain = vi.fn();
    const rampGain = vi.fn();
    class FakeAudioContext {
      currentTime = 1;
      state = 'running';
      destination = {};
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime: setFrequency },
          connect: vi.fn(),
          start,
          stop,
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: setGain,
            exponentialRampToValueAtTime: rampGain,
          },
          connect: vi.fn(),
        };
      }
    }
    Object.defineProperty(win, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });

    controls.configureFeedback({
      mobileControlHaptics: false,
      mobileControlSound: true,
    });
    controls.feedback('enter');

    expect(setFrequency).toHaveBeenCalledWith(760, 1);
    expect(setGain).toHaveBeenCalledWith(0.025, 1);
    expect(rampGain).toHaveBeenCalledWith(0.0001, 1.035);
    expect(start).toHaveBeenCalledWith(1);
    expect(stop).toHaveBeenCalledWith(1.04);
  });

  it('turns a simultaneous Up+Down press into Enter without leaking arrows', () => {
    const { pad, sendKey, win } = harness;
    const up = pad.element!.querySelector('[data-nav-key="up"]')!;
    const down = pad.element!.querySelector('[data-nav-key="down"]')!;

    dispatchPointer(win, up, 'pointerdown', 1);
    dispatchPointer(win, down, 'pointerdown', 2);
    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(sendKey).toHaveBeenCalledWith('\r');
    expect(pad.element?.classList.contains('chord-active')).toBe(true);

    dispatchPointer(win, up, 'pointerup', 1);
    dispatchPointer(win, down, 'pointerup', 2);
    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(pad.element?.classList.contains('chord-active')).toBe(false);
  });

  it('uses exposed hardware volume keys without focusing the terminal', () => {
    const { sendKey, win } = harness;

    const down = dispatchVolumeKey(win, 'keydown', 'AudioVolumeUp');
    expect(down.defaultPrevented).toBe(true);
    expect(sendKey).not.toHaveBeenCalled();

    const up = dispatchVolumeKey(win, 'keyup', 'AudioVolumeUp');
    expect(up.defaultPrevented).toBe(true);
    expect(sendKey).toHaveBeenCalledOnce();
    expect(sendKey).toHaveBeenCalledWith('\x1b[A');
    expect(win.app.terminal.focus).not.toHaveBeenCalled();
  });

  it('turns simultaneous volume directions into one Enter without leaking arrows', () => {
    const { pad, sendKey, win } = harness;

    dispatchVolumeKey(win, 'keydown', 'AudioVolumeUp');
    dispatchVolumeKey(win, 'keydown', 'AudioVolumeDown');
    expect(sendKey).toHaveBeenCalledOnce();
    expect(sendKey).toHaveBeenCalledWith('\r');
    expect(pad.element?.classList.contains('chord-active')).toBe(true);

    dispatchVolumeKey(win, 'keyup', 'AudioVolumeUp');
    dispatchVolumeKey(win, 'keyup', 'AudioVolumeDown');
    expect(sendKey).toHaveBeenCalledOnce();
    expect(pad.element?.classList.contains('chord-active')).toBe(false);
  });

  it('leaves volume keys alone while the mobile controls are unavailable', async () => {
    const { pad, sendKey, win } = harness;
    const modal = win.document.createElement('div');
    modal.className = 'modal';
    win.document.body.appendChild(modal);
    modal.classList.add('active');
    await Promise.resolve();
    expect(pad.element?.classList.contains('visible')).toBe(false);

    const down = dispatchVolumeKey(win, 'keydown', 'AudioVolumeDown');
    const up = dispatchVolumeKey(win, 'keyup', 'AudioVolumeDown');

    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('keeps an explicit Enter button available for one-finger and switch input', () => {
    const { pad, sendKey } = harness;
    const enter = pad.element!.querySelector('[data-nav-key="enter"]') as HTMLButtonElement;

    enter.click();

    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(sendKey).toHaveBeenCalledWith('\r');
  });

  it('maps vertical swipes on the bar to arrows and ignores short movement', () => {
    const { pad, sendKey, win } = harness;
    const bar = pad.element!;

    dispatchPointer(win, bar, 'pointerdown', 10, 100);
    dispatchPointer(win, bar, 'pointerup', 10, 50);
    dispatchPointer(win, bar, 'pointerdown', 11, 50);
    dispatchPointer(win, bar, 'pointerup', 11, 100);
    dispatchPointer(win, bar, 'pointerdown', 12, 50);
    dispatchPointer(win, bar, 'pointerup', 12, 70);

    expect(sendKey).toHaveBeenNthCalledWith(1, '\x1b[A');
    expect(sendKey).toHaveBeenNthCalledWith(2, '\x1b[B');
    expect(sendKey).toHaveBeenCalledTimes(2);
  });

  it('drops canceled pointers without sending or leaving a pressed state', () => {
    const { pad, sendKey, win } = harness;
    const down = pad.element!.querySelector('[data-nav-key="down"]')!;

    dispatchPointer(win, down, 'pointerdown', 5);
    dispatchPointer(win, down, 'pointercancel', 5);

    expect(sendKey).not.toHaveBeenCalled();
    expect(down.classList.contains('pressed')).toBe(false);
  });

  it('shows jump-to-latest only away from the bottom and never focuses xterm', () => {
    const { pad, accessory, sendKey, win } = harness;
    const jump = pad.element!.querySelector('[data-nav-key="jump-bottom"]') as HTMLButtonElement;

    expect(jump).not.toBeNull();
    expect(jump.hidden).toBe(true);
    expect(accessory.element!.querySelector('[data-action="jump-bottom"]')).toBeNull();

    win.app.isTerminalAtBottom.mockReturnValue(false);
    pad.syncJumpVisibility();
    expect(jump.hidden).toBe(false);
    jump.click();

    expect(win.app.jumpTerminalToLatest).toHaveBeenCalledOnce();
    expect(win.app.terminal.focus).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();

    win.app.isTerminalAtBottom.mockReturnValue(true);
    pad.syncJumpVisibility();
    expect(jump.hidden).toBe(true);
  });
});
