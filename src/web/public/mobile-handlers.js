/**
 * @fileoverview Mobile device support: detection, keyboard handling, and swipe navigation.
 *
 * Defines three singleton objects that manage mobile-specific behavior:
 *
 * - MobileDetection — Device type detection (mobile/tablet/desktop), touch capability,
 *   iOS/Safari identification, and body class management for CSS targeting.
 * - KeyboardHandler — Virtual keyboard show/hide detection via visualViewport API,
 *   toolbar/accessory bar repositioning, terminal resize on keyboard open/close,
 *   and input scroll-into-view. Uses 100px threshold for iOS address bar drift.
 * - SwipeHandler — Horizontal swipe detection on the terminal area for session switching.
 *   80px minimum distance, 300ms maximum time, 100px max vertical drift.
 *
 * All three have init()/cleanup() lifecycle methods. They are re-initialized after SSE
 * reconnect (in handleInit) to prevent stale closures.
 *
 * @globals {object} MobileDetection
 * @globals {object} KeyboardHandler
 * @globals {object} SwipeHandler
 *
 * @dependency keyboard-accessory.js (MobileTerminalControls references in KeyboardHandler, soft — guarded with typeof checks)
 * @loadorder 2 of 15 — loaded after constants.js, before voice-input.js
 */

// Codeman — Mobile detection, keyboard handling, and swipe navigation
// Loaded after constants.js, before app.js

// ═══════════════════════════════════════════════════════════════
// Mobile Detection
// ═══════════════════════════════════════════════════════════════

/**
 * MobileDetection - Detects device type and touch capability.
 * Updates body classes for CSS targeting.
 */
const MobileDetection = {
  /** Check if device supports touch input */
  isTouchDevice() {
    return (
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    );
  },

  /**
   * Check whether this browser belongs to a handheld device.
   *
   * Unlike getDeviceType(), this classification must remain stable when a
   * foldable changes posture. An unfolded phone can expose a desktop-width
   * viewport, but it still needs the same per-device settings that were saved
   * while folded. User-Agent Client Hints are preferred where available; the
   * legacy token fallback covers Android WebView and iPhone browsers.
   */
  isHandheldDevice() {
    if (!this.isTouchDevice()) return false;

    const userAgent = navigator.userAgent || '';

    // Prefer explicit UA form-factor signals. Besides matching real browsers,
    // this avoids Chromium emulation reporting userAgentData.mobile=true for
    // an iPad/tablet context created with isMobile=true.
    if (/iPad|Tablet|Silk|PlayBook|Kindle|Windows NT|CrOS|Macintosh/i.test(userAgent)) {
      return false;
    }
    if (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent)) return false;
    if (/Mobi|iPhone|iPod/i.test(userAgent)) return true;

    const uaDataMobile = navigator.userAgentData?.mobile;
    if (typeof uaDataMobile === 'boolean') return uaDataMobile;

    return false;
  },

  /** Check if device is iOS (iPhone, iPad, iPod) */
  isIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  },

  /** Check if browser is Safari */
  isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  },

  /** Check if screen is small (phone-sized, <430px) */
  isSmallScreen() {
    return window.innerWidth < 430;
  },

  /** Check if screen is medium (tablet-sized, 430-768px) */
  isMediumScreen() {
    return window.innerWidth >= 430 && window.innerWidth < 768;
  },

  /** Get device type based on screen width */
  getDeviceType() {
    const width = window.innerWidth;
    if (width < 430) return 'mobile';
    if (width < 768) return 'tablet';
    return 'desktop';
  },

  /** Update body classes based on device detection */
  updateBodyClass() {
    const body = document.body;
    const deviceType = this.getDeviceType();
    const isTouch = this.isTouchDevice();

    // Remove existing device classes
    body.classList.remove(
      'device-mobile',
      'device-tablet',
      'device-desktop',
      'touch-device',
      'handheld-device',
      'ios-device',
      'safari-browser'
    );

    // Add current device class
    body.classList.add(`device-${deviceType}`);

    // Add touch device class if applicable
    if (isTouch) {
      body.classList.add('touch-device');
    }

    if (this.isHandheldDevice()) {
      body.classList.add('handheld-device');
    }

    // Add iOS-specific class for safe area handling
    if (this.isIOS()) {
      body.classList.add('ios-device');
    }

    // Add Safari class for browser-specific fixes
    if (this.isSafari()) {
      body.classList.add('safari-browser');
    }
  },

  /** Set --app-height CSS variable from visual viewport.
   *  On iPad Safari with tabs, 100vh extends behind the tab bar.
   *  visualViewport.height reflects the actual visible area.
   *  Skips when virtual keyboard is open — KeyboardHandler manages
   *  layout via translateY + paddingBottom; shrinking --app-height
   *  would double-count and leave zero space for the terminal. */
  updateAppHeight() {
    if (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) return;
    const vh = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${vh}px`);
  },

  /** Initialize mobile detection and set up resize listener */
  init() {
    this.updateBodyClass();
    this.updateAppHeight();

    // Update --app-height on viewport resize (orientation, tab bar toggle)
    if (window.visualViewport) {
      this._appHeightHandler = () => this.updateAppHeight();
      window.visualViewport.addEventListener('resize', this._appHeightHandler);
    }

    // Debounced resize handler
    let resizeTimeout;
    this._resizeHandler = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.updateBodyClass();
        this.updateAppHeight();
        // Tab auto-wrap is width-driven, so it must re-evaluate on resize — the only
        // other trigger is a tab content render. No-op on mobile/tablet (method bails).
        if (typeof app !== 'undefined') app.updateTabOverflowMode?.();
        if (typeof MobileTerminalControls !== 'undefined') {
          MobileTerminalControls.syncVisibility();
        }
      }, 100);
    };
    window.addEventListener('resize', this._resizeHandler);

    // iOS: prevent pinch-to-zoom (Safari ignores user-scalable=no since iOS 10)
    if (this.isIOS()) {
      this._gestureStartHandler = (e) => e.preventDefault();
      this._gestureChangeHandler = (e) => e.preventDefault();
      document.addEventListener('gesturestart', this._gestureStartHandler);
      document.addEventListener('gesturechange', this._gestureChangeHandler);
    }
  },

  /** Remove event listeners */
  cleanup() {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._gestureStartHandler) {
      document.removeEventListener('gesturestart', this._gestureStartHandler);
      document.removeEventListener('gesturechange', this._gestureChangeHandler);
      this._gestureStartHandler = null;
      this._gestureChangeHandler = null;
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Handler
// ═══════════════════════════════════════════════════════════════

/**
 * KeyboardHandler - Simple handler to scroll inputs into view when keyboard appears.
 * Uses focusin event and scrollIntoView - keeps it simple and reliable.
 * Also handles terminal scrolling and toolbar repositioning via visualViewport API.
 */
const KeyboardHandler = {
  VIEWPORT_SETTLE_MS: 80,
  FRAME_COVER_MIN_MS: 220,
  FRAME_COVER_MAX_MS: 1600,
  FRAME_COVER_LOAD_POLL_MS: 100,
  KEYBOARD_OPEN_INTENT_MS: 1200,
  lastViewportHeight: 0,
  keyboardVisible: false,
  initialViewportHeight: 0,
  initialViewportWidth: 0,
  _keyboardOpeningTimer: null,
  _viewportSettleTimer: null,
  _settleScrollToBottom: false,
  _settleFocusInput: false,
  _terminalInputRequested: false,
  _terminalFrameCover: null,
  _terminalFrameCoverHeight: 0,
  _terminalFrameCoverStartedAt: 0,
  _terminalFrameCoverArmed: false,
  _terminalFrameCoverReady: false,
  _terminalFrameCoverReadyVersion: 0,
  _terminalFrameCoverSwapVersion: 0,
  _terminalFrameCoverMinTimer: null,
  _terminalFrameCoverMaxTimer: null,

  /** Initialize keyboard handling */
  init() {
    // Only initialize on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    this.initialViewportHeight = window.visualViewport?.height || window.innerHeight;
    this.initialViewportWidth = window.visualViewport?.width || window.innerWidth;
    this.lastViewportHeight = this.initialViewportHeight;

    // Simple focus handler - scroll input into view after keyboard appears
    this._focusinHandler = (e) => {
      const target = e.target;
      this._terminalInputRequested = this.isTerminalInputElement(target);
      if (this._terminalInputRequested) {
        if (!this.keyboardVisible) {
          this._markKeyboardOpening();
          this._beginTerminalFrameCover();
        }
        return;
      }
      this._clearKeyboardOpeningIntent();
      if (!this.isInputElement(target)) return;

      // Wait for keyboard animation, then scroll input into view
      setTimeout(() => {
        this.scrollInputIntoView(target);
      }, 400);
    };
    document.addEventListener('focusin', this._focusinHandler);

    // Use visualViewport to detect keyboard and reposition toolbar
    if (window.visualViewport) {
      this._viewportResizeHandler = () => {
        this.handleViewportResize();
      };
      this._viewportScrollHandler = () => {
        this.updateLayoutForKeyboard();
        this._updateTerminalFrameCoverGeometry();
        if (this._terminalInputRequested) window.scrollTo(0, 0);
      };
      window.visualViewport.addEventListener('resize', this._viewportResizeHandler);
      // Also handle scroll (iOS scrolls viewport when keyboard appears)
      window.visualViewport.addEventListener('scroll', this._viewportScrollHandler);
    }

    // Prevent page-level scroll when keyboard is visible.
    // iOS Safari scrolls the document to bring xterm's hidden textarea into
    // view when the user types, pushing the entire UI off-screen. The CSS
    // position:fixed on .app prevents most cases, but reset as a safety net.
    this._windowScrollHandler = () => {
      if (this.keyboardVisible || document.body.classList.contains('keyboard-opening')) {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener('scroll', this._windowScrollHandler);
  },

  /** Remove event listeners */
  cleanup() {
    if (this._focusinHandler) {
      document.removeEventListener('focusin', this._focusinHandler);
      this._focusinHandler = null;
    }
    if (this._viewportResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._viewportResizeHandler);
      this._viewportResizeHandler = null;
    }
    if (this._viewportScrollHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('scroll', this._viewportScrollHandler);
      this._viewportScrollHandler = null;
    }
    if (this._windowScrollHandler) {
      window.removeEventListener('scroll', this._windowScrollHandler);
      this._windowScrollHandler = null;
    }
    if (this._viewportSettleTimer) {
      clearTimeout(this._viewportSettleTimer);
      this._viewportSettleTimer = null;
    }
    this._clearKeyboardOpeningIntent();
    this._settleScrollToBottom = false;
    this._settleFocusInput = false;
    this._terminalInputRequested = false;
    this._discardTerminalFrameCover();
  },

  /**
   * Pin the app before the first visualViewport resize. Mobile browsers may
   * scroll the layout viewport as soon as focus moves to xterm's textarea,
   * several frames before the keyboard crosses the visibility threshold.
   */
  _markKeyboardOpening() {
    document.body.classList.add('keyboard-opening');
    window.scrollTo(0, 0);
    if (this._keyboardOpeningTimer) clearTimeout(this._keyboardOpeningTimer);
    this._keyboardOpeningTimer = setTimeout(() => {
      this._keyboardOpeningTimer = null;
      if (!this.keyboardVisible) document.body.classList.remove('keyboard-opening');
    }, this.KEYBOARD_OPEN_INTENT_MS);
  },

  _clearKeyboardOpeningIntent() {
    if (this._keyboardOpeningTimer) clearTimeout(this._keyboardOpeningTimer);
    this._keyboardOpeningTimer = null;
    document.body.classList.remove('keyboard-opening');
  },

  /** Handle viewport resize (keyboard show/hide) */
  handleViewportResize() {
    const currentHeight = window.visualViewport?.height || window.innerHeight;
    const currentWidth = window.visualViewport?.width || window.innerWidth;

    // Keyboard animations often arrive as several sub-threshold resize steps.
    // Keep the full-height baseline anchored instead of ratcheting it downward.
    // A substantial width change indicates a rotation or posture change, where
    // the previous orientation's height is no longer a useful baseline.
    if (Math.abs(this.initialViewportWidth - currentWidth) > 80) {
      this.initialViewportHeight = Math.max(currentHeight, window.innerHeight);
      this.initialViewportWidth = currentWidth;
    }
    const heightDiff = this.initialViewportHeight - currentHeight;

    // Keyboard appeared (viewport shrunk by more than 150px)
    if (heightDiff > 150 && !this.keyboardVisible) {
      this.keyboardVisible = true;
      document.body.classList.add('keyboard-visible');
      this._clearKeyboardOpeningIntent();
      // While the keyboard is open, size the app to the visual viewport so
      // xterm's bottom row and cursor sit above the OS keyboard.
      document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
      this.onKeyboardShow();
    }
    // Keyboard hidden (viewport grew back close to initial)
    // Use 100px threshold (not 50) to handle iOS address bar drift,
    // iOS 26's persistent 24px discrepancy, and Safari bottom bar changes
    else if (heightDiff < 100 && this.keyboardVisible) {
      if (this._terminalInputRequested) this._beginTerminalFrameCover();
      this.keyboardVisible = false;
      document.body.classList.remove('keyboard-visible');
      this._clearKeyboardOpeningIntent();
      this.onKeyboardHide();
      // Re-sync --app-height now that keyboard is gone (MobileDetection skipped
      // updates while keyboardVisible was true)
      MobileDetection.updateAppHeight();
    }

    // Grow the baseline while the keyboard is hidden (for example when the
    // browser address bar collapses), but never lower it during a keyboard
    // opening animation.
    if (!this.keyboardVisible) {
      this.initialViewportHeight = Math.max(this.initialViewportHeight, currentHeight);
    } else {
      document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
    }

    this.updateLayoutForKeyboard();
    this._updateTerminalFrameCoverGeometry();
    this._scheduleViewportSettle();
    this.lastViewportHeight = currentHeight;
  },

  /** Update layout when keyboard shows/hides */
  updateLayoutForKeyboard() {
    if (!window.visualViewport) return;

    if (!MobileDetection.isTouchDevice()) {
      this.resetLayout();
      return;
    }

    const cjkInput = document.getElementById('cjkInput');
    const isPhoneLayout = MobileDetection.isHandheldDevice();
    const isMediumScreen = !isPhoneLayout && window.innerWidth < 768;

    if (this.keyboardVisible) {
      const keyboardHeight = this.initialViewportHeight - (window.visualViewport.height || window.innerHeight);
      const accessoryBar = document.querySelector('.keyboard-accessory-bar');

      if (isPhoneLayout) {
        // The phone app is already constrained to the visual viewport. CSS
        // reserves exactly one accessory row when mobile terminal controls are
        // enabled; otherwise the terminal reaches the OS keyboard.
        const toolbar = document.querySelector('.toolbar');
        const main = document.querySelector('.main');
        if (toolbar) toolbar.style.transform = '';
        if (accessoryBar) accessoryBar.style.transform = '';
        if (main) main.style.paddingBottom = '';
      } else if (isMediumScreen) {
        // Small tablets retain fixed controls and use the visual viewport
        // offset to lift them above the keyboard.
        const toolbar = document.querySelector('.toolbar');
        const main = document.querySelector('.main');

        const layoutHeight = window.innerHeight;
        const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
        const keyboardOffset = Math.max(0, layoutHeight - visualBottom);

        if (toolbar) {
          toolbar.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
        }
        if (accessoryBar) {
          accessoryBar.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
        }
        if (main && keyboardHeight > 0) {
          const toolbarHeight =
            toolbar && getComputedStyle(toolbar).display !== 'none' ? toolbar.getBoundingClientRect().height : 0;
          const accessoryHeight = accessoryBar?.classList.contains('visible')
            ? accessoryBar.getBoundingClientRect().height
            : 0;
          const cjkInputHeight = cjkInput?.classList.contains('cjk-input-visible')
            ? cjkInput.getBoundingClientRect().height
            : 0;
          main.style.paddingBottom = `${toolbarHeight + accessoryHeight + cjkInputHeight}px`;
        }
      } else if (keyboardHeight > 0) {
        // iPad: use direct bottom positioning (translateY unreliable —
        // iOS auto-scrolls the visual viewport, making keyboardOffset ≈ 0).
        if (accessoryBar) {
          accessoryBar.style.bottom = `${keyboardHeight}px`;
        }
      }

      // CJK textarea positioning (always position:fixed on touch devices).
      if (cjkInput?.classList.contains('cjk-input-visible') && keyboardHeight > 0) {
        if (isPhoneLayout) {
          // Phone CSS keeps the CJK field in terminal-wrap's flex flow.
          cjkInput.style.transform = '';
          cjkInput.style.bottom = '';
        } else if (isMediumScreen) {
          // Small tablets use the same translation as the fixed controls.
          const layoutHeight = window.innerHeight;
          const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
          const keyboardOffset = Math.max(0, layoutHeight - visualBottom);
          cjkInput.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
          cjkInput.style.bottom = '';
        } else {
          // iPad: direct bottom = keyboard + the currently visible accessory row.
          const accessoryHeight = accessoryBar?.classList.contains('visible')
            ? accessoryBar.getBoundingClientRect().height
            : 0;
          cjkInput.style.bottom = `${keyboardHeight + accessoryHeight}px`;
          cjkInput.style.transform = '';
        }
      }
    } else {
      this.resetLayout();
    }
  },

  /** Reset layout to normal (no keyboard) */
  resetLayout() {
    const toolbar = document.querySelector('.toolbar');
    const accessoryBar = document.querySelector('.keyboard-accessory-bar');
    const cjkInput = document.getElementById('cjkInput');
    const main = document.querySelector('.main');

    if (toolbar) {
      toolbar.style.transform = '';
    }
    if (accessoryBar) {
      accessoryBar.style.transform = '';
      accessoryBar.style.bottom = '';
    }
    if (cjkInput) {
      cjkInput.style.transform = '';
      cjkInput.style.bottom = '';
    }
    if (main) {
      main.style.paddingBottom = '';
    }
  },

  /** Clear stale mobile keyboard state before a non-touch viewport measures xterm. */
  resetForDesktopViewport() {
    if (MobileDetection.isTouchDevice()) return;
    this.keyboardVisible = false;
    document.body.classList.remove('keyboard-visible', 'keyboard-opening');
    if (this._keyboardOpeningTimer) clearTimeout(this._keyboardOpeningTimer);
    this._keyboardOpeningTimer = null;
    this.resetLayout();
  },

  /** Called when keyboard appears */
  onKeyboardShow() {
    if (this._terminalInputRequested) this._beginTerminalFrameCover();
    if (typeof app !== 'undefined') app._captureLocalEchoPromptAnchor?.();
    if (typeof MobileTerminalControls !== 'undefined') {
      MobileTerminalControls.syncVisibility();
    }
    this.updateLayoutForKeyboard();

    // Reset any page scroll that occurred during keyboard open.
    // iOS Safari may scroll the document to reveal xterm's hidden textarea.
    window.scrollTo(0, 0);

    if (this._terminalInputRequested && typeof app !== 'undefined' && app.terminal) {
      // Keyboard intent means the reader has left history and returned to the
      // live prompt. Do this locally before the OS animation settles so the
      // input row is visible immediately without asking the TUI to redraw.
      app._terminalScrollLocked = false;
      app._wasAtBottomBeforeWrite = true;
      app.terminal.scrollToBottom();
      app._focusMobileTerminalInput?.();
    }

    // visualViewport emits multiple heights throughout the OS animation.
    // Re-schedule on every event and fit only after the final height settles;
    // fitting a hard-coded 150ms intermediate frame left xterm at stale rows.
    this._scheduleViewportSettle({
      scrollToBottom: this._terminalInputRequested,
      focusInput: this._terminalInputRequested,
    });

    // Reposition subagent windows to stack from bottom (above keyboard)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /** Called when keyboard hides */
  onKeyboardHide() {
    if (typeof app !== 'undefined') app._captureLocalEchoPromptAnchor?.();
    if (typeof app !== 'undefined') {
      app._localEchoOverlay?.setViewportPinned?.(false);
    }
    const terminalOwnedKeyboard = this._terminalInputRequested;
    this._terminalInputRequested = false;
    if (typeof MobileTerminalControls !== 'undefined') {
      MobileTerminalControls.syncVisibility();
    }

    this.resetLayout();

    this._scheduleViewportSettle({ scrollToBottom: terminalOwnedKeyboard });

    // Reposition subagent windows to stack from top (below header)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /**
   * Restore terminal-owned input after selectSession() has already fitted,
   * resized, and painted the newly active session. Re-running onKeyboardShow()
   * here schedules a redundant second fit and causes a visible post-switch jump.
   */
  restoreTerminalInputAfterSessionSwitch() {
    if (!this.keyboardVisible || typeof app === 'undefined' || !app.terminal) return;
    app._captureLocalEchoPromptAnchor?.();
    app._terminalScrollLocked = false;
    app._wasAtBottomBeforeWrite = true;
    app.terminal.scrollToBottom();
    app._syncMobileHelperTextareaToCursor?.();
    app._localEchoOverlay?.rerender?.();
    app._focusMobileTerminalInput?.();
    window.scrollTo(0, 0);
  },

  /** Coalesce the keyboard animation into one final xterm reflow and PTY resize. */
  _scheduleViewportSettle({ scrollToBottom = false, focusInput = false } = {}) {
    this._settleScrollToBottom = this._settleScrollToBottom || scrollToBottom;
    this._settleFocusInput = this._settleFocusInput || focusInput;
    if (this._viewportSettleTimer) clearTimeout(this._viewportSettleTimer);
    this._viewportSettleTimer = setTimeout(() => {
      this._viewportSettleTimer = null;
      const shouldScrollToBottom = this._settleScrollToBottom;
      const shouldFocusInput = this.keyboardVisible && (this._settleFocusInput || this._terminalInputRequested);
      const shouldResizeTerminal = !this.keyboardVisible || shouldFocusInput || this._terminalInputRequested;
      this._settleScrollToBottom = false;
      this._settleFocusInput = false;

      if (typeof app !== 'undefined' && app.terminal) {
        if (app.fitAddon) {
          try {
            app.fitAddon.fit();
          } catch {}
        }
        if (this.keyboardVisible) this._shrinkPaddingToFit();
        if (shouldScrollToBottom) {
          app._terminalScrollLocked = false;
          app._wasAtBottomBeforeWrite = true;
          app.terminal.scrollToBottom();
        }
        app._syncMobileHelperTextareaToCursor?.();
        app._localEchoOverlay?.rerender?.();
        if (shouldFocusInput) app._focusMobileTerminalInput?.();
        if (shouldResizeTerminal) {
          this._armTerminalFrameCover();
          this._sendTerminalResize();
        }
      }
      window.scrollTo(0, 0);
    }, this.VIEWPORT_SETTLE_MS);
  },

  /**
   * Freeze the currently painted terminal rows across a phone keyboard resize.
   * xterm's DOM renderer can briefly clear between fit() and the TUI's SIGWINCH
   * redraw; the inert clone keeps the last valid frame visible in that window.
   */
  _beginTerminalFrameCover({ includeShell = false, restart = false, arm = false } = {}) {
    if (!MobileDetection.isTouchDevice() || typeof app === 'undefined') return;
    if (this._terminalFrameCover) {
      if (restart) this._restartTerminalFrameCover();
      if (arm) this._armTerminalFrameCover();
      return;
    }
    const session = app.activeSessionId ? app.sessions?.get(app.activeSessionId) : null;
    if (!app.activeSessionId || (!includeShell && session?.mode === 'shell')) return;

    const terminalElement = app.terminal?.element;
    const screen = terminalElement?.querySelector?.('.xterm-screen');
    if (!(terminalElement instanceof HTMLElement) || !(screen instanceof HTMLElement)) return;
    const rect = screen.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const cover = document.createElement('div');
    cover.className = 'terminal-resize-frame-cover';
    cover.setAttribute('aria-hidden', 'true');
    const rows = screen.querySelector('.xterm-rows');
    if (!(rows instanceof HTMLElement)) return;
    const frame = document.createElement('div');
    frame.className = `${screen.className} terminal-resize-frame`;
    frame.appendChild(rows.cloneNode(true));
    const localEcho = [...screen.children].find(
      (child) =>
        child instanceof HTMLElement &&
        child.style.pointerEvents === 'none' &&
        child.style.zIndex === '7' &&
        child.textContent
    );
    if (localEcho) frame.appendChild(localEcho.cloneNode(true));
    frame.style.width = `${rect.width}px`;
    frame.style.height = `${rect.height}px`;
    cover.appendChild(frame);
    terminalElement.appendChild(cover);

    this._terminalFrameCover = cover;
    this._terminalFrameCoverHeight = rect.height;
    this._terminalFrameCoverStartedAt = Date.now();
    this._terminalFrameCoverArmed = false;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
    this._scheduleTerminalFrameCoverExpiry();
    this._updateTerminalFrameCoverGeometry();
    if (arm) this._armTerminalFrameCover();
  },

  _restartTerminalFrameCover() {
    const cover = this._terminalFrameCover;
    if (!cover) return;
    this._clearTerminalFrameCoverTimers();
    this._terminalFrameCoverStartedAt = Date.now();
    this._terminalFrameCoverArmed = false;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
    this._scheduleTerminalFrameCoverExpiry();
    this._updateTerminalFrameCoverGeometry();
  },

  _scheduleTerminalFrameCoverExpiry(delay = this.FRAME_COVER_MAX_MS) {
    if (this._terminalFrameCoverMaxTimer) clearTimeout(this._terminalFrameCoverMaxTimer);
    this._terminalFrameCoverMaxTimer = setTimeout(() => {
      this._terminalFrameCoverMaxTimer = null;
      if (this._terminalFrameCoverLoadPending()) {
        this._scheduleTerminalFrameCoverExpiry(this.FRAME_COVER_LOAD_POLL_MS);
        return;
      }
      this._finishTerminalFrameCover();
    }, delay);
  },

  _terminalFrameCoverLoadPending() {
    if (typeof app === 'undefined' || !app.activeSessionId) return false;
    const state = app.terminalLoadStates?.get?.(app.activeSessionId);
    return Boolean(state && state.phase !== 'failed');
  },

  _updateTerminalFrameCoverGeometry() {
    const cover = this._terminalFrameCover;
    const frame = cover?.querySelector?.('.terminal-resize-frame');
    if (!(cover instanceof HTMLElement) || !(frame instanceof HTMLElement)) return;
    const sourceHeight = this._terminalFrameCoverHeight || parseFloat(frame.style.height) || 0;
    const visibleHeight = cover.getBoundingClientRect().height;
    const shift = Math.min(0, visibleHeight - sourceHeight);
    frame.style.setProperty('--terminal-frame-shift', `${shift}px`);
  },

  _armTerminalFrameCover() {
    if (!this._terminalFrameCover) return;
    this._terminalFrameCoverArmed = true;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
    if (this._terminalFrameCoverMinTimer) clearTimeout(this._terminalFrameCoverMinTimer);
    const elapsed = Date.now() - this._terminalFrameCoverStartedAt;
    this._terminalFrameCoverMinTimer = setTimeout(
      () => {
        this._terminalFrameCoverMinTimer = null;
        this._tryFinishTerminalFrameCover();
      },
      Math.max(0, this.FRAME_COVER_MIN_MS - elapsed)
    );
  },

  onTerminalFrameReady() {
    if (!this._terminalFrameCoverArmed) return;
    this._terminalFrameCoverReady = true;
    this._terminalFrameCoverReadyVersion += 1;
    this._tryFinishTerminalFrameCover();
  },

  _tryFinishTerminalFrameCover() {
    if (!this._terminalFrameCover || !this._terminalFrameCoverArmed || !this._terminalFrameCoverReady) {
      return;
    }
    if (Date.now() - this._terminalFrameCoverStartedAt < this.FRAME_COVER_MIN_MS) return;
    if (!this._terminalHasVisibleFrame()) return;
    this._scheduleTerminalFrameCoverSwap();
  },

  _scheduleTerminalFrameCoverSwap() {
    const readyVersion = this._terminalFrameCoverReadyVersion;
    if (this._terminalFrameCoverSwapVersion === readyVersion) return;
    this._terminalFrameCoverSwapVersion = readyVersion;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (
          !this._terminalFrameCover ||
          !this._terminalFrameCoverArmed ||
          !this._terminalFrameCoverReady ||
          this._terminalFrameCoverReadyVersion !== readyVersion
        ) {
          return;
        }
        this._finishTerminalFrameCover();
      });
    });
  },

  _terminalHasVisibleFrame() {
    if (typeof app === 'undefined' || !app.terminal) return false;
    if (app._localEchoOverlay?.state?.visible) return true;
    const terminal = app.terminal;
    const buffer = terminal.buffer?.active;
    if (!buffer?.getLine) return false;
    const viewportY = buffer.viewportY || 0;
    const rows = Math.max(1, terminal.rows || 1);
    for (let row = 0; row < rows; row++) {
      if (
        buffer
          .getLine(viewportY + row)
          ?.translateToString?.(true)
          ?.trim()
      )
        return true;
    }
    return false;
  },

  _finishTerminalFrameCover() {
    const cover = this._terminalFrameCover;
    if (!cover) return;
    this._terminalFrameCoverArmed = false;
    this._discardTerminalFrameCover();
  },

  _clearTerminalFrameCoverTimers() {
    if (this._terminalFrameCoverMinTimer) clearTimeout(this._terminalFrameCoverMinTimer);
    if (this._terminalFrameCoverMaxTimer) clearTimeout(this._terminalFrameCoverMaxTimer);
    this._terminalFrameCoverMinTimer = null;
    this._terminalFrameCoverMaxTimer = null;
  },

  _discardTerminalFrameCover() {
    this._clearTerminalFrameCoverTimers();
    this._terminalFrameCover?.remove();
    this._terminalFrameCover = null;
    this._terminalFrameCoverHeight = 0;
    this._terminalFrameCoverStartedAt = 0;
    this._terminalFrameCoverArmed = false;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
  },

  /** Send current terminal dimensions to the server (one-shot, for keyboard open/close) */
  _sendTerminalResize() {
    if (typeof app === 'undefined' || !app.activeSessionId || !app.fitAddon) return;
    try {
      app.sendResize(app.activeSessionId, { takeControl: true, refit: false }).catch(() => {});
    } catch {}
  },

  /**
   * Shrink .main paddingBottom to eliminate the terminal row quantization gap.
   * xterm can only render whole rows, so fractional-row pixels create dead
   * space below the last row. After fitAddon.fit(), measure the gap and
   * reduce padding by that amount so the terminal sits flush against the bars.
   */
  _shrinkPaddingToFit() {
    try {
      const container = document.getElementById('terminalContainer');
      const main = document.querySelector('.main');
      if (!container || !main || typeof app === 'undefined' || !app.terminal) return;
      const cellH = app.terminal._core?._renderService?.dimensions?.css?.cell?.height;
      if (!cellH) return;
      const gap = container.clientHeight - app.terminal.rows * cellH;
      if (gap > 0 && gap < cellH) {
        const currentPadding = parseFloat(getComputedStyle(main).paddingBottom) || 0;
        const nextPadding = Math.max(0, currentPadding - gap);
        if (Math.abs(nextPadding - currentPadding) < 0.5) return;
        main.style.paddingBottom = `${nextPadding}px`;
        const appliedPadding = parseFloat(getComputedStyle(main).paddingBottom) || 0;
        if (Math.abs(appliedPadding - currentPadding) >= 0.5 && app.fitAddon)
          try {
            app.fitAddon.fit();
          } catch {}
      }
    } catch {}
  },

  /** Check whether focus belongs to the terminal's mobile text-entry surface. */
  isTerminalInputElement(el) {
    if (!el) return false;
    if (el.id === 'cjkInput') return true;
    if (typeof app !== 'undefined' && el === app.terminal?.textarea) return true;
    return Boolean(el.closest?.('.xterm, .terminal-container'));
  },

  /** Check if element is an input that triggers keyboard (excludes terminal) */
  isInputElement(el) {
    if (!el) return false;

    // Exclude xterm.js terminal inputs (they handle their own scroll)
    if (el.closest('.xterm') || el.closest('.terminal-container')) {
      return false;
    }

    const tagName = el.tagName?.toLowerCase();
    // Exclude type=range, type=checkbox, type=radio (don't trigger keyboard)
    if (tagName === 'input') {
      const type = el.type?.toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'file') {
        return false;
      }
    }
    return tagName === 'input' || tagName === 'textarea' || el.isContentEditable;
  },

  /** Scroll input into view above the keyboard */
  scrollInputIntoView(input) {
    // Check if input is still focused (user might have tapped away)
    if (document.activeElement !== input) return;

    // Find if we're in a modal
    const modal = input.closest('.modal.active');
    const modalBody = modal?.querySelector('.modal-body');

    if (modalBody) {
      // For modals - scroll within the modal body
      const inputRect = input.getBoundingClientRect();
      const modalRect = modalBody.getBoundingClientRect();

      // If input is below middle of modal, scroll it up
      if (inputRect.top > modalRect.top + modalRect.height * 0.4) {
        const scrollAmount = inputRect.top - modalRect.top - 100;
        modalBody.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    } else {
      // For page-level - use scrollIntoView
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// Mobile Swipe Handler
// ═══════════════════════════════════════════════════════════════

/**
 * SwipeHandler - Detects horizontal swipes on terminal to switch sessions.
 * Only active on mobile/touch devices.
 */
const SwipeHandler = {
  startX: 0,
  startY: 0,
  startTime: 0,
  minSwipeDistance: 80, // Minimum pixels for a valid swipe
  maxSwipeTime: 300, // Maximum ms for a swipe gesture
  maxVerticalDrift: 100, // Max vertical movement allowed

  _touchStartHandler: null,
  _touchEndHandler: null,
  _element: null,

  /** Initialize swipe handling */
  init() {
    // Only on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    const terminal = document.querySelector('.main');
    if (!terminal) return;

    this._element = terminal;
    this._touchStartHandler = (e) => this.onTouchStart(e);
    this._touchEndHandler = (e) => this.onTouchEnd(e);
    terminal.addEventListener('touchstart', this._touchStartHandler, { passive: true });
    terminal.addEventListener('touchend', this._touchEndHandler, { passive: true });
  },

  /** Remove swipe listeners */
  cleanup() {
    if (this._element && this._touchStartHandler) {
      this._element.removeEventListener('touchstart', this._touchStartHandler);
      this._element.removeEventListener('touchend', this._touchEndHandler);
    }
    this._touchStartHandler = null;
    this._touchEndHandler = null;
    this._element = null;
  },

  onTouchStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    this.startX = e.touches[0].clientX;
    this.startY = e.touches[0].clientY;
    this.startTime = Date.now();
  },

  onTouchEnd(e) {
    if (!e.changedTouches || e.changedTouches.length !== 1) return;

    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const elapsed = Date.now() - this.startTime;

    // Check if it's a valid swipe
    const deltaX = endX - this.startX;
    const deltaY = Math.abs(endY - this.startY);

    if (elapsed > this.maxSwipeTime) return; // Too slow
    if (deltaY > this.maxVerticalDrift) return; // Too much vertical movement
    if (Math.abs(deltaX) < this.minSwipeDistance) return; // Too short

    // Valid swipe detected
    if (deltaX > 0) {
      // Swipe right -> previous session
      if (typeof app !== 'undefined') app.prevSession();
    } else {
      // Swipe left -> next session
      if (typeof app !== 'undefined') app.nextSession();
    }
  },
};
