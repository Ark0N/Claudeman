import type {
  XtermTerminal,
  XtermAddon,
  ZerolagInputDraftState,
  ZerolagInputOptions,
  ZerolagInputState,
  PromptPosition,
  PromptFinder,
  FontStyle,
} from './types.js';
import { getCellDimensions } from './cell-dimensions.js';
import { findPrompt, readTextAfterPrompt } from './prompt-finder.js';
import { renderOverlay, charCellWidth } from './overlay-renderer.js';

const DEFAULT_PROMPT: PromptFinder = { type: 'character', char: '>', offset: 2 };
const DEFAULT_Z_INDEX = 7;
const DEFAULT_SCROLL_DEBOUNCE_MS = 50;
const DEFAULT_BG = '#0d0d0d';
const DEFAULT_FG = '#eeeeee';
const DEFAULT_CURSOR = '#e0e0e0';
const GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

interface InputLayoutLine {
  text: string;
  startOffset: number;
  endOffset: number;
}

function removeLastInputUnit(text: string): string {
  if (!text) return '';
  if (text.endsWith('\r\n')) return text.slice(0, -2);

  if (GRAPHEME_SEGMENTER) {
    const lastSegment = GRAPHEME_SEGMENTER.segment(text).containing(text.length - 1);
    return text.slice(0, lastSegment?.index ?? 0);
  }

  const last = text.charCodeAt(text.length - 1);
  const removesSurrogatePair =
    last >= 0xdc00 &&
    last <= 0xdfff &&
    text.length > 1 &&
    text.charCodeAt(text.length - 2) >= 0xd800 &&
    text.charCodeAt(text.length - 2) <= 0xdbff;
  return text.slice(0, removesSurrogatePair ? -2 : -1);
}

/**
 * xterm.js addon that provides instant keystroke feedback via a DOM overlay.
 *
 * Eliminates perceived input latency over high-RTT connections (SSH, remote
 * terminals, mobile) by rendering typed characters immediately as a DOM
 * overlay, without waiting for the PTY round-trip.
 *
 * The addon does NOT hook `terminal.onData` — the consumer wires their
 * own input handler and calls `addChar()`, `removeChar()`, `clear()`, etc.
 *
 * Compatible with both `xterm` (pre-5.4) and `@xterm/xterm` (5.4+).
 *
 * @example
 * ```typescript
 * import { Terminal } from '@xterm/xterm';
 * import { ZerolagInputAddon } from 'xterm-zerolag-input';
 *
 * const terminal = new Terminal();
 * const zerolag = new ZerolagInputAddon({
 *   prompt: { type: 'character', char: '$', offset: 2 },
 * });
 * terminal.open(document.getElementById('terminal')!);
 * terminal.loadAddon(zerolag);
 *
 * terminal.onData((data) => {
 *   if (data === '\r') {
 *     const text = zerolag.pendingText;
 *     zerolag.clear();
 *     ws.send(text + '\r');
 *   } else if (data === '\x7f') {
 *     const source = zerolag.removeChar();
 *     if (source !== 'pending') ws.send(data); // let the PTY handle text not owned locally
 *   } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
 *     zerolag.addChar(data);
 *   }
 * });
 * ```
 */
export class ZerolagInputAddon implements XtermAddon {
  private _terminal: XtermTerminal | null = null;
  private _overlay: HTMLDivElement | null = null;
  private _options: Required<Pick<ZerolagInputOptions, 'zIndex' | 'showCursor' | 'scrollDebounceMs'>> &
    ZerolagInputOptions;

  // Text state
  private _pendingText = '';
  private _compositionText = '';
  private _flushedOffset = 0;
  private _flushedText = '';
  private _bufferDetectDone = false;

  // Render cache
  private _lastRenderKey = '';
  private _lastPromptPos: PromptPosition | null = null;
  private _layoutLines: InputLayoutLine[] = [];
  private _layoutDirtyOffset: number | null = 0;
  private _layoutTextLength = 0;
  private _layoutStartCol = -1;
  private _layoutCols = -1;
  private _layoutRevision = 0;
  private _fallbackFlushedText: string | null = null;

  // Font cache
  private _font: FontStyle = {
    fontFamily: 'monospace',
    fontSize: '14px',
    fontWeight: 'normal',
    color: DEFAULT_FG,
    backgroundColor: DEFAULT_BG,
    letterSpacing: '',
  };

  // Scroll handling
  private _scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private _scrollHandler: (() => void) | null = null;
  private _scrollViewport: Element | null = null;
  private _viewportPinned = false;

  constructor(options?: ZerolagInputOptions) {
    this._options = {
      prompt: options?.prompt ?? DEFAULT_PROMPT,
      zIndex: options?.zIndex ?? DEFAULT_Z_INDEX,
      showCursor: options?.showCursor ?? true,
      scrollDebounceMs: options?.scrollDebounceMs ?? DEFAULT_SCROLL_DEBOUNCE_MS,
      backgroundColor: options?.backgroundColor,
      foregroundColor: options?.foregroundColor,
      cursorColor: options?.cursorColor,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /**
   * Called by `terminal.loadAddon()`. Do not call directly.
   */
  activate(terminal: XtermTerminal): void {
    this._terminal = terminal;

    // Create overlay container
    this._overlay = document.createElement('div');
    this._overlay.style.cssText = `position:absolute;z-index:${this._options.zIndex};pointer-events:none;display:none`;

    // Insert into xterm DOM
    const screen = terminal.element?.querySelector('.xterm-screen');
    if (screen) {
      screen.appendChild(this._overlay);
    }

    // Cache font properties
    this._cacheFont();

    // Scroll detection: hide overlay when scrolled away from bottom
    this._scrollHandler = () => {
      try {
        const buf = this._terminal!.buffer.active;
        if (buf.viewportY !== buf.baseY && !this._viewportPinned) {
          this._overlay!.style.display = 'none';
          if (this._scrollTimer) {
            clearTimeout(this._scrollTimer);
            this._scrollTimer = null;
          }
        } else if (this._pendingText || this._compositionText || this._flushedOffset > 0) {
          if (this._scrollTimer) clearTimeout(this._scrollTimer);
          this._scrollTimer = setTimeout(() => {
            this._scrollTimer = null;
            this._lastRenderKey = '';
            this._render();
          }, this._options.scrollDebounceMs);
        }
      } catch {
        /* ignore */
      }
    };

    const viewport = terminal.element?.querySelector('.xterm-viewport');
    if (viewport) {
      viewport.addEventListener('scroll', this._scrollHandler, { passive: true });
      this._scrollViewport = viewport;
    }
  }

  /**
   * Remove the overlay, clean up listeners.
   */
  dispose(): void {
    this.clear();
    if (this._scrollTimer) {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = null;
    }
    if (this._scrollViewport && this._scrollHandler) {
      this._scrollViewport.removeEventListener('scroll', this._scrollHandler);
    }
    this._overlay?.remove();
    this._overlay = null;
    this._scrollViewport = null;
    this._scrollHandler = null;
    this._terminal = null;
  }

  // ─── Input methods ────────────────────────────────────────────────

  /**
   * Add a single printable character to the overlay.
   * Call this when the user types a character (charCode >= 32, length === 1).
   */
  addChar(char: string): void {
    this._markLayoutDirty(this._pendingDisplayOffset() + this._pendingText.length);
    this._pendingText += char;
    this._render();
  }

  /**
   * Append multiple characters at once (e.g., paste).
   */
  appendText(text: string): void {
    if (!text) return;
    this._markLayoutDirty(this._pendingDisplayOffset() + this._pendingText.length);
    this._pendingText += text;
    this._render();
  }

  /**
   * Replace the transient IME candidate shown after committed pending text.
   * Candidate updates are replacements, not appends: mobile keyboards rewrite
   * the whole composing word as suggestions change.
   */
  setCompositionText(text: string): void {
    this._markLayoutDirty(this._pendingDisplayOffset() + this._pendingText.length);
    this._compositionText = text;
    if (text || this._pendingText || this._flushedOffset > 0) {
      this._render();
    } else {
      this._hide();
    }
  }

  /**
   * Atomically replace the transient IME candidate with finalized input.
   */
  commitComposition(text: string): void {
    this._markLayoutDirty(this._pendingDisplayOffset() + this._pendingText.length);
    this._compositionText = '';
    if (text) this._pendingText += text;
    if (this._pendingText || this._flushedOffset > 0) {
      this._render();
    } else {
      this._hide();
    }
  }

  /** Remove an unfinished IME candidate without changing committed input. */
  clearComposition(): void {
    this.commitComposition('');
  }

  /**
   * Remove the last character from the overlay.
   *
   * Cascade order:
   * 1. Remove from transient composition if non-empty → returns `'pending'`
   * 2. Remove from `pendingText` if non-empty → returns `'pending'`
   * 3. Decrement `flushedOffset` if pending is empty but flushed exists → returns `'flushed'`
   *
   * @returns The source of the removed character, or `false` if nothing to remove.
   *
   * - `'pending'`: A user-visible input unit was removed from unsent or
   *   composing text. The consumer should NOT send backspace to the PTY.
   * - `'flushed'`: A character was removed from text already sent to the PTY.
   *   The consumer SHOULD send backspace to the PTY.
   * - `false`: No locally tracked text was removed. The consumer decides
   *   whether the PTY may still own editable text and should receive backspace.
   */
  removeChar(): 'pending' | 'flushed' | false {
    if (this._compositionText.length > 0) {
      this._compositionText = removeLastInputUnit(this._compositionText);
      this._markLayoutDirty(this._pendingDisplayOffset() + this._pendingText.length + this._compositionText.length);
      if (this._compositionText || this._pendingText || this._flushedOffset > 0) {
        this._render();
      } else {
        this._hide();
      }
      return 'pending';
    }

    if (this._pendingText.length > 0) {
      this._pendingText = removeLastInputUnit(this._pendingText);
      this._markLayoutDirty(this._pendingDisplayOffset() + this._pendingText.length);
      if (this._pendingText.length > 0 || this._flushedOffset > 0) {
        this._render();
      } else {
        this._hide();
      }
      return 'pending';
    }

    if (this._flushedOffset > 0) {
      const nextText = removeLastInputUnit(this._flushedText);
      const removedLength = this._flushedText.length - nextText.length;
      this._flushedOffset = Math.max(0, this._flushedOffset - Math.max(1, removedLength));
      this._flushedText = nextText;
      this._markLayoutDirty(0);
      if (this._flushedOffset > 0) {
        this._render();
      } else {
        this._hide();
      }
      return 'flushed';
    }

    return false;
  }

  /**
   * Clear all overlay state (pending + flushed). Hides the overlay.
   * Call on Enter, Ctrl+C, or any action that submits/cancels input.
   */
  clear(): void {
    this._pendingText = '';
    this._compositionText = '';
    this._flushedOffset = 0;
    this._flushedText = '';
    this._bufferDetectDone = false;
    this._lastRenderKey = '';
    this._lastPromptPos = null;
    this._resetLayout();
    this._hide();
  }

  /**
   * Restore serialized editable input atomically.
   *
   * Pass `render=false` while a different session's terminal frame is still
   * visible. A later `rerender()` will locate the prompt in the current frame,
   * avoiding a stale prompt-position cache during asynchronous tab switches.
   */
  restoreDraft(draft: ZerolagInputDraftState, render = true): void {
    this._pendingText = typeof draft?.pendingText === 'string' ? draft.pendingText : '';
    this._compositionText = '';
    this._flushedText = typeof draft?.flushedText === 'string' ? draft.flushedText : '';
    this._flushedOffset = this._flushedText.length;
    this._bufferDetectDone = false;
    this._lastRenderKey = '';
    this._lastPromptPos = null;
    this._resetLayout();

    if (!render) {
      this._hide();
      return;
    }
    if (this.hasPending) {
      this._render();
    } else {
      this._hide();
    }
  }

  // ─── Flushed text tracking ────────────────────────────────────────

  /**
   * Mark characters as "flushed" — sent to PTY but echo not yet received.
   *
   * The overlay renders flushed text (from the stored string) with an opaque
   * background to cover the terminal's canvas text, preventing a visible
   * font mismatch between canvas and DOM rendering.
   *
   * @param count - Number of characters flushed
   * @param text - The actual flushed text (avoids reading stale terminal buffer)
   * @param render - Whether to re-render immediately (default: `true`).
   *   Pass `false` when restoring flushed state during a tab/session switch
   *   before the new buffer has loaded — rendering against a stale buffer
   *   would lock the prompt column to the wrong position. Call `rerender()`
   *   explicitly after the buffer finishes loading.
   */
  setFlushed(count: number, text: string, render = true): void {
    this._flushedOffset = count;
    this._flushedText = text;
    this._markLayoutDirty(0);
    if (render) this._render();
  }

  /**
   * Get current flushed state.
   */
  getFlushed(): { count: number; text: string } {
    return { count: this._flushedOffset, text: this._flushedText };
  }

  /**
   * Clear flushed state. Call when server echo has arrived and the terminal
   * buffer now contains the flushed text.
   */
  clearFlushed(): void {
    this._flushedOffset = 0;
    this._flushedText = '';
    this._markLayoutDirty(0);
    if (this._pendingText || this._compositionText) {
      this._render();
    } else {
      this._hide();
    }
  }

  // ─── Rendering control ────────────────────────────────────────────

  /**
   * Force a re-render of the overlay at the current prompt position.
   * Call after terminal resets, buffer reloads, or full-screen redraws
   * that move the prompt.
   */
  rerender(): void {
    if (this._pendingText || this._compositionText || this._flushedOffset > 0) {
      this._lastRenderKey = '';
      this._render();
    }
  }

  /**
   * Keep the pending draft pinned to the visible terminal rows while xterm
   * scrollback is away from the bottom. Consumers should enable this only
   * while a separate input surface (for example a phone keyboard) stays active.
   */
  setViewportPinned(pinned: boolean): void {
    const next = pinned === true;
    if (this._viewportPinned === next) return;
    this._viewportPinned = next;
    this._lastRenderKey = '';

    if (next && !this._lastPromptPos) {
      this._lastPromptPos = this.findPrompt();
    }
    if (!this._terminal || !this._overlay || !this.hasPending) return;
    const buf = this._terminal.buffer.active;
    if (!next && buf.viewportY !== buf.baseY) {
      this._overlay.style.display = 'none';
      return;
    }
    this._render();
  }

  /**
   * Re-read font properties from the terminal and re-render.
   * Call after font size changes, theme changes, etc.
   */
  refreshFont(): void {
    this._cacheFont();
    this._lastRenderKey = '';
    if (this._pendingText || this._compositionText || this._flushedOffset > 0) this._render();
  }

  // ─── Buffer detection ─────────────────────────────────────────────

  /**
   * Scan the terminal buffer for text after the prompt marker.
   * If found, sets it as flushed text in the overlay.
   *
   * Use case: Tab completion filled text on the prompt that the overlay
   * doesn't know about. Call this to sync overlay state with the buffer.
   *
   * @returns The detected text, or `null` if no prompt or no text found.
   */
  detectBufferText(): string | null {
    return this._detectBufferText();
  }

  /**
   * Reset the buffer detection guard. After `clear()`, detection is
   * automatically re-enabled. Call this manually if you need to force
   * re-detection (e.g., after a tab completion response arrives).
   */
  resetBufferDetection(): void {
    this._bufferDetectDone = false;
  }

  /**
   * Undo the last `detectBufferText()` call — clears flushed state and
   * re-enables detection.
   *
   * Use case: Tab completion detection found text that matches the
   * pre-tab baseline (no real completion happened). Call this to undo
   * the detection so it can retry on the next flush cycle.
   */
  undoDetection(): void {
    this._flushedOffset = 0;
    this._flushedText = '';
    this._bufferDetectDone = false;
    this._markLayoutDirty(0);
  }

  /**
   * Suppress buffer detection until the next `clear()` or
   * `resetBufferDetection()` call.
   *
   * Use case: When switching to a session whose buffer contains UI
   * framework text (e.g., Ink status bars) after the prompt marker,
   * `detectBufferText()` would falsely pick up that text as user input.
   * Call this after switching to prevent false detection until the user
   * actually presses Enter (which calls `clear()` and re-enables detection).
   */
  suppressBufferDetection(): void {
    this._bufferDetectDone = true;
  }

  // ─── Prompt configuration ──────────────────────────────────────────

  /**
   * Change the prompt detection strategy at runtime.
   * Call this when switching between CLI modes (e.g., Claude Code vs OpenCode)
   * that use different prompt characters.
   */
  setPrompt(finder: PromptFinder): void {
    this._options.prompt = finder;
    this._lastPromptPos = null;
    this._lastRenderKey = '';
    if (this._pendingText || this._compositionText || this._flushedOffset > 0) this._render();
  }

  // ─── Prompt utilities ─────────────────────────────────────────────

  /**
   * Find the prompt in the terminal buffer using the configured strategy.
   * @returns The position or `null` if not found.
   */
  findPrompt(): PromptPosition | null {
    if (!this._terminal) return null;
    return findPrompt(this._terminal, this._options.prompt ?? DEFAULT_PROMPT);
  }

  /**
   * Read text after the prompt marker on the prompt line.
   * Convenience method for consumers that need to snapshot prompt content.
   */
  readPromptText(): string | null {
    if (!this._terminal) return null;
    const prompt = this.findPrompt();
    if (!prompt) return null;
    const offset = this._getPromptOffset();
    const text = readTextAfterPrompt(this._terminal, prompt, offset);
    return text || null;
  }

  // ─── Public state ─────────────────────────────────────────────────

  /** Current pending (unacknowledged) text. */
  get pendingText(): string {
    return this._pendingText;
  }

  /** Current uncommitted IME candidate text. */
  get compositionText(): string {
    return this._compositionText;
  }

  /** Whether there is any overlay content (pending, composing, or flushed). */
  get hasPending(): boolean {
    return this._pendingText.length > 0 || this._compositionText.length > 0 || this._flushedOffset > 0;
  }

  /** Read-only state snapshot. */
  get state(): ZerolagInputState {
    return {
      pendingText: this._pendingText,
      compositionText: this._compositionText,
      flushedLength: this._flushedOffset,
      flushedText: this._flushedText,
      visible: this._overlay !== null && this._overlay.style.display !== 'none',
      promptPosition: this._lastPromptPos ? { ...this._lastPromptPos } : null,
    };
  }

  // ─── Private methods ──────────────────────────────────────────────

  private _getPromptOffset(): number {
    const prompt = this._options.prompt ?? DEFAULT_PROMPT;
    return prompt.offset ?? 2;
  }

  private _detectBufferText(): string | null {
    if (this._bufferDetectDone) return null;
    if (!this._terminal) return null;

    try {
      const prompt = this.findPrompt();
      if (!prompt) return null;

      const offset = this._getPromptOffset();
      const afterPrompt = readTextAfterPrompt(this._terminal, prompt, offset);

      if (afterPrompt.length > 0) {
        this._flushedOffset = afterPrompt.length;
        this._flushedText = afterPrompt;
        this._markLayoutDirty(0);
        this._lastPromptPos = prompt;
        this._bufferDetectDone = true;
        return afterPrompt;
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  private _cacheFont(): void {
    if (!this._terminal) return;

    const t = this._terminal;
    this._font.fontFamily = t.options.fontFamily || 'monospace';
    this._font.fontSize = (t.options.fontSize || 14) + 'px';
    this._font.fontWeight = String(t.options.fontWeight || 'normal');
    this._font.backgroundColor = this._options.backgroundColor ?? t.options.theme?.background ?? DEFAULT_BG;
    this._font.color = this._options.foregroundColor ?? t.options.theme?.foreground ?? DEFAULT_FG;
    this._font.letterSpacing = '';

    // Prefer computed styles from rendered rows (matches actual rendering)
    const rows = t.element?.querySelector('.xterm-rows');
    if (rows) {
      const cs = getComputedStyle(rows);
      this._font.letterSpacing = cs.letterSpacing;
      if (!this._options.foregroundColor && cs.color) {
        this._font.color = cs.color;
      }
    }
  }

  private _hide(): void {
    if (!this._overlay) return;
    this._lastRenderKey = '';
    if (!this._viewportPinned) this._lastPromptPos = null;
    this._overlay.innerHTML = '';
    this._overlay.style.display = 'none';
  }

  private _pendingDisplayOffset(): number {
    return this._flushedText.length === this._flushedOffset ? this._flushedText.length : 0;
  }

  private _markLayoutDirty(offset: number): void {
    const safeOffset = Math.max(0, offset);
    this._layoutDirtyOffset =
      this._layoutDirtyOffset === null ? safeOffset : Math.min(this._layoutDirtyOffset, safeOffset);
    this._lastRenderKey = '';
  }

  private _resetLayout(): void {
    this._layoutLines = [];
    this._layoutDirtyOffset = 0;
    this._layoutTextLength = 0;
    this._layoutStartCol = -1;
    this._layoutCols = -1;
    this._fallbackFlushedText = null;
    this._layoutRevision += 1;
  }

  private _layoutVisibleLines(
    displayText: string,
    startCol: number,
    totalCols: number,
    terminalRows: number
  ): { visibleLines: string[]; hiddenLineCount: number } {
    const firstLineCols = Math.max(1, totalCols - startCol);
    const geometryChanged = this._layoutStartCol !== startCol || this._layoutCols !== totalCols;
    let dirtyOffset = geometryChanged ? 0 : this._layoutDirtyOffset;
    if (dirtyOffset === null && this._layoutTextLength !== displayText.length) dirtyOffset = 0;
    if (dirtyOffset === null && this._layoutLines.length > 0) {
      const hiddenLineCount = Math.max(0, this._layoutLines.length - terminalRows);
      return {
        visibleLines: this._layoutLines.slice(hiddenLineCount).map((line) => line.text),
        hiddenLineCount,
      };
    }

    let reflowLineIndex = 0;
    if (!geometryChanged && this._layoutLines.length > 0 && (dirtyOffset ?? 0) > 0) {
      let low = 0;
      let high = this._layoutLines.length - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (this._layoutLines[middle].startOffset <= (dirtyOffset ?? 0)) {
          reflowLineIndex = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (reflowLineIndex > 0 && this._layoutLines[reflowLineIndex].startOffset === (dirtyOffset ?? 0)) {
        reflowLineIndex -= 1;
      }
    }

    let startOffset = this._layoutLines[reflowLineIndex]?.startOffset ?? 0;
    if (startOffset > displayText.length) {
      reflowLineIndex = 0;
      startOffset = 0;
    }
    this._layoutLines.length = reflowLineIndex;
    const lines = this._layoutLines;
    let lineStartOffset = startOffset;
    let lineText = '';
    let lineCols = 0;
    let lineCapacity = reflowLineIndex === 0 ? firstLineCols : totalCols;
    let index = startOffset;

    while (index < displayText.length) {
      const codePoint = displayText.codePointAt(index);
      if (codePoint === undefined) break;
      const char = String.fromCodePoint(codePoint);
      const charLength = char.length;

      if (char === '\r' || char === '\n') {
        index += charLength;
        if (char === '\r' && displayText[index] === '\n') index += 1;
        lines.push({ text: lineText, startOffset: lineStartOffset, endOffset: index });
        lineStartOffset = index;
        lineText = '';
        lineCols = 0;
        lineCapacity = totalCols;
        continue;
      }

      const charCols = charCellWidth(this._terminal, char);
      if (lineCols + charCols > lineCapacity && (lineText.length > 0 || lineCapacity !== totalCols)) {
        lines.push({ text: lineText, startOffset: lineStartOffset, endOffset: index });
        lineStartOffset = index;
        lineText = '';
        lineCols = 0;
        lineCapacity = totalCols;
        continue;
      }

      lineText += char;
      lineCols += charCols;
      index += charLength;
    }
    lines.push({ text: lineText, startOffset: lineStartOffset, endOffset: displayText.length });

    this._layoutLines = lines;
    this._layoutDirtyOffset = null;
    this._layoutTextLength = displayText.length;
    this._layoutStartCol = startCol;
    this._layoutCols = totalCols;
    this._layoutRevision += 1;

    const hiddenLineCount = Math.max(0, lines.length - terminalRows);
    return {
      visibleLines: lines.slice(hiddenLineCount).map((line) => line.text),
      hiddenLineCount,
    };
  }

  private _render(): void {
    if (!this._terminal || !this._overlay) return;
    if (!this._pendingText && !this._compositionText && !(this._flushedOffset > 0)) {
      this._overlay.style.display = 'none';
      return;
    }

    try {
      const buf = this._terminal.buffer.active;
      const terminalRows = Math.max(1, this._terminal.rows);
      const pinnedToScrolledViewport = this._viewportPinned && buf.viewportY !== buf.baseY;

      // Hide overlay when scrolled up — prompt is at bottom, not in viewport
      if (buf.viewportY !== buf.baseY && !pinnedToScrolledViewport) {
        this._overlay.style.display = 'none';
        return;
      }

      if (pinnedToScrolledViewport) {
        if (this._lastPromptPos) {
          this._lastPromptPos = {
            row: terminalRows - 1,
            col: this._lastPromptPos.col,
          };
        }
      } else {
        // Re-scan for prompt on every render (full-screen redraws can move it)
        const prompt = this.findPrompt();
        if (prompt) {
          // When flushed text exists, lock column to prevent jitter from
          // redraws that temporarily shift the prompt marker. Allow row changes.
          if (this._lastPromptPos && this._flushedOffset > 0) {
            this._lastPromptPos = { row: prompt.row, col: this._lastPromptPos.col };
          } else {
            this._lastPromptPos = prompt;
          }
        } else if (!this._lastPromptPos) {
          this._overlay.style.display = 'none';
          return;
        }
      }
      if (!this._lastPromptPos) {
        this._overlay.style.display = 'none';
        return;
      }
      const activePrompt = this._lastPromptPos!;

      const dims = getCellDimensions(this._terminal);
      if (!dims) {
        this._overlay.style.display = 'none';
        return;
      }

      const { width: cellW, height: cellH, charTop, charHeight } = dims;
      const totalCols = this._terminal.cols;
      const offset = this._getPromptOffset();
      const startCol = activePrompt.col + offset;

      // Build display text: flushed chars + pending chars
      let displayText = this._pendingText + this._compositionText;
      if (this._flushedOffset > 0) {
        if (this._flushedText && this._flushedText.length === this._flushedOffset) {
          if (this._fallbackFlushedText !== null) {
            this._fallbackFlushedText = null;
            this._markLayoutDirty(0);
          }
          displayText = this._flushedText + this._pendingText + this._compositionText;
        } else {
          // Fallback: read flushed chars from terminal buffer
          const absRow = buf.viewportY + activePrompt.row;
          const line = buf.getLine(absRow);
          if (line) {
            const lineText = line.translateToString(true);
            const flushedChars = lineText.slice(startCol, startCol + this._flushedOffset);
            if (this._fallbackFlushedText !== flushedChars) {
              this._fallbackFlushedText = flushedChars;
              this._markLayoutDirty(0);
            }
            displayText = flushedChars + this._pendingText + this._compositionText;
          }
        }
      }

      // Keep the newest draft row visible at the bottom of the terminal. As
      // the draft grows it expands upward; deleting rows lets it shrink back
      // toward the prompt. Drafts taller than the viewport retain their tail.
      const { visibleLines, hiddenLineCount } = this._layoutVisibleLines(
        displayText,
        startCol,
        totalCols,
        terminalRows
      );
      const visibleStartCol = hiddenLineCount > 0 ? 0 : startCol;
      const renderRow = Math.max(0, Math.min(activePrompt.row, terminalRows - visibleLines.length));

      // Skip redundant re-renders — include the resolved geometry so a
      // keyboard resize still repositions identical text.
      const renderKey = `${this._layoutRevision}:${visibleStartCol}:${renderRow}:${activePrompt.col}:${totalCols}:${terminalRows}:${cellW}:${cellH}:${charTop}:${charHeight}:${this._flushedOffset}`;
      if (renderKey === this._lastRenderKey && this._overlay.style.display !== 'none') return;
      this._lastRenderKey = renderKey;

      const cursorColor = this._options.cursorColor ?? this._terminal.options.theme?.cursor ?? DEFAULT_CURSOR;

      renderOverlay(this._overlay, {
        lines: visibleLines,
        startCol: visibleStartCol,
        totalCols,
        cellW,
        cellH,
        charTop,
        charHeight,
        promptRow: renderRow,
        font: this._font,
        showCursor: this._options.showCursor,
        cursorColor,
        terminal: this._terminal,
      });
    } catch {
      // Hide on render error but preserve pendingText —
      // next rerender() will retry when terminal is ready.
      if (this._overlay) {
        this._overlay.innerHTML = '';
        this._overlay.style.display = 'none';
      }
    }
  }
}
