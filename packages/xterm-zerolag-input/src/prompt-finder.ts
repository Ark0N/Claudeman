import type { XtermTerminal, PromptFinder, PromptPosition } from './types.js';

/**
 * Find the prompt in the terminal buffer using the configured strategy.
 * Scans bottom-up through the viewport to find the most recent prompt.
 *
 * @returns The prompt position (viewport-relative), or `null` if not found.
 */
export function findPrompt(
    terminal: XtermTerminal,
    finder: PromptFinder,
): PromptPosition | null {
    try {
        const buffer = terminal.buffer.active;
        const viewportTop = buffer.viewportY;

        switch (finder.type) {
            case 'character': {
                for (let row = terminal.rows - 1; row >= 0; row--) {
                    const line = buffer.getLine(viewportTop + row);
                    if (!line) continue;
                    const text = line.translateToString(true);
                    const idx = text.lastIndexOf(finder.char);
                    if (idx >= 0) return { row, col: idx };
                }
                return null;
            }

            case 'regex': {
                for (let row = terminal.rows - 1; row >= 0; row--) {
                    const line = buffer.getLine(viewportTop + row);
                    if (!line) continue;
                    const text = line.translateToString(true);
                    const match = text.match(finder.pattern);
                    if (match) {
                        const col = match.index ?? 0;
                        return { row, col };
                    }
                }
                return null;
            }

            case 'custom':
                return finder.find(terminal);

            default:
                return null;
        }
    } catch {
        return null;
    }
}

/**
 * Read text after the prompt position on the same line.
 *
 * @param terminal - The xterm.js terminal instance
 * @param prompt - The prompt position in the viewport
 * @param offset - Characters to skip after the prompt marker (e.g., 2 for "> ")
 * @returns The text after the prompt, trimmed. Empty string if nothing found.
 */
export function readTextAfterPrompt(
    terminal: XtermTerminal,
    prompt: PromptPosition,
    offset: number,
): string {
    try {
        const buffer = terminal.buffer.active;
        const absRow = buffer.viewportY + prompt.row;
        const line = buffer.getLine(absRow);
        if (!line) return '';
        const lineText = line.translateToString(true);
        return lineText.slice(prompt.col + offset).trimEnd();
    } catch {
        return '';
    }
}
