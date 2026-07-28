/**
 * @fileoverview Mobile keyboard controls and modal focus trap.
 *
 * Defines four exports:
 *
 * - MobileTerminalControls (singleton object) — Product-level facade that owns
 *   initialization, enablement, modal visibility, and shared key mappings for
 *   both responsive control surfaces.
 *
 * - KeyboardAccessoryBar (singleton object) — Quick action buttons shown above the virtual
 *   keyboard on mobile: arrows, Tab, Esc, commands, paste, and dismiss.
 *   The paste button opens a dialog that handles both text paste and image attach
 *   (native picker + best-effort image paste, routed through app._uploadAndInsertImages).
 *   Destructive actions (/clear, /compact) require double-tap confirmation (2s amber state).
 *   Commands are sent as text + Enter separately for Ink compatibility.
 *   Only initializes on touch devices (MobileDetection.isTouchDevice guard).
 *
 * - MobileNavigationPad (singleton object) — Keyboard-hidden Esc/Up/Enter/Down/Tab controls
 *   for terminal menus plus a contextual jump-to-latest action. A simultaneous Up+Down
 *   press emits Enter, and vertical swipes on the surrounding bar emit arrow keys without
 *   focusing xterm or opening the keyboard.
 *
 * - FocusTrap (class) — Traps Tab/Shift+Tab keyboard focus within a modal element.
 *   Saves and restores previously focused element on deactivate. Used by Ralph wizard
 *   and other modal dialogs.
 *
 * @globals {object} KeyboardAccessoryBar
 * @globals {object} MobileNavigationPad
 * @globals {object} MobileTerminalControls
 * @globals {class} FocusTrap
 *
 * @dependency mobile-handlers.js (MobileDetection.isTouchDevice)
 * @dependency app.js (uses global `app` for sendInput, activeSessionId, terminal)
 * @loadorder 5 of 15 — loaded after notification-manager.js, before app.js
 */

// Codeman — Keyboard accessory bar and focus trap for modals
// Loaded after mobile-handlers.js, before app.js

const TERMINAL_CONTROL_SEQUENCES = Object.freeze({
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  shiftTab: '\x1b[Z',
  ctrlO: '\x0f',
  optionEnter: '\x1b\r',
});

const TERMINAL_ACCESSORY_KEY_ACTIONS = Object.freeze({
  'scroll-up': 'up',
  'scroll-down': 'down',
  'arrow-left': 'left',
  'arrow-right': 'right',
  esc: 'esc',
  'opt-enter': 'optionEnter',
  tab: 'tab',
  'shift-tab': 'shiftTab',
  'ctrl-o': 'ctrlO',
});

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Accessory Bar
// ═══════════════════════════════════════════════════════════════

/**
 * KeyboardAccessoryBar - Quick action buttons shown above keyboard when typing.
 */
const KeyboardAccessoryBar = {
  element: null,
  enabled: false,

  /** Full keyboard-open control set. */
  _buttons: `
      <button class="accessory-btn" data-action="esc" title="Escape">Esc</button>
      <button class="accessory-btn accessory-btn-arrow" data-action="arrow-left" title="Arrow left">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M15 19l-7-7 7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-up" title="Arrow up">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="opt-enter" title="Option+Enter (newline)">⌥Enter</button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-down" title="Arrow down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="arrow-right" title="Arrow right">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M9 5l7 7-7 7"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="tab" title="Tab">Tab</button>
      <button class="accessory-btn" data-action="shift-tab" title="Shift+Tab">⇧Tab</button>
      <button class="accessory-btn" data-action="paste" title="Paste from clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="effort-max" title="/effort max">Max</button>
      <button class="accessory-btn" data-action="ctrl-o" title="Ctrl+O">⌃O</button>
      <button class="accessory-btn" data-action="init" title="/init">/init</button>
      <button class="accessory-btn" data-action="clear" title="/clear">/clear</button>
      <button class="accessory-btn" data-action="compact" title="/compact">/compact</button>
      <button class="accessory-btn accessory-btn-dismiss" data-action="dismiss" title="Dismiss keyboard">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>`,

  /** Create and inject the accessory bar */
  init() {
    // Only on mobile
    if (!MobileDetection.isTouchDevice() || this.element) return;

    // Create accessory bar element
    this.element = document.createElement('div');
    this.element.className = 'keyboard-accessory-bar';
    this.element.innerHTML = this._buttons;

    // Add click handlers — preventDefault stops event from reaching terminal
    this.element.addEventListener('click', (e) => {
      const btn = e.target.closest('.accessory-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const action = btn.dataset.action;
      this.handleAction(action, btn);

      // Refocus terminal so keyboard stays open (tap blurs terminal → keyboard dismisses → toolbar shifts)
      const refocusActions = new Set(['scroll-up', 'scroll-down', 'arrow-left', 'arrow-right', 'tab', 'shift-tab', 'ctrl-o', 'opt-enter', 'esc', 'effort-max']);
      if (refocusActions.has(action) ||
          ((action === 'clear' || action === 'compact') && this._confirmAction)) {
        if (typeof app !== 'undefined' && app.terminal) {
          app.terminal.focus();
        }
      }
    });

    // Insert before toolbar
    const toolbar = document.querySelector('.toolbar');
    if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.insertBefore(this.element, toolbar);
    }
  },

  /** Enable or disable the keyboard-open surface of mobile terminal controls. */
  setEnabled(enabled) {
    this.enabled = enabled === true;
    this.syncVisibility();
  },

  /** Match the accessory surface to keyboard and modal state. */
  syncVisibility() {
    if (!this.element) return;
    const keyboardVisible =
      (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) ||
      document.body.classList.contains('keyboard-visible');
    const hasSession = typeof app !== 'undefined' && Boolean(app.activeSessionId);
    const hasOpenDialog = MobileTerminalControls.hasOpenDialog();
    const visible = this.enabled && hasSession && keyboardVisible && !hasOpenDialog;
    this.element.classList.toggle('visible', visible);
    document.body.classList.toggle('keyboard-accessory-visible', visible);
    if (!visible) this.clearConfirm();
  },

  _confirmTimer: null,
  _confirmAction: null,

  /** Handle accessory button actions */
  handleAction(action, btn) {
    if (typeof app === 'undefined' || !app.activeSessionId) return;
    const terminalKey = TERMINAL_ACCESSORY_KEY_ACTIONS[action];
    if (terminalKey) {
      MobileTerminalControls.sendKey(terminalKey);
      return;
    }

    switch (action) {
      case 'effort-max':
        this.sendCommand('/effort max');
        break;
      case 'init':
        this.sendCommand('/init');
        break;
      case 'clear':
      case 'compact': {
        const cmd = action === 'clear' ? '/clear' : '/compact';
        if (this._confirmAction === action && this._confirmTimer) {
          this.clearConfirm();
          this.sendCommand(cmd);
        } else {
          this.setConfirm(action, btn);
        }
        break;
      }
      case 'paste':
        this.pasteFromClipboard();
        break;
      case 'dismiss':
        // Blur active element to dismiss keyboard
        document.activeElement?.blur();
        break;
      default:
        return;
    }
    MobileTerminalControls.feedback(action);
  },

  /** Enter confirm state: button turns amber for 2s waiting for second tap */
  setConfirm(action, btn) {
    this.clearConfirm();
    this._confirmAction = action;
    if (btn) {
      btn.classList.add('confirming');
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Tap again';
    }
    this._confirmTimer = setTimeout(() => this.clearConfirm(), 2000);
  },

  /** Reset confirm state */
  clearConfirm() {
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    }
    if (this._confirmAction && this.element) {
      const btn = this.element.querySelector(`[data-action="${this._confirmAction}"]`);
      if (btn && btn.dataset.origHtml) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
      }
      if (btn) btn.classList.remove('confirming');
    }
    this._confirmAction = null;
  },

  /** Send a slash command to the active session.
   *  Sends text and Enter separately so Ink processes them as distinct events. */
  sendCommand(command) {
    if (!app.activeSessionId) return;
    // The durable input queue preserves these as two ordered records.
    app.sendInput(command);
    app.sendInput('\r');
  },

  /** Show a paste overlay for iOS compatibility.
   *  Handles three input paths from one dialog:
   *   - Text: long-press the textarea → Paste → Send (unchanged).
   *   - Image (picker): the "Image" button opens a native file picker
   *     (accept=image/* → camera / photo library / files), the most reliable
   *     way to attach a photo on mobile.
   *   - Image (paste): if the browser exposes image blobs on the textarea's
   *     paste event, we intercept them and upload directly. Support is spotty
   *     on mobile, so it is a best-effort enhancement layered on the picker.
   *  All image paths reuse app._uploadAndInsertImages() (image-input.js), which
   *  uploads to /api/sessions/:id/paste-image and inserts the saved path. */
  pasteFromClipboard() {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay';
    overlay.innerHTML = `
      <div class="paste-dialog">
        <textarea class="paste-textarea" placeholder="Long-press to paste text — or tap 🖼 to attach an image"></textarea>
        <div class="paste-actions">
          <button class="paste-image">🖼 Image</button>
          <button class="paste-cancel">Cancel</button>
          <button class="paste-send">Send</button>
        </div>
        <input type="file" class="paste-file-input" accept="image/*" multiple hidden>
      </div>
    `;

    const textarea = overlay.querySelector('.paste-textarea');
    const fileInput = overlay.querySelector('.paste-file-input');

    const close = () => overlay.remove();

    const sendText = () => {
      const text = textarea.value;
      close();
      if (text) {
        app.sendPastedText(text, { submit: true });
      }
    };

    // Filter to images, close the dialog, and hand off to the shared
    // upload+insert pipeline. Returns true if any image was handled.
    const handleImages = (files) => {
      const images = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return false;
      close();
      if (typeof app._uploadAndInsertImages === 'function') app._uploadAndInsertImages(images);
      return true;
    };

    // Image picker (camera / photo library) — the reliable mobile path.
    overlay.querySelector('.paste-image').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => handleImages(fileInput.files));

    // Best-effort: capture images pasted straight into the textarea.
    textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const imageFiles = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const blob = items[i].getAsFile();
          if (blob) imageFiles.push(blob);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleImages(imageFiles);
      }
    });

    overlay.querySelector('.paste-cancel').addEventListener('click', close);
    overlay.querySelector('.paste-send').addEventListener('click', sendText);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    document.body.appendChild(overlay);
    textarea.focus();
  },

};

// ═══════════════════════════════════════════════════════════════
// Keyboard-hidden terminal navigation
// ═══════════════════════════════════════════════════════════════

/**
 * MobileNavigationPad - Persistent terminal-menu controls for phone layouts.
 *
 * Arrow actions are emitted on pointer release so a second simultaneous pointer
 * can turn an Up+Down pair into Enter without leaking the first arrow.
 */
const MobileNavigationPad = {
  element: null,
  enabled: false,
  _pointers: new Map(),
  _consumedPointers: new Set(),
  _chordActive: false,
  _volumeKeys: new Map(),
  _volumeChordActive: false,
  _swipeDistance: 36,
  _swipeTime: 600,

  _buttons: `
    <button type="button"
            class="mobile-terminal-nav-btn mobile-terminal-nav-jump"
            data-nav-key="jump-bottom" aria-label="Jump to latest output"
            title="Jump to latest output" aria-hidden="true" hidden>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 17V3"/>
        <path d="m6 11 6 6 6-6"/>
        <path d="M19 21H5"/>
      </svg>
    </button>
    <button type="button" class="mobile-terminal-nav-btn mobile-terminal-nav-key"
            data-nav-key="esc" aria-label="Escape" title="Escape">Esc</button>
    <button type="button" class="mobile-terminal-nav-btn" data-nav-key="up"
            aria-label="Terminal menu up" title="Terminal menu up">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6 15 6-6 6 6"/>
      </svg>
    </button>
    <button type="button" class="mobile-terminal-nav-btn mobile-terminal-nav-enter"
            data-nav-key="enter" aria-label="Terminal menu enter" title="Enter">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 10 4 15l5 5"/>
        <path d="M20 4v7a4 4 0 0 1-4 4H4"/>
      </svg>
    </button>
    <button type="button" class="mobile-terminal-nav-btn" data-nav-key="down"
            aria-label="Terminal menu down" title="Terminal menu down">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6 9 6 6 6-6"/>
      </svg>
    </button>
    <button type="button" class="mobile-terminal-nav-btn mobile-terminal-nav-key"
            data-nav-key="tab" aria-label="Tab" title="Tab">Tab</button>`,

  init(enabled = false) {
    if (!MobileDetection.isTouchDevice() || this.element) return;

    this.element = document.createElement('div');
    this.element.className = 'mobile-terminal-nav';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Terminal menu navigation');
    this.element.setAttribute('aria-hidden', 'true');
    this.element.innerHTML = this._buttons;

    this._pointerDownHandler = (e) => this.onPointerDown(e);
    this._pointerUpHandler = (e) => this.onPointerUp(e);
    this._pointerCancelHandler = (e) => this.onPointerCancel(e);
    this._clickHandler = (e) => this.onClick(e);
    this._volumeKeyDownHandler = (e) => this.onVolumeKeyDown(e);
    this._volumeKeyUpHandler = (e) => this.onVolumeKeyUp(e);

    this.element.addEventListener('pointerdown', this._pointerDownHandler);
    this.element.addEventListener('pointerup', this._pointerUpHandler);
    this.element.addEventListener('pointercancel', this._pointerCancelHandler);
    this.element.addEventListener('lostpointercapture', this._pointerCancelHandler);
    this.element.addEventListener('click', this._clickHandler);
    document.addEventListener('keydown', this._volumeKeyDownHandler, true);
    document.addEventListener('keyup', this._volumeKeyUpHandler, true);
    document.body.appendChild(this.element);

    this.setEnabled(enabled);
  },

  setEnabled(enabled) {
    this.enabled = enabled === true;
    this.syncVisibility();
  },

  syncVisibility() {
    if (!this.element) return;

    const keyboardVisible =
      (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) ||
      document.body.classList.contains('keyboard-visible');
    const isPhoneLayout =
      typeof MobileDetection !== 'undefined' &&
      MobileDetection.isTouchDevice() &&
      MobileDetection.getDeviceType() !== 'desktop';
    const hasSession = typeof app !== 'undefined' && Boolean(app.activeSessionId);
    const hasOpenDialog = MobileTerminalControls.hasOpenDialog();
    const visible =
      this.enabled && isPhoneLayout && hasSession && !keyboardVisible && !hasOpenDialog;

    this.element.classList.toggle('visible', visible);
    this.element.setAttribute('aria-hidden', visible ? 'false' : 'true');
    for (const button of this.element.querySelectorAll('button')) {
      button.disabled = !visible;
    }
    this.syncJumpVisibility(visible);
    document.body.classList.toggle('mobile-nav-visible', visible);

    if (!visible) {
      this.resetPointers();
      this.resetVolumeKeys();
    }
  },

  syncJumpVisibility(navigationVisible = this.element?.classList.contains('visible')) {
    const button = this.element?.querySelector('[data-nav-key="jump-bottom"]');
    if (!(button instanceof HTMLButtonElement)) return;

    const hasSession = typeof app !== 'undefined' && Boolean(app.activeSessionId);
    const readingHistory =
      typeof app !== 'undefined' && typeof app.isTerminalReadingHistory === 'function'
        ? app.isTerminalReadingHistory()
        : typeof app !== 'undefined' && typeof app.isTerminalAtBottom === 'function'
          ? !app.isTerminalAtBottom()
          : false;
    const visible = Boolean(navigationVisible && hasSession && readingHistory);
    button.hidden = !visible;
    button.disabled = !visible;
    button.setAttribute('aria-hidden', visible ? 'false' : 'true');
    this.element.classList.toggle('jump-visible', visible);
  },

  blurTerminalInput() {
    const active = document.activeElement;
    const terminalTextarea =
      typeof app !== 'undefined' && app.terminal ? app.terminal.textarea : null;
    const isTerminalInput =
      active === terminalTextarea ||
      active?.classList?.contains('xterm-helper-textarea') ||
      active?.id === 'cjkInput';
    if (isTerminalInput) active.blur();
  },

  onPointerDown(e) {
    if (!this.element?.classList.contains('visible')) return;

    const button = e.target.closest?.('[data-nav-key]');
    const key = button?.dataset.navKey || 'swipe';
    // Android can leave xterm's hidden textarea focused after the user dismisses
    // the keyboard. Release it inside the trusted touch gesture before sending
    // terminal input, otherwise the same gesture may reopen the keyboard.
    this.blurTerminalInput();
    e.preventDefault();
    e.stopPropagation();

    this._pointers.set(e.pointerId, {
      key,
      button: button || null,
      startY: e.clientY,
      startedAt: Date.now(),
    });
    button?.classList.add('pressed');

    try {
      (button || this.element).setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic test events are not registered as active OS pointers.
    }

    if ((key === 'up' || key === 'down') && !this._chordActive) {
      const opposite = key === 'up' ? 'down' : 'up';
      const oppositeEntry = [...this._pointers.entries()].find(
        ([pointerId, state]) => pointerId !== e.pointerId && state.key === opposite
      );
      if (oppositeEntry) {
        this._consumedPointers.add(e.pointerId);
        this._consumedPointers.add(oppositeEntry[0]);
        this._chordActive = true;
        this.element.classList.add('chord-active');
        this.sendKey('enter');
      }
    }
  },

  onPointerUp(e) {
    const state = this._pointers.get(e.pointerId);
    if (!state) return;

    e.preventDefault();
    e.stopPropagation();
    const consumed = this._consumedPointers.has(e.pointerId);

    if (!consumed) {
      if (state.key === 'swipe') {
        const elapsed = Date.now() - state.startedAt;
        const deltaY = e.clientY - state.startY;
        if (elapsed <= this._swipeTime && Math.abs(deltaY) >= this._swipeDistance) {
          this.sendKey(deltaY < 0 ? 'up' : 'down');
        }
      } else {
        this.sendKey(state.key);
      }
    }

    this.releasePointer(e.pointerId, state);
  },

  onPointerCancel(e) {
    const state = this._pointers.get(e.pointerId);
    if (!state) return;
    this.releasePointer(e.pointerId, state);
  },

  releasePointer(pointerId, state) {
    this._pointers.delete(pointerId);
    this._consumedPointers.delete(pointerId);

    if (
      state.button &&
      ![...this._pointers.values()].some((pointer) => pointer.button === state.button)
    ) {
      state.button.classList.remove('pressed');
    }

    const pointerDirectionHeld = [...this._pointers.values()].some(
      (pointer) => pointer.key === 'up' || pointer.key === 'down'
    );
    if (!pointerDirectionHeld) {
      this._chordActive = false;
      this.syncChordVisual();
    }
  },

  onClick(e) {
    const button = e.target.closest?.('[data-nav-key]');
    if (!button) return;

    this.blurTerminalInput();
    e.preventDefault();
    e.stopPropagation();
    // Pointer input is handled above. detail=0 preserves keyboard/switch-control activation.
    if (e.detail === 0 && this.element?.classList.contains('visible')) {
      this.sendKey(button.dataset.navKey);
    }
  },

  volumeDirection(e) {
    const values = [e.key, e.code];
    if (values.includes('AudioVolumeUp') || values.includes('VolumeUp')) return 'up';
    if (values.includes('AudioVolumeDown') || values.includes('VolumeDown')) return 'down';
    return null;
  },

  onVolumeKeyDown(e) {
    const direction = this.volumeDirection(e);
    if (!direction || !this.element?.classList.contains('visible')) return;

    this.blurTerminalInput();
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;

    // Recover from a missing keyup before recording a fresh physical press.
    if (this._volumeKeys.has(direction)) {
      this.releaseVolumeKey(direction);
    }

    const state = { consumed: false };
    this._volumeKeys.set(direction, state);
    this.syncDirectionPressed(direction);

    const opposite = direction === 'up' ? 'down' : 'up';
    const oppositeState = this._volumeKeys.get(opposite);
    if (oppositeState && !this._volumeChordActive) {
      state.consumed = true;
      oppositeState.consumed = true;
      this._volumeChordActive = true;
      this.syncChordVisual();
      this.sendKey('enter');
    }
  },

  onVolumeKeyUp(e) {
    const direction = this.volumeDirection(e);
    const state = direction && this._volumeKeys.get(direction);
    if (!state) return;

    e.preventDefault();
    e.stopPropagation();
    if (!state.consumed && this.element?.classList.contains('visible')) {
      this.sendKey(direction);
    }
    this.releaseVolumeKey(direction);
  },

  releaseVolumeKey(direction) {
    this._volumeKeys.delete(direction);
    this.syncDirectionPressed(direction);

    if (this._volumeKeys.size === 0) {
      this._volumeChordActive = false;
      this.syncChordVisual();
    }
  },

  syncDirectionPressed(direction) {
    const button = this.element?.querySelector(`[data-nav-key="${direction}"]`);
    if (!button) return;

    const pointerHeld = [...this._pointers.values()].some(
      (pointer) => pointer.key === direction
    );
    button.classList.toggle('pressed', pointerHeld || this._volumeKeys.has(direction));
  },

  syncChordVisual() {
    this.element?.classList.toggle(
      'chord-active',
      this._chordActive || this._volumeChordActive
    );
  },

  sendKey(key) {
    if (key === 'jump-bottom') {
      if (typeof app === 'undefined' || !app.activeSessionId) return;
      app.jumpTerminalToLatest?.();
      MobileTerminalControls.feedback(key);
      this.syncJumpVisibility();
      return;
    }
    MobileTerminalControls.sendKey(key);
  },

  resetPointers() {
    this._pointers.clear();
    this._consumedPointers.clear();
    this._chordActive = false;
    this.element?.classList.remove('chord-active');
    for (const button of this.element?.querySelectorAll('.pressed') || []) {
      button.classList.remove('pressed');
    }
  },

  resetVolumeKeys() {
    this._volumeKeys.clear();
    this._volumeChordActive = false;
    this.syncChordVisual();
    for (const direction of ['up', 'down']) {
      this.syncDirectionPressed(direction);
    }
  },

  cleanup() {
    if (!this.element) return;
    this.resetPointers();
    this.resetVolumeKeys();
    this.element.removeEventListener('pointerdown', this._pointerDownHandler);
    this.element.removeEventListener('pointerup', this._pointerUpHandler);
    this.element.removeEventListener('pointercancel', this._pointerCancelHandler);
    this.element.removeEventListener('lostpointercapture', this._pointerCancelHandler);
    this.element.removeEventListener('click', this._clickHandler);
    document.removeEventListener('keydown', this._volumeKeyDownHandler, true);
    document.removeEventListener('keyup', this._volumeKeyUpHandler, true);
    this.element.remove();
    this.element = null;
    document.body.classList.remove('mobile-nav-visible');
  },
};

// ═══════════════════════════════════════════════════════════════
// Unified mobile terminal controls
// ═══════════════════════════════════════════════════════════════

/**
 * MobileTerminalControls - Product-level owner for the two responsive surfaces.
 */
const MobileTerminalControls = {
  enabled: false,
  hapticsEnabled: true,
  soundEnabled: false,
  _audioContext: null,
  _modalObserver: null,

  /**
   * Resolve the canonical per-device setting while preserving both shipped
   * legacy formats. The old extendedKeyboardBar=false selected a smaller bar;
   * it never disabled mobile controls, so touch devices still default on.
   */
  resolveEnabled(settings = {}, defaults = {}, isTouchDevice = null) {
    if (typeof settings?.mobileTerminalControlsEnabled === 'boolean') {
      return settings.mobileTerminalControlsEnabled;
    }
    if (typeof settings?.mobileNavigationPadEnabled === 'boolean') {
      return settings.mobileNavigationPadEnabled;
    }
    if (typeof defaults?.mobileTerminalControlsEnabled === 'boolean') {
      return defaults.mobileTerminalControlsEnabled;
    }
    if (settings?.extendedKeyboardBar === true || defaults?.extendedKeyboardBar === true) {
      return true;
    }
    const touchDevice =
      typeof isTouchDevice === 'boolean'
        ? isTouchDevice
        : typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice();
    return touchDevice;
  },

  init(enabled = false) {
    KeyboardAccessoryBar.init();
    MobileNavigationPad.init(false);
    this._installModalObserver();
    this.setEnabled(enabled);
  },

  configureFeedback(settings = {}, defaults = {}) {
    this.hapticsEnabled =
      settings.mobileControlHaptics ?? defaults.mobileControlHaptics ?? true;
    this.soundEnabled =
      settings.mobileControlSound ?? defaults.mobileControlSound ?? false;
  },

  setEnabled(enabled) {
    this.enabled = enabled === true;
    KeyboardAccessoryBar.setEnabled(this.enabled);
    MobileNavigationPad.setEnabled(this.enabled);
  },

  syncVisibility() {
    KeyboardAccessoryBar.syncVisibility();
    MobileNavigationPad.syncVisibility();
  },

  blurTerminalInput() {
    MobileNavigationPad.blurTerminalInput();
  },

  sendKey(action) {
    const sequence = TERMINAL_CONTROL_SEQUENCES[action];
    if (!sequence || typeof app === 'undefined' || !app.activeSessionId) return;
    app.sendTerminalKey(sequence);
    this.feedback(action);
  },

  feedback(action) {
    if (this.hapticsEnabled && navigator.vibrate) {
      try {
        navigator.vibrate(action === 'enter' ? 18 : 10);
      } catch {
        // Vibration is optional and may be blocked by browser policy.
      }
    }
    if (!this.soundEnabled) return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      const context = this._audioContext || new AudioContext();
      this._audioContext = context;
      const play = () => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const now = context.currentTime;
        const frequencies = { up: 620, down: 440, enter: 760, esc: 320, tab: 540 };
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequencies[action] || 500, now);
        gain.gain.setValueAtTime(0.025, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.04);
      };
      if (context.state === 'suspended') {
        context.resume().then(play).catch(() => {});
      } else {
        play();
      }
    } catch {
      // Audio feedback is best-effort on browsers without a usable Web Audio context.
    }
  },

  /** True when a pointer target will perform its own semantic key claim. */
  isKeyControlTarget(target) {
    if (!target?.closest) return false;
    if (target.closest('.mobile-terminal-nav')) return true;
    const accessoryButton = target.closest('.keyboard-accessory-bar [data-action]');
    return Boolean(TERMINAL_ACCESSORY_KEY_ACTIONS[accessoryButton?.dataset.action]);
  },

  /** Match every modal convention currently used by Codeman's UI modules. */
  hasOpenDialog() {
    return [...document.querySelectorAll('.modal')].some((modal) => {
      if (
        modal.classList.contains('active') ||
        modal.classList.contains('show') ||
        modal.hasAttribute('open')
      ) {
        return true;
      }
      return Boolean(modal.style.display && modal.style.display !== 'none');
    });
  },

  _installModalObserver() {
    if (
      this._modalObserver ||
      typeof MobileDetection === 'undefined' ||
      !MobileDetection.isTouchDevice()
    ) {
      return;
    }
    this._modalObserver = new MutationObserver((mutations) => {
      if (
        mutations.some(
          (mutation) =>
            mutation.target.classList?.contains('modal') ||
            (mutation.type === 'childList' &&
              [...mutation.addedNodes, ...mutation.removedNodes].some(
                (node) =>
                  node.nodeType === Node.ELEMENT_NODE &&
                  (node.matches?.('.modal') || node.querySelector?.('.modal'))
              ))
        )
      ) {
        this.syncVisibility();
      }
    });
    this._modalObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'open'],
    });
  },

  cleanup() {
    this._modalObserver?.disconnect();
    this._modalObserver = null;
    MobileNavigationPad.cleanup();
    KeyboardAccessoryBar.clearConfirm();
    KeyboardAccessoryBar.element?.remove();
    KeyboardAccessoryBar.element = null;
    KeyboardAccessoryBar.enabled = false;
    document.body.classList.remove('keyboard-accessory-visible');
    this._audioContext?.close?.().catch?.(() => {});
    this._audioContext = null;
    this.enabled = false;
  },
};

// ═══════════════════════════════════════════════════════════════
// Accessibility: Focus Trap for Modals
// ═══════════════════════════════════════════════════════════════

/**
 * FocusTrap - Traps keyboard focus within an element (typically a modal).
 * Saves the previously focused element and restores focus when deactivated.
 */
class FocusTrap {
  constructor(element) {
    this.element = element;
    this.previouslyFocused = null;
    this.boundHandleKeydown = this.handleKeydown.bind(this);
  }

  activate() {
    this.previouslyFocused = document.activeElement;
    this.element.addEventListener('keydown', this.boundHandleKeydown);

    // Focus first focusable element after a brief delay (for CSS transitions)
    requestAnimationFrame(() => {
      const focusable = this.getFocusableElements();
      if (focusable.length) {
        focusable[0].focus();
      }
    });
  }

  deactivate() {
    this.element.removeEventListener('keydown', this.boundHandleKeydown);
    if (this.previouslyFocused && typeof this.previouslyFocused.focus === 'function') {
      this.previouslyFocused.focus();
    }
  }

  getFocusableElements() {
    const selector = [
      'button:not([disabled]):not([tabindex="-1"])',
      'input:not([disabled]):not([tabindex="-1"])',
      'select:not([disabled]):not([tabindex="-1"])',
      'textarea:not([disabled]):not([tabindex="-1"])',
      'a[href]:not([tabindex="-1"])',
      '[tabindex]:not([tabindex="-1"]):not([disabled])'
    ].join(', ');

    return [...this.element.querySelectorAll(selector)].filter(
      el => el.offsetParent !== null // Exclude hidden elements
    );
  }

  handleKeydown(e) {
    if (e.key !== 'Tab') return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
