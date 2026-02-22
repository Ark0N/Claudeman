import type { XtermTerminal, CellDimensions } from './types.js';

/**
 * Get cell dimensions from the terminal, handling xterm.js v5 (private API)
 * and v7+ (public API).
 *
 * Returns `null` if the terminal is not yet rendered or dimensions are
 * unavailable.
 */
export function getCellDimensions(terminal: XtermTerminal): CellDimensions | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = terminal as any;

    // Try v7+ public API first
    if (t.dimensions?.css?.cell) {
        return {
            width: t.dimensions.css.cell.width,
            height: t.dimensions.css.cell.height,
        };
    }

    // Fall back to v5 private API
    try {
        const dims = t._core?._renderService?.dimensions;
        if (dims?.css?.cell) {
            return {
                width: dims.css.cell.width,
                height: dims.css.cell.height,
            };
        }
    } catch {
        // Private API may throw in some environments
    }

    return null;
}
