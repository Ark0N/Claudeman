/**
 * @fileoverview Single pre-delivery controller for terminal text input.
 *
 * Browser/xterm/CJK/accessory adapters feed semantic input into this class.
 * It owns transient composition state, alternate-path deduplication, local
 * echo mutations, helper-textarea lifecycle, and final delivery ordering.
 * Durable draft persistence and exactly-once transport remain injected ports.
 *
 * @globals {TerminalInputController}
 * @dependency None
 * @loadorder 5.58 of 16 - loaded after terminal-input-state.js, before app.js
 */

const TERMINAL_INPUT_SEGMENTER =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function countTerminalInputUnits(text) {
  const value = String(text || '');
  if (!value) return 0;
  if (TERMINAL_INPUT_SEGMENTER) {
    let count = 0;
    for (const _segment of TERMINAL_INPUT_SEGMENTER.segment(value)) count += 1;
    return count;
  }
  return Array.from(value.replace(/\r\n/g, '\n')).length;
}

class TerminalInputController {
  constructor(options = {}) {
    this._textarea = options.textarea || null;
    this._overlay = options.overlay || null;
    this._getOverlay = typeof options.getOverlay === 'function' ? options.getOverlay : () => this._overlay;
    this._getSessionId = typeof options.getSessionId === 'function' ? options.getSessionId : () => '';
    this._getSessionMode = typeof options.getSessionMode === 'function' ? options.getSessionMode : () => '';
    this._isLocalEchoEnabled =
      typeof options.isLocalEchoEnabled === 'function' ? options.isLocalEchoEnabled : () => false;
    this._isRestoringDraft = typeof options.isRestoringDraft === 'function' ? options.isRestoringDraft : () => false;
    this._isInteractionPrompt =
      typeof options.isInteractionPrompt === 'function' ? options.isInteractionPrompt : () => false;
    this._onInteractionControl =
      typeof options.onInteractionControl === 'function' ? options.onInteractionControl : () => {};
    this._captureDraft = typeof options.captureDraft === 'function' ? options.captureDraft : () => {};
    this._setDraft = typeof options.setDraft === 'function' ? options.setDraft : () => {};
    this._clearDraft = typeof options.clearDraft === 'function' ? options.clearDraft : () => {};
    this._deliver = typeof options.deliver === 'function' ? options.deliver : () => {};
    this._preparePaste = typeof options.preparePaste === 'function' ? options.preparePaste : (text) => text;
    this._trace = typeof options.trace === 'function' ? options.trace : () => {};
    this._log = typeof options.log === 'function' ? options.log : () => {};
    this._setTimer =
      typeof options.setTimer === 'function'
        ? options.setTimer
        : (callback, delay) => globalThis.setTimeout(callback, delay);
    this._clearTimer =
      typeof options.clearTimer === 'function' ? options.clearTimer : (timer) => globalThis.clearTimeout(timer);
    this._now = typeof options.now === 'function' ? options.now : () => globalThis.performance?.now?.() ?? Date.now();
    this._commitTimeoutMs = Number.isFinite(options.commitTimeoutMs) ? options.commitTimeoutMs : 80;
    this._commitReplayWindowMs = Number.isFinite(options.commitReplayWindowMs) ? options.commitReplayWindowMs : 120;
    this._onTab = typeof options.onTab === 'function' ? options.onTab : null;
    this._onTabCancel = typeof options.onTabCancel === 'function' ? options.onTabCancel : () => {};

    this._compositionActive = false;
    this._compositionPending = false;
    this._compositionEpoch = 0;
    this._expectedCommit = null;
    this._fallbackCommit = null;
    this._fallbackSessionId = null;
    this._fallbackCommitEpoch = -1;
    this._fallbackCommitExpiresAt = -Infinity;
    this._compositionCommitTimer = null;
    this._pendingDelivery = '';
    this._pendingDeliverySessionId = null;
    this._deliveryFlushTimer = null;
    this._lastKeystrokeTime = 0;
    this._compositionInputCommittedEpoch = -1;
    this._ignoredCompositionEndEpoch = -1;
    this._helperMutationSnapshot = null;
    this._keydownEchoTokens = [];
    this._lastMobileEnterKeydownAt = -Infinity;
    this._mobileLineBreakPending = false;
    this._mobileLineBreakFallbackTimer = null;
    this._textareaListeners = [];
    this._lastRoutedPaste = '';
    this._lastRoutedPasteAt = 0;
    this._lastRoutedPasteSource = '';
    this._multipartPasteUntil = 0;
    this._multipartPasteCandidateUntil = 0;
    this._ptyEditingSessionIds = new Set();
    this._tabCompletionPending = false;
  }

  get state() {
    return {
      compositionActive: this._compositionActive,
      compositionPending: this._compositionPending,
      compositionEpoch: this._compositionEpoch,
      expectedCommit: this._expectedCommit,
      fallbackCommit: this._fallbackCommit,
      fallbackSessionId: this._fallbackSessionId,
      pendingDelivery: this._pendingDelivery,
    };
  }

  beginComposition() {
    this._cancelTabCompletionTracking();
    this._clearMobileLineBreakTimer();
    this._mobileLineBreakPending = false;
    this._compositionActive = true;
    this._compositionEpoch += 1;
    this._compositionInputCommittedEpoch = -1;
    this._helperMutationSnapshot = null;
    this._compositionPending = false;
    this._expectedCommit = null;
    this.clearCompositionDelivery();
    this._clearCompositionTimer();
    const overlay = this._getOverlay();
    if (this._usesLocalOverlay()) {
      overlay?.setCompositionText?.('');
      this._captureDraft();
    }
    this._trace('compositionstart', {
      epoch: this._compositionEpoch,
      helperLen: this._textarea?.value?.length || 0,
      pendingLen: overlay?.pendingText?.length || 0,
      local: this._usesLocalOverlay(),
    });
  }

  updateComposition(text) {
    if (!this._usesLocalOverlay()) return;
    this._getOverlay()?.setCompositionText?.(typeof text === 'string' ? text : '');
    this._captureDraft();
  }

  endComposition(text) {
    const belongsToKnownComposition =
      this._compositionActive ||
      this._compositionInputCommittedEpoch === this._compositionEpoch ||
      this._ignoredCompositionEndEpoch === this._compositionEpoch ||
      this._mobileLineBreakPending;
    if (!belongsToKnownComposition) {
      this._trace('compositionend-orphan-drop', {
        epoch: this._compositionEpoch,
        dataLen: typeof text === 'string' ? text.length : 0,
      });
      this._resetHelperTextarea();
      return;
    }
    this._compositionActive = false;
    const overlay = this._getOverlay();
    const fallbackText = (typeof text === 'string' && text) || overlay?.compositionText || '';
    this._expectedCommit = this._usesLocalOverlay() && fallbackText ? fallbackText : null;
    this._compositionPending = true;
    this._clearCompositionTimer();
    this._trace('compositionend', {
      epoch: this._compositionEpoch,
      dataLen: typeof text === 'string' ? text.length : 0,
      helperLen: this._textarea?.value?.length || 0,
      pendingLen: overlay?.pendingText?.length || 0,
      local: this._usesLocalOverlay(),
    });
    if (this._ignoredCompositionEndEpoch === this._compositionEpoch) {
      this._ignoredCompositionEndEpoch = -1;
      this._compositionPending = false;
      this._expectedCommit = null;
      return;
    }
    if (this._compositionInputCommittedEpoch === this._compositionEpoch) {
      this._compositionInputCommittedEpoch = -1;
      this._compositionPending = false;
      this._expectedCommit = null;
      this._clearCompositionTimer();
      return;
    }

    const endedEpoch = this._compositionEpoch;
    if (!this._usesLocalOverlay()) {
      this._compositionCommitTimer = this._setTimer(() => {
        this._compositionCommitTimer = null;
        if (endedEpoch === this._compositionEpoch) {
          this._compositionPending = false;
        }
      }, this._commitTimeoutMs);
      return;
    }

    if (this._mobileLineBreakPending) {
      this._mobileLineBreakPending = false;
      this._clearMobileLineBreakTimer();
      this.insertDraftLineBreak(fallbackText);
      return;
    }

    this._compositionCommitTimer = this._setTimer(() => {
      this._compositionCommitTimer = null;
      if (!this._compositionPending || endedEpoch !== this._compositionEpoch) {
        return;
      }
      this.commitCompositionFallback(fallbackText);
    }, this._commitTimeoutMs);
  }

  setCompositionPending(value, expectedText = null) {
    this._compositionPending = value === true;
    this._expectedCommit =
      this._compositionPending && typeof expectedText === 'string' && expectedText ? expectedText : null;
    if (!this._compositionPending) this._clearCompositionTimer();
  }

  commitCompositionFallback(text) {
    if (!this._compositionPending) return false;
    const overlay = this._getOverlay();
    const finalText = (typeof text === 'string' && text) || overlay?.compositionText || '';
    if (!finalText) {
      this._compositionPending = false;
      this._expectedCommit = null;
      overlay?.clearComposition?.();
      this._resetHelperTextarea();
      this._captureDraft();
      return false;
    }
    this._acceptComposition(finalText);
    return true;
  }

  handleTerminalData(data, source = null) {
    const sessionId = this._getSessionId();
    if (!sessionId || !data) return false;
    if (data !== '\t') this._cancelTabCompletionTracking();
    this._expireCompositionDelivery();
    const actualSource = source || 'xterm';
    if (actualSource === 'xterm') {
      this._markKeydownEchoDelivered(sessionId, data);
    }
    const localEcho = this._usesLocalOverlay(sessionId);
    const firstCode = data.charCodeAt(0);
    const isCompositionText = data !== '\x7f' && firstCode >= 32;
    const inputKind = this._classifyData(data);

    this._trace('ondata', {
      source: actualSource,
      kind: inputKind,
      len: data.length,
      local: localEcho,
      pendingLen: this._getOverlay()?.pendingText?.length || 0,
      markerLen: this._fallbackCommit?.length || 0,
      markerEq: data === this._fallbackCommit,
      compositionPending: this._compositionPending,
      expectedLen: this._expectedCommit?.length || 0,
    });

    if (this._fallbackCommit !== null && this._fallbackSessionId !== sessionId) {
      this._trace('marker-clear', { reason: 'session' });
      this.clearCompositionDelivery();
    }

    if (localEcho && this._compositionPending && data === '\x7f') {
      this._compositionPending = false;
      this._compositionActive = false;
      this._expectedCommit = null;
      this._clearCompositionTimer();
      this._getOverlay()?.clearComposition?.();
      this.clearCompositionDelivery();
      this._resetHelperTextarea();
      this._trace('composition-cancel', { reason: 'delete' });
    }

    if (localEcho && this._compositionActive && isCompositionText) {
      this._trace('composition-interim-drop', {
        source: actualSource,
        len: data.length,
      });
      return true;
    }

    const fallbackCommit = this._fallbackCommit;
    if (fallbackCommit !== null && fallbackCommit.startsWith(data)) {
      this._trace('marker-drop', {
        reason: data.length === fallbackCommit.length ? 'match' : 'prefix',
        len: data.length,
      });
      const remaining = fallbackCommit.slice(data.length);
      if (remaining) {
        this._fallbackCommit = remaining;
      } else {
        this.clearCompositionDelivery();
      }
      return true;
    }

    if (fallbackCommit !== null) {
      const acceptsComposition =
        data.length === 1 && data !== '\x7f' && (/\s/.test(data) || (firstCode >= 32 && !/[\p{L}\p{N}]/u.test(data)));
      if (!acceptsComposition) {
        this._trace('marker-clear', {
          reason: 'substantive',
          len: data.length,
          kind: inputKind,
        });
        this.clearCompositionDelivery();
      } else {
        this._trace('marker-keep', {
          reason: 'boundary',
          kind: inputKind,
        });
      }
    }

    if (!localEcho && this._compositionPending && isCompositionText) {
      this._compositionPending = false;
      this._clearCompositionTimer();
      this._rememberCompositionDelivery(data);
      this._resetHelperTextarea();
      this._trace('marker-remember', {
        source: 'shell',
        len: data.length,
      });
    }

    if (localEcho) {
      return this._handleLocalEchoData(data, isCompositionText, actualSource, sessionId);
    }

    this._queueNormalDelivery(data, sessionId);
    this._finishPtyEditingIfNeeded(sessionId, data);
    return true;
  }

  sendControl(data) {
    const sessionId = this._getSessionId();
    if (!data || !sessionId) return;
    if (data !== '\t') this._cancelTabCompletionTracking();
    if (this._usesLocalOverlay(sessionId)) {
      const overlay = this._getOverlay();
      const compositionText = overlay?.compositionText || '';
      if (compositionText) {
        this.setCompositionPending(true, compositionText);
        this.commitCompositionFallback(compositionText);
      }
      this.handleTerminalData(data, 'terminal-control');
      return;
    }
    this._flushDelivery();
    this._deliver(sessionId, data);
    this._finishPtyEditingIfNeeded(sessionId, data);
  }

  insertText(text) {
    const sessionId = this._getSessionId();
    if (!sessionId || !text) return;
    this._cancelTabCompletionTracking();
    this.clearCompositionDelivery();
    if (this._usesLocalOverlay(sessionId)) {
      this._getOverlay()?.appendText?.(text);
      this._captureDraft();
      return;
    }
    this._flushDelivery();
    this._deliverDraftText(sessionId, text);
  }

  sendExternalText(text, options = {}) {
    const sessionId = this._getSessionId();
    if (!sessionId || !text) return;
    this._cancelTabCompletionTracking();
    this._flushDelivery();
    this.clearCompositionDelivery();
    if (this._usesLocalOverlay(sessionId)) {
      const overlay = this._getOverlay();
      const compositionText = overlay?.compositionText || '';
      if (compositionText) {
        this.setCompositionPending(true, compositionText);
        this.commitCompositionFallback(compositionText);
      }
      const pendingText = overlay?.pendingText || '';
      const flushed = overlay?.getFlushed?.() || { count: 0, text: '' };
      const deliveredText = pendingText + text;
      const flushedText = flushed.text + deliveredText;
      overlay?.clear?.();
      overlay?.setFlushed?.(flushedText.length, flushedText);
      overlay?.suppressBufferDetection?.();
      this._setDraft(sessionId, {
        pendingText: '',
        flushedText,
        cjkText: '',
        updatedAt: Date.now(),
      });
      this._deliverDraftText(sessionId, deliveredText, {
        useMux: options.useMux !== false,
      });
      this._resetHelperTextarea();
      return;
    }
    this._deliverDraftText(sessionId, text, {
      useMux: options.useMux !== false,
    });
  }

  sendCommand(command) {
    if (!command || !this._getSessionId()) return;
    this.insertText(command);
    this.sendControl('\r');
  }

  sendPaste(text, options = {}) {
    const sessionId = this._getSessionId();
    if (!sessionId || !text) return;
    this._cancelTabCompletionTracking();
    const rawText = String(text);
    if (this._usesLocalOverlay(sessionId) && !options.submit) {
      this.insertText(rawText);
      return;
    }

    this.clearCompositionDelivery();
    let pasteText = rawText;
    if (this._usesLocalOverlay(sessionId)) {
      const overlay = this._getOverlay();
      const compositionText = overlay?.compositionText || '';
      if (compositionText) {
        this.setCompositionPending(true, compositionText);
        this.commitCompositionFallback(compositionText);
      }
      pasteText = (overlay?.pendingText || '') + rawText;
      overlay?.clear?.();
      overlay?.suppressBufferDetection?.();
      this._clearDraft(sessionId);
      this._resetHelperTextarea();
    }

    const mode = this._getSessionMode();
    const input = this._preparePaste(pasteText, mode !== 'shell');
    this._flushDelivery();
    this._deliver(sessionId, input, { useMux: false });
    if (options.submit) {
      this._deliver(sessionId, '\r', { useMux: false });
      this._finishPtyEditingIfNeeded(sessionId, '\r');
    }
  }

  sendModifiedEnter(keyName) {
    const sessionId = this._getSessionId();
    if (!sessionId || (keyName !== 'C-Enter' && keyName !== 'S-Enter')) return;
    this._cancelTabCompletionTracking();
    const lineFeed = '\n';
    const overlay = this._getOverlay();
    if (!this._usesLocalOverlay(sessionId)) {
      this._flushDelivery();
      this._deliver(sessionId, lineFeed);
      return;
    }

    const compositionText = overlay?.compositionText || '';
    if (compositionText) {
      this.setCompositionPending(true, compositionText);
      this.commitCompositionFallback(compositionText);
    }
    const text = overlay?.pendingText || '';
    const flushed = overlay?.getFlushed?.() || { count: 0, text: '' };
    const flushedText = flushed.text + text + lineFeed;
    overlay?.clear?.();
    overlay?.setFlushed?.(flushedText.length, flushedText);
    overlay?.suppressBufferDetection?.();
    this._setDraft(sessionId, {
      pendingText: '',
      flushedText,
      cjkText: '',
      updatedAt: Date.now(),
    });
    if (text) this._deliverDraftText(sessionId, text);
    this._deliver(sessionId, lineFeed);
    this._resetHelperTextarea();
  }

  insertDraftLineBreak(fallbackText = '') {
    const sessionId = this._getSessionId();
    if (!sessionId) return;
    const overlay = this._getOverlay();
    if (!this._usesLocalOverlay(sessionId)) {
      this._resetHelperTextarea();
      this.sendControl('\r');
      return;
    }
    const compositionText = fallbackText || overlay?.compositionText || '';
    if (compositionText) {
      this.setCompositionPending(true, compositionText);
      this.commitCompositionFallback(compositionText);
    } else {
      overlay?.clearComposition?.();
    }
    overlay?.appendText?.('\n');
    this._captureDraft();
    this._resetHelperTextarea();
  }

  clearInput() {
    const sessionId = this._getSessionId();
    if (!sessionId) return;
    this._cancelTabCompletionTracking();
    this.clearDeliveryBuffer();
    this._resetCompositionState();

    const overlay = this._getOverlay();
    if (this._usesLocalOverlay(sessionId) && overlay) {
      const flushed = overlay.getFlushed?.() || {
        count: 0,
        text: '',
      };
      overlay.clear?.();
      overlay.suppressBufferDetection?.();
      this._clearDraft(sessionId);
      const deleteCount = flushed.text ? countTerminalInputUnits(flushed.text) : flushed.count;
      if (deleteCount > 0) {
        this._deliver(sessionId, '\x7f'.repeat(deleteCount), { useMux: false });
      }
    } else {
      this._deliver(sessionId, '\x15', { useMux: false });
      this._finishPtyEditingIfNeeded(sessionId, '\x15');
    }
    this._resetHelperTextarea();
  }

  flushDraftText(text, sessionId = this._getSessionId()) {
    if (!sessionId || !text) return false;
    this._flushDelivery();
    this._deliverDraftText(sessionId, text);
    return true;
  }

  forgetSession(sessionId) {
    if (sessionId) this._ptyEditingSessionIds.delete(sessionId);
  }

  isPtyEditing(sessionId = this._getSessionId()) {
    return this._isPtyEditing(sessionId);
  }

  restorePtyEditing(sessionId, ptyOwned) {
    if (!sessionId) return;
    if (ptyOwned === true) {
      this._ptyEditingSessionIds.add(sessionId);
    } else {
      this._ptyEditingSessionIds.delete(sessionId);
    }
  }

  clearPtyEditingSessions() {
    this._ptyEditingSessionIds.clear();
  }

  clearDeliveryBuffer() {
    this._pendingDelivery = '';
    this._pendingDeliverySessionId = null;
    if (this._deliveryFlushTimer !== null) {
      this._clearTimer(this._deliveryFlushTimer);
      this._deliveryFlushTimer = null;
    }
  }

  clearCompositionDelivery() {
    this._fallbackCommit = null;
    this._fallbackSessionId = null;
    this._fallbackCommitEpoch = -1;
    this._fallbackCommitExpiresAt = -Infinity;
  }

  reset(options = {}) {
    this._cancelTabCompletionTracking();
    if (options.flushDelivery !== false) {
      this._cancelDeliveryFlush();
      this._flushDelivery();
    } else {
      this.clearDeliveryBuffer();
    }
    this._resetCompositionState();
    this._lastRoutedPaste = '';
    this._lastRoutedPasteAt = 0;
    this._lastRoutedPasteSource = '';
    this._multipartPasteUntil = 0;
    this._multipartPasteCandidateUntil = 0;
    this._resetHelperTextarea();
  }

  attachTextarea(container, options = {}) {
    if (!this._textarea || !container || this._textareaListeners.length) {
      return false;
    }
    const mobile = options.mobile === true;
    const on = (target, type, handler, listenerOptions) => {
      target.addEventListener(type, handler, listenerOptions);
      this._textareaListeners.push({
        target,
        type,
        handler,
        listenerOptions,
      });
    };

    this._attachPasteListeners(on, container, {
      segmentedFallback: mobile,
    });
    if (mobile) {
      this._attachMobileCompositionListeners(on, container);
    }
    return true;
  }

  detachTextarea() {
    for (const { target, type, handler, listenerOptions } of this._textareaListeners) {
      target.removeEventListener(type, handler, listenerOptions);
    }
    this._textareaListeners = [];
    this._clearMobileLineBreakTimer();
  }

  destroy() {
    this.detachTextarea();
    this.reset();
    this._ptyEditingSessionIds.clear();
  }

  _attachMobileCompositionListeners(on, container) {
    const textarea = this._textarea;

    on(
      container,
      'compositionstart',
      (event) => {
        if (event.target !== textarea) return;
        this.beginComposition();
      },
      true
    );
    on(
      container,
      'compositionupdate',
      (event) => {
        if (event.target !== textarea) return;
        this.updateComposition(event.data || '');
      },
      true
    );
    on(
      container,
      'compositionend',
      (event) => {
        if (event.target !== textarea) return;
        this.endComposition(event.data || '');
      },
      true
    );
    on(
      container,
      'keydown',
      (event) => {
        if (event.target !== textarea) return;
        if (event.key === 'Enter') {
          this._lastMobileEnterKeydownAt = this._now();
        }
        if (!event.isComposing && event.keyCode === 229) {
          this._helperMutationSnapshot = this._captureHelperMutationSnapshot();
          this._keydownEchoTokens = [];
          return;
        }
        if (!event.isComposing) {
          this._registerKeydownEchoCandidate(event);
        }
      },
      true
    );
    on(
      container,
      'beforeinput',
      (event) => {
        if (event.target !== textarea) return;
        if (!event.isComposing && (event.inputType === 'insertText' || event.inputType === 'insertReplacementText')) {
          this._helperMutationSnapshot = this._captureHelperMutationSnapshot();
        }

        const isLineBreak = event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph';
        const followsMobileEnter = isLineBreak && this._now() - this._lastMobileEnterKeydownAt < 500;
        if (followsMobileEnter && this._getSessionId()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this._lastMobileEnterKeydownAt = -Infinity;
          if (!this._usesLocalOverlay()) {
            this.insertDraftLineBreak();
            return;
          }
          if (this._compositionActive || event.isComposing) {
            this._mobileLineBreakPending = true;
            const lineBreakEpoch = this._compositionEpoch;
            const fallbackText = this._getOverlay()?.compositionText || '';
            this._clearMobileLineBreakTimer();
            this._mobileLineBreakFallbackTimer = this._setTimer(() => {
              this._mobileLineBreakFallbackTimer = null;
              if (!this._mobileLineBreakPending || lineBreakEpoch !== this._compositionEpoch) {
                return;
              }
              this._mobileLineBreakPending = false;
              this._ignoredCompositionEndEpoch = lineBreakEpoch;
              this._compositionActive = false;
              this.insertDraftLineBreak(fallbackText);
            }, this._commitTimeoutMs);
          } else {
            this.insertDraftLineBreak();
          }
          return;
        }

        if (
          this._compositionActive ||
          event.isComposing ||
          !this._getSessionId() ||
          (event.inputType !== 'deleteContentBackward' && event.inputType !== 'deleteWordBackward')
        ) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        this._resetHelperTextarea();
        if (this._consumeKeydownEcho(this._getSessionId(), '\x7f')) {
          return;
        }
        this.handleTerminalData('\x7f', 'beforeinput-delete');
      },
      true
    );
    on(
      container,
      'input',
      (event) => {
        if (
          event.target !== textarea ||
          (event.inputType !== 'insertText' && event.inputType !== 'insertReplacementText')
        ) {
          return;
        }

        // This controller is the single owner of helper-textarea mutations.
        // The container capture runs before xterm's textarea capture listener.
        event.stopImmediatePropagation();
        this._trace('input-capture', {
          type: event.inputType || 'none',
          eventComp: !!event.isComposing,
          stateComp: this._compositionActive,
          eventLen: typeof event.data === 'string' ? event.data.length : -1,
          helperLen: textarea.value.length,
          snapshotLen: this._helperMutationSnapshot?.value?.length ?? -1,
          pendingLen: this._getOverlay()?.pendingText?.length || 0,
          markerLen: this._fallbackCommit?.length || 0,
        });
        if (event.isComposing) return;

        const snapshot = this._helperMutationSnapshot;
        this._helperMutationSnapshot = null;
        const mutation = this._deriveTextareaMutation(snapshot, textarea.value);
        const eventData = typeof event.data === 'string' ? event.data : '';
        const data = snapshot
          ? mutation.insertedText || eventData
          : eventData || mutation.insertedText || textarea.value;
        this._trace('input-route', {
          eventLen: eventData.length,
          insertedLen: mutation.insertedText.length,
          removedLen: mutation.removedText.length,
          routeLen: data.length,
          markerLen: this._fallbackCommit?.length || 0,
          markerEq: data === this._fallbackCommit,
          pendingLen: this._getOverlay()?.pendingText?.length || 0,
        });
        if (!data && !mutation.removedText) return;

        const finalizingComposition = this._compositionActive;
        if (finalizingComposition) {
          this._compositionActive = false;
          this._compositionInputCommittedEpoch = this._compositionEpoch;
          this._compositionPending = true;
          this._expectedCommit = this._getOverlay()?.compositionText || null;
          this._clearCompositionTimer();
        }

        if (
          !finalizingComposition &&
          event.inputType === 'insertText' &&
          this._consumeKeydownEcho(this._getSessionId(), data)
        ) {
          this._resetHelperTextarea();
          return;
        }
        if (!finalizingComposition && event.inputType !== 'insertText') {
          this._keydownEchoTokens = [];
        }

        const pendingText = this._getOverlay()?.pendingText || '';
        const shouldApplyReplacement =
          mutation.removedText && (!this._usesLocalOverlay() || pendingText.endsWith(mutation.removedText));

        this._resetHelperTextarea();
        if (shouldApplyReplacement) {
          const deleteCount = countTerminalInputUnits(mutation.removedText);
          for (let index = 0; index < deleteCount; index += 1) {
            this.handleTerminalData('\x7f', 'capture-replacement');
          }
        }
        if (data) {
          this.handleTerminalData(data, 'capture-input');
        }
      },
      true
    );
  }

  _attachPasteListeners(on, container, options) {
    const textarea = this._textarea;
    const multipartGapMs = 40;
    const readPasteText = (event) => {
      const candidates = [
        event.clipboardData?.getData?.('text/plain'),
        event.dataTransfer?.getData?.('text/plain'),
        typeof event.data === 'string' ? event.data : '',
        textarea.value,
      ];
      return candidates.reduce(
        (longest, value) => (typeof value === 'string' && value.length > longest.length ? value : longest),
        ''
      );
    };
    const routeTextPaste = (event, source, explicitText) => {
      if (event.target !== textarea) return false;
      const sessionId = this._getSessionId();
      if (!sessionId || this._getSessionMode() === 'shell') {
        return false;
      }
      const text = explicitText ?? readPasteText(event);
      if (!text) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      this._resetHelperTextarea();
      const now = this._now();
      const duplicateInputAfterCapture =
        text === this._lastRoutedPaste &&
        now - this._lastRoutedPasteAt < 100 &&
        source.startsWith('input:') &&
        (this._lastRoutedPasteSource === 'clipboard' || this._lastRoutedPasteSource.startsWith('beforeinput:'));
      if (duplicateInputAfterCapture) return true;

      this._lastRoutedPaste = text;
      this._lastRoutedPasteAt = now;
      this._lastRoutedPasteSource = source;
      const lineBreaks = text.match(/\r\n|\r|\n/g)?.length || 0;
      this._log(`XTERM_PASTE source=${source} len=${text.length} breaks=${lineBreaks}`);
      if (this._usesLocalOverlay()) {
        this.insertText(text);
      } else {
        this.sendPaste(text);
      }
      return true;
    };
    const routeInputPasteMutation = (event, phase) => {
      if (event.target !== textarea) return;
      const inputType = event.inputType || '';
      const mutationText = typeof event.data === 'string' ? event.data : '';
      const now = this._now();
      const continuesMultipartPaste = now <= this._multipartPasteUntil;

      if (inputType === 'insertFromPaste') {
        if (routeTextPaste(event, `${phase}:paste`)) {
          this._multipartPasteCandidateUntil = 0;
          this._multipartPasteUntil = now + multipartGapMs;
        }
        return;
      }

      if (options.segmentedFallback && inputType === 'insertText' && mutationText) {
        if (!continuesMultipartPaste) {
          this._multipartPasteCandidateUntil = mutationText.length > 1 ? now + multipartGapMs : 0;
          return;
        }
        if (routeTextPaste(event, `${phase}:text`, mutationText)) {
          this._multipartPasteUntil = now + multipartGapMs;
        }
        return;
      }
      if (
        options.segmentedFallback &&
        (continuesMultipartPaste || now <= this._multipartPasteCandidateUntil) &&
        (inputType === 'insertLineBreak' || inputType === 'insertParagraph')
      ) {
        if (routeTextPaste(event, `${phase}:break`, '\n')) {
          this._multipartPasteCandidateUntil = 0;
          this._multipartPasteUntil = now + multipartGapMs;
        }
        return;
      }
      this._multipartPasteCandidateUntil = 0;
    };

    on(
      container,
      'paste',
      (event) => {
        routeTextPaste(event, 'clipboard');
      },
      true
    );
    on(
      container,
      'beforeinput',
      (event) => {
        routeInputPasteMutation(event, 'beforeinput');
      },
      true
    );
    on(
      container,
      'input',
      (event) => {
        routeInputPasteMutation(event, 'input');
      },
      true
    );
  }

  _captureHelperMutationSnapshot() {
    const value = this._textarea?.value || '';
    const start = this._textarea?.selectionStart ?? value.length;
    return {
      value,
      start,
      end: this._textarea?.selectionEnd ?? this._textarea?.selectionStart ?? value.length,
    };
  }

  _deriveTextareaMutation(snapshot, currentValue) {
    const current = String(currentValue ?? '');
    if (!snapshot) {
      return {
        insertedText: current,
        removedText: '',
      };
    }
    const previous = String(snapshot.value ?? '');
    const start = Math.max(0, Math.min(previous.length, snapshot.start ?? previous.length));
    const end = Math.max(start, Math.min(previous.length, snapshot.end ?? start));
    const prefix = previous.slice(0, start);
    const suffix = previous.slice(end);
    if (current.startsWith(prefix) && current.endsWith(suffix) && current.length >= prefix.length + suffix.length) {
      return {
        insertedText: current.slice(prefix.length, current.length - suffix.length),
        removedText: previous.slice(start, end),
      };
    }

    let commonPrefix = 0;
    while (
      commonPrefix < previous.length &&
      commonPrefix < current.length &&
      previous[commonPrefix] === current[commonPrefix]
    ) {
      commonPrefix += 1;
    }
    let commonSuffix = 0;
    while (
      commonSuffix < previous.length - commonPrefix &&
      commonSuffix < current.length - commonPrefix &&
      previous[previous.length - 1 - commonSuffix] === current[current.length - 1 - commonSuffix]
    ) {
      commonSuffix += 1;
    }
    return {
      insertedText: current.slice(commonPrefix, current.length - commonSuffix),
      removedText: previous.slice(commonPrefix, previous.length - commonSuffix),
    };
  }

  _handleLocalEchoData(data, isCompositionText, source, sessionId) {
    const overlay = this._getOverlay();

    if (this._isInteractionPrompt(sessionId) && data !== '\x7f' && data.charCodeAt(0) < 32) {
      this._deliver(sessionId, data);
      this._onInteractionControl(sessionId, data);
      this._resetHelperTextarea();
      return true;
    }

    if (this._compositionPending && isCompositionText) {
      const expectedCommit = this._expectedCommit;
      const hasStaleHelperPrefix =
        expectedCommit && data.length > expectedCommit.length && data.endsWith(expectedCommit);
      const finalText = hasStaleHelperPrefix ? expectedCommit : data;
      if (hasStaleHelperPrefix) {
        this._trace('composition-strip-stale-prefix', {
          payloadLen: data.length,
          finalLen: finalText.length,
        });
      }
      this._trace('composition-accept', {
        source,
        len: finalText.length,
      });
      this._acceptComposition(finalText);
      return true;
    }

    if (data === '\x7f') {
      const removedFrom = overlay?.removeChar?.();
      if (removedFrom !== 'pending') {
        this._deliver(sessionId, data);
      }
      this._captureDraft();
      return true;
    }

    if (/^[\r\n]+$/.test(data)) {
      const text = overlay?.pendingText || '';
      if (text) {
        const lineBreaks = text.match(/\r\n|\r|\n/g)?.length || 0;
        this._log(`LOCAL_ECHO_SUBMIT len=${text.length} breaks=${lineBreaks}`);
      }
      overlay?.clear?.();
      overlay?.suppressBufferDetection?.();
      this._clearDraft(sessionId);
      this.clearDeliveryBuffer();
      if (text) this._deliverDraftText(sessionId, text);
      this._deliver(sessionId, '\r');
      this._resetHelperTextarea();
      return true;
    }

    if (data.length > 1 && data.charCodeAt(0) >= 32) {
      overlay?.appendText?.(data);
      this._captureDraft();
      return true;
    }

    if (data.charCodeAt(0) < 32) {
      if (data.length > 1 && data.charCodeAt(0) === 27) {
        this._handoffOverlayToPty(sessionId, overlay);
        this._deliver(sessionId, data);
        return true;
      }
      if (this._isRestoringDraft()) {
        this._deliver(sessionId, data);
        return true;
      }
      if (data === '\t' && this._onTab) {
        const text = overlay?.pendingText || '';
        const flushed = overlay?.getFlushed?.() || { count: 0, text: '' };
        const flushedText = flushed.text + text;
        const handled =
          this._onTab({
            controller: this,
            overlay,
            sessionId,
            text,
            flushedText,
          }) !== false;
        if (handled) {
          this._tabCompletionPending = true;
          overlay?.clear?.();
          if (flushedText) {
            overlay?.setFlushed?.(flushedText.length, flushedText);
            this._setDraft(sessionId, {
              pendingText: '',
              flushedText,
              cjkText: '',
              updatedAt: Date.now(),
            });
          } else {
            this._clearDraft(sessionId);
          }
          overlay?.suppressBufferDetection?.();
          if (text) this._deliverDraftText(sessionId, text);
          this._deliver(sessionId, data);
          this._resetHelperTextarea();
        }
        return handled;
      }
      if (data === '\x1b') {
        this._deliver(sessionId, data);
        this._resetHelperTextarea();
        return true;
      }
      const text = overlay?.pendingText || '';
      this._handoffOverlayToPty(sessionId, overlay);
      if (text) this._trace('pty-editing-handoff', { reason: 'control', len: text.length });
      this._deliver(sessionId, data);
      this._finishPtyEditingIfNeeded(sessionId, data);
      this._resetHelperTextarea();
      return true;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      overlay?.addChar?.(data);
      this._captureDraft();
      return true;
    }

    return false;
  }

  _usesLocalOverlay(sessionId = this._getSessionId()) {
    return !!this._isLocalEchoEnabled() && !this._isPtyEditing(sessionId);
  }

  _isPtyEditing(sessionId) {
    return !!sessionId && this._ptyEditingSessionIds.has(sessionId);
  }

  _deliverDraftText(sessionId, text, options = {}) {
    const rawText = String(text || '');
    if (!sessionId || !rawText) return;
    const shouldFrame = /[\r\n]/.test(rawText) && this._getSessionMode() !== 'shell';
    const input = shouldFrame ? this._preparePaste(rawText, true) : rawText;
    const deliveryOptions = { ...options };
    if (shouldFrame) deliveryOptions.useMux = false;
    if (Object.prototype.hasOwnProperty.call(deliveryOptions, 'useMux')) {
      this._deliver(sessionId, input, deliveryOptions);
    } else {
      this._deliver(sessionId, input);
    }
  }

  _handoffOverlayToPty(sessionId, overlay = this._getOverlay()) {
    if (!sessionId) return;
    const text = overlay?.pendingText || '';
    if (text) this._deliverDraftText(sessionId, text);
    overlay?.clear?.();
    overlay?.suppressBufferDetection?.();
    this._setDraft(sessionId, {
      pendingText: '',
      flushedText: '',
      cjkText: '',
      ptyOwned: true,
      updatedAt: Date.now(),
    });
    this._ptyEditingSessionIds.add(sessionId);
    this._resetHelperTextarea();
  }

  _finishPtyEditingIfNeeded(sessionId, data) {
    if (!this._isPtyEditing(sessionId)) return;
    if (/^[\r\n]+$/.test(data) || data === '\x03' || data === '\x15') {
      this._ptyEditingSessionIds.delete(sessionId);
      this._clearDraft(sessionId);
    }
  }

  resolveTabCompletion() {
    this._tabCompletionPending = false;
  }

  _cancelTabCompletionTracking(handoffToPty = true) {
    if (!this._tabCompletionPending) return;
    this._tabCompletionPending = false;
    if (handoffToPty) {
      const sessionId = this._getSessionId();
      if (this._usesLocalOverlay(sessionId)) {
        this._handoffOverlayToPty(sessionId);
      }
    }
    this._onTabCancel();
  }

  _registerKeydownEchoCandidate(event) {
    const sessionId = this._getSessionId();
    if (!sessionId) return;
    let data = '';
    if (event.key === 'Backspace') {
      data = '\x7f';
    } else if (
      typeof event.key === 'string' &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      data = event.key;
    }
    if (!data) return;
    this._keydownEchoTokens.push({
      sessionId,
      data,
      delivered: false,
    });
    if (this._keydownEchoTokens.length > 32) {
      this._keydownEchoTokens.splice(0, this._keydownEchoTokens.length - 32);
    }
  }

  _markKeydownEchoDelivered(sessionId, data) {
    const token = this._keydownEchoTokens.find(
      (candidate) => !candidate.delivered && candidate.sessionId === sessionId && candidate.data === data
    );
    if (token) token.delivered = true;
  }

  _consumeKeydownEcho(sessionId, data) {
    const index = this._keydownEchoTokens.findIndex(
      (candidate) => candidate.sessionId === sessionId && candidate.data === data
    );
    if (index < 0) {
      this._keydownEchoTokens = [];
      return false;
    }
    const [token] = this._keydownEchoTokens.splice(index, 1);
    return token.delivered;
  }

  _queueNormalDelivery(data, sessionId) {
    if (this._pendingDeliverySessionId && this._pendingDeliverySessionId !== sessionId) {
      this._flushDelivery();
    }
    this._pendingDeliverySessionId = sessionId;
    this._pendingDelivery += data;

    if (data.charCodeAt(0) < 32 || data.length > 1) {
      this._cancelDeliveryFlush();
      this._flushDelivery();
      return;
    }

    const now = this._now();
    if (now - this._lastKeystrokeTime > 50) {
      this._cancelDeliveryFlush();
      this._lastKeystrokeTime = now;
      this._flushDelivery();
      return;
    }

    this._lastKeystrokeTime = now;
    if (this._deliveryFlushTimer === null) {
      this._deliveryFlushTimer = this._setTimer(() => {
        this._deliveryFlushTimer = null;
        this._flushDelivery();
      }, 0);
    }
  }

  _flushDelivery() {
    if (!this._pendingDelivery) return;
    const sessionId = this._pendingDeliverySessionId || this._getSessionId();
    const data = this._pendingDelivery;
    this._pendingDelivery = '';
    this._pendingDeliverySessionId = null;
    if (sessionId) this._deliver(sessionId, data);
  }

  _cancelDeliveryFlush() {
    if (this._deliveryFlushTimer === null) return;
    this._clearTimer(this._deliveryFlushTimer);
    this._deliveryFlushTimer = null;
  }

  _acceptComposition(finalText) {
    this._compositionPending = false;
    this._expectedCommit = null;
    this._clearCompositionTimer();
    this._getOverlay()?.commitComposition?.(finalText);
    this._resetHelperTextarea();
    this._captureDraft();
    this._rememberCompositionDelivery(finalText);
  }

  _rememberCompositionDelivery(finalText) {
    this._fallbackCommit = finalText;
    this._fallbackSessionId = this._getSessionId();
    this._fallbackCommitEpoch = this._compositionEpoch;
    this._fallbackCommitExpiresAt = this._now() + this._commitReplayWindowMs;
  }

  _expireCompositionDelivery() {
    if (this._fallbackCommit === null) return;
    if (this._fallbackCommitEpoch !== this._compositionEpoch || this._now() > this._fallbackCommitExpiresAt) {
      this.clearCompositionDelivery();
    }
  }

  _resetHelperTextarea() {
    if (!this._textarea) return;
    if (this._textarea.value !== '') {
      this._textarea.value = '';
    }
    try {
      this._textarea.setSelectionRange?.(0, 0);
    } catch {
      /* hidden textarea may be detached during terminal teardown */
    }
  }

  _clearCompositionTimer() {
    if (this._compositionCommitTimer === null) return;
    this._clearTimer(this._compositionCommitTimer);
    this._compositionCommitTimer = null;
  }

  _clearMobileLineBreakTimer() {
    if (this._mobileLineBreakFallbackTimer === null) {
      return;
    }
    this._clearTimer(this._mobileLineBreakFallbackTimer);
    this._mobileLineBreakFallbackTimer = null;
  }

  _resetCompositionState() {
    this._compositionActive = false;
    this._compositionPending = false;
    this._expectedCommit = null;
    this.clearCompositionDelivery();
    this._clearCompositionTimer();
    this._clearMobileLineBreakTimer();
    this._mobileLineBreakPending = false;
    this._compositionInputCommittedEpoch = -1;
    this._ignoredCompositionEndEpoch = -1;
    this._helperMutationSnapshot = null;
    this._keydownEchoTokens = [];
    this._lastMobileEnterKeydownAt = -Infinity;
    this._compositionEpoch += 1;
    this._getOverlay()?.clearComposition?.();
  }

  _classifyData(data) {
    const firstCode = data.charCodeAt(0);
    if (data.length === 1) {
      if (firstCode === 127) return 'delete';
      if (firstCode < 32) return 'control';
      if (/\s/.test(data)) return 'boundary';
      return 'printable';
    }
    return firstCode === 27 ? 'escape' : 'text';
  }
}

globalThis.TerminalInputController = TerminalInputController;
