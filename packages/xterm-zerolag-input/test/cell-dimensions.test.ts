import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { getCellDimensions } from '../src/cell-dimensions.js';
import { createMockTerminal } from './helpers.js';
import type { XtermTerminal } from '../src/types.js';

let cleanups: (() => void)[] = [];

afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups = [];
});

describe('getCellDimensions', () => {
    describe('v5 private API (mock _core._renderService)', () => {
        it('returns cell width and height from css.cell', () => {
            const mock = createMockTerminal({ cellWidth: 8.4, cellHeight: 19 });
            cleanups.push(mock.cleanup);
            const dims = getCellDimensions(mock.terminal as unknown as XtermTerminal);
            expect(dims).not.toBeNull();
            expect(dims!.width).toBe(8.4);
            expect(dims!.height).toBe(19);
        });

        it('returns charTop from device.char.top divided by DPR', () => {
            const mock = createMockTerminal({
                cellWidth: 8, cellHeight: 19,
                deviceCharTop: 2,
            });
            cleanups.push(mock.cleanup);
            const dims = getCellDimensions(mock.terminal as unknown as XtermTerminal);
            expect(dims).not.toBeNull();
            // DPR=1 in jsdom, so charTop = 2 / 1 = 2
            expect(dims!.charTop).toBe(2);
        });

        it('returns charHeight from device.char.height divided by DPR', () => {
            const mock = createMockTerminal({
                cellWidth: 8, cellHeight: 19,
                deviceCharHeight: 16,
            });
            cleanups.push(mock.cleanup);
            const dims = getCellDimensions(mock.terminal as unknown as XtermTerminal);
            expect(dims).not.toBeNull();
            // DPR=1, so charHeight = 16 / 1 = 16
            expect(dims!.charHeight).toBe(16);
        });

        it('defaults charTop to 0 when device.char not present', () => {
            // Default mock has deviceCharTop=0
            const mock = createMockTerminal({ cellWidth: 8, cellHeight: 19 });
            cleanups.push(mock.cleanup);
            const dims = getCellDimensions(mock.terminal as unknown as XtermTerminal);
            expect(dims!.charTop).toBe(0);
        });

        it('defaults charHeight to cellH when device.char.height not set', () => {
            // Default mock has deviceCharHeight=cellH
            const mock = createMockTerminal({ cellWidth: 8, cellHeight: 19 });
            cleanups.push(mock.cleanup);
            const dims = getCellDimensions(mock.terminal as unknown as XtermTerminal);
            expect(dims!.charHeight).toBe(19);
        });
    });

    describe('DPR simulation', () => {
        const originalDPR = globalThis.devicePixelRatio;

        beforeEach(() => {
            // Set DPR=2 to test division
            Object.defineProperty(globalThis, 'devicePixelRatio', {
                value: 2,
                writable: true,
                configurable: true,
            });
        });

        afterEach(() => {
            Object.defineProperty(globalThis, 'devicePixelRatio', {
                value: originalDPR,
                writable: true,
                configurable: true,
            });
        });

        it('divides device.char.top by DPR', () => {
            const mock = createMockTerminal({
                cellWidth: 16, cellHeight: 38,
                deviceCharTop: 4,
                deviceCharHeight: 32,
            });
            cleanups.push(mock.cleanup);
            const dims = getCellDimensions(mock.terminal as unknown as XtermTerminal);
            expect(dims).not.toBeNull();
            // charTop = 4 / 2 = 2
            expect(dims!.charTop).toBe(2);
            // charHeight = 32 / 2 = 16
            expect(dims!.charHeight).toBe(16);
        });
    });

    describe('null cases', () => {
        it('returns null for terminal without _core', () => {
            const terminal = {
                element: document.createElement('div'),
                cols: 80,
                rows: 24,
                options: {},
                buffer: { active: { viewportY: 0, baseY: 0, getLine: () => undefined } },
            } as unknown as XtermTerminal;
            const dims = getCellDimensions(terminal);
            expect(dims).toBeNull();
        });

        it('returns null for terminal with no dimensions', () => {
            const terminal = {
                element: document.createElement('div'),
                cols: 80,
                rows: 24,
                options: {},
                buffer: { active: { viewportY: 0, baseY: 0, getLine: () => undefined } },
                _core: { _renderService: {} },
            } as unknown as XtermTerminal;
            const dims = getCellDimensions(terminal);
            expect(dims).toBeNull();
        });
    });
});
