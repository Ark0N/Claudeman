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
      theme: {
        background: '#0d0d0d',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        cursorAccent: '#0d0d0d',
        selection: 'rgba(255, 255, 255, 0.3)',
        black: '#0d0d0d',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#ffd43b',
        blue: '#339af0',
        magenta: '#cc5de8',
        cyan: '#22b8cf',
        white: '#e0e0e0',
        brightBlack: '#495057',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#5c7cfa',
        brightMagenta: '#da77f2',
        brightCyan: '#66d9e8',
        brightWhite: '#ffffff',
      },
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

    // Suppress xterm key handling during CJK IME composition.
    // Without this, xterm processes raw keyDown events (e.g., "Process" key)
    // during composition, causing duplicate or garbled input.
    this.terminal.attachCustomKeyEventHandler((ev) => {
      if (ev.isComposing || ev.keyCode === 229) return false;

      // Let Alt+digit pass through to browser (tab switching)
      if (ev.altKey && ev.key >= '0' && ev.key <= '9') return false;

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
          Promise.resolve().then(() => {
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
    if (_params.get('webgl') === 'force') {
      try { localStorage.removeItem('codeman-webgl-disabled'); } catch {}
    }
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
    const skipWebGL =
      MobileDetection.getDeviceType() !== 'desktop' ||
      _params.has('nowebgl') ||
      _stickyDisabled;
    if (_stickyDisabled) {
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

    // CJK IME input — textarea in index.html, just wire up send
    this._cjkInput = null;
    if (typeof CjkInput !== 'undefined') {
      this._cjkInput = CjkInput.init({
        send: (text) => {
          if (this.activeSessionId) {
            this._sendInputAsync(this.activeSessionId, text);
          }
        },
      });
    }

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

    // Always use mouse wheel for terminal scrollback, never forward to application.
    // Prevents Claude's Ink UI (plan mode selector) from capturing scroll as option navigation.
    container.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const lines = Math.round(ev.deltaY / 25) || (ev.deltaY > 0 ? 1 : -1);
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
      container.addEventListener(
        'touchstart',
        (ev) => {
          if (ev.touches.length === 1) {
            touchLastY = ev.touches[0].clientY;
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
            didScroll = true;
            const touchY = ev.touches[0].clientY;
            const delta = touchLastY - touchY; // positive = scroll down
            pixelAccum += delta;
            velocity = delta * 1.2;
            touchLastY = touchY;
            // Convert accumulated pixels to whole lines
            const ch = cellHeight();
            const lines = Math.trunc(pixelAccum / ch);
            if (lines !== 0) {
              this.terminal.scrollLines(lines);
              pixelAccum -= lines * ch;
            }
          }
        },
        { passive: true }
      );

      container.addEventListener(
        'touchend',
        () => {
          isTouching = false;
          if (!scrollFrame && Math.abs(velocity) > 0.3) {
            scrollFrame = requestAnimationFrame(scrollLoop);
          }
          // Tap (no scroll): refocus xterm's hidden textarea so keyboard input
          // routes back to the terminal. Without this, a tap on the terminal area
          // consumes the touch event but xterm's textarea never regains focus.
          if (!didScroll && this.terminal) {
            this.terminal.focus();
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

    // Welcome message
    this.showWelcome();

    // Image paste and drag-and-drop support
    this.initImageInput();

    // Generation counter for chunkedTerminalWrite — aborts stale writes on tab switch
    this._chunkedWriteGen = 0;

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
              !activeResizeSession._ended &&
              this.terminal &&
              this.isTerminalAtBottom()
            ) {
              this.terminal.write('\x1b[3J\x1b[H\x1b[2J');
            }
            this._lastResizeDims = { cols, rows };
            fetch(`/api/sessions/${this.activeSessionId}/resize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cols, rows }),
            }).catch(() => {});
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
      // CJK input has focus — block xterm from sending to PTY
      if (window.cjkActive || document.activeElement?.id === 'cjkInput') return;
      if (this.activeSessionId) {
        // Filter out terminal query responses that xterm.js generates automatically.
        // These are responses to DA (Device Attributes), DSR (Device Status Report), etc.
        // sent by tmux when attaching. Without this filter, they appear as typed text.
        // Patterns: \x1b[?...c (DA1), \x1b[>...c (DA2), \x1b[...R (CPR), \x1b[...n (DSR)
        if (/^\x1b\[[\?>=]?[\d;]*[cnR]$/.test(data)) return;

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
          });
        };

        // Pattern 1: Commands with file paths (tail -f, cat, head, grep pattern, etc.)
        // Handles: tail -f /path, grep pattern /path, cat -n /path
        const cmdPattern = /(tail|cat|head|less|grep|watch|vim|nano)\s+(?:[^\s\/]*\s+)*(\/[^\s"'<>|;&\n\x00-\x1f]+)/g;

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
    }
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
  },

  /**
   * Fetch and deduplicate history sessions (up to 3 per project, sorted by date).
   * Uses projectKey for grouping because workingDir decoding is lossy.
   * @returns {Promise<Array>} deduplicated session list, most recent first
   */
  async _fetchHistorySessions() {
    const res = await fetch('/api/history/sessions');
    const data = await res.json();
    const sessions = data.sessions || [];
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

  /** Build a single history item DOM element */
  _buildHistoryItem(s, cases) {
    const size =
      s.sizeBytes < 1024
        ? `${s.sizeBytes}B`
        : s.sizeBytes < 1048576
          ? `${(s.sizeBytes / 1024).toFixed(0)}K`
          : `${(s.sizeBytes / 1048576).toFixed(1)}M`;
    const date = new Date(s.lastModified);
    const timeStr =
      date.toLocaleDateString('en', { month: 'short', day: 'numeric' }) +
      ' ' +
      date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
    const shortDir = this._shortenHomePath(s.workingDir);
    const caseLabel = this._resolveCaseLabel(s.workingDir, cases);

    const item = document.createElement('div');
    item.className = 'history-item';
    item.title = s.workingDir;

    // Main row: clickable surface that triggers resume
    const mainRow = document.createElement('div');
    mainRow.className = 'history-item-main';
    mainRow.addEventListener('click', () => this.resumeHistorySession(s.sessionId, s.workingDir));

    const textCol = document.createElement('div');
    textCol.className = 'history-item-text';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'history-item-title';
    titleSpan.textContent = s.firstPrompt || shortDir;

    const subtitleSpan = document.createElement('span');
    subtitleSpan.className = 'history-item-subtitle';
    if (caseLabel.startsWith('#')) subtitleSpan.classList.add('is-case');
    subtitleSpan.textContent = caseLabel;

    textCol.append(titleSpan, subtitleSpan);

    const metaSpan = document.createElement('span');
    metaSpan.className = 'history-item-meta';
    metaSpan.textContent = timeStr;

    const expandBtn = document.createElement('button');
    expandBtn.className = 'history-item-expand';
    expandBtn.type = 'button';
    expandBtn.setAttribute('aria-label', 'Show details');
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
    metaRow.textContent = `${timeStr} · ${size} · ${s.sessionId.slice(0, 8)}`;

    detail.append(promptRow, pathRow, metaRow);

    expandBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const expanded = item.classList.toggle('expanded');
      detail.hidden = !expanded;
      expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });

    item.append(mainRow, detail);
    return item;
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
        : fetch('/api/cases').then((r) => (r.ok ? r.json() : [])).catch(() => []);
      const [allSessions, cases] = await Promise.all([
        this._fetchHistorySessions(30),
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

  async resumeHistorySession(sessionId, workingDir) {
    // Close the run mode menu if open
    document.getElementById('runModeMenu')?.classList.remove('active');
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
      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const createRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingDir,
          name,
          resumeSessionId: sessionId,
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
        }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error);

      const newSessionId = createData.session.id;

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
        // Claude Code: scan for ❯ prompt character
        this._localEchoOverlay.setPrompt({ type: 'character', char: '\u276f', offset: 2 });
      }
    }
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
    const MAX_FRAME_BYTES = 65536; // 64KB budget per frame
    let deferred = false;

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
    const bytesThisFrame = deferred ? MAX_FRAME_BYTES : _joinedLen;
    const _dt = performance.now() - _t0;
    if (_dt > 100 || deferred)
      console.warn(
        `[CRASH-DIAG] flushPendingWrites: ${_dt.toFixed(0)}ms, ${(bytesThisFrame / 1024).toFixed(0)}KB written${deferred ? ', rest deferred' : ''} (total ${(_joinedLen / 1024).toFixed(0)}KB)`
      );

    // Sticky scroll: if user was at bottom, keep them there after new output
    if (this._wasAtBottomBeforeWrite) {
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

  /**
   * Write large buffer to terminal in chunks to avoid UI jank.
   * Uses _safeYield to spread work across frames; falls back to setTimeout
   * and a tick-Worker so progress continues on occluded / idle-throttled tabs.
   * @param {string} buffer - The full terminal buffer to write
   * @param {number} chunkSize - Size of each chunk (default 128KB for smooth 60fps)
   * @returns {Promise<void>} - Resolves when all chunks written
   */
  chunkedTerminalWrite(buffer, chunkSize = TERMINAL_CHUNK_SIZE) {
    // Generation counter: if a newer chunkedTerminalWrite starts (tab switch),
    // older writes abort instead of continuing to push stale data into the terminal.
    const writeGen = ++this._chunkedWriteGen;

    return new Promise((resolve) => {
      if (!buffer || buffer.length === 0) {
        this._finishBufferLoad();
        resolve();
        return;
      }

      // Block live SSE writes during buffer load to prevent interleaving
      this._isLoadingBuffer = true;
      this._loadBufferQueue = [];

      // Strip any DEC 2026 markers that might be in the buffer
      // (from historical SSE data that was stored with markers)
      const cleanBuffer = buffer.replace(DEC_SYNC_STRIP_RE, '');

      const finish = () => {
        // Only finish if we're still the active write — a newer write owns buffer load state
        if (this._chunkedWriteGen === writeGen) {
          this._finishBufferLoad();
        }
        resolve();
      };

      // For small buffers, write directly — single-frame render is fast enough
      if (cleanBuffer.length <= chunkSize) {
        this.terminal.write(cleanBuffer);
        finish();
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
   * Queued SSE events are DISCARDED, not flushed. The loaded buffer from the API
   * is the source of truth up to the response timestamp. SSE events queued during
   * the fetch+write overlap with the buffer — flushing them writes duplicate data
   * (especially Ink cursor-up redraws), corrupting the terminal display.
   * After unblocking, new SSE/WS events deliver subsequent output normally.
   */
  _finishBufferLoad() {
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
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
   * Sends resize to PTY and Ctrl+L to trigger Claude to redraw.
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
      // Send resize to restore proper dimensions (with minimum enforcement)
      await this.sendResize(this.activeSessionId);

      // Send Ctrl+L to trigger Claude to redraw at new size
      await fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x0c' }),
      });

      this.showToast(`Terminal restored to ${dims.cols}x${dims.rows}`, 'success');
    } catch (err) {
      console.error('Failed to restore terminal size:', err);
      this.showToast('Failed to restore terminal size', 'error');
    }
  },

  // Send Ctrl+L to fix display for newly created sessions once Claude is running
  sendPendingCtrlL(sessionId) {
    if (!this.pendingCtrlL || !this.pendingCtrlL.has(sessionId)) {
      return;
    }
    this.pendingCtrlL.delete(sessionId);

    // Only send if this is the active session
    if (sessionId !== this.activeSessionId) {
      return;
    }

    // Send resize + Ctrl+L to fix the display (with minimum dimension enforcement)
    this.sendResize(sessionId).then(() => {
      fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x0c' }),
      });
    });
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
   * @returns {Promise<void>}
   */
  async sendResize(sessionId) {
    // Fit terminal to container before reading dimensions — ensures local
    // terminal size matches what we report to the server PTY.
    if (this.fitAddon) this.fitAddon.fit();
    const dims = this.getTerminalDimensions();
    if (!dims) return;
    // Update _lastResizeDims so the throttledResize handler won't redundantly
    // clear the terminal for the same dimensions (which would blank the screen
    // without a subsequent Ink redraw to repaint it).
    this._lastResizeDims = { cols: dims.cols, rows: dims.rows };
    // Fast path: WebSocket resize
    if (this._wsReady && this._wsSessionId === sessionId) {
      try {
        this._ws.send(JSON.stringify({ t: 'z', c: dims.cols, r: dims.rows }));
        return;
      } catch {
        // Fall through to HTTP POST
      }
    }
    await fetch(`/api/sessions/${sessionId}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dims),
    });
  },

  /**
   * Send input to the active session.
   * @param {string} input - Text to send (include \r for Enter)
   * @returns {Promise<void>}
   */
  async sendInput(input) {
    if (!this.activeSessionId) return;
    await fetch(`/api/sessions/${this.activeSessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, useMux: true }),
    });
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
});
