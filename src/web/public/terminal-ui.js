/**
 * @fileoverview Terminal setup (xterm.js config, input, resize, link provider), rendering pipeline
 * (batch writes, flicker filter, chunked writes, local echo), terminal controls (clear, font, resize),
 * and directory input.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.terminal, this.fitAddon, this.sessions)
 * @dependency constants.js (DEC_SYNC_STRIP_RE, TIMING constants)
 * @dependency mobile-handlers.js (MobileDetection)
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js, vendor/xterm-addon-webgl.js
 * @dependency vendor/xterm-zerolag-input.js (LocalEchoOverlay)
 * @loadorder 7 of 15 — loaded after app.js, before respawn-ui.js
 */

(function (global) {
  const TERMINAL_QUERY_RESPONSE_PATTERN = /^\x1b\[[\?>=]?[\d;]*[cnR]$/;
  const TERMINAL_OSC_RESPONSE_PATTERN = /^\x1b\][\d;]*[^\x07\x1b]*(?:\x07|\x1b\\)$/;
  // Grace window after a manual scroll-up gesture during which sticky-scroll is
  // suppressed, so high-frequency Codex status redraws don't snap the viewport
  // back to the bottom while the user is inspecting earlier output.
  const USER_SCROLL_STICKY_SUPPRESS_MS = 1500;
  // Mobile browsers synthesize trusted mouse events after touchend. During this
  // short window, only the app's synthetic tap-to-position mouse event should
  // reach xterm.
  const TOUCH_COMPAT_MOUSE_SUPPRESS_MS = 450;

  function isTerminalQueryResponse(data) {
    return TERMINAL_QUERY_RESPONSE_PATTERN.test(data) || TERMINAL_OSC_RESPONSE_PATTERN.test(data);
  }

  function shouldSuppressTerminalQueryResponse(data) {
    return isTerminalQueryResponse(data);
  }

  // Per-skin xterm.js palettes. The 'daylight-blue' object equals the legacy hardcoded
  // theme, so default behavior is unchanged. Shared at module scope and exported on the
  // global so both terminal-ui.js (main terminal) and panels-ui.js (teammate terminals,
  // a separate IIFE) can read the current skin's palette.
  const CODEMAN_XTERM_THEMES = {
    og: { background: '#0d0d0d', foreground: '#e0e0e0', cursor: '#e0e0e0', cursorAccent: '#0d0d0d', selection: 'rgba(255,255,255,0.3)', black: '#0d0d0d', red: '#ff6b6b', green: '#51cf66', yellow: '#ffd43b', blue: '#339af0', magenta: '#cc5de8', cyan: '#22b8cf', white: '#e0e0e0', brightBlack: '#495057', brightRed: '#ff8787', brightGreen: '#69db7c', brightYellow: '#ffe066', brightBlue: '#5c7cfa', brightMagenta: '#da77f2', brightCyan: '#66d9e8', brightWhite: '#ffffff' },
    'daylight-green': { background: '#161b23', foreground: '#dfe6ef', cursor: '#2fd3aa', cursorAccent: '#161b23', selection: 'rgba(47,211,170,0.22)', black: '#161b23', red: '#ff8585', green: '#34d8a0', yellow: '#f0c25a', blue: '#5cc6e8', magenta: '#c79af2', cyan: '#2bcbbb', white: '#dfe6ef', brightBlack: '#5b6675', brightRed: '#ffa0a0', brightGreen: '#5fe6b8', brightYellow: '#ffd884', brightBlue: '#82d4ee', brightMagenta: '#d6b3f7', brightCyan: '#5ee0d4', brightWhite: '#f3f6fa' },
    'daylight-blue': { background: '#161b23', foreground: '#dfe6ef', cursor: '#38b6f0', cursorAccent: '#161b23', selection: 'rgba(56,182,240,0.22)', black: '#161b23', red: '#ff8585', green: '#34d8a0', yellow: '#f0c25a', blue: '#5cc6e8', magenta: '#c79af2', cyan: '#2bcbbb', white: '#dfe6ef', brightBlack: '#5b6675', brightRed: '#ffa0a0', brightGreen: '#5fe6b8', brightYellow: '#ffd884', brightBlue: '#82d4ee', brightMagenta: '#d6b3f7', brightCyan: '#5ee0d4', brightWhite: '#f3f6fa' },
  };
  function currentXtermTheme() {
    const skin = (typeof document !== 'undefined' && document.documentElement.dataset.skin) || 'daylight-blue';
    return CODEMAN_XTERM_THEMES[skin] || CODEMAN_XTERM_THEMES['daylight-blue'];
  }

  global.CodemanTerminalInput = {
    isTerminalQueryResponse,
    shouldSuppressTerminalQueryResponse,
    USER_SCROLL_STICKY_SUPPRESS_MS,
    TOUCH_COMPAT_MOUSE_SUPPRESS_MS,
  };
  global.CODEMAN_XTERM_THEMES = CODEMAN_XTERM_THEMES;
  global.codemanCurrentXtermTheme = currentXtermTheme;
})(window);

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Terminal Setup — xterm.js config and input handling
  // ═══════════════════════════════════════════════════════════════

  initTerminal() {
    // Load scrollback setting from localStorage, treating DEFAULT_SCROLLBACK as a floor
    // so users who picked up the previous (smaller) default get the new minimum on upgrade.
    const stored = parseInt(localStorage.getItem('codeman-scrollback'));
    const scrollback = Number.isFinite(stored) && stored > 0 ? Math.max(stored, DEFAULT_SCROLLBACK) : DEFAULT_SCROLLBACK;

    this.terminal = new Terminal({
      theme: { ...window.codemanCurrentXtermTheme() },
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
      // Use smaller font on mobile to fit more columns (prevents wrapping of Claude's status line)
      fontSize: MobileDetection.getDeviceType() === 'mobile' ? 10 : 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: scrollback,
      allowTransparency: true,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    // SerializeAddon: lets us snapshot the xterm rendered state (viewport +
    // scrollback + colors/attrs) when switching away from a tab and restore
    // it on switch-back. Needed primarily for codex tabs — codex's TUI drops
    // earlier conversation from its current frame, so replaying the server
    // byte buffer on tab-switch shows only the latest (idle) frame. The
    // snapshot captures what the user was actually looking at.
    this._xtermSnapshots = new Map(); // Map<sessionId, serialized-string>
    if (typeof SerializeAddon !== 'undefined') {
      try {
        this._serializeAddon = new SerializeAddon.SerializeAddon();
        this.terminal.loadAddon(this._serializeAddon);
      } catch (_e) {
        /* SerializeAddon failed — snapshot/restore disabled, fallback to buffer-fetch */
        this._serializeAddon = null;
      }
    }

    if (typeof Unicode11Addon !== 'undefined') {
      try {
        const unicode11Addon = new Unicode11Addon.Unicode11Addon();
        this.terminal.loadAddon(unicode11Addon);
        this.terminal.unicode.activeVersion = '11';
      } catch (_e) {
        /* Unicode11 addon failed — default Unicode handling used */
      }
    }

    const container = document.getElementById('terminalContainer');
    this.terminal.open(container);
    this._installMobileTapMouseGuard();

    // Suppress xterm key handling during CJK IME composition.
    // Without this, xterm processes raw keyDown events (e.g., "Process" key)
    // during composition, causing duplicate or garbled input.
    this.terminal.attachCustomKeyEventHandler((ev) => {
      if (ev.isComposing || ev.keyCode === 229) return false;

      // Let the app's Alt/Option session-nav and Command Palette shortcuts reach the document keydown handler
      // (app.js switches tabs by PHYSICAL e.code) instead of xterm injecting ESC<char> into
      // the PTY. Mirror app.js's gate exactly — same physical codes + modifier guard — so
      // macOS Option layouts (Option+1 -> "¡", Option+[ -> "“", Option+K -> "˚") are suppressed here too and
      // don't leak an escape sequence into the focused terminal on every tab switch.
      if (
        ev.altKey &&
        !ev.ctrlKey &&
        !ev.shiftKey &&
        /^(Digit[1-9]|BracketLeft|BracketRight|KeyK)$/.test(ev.code || '')
      ) {
        return false;
      }

      // Command palette chord (COD-153): keep it out of the PTY. The document
      // CAPTURE handler has already opened the palette by the time xterm sees
      // this keydown, but its preventDefault() does NOT stop xterm — without
      // this gate Ctrl+K would ALSO write 0x0b (readline kill-line) into the
      // live session behind the palette, truncating whatever the user had
      // typed. Route through the registry-aware checker so a rebound or
      // disabled palette shortcut restores normal terminal Ctrl+K.
      if (ev.type === 'keydown' && this.shouldOpenCommandPaletteFromShortcut?.(ev)) {
        return false;
      }

      // Ctrl+V / Cmd+V: intercept before xterm sends ^V to PTY.
      // Route through our paste trap which handles both images and text.
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'v' && ev.type === 'keydown') {
        if (this.activeSessionId && this._handleImagePaste) {
          this._handleImagePaste();
        }
        return false;
      }

      // Shift+Enter / Ctrl+Enter: insert newline for multi-line input.
      // xterm.js sends plain \r for all Enter variants, so Claude Code (Ink) can't
      // distinguish them. We use tmux send-keys -H to send a line feed byte (0x0a)
      // which the inner application recognizes as "insert newline" vs carriage return.
      if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey) && ev.type === 'keydown') {
        if (this.activeSessionId) {
          if (this._localEchoEnabled) {
            const text = this._localEchoOverlay?.pendingText || '';
            this._localEchoOverlay?.clear();
            this._localEchoOverlay?.suppressBufferDetection();
            this._flushedOffsets?.delete(this.activeSessionId);
            this._flushedTexts?.delete(this.activeSessionId);
            if (text) {
              this._pendingInput += text;
              flushInput();
            }
            setTimeout(() => {
              fetch(`/api/sessions/${this.activeSessionId}/send-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: ev.ctrlKey ? 'C-Enter' : 'S-Enter' }),
              });
            }, text ? 80 : 0);
          } else {
            fetch(`/api/sessions/${this.activeSessionId}/send-key`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: ev.ctrlKey ? 'C-Enter' : 'S-Enter' }),
            });
          }
        }
        return false;
      }

      return true;
    });

    // Android virtual keyboard fix: catch non-composition input events.
    // On Android Chrome, typing symbols (e.g., "/" from Gboard's symbol keyboard)
    // sends keyCode 229 + input event WITHOUT compositionstart/end wrapping.
    // The custom key handler above returns false for keyCode 229, telling xterm
    // to ignore the keydown. xterm.js expects the character to arrive via
    // composition events, but since there's no composition, the character is lost.
    // This listener catches those orphaned input events and forwards them to onData.
    {
      const xtermTextarea = container.querySelector('.xterm-helper-textarea');
      if (xtermTextarea && MobileDetection.isTouchDevice()) {
        let composing = false;
        let lastKeydownHandled = 0;
        xtermTextarea.addEventListener('compositionstart', () => { composing = true; });
        xtermTextarea.addEventListener('compositionend', () => { composing = false; });
        // Track when xterm handles a keydown normally (non-229 keyCode).
        // If xterm processed the keydown, it will emit onData itself --
        // the input event handler below must NOT re-send the character.
        xtermTextarea.addEventListener('keydown', (e) => {
          if (!e.isComposing && e.keyCode !== 229) {
            lastKeydownHandled = Date.now();
          }
        });
        xtermTextarea.addEventListener('input', (e) => {
          // Only handle insertText events outside of composition -- these are
          // the ones xterm.js misses on Android virtual keyboards.
          if (composing || e.isComposing) return;
          if (e.inputType !== 'insertText' || !e.data) return;
          // If xterm just handled a keydown (within 50ms), it already sent the
          // char via onData. Skip to avoid double-send (e.g., Shift+A => AA).
          if (Date.now() - lastKeydownHandled < 50) return;
          // xterm.js may have already processed this via its own input handler.
          // Check if the textarea was cleared by xterm (value is empty or just
          // whitespace) -- if so, xterm handled it and we should not double-send.
          // Use a microtask to check after xterm's own handlers have run.
          const data = e.data;
          const pendingBefore = this._localEchoOverlay?.pendingText || '';
          Promise.resolve().then(() => {
            if (
              this._lastTerminalData?.data === data &&
              performance.now() - this._lastTerminalData.time < 100
            ) {
              xtermTextarea.value = '';
              return;
            }
            const pendingAfter = this._localEchoOverlay?.pendingText || '';
            if (
              this._localEchoEnabled &&
              pendingAfter.length > pendingBefore.length &&
              pendingAfter.endsWith(data)
            ) {
              xtermTextarea.value = '';
              return;
            }
            // If xterm cleared the textarea, it processed the input -- skip.
            const val = xtermTextarea.value;
            if (!val || (val.trim() === '' && data !== ' ')) return;
            // xterm didn't process it -- forward to terminal as if typed.
            // Emit via onData path by writing to terminal's input handler.
            this.terminal._core.coreService.triggerDataEvent(data, true);
            // Clear the textarea to prevent xterm from processing it later.
            xtermTextarea.value = '';
          });
        });
      }
    }

    // WebGL renderer for GPU-accelerated terminal rendering.
    // Previously caused "page unresponsive" crashes from synchronous GPU stalls,
    // but the 48KB/frame flush cap in flushPendingWrites() now prevents
    // oversized terminal.write() calls that triggered the stalls.
    // Disable with ?nowebgl URL param if GPU issues return.
    // Auto-fallback: _initWebGL installs a long-task watchdog that disables
    // WebGL sticky in localStorage after repeated GPU stalls (see app.js).
    // Force re-enable after sticky disable with ?webgl=force.
    // Lazy-loaded: script downloaded only on desktop (saves 244KB on mobile).
    this._webglAddon = null;
    const _params = new URLSearchParams(location.search);
    const _stickyDisabled = (() => {
      try {
        const raw = localStorage.getItem('codeman-webgl-disabled');
        if (!raw) return false;
        const { at } = JSON.parse(raw);
        // Auto-expire after WEBGL_FALLBACK.STICKY_EXPIRY_MS so we retry
        // (driver/Chrome may have been updated).
        if (Date.now() - at > WEBGL_FALLBACK.STICKY_EXPIRY_MS) {
          localStorage.removeItem('codeman-webgl-disabled');
          return false;
        }
        return true;
      } catch { return false; }
    })();
    // User's "WebGL Renderer" toggle (Settings > Appearance). undefined = untouched
    // (desktop default on); false = explicit opt-out; true = explicit opt-in.
    const _webglSettings = this.loadAppSettingsFromStorage();
    const _webglDefaults = this.getDefaultSettings();
    const _webglPref = _webglSettings.webglRendererEnabled ?? _webglDefaults.webglRendererEnabled;
    const { skip: skipWebGL, clearSticky: _clearWebglSticky } = shouldSkipWebGL({
      deviceType: MobileDetection.getDeviceType(),
      noWebglParam: _params.has('nowebgl'),
      forceParam: _params.get('webgl') === 'force',
      stickyDisabled: _stickyDisabled,
      userPrefEnabled: _webglPref,
    });
    // Only ?webgl=force retires the auto-fallback marker at init — a stored
    // toggle ON is incidental (checkbox defaults checked) and must not defeat
    // the sticky safety net. An OFF→ON flip clears it in saveAppSettings().
    if (_clearWebglSticky) {
      try { localStorage.removeItem('codeman-webgl-disabled'); } catch {}
    }
    if (skipWebGL && _stickyDisabled) {
      console.log('[CRASH-DIAG] WebGL sticky-disabled from prior stalls — DOM renderer in use. Re-enable: ?webgl=force');
    }
    if (!skipWebGL) {
      if (typeof WebglAddon !== 'undefined') {
        this._initWebGL();
      } else {
        // Lazy-load WebGL addon — not bundled in <head> to avoid blocking mobile
        const wglScript = document.createElement('script');
        wglScript.src = 'vendor/xterm-addon-webgl.min.js';
        wglScript.onload = () => this._initWebGL();
        wglScript.onerror = () => console.warn('[CRASH-DIAG] Failed to load WebGL addon — using canvas renderer');
        document.head.appendChild(wglScript);
      }
    }

    this._localEchoOverlay = new LocalEchoOverlay(this.terminal);
    if (MobileDetection.isTouchDevice()) {
      this.terminal.onCursorMove(() => this._syncMobileHelperTextareaToCursor());
      this.terminal.onRender(() => this._syncMobileHelperTextareaToCursor());
    }

    // CJK IME input — textarea in index.html, just wire up send
    this._cjkInput = null;
    if (typeof CjkInput !== 'undefined') {
      this._cjkInput = CjkInput.init({
        send: (text) => {
          this._handleCjkInput(text);
        },
      });
    }

    // ── Focus router ──
    // While the CJK field is visible, EVERY terminal.focus() call must land on
    // the CJK field instead. Focusing xterm's hidden textarea in CJK mode sends
    // the IME's output into a black hole: the keyboard composes normally, but
    // onData is gated by cjkActive, so nothing reaches the field OR the PTY.
    // Session select / SSE-reconnect restore paths call terminal.focus() and
    // were silently stealing focus after every app switch on mobile (the
    // intermittent "Chinese input goes nowhere" bug). One chokepoint here
    // covers all ~15 call sites plus any future ones.
    const _xtermFocus = this.terminal.focus.bind(this.terminal);
    this.terminal.focus = () => {
      const cjkEl = document.getElementById('cjkInput');
      if (cjkEl?.classList.contains('cjk-input-visible')) {
        cjkEl.focus();
      } else {
        _xtermFocus();
      }
    };

    // On mobile Safari, delay initial fit() to allow layout to settle
    // This prevents 0-column terminals caused by fit() running before container is sized
    const isMobileSafari =
      MobileDetection.getDeviceType() === 'mobile' && document.body.classList.contains('safari-browser');
    if (isMobileSafari) {
      // Wait for layout, then fit multiple times to ensure proper sizing
      requestAnimationFrame(() => {
        this.fitAddon.fit();
        // Double-check after another frame
        requestAnimationFrame(() => this.fitAddon.fit());
      });
    } else {
      this.fitAddon.fit();
    }

    // Register link provider for clickable file paths in Bash tool output
    this.registerFilePathLinkProvider();

    // Mouse wheel: forward to the TUI only for sessions verified to handle SGR
    // wheel reports (codex, and claude 2.1.187+ — see _shouldForwardWheelToApp),
    // local scrollback otherwise. Claude Code 2.1.187+ scrolls its own
    // transcript on SGR wheel reports — scrolled-away tool blocks re-render
    // live and stay clickable — and its select menus no longer capture wheel
    // as option navigation (verified against 2.1.202: /model menu highlight
    // ignores wheel reports); older versions DO capture wheel as option
    // navigation, so they keep the local wheel.
    // Shift+wheel always scrolls xterm's local scrollback (Codeman's restored
    // history lives there), and once the viewport left the bottom the wheel
    // stays local until the user scrolls back down — so both scrollbacks stay
    // reachable without a mode switch.
    container.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const lines = this._wheelScrollLines(ev);
        if (this._shouldForwardWheelToApp(ev)) {
          this._sendSyntheticSgrWheel(ev.clientX, ev.clientY, lines);
          return;
        }
        this._noteTerminalUserScroll(lines);
        this.terminal.scrollLines(lines);
      },
      { passive: false }
    );

    // Touch scrolling — use terminal.scrollLines() for all devices.
    // xterm.js DOM renderer doesn't populate xterm-viewport's scroll area,
    // so native CSS scrolling (overflow-y: scroll + touch-action: pan-y)
    // has nothing to scroll. Instead, convert touch deltas into scrollLines()
    // calls, matching the wheel handler above.
    {
      const cellHeight = () => this.terminal._core?._renderService?.dimensions?.css?.cell?.height || 13;
      let touchLastY = 0;
      let velocity = 0;
      let lastTime = 0;
      let scrollFrame = null;
      let isTouching = false;

      const scrollLoop = (timestamp) => {
        const dt = lastTime ? (timestamp - lastTime) / 16.67 : 1;
        lastTime = timestamp;

        if (!isTouching && Math.abs(velocity) > 0.3) {
          // Momentum phase — convert pixel velocity to lines
          const lines = Math.round(velocity / cellHeight());
          if (lines !== 0) this.terminal.scrollLines(lines);
          velocity *= 0.92;
          scrollFrame = requestAnimationFrame(scrollLoop);
        } else if (!isTouching) {
          scrollFrame = null;
          velocity = 0;
        } else {
          scrollFrame = requestAnimationFrame(scrollLoop);
        }
      };

      // Accumulate sub-line pixel deltas so slow swipes still scroll
      let pixelAccum = 0;

      let didScroll = false; // track whether touchmove fired (tap vs scroll)
      let touchStartY = 0;
      const TAP_THRESHOLD = 8; // px — ignore micro-drift to distinguish tap from scroll
      container.addEventListener(
        'touchstart',
        (ev) => {
          if (ev.touches.length === 1) {
            touchLastY = ev.touches[0].clientY;
            touchStartY = touchLastY;
            velocity = 0;
            pixelAccum = 0;
            isTouching = true;
            didScroll = false;
            lastTime = 0;
            if (scrollFrame) {
              cancelAnimationFrame(scrollFrame);
              scrollFrame = null;
            }
          }
        },
        { passive: true }
      );

      container.addEventListener(
        'touchmove',
        (ev) => {
          if (ev.touches.length === 1 && isTouching) {
            const touchY = ev.touches[0].clientY;
            if (!didScroll && Math.abs(touchY - touchStartY) >= TAP_THRESHOLD) {
              didScroll = true;
            }
            // Below the tap threshold, treat the gesture as a potential tap:
            // don't preventDefault (iOS needs click synthesis to show the
            // keyboard) and don't accumulate scroll distance or velocity. Without
            // this guard, sub-threshold micro-drift still scrolls a line and
            // leaves a non-zero velocity that touchend turns into a momentum
            // fling, so a jittery tap would both position the cursor AND scroll.
            if (!didScroll) return;
            ev.preventDefault();
            const delta = touchLastY - touchY; // positive = scroll down
            pixelAccum += delta;
            velocity = delta * 1.2;
            touchLastY = touchY;
            // Convert accumulated pixels to whole lines
            const ch = cellHeight();
            const lines = Math.trunc(pixelAccum / ch);
            if (lines !== 0) {
              this._noteTerminalUserScroll(lines);
              this.terminal.scrollLines(lines);
              pixelAccum -= lines * ch;
            }
          }
        },
        { passive: false }
      );

      container.addEventListener(
        'touchend',
        (ev) => {
          isTouching = false;
          if (!scrollFrame && Math.abs(velocity) > 0.3) {
            scrollFrame = requestAnimationFrame(scrollLoop);
          }
          if (!didScroll && this.terminal) {
            // ── Tap-to-position cursor ──────────────────────────────────
            // Synthesize a click from the real touch point so the foreground app
            // moves its cursor to the tapped cell (iOS doesn't reliably do this
            // itself under touch-action:none). CRITICAL: only when mouse tracking
            // is ON. xterm disables its local SelectionService while mouse events
            // are active, so the synthetic click is forwarded to the PTY as an SGR
            // report (cursor moves). But when tracking is OFF, that same click
            // drives xterm's LOCAL selection (detail 1/2/3 → char/word/line) — a
            // tap on CJK text would select & copy it instead of positioning. So
            // gate strictly on the live mouse-tracking mode.
            const touch = ev.changedTouches && ev.changedTouches[0];
            const mouseMode = this.terminal.modes?.mouseTrackingMode;
            const mouseTrackingOn = !!mouseMode && mouseMode !== 'none';
            if (touch) {
              this._suppressTrustedTapMouseEvents();
            }
            if (touch && mouseTrackingOn) {
              this._dispatchSyntheticTerminalClick(touch.clientX, touch.clientY);
            } else if (touch && this._sessionUsesServerMouseStrip()) {
              // The server strips mouse-tracking DECSETs from claude/codex/gemini
              // output (isAltScreenStripMode, session.ts) so the wheel keeps
              // scrolling scrollback — which leaves THIS xterm permanently at
              // mouseTrackingMode 'none' even though the TUI on the PTY side has
              // tracking ON and still understands SGR reports. Encode the report
              // ourselves and send it straight to the PTY: no DOM click is
              // dispatched, so xterm's local selection can't trigger either.
              this._sendSyntheticSgrTap(touch.clientX, touch.clientY);
            }
            this._syncMobileHelperTextareaToCursor();
            // Route subsequent typing to the right place: keep the CJK input
            // field focused when Chinese input is on, otherwise the terminal.
            const cjkInput = document.getElementById('cjkInput');
            if (cjkInput?.classList.contains('cjk-input-visible')) {
              cjkInput.focus();
            } else {
              this.terminal.focus();
            }
          }
        },
        { passive: true }
      );

      container.addEventListener(
        'touchcancel',
        () => {
          isTouching = false;
          velocity = 0;
          pixelAccum = 0;
        },
        { passive: true }
      );
    }

    // ── Desktop click-to-position cursor ──────────────────────────────
    // A real mouse click normally reaches the PTY through xterm's own mouse
    // encoder, but that encoder only runs while mouseTrackingMode is ON — and
    // the server strips the enabling DECSETs from claude/codex/gemini output
    // (isAltScreenStripMode, session.ts) so the wheel keeps scrolling
    // scrollback. Desktop clicks therefore stopped reporting entirely (the
    // same breakage the mobile touchend tap branch above works around).
    // Hand-encode the SGR report for plain left-clicks on those sessions.
    container.addEventListener('click', (ev) => this._handleDesktopTerminalClick(ev));

    // Welcome message
    this.showWelcome();

    // Image paste and drag-and-drop support
    this.initImageInput();

    // Generation counter for chunkedTerminalWrite — aborts stale writes on tab switch
    this._chunkedWriteGen = 0;
    this._bufferLoadSeq = 0;
    this._bufferLoadOwner = null;
    this._lastUserScrollUpAt = null;

    // Handle resize with throttling for performance
    this._resizeTimeout = null;
    this._lastResizeDims = null;

    // Minimum terminal dimensions to prevent vertical text wrapping
    const MIN_COLS = 40;
    const MIN_ROWS = 10;

    const throttledResize = () => {
      // Trailing-edge debounce: ALL resize work (fit + clear + SIGWINCH) happens
      // once after the user stops resizing. During active resize, the terminal
      // stays at its old dimensions for up to 300ms.
      //
      // Why not fit() immediately? Each fitAddon.fit() reflows content at the
      // new width — lines that were 7 rows become 10, and the overflow gets
      // pushed into scrollback. With continuous resize events, this creates
      // dozens of intermediate reflow states in scrollback, appearing as
      // duplicate/garbled content when the user scrolls up.
      //
      // By deferring fit() to the trailing edge, there's exactly ONE reflow
      // at the final dimensions, ONE viewport clear, and ONE Ink redraw.
      if (this._resizeTimeout) {
        clearTimeout(this._resizeTimeout);
      }
      this._resizeTimeout = setTimeout(() => {
        this._resizeTimeout = null;
        // Fit xterm.js to final container dimensions
        if (this.fitAddon) {
          this.fitAddon.fit();
        }
        // Flush any stale flicker buffer before clearing viewport
        if (this.flickerFilterBuffer) {
          if (this.flickerFilterTimeout) {
            clearTimeout(this.flickerFilterTimeout);
            this.flickerFilterTimeout = null;
          }
          this.flushFlickerBuffer();
        }
        // Skip server resize while mobile keyboard is visible — sending SIGWINCH
        // causes Ink to re-render at the new row count, garbling terminal output.
        // Local fit() still runs so xterm knows the viewport size for scrolling.
        const keyboardUp = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
        if (this.activeSessionId && !keyboardUp) {
          const dims = this.fitAddon.proposeDimensions();
          // Enforce minimum dimensions to prevent layout issues
          const cols = dims ? Math.max(dims.cols, MIN_COLS) : MIN_COLS;
          const rows = dims ? Math.max(dims.rows, MIN_ROWS) : MIN_ROWS;
          // Only send resize if dimensions actually changed
          if (!this._lastResizeDims || cols !== this._lastResizeDims.cols || rows !== this._lastResizeDims.rows) {
            // Clear viewport + scrollback ONLY when dimensions actually change.
            // fitAddon.fit() reflows content: lines at old width may wrap to more rows,
            // pushing overflow into scrollback. Ink's cursor-up count is based on the
            // pre-reflow line count, so ghost renders accumulate in scrollback.
            // Fix: \x1b[3J (Erase Saved Lines) clears scrollback reflow debris,
            // then \x1b[H\x1b[2J clears the viewport for a clean Ink redraw.
            // IMPORTANT: Only clear when we're actually sending SIGWINCH (dims changed).
            // Clearing without a subsequent Ink redraw leaves the terminal blank.
            const activeResizeSession = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
            if (
              activeResizeSession &&
              activeResizeSession.mode !== 'shell' &&
              this.terminal &&
              this.isTerminalAtBottom()
            ) {
              this.terminal.write('\x1b[3J\x1b[H\x1b[2J');
            }
            this._lastResizeDims = { cols, rows };
            // Typed + WS-first like sendResize: the viewport type feeds resize
            // arbitration (a phone rotating must not bypass a desktop claim),
            // and a desktop window narrowing past the tablet breakpoint must
            // send a typed WS frame so its stale desktop claim is released.
            const viewportType =
              typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType
                ? MobileDetection.getDeviceType()
                : 'desktop';
            let sentViaWs = false;
            if (this._wsReady && this._wsSessionId === this.activeSessionId) {
              try {
                this._ws.send(JSON.stringify({ t: 'z', c: cols, r: rows, v: viewportType }));
                sentViaWs = true;
              } catch {
                // Fall through to HTTP POST
              }
            }
            if (!sentViaWs) {
              fetch(`/api/sessions/${this.activeSessionId}/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols, rows, viewportType }),
              }).catch(() => {});
            }
          }
        }
        // Update subagent connection lines and local echo at new dimensions
        this.updateConnectionLines();
        if (this._localEchoOverlay?.hasPending) {
          this._localEchoOverlay.rerender();
        }
      }, 300); // Trailing-edge: only fire after 300ms of no resize events
    };

    window.addEventListener('resize', throttledResize);
    // Store resize observer for cleanup (prevents memory leak on terminal re-init)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
    }
    this.terminalResizeObserver = new ResizeObserver(throttledResize);
    this.terminalResizeObserver.observe(container);

    // Handle keyboard input — send to PTY immediately, no local echo.
    // PTY/Ink handles all character echoing to avoid desync ("typing visible below" bug).
    this._pendingInput = '';
    this._inputFlushTimeout = null;
    this._lastKeystrokeTime = 0;

    const flushInput = () => {
      this._inputFlushTimeout = null;
      if (this._pendingInput && this.activeSessionId) {
        const input = this._pendingInput;
        const sessionId = this.activeSessionId;
        this._pendingInput = '';
        this._sendInputAsync(sessionId, input);
      }
    };

    // Local echo mode: buffer keystrokes locally (shown in overlay) and only
    // send to PTY on Enter.  Avoids out-of-order delivery on high-latency
    // mobile connections.  The overlay + localStorage persistence ensure input
    // survives tab switches and reconnects.

    this.terminal.onData((data) => {
      // Mouse SGR reports (tap-to-position) are NOT IME input — they must reach
      // the PTY even while the CJK input field owns focus. Without this exception
      // tapping to move the cursor silently does nothing whenever Chinese input
      // is on, because cjkActive stays true the whole time the field is visible.
      const isMouseReport = /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);
      // CJK input has focus — block xterm from sending keystrokes to PTY
      if (!isMouseReport && (window.cjkActive || document.activeElement?.id === 'cjkInput')) {
        // Self-heal: if the CJK field is visible but focus drifted to xterm's
        // hidden textarea (e.g. something called terminal.focus()), everything
        // typed lands HERE and is swallowed — keyboard shows the IME composing
        // while both the CJK field and the terminal stay empty. Route focus
        // back so the very next keystroke lands in the CJK field again.
        // Only GENUINE typed input qualifies: onData also fires for xterm's
        // self-generated query replies (DA/DSR/CPR/OSC during Ink redraws),
        // which arrive no matter what has focus — so require focus to be on
        // xterm's own textarea and bail on query replies, or this would steal
        // focus from the rename/search/settings inputs while output streams.
        const cjkEl = document.getElementById('cjkInput');
        if (
          cjkEl?.classList.contains('cjk-input-visible') &&
          document.activeElement === this.terminal.textarea &&
          !window.CodemanTerminalInput?.shouldSuppressTerminalQueryResponse(data)
        ) {
          _crashDiag.log('CJK regain-focus (onData swallowed input)');
          cjkEl.focus();
        }
        return;
      }
      if (this.activeSessionId) {
        // Filter terminal query replies generated by xterm.js itself.
        // Forwarding them through the WebSocket injects DA/DSR/CPR replies
        // into the foreground process as typed input (for example "0;276;0c").
        if (
          window.CodemanTerminalInput?.shouldSuppressTerminalQueryResponse(data)
        ) {
          return;
        }
        this._lastTerminalData = { data, time: performance.now() };

        // ── Local Echo Mode ──
        // When enabled, keystrokes are buffered locally in the overlay for
        // instant visual feedback.  Nothing is sent to the PTY until Enter
        // (or a control char) is pressed — avoids out-of-order char delivery.
        if (this._localEchoEnabled) {
          if (data === '\x7f') {
            const source = this._localEchoOverlay?.removeChar();
            if (source === 'flushed') {
              // Sync app-level flushed Maps (per-session state for tab switching)
              const { count, text } = this._localEchoOverlay.getFlushed();
              if (this._flushedOffsets?.has(this.activeSessionId)) {
                if (count === 0) {
                  this._flushedOffsets.delete(this.activeSessionId);
                  this._flushedTexts?.delete(this.activeSessionId);
                } else {
                  this._flushedOffsets.set(this.activeSessionId, count);
                  this._flushedTexts?.set(this.activeSessionId, text);
                }
              }
              this._pendingInput += data;
              flushInput();
            }
            // 'pending' = removed unsent text (no PTY backspace needed)
            // false = nothing to remove (swallow the backspace)
            return;
          }
          if (/^[\r\n]+$/.test(data)) {
            // Enter: send full buffered text + \r to PTY in one shot
            const text = this._localEchoOverlay?.pendingText || '';
            this._localEchoOverlay?.clear();
            // Suppress detection so PTY-echoed text isn't re-detected as user input
            this._localEchoOverlay?.suppressBufferDetection();
            // Clear flushed offset and text — Enter commits all text
            this._flushedOffsets?.delete(this.activeSessionId);
            this._flushedTexts?.delete(this.activeSessionId);
            if (this._inputFlushTimeout) {
              clearTimeout(this._inputFlushTimeout);
              this._inputFlushTimeout = null;
            }
            if (text) {
              this._pendingInput += text;
              flushInput();
            }
            // Send \r after a short delay so text arrives first
            setTimeout(() => {
              this._pendingInput += '\r';
              flushInput();
            }, 80);
            return;
          }
          if (data.length > 1 && data.charCodeAt(0) >= 32) {
            // Paste: append to overlay only (sent on Enter)
            this._localEchoOverlay?.appendText(data);
            return;
          }
          if (data.charCodeAt(0) < 32) {
            // Skip xterm-generated terminal responses.
            // These arrive via triggerDataEvent when the terminal processes
            // buffer data (DA responses, OSC color queries, mode reports, etc.).
            // They are NOT user input and must not clear flushed text state.
            // Covers: CSI (\x1b[), OSC (\x1b]), DCS (\x1bP), APC (\x1b_),
            // PM (\x1b^), SOS (\x1bX), and any other multi-byte ESC sequence.
            // Single-byte ESC (user pressing Escape) still falls through to
            // the control char handler below.
            if (data.length > 1 && data.charCodeAt(0) === 27) {
              // Multi-byte escape sequence — forward to PTY without clearing
              // overlay/flushed state (terminal response, not user input)
              this._pendingInput += data;
              flushInput();
              return;
            }
            // During buffer load (tab switch), stray control chars from
            // terminal response processing must not wipe the flushed state
            // that selectSession() is actively restoring.
            if (this._restoringFlushedState) {
              this._pendingInput += data;
              flushInput();
              return;
            }
            // Tab key: send pending text + Tab to PTY for tab completion.
            // Set a flag so flushPendingWrites() re-detects buffer text when
            // the PTY response arrives (event-driven, no fixed timer).
            if (data === '\t') {
              const text = this._localEchoOverlay?.pendingText || '';
              this._localEchoOverlay?.clear();
              this._flushedOffsets?.delete(this.activeSessionId);
              this._flushedTexts?.delete(this.activeSessionId);
              if (text) {
                this._pendingInput += text;
              }
              this._pendingInput += data;
              if (this._inputFlushTimeout) {
                clearTimeout(this._inputFlushTimeout);
                this._inputFlushTimeout = null;
              }
              // Snapshot prompt line text BEFORE flushing — used to distinguish
              // real Tab completions from pre-existing Claude UI text.
              let baseText = '';
              try {
                const p = this._localEchoOverlay?.findPrompt?.();
                if (p) {
                  const buf = this.terminal.buffer.active;
                  const line = buf.getLine(buf.viewportY + p.row);
                  if (line)
                    baseText = line
                      .translateToString(true)
                      .slice(p.col + 2)
                      .trimEnd();
                }
              } catch {}
              this._tabCompletionBaseText = baseText;
              flushInput();
              this._tabCompletionSessionId = this.activeSessionId;
              this._tabCompletionRetries = 0;
              // Fallback: if flushPendingWrites() detection misses the completion
              // (e.g., flicker filter delays data, or xterm hasn't processed writes
              // by the time the callback fires), retry detection after a delay.
              // This ensures the overlay renders even without further terminal data.
              if (this._tabCompletionFallback) clearTimeout(this._tabCompletionFallback);
              const selfTab = this;
              this._tabCompletionFallback = setTimeout(() => {
                selfTab._tabCompletionFallback = null;
                if (!selfTab._tabCompletionSessionId || selfTab._tabCompletionSessionId !== selfTab.activeSessionId)
                  return;
                const ov = selfTab._localEchoOverlay;
                if (!ov || ov.pendingText) return;
                selfTab.terminal.write('', () => {
                  if (!selfTab._tabCompletionSessionId) return;
                  ov.resetBufferDetection();
                  const detected = ov.detectBufferText();
                  if (detected && detected !== selfTab._tabCompletionBaseText) {
                    selfTab._tabCompletionSessionId = null;
                    selfTab._tabCompletionRetries = 0;
                    selfTab._tabCompletionBaseText = null;
                    ov.rerender();
                  }
                });
              }, 300);
              return;
            }
            // Control chars (Ctrl+C, single ESC): send buffered text + control char immediately
            const text = this._localEchoOverlay?.pendingText || '';
            this._localEchoOverlay?.clear();
            // Suppress detection so PTY-echoed text isn't re-detected as user input
            this._localEchoOverlay?.suppressBufferDetection();
            // Clear flushed offset and text — control chars (Ctrl+C, Escape) change
            // cursor position or abort readline, making flushed text tracking invalid.
            this._flushedOffsets?.delete(this.activeSessionId);
            this._flushedTexts?.delete(this.activeSessionId);
            if (text) {
              this._pendingInput += text;
            }
            this._pendingInput += data;
            if (this._inputFlushTimeout) {
              clearTimeout(this._inputFlushTimeout);
              this._inputFlushTimeout = null;
            }
            flushInput();
            return;
          }
          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            // Printable char: add to overlay only (sent on Enter)
            this._localEchoOverlay?.addChar(data);
            return;
          }
        }

        // ── Normal Mode (echo disabled) ──
        this._pendingInput += data;

        // Control chars (Enter, Ctrl+C, escape sequences) — flush immediately
        if (data.charCodeAt(0) < 32 || data.length > 1) {
          if (this._inputFlushTimeout) {
            clearTimeout(this._inputFlushTimeout);
            this._inputFlushTimeout = null;
          }
          flushInput();
          return;
        }

        // Regular chars — flush immediately if typed after a gap (>50ms),
        // otherwise batch via microtask to coalesce rapid keystrokes (paste).
        const now = performance.now();
        if (now - this._lastKeystrokeTime > 50) {
          // Single char after a gap — send immediately, no setTimeout latency
          if (this._inputFlushTimeout) {
            clearTimeout(this._inputFlushTimeout);
            this._inputFlushTimeout = null;
          }
          this._lastKeystrokeTime = now;
          flushInput();
        } else {
          // Rapid sequence (paste or fast typing) — coalesce via microtask
          this._lastKeystrokeTime = now;
          if (!this._inputFlushTimeout) {
            this._inputFlushTimeout = setTimeout(flushInput, 0);
          }
        }
      }
    });
  },

  /**
   * Register a custom link provider for xterm.js that detects file paths
   * in terminal output and makes them clickable.
   * When clicked, opens a floating log viewer window with live streaming.
   */
  registerFilePathLinkProvider() {
    const self = this;

    // Debug: Track if provider is being invoked
    let lastInvokedLine = -1;

    this.terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        // Debug logging - only log if line changed to avoid spam
        if (bufferLineNumber !== lastInvokedLine) {
          lastInvokedLine = bufferLineNumber;
          console.debug('[LinkProvider] Checking line:', bufferLineNumber);
        }

        const buffer = self.terminal.buffer.active;
        // provideLinks passes 1-based line number, getLine expects 0-based
        const line = buffer.getLine(bufferLineNumber - 1);

        if (!line) {
          callback(undefined);
          return;
        }

        // Get line text - translateToString handles wrapped lines
        const lineText = line.translateToString(true);

        if (!lineText || !lineText.includes('/')) {
          callback(undefined);
          return;
        }

        const links = [];

        // Pattern 0: URLs (https://, http://) — matched first so they take priority
        const urlPattern = /https?:\/\/[^\s"'<>|;&)\]\x00-\x1f]+/g;

        const addUrlLink = (url, matchIndex) => {
          // Strip trailing punctuation that's likely not part of the URL
          const cleaned = url.replace(/[.,;:!?)]+$/, '');
          const startCol = lineText.indexOf(cleaned, matchIndex);
          if (startCol === -1) return;

          if (links.some((l) => l.range.start.x === startCol + 1)) return;

          links.push({
            text: cleaned,
            range: {
              start: { x: startCol + 1, y: bufferLineNumber },
              end: { x: startCol + cleaned.length + 1, y: bufferLineNumber },
            },
            decorations: { pointerCursor: true, underline: true },
            activate(_event, text) {
              window.open(text, '_blank', 'noopener,noreferrer');
            },
            hover() {
              self._linkHovered = true;
            },
            leave() {
              self._linkHovered = false;
            },
          });
        };

        // Pattern 1: Commands with file paths (tail -f, cat, head, grep pattern, etc.)
        // Handles: tail -f /path, grep pattern /path, cat -n /path
        // ⚠ The arg group must stay linear-time: `(?:[^\s\/]*\s+)*` (empty-matchable
        // token, unbounded) backtracks exponentially on lines with a trigger word
        // followed by multi-space runs (e.g. wrapped heredoc/table output) — froze
        // the whole tab on hover. Non-empty token + bounded reps is O(n).
        const cmdPattern = /\b(tail|cat|head|less|grep|watch|vim|nano)\s+(?:[^\s\/]+\s+){0,4}(\/[^\s"'<>|;&\n\x00-\x1f]+)/g;

        // Pattern 2: Paths with common extensions
        const extPattern =
          /(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\n\x00-\x1f]*\.(?:log|txt|json|md|yaml|yml|csv|xml|sh|py|ts|js))\b/g;

        // Pattern 3: Bash() tool output
        const bashPattern = /Bash\([^)]*?(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\)\n\x00-\x1f]+)/g;

        const addLink = (filePath, matchIndex) => {
          const startCol = lineText.indexOf(filePath, matchIndex);
          if (startCol === -1) return;

          // Skip if already have link at this position
          if (links.some((l) => l.range.start.x === startCol + 1)) return;

          links.push({
            text: filePath,
            range: {
              start: { x: startCol + 1, y: bufferLineNumber }, // 1-based
              end: { x: startCol + filePath.length + 1, y: bufferLineNumber },
            },
            decorations: {
              pointerCursor: true,
              underline: true,
            },
            activate(event, text) {
              self.openLogViewerWindow(text, self.activeSessionId);
            },
            hover() {
              self._linkHovered = true;
            },
            leave() {
              self._linkHovered = false;
            },
          });
        };

        // Match all patterns — URLs first so they take priority
        let match;

        urlPattern.lastIndex = 0;
        while ((match = urlPattern.exec(lineText)) !== null) {
          addUrlLink(match[0], match.index);
        }

        cmdPattern.lastIndex = 0;
        while ((match = cmdPattern.exec(lineText)) !== null) {
          addLink(match[2], match.index);
        }

        extPattern.lastIndex = 0;
        while ((match = extPattern.exec(lineText)) !== null) {
          addLink(match[1], match.index);
        }

        bashPattern.lastIndex = 0;
        while ((match = bashPattern.exec(lineText)) !== null) {
          addLink(match[1], match.index);
        }

        if (links.length > 0) {
          console.debug(
            '[LinkProvider] Found links:',
            links.map((l) => l.text)
          );
        }
        callback(links.length > 0 ? links : undefined);
      },
    });

    console.log('[LinkProvider] File path link provider registered');
  },

  showWelcome() {
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.add('visible');
      this.loadTunnelStatus();
      this.loadHistorySessions();
      this.initSearchPanel();
    }
    // Home screen has no input target — hide the CJK textarea (activeSessionId
    // is null by the time we get here). Guarded: defined on the app object.
    this._updateCjkInputState?.();
  },

  hideWelcome() {
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    // Collapse expanded QR when leaving welcome screen
    const qrWrap = document.getElementById('welcomeQr');
    if (qrWrap) {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.remove('expanded');
    }
    // Entering a session — restore CJK textarea if the user has it enabled
    // (activeSessionId is already set by selectSession before this call).
    this._updateCjkInputState?.();
  },

  /**
   * Fetch and deduplicate history sessions (up to 3 per project, sorted by date).
   * Uses projectKey for grouping because workingDir decoding is lossy.
   * @returns {Promise<Array>} deduplicated session list, most recent first
   */
  async _fetchHistorySessions() {
    const res = await fetch('/api/history/sessions');
    const data = await res.json();
    const sessions = data.data?.sessions || [];
    if (sessions.length === 0) return [];

    const byProject = new Map();
    for (const s of sessions) {
      const key = s.projectKey || s.workingDir;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(s);
    }
    const items = [];
    for (const [, group] of byProject) {
      items.push(...group.slice(0, 3));
    }
    items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    return items;
  },

  /**
   * Fetch the unified session list (live + persisted + non-Claude + closed
   * history), already de-duplicated and sorted newest-first by the backend
   * (`GET /api/sessions/unified`, COD-121). No client-side grouping needed.
   * @param {number} [limit=60] max sessions to request
   * @returns {Promise<Array>} unified session items, most recent first
   */
  async _fetchUnifiedSessions(limit = 60) {
    const res = await fetch('/api/sessions/unified?limit=' + limit);
    // ApiResponse envelope: { success, data: { sessions } }. Throw on failure so
    // callers (loadHistorySessions) hit their catch instead of rendering a 5xx as
    // an empty history.
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.success === false || !data.data) {
      throw new Error(data?.error || `unified sessions request failed (HTTP ${res.status})`);
    }
    return data.data.sessions || [];
  },

  /**
   * Resolve workingDir to a case-aware short label.
   * - Exact case path match → "#caseName"
   * - workingDir under a case dir → "#caseName/subdir"
   * - Otherwise → basename (e.g. "Claudeman")
   */
  _resolveCaseLabel(workingDir, cases) {
    if (!workingDir) return '';
    let best = null;
    for (const c of cases || []) {
      if (!c || !c.path) continue;
      if (workingDir === c.path) {
        return `#${c.name}`;
      }
      if (workingDir.startsWith(c.path + '/')) {
        const len = c.path.length;
        if (!best || len > best.len) {
          best = { name: c.name, suffix: workingDir.slice(len), len };
        }
      }
    }
    if (best) return `#${best.name}${best.suffix}`;
    return workingDir.split('/').pop() || workingDir;
  },

  /** Normalize home prefixes to "~/" on both Linux and macOS */
  _shortenHomePath(p) {
    return (p || '')
      .replace(/^\/home\/[^/]+\//, '~/')
      .replace(/^\/Users\/[^/]+\//, '~/');
  },

  /**
   * Build a single history item DOM element.
   * @param {object} s session record
   * @param {Array} cases linked cases (for #caseName label)
   * @param {object} [options]
   * @param {boolean} [options.showViewAll=true] show "View all in folder" button in detail panel
   * @param {Function} [options.onActivate] main-row click handler override (default: resume the conversation)
   */
  _buildHistoryItem(s, cases, options) {
    const showViewAll = options?.showViewAll !== false;

    // Size: only render when a numeric byte count is present (unified items
    // backed solely by a live/persisted source may omit it).
    const hasSize = typeof s.sizeBytes === 'number';
    const size = !hasSize
      ? ''
      : s.sizeBytes < 1024
        ? `${s.sizeBytes}B`
        : s.sizeBytes < 1048576
          ? `${(s.sizeBytes / 1024).toFixed(0)}K`
          : `${(s.sizeBytes / 1048576).toFixed(1)}M`;

    // Timestamp: unified shape carries lastActivityAt (ms epoch); the older
    // folder-modal/history shape carries an ISO lastModified string. Prefer ms,
    // fall back to parsing the string, and omit entirely when neither is valid.
    const tsMs =
      typeof s.lastActivityAt === 'number'
        ? s.lastActivityAt
        : s.lastModified
          ? Date.parse(s.lastModified)
          : NaN;
    let timeStr = '';
    if (!Number.isNaN(tsMs)) {
      const date = new Date(tsMs);
      timeStr =
        date.toLocaleDateString('en', { month: 'short', day: 'numeric' }) +
        ' ' +
        date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    const shortDir = this._shortenHomePath(s.workingDir);
    const caseLabel = this._resolveCaseLabel(s.workingDir, cases);

    const isLive = Array.isArray(s.sources) && s.sources.includes('live');

    const item = document.createElement('div');
    item.className = 'history-item';
    item.title = s.workingDir || '';

    // Main row: clickable surface. A caller-supplied onActivate wins (the
    // Session Manager routes live rows to selectSession and history rows to
    // resume). Otherwise the default focuses the live tab when the row is a
    // still-running session, else resumes the conversation — keyed by the Claude
    // conversation UUID (claudeSessionId) when present, since resumed sessions
    // carry theirs separately from their Codeman id.
    const mainRow = document.createElement('div');
    mainRow.className = 'history-item-main';
    mainRow.addEventListener(
      'click',
      options?.onActivate ||
        (() => {
          if (isLive && this.sessions.has(s.sessionId)) {
            this.selectSession(s.sessionId);
          } else {
            this.resumeHistorySession(s.claudeSessionId || s.sessionId, s.workingDir || '');
          }
        })
    );

    const textCol = document.createElement('div');
    textCol.className = 'history-item-text';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'history-item-title';
    titleSpan.textContent = s.name || s.firstPrompt || shortDir;

    // Badge row: mode (claude/codex/opencode/gemini/shell) + a LIVE pill.
    const badgeRow = document.createElement('div');
    badgeRow.className = 'history-item-badges';
    if (s.mode) {
      const modeBadge = document.createElement('span');
      modeBadge.className = 'history-item-badge history-item-badge-mode';
      modeBadge.textContent = s.mode;
      badgeRow.appendChild(modeBadge);
    }
    if (isLive) {
      const liveBadge = document.createElement('span');
      liveBadge.className = 'history-item-badge history-item-badge-live';
      liveBadge.textContent = 'LIVE';
      badgeRow.appendChild(liveBadge);
    }

    const subtitleSpan = document.createElement('span');
    subtitleSpan.className = 'history-item-subtitle';
    if (caseLabel.startsWith('#')) subtitleSpan.classList.add('is-case');
    subtitleSpan.textContent = caseLabel;

    textCol.append(titleSpan);
    if (badgeRow.childElementCount > 0) textCol.append(badgeRow);
    textCol.append(subtitleSpan);

    const metaSpan = document.createElement('span');
    metaSpan.className = 'history-item-meta';
    metaSpan.textContent = timeStr;

    const expandBtn = document.createElement('button');
    expandBtn.className = 'history-item-expand';
    expandBtn.type = 'button';
    // COD-130: the ⋯ button now opens a context (kebab) menu rather than
    // toggling the inline detail panel directly. aria-expanded still tracks
    // the detail panel (toggled via the menu's "Show details" item).
    expandBtn.setAttribute('aria-haspopup', 'menu');
    expandBtn.setAttribute('aria-label', 'Session actions');
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.textContent = '⋯'; // ⋯

    mainRow.append(textCol, metaSpan, expandBtn);

    // Detail panel: full prompt + full path, hidden by default
    const detail = document.createElement('div');
    detail.className = 'history-item-detail';
    detail.hidden = true;

    const promptRow = document.createElement('div');
    promptRow.className = 'history-detail-row';
    const promptLabel = document.createElement('span');
    promptLabel.className = 'history-detail-label';
    promptLabel.textContent = 'Prompt';
    const promptText = document.createElement('span');
    promptText.className = 'history-detail-value history-detail-prompt';
    promptText.textContent = s.firstPrompt || '(no prompt captured)';
    promptRow.append(promptLabel, promptText);

    const pathRow = document.createElement('div');
    pathRow.className = 'history-detail-row';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'history-detail-label';
    pathLabel.textContent = 'Path';
    const pathText = document.createElement('span');
    pathText.className = 'history-detail-value history-detail-path';
    pathText.textContent = shortDir;
    pathRow.append(pathLabel, pathText);

    const metaRow = document.createElement('div');
    metaRow.className = 'history-detail-row history-detail-meta';
    const metaParts = [];
    if (timeStr) metaParts.push(timeStr);
    if (hasSize) metaParts.push(size);
    metaParts.push(s.sessionId.slice(0, 8));
    metaRow.textContent = metaParts.join(' · ');

    detail.append(promptRow, pathRow, metaRow);

    if (showViewAll && s.projectKey) {
      const actionRow = document.createElement('div');
      actionRow.className = 'history-detail-row history-detail-actions';
      const viewAllBtn = document.createElement('button');
      viewAllBtn.type = 'button';
      viewAllBtn.className = 'history-view-all-btn';
      viewAllBtn.textContent = 'View all in this folder';
      viewAllBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.openFolderHistoryModal(s.projectKey, s.workingDir, cases);
      });
      actionRow.appendChild(viewAllBtn);
      detail.appendChild(actionRow);
    }

    expandBtn.addEventListener('click', (ev) => {
      // COD-130: stop both the row resume handler and the Session Manager
      // modal's main-row close listener from firing, then open the kebab menu.
      ev.stopPropagation();
      ev.preventDefault();
      this._openSessionRowMenu(ev.currentTarget, s, cases, item, detail);
    });

    item.append(mainRow, detail);
    return item;
  },

  /**
   * COD-130: Open a context (kebab) menu anchored to a history item's ⋯
   * button. Replaces the old inline detail-toggle so the same control works
   * both in the history list and inside the Session Manager modal (where a
   * capture-phase close listener previously swallowed the click).
   *
   * The menu is appended to <body> with fixed positioning so it escapes the
   * modal's overflow/stacking context, and flips above the anchor when it
   * would overflow the viewport bottom.
   *
   * @param {HTMLElement} anchorEl the ⋯ button the menu anchors to
   * @param {object} s session record
   * @param {Array} cases linked cases (unused but kept for parity/future)
   * @param {HTMLElement} item the .history-item element (for detail toggle)
   * @param {HTMLElement} detail the inline detail panel element
   */
  _openSessionRowMenu(anchorEl, s, cases, item, detail) {
    // Close any already-open row menu first — call its own close fn so the
    // previous menu's document/window listeners are detached (a raw .remove()
    // would leave them dangling until the next event self-cleans).
    if (this._openRowMenuClose) {
      try {
        this._openRowMenuClose();
      } catch {
        /* noop */
      }
    }

    const isLiveOpen =
      Array.isArray(s.sources) && s.sources.includes('live') && this.sessions.has(s.sessionId);

    const menu = document.createElement('div');
    menu.className = 'session-row-menu';
    menu.setAttribute('role', 'menu');

    // closeMenu tears down the menu and all transient listeners.
    let onDocMouseDown = null;
    let onKeyDown = null;
    let onScrollResize = null;
    const closeMenu = () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize, true);
      try {
        menu.remove();
      } catch {
        /* noop */
      }
      if (this._openRowMenuEl === menu) {
        this._openRowMenuEl = null;
        this._openRowMenuClose = null;
      }
    };

    // Helper: build one menu item button.
    const addItem = (label, onActivate, opts) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'session-row-menu-item';
      btn.setAttribute('role', 'menuitem');
      const text = document.createElement('span');
      text.className = 'session-row-menu-label';
      text.textContent = label;
      btn.appendChild(text);
      if (opts && opts.sublabel) {
        const sub = document.createElement('span');
        sub.className = 'session-row-menu-sublabel';
        sub.textContent = opts.sublabel;
        btn.appendChild(sub);
      }
      btn.addEventListener('click', async (ev) => {
        // Never let the click bubble to the row resume / modal close handlers.
        ev.stopPropagation();
        ev.preventDefault();
        await onActivate();
      });
      menu.appendChild(btn);
    };

    // Resume / Switch to session (always).
    addItem(
      isLiveOpen ? 'Switch to session' : 'Resume session',
      () => {
        if (isLiveOpen) {
          this.selectSession(s.sessionId);
        } else {
          // Resume by the Claude conversation UUID when present (resumed sessions
          // carry theirs separately from their Codeman id).
          this.resumeHistorySession(s.claudeSessionId || s.sessionId, s.workingDir || '');
        }
        this.closeSessionManager?.();
        closeMenu();
      }
    );

    // Open folder (only for a live+open session — file browser is session-scoped).
    if (isLiveOpen) {
      addItem('Open folder', () => {
        this.selectSession(s.sessionId);
        this.loadFileBrowser?.(s.sessionId);
        this.closeSessionManager?.();
        closeMenu();
      });
    }

    // Copy path (only when a workingDir is known).
    if (s.workingDir) {
      addItem('Copy path', async () => {
        const ok = await this._copyText(s.workingDir);
        this.showToast(ok ? 'Path copied' : 'Copy failed', ok ? 'success' : 'error');
        closeMenu();
      });
    }

    // Show details (always) — toggles the inline detail panel; keeps modal open.
    addItem('Show details', () => {
      const expanded = item.classList.toggle('expanded');
      detail.hidden = !expanded;
      anchorEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      closeMenu();
    });

    // Position: fixed, anchored under/over the button; flip up on overflow.
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 4;
    let top = rect.bottom + gap;
    if (top + menuRect.height > window.innerHeight && rect.top - gap - menuRect.height >= 0) {
      top = rect.top - gap - menuRect.height; // flip above the anchor
    }
    // Right-align the menu to the button, clamped into the viewport.
    let left = rect.right - menuRect.width;
    if (left < gap) left = gap;
    if (left + menuRect.width > window.innerWidth - gap) {
      left = Math.max(gap, window.innerWidth - gap - menuRect.width);
    }
    menu.style.top = `${Math.max(gap, top)}px`;
    menu.style.left = `${left}px`;

    // Dismissal listeners.
    onDocMouseDown = (ev) => {
      if (menu.contains(ev.target) || anchorEl.contains(ev.target)) return;
      closeMenu();
    };
    onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeMenu();
      }
    };
    onScrollResize = () => closeMenu();
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize, true);

    this._openRowMenuEl = menu;
    this._openRowMenuClose = closeMenu;
  },

  /** Number of history items shown before "Show More" */
  _HISTORY_INITIAL_COUNT: 4,

  async loadHistorySessions() {
    const container = document.getElementById('historySessions');
    const list = document.getElementById('historyList');
    if (!container || !list) return;

    try {
      // Load cases in parallel so subtitle can show "#caseName" labels.
      // Prefer already-loaded this.cases to avoid an extra request.
      const casesPromise = Array.isArray(this.cases) && this.cases.length > 0
        ? Promise.resolve(this.cases)
        : fetch('/api/cases').then((r) => (r.ok ? r.json() : null)).then((d) => d?.data || []).catch(() => []);
      const [allSessions, cases] = await Promise.all([
        this._fetchUnifiedSessions(60),
        casesPromise,
      ]);
      if (allSessions.length === 0) {
        container.style.display = 'none';
        return;
      }

      list.replaceChildren();
      const initialCount = this._HISTORY_INITIAL_COUNT;

      // Render initial items
      for (let i = 0; i < Math.min(initialCount, allSessions.length); i++) {
        list.appendChild(this._buildHistoryItem(allSessions[i], cases));
      }

      // Add "Show More" button if there are more items
      if (allSessions.length > initialCount) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'history-show-more';
        moreBtn.textContent = `Show ${allSessions.length - initialCount} more`;
        moreBtn.addEventListener('click', () => {
          for (let i = initialCount; i < allSessions.length; i++) {
            list.insertBefore(this._buildHistoryItem(allSessions[i], cases), moreBtn);
          }
          moreBtn.remove();
        });
        list.appendChild(moreBtn);
      }

      container.style.display = '';
    } catch (err) {
      console.error('[loadHistorySessions]', err);
      container.style.display = 'none';
    }
  },

  /** Page size for the folder history modal */
  _FOLDER_HISTORY_PAGE_SIZE: 20,

  /**
   * Open a modal showing all history sessions in a single folder.
   * Paginated by FOLDER_HISTORY_PAGE_SIZE; "Show more" loads next page.
   */
  openFolderHistoryModal(projectKey, workingDir, cases) {
    // Close any existing instance first
    this._closeFolderHistoryModal();

    const modal = document.createElement('div');
    modal.className = 'modal active folder-history-modal';
    modal.id = 'folderHistoryModal';

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => this._closeFolderHistoryModal());

    const content = document.createElement('div');
    content.className = 'modal-content modal-lg';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h3');
    title.textContent = 'Folder History';
    const subtitle = document.createElement('div');
    subtitle.className = 'folder-history-subtitle';
    subtitle.textContent = this._shortenHomePath(workingDir);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this._closeFolderHistoryModal());
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const list = document.createElement('div');
    list.className = 'folder-history-list';
    list.setAttribute('data-loading', 'true');
    list.textContent = 'Loading...';
    body.append(subtitle, list);

    content.append(header, body);
    modal.append(backdrop, content);
    document.body.appendChild(modal);

    // Track state for pagination
    this._folderHistoryState = {
      projectKey,
      workingDir,
      cases: cases || [],
      offset: 0,
      total: null,
      list,
    };

    // ESC to close
    this._folderHistoryEscHandler = (ev) => {
      if (ev.key === 'Escape') this._closeFolderHistoryModal();
    };
    document.addEventListener('keydown', this._folderHistoryEscHandler);

    this._loadFolderHistoryPage();
  },

  async _loadFolderHistoryPage() {
    const state = this._folderHistoryState;
    if (!state) return;
    const { projectKey, cases, list } = state;
    const limit = this._FOLDER_HISTORY_PAGE_SIZE;
    const offset = state.offset;

    // Remove existing "Show more" button while loading
    const existingMore = list.querySelector('.folder-history-more');
    if (existingMore) existingMore.remove();

    // First page: clear loading placeholder
    if (offset === 0) {
      list.replaceChildren();
      list.removeAttribute('data-loading');
    }

    try {
      const url = `/api/history/sessions?projectKey=${encodeURIComponent(projectKey)}&offset=${offset}&limit=${limit}`;
      const res = await fetch(url);
      const data = await res.json();
      const sessions = data.data?.sessions || [];
      state.total = typeof data.data?.total === 'number' ? data.data.total : sessions.length + offset;

      if (offset === 0 && sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'folder-history-empty';
        empty.textContent = 'No conversations found in this folder.';
        list.appendChild(empty);
        return;
      }

      for (const s of sessions) {
        list.appendChild(this._buildHistoryItem(s, cases, { showViewAll: false }));
      }

      state.offset = offset + sessions.length;

      // Add "Show more" if there are more sessions
      if (state.offset < state.total) {
        const remaining = state.total - state.offset;
        const moreBtn = document.createElement('button');
        moreBtn.className = 'history-show-more folder-history-more';
        moreBtn.textContent = `Show ${Math.min(limit, remaining)} more (${remaining} remaining)`;
        moreBtn.addEventListener('click', () => this._loadFolderHistoryPage());
        list.appendChild(moreBtn);
      }
    } catch (err) {
      console.error('[loadFolderHistoryPage]', err);
      const errorEl = document.createElement('div');
      errorEl.className = 'folder-history-empty';
      errorEl.textContent = 'Failed to load folder history.';
      list.appendChild(errorEl);
    }
  },

  _closeFolderHistoryModal() {
    const modal = document.getElementById('folderHistoryModal');
    if (modal) modal.remove();
    if (this._folderHistoryEscHandler) {
      document.removeEventListener('keydown', this._folderHistoryEscHandler);
      this._folderHistoryEscHandler = null;
    }
    this._folderHistoryState = null;
  },

  async resumeHistorySession(sessionId, workingDir) {
    // Close the run mode menu if open
    document.getElementById('runModeMenu')?.classList.remove('active');
    // Close folder history modal if open
    this._closeFolderHistoryModal();
    try {
      this.terminal.clear();
      this.terminal.writeln(`\x1b[1;32m Resuming conversation ${sessionId.slice(0, 8)}...\x1b[0m`);

      // Generate a session name from the working dir
      const dirName = workingDir.split('/').pop() || 'session';
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^w(\d+)-/);
        if (match) {
          const num = parseInt(match[1]);
          if (num >= startNumber) startNumber = num + 1;
        }
      }
      const name = `w${startNumber}-${dirName}`;

      // Create session with resumeSessionId — include envOverrides so resumed
      // conversations inherit current UI settings (effort, agent teams, etc.).
      // Match by path (not basename) so linked/renamed cases still resolve correctly.
      const matchingCase = (this.cases || []).find((c) => c.path === workingDir);
      const caseName = matchingCase?.name || workingDir.split('/').pop() || '';
      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), globalSettings);
      const effort = this.getEffortSetting(globalSettings);
      const createRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingDir,
          name,
          resumeSessionId: sessionId,
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          ...(effort ? { effort } : {}),
        }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error);

      const newSessionId = createData.data.session.id;

      // Start interactive
      await fetch(`/api/sessions/${newSessionId}/interactive`, { method: 'POST' });

      this.terminal.writeln(`\x1b[90m Session ${name} ready\x1b[0m`);
      await this.selectSession(newSessionId);
      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Terminal Rendering
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if terminal viewport is at or near the bottom.
   * Used to implement "sticky scroll" behavior - keep user at bottom if they were there.
   */
  isTerminalAtBottom() {
    if (!this.terminal) return true;
    const buffer = this.terminal.buffer.active;
    // viewportY is the top line of the viewport, baseY is where scrollback starts
    // If viewportY >= baseY, we're showing the latest content (at bottom)
    // Allow 2 lines tolerance for edge cases
    return buffer.viewportY >= buffer.baseY - 2;
  },

  // Record manual scroll gestures so sticky-scroll can give an upward scroll a
  // short grace window (see _hasRecentUserScrollUp). A downward scroll that
  // lands back at the bottom clears the suppression immediately.
  _noteTerminalUserScroll(lines) {
    if (lines < 0) {
      this._lastUserScrollUpAt = performance.now();
    } else if (this.isTerminalAtBottom()) {
      this._lastUserScrollUpAt = null;
    }
  },

  _hasRecentUserScrollUp() {
    if (typeof this._lastUserScrollUpAt !== 'number') return false;
    return performance.now() - this._lastUserScrollUpAt < window.CodemanTerminalInput.USER_SCROLL_STICKY_SUPPRESS_MS;
  },

  batchTerminalWrite(data) {
    // If a buffer load (chunkedTerminalWrite) is in progress, queue live events
    // to prevent interleaving historical buffer data with live SSE data.
    // This is critical: interleaving causes cursor position chaos with Ink redraws.
    if (this._isLoadingBuffer) {
      if (this._loadBufferQueue) this._loadBufferQueue.push(data);
      return;
    }

    // Check if at bottom BEFORE adding data (captures user's scroll position)
    // Only update if not already scheduled (preserve the first check's result)
    if (!this.writeFrameScheduled) {
      this._wasAtBottomBeforeWrite = this.isTerminalAtBottom();
    }

    // Check if flicker filter is enabled for current session
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    const flickerFilterEnabled = session?.flickerFilterEnabled ?? false;

    // xterm.js 6.0 handles DEC 2026 synchronized output natively — Ink's cursor-up
    // redraws are wrapped in 2026h/2026l markers and rendered atomically by xterm.js.
    // No client-side cursor-up detection/buffering needed. The old 50ms flicker filter
    // was actively harmful: it accumulated multiple resize redraws and flushed them
    // together, causing stacked ghost renders due to reflow line-count mismatches.

    // Opt-in flicker filter: buffer screen clear patterns (for sessions that enable it)
    if (flickerFilterEnabled) {
      const hasScreenClear =
        data.includes('\x1b[2J') ||
        data.includes('\x1b[H\x1b[J') ||
        (data.includes('\x1b[H') && data.includes('\x1b[?25l'));

      if (hasScreenClear) {
        this.flickerFilterActive = true;
        this.flickerFilterBuffer += data;

        if (this.flickerFilterTimeout) {
          clearTimeout(this.flickerFilterTimeout);
        }
        this.flickerFilterTimeout = setTimeout(() => {
          this.flickerFilterTimeout = null;
          this.flushFlickerBuffer();
        }, SYNC_WAIT_TIMEOUT_MS); // 50ms buffer window

        return;
      }

      if (this.flickerFilterActive) {
        this.flickerFilterBuffer += data;
        return;
      }
    }

    // Accumulate raw data (may contain DEC 2026 markers)
    this.pendingWrites.push(data);

    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      this._safeYield(() => {
        // xterm.js 6.0 handles DEC 2026 sync markers natively — it buffers
        // content between 2026h/2026l and renders atomically. No need for
        // client-side incomplete-block detection; just flush every frame.
        this.flushPendingWrites();
        this.writeFrameScheduled = false;
      });
    }
  },

  /**
   * Flush the flicker filter buffer to the terminal.
   * Called after the buffer window expires.
   */
  flushFlickerBuffer() {
    if (!this.flickerFilterBuffer) return;

    // Transfer buffered data to normal pending writes
    this.pendingWrites.push(this.flickerFilterBuffer);
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Trigger a normal flush
    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      this._safeYield(() => {
        this.flushPendingWrites();
        this.writeFrameScheduled = false;
      });
    }
  },

  /**
   * Update local echo overlay state based on settings.
   * Enabled whenever the setting is on — works during idle AND busy.
   * Position is tracked dynamically by _findPrompt() on every render.
   */
  _updateLocalEchoState() {
    const settings = this.loadAppSettingsFromStorage();
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    const echoEnabled = settings.localEchoEnabled ?? MobileDetection.isTouchDevice();
    const shouldEnable = !!(echoEnabled && session);
    if (this._localEchoEnabled && !shouldEnable) {
      this._localEchoOverlay?.clear();
    }
    this._localEchoEnabled = shouldEnable;

    // Swap prompt finder based on session mode
    if (this._localEchoOverlay && session) {
      if (session.mode === 'opencode') {
        // OpenCode (Bubble Tea TUI): find the ┃ border on the cursor's row.
        // The input area is "┃  <text>" — the ┃ is the anchor, offset 3 skips "┃  ".
        // We use the cursor row (cursorY) to find the right line, then scan for ┃.
        this._localEchoOverlay.setPrompt({
          type: 'custom',
          offset: 3,
          find: (terminal) => {
            try {
              const buf = terminal.buffer.active;
              const row = buf.cursorY;
              const line = buf.getLine(buf.viewportY + row);
              if (!line) return null;
              const text = line.translateToString(true);
              const idx = text.indexOf('\u2503'); // ┃ (BOX DRAWINGS HEAVY VERTICAL)
              if (idx >= 0) return { row, col: idx };
              return null;
            } catch {
              return null;
            }
          },
        });
      } else if (session.mode === 'shell') {
        // Shell mode: the shell provides its own PTY echo so the overlay isn't needed.
        // Disable it by clearing any pending text.
        this._localEchoOverlay.clear();
        this._localEchoEnabled = false;
      } else {
        // Codex/Claude-style TUIs usually expose a ❯ prompt. During active
        // redraws or compact mobile layouts that marker may not be present in
        // the viewport, while xterm's cursor still marks the editable input
        // position. Fall back to cursor coordinates so phone typing appears at
        // the terminal cursor instead of disappearing into pending state.
        this._localEchoOverlay.setPrompt({
          type: 'custom',
          offset: 0,
          find: (terminal) => {
            try {
              const buf = terminal.buffer.active;
              for (let row = terminal.rows - 1; row >= 0; row--) {
                const line = buf.getLine(buf.viewportY + row);
                if (!line) continue;
                const text = line.translateToString(true);
                const idx = text.lastIndexOf('\u276f');
                if (idx >= 0) return { row, col: idx + 2 };
              }
              return {
                row: Math.max(0, Math.min(terminal.rows - 1, buf.cursorY)),
                col: Math.max(0, Math.min(terminal.cols - 1, buf.cursorX)),
              };
            } catch {
              return null;
            }
          },
        });
      }
    }
  },

  // CJK textarea already provides visual feedback — bypass local echo
  // buffering so each composed word reaches the PTY immediately.
  _handleCjkInput(text) {
    if (!this.activeSessionId) {
      _crashDiag.log(`CJK send DROP no-session len=${text.length}`);
      return;
    }
    _crashDiag.log(`CJK send→${this.activeSessionId.slice(0, 8)} len=${text.length}`);
    this._sendInputAsync(this.activeSessionId, text);
  },

  /**
   * Flush pending writes to terminal, processing DEC 2026 sync markers.
   * Strips markers and writes content atomically within a single frame.
   */
  flushPendingWrites() {
    if (this.pendingWrites.length === 0 || !this.terminal) return;

    const _t0 = performance.now();
    // xterm.js 6.0+ natively handles DEC 2026 synchronized output markers.
    // Pass raw data through — xterm.js buffers content between markers and
    // renders atomically, eliminating split-frame Ink redraws.
    const joined = this.pendingWrites.join('');
    this.pendingWrites = [];
    const _joinedLen = joined.length;
    if (_joinedLen > 16384) _crashDiag.log(`FLUSH: ${(_joinedLen / 1024).toFixed(0)}KB`);

    // Per-frame byte budget to prevent main thread blocking.
    // Large writes (141KB+) can freeze Chrome for 2+ minutes.
    // Codex's TUI emits dense synchronized redraws during thinking/high-effort
    // phases, so it gets a smaller first frame to keep per-frame xterm/WebGL
    // stalls short; other modes keep the larger 64KB budget.
    const activeSession = this.activeSessionId && this.sessions ? this.sessions.get(this.activeSessionId) : null;
    const MAX_FRAME_BYTES = activeSession?.mode === 'codex' ? 32768 : 65536;
    let deferred = false;
    // If the user recently scrolled up, remember the viewport so we can restore
    // it after the write — Codex status redraws would otherwise jump it.
    const preserveViewportY =
      this._hasRecentUserScrollUp() && this.terminal.buffer?.active ? this.terminal.buffer.active.viewportY : null;

    if (_joinedLen <= MAX_FRAME_BYTES) {
      this.terminal.write(joined);
    } else {
      // Write first chunk now, defer rest to next frame
      this.terminal.write(joined.slice(0, MAX_FRAME_BYTES));
      this.pendingWrites.push(joined.slice(MAX_FRAME_BYTES));
      deferred = true;
      if (!this.writeFrameScheduled) {
        this.writeFrameScheduled = true;
        this._safeYield(() => {
          this.flushPendingWrites();
          this.writeFrameScheduled = false;
        });
      }
    }
    if (
      preserveViewportY !== null &&
      this.terminal.buffer?.active?.viewportY !== preserveViewportY &&
      typeof this.terminal.scrollToLine === 'function'
    ) {
      this.terminal.scrollToLine(preserveViewportY);
    }
    const bytesThisFrame = deferred ? MAX_FRAME_BYTES : _joinedLen;
    const _dt = performance.now() - _t0;
    if (_dt > 100 || deferred)
      console.warn(
        `[CRASH-DIAG] flushPendingWrites: ${_dt.toFixed(0)}ms, ${(bytesThisFrame / 1024).toFixed(0)}KB written${deferred ? ', rest deferred' : ''} (total ${(_joinedLen / 1024).toFixed(0)}KB)`
      );

    // Sticky scroll: if user was at bottom, keep them there after new output.
    // Give manual scroll-up gestures a short grace window so high-frequency
    // Codex status ticks do not snap the viewport back while the user is
    // trying to inspect earlier output.
    if (this._wasAtBottomBeforeWrite && !this._hasRecentUserScrollUp()) {
      this.terminal.scrollToBottom();
    }

    // Re-position local echo overlay after terminal writes — Ink redraws can
    // move the ❯ prompt to a different row, making the overlay invisible.
    if (this._localEchoOverlay?.hasPending) {
      this._localEchoOverlay.rerender();
    }

    // After Tab completion: detect the completed text in the overlay.
    // Use terminal.write('', callback) to defer detection until xterm.js
    // finishes processing ALL queued writes — direct buffer reads after
    // terminal.write(data) can miss text if xterm processes asynchronously.
    if (
      this._tabCompletionSessionId &&
      this._tabCompletionSessionId === this.activeSessionId &&
      this._localEchoOverlay &&
      !this._localEchoOverlay.pendingText
    ) {
      const overlay = this._localEchoOverlay;
      const self = this;
      this.terminal.write('', () => {
        if (!self._tabCompletionSessionId) return; // already resolved
        overlay.resetBufferDetection();
        const detected = overlay.detectBufferText();
        if (detected) {
          if (detected === self._tabCompletionBaseText) {
            // Same text as before Tab — no completion yet. Undo and retry.
            overlay.undoDetection();
            self._tabCompletionRetries = (self._tabCompletionRetries || 0) + 1;
            if (self._tabCompletionRetries > 60) {
              self._tabCompletionSessionId = null;
              self._tabCompletionRetries = 0;
            }
          } else {
            // Text changed — real completion happened
            self._tabCompletionSessionId = null;
            self._tabCompletionRetries = 0;
            self._tabCompletionBaseText = null;
            if (self._tabCompletionFallback) {
              clearTimeout(self._tabCompletionFallback);
              self._tabCompletionFallback = null;
            }
            overlay.rerender();
          }
        } else {
          // No text found yet — retry on next flush.
          self._tabCompletionRetries = (self._tabCompletionRetries || 0) + 1;
          if (self._tabCompletionRetries > 60) {
            self._tabCompletionSessionId = null;
            self._tabCompletionRetries = 0;
          }
        }
      });
    }
  },

  /**
   * Schedule cb via THREE racing primitives so data-pacing makes progress
   * regardless of which scheduling primitive Chrome is throttling:
   *   1. requestAnimationFrame — primary, fires at compositor rate
   *      (may be 0Hz when window is occluded / on backgrounded monitor).
   *   2. setTimeout(50) — fallback for occluded-but-visible windows
   *      (clamped to 1Hz by Chrome's intensive wake-up throttling
   *      after ~5 min of no user interaction).
   *   3. Worker postMessage — bypasses intensive throttling entirely;
   *      Workers are not subject to background-tab / idle-tab throttling
   *      (the React Scheduler trick).
   * Whichever fires first wins; the others are no-ops thanks to the
   * `done` guard. Without all three, chunkedTerminalWrite and the deferred
   * path of flushPendingWrites stall indefinitely when the substrate is
   * degraded (visible-but-occluded window, OR idle-throttled tab, OR
   * background tab on a different monitor).
   */
  _safeYield(cb) {
    let done = false;
    const wrapped = () => {
      if (done) return;
      done = true;
      cb();
    };
    requestAnimationFrame(wrapped);
    setTimeout(wrapped, 50);
    this._workerYield(wrapped);
  },

  /**
   * Lazy-init a tiny "tick" worker whose only job is to postMessage back to
   * us as fast as possible, escaping main-thread throttling. The worker's
   * setTimeout(0) is not subject to Chrome's intensive wake-up throttling
   * even when the parent tab is idle.
   */
  _workerYield(cb) {
    try {
      if (this._yieldWorker === undefined) {
        // First call: build the worker (or mark unavailable). Each
        // postMessage in produces exactly one postMessage out — we count on
        // FIFO 1:1 to drain queue entries.
        const src = "onmessage=()=>setTimeout(()=>postMessage(0),0);";
        const blob = new Blob([src], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        this._yieldWorker = new Worker(url);
        URL.revokeObjectURL(url);
        this._yieldQueue = [];
        this._yieldWorker.onmessage = () => {
          const fn = this._yieldQueue.shift();
          if (fn) fn();
        };
      }
      if (!this._yieldWorker) return;
      this._yieldQueue.push(cb);
      this._yieldWorker.postMessage(0);
    } catch {
      this._yieldWorker = null; // mark unavailable, future calls skip
    }
  },

  scrollToLastNonEmptyLine() {
    if (!this.terminal?.buffer?.active) {
      this.terminal?.scrollToBottom?.();
      return;
    }

    const buffer = this.terminal.buffer.active;
    const totalLines = buffer.baseY + buffer.length;
    let lastNonEmptyLine = -1;

    for (let lineIndex = totalLines - 1; lineIndex >= 0; lineIndex--) {
      const line = buffer.getLine(lineIndex);
      if (line?.translateToString(true).trim()) {
        lastNonEmptyLine = lineIndex;
        break;
      }
    }

    if (lastNonEmptyLine >= 0 && typeof this.terminal.scrollToLine === 'function') {
      let targetLine = Math.max(0, lastNonEmptyLine - this.terminal.rows + 2);
      const maxTargetLine = Math.max(0, lastNonEmptyLine);
      while (targetLine < maxTargetLine) {
        const line = buffer.getLine(targetLine);
        if (line?.translateToString(true).trim()) break;
        targetLine++;
      }
      this.terminal.scrollToLine(targetLine);
    } else {
      this.terminal.scrollToBottom();
    }
  },

  /**
   * Write large buffer to terminal in chunks to avoid UI jank.
   * Uses _safeYield to spread work across frames; falls back to setTimeout
   * and a tick-Worker so progress continues on occluded / idle-throttled tabs.
   * @param {string} buffer - The full terminal buffer to write
   * @param {number} chunkSize - Size of each chunk (default 128KB for smooth 60fps)
   * @returns {Promise<void>} - Resolves when all chunks written
   */
  chunkedTerminalWrite(buffer, chunkSize = TERMINAL_CHUNK_SIZE, loadOwner) {
    // Generation counter: if a newer chunkedTerminalWrite starts (tab switch),
    // older writes abort instead of continuing to push stale data into the terminal.
    const writeGen = ++this._chunkedWriteGen;
    const bufferLoadOwner = this._beginBufferLoad(loadOwner);

    return new Promise((resolve) => {
      if (!buffer || buffer.length === 0) {
        this._finishBufferLoad(bufferLoadOwner);
        resolve();
        return;
      }

      // Strip any DEC 2026 markers that might be in the buffer
      // (from historical SSE data that was stored with markers)
      const cleanBuffer = buffer.replace(DEC_SYNC_STRIP_RE, '');

      const finish = () => {
        // Only finish if we're still the active write — a newer write owns buffer load state
        if (this._chunkedWriteGen === writeGen) {
          this._finishBufferLoad(bufferLoadOwner);
        }
        resolve();
      };

      // For small buffers, write directly — single-frame render is fast enough
      if (cleanBuffer.length <= chunkSize) {
        this.terminal.write(cleanBuffer, finish);
        return;
      }

      // Large buffers: write in chunks across animation frames.
      // Each 32KB chunk keeps per-frame WebGL render work under ~5ms,
      // avoiding GPU stalls without needing to toggle the renderer.
      let offset = 0;
      const _chunkStart = performance.now();
      let _chunkCount = 0;
      const writeChunk = () => {
        // Abort if a newer chunked write started (user switched tabs)
        if (this._chunkedWriteGen !== writeGen) {
          resolve();
          return;
        }

        if (offset >= cleanBuffer.length) {
          const _totalMs = performance.now() - _chunkStart;
          console.log(
            `[CRASH-DIAG] chunkedTerminalWrite complete: ${cleanBuffer.length} bytes in ${_chunkCount} chunks, ${_totalMs.toFixed(0)}ms total`
          );
          // Wait one more frame for xterm to finish rendering before resolving
          this._safeYield(finish);
          return;
        }

        const _ct0 = performance.now();
        const chunk = cleanBuffer.slice(offset, offset + chunkSize);
        this.terminal.write(chunk);
        const _cdt = performance.now() - _ct0;
        _chunkCount++;
        if (_cdt > 50)
          console.warn(
            `[CRASH-DIAG] chunk #${_chunkCount} write took ${_cdt.toFixed(0)}ms (${chunk.length} bytes at offset ${offset})`
          );
        offset += chunkSize;

        // Schedule next chunk; rAF if possible, else setTimeout/Worker
        // fallback so progress doesn't stall on occluded/unfocused windows.
        this._safeYield(writeChunk);
      };

      // Start writing
      this._safeYield(writeChunk);
    });
  },

  /**
   * Complete a buffer load: unblock live SSE writes.
   * Called when chunkedTerminalWrite finishes (or is skipped for empty buffers).
   *
   * By default queued SSE events are DISCARDED, not flushed. For an established
   * session the loaded buffer from the API is the source of truth up to the
   * response timestamp; SSE events queued during the fetch+write overlap already
   * appear in that buffer, so flushing them writes duplicate data (especially Ink
   * cursor-up redraws), corrupting the terminal display.
   *
   * COD-144: a brand-new session is the exception. Its terminal fetch can resolve
   * BEFORE the PTY emits its first prompt, so the fetched buffer is empty and the
   * prompt arrives only as a queued SSE event. Discarding it leaves the terminal
   * blank until a tab-switch re-fetches a now-populated buffer. When the caller
   * knows the load painted nothing (empty fetch + no cache), it passes
   * `{ flushQueued: true }` so the queued events are REPLAYED through
   * `batchTerminalWrite()` instead of dropped. Replay runs after `_isLoadingBuffer`
   * is cleared, so the events write through normally and are not re-queued.
   *
   * After unblocking, new SSE/WS events deliver subsequent output normally.
   *
   * @param {string} [owner] Load token from `_beginBufferLoad`; a stale owner is a no-op.
   * @param {{ flushQueued?: boolean }} [opts] When `flushQueued` is true, replay any queued events.
   */
  _beginBufferLoad(owner) {
    if (this._bufferLoadSeq === undefined) this._bufferLoadSeq = 0;
    const loadOwner = owner === undefined ? `buffer-${++this._bufferLoadSeq}` : owner;
    this._bufferLoadOwner = loadOwner;
    this._isLoadingBuffer = true;
    this._loadBufferQueue = [];
    return loadOwner;
  },

  _finishBufferLoad(owner, opts) {
    if (owner !== undefined && this._bufferLoadOwner !== owner) {
      return false;
    }
    const queued = this._loadBufferQueue;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    this._bufferLoadOwner = null;
    // COD-144: replay (rather than discard) queued live events when the load
    // painted nothing — the queued prompt is the only content a new session has.
    if (opts?.flushQueued && queued && queued.length) {
      for (const data of queued) {
        this.batchTerminalWrite(data);
      }
    }
    return true;
  },

  // ═══════════════════════════════════════════════════════════════
  // Terminal Controls
  // ═══════════════════════════════════════════════════════════════

  clearTerminal() {
    this.terminal.clear();
  },

  /**
   * Restore terminal size to match web UI dimensions.
   * Use this after mobile screen attachment has squeezed the terminal.
   * Sends only resize — SIGWINCH triggers Ink redraw on real dimension changes.
   * Ctrl+L is NOT sent here (Claude Code 2.x treats it as "clear conversation").
   */
  async restoreTerminalSize() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }

    const dims = this.getTerminalDimensions();
    if (!dims) {
      this.showToast('Could not determine terminal size', 'error');
      return;
    }

    try {
      // Force resize even when dimensions match the server's last known state —
      // another device may have changed the PTY size since this client last sent,
      // and force guarantees a SIGWINCH → Ink redraw at the current device's size.
      await this.sendResize(this.activeSessionId, { force: true });

      this.showToast(`Terminal restored to ${dims.cols}x${dims.rows}`, 'success');
    } catch (err) {
      console.error('Failed to restore terminal size:', err);
      this.showToast('Failed to restore terminal size', 'error');
    }
  },

  // Vestigial no-op: this method has no callers today. It's kept (not deleted)
  // as a documented guard so the Ctrl+L behavior below isn't reintroduced.
  //
  // Originally this sent Ctrl+L (\x0c) when a flagged session first reached
  // idle/working to scrub mux-init junk from the screen. Two problems:
  //   1. `pendingCtrlL` was never actually populated anywhere (dead path).
  //   2. Claude Code 2.x interprets Ctrl+L as a two-step "clear conversation"
  //      command — sending it from background flows risked nuking the user's
  //      conversation if it coincided with another Ctrl+L (e.g. from
  //      selectSession on page reload).
  // If a per-session display-fix is ever needed again, do it via sendResize
  // or an Ink-safe control sequence, NOT \x0c.
  sendPendingCtrlL(_sessionId) {
    // intentionally empty
  },

  async copyTerminal() {
    try {
      const buffer = this.terminal.buffer.active;
      let text = '';
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      await navigator.clipboard.writeText(text.replace(/\n+$/, '\n'));
      this.showToast('Copied to clipboard', 'success');
    } catch (err) {
      this.showToast('Failed to copy', 'error');
    }
  },

  _syncMobileHelperTextareaToCursor() {
    if (!MobileDetection.isTouchDevice() || !this.terminal?.element) return;
    try {
      const xtermEl = this.terminal.element;
      const cursor = this.terminal.element.querySelector('.xterm-cursor');
      const screen = this.terminal.element.querySelector('.xterm-screen');
      if (!(xtermEl instanceof HTMLElement) || !(cursor instanceof HTMLElement) || !(screen instanceof HTMLElement)) return;
      const cursorRect = cursor.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      if (!cursorRect.width && !cursorRect.height) return;
      const left = Math.max(0, Math.round(cursorRect.left - screenRect.left));
      const top = Math.max(0, Math.round(cursorRect.top - screenRect.top));
      xtermEl.style.setProperty('--xterm-helper-left', `${left}px`);
      xtermEl.style.setProperty('--xterm-helper-top', `${top}px`);
    } catch {}
  },

  // ═══════════════════════════════════════════════════════════════
  // Synthetic tap → mouse report
  // ═══════════════════════════════════════════════════════════════
  // Dispatch a mousedown+mouseup pair at viewport coords (clientX/clientY) to
  // xterm's root element. xterm's mouse-reporting handler reads the event's
  // client coords, maps them to a terminal cell relative to .xterm-screen, and
  // — when the foreground app has mouse tracking active (DECSET 1000/1002/1006,
  // which Claude's input enables) — encodes an SGR mouse report to the PTY.
  // That is the same path a real desktop click takes; on touch devices the
  // browser's own compatibility-event synthesis is unreliable (and suppressed
  // by touch-action:none), so we drive it explicitly. With mouse tracking off
  // it degrades to a harmless zero-length click (no drag → no text selection).
  _dispatchSyntheticTerminalClick(clientX, clientY) {
    const el = this.terminal?.element;
    if (!el || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    // xterm registers its mouseup listener on document during mousedown, so a
    // bubbling mouseup reaches it; dispatch both to the root element in order.
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      detail: 1,
    };
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    } catch {
      /* MouseEvent constructor unavailable — tap-to-position simply no-ops */
    }
  },

  // Mirror of the server's isAltScreenStripMode (session.ts): session modes whose
  // output stream has mouse-tracking DECSET sequences stripped before reaching the
  // browser. For these, xterm's live mouseTrackingMode is useless as a gate — the
  // PTY-side TUI keeps tracking enabled, we just never see the enable sequence.
  _sessionUsesServerMouseStrip() {
    const mode = this.sessions?.get(this.activeSessionId)?.mode || 'claude';
    return mode === 'claude' || mode === 'codex' || mode === 'gemini';
  },

  // True when xterm's viewport shows the live PTY screen (not scrolled up into
  // local scrollback). SGR coordinates are only meaningful then: the TUI's
  // screen is the bottom `rows` of the buffer, so a report computed from a
  // scrolled-up viewport would hit-test a completely different row.
  _terminalViewportAtBottom() {
    const buf = this.terminal?.buffer?.active;
    return !buf || buf.viewportY >= buf.baseY;
  },

  // Map a viewport point to a 1-based terminal cell the same way xterm maps a
  // click: offset inside .xterm-screen divided by the rendered cell size,
  // clamped to the grid. Returns null when the terminal isn't measurable yet.
  _clientPointToCell(clientX, clientY) {
    if (!this.terminal || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const screen = this.terminal.element?.querySelector('.xterm-screen');
    const cell = this.terminal._core?._renderService?.dimensions?.css?.cell;
    if (!screen || !cell?.width || !cell?.height) return null;
    const rect = screen.getBoundingClientRect();
    const col = Math.max(1, Math.min(this.terminal.cols, Math.floor((clientX - rect.left) / cell.width) + 1));
    const row = Math.max(1, Math.min(this.terminal.rows, Math.floor((clientY - rect.top) / cell.height) + 1));
    return { col, row };
  },

  // Encode a tap as an SGR mouse report (press + release at button 0) and send it
  // to the PTY directly, bypassing xterm's mouse encoder.
  _sendSyntheticSgrTap(clientX, clientY) {
    if (!this.activeSessionId) return;
    if (!this._terminalViewportAtBottom()) return; // scrollback click → misfire, do nothing
    const pos = this._clientPointToCell(clientX, clientY);
    if (!pos) return;
    this._sendInputAsync(this.activeSessionId, `\x1b[<0;${pos.col};${pos.row}M\x1b[<0;${pos.col};${pos.row}m`);
  },

  // True when a parsed CLI version string ('2.1.187' — banner-parsed on the
  // server, delivered via session:cliInfo / SessionState.cliVersion) is known
  // AND >= the minimum. Unknown or unparseable versions return false so
  // callers keep the conservative behavior.
  _cliVersionAtLeast(version, minimum) {
    if (typeof version !== 'string') return false;
    const parts = version.trim().replace(/^v/, '').split('.').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return false;
    const min = minimum.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (parts[i] !== min[i]) return parts[i] > min[i];
    }
    return true;
  },

  // Wheel forwarding gate for the container wheel handler: no Shift override,
  // xterm's own encoder dormant, viewport at the bottom, and a TUI VERIFIED to
  // scroll its transcript on SGR wheel reports: codex, or claude 2.1.187+
  // (older Claude Code captures wheel as select-menu option navigation; an
  // unknown version is treated as older). Gemini is a strip mode too but its
  // wheel behavior is unverified, so it keeps the local wheel — taps/clicks
  // are still forwarded for it (harmless no-ops at worst).
  // Wheel delta → whole scroll lines. macOS trackpads turn Shift+two-finger
  // scroll into a HORIZONTAL wheel (deltaY≈0, deltaX carries the magnitude), and
  // Shift routes the wheel to local scrollback (_shouldForwardWheelToApp returns
  // false on Shift). So under Shift, read whichever axis dominates — otherwise
  // deltaY≈0 collapses to a fixed ±1 line/tick and the gesture can't page through
  // history on a trackpad (issue #154). Non-Shift and mouse-wheel paths are
  // unchanged (they carry deltaY). The `|| ±1` keeps sub-25px deltas moving.
  _wheelScrollLines(ev) {
    const delta = ev.shiftKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    return Math.round(delta / 25) || (delta > 0 ? 1 : -1);
  },

  _shouldForwardWheelToApp(ev) {
    if (ev.shiftKey) return false;
    // Opt-out (App Settings → Input → "Wheel scrolls local history"): pin the
    // plain wheel to xterm's own scrollback like pre-#144, for users who prefer
    // it over forwarding the wheel to the CLI's transcript (issue #154). Cheap —
    // loadAppSettingsFromStorage() is cache-backed.
    if (this.loadAppSettingsFromStorage?.()?.terminalWheelLocalScrollback) return false;
    const mode = this.terminal?.modes?.mouseTrackingMode;
    if (mode && mode !== 'none') return false;
    const session = this.sessions?.get(this.activeSessionId);
    const sessionMode = session?.mode || 'claude';
    if (sessionMode === 'claude') {
      if (!this._cliVersionAtLeast(session?.cliVersion, '2.1.187')) return false;
    } else if (sessionMode !== 'codex') {
      return false;
    }
    return this._terminalViewportAtBottom();
  },

  // Encode wheel ticks as SGR reports (button 64 = up, 65 = down) at the pointer
  // cell. Reports are coalesced into one fire-and-forget write per ~40ms: a
  // trackpad emits dozens of wheel events per second and each send becomes a
  // tmux send-keys on the server — unbatched, a single flick would spawn a
  // process storm. Per-event tick count is capped (Claude applies its own
  // scroll-speed multiplier and acceleration on top), and the queue is bounded
  // so a wild scroll can't build a backlog that keeps scrolling after the finger
  // stops. Flushed via _sendInputEphemeral — loss-tolerant, off the durable queue.
  _sendSyntheticSgrWheel(clientX, clientY, lines) {
    if (!this.activeSessionId || !lines) return;
    const pos = this._clientPointToCell(clientX, clientY);
    if (!pos) return;
    const btn = lines < 0 ? 64 : 65;
    const ticks = Math.min(Math.abs(lines), 5);
    const queued = this._wheelSgrQueue || '';
    if (queued.length > 512) return;
    this._wheelSgrQueue = queued + `\x1b[<${btn};${pos.col};${pos.row}M`.repeat(ticks);
    if (this._wheelSgrFlushTimer) return;
    this._wheelSgrFlushTimer = setTimeout(() => this._flushWheelSgrQueue(), 40);
  },

  _flushWheelSgrQueue() {
    this._wheelSgrFlushTimer = null;
    const data = this._wheelSgrQueue;
    this._wheelSgrQueue = '';
    // Ephemeral (fire-and-forget): wheel reports are loss-tolerant, so they skip
    // the durable seq/ACK queue — no localStorage churn, no "Nb queued" flicker
    // in the connection indicator on every scroll tick.
    if (data && this.activeSessionId) this._sendInputEphemeral(this.activeSessionId, data);
  },

  // Desktop counterpart of the touchend tap branch: hand-encode an SGR report
  // for a plain left-click when the server strips mouse DECSETs (see
  // _sessionUsesServerMouseStrip). Every skip below is a click that already has
  // a meaning elsewhere: synthetic/compat clicks after a touch tap (touchend
  // reported already), modified clicks (shift keeps xterm's selection
  // override), double/triple clicks (word/line selection), drag-selections,
  // clicks on hovered links (activate() already handles the click — a second
  // synthetic SGR press could e.g. dismiss a claude permission dialog),
  // clicks outside the cell grid, and sessions where xterm's own encoder is
  // live (it reported the click itself — a second report would double-move).
  _handleDesktopTerminalClick(ev) {
    if (!this.terminal || !ev?.isTrusted) return;
    if (ev.button !== 0 || ev.detail !== 1) return;
    if (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const mode = this.terminal.modes?.mouseTrackingMode;
    if (mode && mode !== 'none') return;
    if (!this._sessionUsesServerMouseStrip()) return;
    if (this.terminal.hasSelection?.()) return;
    if (this._linkHovered) return; // link provider hover/leave callbacks (registerFilePathLinkProvider)
    if (performance.now() <= (this._trustedTapMouseSuppressUntil || 0)) return;
    if (!ev.target?.closest?.('.xterm-screen')) return;
    this._sendSyntheticSgrTap(ev.clientX, ev.clientY);
  },

  _installMobileTapMouseGuard() {
    const el = this.terminal?.element;
    if (!el || el._codemanTapMouseGuardInstalled) return;
    if (typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice && !MobileDetection.isTouchDevice()) return;
    el._codemanTapMouseGuardInstalled = true;
    const suppressTrustedCompatMouse = (ev) => {
      const suppressUntil = this._trustedTapMouseSuppressUntil || 0;
      if (!ev.isTrusted || performance.now() > suppressUntil) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    el.addEventListener('mousedown', suppressTrustedCompatMouse, true);
    el.addEventListener('mouseup', suppressTrustedCompatMouse, true);
  },

  _suppressTrustedTapMouseEvents() {
    const ms = window.CodemanTerminalInput?.TOUCH_COMPAT_MOUSE_SUPPRESS_MS || 450;
    this._trustedTapMouseSuppressUntil = performance.now() + ms;
  },

  increaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.min(current + 2, 24));
  },

  decreaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.max(current - 2, 10));
  },

  setFontSize(size) {
    this.terminal.options.fontSize = size;
    document.getElementById('fontSizeDisplay').textContent = size;
    this.fitAddon.fit();
    localStorage.setItem('codeman-font-size', size);
    // Update overlay font cache and re-render at new cell dimensions
    this._localEchoOverlay?.refreshFont();
  },

  loadFontSize() {
    const saved = localStorage.getItem('codeman-font-size');
    if (saved) {
      const size = parseInt(saved, 10);
      if (size >= 10 && size <= 24) {
        this.terminal.options.fontSize = size;
        document.getElementById('fontSizeDisplay').textContent = size;
      }
    }
  },

  /**
   * Get terminal dimensions with minimum enforcement.
   * Prevents extremely narrow terminals that cause vertical text wrapping.
   * @returns {{cols: number, rows: number}|null}
   */
  getTerminalDimensions() {
    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    const dims = this.fitAddon?.proposeDimensions();
    if (!dims) return null;
    return {
      cols: Math.max(dims.cols, MIN_COLS),
      rows: Math.max(dims.rows, MIN_ROWS),
    };
  },

  /**
   * Send resize to a session with minimum dimension enforcement.
   * @param {string} sessionId
   * @param {{ forceHttp?: boolean, force?: boolean }} [options]
   * @returns {Promise<boolean>} Whether dimensions changed from the last send
   */
  async sendResize(sessionId, options = {}) {
    // Fit terminal to container before reading dimensions — ensures local
    // terminal size matches what we report to the server PTY.
    if (this.fitAddon) this.fitAddon.fit();
    const dims = this.getTerminalDimensions();
    if (!dims) return false;
    // Did the dimensions actually change since the last resize we sent? Callers
    // use this to skip work (e.g. the post-resize TUI-redraw settle) when no
    // real SIGWINCH was triggered — switching tabs at the same browser size is
    // a no-op on the server and needs no redraw grace.
    const prev = this._lastResizeDims;
    const changed = !prev || prev.cols !== dims.cols || prev.rows !== dims.rows;
    // Update _lastResizeDims so the throttledResize handler won't redundantly
    // clear the terminal for the same dimensions (which would blank the screen
    // without a subsequent Ink redraw to repaint it).
    this._lastResizeDims = { cols: dims.cols, rows: dims.rows };
    const viewportType =
      typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType
        ? MobileDetection.getDeviceType()
        : window.innerWidth < 430
          ? 'mobile'
          : window.innerWidth < 768
            ? 'tablet'
            : 'desktop';
    // Fast path: WebSocket resize
    if (!options.forceHttp && this._wsReady && this._wsSessionId === sessionId) {
      try {
        const msg = { t: 'z', c: dims.cols, r: dims.rows, v: viewportType };
        if (options.force) msg.f = true;
        this._ws.send(JSON.stringify(msg));
        return changed;
      } catch {
        // Fall through to HTTP POST
      }
    }
    const body = { ...dims, viewportType };
    if (options.force) body.force = true;
    await fetch(`/api/sessions/${sessionId}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return changed;
  },

  /**
   * Send input to the active session.
   * @param {string} input - Text to send (include \r for Enter)
   * @returns {Promise<void>}
   */
  async sendInput(input) {
    if (!this.activeSessionId || !input) return;
    // Route through the durable, exactly-once delivery layer (useMux for the
    // POST fallback) so voice / keyboard-accessory / paste input also survives a
    // dropped link instead of being lost in a single best-effort fetch.
    this._sendInputAsync(this.activeSessionId, input, { useMux: true });
  },

  // ═══════════════════════════════════════════════════════════════
  // Directory Input
  // ═══════════════════════════════════════════════════════════════

  toggleDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    if (input.classList.contains('hidden')) {
      input.classList.remove('hidden');
      btn.style.display = 'none';
      input.focus();
    }
  },

  hideDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    setTimeout(() => {
      input.classList.add('hidden');
      btn.style.display = '';

      const value = input.value.trim();
      document.getElementById('dirDisplay').textContent = value || 'No directory';
    }, 100);
  },

  // Re-theme all live xterm terminals (main + teammate) to the given skin's palette.
  // Uses the xterm v5+ live setter (full object assignment triggers a repaint for both
  // DOM and WebGL renderers) plus a belt-and-suspenders refresh().
  applyTerminalSkin(skin) {
    const theme = { ...(window.CODEMAN_XTERM_THEMES[skin] || window.CODEMAN_XTERM_THEMES['daylight-blue']) };
    if (this.terminal) {
      this.terminal.options.theme = theme;
      try {
        this.terminal.refresh(0, this.terminal.rows - 1);
      } catch {}
    }
    if (this.teammateTerminals) {
      for (const [, entry] of this.teammateTerminals) {
        if (entry && entry.terminal) {
          entry.terminal.options.theme = { ...theme };
          try {
            entry.terminal.refresh(0, entry.terminal.rows - 1);
          } catch {}
        }
      }
    }
  },
});

// ═══════════════════════════════════════════════════════════════
// COD-9 — Cross-session search (folded into the welcome history panel)
// Consumes GET /api/search; renders grouped result cards with jump-to actions.
// ═══════════════════════════════════════════════════════════════

(function (global) {
  const SEARCH_DEBOUNCE_MS = 250;
  const SEARCH_LIMIT = 60;
  const SOURCE_LABELS = { session: 'Sessions', event: 'Events', file: 'Files' };

  /** Human-friendly relative-ish timestamp matching the history panel's style. */
  function formatSearchTime(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    return (
      d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })
    );
  }

  global.CodemanSearch = { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT, SOURCE_LABELS, formatSearchTime };
})(window);

Object.assign(CodemanApp.prototype, {
  /**
   * Wire up the search box, filter chips, and selects inside the welcome
   * history panel. Idempotent — safe to call every time the overlay opens.
   */
  initSearchPanel() {
    const input = document.getElementById('searchInput');
    if (!input || this._searchPanelWired) {
      // Even when already wired, refresh the case dropdown (cases may have loaded since).
      if (this._searchPanelWired) this._populateSearchCaseFilter();
      return;
    }
    this._searchPanelWired = true;

    // Active source-type filter set (mirrors the chip .active state → types= param).
    this._searchTypes = new Set(['session', 'event', 'file']);
    this._searchSecondary = { caseLabel: '', status: '', days: '' };
    this._searchDebounceTimer = null;
    this._searchSeq = 0;
    this._searchLastData = null;

    const clearBtn = document.getElementById('searchClearBtn');
    const results = document.getElementById('searchResults');

    input.addEventListener('input', () => {
      if (clearBtn) clearBtn.hidden = input.value.length === 0;
      this._scheduleSearch();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && input.value) {
        ev.stopPropagation();
        this._clearSearch();
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => this._clearSearch());
    }

    document.querySelectorAll('#searchFilters .search-filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const t = chip.dataset.typeFilter;
        // Keep at least one type selected.
        if (this._searchTypes.has(t) && this._searchTypes.size === 1) return;
        if (this._searchTypes.has(t)) {
          this._searchTypes.delete(t);
          chip.classList.remove('active');
        } else {
          this._searchTypes.add(t);
          chip.classList.add('active');
        }
        this._runSearch();
      });
    });

    const caseSel = document.getElementById('searchCaseFilter');
    const statusSel = document.getElementById('searchStatusFilter');
    const dateSel = document.getElementById('searchDateFilter');
    if (caseSel) {
      caseSel.addEventListener('change', () => {
        this._searchSecondary.caseLabel = caseSel.value;
        this._renderSearch(this._searchLastData);
      });
    }
    if (statusSel) {
      statusSel.addEventListener('change', () => {
        this._searchSecondary.status = statusSel.value;
        this._renderSearch(this._searchLastData);
      });
    }
    if (dateSel) {
      dateSel.addEventListener('change', () => {
        this._searchSecondary.days = dateSel.value;
        this._renderSearch(this._searchLastData);
      });
    }

    this._populateSearchCaseFilter();
    if (results) results.hidden = true;
  },

  /** Fill the case <select> from loaded cases (#caseName values). */
  _populateSearchCaseFilter() {
    const sel = document.getElementById('searchCaseFilter');
    if (!sel) return;
    const cases = Array.isArray(this.cases) ? this.cases : [];
    const names = Array.from(new Set(cases.map((c) => c && c.name).filter(Boolean))).sort();
    const current = sel.value;
    // Rebuild options (keep the "All cases" placeholder).
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All cases';
    sel.appendChild(all);
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = '#' + name;
      sel.appendChild(opt);
    }
    if (current && names.includes(current)) sel.value = current;
  },

  /** Debounced trigger from the input event. */
  _scheduleSearch() {
    clearTimeout(this._searchDebounceTimer);
    this._searchDebounceTimer = setTimeout(() => this._runSearch(), window.CodemanSearch.SEARCH_DEBOUNCE_MS);
  },

  _clearSearch() {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.hidden = true;
    this._searchLastData = null;
    this._renderSearch(null);
  },

  /** Execute the federated search request and render the result. */
  async _runSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;
    const q = input.value.trim();
    if (q.length === 0) {
      this._searchLastData = null;
      this._renderSearch(null);
      return;
    }

    const types = Array.from(this._searchTypes);
    const params = new URLSearchParams();
    params.set('q', q.slice(0, 200));
    if (types.length > 0 && types.length < 3) params.set('types', types.join(','));
    params.set('limit', String(window.CodemanSearch.SEARCH_LIMIT));

    const seq = ++this._searchSeq;
    const data = await this._apiJson('/api/search?' + params.toString());
    // Drop stale responses (a newer query already fired).
    if (seq !== this._searchSeq) return;

    if (!data) {
      // null = request error or 400 (bad input). Show an empty/error state.
      this._searchLastData = { query: q, groups: [], totalResults: 0, truncated: false, _error: true };
    } else {
      this._searchLastData = data;
    }
    this._renderSearch(this._searchLastData);
  },

  /**
   * Apply client-side secondary filters (case / status / date) to a group's
   * results. Type filtering already happened server-side via types=.
   */
  _applySecondaryFilters(results) {
    const { caseLabel, status, days } = this._searchSecondary;
    let out = results;
    if (caseLabel) {
      const want = '#' + caseLabel;
      out = out.filter((r) => (r.sessionName || '').includes(want) || r.sessionName === caseLabel);
    }
    if (status) {
      const activeIds = new Set((this.sessionOrder || []).concat(Object.keys(this.sessions || {})));
      out = out.filter((r) => {
        const isActive = activeIds.has(r.sessionId);
        return status === 'active' ? isActive : !isActive;
      });
    }
    if (days) {
      const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
      out = out.filter((r) => Number.isFinite(r.timestamp) && r.timestamp >= cutoff);
    }
    return out;
  },

  /** Render the grouped result cards (or empty/loading states). */
  _renderSearch(data) {
    const results = document.getElementById('searchResults');
    const historyTitle = document.getElementById('historyTitle');
    const historyList = document.getElementById('historyList');
    if (!results) return;

    const searching = !!data;
    // Hide the plain "Resume Conversation" history list while a search is active.
    if (historyTitle) historyTitle.style.display = searching ? 'none' : '';
    if (historyList) historyList.style.display = searching ? 'none' : '';

    results.innerHTML = '';
    if (!data) {
      results.hidden = true;
      return;
    }
    results.hidden = false;

    if (data._error) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'Search unavailable — check the query and try again.';
      results.appendChild(empty);
      return;
    }

    // Apply secondary (client-side) filters and recompute shown total.
    const groups = (data.groups || [])
      .map((g) => ({ type: g.type, results: this._applySecondaryFilters(g.results || []) }))
      .filter((g) => g.results.length > 0);

    const shownTotal = groups.reduce((n, g) => n + g.results.length, 0);

    if (shownTotal === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'No results for "' + (data.query || '') + '"';
      results.appendChild(empty);
      return;
    }

    for (const group of groups) {
      const header = document.createElement('div');
      header.className = 'search-group-header';
      const label = document.createElement('span');
      label.className = 'search-group-label';
      label.textContent = window.CodemanSearch.SOURCE_LABELS[group.type] || group.type;
      const count = document.createElement('span');
      count.className = 'search-group-count';
      count.textContent = String(group.results.length);
      header.append(label, count);
      results.appendChild(header);

      for (const r of group.results) {
        results.appendChild(this._buildSearchResultCard(r));
      }
    }

    if (data.truncated) {
      const trunc = document.createElement('div');
      trunc.className = 'search-truncated';
      trunc.textContent = 'Showing the top matches — refine your search to narrow results.';
      results.appendChild(trunc);
    }
  },

  /** Build a single result card DOM node wired to its jump-to action. */
  _buildSearchResultCard(r) {
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.dataset.type = r.type;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const topRow = document.createElement('div');
    topRow.className = 'search-result-top';

    const badge = document.createElement('span');
    badge.className = 'search-result-badge search-badge-' + r.type;
    badge.textContent = (window.CodemanSearch.SOURCE_LABELS[r.type] || r.type).replace(/s$/, '');

    const name = document.createElement('span');
    name.className = 'search-result-name';
    name.textContent = r.sessionName || r.sessionId || '(session)';

    const time = document.createElement('span');
    time.className = 'search-result-time';
    time.textContent = window.CodemanSearch.formatSearchTime(r.timestamp);

    topRow.append(badge, name, time);

    const snippet = document.createElement('div');
    snippet.className = 'search-result-snippet';
    snippet.textContent = r.snippet || '';

    card.append(topRow, snippet);

    const jump = () => this._jumpToSearchResult(r);
    card.addEventListener('click', jump);
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        jump();
      }
    });

    return card;
  },

  /**
   * Navigate to a search result by jumpTo.kind, reusing the existing app methods:
   *   session     → selectSession(sessionId)        (open/switch to the session)
   *   run-summary → openRunSummary(sessionId)        (session options → summary tab)
   *   file-preview→ openFilePreview(path, sessionId, attachmentId)
   */
  _jumpToSearchResult(r) {
    const jt = r && r.jumpTo;
    if (!jt) return;
    // Leaving the welcome overlay so the target surface is visible.
    if (typeof this.hideWelcome === 'function') this.hideWelcome();

    try {
      if (jt.kind === 'run-summary') {
        this.openRunSummary(jt.sessionId);
      } else if (jt.kind === 'file-preview') {
        this.openFilePreview(jt.relativePath || '', jt.sessionId, jt.targetId || null);
      } else {
        // 'session' (default)
        this.selectSession(jt.sessionId);
      }
    } catch (err) {
      console.error('[search] jump failed', err);
    }
  },
});
