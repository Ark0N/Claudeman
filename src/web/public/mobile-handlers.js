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
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar reference in KeyboardHandler.onKeyboardShow, soft — guarded with typeof check)
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
      'ios-device',
      'safari-browser'
    );

    // Add current device class
    body.classList.add(`device-${deviceType}`);

    // Add touch device class if applicable
    if (isTouch) {
      body.classList.add('touch-device');
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
  FRAME_COVER_CODEX_QUIET_MS: 180,
  KEYBOARD_CLOSE_START_DELTA_PX: 40,
  lastViewportHeight: 0,
  keyboardVisible: false,
  initialViewportHeight: 0,
  _keyboardOpenMinHeight: 0,
  _keyboardClosing: false,
  _viewportSettleTimer: null,
  _settleScrollToBottom: false,
  _terminalInputRequested: false,
  _terminalFrameCover: null,
  _terminalFrameCoverStartedAt: 0,
  _terminalFrameCoverArmed: false,
  _terminalFrameCoverReady: false,
  _terminalFrameCoverReadyAt: 0,
  _terminalFrameCoverReadyVersion: 0,
  _terminalFrameCoverSwapVersion: 0,
  _terminalFrameCoverAuthoritative: false,
  _terminalFrameCoverMinTimer: null,
  _terminalFrameCoverMaxTimer: null,
  _terminalFrameCoverQuietTimer: null,

  /** Initialize keyboard handling */
  init() {
    // Only initialize on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    this.initialViewportHeight = window.visualViewport?.height || window.innerHeight;
    this.lastViewportHeight = this.initialViewportHeight;
    this._keyboardOpenMinHeight = 0;
    this._keyboardClosing = false;

    // Simple focus handler - scroll input into view after keyboard appears
    this._focusinHandler = (e) => {
      const target = e.target;
      this._terminalInputRequested = this.isTerminalInputElement(target);
      if (this._terminalInputRequested) {
        if (!this.keyboardVisible) this._beginTerminalFrameCover();
        return;
      }
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
      if (this.keyboardVisible) {
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
    this._settleScrollToBottom = false;
    this._terminalInputRequested = false;
    this._keyboardOpenMinHeight = 0;
    this._keyboardClosing = false;
    this._discardTerminalFrameCover();
  },

  /** Handle viewport resize (keyboard show/hide) */
  handleViewportResize() {
    const currentHeight = window.visualViewport?.height || window.innerHeight;
    const heightDiff = this.initialViewportHeight - currentHeight;

    // A soft keyboard closes through several growing visualViewport frames.
    // Start covering at the first meaningful growth instead of waiting until
    // the final hidden threshold, where a resize redraw may already be visible.
    if (this.keyboardVisible) {
      const openMinHeight =
        this._keyboardOpenMinHeight > 0
          ? Math.min(this._keyboardOpenMinHeight, currentHeight)
          : Math.min(this.lastViewportHeight || currentHeight, currentHeight);
      this._keyboardOpenMinHeight = openMinHeight;
      if (!this._keyboardClosing && currentHeight - openMinHeight >= this.KEYBOARD_CLOSE_START_DELTA_PX) {
        this._keyboardClosing = true;
        if (this._terminalInputRequested) {
          this._beginTerminalFrameCover({ restart: true });
        }
      }
    }

    // Keyboard appeared (viewport shrunk by more than 150px)
    if (heightDiff > 150 && !this.keyboardVisible) {
      this.keyboardVisible = true;
      this._keyboardOpenMinHeight = currentHeight;
      this._keyboardClosing = false;
      document.body.classList.add('keyboard-visible');
      // While the keyboard is open, size the app to the visual viewport so
      // xterm's bottom row and cursor sit above the OS keyboard.
      document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
      this.onKeyboardShow();
    }
    // Keyboard hidden (viewport grew back close to initial)
    // Use 100px threshold (not 50) to handle iOS address bar drift,
    // iOS 26's persistent 24px discrepancy, and Safari bottom bar changes
    else if (heightDiff < 100 && this.keyboardVisible) {
      // Closing can begin while the opening cover still owns a queued
      // compositor swap. Restart its lifecycle so that stale release cannot
      // expose the final fit/SIGWINCH redraw sequence.
      if (this._terminalInputRequested) {
        this._beginTerminalFrameCover({ restart: true });
      }
      this.keyboardVisible = false;
      this._keyboardOpenMinHeight = 0;
      this._keyboardClosing = false;
      document.body.classList.remove('keyboard-visible');
      this.onKeyboardHide();
      // Re-sync --app-height now that keyboard is gone (MobileDetection skipped
      // updates while keyboardVisible was true)
      MobileDetection.updateAppHeight();
    }

    // Update baseline when keyboard is not visible — adapts to address bar
    // state changes, orientation changes, and other viewport shifts
    if (!this.keyboardVisible) {
      this.initialViewportHeight = currentHeight;
    } else {
      document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
    }

    this.updateLayoutForKeyboard();
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
    const isSmallMedium = MobileDetection.isSmallScreen() || MobileDetection.isMediumScreen();

    if (this.keyboardVisible) {
      const keyboardHeight = this.initialViewportHeight - (window.visualViewport.height || window.innerHeight);
      const accessoryBar = document.querySelector('.keyboard-accessory-bar');

      if (isSmallMedium) {
        // Phones/small tablets: toolbar and accessory bar are position:fixed
        // via CSS. Use translateY to lift them above the keyboard.
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
          const cjkInputHeight = cjkInput?.classList.contains('cjk-input-visible') ? 44 : 0;
          main.style.paddingBottom = `${84 + cjkInputHeight}px`;
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
        if (isSmallMedium) {
          // Phones: use translateY like toolbar/accessory bar.
          const layoutHeight = window.innerHeight;
          const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
          const keyboardOffset = Math.max(0, layoutHeight - visualBottom);
          cjkInput.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
          cjkInput.style.bottom = '';
        } else {
          // iPad: direct bottom = keyboard + accessory bar height.
          cjkInput.style.bottom = `${keyboardHeight + 44}px`;
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

  /** Called when keyboard appears */
  onKeyboardShow() {
    if (this._terminalInputRequested) this._beginTerminalFrameCover();

    // Show keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.show();
    }

    // Reset any page scroll that occurred during keyboard open.
    // iOS Safari may scroll the document to reveal xterm's hidden textarea.
    window.scrollTo(0, 0);

    // visualViewport emits multiple heights throughout the OS animation.
    // Re-schedule on every event and fit only after the final height settles.
    this._scheduleViewportSettle({ scrollToBottom: true });

    // Reposition subagent windows to stack from bottom (above keyboard)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /** Called when keyboard hides */
  onKeyboardHide() {
    const terminalOwnedKeyboard = this._terminalInputRequested;
    this._terminalInputRequested = false;

    // Hide keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.hide();
    }

    this.resetLayout();

    this._scheduleViewportSettle({ scrollToBottom: terminalOwnedKeyboard });

    // Reposition subagent windows to stack from top (below header)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /** Coalesce the keyboard animation into one final xterm reflow and PTY resize. */
  _scheduleViewportSettle({ scrollToBottom = false } = {}) {
    this._settleScrollToBottom = this._settleScrollToBottom || scrollToBottom;
    if (this._viewportSettleTimer) clearTimeout(this._viewportSettleTimer);
    this._viewportSettleTimer = setTimeout(() => {
      this._viewportSettleTimer = null;
      const shouldScrollToBottom = this._settleScrollToBottom;
      this._settleScrollToBottom = false;

      if (typeof app !== 'undefined' && app.terminal) {
        if (app.fitAddon) {
          try {
            app.fitAddon.fit();
          } catch {}
        }
        if (this.keyboardVisible) this._shrinkPaddingToFit();
        if (shouldScrollToBottom) app.terminal.scrollToBottom();
        app._syncMobileHelperTextareaToCursor?.();
        app._localEchoOverlay?.rerender?.();
        this._armTerminalFrameCover();
        this._sendTerminalResize();
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

    const rows = screen.querySelector('.xterm-rows');
    if (!(rows instanceof HTMLElement)) return;
    const cover = document.createElement('div');
    cover.className = 'terminal-resize-frame-cover';
    cover.setAttribute('aria-hidden', 'true');
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
    this._terminalFrameCoverStartedAt = Date.now();
    this._terminalFrameCoverArmed = false;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyAt = 0;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
    this._terminalFrameCoverAuthoritative = false;
    this._scheduleTerminalFrameCoverExpiry();
    if (arm) this._armTerminalFrameCover();
  },

  _restartTerminalFrameCover() {
    if (!this._terminalFrameCover) return;
    this._clearTerminalFrameCoverTimers();
    this._terminalFrameCoverStartedAt = Date.now();
    this._terminalFrameCoverArmed = false;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyAt = 0;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
    this._terminalFrameCoverAuthoritative = false;
    this._scheduleTerminalFrameCoverExpiry();
  },

  _scheduleTerminalFrameCoverExpiry(delay = this.FRAME_COVER_MAX_MS) {
    if (this._terminalFrameCoverMaxTimer) clearTimeout(this._terminalFrameCoverMaxTimer);
    this._terminalFrameCoverMaxTimer = setTimeout(() => {
      this._terminalFrameCoverMaxTimer = null;
      if (this._terminalFrameCoverLoadPending()) {
        this._scheduleTerminalFrameCoverExpiry(this.FRAME_COVER_LOAD_POLL_MS);
        return;
      }
      this._forceTerminalFrameCoverSwap();
    }, delay);
  },

  _terminalFrameCoverLoadPending() {
    if (typeof app === 'undefined' || !app.activeSessionId) return false;
    const state = app.terminalLoadStates?.get?.(app.activeSessionId);
    return Boolean(state && state.phase !== 'failed');
  },

  _armTerminalFrameCover() {
    if (!this._terminalFrameCover) return;
    this._terminalFrameCoverArmed = true;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyAt = 0;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
    this._terminalFrameCoverAuthoritative = false;
    if (this._terminalFrameCoverQuietTimer) {
      clearTimeout(this._terminalFrameCoverQuietTimer);
      this._terminalFrameCoverQuietTimer = null;
    }
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

  onTerminalFramePending() {
    if (!this._terminalFrameCover || !this._terminalFrameCoverArmed) return;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyAt = 0;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
    if (this._terminalFrameCoverQuietTimer) {
      clearTimeout(this._terminalFrameCoverQuietTimer);
      this._terminalFrameCoverQuietTimer = null;
    }
  },

  needsTerminalFrameReady() {
    return Boolean(this._terminalFrameCover && this._terminalFrameCoverArmed);
  },

  onTerminalFrameReady() {
    if (!this._terminalFrameCoverArmed) return;
    this._terminalFrameCoverReady = true;
    this._terminalFrameCoverReadyAt = Date.now();
    this._terminalFrameCoverReadyVersion += 1;
    this._tryFinishTerminalFrameCover();
  },

  onTerminalFrameAuthoritative() {
    if (!this._terminalFrameCover || !this._terminalFrameCoverArmed) return;
    this._terminalFrameCoverAuthoritative = true;
    if (this._terminalFrameCoverQuietTimer) {
      clearTimeout(this._terminalFrameCoverQuietTimer);
      this._terminalFrameCoverQuietTimer = null;
    }
    this.onTerminalFrameReady();
  },

  _tryFinishTerminalFrameCover() {
    if (!this._terminalFrameCover || !this._terminalFrameCoverArmed || !this._terminalFrameCoverReady) {
      return;
    }
    if (Date.now() - this._terminalFrameCoverStartedAt < this.FRAME_COVER_MIN_MS) return;
    if (!this._terminalHasVisibleFrame()) return;
    const activeSession =
      typeof app !== 'undefined' && app.activeSessionId ? app.sessions?.get?.(app.activeSessionId) : null;
    const quietMs =
      this._terminalFrameCoverAuthoritative || activeSession?.mode !== 'codex' ? 0 : this.FRAME_COVER_CODEX_QUIET_MS;
    const quietRemaining = this._terminalFrameCoverReadyAt + quietMs - Date.now();
    if (quietRemaining > 0) {
      if (!this._terminalFrameCoverQuietTimer) {
        this._terminalFrameCoverQuietTimer = setTimeout(() => {
          this._terminalFrameCoverQuietTimer = null;
          this._tryFinishTerminalFrameCover();
        }, quietRemaining);
      }
      return;
    }
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

  _forceTerminalFrameCoverSwap() {
    const cover = this._terminalFrameCover;
    if (!cover) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this._terminalFrameCover === cover) this._finishTerminalFrameCover();
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
      ) {
        return true;
      }
    }
    return false;
  },

  _finishTerminalFrameCover() {
    if (!this._terminalFrameCover) return;
    this._terminalFrameCoverArmed = false;
    this._discardTerminalFrameCover();
  },

  _clearTerminalFrameCoverTimers() {
    if (this._terminalFrameCoverMinTimer) clearTimeout(this._terminalFrameCoverMinTimer);
    if (this._terminalFrameCoverMaxTimer) clearTimeout(this._terminalFrameCoverMaxTimer);
    if (this._terminalFrameCoverQuietTimer) clearTimeout(this._terminalFrameCoverQuietTimer);
    this._terminalFrameCoverMinTimer = null;
    this._terminalFrameCoverMaxTimer = null;
    this._terminalFrameCoverQuietTimer = null;
  },

  _discardTerminalFrameCover() {
    this._clearTerminalFrameCoverTimers();
    this._terminalFrameCover?.remove();
    this._terminalFrameCover = null;
    this._terminalFrameCoverStartedAt = 0;
    this._terminalFrameCoverArmed = false;
    this._terminalFrameCoverReady = false;
    this._terminalFrameCoverReadyAt = 0;
    this._terminalFrameCoverReadyVersion += 1;
    this._terminalFrameCoverSwapVersion = 0;
    this._terminalFrameCoverAuthoritative = false;
  },

  /** Send current terminal dimensions to the server (one-shot, for keyboard open/close) */
  _sendTerminalResize() {
    if (typeof app === 'undefined' || !app.activeSessionId || !app.fitAddon) return;
    try {
      return app._requestTerminalFrameReconcile?.({
        captureWhenUnchanged: true,
        reason: 'keyboard-resize',
        resizeOptions: { takeControl: true, refit: false },
        settleMs: TUI_REDRAW_SETTLE_MS,
      });
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
        const currentPadding = parseInt(main.style.paddingBottom) || 0;
        main.style.paddingBottom = Math.max(0, currentPadding - gap) + 'px';
        if (app.fitAddon)
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
