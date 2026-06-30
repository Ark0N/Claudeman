import { describe, it, expect } from 'vitest';
import {
  resolveTerminalHistoryConfig,
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
  DEFAULT_TMUX_HISTORY_LIMIT,
  DEFAULT_TERMINAL_BUFFER_MAX_BYTES,
  DEFAULT_TERMINAL_BUFFER_TRIM_BYTES,
  MIN_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_BUFFER_BYTES,
  MAX_TERMINAL_BUFFER_BYTES,
} from '../src/config/terminal-history.js';

describe('resolveTerminalHistoryConfig', () => {
  it('returns the documented defaults for empty settings', () => {
    const cfg = resolveTerminalHistoryConfig({});
    expect(cfg).toEqual({
      terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
      tmuxHistoryLimit: DEFAULT_TMUX_HISTORY_LIMIT,
      terminalBufferMaxBytes: DEFAULT_TERMINAL_BUFFER_MAX_BYTES,
      terminalBufferTrimBytes: DEFAULT_TERMINAL_BUFFER_TRIM_BYTES,
    });
  });

  it('defaults raise tmux scrollback to 100k and terminal buffer cap to 32MB', () => {
    expect(DEFAULT_TMUX_HISTORY_LIMIT).toBe(100_000);
    expect(DEFAULT_TERMINAL_SCROLLBACK_LINES).toBe(100_000);
    expect(DEFAULT_TERMINAL_BUFFER_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(DEFAULT_TERMINAL_BUFFER_TRIM_BYTES).toBe(24 * 1024 * 1024);
  });

  it('passes valid in-range values through unchanged', () => {
    const cfg = resolveTerminalHistoryConfig({
      terminalScrollbackLines: 50_000,
      tmuxHistoryLimit: 75_000,
      terminalBufferMaxBytes: 16 * 1024 * 1024,
      terminalBufferTrimBytes: 8 * 1024 * 1024,
    });
    expect(cfg).toEqual({
      terminalScrollbackLines: 50_000,
      tmuxHistoryLimit: 75_000,
      terminalBufferMaxBytes: 16 * 1024 * 1024,
      terminalBufferTrimBytes: 8 * 1024 * 1024,
    });
  });

  it('clamps scrollback/history below MIN up to the floor', () => {
    const cfg = resolveTerminalHistoryConfig({
      terminalScrollbackLines: 1,
      tmuxHistoryLimit: 0,
    });
    expect(cfg.terminalScrollbackLines).toBe(MIN_TERMINAL_SCROLLBACK_LINES);
    expect(cfg.tmuxHistoryLimit).toBe(MIN_TERMINAL_SCROLLBACK_LINES);
  });

  it('clamps scrollback/history above MAX down to the ceiling', () => {
    const cfg = resolveTerminalHistoryConfig({
      terminalScrollbackLines: 999_999_999,
      tmuxHistoryLimit: 999_999_999,
    });
    expect(cfg.terminalScrollbackLines).toBe(MAX_TERMINAL_SCROLLBACK_LINES);
    expect(cfg.tmuxHistoryLimit).toBe(MAX_TERMINAL_SCROLLBACK_LINES);
  });

  it('clamps the buffer byte caps to their MIN/MAX bounds', () => {
    const tooSmall = resolveTerminalHistoryConfig({ terminalBufferMaxBytes: 1 });
    expect(tooSmall.terminalBufferMaxBytes).toBe(MIN_TERMINAL_BUFFER_BYTES);

    const tooLarge = resolveTerminalHistoryConfig({ terminalBufferMaxBytes: 1024 * 1024 * 1024 });
    expect(tooLarge.terminalBufferMaxBytes).toBe(MAX_TERMINAL_BUFFER_BYTES);
  });

  it('keeps trim <= max (trim is capped to the resolved max)', () => {
    const cfg = resolveTerminalHistoryConfig({
      terminalBufferMaxBytes: 4 * 1024 * 1024,
      terminalBufferTrimBytes: 64 * 1024 * 1024,
    });
    expect(cfg.terminalBufferTrimBytes).toBeLessThanOrEqual(cfg.terminalBufferMaxBytes);
    expect(cfg.terminalBufferTrimBytes).toBe(4 * 1024 * 1024);
  });

  it('caps the default trim to a lowered max', () => {
    // Default trim (24MB) exceeds a 2MB max → trim must fall to the max.
    const cfg = resolveTerminalHistoryConfig({ terminalBufferMaxBytes: 2 * 1024 * 1024 });
    expect(cfg.terminalBufferTrimBytes).toBe(2 * 1024 * 1024);
  });

  it('truncates fractional inputs to integers', () => {
    const cfg = resolveTerminalHistoryConfig({ terminalScrollbackLines: 12_345.9 });
    expect(cfg.terminalScrollbackLines).toBe(12_345);
  });

  it('falls back to defaults for non-number / non-finite inputs', () => {
    const cfg = resolveTerminalHistoryConfig({
      terminalScrollbackLines: 'lots' as unknown as number,
      tmuxHistoryLimit: NaN,
      terminalBufferMaxBytes: null as unknown as number,
      terminalBufferTrimBytes: Infinity,
    });
    expect(cfg.terminalScrollbackLines).toBe(DEFAULT_TERMINAL_SCROLLBACK_LINES);
    expect(cfg.tmuxHistoryLimit).toBe(DEFAULT_TMUX_HISTORY_LIMIT);
    expect(cfg.terminalBufferMaxBytes).toBe(DEFAULT_TERMINAL_BUFFER_MAX_BYTES);
    // trim default is min(DEFAULT_TRIM, resolvedMax) — here resolvedMax is the default max.
    expect(cfg.terminalBufferTrimBytes).toBe(DEFAULT_TERMINAL_BUFFER_TRIM_BYTES);
  });

  it('uses an empty object when called with no argument', () => {
    expect(resolveTerminalHistoryConfig().tmuxHistoryLimit).toBe(DEFAULT_TMUX_HISTORY_LIMIT);
  });
});
