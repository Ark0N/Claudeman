/**
 * Defaults, bounds, and resolution for terminal history retention.
 *
 * Defaults are sized to retain a full default scrollback for replay:
 * - browser/tmux scrollback: 50,000 -> 100,000 lines
 * - server PTY buffer cap: 2MB -> 32MB (room for 100k normal-width lines + ANSI)
 * All values remain env- and settings-overridable and bounds-clamped via
 * resolveTerminalHistoryConfig().
 */

export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 100_000;
export const DEFAULT_TMUX_HISTORY_LIMIT = 100_000;
export const DEFAULT_TERMINAL_BUFFER_MAX_BYTES =
  parseInt(process.env.CODEMAN_MAX_TERMINAL_BUFFER || '', 10) || 32 * 1024 * 1024;
export const DEFAULT_TERMINAL_BUFFER_TRIM_BYTES =
  parseInt(process.env.CODEMAN_TRIM_TERMINAL_TO || '', 10) || 24 * 1024 * 1024;

export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000;
export const MAX_TERMINAL_SCROLLBACK_LINES = 1_000_000;
export const MIN_TERMINAL_BUFFER_BYTES = 1024 * 1024;
export const MAX_TERMINAL_BUFFER_BYTES = 128 * 1024 * 1024;

export interface TerminalHistoryConfig {
  terminalScrollbackLines: number;
  tmuxHistoryLimit: number;
  terminalBufferMaxBytes: number;
  terminalBufferTrimBytes: number;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function resolveTerminalHistoryConfig(settings: Record<string, unknown> = {}): TerminalHistoryConfig {
  const terminalBufferMaxBytes = boundedInt(
    settings.terminalBufferMaxBytes,
    DEFAULT_TERMINAL_BUFFER_MAX_BYTES,
    MIN_TERMINAL_BUFFER_BYTES,
    MAX_TERMINAL_BUFFER_BYTES
  );
  const terminalBufferTrimBytes = boundedInt(
    settings.terminalBufferTrimBytes,
    Math.min(DEFAULT_TERMINAL_BUFFER_TRIM_BYTES, terminalBufferMaxBytes),
    MIN_TERMINAL_BUFFER_BYTES,
    terminalBufferMaxBytes
  );

  return {
    terminalScrollbackLines: boundedInt(
      settings.terminalScrollbackLines,
      DEFAULT_TERMINAL_SCROLLBACK_LINES,
      MIN_TERMINAL_SCROLLBACK_LINES,
      MAX_TERMINAL_SCROLLBACK_LINES
    ),
    tmuxHistoryLimit: boundedInt(
      settings.tmuxHistoryLimit,
      DEFAULT_TMUX_HISTORY_LIMIT,
      MIN_TERMINAL_SCROLLBACK_LINES,
      MAX_TERMINAL_SCROLLBACK_LINES
    ),
    terminalBufferMaxBytes,
    terminalBufferTrimBytes,
  };
}
