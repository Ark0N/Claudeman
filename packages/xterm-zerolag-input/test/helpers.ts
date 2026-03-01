/**
 * Mock terminal factory for unit tests.
 *
 * Creates a minimal Terminal-like object that satisfies the addon's
 * requirements without needing a real xterm.js instance or DOM renderer.
 */

interface MockLine {
    translateToString(_trimRight?: boolean): string;
}

interface MockBufferOptions {
    lines: string[];
    viewportY?: number;
    baseY?: number;
    cursorX?: number;
    cursorY?: number;
}

interface MockTerminalOptions {
    buffer?: MockBufferOptions;
    cols?: number;
    rows?: number;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: string | number;
    theme?: {
        background?: string;
        foreground?: string;
        cursor?: string;
    };
    cellWidth?: number;
    cellHeight?: number;
    /** Device-pixel char top offset (for charTop calculation). Default: 0 */
    deviceCharTop?: number;
    /** Device-pixel char height (for charHeight calculation). Default: cellHeight * dpr */
    deviceCharHeight?: number;
}

export function createMockTerminal(opts: MockTerminalOptions = {}) {
    const bufOpts = opts.buffer ?? { lines: ['$ '] };
    const lines = bufOpts.lines;
    const viewportY = bufOpts.viewportY ?? 0;
    const baseY = bufOpts.baseY ?? viewportY;
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? Math.max(lines.length, 24);
    const cellW = opts.cellWidth ?? 8.4;
    const cellH = opts.cellHeight ?? 17;

    const mockLines: MockLine[] = lines.map((text) => ({
        translateToString: () => text,
    }));

    // Create minimal DOM structure
    const element = document.createElement('div');
    element.className = 'terminal xterm';

    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';

    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    screen.style.position = 'relative';

    const xtermRows = document.createElement('div');
    xtermRows.className = 'xterm-rows';

    element.appendChild(viewport);
    element.appendChild(screen);
    screen.appendChild(xtermRows);

    // Append to document so getComputedStyle works
    document.body.appendChild(element);

    const terminal = {
        element,
        cols,
        rows,
        options: {
            fontFamily: opts.fontFamily ?? 'monospace',
            fontSize: opts.fontSize ?? 14,
            fontWeight: opts.fontWeight ?? 'normal',
            theme: opts.theme ?? {},
        },
        buffer: {
            active: {
                viewportY,
                baseY,
                cursorX: bufOpts.cursorX ?? 0,
                cursorY: bufOpts.cursorY ?? 0,
                getLine: (absRow: number): MockLine | undefined => {
                    return mockLines[absRow - viewportY];
                },
            },
        },
        _core: {
            _renderService: {
                dimensions: {
                    css: {
                        cell: { width: cellW, height: cellH },
                    },
                    device: {
                        char: {
                            top: opts.deviceCharTop ?? 0,
                            height: opts.deviceCharHeight ?? cellH,
                        },
                    },
                },
            },
        },
        // Simulate loadAddon
        loadAddon(addon: { activate: (t: unknown) => void }) {
            addon.activate(this);
        },
    };

    return {
        terminal,
        /** Update buffer lines for subsequent calls */
        setLines(newLines: string[]) {
            mockLines.length = 0;
            for (const text of newLines) {
                mockLines.push({ translateToString: () => text });
            }
        },
        /** Clean up DOM */
        cleanup() {
            element.remove();
        },
    };
}
