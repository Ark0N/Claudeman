/**
 * @fileoverview Pure single-line editor behind the TUI's prompt composer (`p`)
 * and search query (`/`).
 *
 * Text is held as CODE POINTS rather than a string, because every operation
 * here is index-based and a cursor that can land inside a surrogate pair
 * eventually deletes half an emoji. Combining marks are their own entries: they
 * are zero-width, so they neither move the cursor's column nor cost a cell, and
 * backspace peeling one off a base letter is what a terminal editor does.
 *
 * Scrolling is derived, never remembered implicitly: `composerScroll()` takes
 * the width and returns the state whose window holds the cursor, which is what
 * keeps "what the footer shows" a function of the state plus the terminal width
 * rather than of the order the user pressed keys in.
 *
 * PURE: no IO, no timers, no `process.*`. Enter and Escape are reported as
 * `submit`/`cancel` rather than acted on, since only the caller knows whether
 * Enter means "send this prompt" or "open the highlighted search result".
 *
 * @module tui/tui-composer
 */

import { charWidth } from './tui-ansi.js';
import type { TuiInputEvent } from './tui-keys.js';

export interface TuiComposerState {
  /** Code points. `chars.join('')` is the text. */
  readonly chars: readonly string[];
  /** 0..chars.length. The cursor sits BEFORE `chars[cursor]`. */
  readonly cursor: number;
  /** First visible code point, as `composerScroll()` last resolved it. */
  readonly scroll: number;
}

export function createComposer(text = ''): TuiComposerState {
  const chars = [...text];
  return { chars, cursor: chars.length, scroll: 0 };
}

export function composerText(state: TuiComposerState): string {
  return state.chars.join('');
}

function withChars(chars: readonly string[], cursor: number, scroll: number): TuiComposerState {
  const clampedCursor = Math.min(Math.max(0, cursor), chars.length);
  return { chars, cursor: clampedCursor, scroll: Math.min(Math.max(0, scroll), chars.length) };
}

/** Insert typed text at the cursor. Newlines are stripped: this is one line. */
export function composerInsert(state: TuiComposerState, value: string): TuiComposerState {
  const inserted = [...value.replace(/[\r\n]+/g, ' ')];
  if (inserted.length === 0) return state;
  const chars = [...state.chars.slice(0, state.cursor), ...inserted, ...state.chars.slice(state.cursor)];
  return withChars(chars, state.cursor + inserted.length, state.scroll);
}

/** Delete the code point before the cursor. */
export function composerBackspace(state: TuiComposerState): TuiComposerState {
  if (state.cursor === 0) return state;
  const chars = [...state.chars.slice(0, state.cursor - 1), ...state.chars.slice(state.cursor)];
  return withChars(chars, state.cursor - 1, state.scroll);
}

/** Delete the code point under the cursor (the Delete key). */
export function composerDelete(state: TuiComposerState): TuiComposerState {
  if (state.cursor >= state.chars.length) return state;
  const chars = [...state.chars.slice(0, state.cursor), ...state.chars.slice(state.cursor + 1)];
  return withChars(chars, state.cursor, state.scroll);
}

/** Delete back to the start of the word before the cursor (Ctrl+W). */
export function composerDeleteWord(state: TuiComposerState): TuiComposerState {
  let start = state.cursor;
  while (start > 0 && state.chars[start - 1] === ' ') start--;
  while (start > 0 && state.chars[start - 1] !== ' ') start--;
  if (start === state.cursor) return state;
  const chars = [...state.chars.slice(0, start), ...state.chars.slice(state.cursor)];
  return withChars(chars, start, state.scroll);
}

export function composerMove(state: TuiComposerState, delta: number): TuiComposerState {
  const cursor = Math.min(Math.max(0, state.cursor + Math.trunc(delta)), state.chars.length);
  return cursor === state.cursor ? state : withChars(state.chars, cursor, state.scroll);
}

export function composerHome(state: TuiComposerState): TuiComposerState {
  return state.cursor === 0 ? state : withChars(state.chars, 0, state.scroll);
}

export function composerEnd(state: TuiComposerState): TuiComposerState {
  return state.cursor === state.chars.length ? state : withChars(state.chars, state.chars.length, state.scroll);
}

export function composerClear(state: TuiComposerState): TuiComposerState {
  return state.chars.length === 0 ? state : { chars: [], cursor: 0, scroll: 0 };
}

/** Display columns of `chars[from..to)`. */
function widthOf(chars: readonly string[], from: number, to: number): number {
  let width = 0;
  for (let i = from; i < to; i++) width += charWidth(chars[i].codePointAt(0) ?? 0);
  return width;
}

/**
 * Resolve `scroll` so the cursor is inside a window `width` columns wide,
 * scrolling the minimum needed. One column is reserved for the cursor itself,
 * so a cursor at the end of the text still has a cell to sit in instead of
 * hanging one past the edge where the terminal would wrap it.
 */
export function composerScroll(state: TuiComposerState, width: number): TuiComposerState {
  const usable = Math.max(0, Math.trunc(width) - 1);
  let scroll = Math.min(Math.max(0, state.scroll), state.cursor);
  while (scroll < state.cursor && widthOf(state.chars, scroll, state.cursor) > usable) scroll++;
  return scroll === state.scroll ? state : { chars: state.chars, cursor: state.cursor, scroll };
}

export interface TuiComposerWindow {
  /** The visible slice of the text. */
  text: string;
  /** Cursor offset in display columns from the start of `text`. */
  cursorColumn: number;
  /** Resolved first visible code point (may differ from `state.scroll`). */
  scroll: number;
}

/**
 * The slice the footer draws plus where the terminal cursor belongs. The scroll
 * is resolved here too, so a renderer that never writes state back still shows
 * the cursor.
 */
export function composerWindow(state: TuiComposerState, width: number): TuiComposerWindow {
  const columns = Math.max(1, Math.trunc(width));
  const scrolled = composerScroll(state, columns);
  const { chars, cursor, scroll } = scrolled;
  let used = 0;
  let end = scroll;
  while (end < chars.length) {
    const next = charWidth(chars[end].codePointAt(0) ?? 0);
    if (used + next > columns) break;
    used += next;
    end++;
  }
  return {
    text: chars.slice(scroll, Math.max(end, cursor)).join(''),
    cursorColumn: widthOf(chars, scroll, cursor),
    scroll,
  };
}

export type TuiComposerStep =
  | { kind: 'edit'; state: TuiComposerState }
  | { kind: 'submit'; text: string }
  | { kind: 'cancel' }
  | { kind: 'ignore' };

/**
 * One keystroke. Enter and Escape are REPORTED rather than applied: `p` sends
 * the line while `/` opens the highlighted result, and only the caller knows
 * which.
 */
export function composerStep(state: TuiComposerState, event: TuiInputEvent): TuiComposerStep {
  switch (event.type) {
    case 'char':
      return { kind: 'edit', state: composerInsert(state, event.value) };
    case 'backspace':
      return { kind: 'edit', state: composerBackspace(state) };
    case 'enter':
      return { kind: 'submit', text: composerText(state) };
    case 'escape':
      return { kind: 'cancel' };
    case 'key':
      switch (event.name) {
        case 'left':
          return { kind: 'edit', state: composerMove(state, -1) };
        case 'right':
          return { kind: 'edit', state: composerMove(state, 1) };
        case 'home':
          return { kind: 'edit', state: composerHome(state) };
        case 'end':
          return { kind: 'edit', state: composerEnd(state) };
        case 'delete':
          return { kind: 'edit', state: composerDelete(state) };
        default:
          return { kind: 'ignore' };
      }
    case 'ctrl':
      switch (event.key) {
        case 'c':
          return { kind: 'cancel' };
        case 'a':
          return { kind: 'edit', state: composerHome(state) };
        case 'e':
          return { kind: 'edit', state: composerEnd(state) };
        case 'u':
          return { kind: 'edit', state: composerClear(state) };
        case 'w':
          return { kind: 'edit', state: composerDeleteWord(state) };
        default:
          return { kind: 'ignore' };
      }
    default:
      return { kind: 'ignore' };
  }
}
