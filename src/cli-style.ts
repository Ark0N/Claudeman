/**
 * @fileoverview One style vocabulary for everything the `codeman` CLI prints:
 * palette, glyphs, the small block helpers (heading/rule/kv), width-aware table
 * layout, a stderr spinner and a y/N confirm.
 *
 * Color detection is chalk's alone. It already honors NO_COLOR, FORCE_COLOR,
 * TERM=dumb and TTY-ness, and a second detector here would disagree with it on
 * some terminal with no way to tell which one was right.
 *
 * The layout math is pure and exported separately from anything that touches a
 * terminal, which is what lets it be unit-tested with no TTY and reused by
 * `utils/dependency-report.ts` while that file stays color-free.
 *
 * @module cli-style
 */

import chalk, { type ChalkInstance } from 'chalk';
import { createInterface } from 'node:readline';
// Direct import, not the `utils` barrel: the barrel pulls in node-pty and every
// CLI resolver, which a style module has no business loading.
import { stripAnsi } from './utils/regex-patterns.js';

// ─────────────────────────────────────────────────────────────────────────────
// Palette and glyphs
// ─────────────────────────────────────────────────────────────────────────────

/** Semantic roles, mirroring the web UI's status language (green fine, yellow waiting, red blocked). */
export const palette = {
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  info: chalk.cyan,
  muted: chalk.gray,
  emph: chalk.bold,
  accent: chalk.magenta,
} as const satisfies Record<string, ChalkInstance>;

/** The glyph vocabulary the CLI already used, in one place. */
export const GLYPH = {
  ok: '✓',
  fail: '✗',
  warn: '⚠',
  idle: '○',
  dot: '●',
  arrow: '→',
} as const;

/** Spinner frames (braille, one cell wide in every terminal we support). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** What a line is reporting, independent of how it is painted. */
export type Tone = 'ok' | 'warn' | 'err' | 'idle' | 'info';

const TONE_GLYPH: Record<Tone, string> = {
  ok: GLYPH.ok,
  warn: GLYPH.warn,
  err: GLYPH.fail,
  idle: GLYPH.idle,
  info: GLYPH.dot,
};

const TONE_STYLE: Record<Tone, ChalkInstance> = {
  ok: palette.ok,
  warn: palette.warn,
  err: palette.err,
  idle: palette.muted,
  info: palette.info,
};

/** Glyph for a tone. Pure, so the mapping is testable without a terminal. */
export function glyphFor(tone: Tone): string {
  return TONE_GLYPH[tone];
}

/** Paint text in a tone's color. */
export function tint(tone: Tone, text: string): string {
  return TONE_STYLE[tone](text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────────────

/** Section heading. The blank line above it is part of the existing block idiom. */
export function heading(text: string): string {
  return `\n${palette.emph(text)}`;
}

/** Horizontal rule under a title. */
export function rule(width = 40): string {
  return palette.muted('─'.repeat(Math.max(0, width)));
}

/**
 * Indented `Label: value` line. `pad` aligns the values of a block by padding
 * the label column (including its colon), for blocks whose labels differ in
 * length.
 */
export function kv(label: string, value: string, pad = 0): string {
  const key = pad > 0 ? padCell(`${label}:`, pad) : `${label}:`;
  return `  ${key} ${value}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Width-aware layout (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Printed width of a cell: ANSI sequences take no columns. */
export function displayWidth(text: string): number {
  return stripAnsi(text).length;
}

export type CellAlign = 'left' | 'right';

/** Pad to `width` columns, measuring by display width so colored cells still align. */
export function padCell(text: string, width: number, align: CellAlign = 'left'): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return align === 'right' ? `${fill}${text}` : `${text}${fill}`;
}

/**
 * Pad AFTER the paint, so the fill stays outside the color run and a trailing
 * empty column can be trimmed away instead of ending in a reset sequence with
 * invisible spaces before it.
 */
export function padStyled(text: string, width: number, paint: (t: string) => string): string {
  return `${paint(text)}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

/** Widest cell per column. Short rows count as empty cells, never as narrower columns. */
export function columnWidths(rows: readonly (readonly string[])[]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(row[i] ?? ''));
    }
  }
  return widths;
}

export interface TableOptions {
  /** Per-column alignment; missing entries are left-aligned. */
  align?: readonly CellAlign[];
  /** Spaces between columns. */
  gap?: number;
  /** Prefix for every row. */
  indent?: string;
}

/**
 * Lay rows out in columns sized to their widest cell. The last cell of a row is
 * never padded, so no line carries trailing whitespace.
 */
export function layoutTable(rows: readonly (readonly string[])[], options: TableOptions = {}): string[] {
  const { align = [], gap = 1, indent = '' } = options;
  const widths = columnWidths(rows);
  const separator = ' '.repeat(Math.max(0, gap));
  return rows.map((row) => {
    const cells = row.map((cell, i) => (i === row.length - 1 ? cell : padCell(cell, widths[i], align[i] ?? 'left')));
    return `${indent}${cells.join(separator)}`;
  });
}

/** `layoutTable()` as one printable block. */
export function table(rows: readonly (readonly string[])[], options: TableOptions = {}): string {
  return layoutTable(rows, options).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────────────────────────

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[K';

/** The slice of a stream a spinner needs; `process.stderr` satisfies it. */
export interface SpinnerStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface Spinner {
  start(): Spinner;
  /** Change the text mid-flight. Silent on a non-TTY, which prints once and stops. */
  setText(text: string): void;
  /** Clear the line, restore the cursor and optionally print a final line. */
  stop(finalLine?: string): void;
}

export interface SpinnerOptions {
  stream?: SpinnerStream;
  intervalMs?: number;
}

/**
 * In-place progress line on stderr, for the calls that block for tens of seconds
 * (daemon start, service install). Only a TTY gets the animation: piped output
 * and journald get the text once, so a log file never fills with `\r` frames.
 */
export function spinner(text: string, options: SpinnerOptions = {}): Spinner {
  const stream = options.stream ?? process.stderr;
  const intervalMs = options.intervalMs ?? 90;
  const animated = Boolean(stream.isTTY);
  let label = text;
  let frame = 0;
  let timer: NodeJS.Timeout | null = null;
  let started = false;
  let stopped = false;

  const restoreCursor = () => {
    if (animated) stream.write(SHOW_CURSOR);
  };

  const render = () => {
    stream.write(`\r${palette.info(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${label}${CLEAR_LINE}`);
    frame++;
  };

  const handle: Spinner = {
    start() {
      if (started || stopped) return handle;
      started = true;
      if (!animated) {
        stream.write(`${label}\n`);
        return handle;
      }
      stream.write(HIDE_CURSOR);
      // A hidden cursor left behind by a Ctrl+C outlives the process, so the
      // exit hook is not optional.
      process.once('exit', restoreCursor);
      render();
      // Unref'd: a spinner must never be the reason the process stays alive.
      timer = setInterval(render, intervalMs);
      timer.unref();
      return handle;
    },
    setText(next: string) {
      label = next;
      if (animated && started && !stopped) render();
    },
    stop(finalLine?: string) {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (animated && started) {
        stream.write(`\r${CLEAR_LINE}`);
        restoreCursor();
        process.off('exit', restoreCursor);
      }
      if (finalLine && animated) stream.write(`${finalLine}\n`);
    },
  };
  return handle;
}

/** Run `work` with a spinner up, stopping it however `work` ends. */
export async function withSpinner<T>(text: string, work: () => Promise<T>, options?: SpinnerOptions): Promise<T> {
  const handle = spinner(text, options).start();
  try {
    return await work();
  } finally {
    handle.stop();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirm
// ─────────────────────────────────────────────────────────────────────────────

/** Is there a human on the other end of both halves of the terminal? */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * y/N prompt. Answers `false` immediately when stdin is not a TTY (a script
 * piping into the CLI must never hang on an invisible question), so callers
 * that support a `--force` flag can branch on `isInteractive()` to keep printing
 * their "pass --force" hint instead.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once('SIGINT', () => resolve(''));
      rl.question(`${question} ${palette.muted('[y/N]')} `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
    // readline resumes stdin; a still-flowing stdin keeps the process alive.
    process.stdin.pause();
  }
}
