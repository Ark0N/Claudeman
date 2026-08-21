/**
 * Defaults, bounds, and resolution for terminal history retention.
 *
 * Raised defaults (the ones actually wired):
 * - tmux history-limit: 50,000 -> 100,000 lines (applied at session spawn)
 * - server PTY buffer cap: 2MB max / 1.5MB trim -> 32MB / 24MB (via buffer-limits.ts)
 * Browser xterm scrollback is a separate hardcoded DEFAULT_SCROLLBACK (50,000) in
 * src/web/public/constants.js and deliberately stays at 50k — 100k xterm lines per tab
 * is a mobile-memory hazard — so DEFAULT_TERMINAL_SCROLLBACK_LINES stays 50,000 to match.
 * The terminalScrollbackLines/terminalBufferMaxBytes/terminalBufferTrimBytes settings keys
 * remain schema-validated but inert (a follow-up wires them); only tmuxHistoryLimit is wired.
 * tmux <3.7 applies it to new panes; tmux 3.7+ can also resize live panes.
 * All values remain env- and settings-overridable and bounds-clamped via
 * resolveTerminalHistoryConfig().
 */

export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 50_000;
export const DEFAULT_TMUX_HISTORY_LIMIT = 100_000;
export const DEFAULT_TERMINAL_BUFFER_MAX_BYTES =
  parseInt(process.env.CODEMAN_MAX_TERMINAL_BUFFER || '', 10) || 32 * 1024 * 1024;
// Trim must stay below the max: BufferAccumulator.trim() keeps the last trimSize chars, so a
// trim >= max never shrinks the buffer — every append then re-joins the whole string (O(n²))
// and memory overshoots the operator's cap (e.g. CODEMAN_MAX_TERMINAL_BUFFER=2097152 with no
// trim env would leave the 24MB trim default in force). Clamp to 75% of the resolved max,
// preserving the 24MB/32MB default ratio as trim hysteresis.
export const DEFAULT_TERMINAL_BUFFER_TRIM_BYTES = Math.min(
  parseInt(process.env.CODEMAN_TRIM_TERMINAL_TO || '', 10) || 24 * 1024 * 1024,
  Math.floor(DEFAULT_TERMINAL_BUFFER_MAX_BYTES * 0.75)
);

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
