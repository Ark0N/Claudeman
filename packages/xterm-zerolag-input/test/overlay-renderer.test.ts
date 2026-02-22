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
});
