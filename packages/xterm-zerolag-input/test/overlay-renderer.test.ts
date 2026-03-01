import { describe, it, expect } from 'vitest';
import { renderOverlay } from '../src/overlay-renderer.js';
import type { RenderParams, FontStyle } from '../src/types.js';

const FONT: FontStyle = {
    fontFamily: 'monospace',
    fontSize: '14px',
    fontWeight: 'normal',
    color: '#eeeeee',
    backgroundColor: '#0d0d0d',
    letterSpacing: '',
};

function makeParams(overrides: Partial<RenderParams> = {}): RenderParams {
    return {
        lines: ['hello'],
        startCol: 2,
        totalCols: 80,
        cellW: 8.4,
        cellH: 17,
        charTop: 2,
        charHeight: 14,
        promptRow: 10,
        font: FONT,
        showCursor: true,
        cursorColor: '#e0e0e0',
        ...overrides,
    };
}

describe('renderOverlay', () => {
    it('positions container at prompt row', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ promptRow: 5 }));
        expect(container.style.top).toBe((5 * 17) + 'px');
        expect(container.style.left).toBe('0px');
    });

    it('creates per-character spans in a line div', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['abc'] }));

        // Line div + cursor span
        expect(container.children.length).toBe(2);

        const lineDiv = container.children[0] as HTMLDivElement;
        expect(lineDiv.children.length).toBe(3); // a, b, c

        const spanA = lineDiv.children[0] as HTMLSpanElement;
        expect(spanA.textContent).toBe('a');
        expect(spanA.style.left).toBe('0px');

        const spanB = lineDiv.children[1] as HTMLSpanElement;
        expect(spanB.textContent).toBe('b');
        expect(spanB.style.left).toBe('8.4px');

        const spanC = lineDiv.children[2] as HTMLSpanElement;
        expect(spanC.textContent).toBe('c');
        expect(spanC.style.left).toBe('16.8px');
    });

    it('sets span width to cellW', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['x'], cellW: 9.5 }));
        const lineDiv = container.children[0] as HTMLDivElement;
        const span = lineDiv.children[0] as HTMLSpanElement;
        expect(span.style.width).toBe('9.5px');
    });

    it('applies font styles to spans', () => {
        const font: FontStyle = {
            fontFamily: 'Fira Code',
            fontSize: '16px',
            fontWeight: 'bold',
            color: '#ff0000',
            backgroundColor: '#000000',
            letterSpacing: '0.5px',
        };
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['A'], font }));

        const lineDiv = container.children[0] as HTMLDivElement;
        // jsdom normalizes hex to rgb()
        expect(lineDiv.style.backgroundColor).toBe('rgb(0, 0, 0)');

        const span = lineDiv.children[0] as HTMLSpanElement;
        expect(span.style.fontFamily).toBe('Fira Code');
        expect(span.style.fontSize).toBe('16px');
        expect(span.style.fontWeight).toBe('bold');
        expect(span.style.color).toBe('rgb(255, 0, 0)');
        expect(span.style.letterSpacing).toBe('0.5px');
    });

    it('offsets first line by startCol', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['hi'], startCol: 5, cellW: 10 }));
        const lineDiv = container.children[0] as HTMLDivElement;
        // First line left = startCol * cellW
        expect(lineDiv.style.left).toBe('50px');
    });

    it('renders cursor at end of text', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({
            lines: ['ab'],
            startCol: 3,
            cellW: 10,
            cellH: 20,
            showCursor: true,
            cursorColor: '#ff00ff',
        }));

        // Last child is cursor (after line div)
        const cursor = container.children[container.children.length - 1] as HTMLSpanElement;
        // cursorCol = startCol(3) + text.length(2) = 5
        expect(cursor.style.left).toBe('50px');
        expect(cursor.style.width).toBe('10px');
        expect(cursor.style.height).toBe('20px');
        // jsdom normalizes hex to rgb()
        expect(cursor.style.backgroundColor).toBe('rgb(255, 0, 255)');
    });

    it('does not render cursor when showCursor is false', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['ab'], showCursor: false }));
        // Only line div, no cursor
        expect(container.children.length).toBe(1);
    });

    it('renders multi-line text', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({
            lines: ['first', 'second'],
            startCol: 5,
            cellW: 10,
            cellH: 20,
        }));

        // 2 line divs + cursor
        expect(container.children.length).toBe(3);

        const line1 = container.children[0] as HTMLDivElement;
        expect(line1.style.left).toBe('50px'); // startCol * cellW
        expect(line1.style.top).toBe('0px');
        expect(line1.children.length).toBe(5); // 'first'

        const line2 = container.children[1] as HTMLDivElement;
        expect(line2.style.left).toBe('0px'); // wrapped lines start at col 0
        expect(line2.style.top).toBe('20px'); // second row
        expect(line2.children.length).toBe(6); // 'second'
    });

    it('clears previous content on re-render', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['abc'] }));
        expect(container.children.length).toBe(2); // line + cursor

        renderOverlay(container, makeParams({ lines: ['xy'] }));
        expect(container.children.length).toBe(2); // line + cursor (rebuilt)

        const lineDiv = container.children[0] as HTMLDivElement;
        expect(lineDiv.children.length).toBe(2); // x, y
    });

    it('shows container (display not none)', () => {
        const container = document.createElement('div');
        container.style.display = 'none';
        renderOverlay(container, makeParams());
        expect(container.style.display).toBe('');
    });

    // ─── Anti-flicker / compositing seam tests ────────────────────

    it('line div height extends 1px past cellH to cover compositing seam', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['abc'], cellH: 19 }));
        const lineDiv = container.children[0] as HTMLDivElement;
        // cellH + 1 = 20px — the extra 1px covers the compositing seam
        expect(lineDiv.style.height).toBe('20px');
    });

    it('line div height is cellH+1 for various cell heights', () => {
        for (const cellH of [15, 17, 19, 22]) {
            const container = document.createElement('div');
            renderOverlay(container, makeParams({ lines: ['x'], cellH }));
            const lineDiv = container.children[0] as HTMLDivElement;
            expect(lineDiv.style.height).toBe((cellH + 1) + 'px');
        }
    });

    it('multi-line overlay has cellH+1 height on each line div', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({
            lines: ['first', 'second'],
            cellH: 19,
        }));
        const line1 = container.children[0] as HTMLDivElement;
        const line2 = container.children[1] as HTMLDivElement;
        expect(line1.style.height).toBe('20px');
        expect(line2.style.height).toBe('20px');
    });

    // ─── Span vertical centering tests ────────────────────────────

    it('span uses full cellH for height and lineHeight (CSS centering)', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['a'], cellH: 19 }));
        const lineDiv = container.children[0] as HTMLDivElement;
        const span = lineDiv.children[0] as HTMLSpanElement;
        expect(span.style.height).toBe('19px');
        expect(span.style.lineHeight).toBe('19px');
    });

    it('span top is 0px (no vertical offset / no transform)', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['a'], cellH: 19 }));
        const lineDiv = container.children[0] as HTMLDivElement;
        const span = lineDiv.children[0] as HTMLSpanElement;
        expect(span.style.top).toBe('0px');
        // No translateY transform — sub-pixel overhang causes artifacts
        expect(span.style.transform).toBe('');
    });

    // ─── Font rendering tests ─────────────────────────────────────

    it('span disables ligatures via font-feature-settings', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['fi'] }));
        const lineDiv = container.children[0] as HTMLDivElement;
        const span = lineDiv.children[0] as HTMLSpanElement;
        // Check cssText includes the ligature-disabling settings
        // jsdom may normalize whitespace; check that both liga and calt are disabled
        expect(span.style.cssText).toContain("font-feature-settings:");
        expect(span.style.cssText).toContain("'liga' 0");
        expect(span.style.cssText).toContain("'calt' 0");
    });

    it('span has text-align: center for glyph centering', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['m'] }));
        const lineDiv = container.children[0] as HTMLDivElement;
        const span = lineDiv.children[0] as HTMLSpanElement;
        expect(span.style.textAlign).toBe('center');
    });

    it('span has pointer-events: none', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: ['a'] }));
        const lineDiv = container.children[0] as HTMLDivElement;
        const span = lineDiv.children[0] as HTMLSpanElement;
        expect(span.style.pointerEvents).toBe('none');
    });

    // ─── Multi-line cursor positioning ────────────────────────────

    it('cursor on wrapped line uses col 0 as base', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({
            lines: ['first', 'ab'],
            startCol: 5,
            cellW: 10,
            cellH: 20,
            showCursor: true,
        }));
        // Cursor at end of second line: col = 0 + 2 = 2
        const cursor = container.children[container.children.length - 1] as HTMLSpanElement;
        expect(cursor.style.left).toBe('20px'); // 2 * 10
        expect(cursor.style.top).toBe('20px'); // row 1 * cellH
    });

    // ─── charTop/charHeight passed through ────────────────────────

    it('accepts charTop and charHeight params without error', () => {
        const container = document.createElement('div');
        expect(() => renderOverlay(container, makeParams({
            lines: ['test'],
            charTop: 2,
            charHeight: 14,
        }))).not.toThrow();
        expect(container.children.length).toBeGreaterThan(0);
    });

    // ─── Line div positioning regression ──────────────────────────

    it('line div background color matches font.backgroundColor', () => {
        const container = document.createElement('div');
        const font: FontStyle = { ...FONT, backgroundColor: '#1a1a1a' };
        renderOverlay(container, makeParams({ lines: ['x'], font }));
        const lineDiv = container.children[0] as HTMLDivElement;
        // jsdom normalizes hex to rgb()
        expect(lineDiv.style.backgroundColor).toBe('rgb(26, 26, 26)');
    });

    it('empty line produces line div with no spans', () => {
        const container = document.createElement('div');
        renderOverlay(container, makeParams({ lines: [''] }));
        const lineDiv = container.children[0] as HTMLDivElement;
        expect(lineDiv.children.length).toBe(0);
    });
});
