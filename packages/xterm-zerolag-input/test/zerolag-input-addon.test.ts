import { describe, it, expect, afterEach } from 'vitest';
import { createMockTerminal } from './helpers.js';
import { ZerolagInputAddon } from '../src/zerolag-input-addon.js';

function setup(lines: string[] = ['$ '], promptChar = '$') {
  const mock = createMockTerminal({ buffer: { lines } });
  const addon = new ZerolagInputAddon({
    prompt: { type: 'character', char: promptChar, offset: 2 },
  });
  mock.terminal.loadAddon(addon);
  return { addon, mock };
}

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

function tracked(lines?: string[], promptChar?: string) {
  const result = setup(lines, promptChar);
  cleanups.push(() => {
    result.addon.dispose();
    result.mock.cleanup();
  });
  return result;
}

function trackedTerminal(options: Parameters<typeof createMockTerminal>[0], promptChar = '$') {
  const mock = createMockTerminal(options);
  const addon = new ZerolagInputAddon({
    prompt: { type: 'character', char: promptChar, offset: 2 },
  });
  mock.terminal.loadAddon(addon);
  cleanups.push(() => {
    addon.dispose();
    mock.cleanup();
  });
  return { addon, mock };
}

describe('ZerolagInputAddon', () => {
  describe('lifecycle', () => {
    it('creates overlay element in .xterm-screen', () => {
      const { addon, mock } = tracked();
      const screen = mock.terminal.element.querySelector('.xterm-screen');
      expect(screen!.children.length).toBeGreaterThan(0);
      const overlay = screen!.lastElementChild as HTMLDivElement;
      expect(overlay.style.zIndex).toBe('7');
      expect(overlay.style.display).toBe('none');
      addon.dispose();
    });

    it('dispose removes overlay from DOM', () => {
      const { addon, mock } = tracked();
      const screen = mock.terminal.element.querySelector('.xterm-screen')!;
      const before = screen.children.length;
      addon.dispose();
      expect(screen.children.length).toBe(before - 1);
    });
  });

  describe('addChar / pendingText', () => {
    it('adds characters to pendingText', () => {
      const { addon } = tracked();
      addon.addChar('a');
      addon.addChar('b');
      addon.addChar('c');
      expect(addon.pendingText).toBe('abc');
    });

    it('hasPending is true when text exists', () => {
      const { addon } = tracked();
      expect(addon.hasPending).toBe(false);
      addon.addChar('x');
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('appendText', () => {
    it('appends multiple characters (paste)', () => {
      const { addon } = tracked();
      addon.addChar('h');
      addon.appendText('ello');
      expect(addon.pendingText).toBe('hello');
    });

    it('ignores empty string', () => {
      const { addon } = tracked();
      addon.appendText('');
      expect(addon.pendingText).toBe('');
      expect(addon.hasPending).toBe(false);
    });

    it('renders explicit line breaks as separate terminal rows', () => {
      const { addon, mock } = tracked();

      addon.appendText('first\nsecond');

      const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
      expect(addon.pendingText).toBe('first\nsecond');
      expect(overlay.children).toHaveLength(3); // two rows and the cursor
      expect(overlay.children[0].textContent).toBe('first');
      expect(overlay.children[1].textContent).toBe('second');
    });

    it('pins a growing multiline draft to the bottom and shrinks it after delete', () => {
      const lines = Array.from({ length: 24 }, () => '');
      lines[22] = '$ ';
      const mock = createMockTerminal({
        buffer: { lines },
        cols: 20,
        rows: 24,
        cellHeight: 10,
      });
      const addon = new ZerolagInputAddon({
        prompt: { type: 'character', char: '$', offset: 2 },
      });
      mock.terminal.loadAddon(addon);
      cleanups.push(() => {
        addon.dispose();
        mock.cleanup();
      });

      addon.appendText('one\ntwo\nthree');

      const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
      expect(overlay.style.top).toBe('210px');
      expect(
        Array.from(overlay.children)
          .slice(0, 3)
          .map((element) => element.textContent)
      ).toEqual(['one', 'two', 'three']);

      for (let i = 0; i < 6; i++) addon.removeChar();

      expect(addon.pendingText).toBe('one\ntwo');
      expect(overlay.style.top).toBe('220px');
      expect(
        Array.from(overlay.children)
          .slice(0, 2)
          .map((element) => element.textContent)
      ).toEqual(['one', 'two']);
    });

    it('keeps only the visible tail when a draft exceeds the terminal height', () => {
      const lines = ['', '', '', '$ '];
      const mock = createMockTerminal({
        buffer: { lines },
        cols: 20,
        rows: 4,
        cellHeight: 10,
      });
      const addon = new ZerolagInputAddon({
        prompt: { type: 'character', char: '$', offset: 2 },
      });
      mock.terminal.loadAddon(addon);
      cleanups.push(() => {
        addon.dispose();
        mock.cleanup();
      });

      addon.appendText('a\nb\nc\nd\ne\nf');

      const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
      expect(overlay.style.top).toBe('0px');
      expect(
        Array.from(overlay.children)
          .slice(0, 4)
          .map((element) => element.textContent)
      ).toEqual(['c', 'd', 'e', 'f']);
    });

    it('reflows only the changed tail of a long draft', () => {
      const { addon } = trackedTerminal({
        buffer: { lines: ['$ '] },
        cols: 12,
        rows: 4,
      });
      addon.appendText('x'.repeat(1_000));
      const before = (
        addon as unknown as {
          _layoutLines: Array<{ text: string }>;
        }
      )._layoutLines;
      const beforeLength = before.length;
      const preserved = before.slice(0, -1);

      addon.addChar('y');

      const after = (
        addon as unknown as {
          _layoutLines: Array<{ text: string }>;
        }
      )._layoutLines;
      expect(after.length).toBeGreaterThanOrEqual(beforeLength);
      for (let index = 0; index < preserved.length; index += 1) {
        expect(after[index]).toBe(preserved[index]);
      }
    });

    it('removes a soft-wrapped tail without leaving a phantom row', () => {
      const { addon, mock } = trackedTerminal({
        buffer: { lines: ['$ '] },
        cols: 6,
        rows: 4,
      });
      addon.appendText('abcde');
      addon.removeChar();

      const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
      const lines = (
        addon as unknown as {
          _layoutLines: Array<{ text: string }>;
        }
      )._layoutLines;
      expect(lines.map((line) => line.text)).toEqual(['abcd']);
      expect(overlay.textContent).toContain('abcd');
    });
  });

  describe('composition text', () => {
    it('renders changing IME candidates without committing them to pending text', () => {
      const { addon, mock } = tracked();
      addon.appendText('first ');

      addon.setCompositionText('sec');
      addon.setCompositionText('second');

      const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
      expect(addon.pendingText).toBe('first ');
      expect(addon.compositionText).toBe('second');
      expect(overlay.textContent).toContain('first second');
    });

    it('commits the finalized composition atomically', () => {
      const { addon } = tracked();
      addon.appendText('first ');
      addon.setCompositionText('second');

      addon.commitComposition('second');

      expect(addon.pendingText).toBe('first second');
      expect(addon.compositionText).toBe('');
      expect(addon.hasPending).toBe(true);
    });

    it('clear removes an unfinished composition', () => {
      const { addon } = tracked();
      addon.setCompositionText('candidate');

      addon.clear();

      expect(addon.compositionText).toBe('');
      expect(addon.state.visible).toBe(false);
    });

    it('removes composition before committed pending text', () => {
      const { addon } = tracked();
      addon.appendText('committed');
      addon.setCompositionText('候補');

      expect(addon.removeChar()).toBe('pending');
      expect(addon.pendingText).toBe('committed');
      expect(addon.compositionText).toBe('候');
    });
  });

  describe('removeChar', () => {
    it('returns "pending" when removing from pendingText', () => {
      const { addon } = tracked();
      addon.addChar('a');
      addon.addChar('b');
      const source = addon.removeChar();
      expect(source).toBe('pending');
      expect(addon.pendingText).toBe('a');
    });

    it('returns false when nothing to remove', () => {
      const { addon } = tracked();
      expect(addon.removeChar()).toBe(false);
    });

    it('removes one emoji grapheme without leaving a surrogate', () => {
      const { addon } = tracked();
      addon.appendText('a😀');

      expect(addon.removeChar()).toBe('pending');
      expect(addon.pendingText).toBe('a');
    });

    it('removes one combining grapheme as a visible unit', () => {
      const { addon } = tracked();
      addon.appendText('e\u0301');

      expect(addon.removeChar()).toBe('pending');
      expect(addon.pendingText).toBe('');
    });

    it('removes CRLF as one rendered line break', () => {
      const { addon } = tracked();
      addon.appendText('line\r\n');

      expect(addon.removeChar()).toBe('pending');
      expect(addon.pendingText).toBe('line');
    });

    it('returns "flushed" when removing from flushed text', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      const source = addon.removeChar();
      expect(source).toBe('flushed');
      expect(addon.getFlushed().count).toBe(2);
      expect(addon.getFlushed().text).toBe('ab');
    });

    it('keeps flushed offsets aligned when removing an emoji grapheme', () => {
      const { addon } = tracked();
      addon.setFlushed('😀'.length, '😀');

      expect(addon.removeChar()).toBe('flushed');
      expect(addon.getFlushed()).toEqual({ count: 0, text: '' });
    });

    it('removes pending before flushed', () => {
      const { addon } = tracked();
      addon.setFlushed(2, 'ab');
      addon.addChar('c');
      const source = addon.removeChar();
      expect(source).toBe('pending');
      expect(addon.pendingText).toBe('');
      expect(addon.getFlushed().count).toBe(2); // flushed unchanged
    });

    it('hides overlay when both pending and flushed become empty', () => {
      const { addon } = tracked();
      addon.addChar('x');
      addon.removeChar();
      expect(addon.hasPending).toBe(false);
    });

    it('does not infer editable text from the terminal buffer', () => {
      const { addon } = tracked(['$ hello']);

      const source = addon.removeChar();

      expect(source).toBe(false);
      expect(addon.getFlushed()).toEqual({ count: 0, text: '' });
    });

    it('removes explicitly detected completion text as flushed input', () => {
      const { addon } = tracked(['$ hello']);
      expect(addon.detectBufferText()).toBe('hello');

      expect(addon.removeChar()).toBe('flushed');
      expect(addon.getFlushed()).toEqual({ count: 4, text: 'hell' });
    });

    it('returns false on empty prompt with no buffer text', () => {
      const { addon } = tracked(['$ ']);
      expect(addon.removeChar()).toBe(false);
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      addon.addChar('d');
      addon.clear();

      expect(addon.pendingText).toBe('');
      expect(addon.getFlushed().count).toBe(0);
      expect(addon.getFlushed().text).toBe('');
      expect(addon.hasPending).toBe(false);
    });
  });

  describe('flushed text', () => {
    it('setFlushed stores count and text', () => {
      const { addon } = tracked();
      addon.setFlushed(5, 'hello');
      expect(addon.getFlushed()).toEqual({ count: 5, text: 'hello' });
      expect(addon.hasPending).toBe(true);
    });

    it('setFlushed with render=false does not render', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc', false);
      expect(addon.getFlushed()).toEqual({ count: 3, text: 'abc' });
      expect(addon.hasPending).toBe(true);
      // Overlay should still be hidden (no render triggered)
      expect(addon.state.visible).toBe(false);
    });

    it('setFlushed with render=false prevents stale column lock', () => {
      const { addon, mock } = tracked(['$ old session text']);
      // Simulate: clear overlay, then restore flushed WITHOUT render
      addon.clear();
      addon.setFlushed(5, 'hello', false);
      // lastPromptPos should still be null (no render happened)
      expect(addon.state.promptPosition).toBeNull();
      // Now simulate buffer load and rerender
      mock.setLines(['$ ']);
      addon.rerender();
      // Prompt should be freshly scanned, no stale column lock
      const pos = addon.state.promptPosition;
      expect(pos).not.toBeNull();
    });

    it('refreshes equal-length fallback text read from the terminal buffer', () => {
      const { addon, mock } = tracked(['$ abc']);
      addon.setFlushed(3, '');
      const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
      expect(overlay.textContent).toContain('abc');

      mock.setLines(['$ xyz']);
      addon.rerender();

      expect(overlay.textContent).toContain('xyz');
      expect(overlay.textContent).not.toContain('abc');
    });

    it('clearFlushed resets flushed state', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      addon.clearFlushed();
      expect(addon.getFlushed()).toEqual({ count: 0, text: '' });
    });

    it('clearFlushed preserves pending text', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      addon.addChar('d');
      addon.clearFlushed();
      expect(addon.pendingText).toBe('d');
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('state snapshot', () => {
    it('returns current state', () => {
      const { addon } = tracked();
      addon.setFlushed(2, 'hi');
      addon.addChar('!');

      const state = addon.state;
      expect(state.pendingText).toBe('!');
      expect(state.flushedLength).toBe(2);
      expect(state.flushedText).toBe('hi');
    });

    it('state is read-only copy', () => {
      const { addon } = tracked();
      addon.addChar('a');
      const s1 = addon.state;
      addon.addChar('b');
      const s2 = addon.state;
      expect(s1.pendingText).toBe('a');
      expect(s2.pendingText).toBe('ab');
    });

    it('restores an editable draft without rendering against a stale terminal frame', () => {
      const { addon, mock } = tracked(['$ stale session']);

      addon.restoreDraft(
        {
          pendingText: ' pending',
          flushedText: 'already sent',
        },
        false
      );

      expect(addon.state).toMatchObject({
        pendingText: ' pending',
        compositionText: '',
        flushedLength: 'already sent'.length,
        flushedText: 'already sent',
        visible: false,
        promptPosition: null,
      });

      mock.setLines(['$ current session']);
      addon.rerender();
      expect(addon.state.visible).toBe(true);
      expect(addon.state.promptPosition).not.toBeNull();
    });
  });

  describe('prompt detection', () => {
    it('findPrompt returns position for character prompt', () => {
      const { addon } = tracked(['$ hello world']);
      const pos = addon.findPrompt();
      expect(pos).toEqual({ row: 0, col: 0 });
    });

    it('findPrompt returns null when no prompt', () => {
      const { addon } = tracked(['no prompt here']);
      const pos = addon.findPrompt();
      expect(pos).toBeNull();
    });

    it('readPromptText reads text after prompt', () => {
      const { addon } = tracked(['$ hello world']);
      const text = addon.readPromptText();
      expect(text).toBe('hello world');
    });

    it('readPromptText returns null when no prompt', () => {
      const { addon } = tracked(['no prompt']);
      const text = addon.readPromptText();
      expect(text).toBeNull();
    });
  });

  describe('buffer detection', () => {
    it('detectBufferText picks up existing text after prompt', () => {
      const { addon } = tracked(['$ existing text']);
      const text = addon.detectBufferText();
      expect(text).toBe('existing text');
      expect(addon.getFlushed().count).toBe(13);
      expect(addon.getFlushed().text).toBe('existing text');
    });

    it('detectBufferText returns null for empty prompt', () => {
      const { addon } = tracked(['$ ']);
      const text = addon.detectBufferText();
      expect(text).toBeNull();
    });

    it('detectBufferText is guarded (only runs once)', () => {
      const { addon } = tracked(['$ text']);
      addon.detectBufferText();
      addon.clearFlushed(); // clear what was detected

      // Should not detect again (guard is set)
      const text = addon.detectBufferText();
      expect(text).toBeNull();
    });

    it('resetBufferDetection allows re-detection', () => {
      const { addon } = tracked(['$ text']);
      addon.detectBufferText();
      addon.clearFlushed();
      addon.resetBufferDetection();

      const text = addon.detectBufferText();
      expect(text).toBe('text');
    });

    it('suppressBufferDetection prevents detection', () => {
      const { addon } = tracked(['$ some UI text']);
      addon.suppressBufferDetection();

      // Detection should be blocked
      const text = addon.detectBufferText();
      expect(text).toBeNull();
      expect(addon.getFlushed().count).toBe(0);
    });

    it('suppressBufferDetection keeps explicit detection disabled while typing', () => {
      const { addon } = tracked(['$ ink status bar']);
      addon.suppressBufferDetection();

      addon.addChar('x');
      expect(addon.pendingText).toBe('x');
      expect(addon.getFlushed().count).toBe(0);
    });

    it('suppressBufferDetection keeps explicit detection disabled before backspace', () => {
      const { addon } = tracked(['$ buffer text']);
      addon.suppressBufferDetection();

      expect(addon.removeChar()).toBe(false);
      expect(addon.getFlushed().count).toBe(0);
    });

    it('undoDetection clears flushed and re-enables detection', () => {
      const { addon } = tracked(['$ completed']);
      // Detect buffer text (simulates tab completion detection)
      addon.detectBufferText();
      expect(addon.getFlushed().count).toBe(9); // 'completed'

      // Undo because it matched baseline (no real completion)
      addon.undoDetection();
      expect(addon.getFlushed().count).toBe(0);
      expect(addon.getFlushed().text).toBe('');

      // Detection should work again (guard reset)
      const text = addon.detectBufferText();
      expect(text).toBe('completed');
    });

    it('undoDetection does not hide overlay or clear pending', () => {
      const { addon } = tracked(['$ buffer']);
      addon.detectBufferText(); // sets flushed
      addon.addChar('x'); // adds pending on top

      addon.undoDetection();
      // Flushed cleared, but pending preserved
      expect(addon.pendingText).toBe('x');
      expect(addon.getFlushed().count).toBe(0);
      expect(addon.hasPending).toBe(true);
    });

    it('clear resets suppression (re-enables detection)', () => {
      const { addon } = tracked(['$ text']);
      addon.suppressBufferDetection();
      addon.clear(); // resets _bufferDetectDone to false

      const text = addon.detectBufferText();
      expect(text).toBe('text');
    });

    it('clear resets buffer detection guard', () => {
      const { addon } = tracked(['$ text']);
      addon.detectBufferText();
      addon.clear();

      // After clear, detection should work again
      const text = addon.detectBufferText();
      expect(text).toBe('text');
    });
  });

  describe('custom prompt configurations', () => {
    it('works with > prompt character', () => {
      const { addon } = tracked(['> hello'], '>');
      const text = addon.readPromptText();
      expect(text).toBe('hello');
    });

    it('works with Unicode prompt', () => {
      const mock = createMockTerminal({ buffer: { lines: ['\u276f hello'] } });
      const addon = new ZerolagInputAddon({
        prompt: { type: 'character', char: '\u276f', offset: 2 },
      });
      mock.terminal.loadAddon(addon);
      cleanups.push(() => {
        addon.dispose();
        mock.cleanup();
      });

      const text = addon.readPromptText();
      expect(text).toBe('hello');
    });
  });

  describe('state.visible', () => {
    it('is false before activate', () => {
      const addon = new ZerolagInputAddon();
      expect(addon.state.visible).toBe(false);
      // No cleanup needed — never activated
    });

    it('is false after dispose', () => {
      const { addon, mock } = tracked();
      addon.addChar('x');
      addon.dispose();
      expect(addon.state.visible).toBe(false);
      mock.cleanup();
    });
  });

  describe('rerender / refreshFont', () => {
    it('rerender does not crash when no text', () => {
      const { addon } = tracked();
      expect(() => addon.rerender()).not.toThrow();
    });

    it('refreshFont does not crash', () => {
      const { addon } = tracked();
      expect(() => addon.refreshFont()).not.toThrow();
    });

    it('rerender re-renders when hasPending', () => {
      const { addon } = tracked();
      addon.addChar('x');
      expect(() => addon.rerender()).not.toThrow();
      expect(addon.hasPending).toBe(true);
    });

    it('refreshFont re-renders flushed-only text', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      expect(() => addon.refreshFont()).not.toThrow();
      expect(addon.hasPending).toBe(true);
    });

    it('can pin a pending draft to the viewport while terminal history is scrolled', () => {
      const { addon, mock } = tracked(['$ draft']);
      addon.appendText('draft');
      const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;

      mock.terminal.buffer.active.baseY = 8;
      mock.terminal.buffer.active.viewportY = 2;
      mock.terminal.element.querySelector('.xterm-viewport')!.dispatchEvent(new Event('scroll'));
      expect(addon.state.visible).toBe(false);

      addon.setViewportPinned(true);
      expect(addon.state.visible).toBe(true);
      expect(overlay.textContent).toContain('draft');

      addon.setViewportPinned(false);
      expect(addon.state.visible).toBe(false);
      expect(addon.pendingText).toBe('draft');
    });

    it('caches the live prompt before an empty pinned draft scrolls away', () => {
      const { addon, mock } = tracked(['$ ']);
      const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
      addon.setViewportPinned(true);

      mock.terminal.buffer.active.baseY = 8;
      mock.terminal.buffer.active.viewportY = 2;
      mock.terminal.element.querySelector('.xterm-viewport')!.dispatchEvent(new Event('scroll'));
      addon.addChar('a');

      expect(addon.state.visible).toBe(true);
      expect(overlay.textContent).toContain('a');
    });

    it('retains the pinned prompt after deleting the draft to empty', () => {
      const { addon, mock } = tracked(['$ ']);
      addon.setViewportPinned(true);
      mock.terminal.buffer.active.baseY = 8;
      mock.terminal.buffer.active.viewportY = 2;
      addon.addChar('a');
      addon.removeChar();

      addon.addChar('b');

      expect(addon.state.visible).toBe(true);
      expect(addon.pendingText).toBe('b');
    });
  });

  describe('tab-switch save/restore pattern', () => {
    it('save pending + flushed, restore as flushed', () => {
      const { addon } = tracked(['$ ']);

      // User types some text
      addon.addChar('h');
      addon.addChar('i');
      expect(addon.pendingText).toBe('hi');

      // Tab switch: save state
      const pending = addon.pendingText;
      const { count: flushedCount, text: flushedText } = addon.getFlushed();
      const totalCount = flushedCount + pending.length;
      const totalText = flushedText + pending;
      addon.clear();

      // Simulate PTY send of pending text (app would do this)
      // ...

      // Tab switch back: restore as flushed (text is now in PTY)
      addon.suppressBufferDetection(); // prevent false Ink detection
      addon.setFlushed(totalCount, totalText, false); // no render — buffer not loaded yet
      expect(addon.getFlushed()).toEqual({ count: 2, text: 'hi' });
      expect(addon.hasPending).toBe(true); // has flushed content

      // Backspace should return 'flushed' (text is in PTY)
      const source = addon.removeChar();
      expect(source).toBe('flushed');
      expect(addon.getFlushed().count).toBe(1);
    });

    it('save with existing flushed + pending', () => {
      const { addon } = tracked(['$ ']);

      // Set flushed from previous restore, then user types more
      addon.setFlushed(3, 'abc');
      addon.addChar('d');
      addon.addChar('e');

      // Save state
      const pending = addon.pendingText;
      const { count, text } = addon.getFlushed();
      expect(pending).toBe('de');
      expect(count).toBe(3);
      expect(text).toBe('abc');

      // Combined for restore
      const totalCount = count + pending.length;
      const totalText = text + pending;
      addon.clear();

      // Restore
      addon.setFlushed(totalCount, totalText);
      expect(addon.getFlushed()).toEqual({ count: 5, text: 'abcde' });
    });
  });

  describe('setPrompt', () => {
    it('changes prompt detection strategy', () => {
      const { addon, mock } = tracked(['$ hello'], '$');
      // Initially finds $ prompt
      expect(addon.findPrompt()).toEqual({ row: 0, col: 0 });
      expect(addon.readPromptText()).toBe('hello');

      // Switch to > prompt — $ is no longer detected
      mock.setLines(['> world']);
      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      expect(addon.findPrompt()).toEqual({ row: 0, col: 0 });
      expect(addon.readPromptText()).toBe('world');
    });

    it('returns null when new prompt character not found', () => {
      const { addon } = tracked(['$ hello'], '$');
      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      // Buffer still has $ not >
      expect(addon.findPrompt()).toBeNull();
    });

    it('resets cached prompt position', () => {
      const { addon } = tracked(['$ typed']);
      addon.addChar('x');
      expect(addon.state.promptPosition).not.toBeNull();

      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      // After setPrompt with no matching prompt, position resets
      expect(addon.state.promptPosition).toBeNull();
    });

    it('re-renders when text exists', () => {
      const { addon, mock } = tracked(['$ '], '$');
      addon.addChar('h');
      addon.addChar('i');

      // Switch prompt strategy — should re-render with existing text
      mock.setLines(['> ']);
      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      expect(addon.pendingText).toBe('hi');
      expect(addon.hasPending).toBe(true);
    });

    it('does not crash when no text to render', () => {
      const { addon } = tracked(['$ ']);
      expect(() => addon.setPrompt({ type: 'character', char: '>', offset: 2 })).not.toThrow();
    });

    it('works with regex prompt strategy', () => {
      const mock = createMockTerminal({ buffer: { lines: ['user@host:~$ cmd'] } });
      const addon = new ZerolagInputAddon({
        prompt: { type: 'character', char: '$', offset: 2 },
      });
      mock.terminal.loadAddon(addon);
      cleanups.push(() => {
        addon.dispose();
        mock.cleanup();
      });

      // Switch to regex
      addon.setPrompt({ type: 'regex', pattern: /\$/, offset: 2 });
      expect(addon.findPrompt()).not.toBeNull();
      expect(addon.readPromptText()).toBe('cmd');
    });
  });

  describe('tab switch with setPrompt (CLI switching)', () => {
    it('full tab switch cycle: save state, setPrompt, restore', () => {
      // Session A with $ prompt
      const { addon, mock } = tracked(['$ '], '$');
      addon.addChar('h');
      addon.addChar('e');
      addon.addChar('l');
      addon.addChar('l');
      addon.addChar('o');
      expect(addon.pendingText).toBe('hello');

      // Save state before tab switch
      const pending = addon.pendingText;
      const { count: flushedCount, text: flushedText } = addon.getFlushed();
      const totalText = flushedText + pending;
      const totalCount = flushedCount + pending.length;
      addon.clear();

      // Switch to Session B with > prompt
      mock.setLines(['> ']);
      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      expect(addon.pendingText).toBe('');
      expect(addon.hasPending).toBe(false);

      // Switch back to Session A — restore state
      mock.setLines(['$ ']);
      addon.setPrompt({ type: 'character', char: '$', offset: 2 });
      addon.suppressBufferDetection();
      addon.setFlushed(totalCount, totalText, false);

      expect(addon.getFlushed()).toEqual({ count: 5, text: 'hello' });
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('overlay hides when prompt not found (ghost artifact fix)', () => {
    it('overlay hides when prompt scrolls away', () => {
      const { addon, mock } = tracked(['$ ']);
      addon.addChar('x');
      // Prompt visible, overlay should render
      expect(addon.hasPending).toBe(true);

      // Simulate prompt scrolling away (no $ in buffer)
      mock.setLines(['just output', 'more output']);
      addon.clear();
      addon.addChar('y');
      // Prompt not found — overlay hidden despite pending text
      // (the addon renders but finds no prompt, so display stays none)
      const state = addon.state;
      expect(state.pendingText).toBe('y');
    });

    it('clear resets lastPromptPos to null', () => {
      const { addon } = tracked(['$ ']);
      addon.addChar('a');
      expect(addon.state.promptPosition).not.toBeNull();

      addon.clear();
      expect(addon.state.promptPosition).toBeNull();
    });
  });

  describe('methods before activate / after dispose', () => {
    it('addChar accumulates but does not crash before activate', () => {
      const addon = new ZerolagInputAddon();
      addon.addChar('a');
      addon.addChar('b');
      expect(addon.pendingText).toBe('ab');
      expect(addon.hasPending).toBe(true);
      // No dispose needed — never activated, no DOM
    });

    it('removeChar works on pending text before activate', () => {
      const addon = new ZerolagInputAddon();
      addon.addChar('x');
      expect(addon.removeChar()).toBe('pending');
      expect(addon.pendingText).toBe('');
    });

    it('clear works before activate', () => {
      const addon = new ZerolagInputAddon();
      addon.addChar('x');
      addon.clear();
      expect(addon.pendingText).toBe('');
      expect(addon.hasPending).toBe(false);
    });

    it('all methods safe after dispose', () => {
      const { addon, mock } = tracked();
      addon.dispose();
      expect(() => addon.addChar('x')).not.toThrow();
      expect(() => addon.removeChar()).not.toThrow();
      expect(() => addon.clear()).not.toThrow();
      expect(() => addon.rerender()).not.toThrow();
      expect(() => addon.refreshFont()).not.toThrow();
      expect(addon.findPrompt()).toBeNull();
      expect(addon.readPromptText()).toBeNull();
      expect(addon.detectBufferText()).toBeNull();
      mock.cleanup();
    });
  });

  describe('CJK wide character support', () => {
    it('addChar works with CJK characters', () => {
      const { addon } = tracked();
      addon.addChar('你');
      addon.addChar('好');
      expect(addon.pendingText).toBe('你好');
    });

    it('appendText works with CJK characters', () => {
      const { addon } = tracked();
      addon.appendText('こんにちは');
      expect(addon.pendingText).toBe('こんにちは');
    });

    it('removeChar removes CJK characters correctly', () => {
      const { addon } = tracked();
      addon.addChar('你');
      addon.addChar('好');
      addon.removeChar();
      expect(addon.pendingText).toBe('你');
    });

    it('mixed ASCII and CJK renders without error', () => {
      const { addon } = tracked();
      addon.addChar('h');
      addon.addChar('i');
      addon.addChar('你');
      addon.addChar('好');
      expect(addon.pendingText).toBe('hi你好');
      expect(addon.hasPending).toBe(true);
    });

    it('CJK line wrapping accounts for double-width', () => {
      // With 10 cols and startCol=2, first line has 8 available cols
      // Each CJK char takes 2 cols, so 4 CJK chars fill the first line
      const { addon } = tracked(['$ '], '$');
      // Type 5 CJK chars — should overflow first line
      for (const ch of '你好世界啊') {
        addon.addChar(ch);
      }
      expect(addon.pendingText).toBe('你好世界啊');
      expect(addon.hasPending).toBe(true);
    });

    it('Korean text renders without error', () => {
      const { addon } = tracked();
      addon.appendText('안녕하세요');
      expect(addon.pendingText).toBe('안녕하세요');
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('typing with pre-existing buffer content', () => {
    it('does not adopt existing buffer text on the first keystroke', () => {
      const { addon } = tracked(['$ existing']);

      addon.addChar('!');
      expect(addon.pendingText).toBe('!');
      expect(addon.getFlushed()).toEqual({ count: 0, text: '' });
    });

    it('does not adopt existing buffer text on appendText', () => {
      const { addon } = tracked(['$ existing']);

      addon.appendText('pasted');
      expect(addon.pendingText).toBe('pasted');
      expect(addon.getFlushed()).toEqual({ count: 0, text: '' });
    });
  });
});
