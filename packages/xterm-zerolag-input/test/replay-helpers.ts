/**
 * Replay-test helpers: a structural hybrid terminal whose buffer, cursor and
 * onWriteParsed delegate to a REAL @xterm/headless Terminal (so fixtures run
 * through the real parser), while `element` is a jsdom div the addon can
 * paint spans into. Works because XtermTerminal is structurally typed.
 *
 * Also carries the test-side mirror of Codeman's classifyPredictInput() and
 * codex composer gate (the real ones live in terminal-ui.js and are pinned by
 * the repo's Layer 4 vm tests; keep the two in sync).
 */
import { Terminal } from '@xterm/headless';
import type { XtermTerminal } from '../src/types.js';
// ?raw imports keep the jsdom environment free of node: builtins
import pasteBracketed from './fixtures/codex/paste-bracketed.jsonl?raw';
import slashPicker from './fixtures/codex/slash-picker.jsonl?raw';
import streamingBurst from './fixtures/codex/streaming-burst.jsonl?raw';
import trustModal from './fixtures/codex/trust-modal.jsonl?raw';
import typeHello from './fixtures/codex/type-hello.jsonl?raw';
import wrap from './fixtures/codex/wrap.jsonl?raw';

const FIXTURES: Record<string, string> = {
  'paste-bracketed': pasteBracketed,
  'slash-picker': slashPicker,
  'streaming-burst': streamingBurst,
  'trust-modal': trustModal,
  'type-hello': typeHello,
  wrap,
};

export const CELL_W = 9;
export const CELL_H = 18;

export interface FixtureLine {
  delayMs?: number;
  keyAt?: boolean;
  data: string;
}

export interface FixtureMeta {
  scenario: string;
  cols: number;
  rows: number;
  codexVersion: string;
  recordedAt: string;
}

export function loadFixture(name: string): { meta: FixtureMeta; lines: FixtureLine[] } {
  const content = FIXTURES[name];
  if (!content) throw new Error(`unknown fixture ${name}`);
  const raw = content
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  return { meta: raw[0] as FixtureMeta, lines: raw.slice(1) as FixtureLine[] };
}

export interface ReplayTerminal {
  hybrid: XtermTerminal;
  term: Terminal;
  write(data: string): Promise<void>;
  cursorRowText(): string;
  rowText(viewportRow: number): string;
  spanCount(): number;
  spans(): HTMLSpanElement[];
  cleanup(): void;
}

export function createReplayTerminal(cols: number, rows: number): ReplayTerminal {
  const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });

  const element = document.createElement('div');
  element.className = 'terminal xterm';
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'xterm-rows';
  element.appendChild(screen);
  screen.appendChild(rowsEl);
  document.body.appendChild(element);

  const hybrid = {
    element,
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    options: { fontFamily: 'monospace', fontSize: 14, fontWeight: 'normal', theme: {} },
    buffer: {
      active: {
        get viewportY() {
          return term.buffer.active.viewportY;
        },
        get baseY() {
          return term.buffer.active.baseY;
        },
        get cursorX() {
          return term.buffer.active.cursorX;
        },
        get cursorY() {
          return term.buffer.active.cursorY;
        },
        getLine: (y: number) => term.buffer.active.getLine(y),
      },
    },
    onWriteParsed: (cb: () => void) => term.onWriteParsed(cb),
    onResize: (cb: (s: { cols: number; rows: number }) => void) => term.onResize(cb),
    _core: {
      _renderService: {
        dimensions: {
          css: { cell: { width: CELL_W, height: CELL_H } },
          device: { char: { top: 0, height: CELL_H } },
        },
      },
    },
  };

  return {
    hybrid: hybrid as unknown as XtermTerminal,
    term,
    write: (data: string) => new Promise<void>((resolve) => term.write(data, () => resolve())),
    cursorRowText() {
      const b = term.buffer.active;
      return b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '';
    },
    rowText(viewportRow: number) {
      const b = term.buffer.active;
      return b.getLine(b.baseY + viewportRow)?.translateToString(true) ?? '';
    },
    spanCount() {
      return element.querySelectorAll('[data-predictive-echo] span').length;
    },
    spans() {
      return Array.from(element.querySelectorAll('[data-predictive-echo] span')) as HTMLSpanElement[];
    },
    cleanup() {
      term.dispose();
      element.remove();
    },
  };
}

// ─── Codeman-side mirrors (keep in sync with terminal-ui.js) ────────────

/** Mirror of window.CodemanTerminalInput.classifyPredictInput. */
export function classifyPredictInput(data: string): 'char' | 'backspace' | 'clear' | 'text' {
  const cps = Array.from(data);
  if (cps.length === 1) {
    const cp = cps[0].codePointAt(0)!;
    if (cp === 0x7f) return 'backspace';
    if (cp >= 0x20) return 'char';
    return 'clear';
  }
  if (data.charCodeAt(0) === 0x1b) return 'clear';
  if (data.charCodeAt(0) >= 0x20) return 'text';
  return 'clear';
}

/** Mirror of the codex composer-row gate (CODEX_COMPOSER_ROW_RE). */
export const CODEX_COMPOSER_ROW_RE = /^› /;

export function codexComposerGate(terminal: XtermTerminal): boolean {
  try {
    const buf = terminal.buffer.active;
    const line = buf.getLine(buf.baseY + (buf.cursorY ?? 0));
    return !!line && CODEX_COMPOSER_ROW_RE.test(line.translateToString(true));
  } catch {
    return false;
  }
}
