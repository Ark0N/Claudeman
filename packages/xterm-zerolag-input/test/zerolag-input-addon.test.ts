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

        it('returns "flushed" when removing from flushed text', () => {
            const { addon } = tracked();
            addon.setFlushed(3, 'abc');
            const source = addon.removeChar();
            expect(source).toBe('flushed');
            expect(addon.getFlushed().count).toBe(2);
            expect(addon.getFlushed().text).toBe('ab');
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

        it('detects buffer text and removes from it when both empty', () => {
            const { addon } = tracked(['$ hello']);
            // Both pending and flushed are empty, but buffer has text
            const source = addon.removeChar();
            expect(source).toBe('flushed');
            // "hello" (5 chars) detected, then one removed = 4
            expect(addon.getFlushed().count).toBe(4);
            expect(addon.getFlushed().text).toBe('hell');
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

        it('suppressBufferDetection also blocks implicit detection in addChar', () => {
            const { addon } = tracked(['$ ink status bar']);
            addon.suppressBufferDetection();

            // addChar calls _detectBufferText internally on first keystroke
            addon.addChar('x');
            // Should have only 'x' pending, NOT the buffer text as flushed
            expect(addon.pendingText).toBe('x');
            expect(addon.getFlushed().count).toBe(0);
        });

        it('suppressBufferDetection also blocks detection in removeChar cascade', () => {
            const { addon } = tracked(['$ buffer text']);
            addon.suppressBufferDetection();

            // removeChar step 3 calls _detectBufferText — should be blocked
            expect(addon.removeChar()).toBe(false);
            expect(addon.getFlushed().count).toBe(0);
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
            cleanups.push(() => { addon.dispose(); mock.cleanup(); });

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
            addon.setFlushed(totalCount, totalText);
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

    describe('addChar implicit buffer detection', () => {
        it('first keystroke detects existing buffer text as flushed', () => {
            const { addon } = tracked(['$ existing']);
            // First addChar should trigger _detectBufferText
            addon.addChar('!');
            expect(addon.pendingText).toBe('!');
            expect(addon.getFlushed().count).toBe(8); // 'existing'
            expect(addon.getFlushed().text).toBe('existing');
        });

        it('second keystroke does NOT re-detect', () => {
            const { addon } = tracked(['$ existing']);
            addon.addChar('a');
            addon.addChar('b');
            // Should NOT detect again — flushed from first char remains
            expect(addon.pendingText).toBe('ab');
            expect(addon.getFlushed().count).toBe(8); // still 'existing'
        });
    });
});
