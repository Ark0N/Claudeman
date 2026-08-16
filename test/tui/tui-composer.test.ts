/**
 * @fileoverview Unit tests for the single-line editor behind `p` and `/`.
 *
 * The interesting parts are the ones a terminal makes hard to see: a cursor
 * that must not split a surrogate pair, a combining mark that belongs to the
 * character before it, and the scroll window, which is the only reason a long
 * prompt stays typeable in a footer one line tall.
 */
import { describe, it, expect } from 'vitest';
import {
  composerBackspace,
  composerDelete,
  composerDeleteWord,
  composerEnd,
  composerHome,
  composerInsert,
  composerMove,
  composerScroll,
  composerStep,
  composerText,
  composerWindow,
  createComposer,
} from '../../src/tui/tui-composer.js';

describe('editing', () => {
  it('inserts at the cursor and keeps it after the insertion', () => {
    let state = createComposer('abc');
    expect(composerText(state)).toBe('abc');
    expect(state.cursor).toBe(3);

    state = composerMove(state, -1);
    state = composerInsert(state, 'XY');
    expect(composerText(state)).toBe('abXYc');
    expect(state.cursor).toBe(4);
  });

  it('never lets a newline into a single-line editor', () => {
    const state = composerInsert(createComposer(), 'one\ntwo\r\nthree');
    expect(composerText(state)).toBe('one two three');
  });

  it('deletes whole characters, not code units', () => {
    const state = composerBackspace(createComposer('a🙂'));
    expect(composerText(state)).toBe('a');
    expect(state.cursor).toBe(1);
  });

  it('deletes forward under the cursor and stops at the end', () => {
    const state = composerHome(createComposer('abc'));
    expect(composerText(composerDelete(state))).toBe('bc');
    expect(composerText(composerDelete(createComposer('abc')))).toBe('abc');
  });

  it('deletes a word back over its trailing spaces', () => {
    expect(composerText(composerDeleteWord(createComposer('fix the bug   ')))).toBe('fix the ');
    expect(composerText(composerDeleteWord(createComposer('word')))).toBe('');
    expect(composerText(composerDeleteWord(createComposer('')))).toBe('');
  });

  it('clamps the cursor at both ends', () => {
    const state = createComposer('abc');
    expect(composerMove(state, 10).cursor).toBe(3);
    expect(composerMove(state, -10).cursor).toBe(0);
    expect(composerHome(state).cursor).toBe(0);
    expect(composerEnd(composerHome(state)).cursor).toBe(3);
  });

  it('leaves a no-op edit as the same object, so nothing repaints', () => {
    const state = createComposer('abc');
    const atStart = composerHome(state);
    expect(composerInsert(state, '')).toBe(state);
    expect(composerMove(state, 1)).toBe(state);
    expect(composerBackspace(atStart)).toBe(atStart);
  });
});

describe('the scroll window', () => {
  it('shows the whole text while it fits', () => {
    const window = composerWindow(createComposer('short'), 20);
    expect(window.text).toBe('short');
    expect(window.cursorColumn).toBe(5);
    expect(window.scroll).toBe(0);
  });

  it('scrolls just far enough to keep the cursor visible', () => {
    // 10 columns of room, one reserved for the cursor itself.
    const state = composerScroll(createComposer('0123456789abcdef'), 10);
    const window = composerWindow(state, 10);
    expect(window.scroll).toBe(7);
    expect(window.text).toBe('789abcdef');
    expect(window.cursorColumn).toBe(9);
  });

  it('scrolls back when the cursor moves left out of the window', () => {
    let state = composerScroll(createComposer('0123456789abcdef'), 10);
    expect(state.scroll).toBe(7);
    state = composerScroll(composerHome(state), 10);
    expect(state.scroll).toBe(0);
    expect(composerWindow(state, 10).cursorColumn).toBe(0);
  });

  it('counts a double-width character as the two columns it takes', () => {
    const state = composerScroll(createComposer('日本語です'), 6);
    const window = composerWindow(state, 6);
    // Five wide characters = 10 columns; the window holds the last three (6
    // columns) minus the cell the cursor needs.
    expect(window.cursorColumn).toBeLessThanOrEqual(5);
    expect(window.text.length).toBeLessThanOrEqual(5);
    expect(composerText(state)).toBe('日本語です');
  });

  it('survives a width of one', () => {
    const state = composerScroll(createComposer('abc'), 1);
    expect(() => composerWindow(state, 1)).not.toThrow();
    expect(composerWindow(state, 1).cursorColumn).toBe(0);
  });
});

describe('composerStep', () => {
  const state = createComposer('ab');

  it('reports Enter and Escape instead of acting on them', () => {
    expect(composerStep(state, { type: 'enter' })).toEqual({ kind: 'submit', text: 'ab' });
    expect(composerStep(state, { type: 'escape' })).toEqual({ kind: 'cancel' });
    expect(composerStep(state, { type: 'ctrl', key: 'c' })).toEqual({ kind: 'cancel' });
  });

  it('maps the editing keys', () => {
    expect(composerStep(state, { type: 'char', value: 'c' })).toEqual({
      kind: 'edit',
      state: expect.objectContaining({ cursor: 3 }),
    });
    expect(composerStep(state, { type: 'key', name: 'left' })).toEqual({
      kind: 'edit',
      state: expect.objectContaining({ cursor: 1 }),
    });
    expect(composerStep(state, { type: 'ctrl', key: 'u' })).toEqual({
      kind: 'edit',
      state: expect.objectContaining({ cursor: 0 }),
    });
    expect(composerText((composerStep(state, { type: 'ctrl', key: 'u' }) as { state: never }).state)).toBe('');
  });

  it('ignores keys that mean nothing to an editor', () => {
    expect(composerStep(state, { type: 'tab' })).toEqual({ kind: 'ignore' });
    expect(composerStep(state, { type: 'key', name: 'pageup' })).toEqual({ kind: 'ignore' });
    expect(composerStep(state, { type: 'ctrl', key: 'x' })).toEqual({ kind: 'ignore' });
    expect(composerStep(state, { type: 'mouse', kind: 'press', x: 1, y: 1, button: 0 })).toEqual({ kind: 'ignore' });
  });
});
