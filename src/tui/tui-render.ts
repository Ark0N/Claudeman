/**
 * @fileoverview Pure frame renderer: model + layout in, one string out.
 *
 * The frame is absolute-addressed, one `ESC [ <row>;1 H` per line followed by
 * `ESC [ K`, so nothing ever scrolls and a repaint cannot leave debris. The
 * caller wraps the result in synchronized-output brackets (DECSET 2026) where
 * the terminal supports it; that is an IO decision and stays out of here.
 *
 * Color is decided by the caller and passed in, never detected here: chalk's
 * auto-detection is the right answer for the one-shot CLI (see `cli-style.ts`)
 * but it would make a frame non-deterministic, and "same inputs, same string"
 * is what makes this module testable. The palette below is the same semantic
 * vocabulary chalk gives `cli-style` (ok green, warn yellow, err red, info
 * cyan, muted gray, emph bold), written as raw SGR so the mapping is fixed.
 *
 * With `color: false` the frame contains no escape sequences at all beyond the
 * cursor addressing that puts each line in place.
 *
 * @module tui/tui-render
 */

import { clipStyledLine, padDisplay, stripStyles, visibleWidth } from './tui-ansi.js';
import type { TuiLayout, TuiRect } from './tui-layout.js';
import type { TuiGlyphTier, TuiGroup, TuiRenderModel, TuiRow, TuiSessionRow, TuiSessionState } from './tui-types.js';

export interface TuiRenderOptions {
  /** Emit SGR color. False is NO_COLOR: cursor addressing and nothing else. */
  color: boolean;
  glyphs: TuiGlyphTier;
  /** Animation counter. The WORKING glyph cycles with it. */
  tick: number;
  /** Wall clock for elapsed times, passed in so a frame is reproducible. */
  now: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette and glyphs
// ─────────────────────────────────────────────────────────────────────────────

const SGR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

const STATE_COLOR: Record<TuiSessionState, string> = {
  'blocked-permission': SGR.red,
  'blocked-question': SGR.red,
  waiting: SGR.yellow,
  working: SGR.green,
  idle: SGR.gray,
  recent: SGR.gray,
};

export interface TuiGlyphSet {
  blockedPermission: string;
  blockedQuestion: string;
  waiting: string;
  /** WORKING animates through Claude's own glyph family, a deliberate nod. */
  working: readonly string[];
  idle: string;
  recent: string;
  cursor: string;
  rule: string;
  divider: string;
  boxTopLeft: string;
  boxTopRight: string;
  boxBottomLeft: string;
  boxBottomRight: string;
  boxHorizontal: string;
  boxVertical: string;
  enter: string;
  updown: string;
  separator: string;
  ellipsis: string;
}

const UNICODE_GLYPHS: TuiGlyphSet = {
  blockedPermission: '⚠',
  blockedQuestion: '⚠',
  waiting: '✋',
  working: ['·', '✢', '✳', '∗', '✻', '✽'],
  idle: '○',
  recent: '✔',
  cursor: '▶',
  rule: '─',
  divider: '│',
  boxTopLeft: '┌',
  boxTopRight: '┐',
  boxBottomLeft: '└',
  boxBottomRight: '┘',
  boxHorizontal: '─',
  boxVertical: '│',
  enter: '⏎',
  updown: '↑↓',
  separator: '·',
  ellipsis: '…',
};

/**
 * The lowest tier, for terminals that are not known-capable. Every state token
 * is three columns wide so rows still line up, mirroring what `sc` falls back
 * to today.
 */
const ASCII_GLYPHS: TuiGlyphSet = {
  blockedPermission: '[!]',
  blockedQuestion: '[?]',
  waiting: '[w]',
  working: ['[*]', '[+]', '[x]', '[+]'],
  idle: '[-]',
  recent: '[v]',
  cursor: '>',
  rule: '-',
  divider: '|',
  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+',
  boxHorizontal: '-',
  boxVertical: '|',
  enter: 'enter',
  updown: 'up/dn',
  separator: '-',
  ellipsis: '..',
};

/**
 * Glyphs for a tier. `nerd` currently renders like `unicode`: the tier exists
 * so detection has somewhere to land and a nerd-font-only set has a home,
 * without shipping glyphs nobody has reviewed on a real font.
 */
export function glyphsFor(tier: TuiGlyphTier): TuiGlyphSet {
  return tier === 'ascii' ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/**
 * Glyph tier from the environment. IO-ish by nature (it reads env), so it takes
 * the env as an argument and the app layer calls it once at startup. The
 * known-capable list is the same gate `scripts/tmux-chooser.sh` uses, plus a
 * UTF-8 locale check and an explicit override.
 */
export function detectGlyphTier(env: Record<string, string | undefined>): TuiGlyphTier {
  const override = env.CODEMAN_TUI_GLYPHS;
  if (override === 'ascii' || override === 'unicode' || override === 'nerd') return override;
  const term = env.TERM ?? '';
  if (term === '' || term === 'dumb') return 'ascii';
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (!/utf-?8/i.test(locale)) return 'ascii';
  const termProgram = env.TERM_PROGRAM ?? '';
  if (termProgram.startsWith('iTerm') || term === 'xterm-kitty' || env.WEZTERM_PANE || env.LC_TERMINAL === 'iTerm2') {
    return 'nerd';
  }
  return 'unicode';
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers (pure, exported for tests and for the app layer)
// ─────────────────────────────────────────────────────────────────────────────

/** Compact age: `45s`, `11m`, `2h`, `3d`. Empty when the anchor is unknown. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/** Compact token count: `842`, `45.2k`, `1.2M`. Empty when there is nothing to show. */
export function formatTokens(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '';
  if (total < 1000) return String(Math.floor(total));
  if (total < 1_000_000) return `${trimTrailingZero((total / 1000).toFixed(1))}k`;
  return `${trimTrailingZero((total / 1_000_000).toFixed(1))}M`;
}

/**
 * What a row is called. Same rule as the web history rows, including the
 * "(no content)" placeholder the transcript reader emits, which is not a title.
 */
export function rowLabel(session: TuiSessionRow): string {
  if (session.name) return session.name;
  const prompt = (session.firstPrompt ?? '').trim();
  if (prompt && prompt !== '(no content)') return prompt;
  const base = (session.workingDir ?? '').split('/').filter(Boolean).pop();
  return base || session.sessionId.slice(0, 8);
}

/** Keep the tail of a path: the last segments identify it, the root never does. */
function truncatePathLeft(path: string, width: number, ellipsis: string): string {
  if (width <= 0) return '';
  if (visibleWidth(path) <= width) return path;
  const keep = Math.max(0, width - visibleWidth(ellipsis));
  return ellipsis + path.slice(path.length - keep);
}

function tokensOf(session: TuiSessionRow): number {
  return (session.inputTokens ?? 0) + (session.outputTokens ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Painting
// ─────────────────────────────────────────────────────────────────────────────

type Painter = (text: string, code: string) => string;

function painterFor(enabled: boolean): Painter {
  return enabled ? (text, code) => (text === '' ? text : `${code}${text}${SGR.reset}`) : (text) => text;
}

function stateGlyph(row: TuiRow, glyphs: TuiGlyphSet, tick: number): string {
  switch (row.state) {
    case 'blocked-permission':
      return glyphs.blockedPermission;
    case 'blocked-question':
      return glyphs.blockedQuestion;
    case 'waiting':
      return glyphs.waiting;
    case 'working': {
      const frames = glyphs.working;
      const index = ((Math.trunc(tick) % frames.length) + frames.length) % frames.length;
      return frames[index];
    }
    case 'idle':
      return glyphs.idle;
    case 'recent':
      return glyphs.recent;
  }
}

function centered(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return padDisplay(`${' '.repeat(pad)}${text}`, width);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows and groups
// ─────────────────────────────────────────────────────────────────────────────

interface RowContext {
  width: number;
  /** 1-based position in the flattened list; only 1-9 get a jump digit. */
  index: number;
  selected: boolean;
  twoLine: boolean;
  glyphs: TuiGlyphSet;
  opts: TuiRenderOptions;
}

function renderRowLines(row: TuiRow, ctx: RowContext): string[] {
  // A selected row is one inverse-video block, so its parts are built unpainted:
  // an inner reset would punch a hole in the highlight.
  const inverse = ctx.selected && ctx.opts.color;
  const paint = painterFor(ctx.opts.color && !inverse);
  const { session } = row;

  const marker = ctx.selected ? padDisplay(ctx.glyphs.cursor, 2) : '  ';
  const digit = ctx.index >= 1 && ctx.index <= 9 ? `${ctx.index} ` : '  ';

  const glyph = paint(stateGlyph(row, ctx.glyphs, ctx.opts.tick), STATE_COLOR[row.state]);
  const elapsed = row.since > 0 ? formatElapsed(ctx.opts.now - row.since) : '';
  const tokens = formatTokens(tokensOf(session));
  const rightParts = [glyph, paint(elapsed, SGR.gray)];
  if (!ctx.twoLine && tokens) rightParts.push(paint(tokens, SGR.gray));
  const right = rightParts.filter((part) => part !== '').join(' ');

  const mode = session.mode && session.mode !== 'claude' ? session.mode : '';
  const nameWidth = Math.max(4, ctx.width - visibleWidth(marker + digit) - visibleWidth(right) - 1);
  const label = rowLabel(session);
  const name = mode ? `${label} ${paint(mode, SGR.magenta)}` : label;

  const first = padDisplay(`${marker}${digit}${padDisplay(name, nameWidth)} ${right}`, ctx.width);
  const lines = [first];

  if (ctx.twoLine) {
    const detail = [truncatePathLeft(session.workingDir ?? '', Math.max(0, ctx.width - 8), ctx.glyphs.ellipsis)];
    if (mode) detail.push(mode);
    if (tokens) detail.push(tokens);
    const text = detail.filter((part) => part !== '').join(` ${ctx.glyphs.separator} `);
    lines.push(padDisplay(`    ${paint(text, SGR.gray)}`, ctx.width));
  }

  return inverse ? lines.map((line) => `${SGR.inverse}${line}${SGR.reset}`) : lines;
}

function renderGroupHeader(group: TuiGroup, width: number, glyphs: TuiGlyphSet, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const label = ` ${group.label} `;
  const fill = Math.max(0, width - visibleWidth(label));
  return padDisplay(`${paint(label, SGR.bold)}${paint(glyphs.rule.repeat(fill), SGR.gray)}`, width);
}

export interface TuiListEntry {
  text: string;
  /** Set on the lines that belong to a session row, so the window can chase the cursor. */
  sessionId?: string;
}

function buildListEntries(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): TuiListEntry[] {
  const glyphs = glyphsFor(opts.glyphs);
  const width = layout.list.width;
  const entries: TuiListEntry[] = [];
  let index = 0;
  for (const group of model.groups()) {
    if (group.rows.length === 0) continue;
    entries.push({ text: renderGroupHeader(group, width, glyphs, opts) });
    for (const row of group.rows) {
      index++;
      const ctx: RowContext = {
        width,
        index,
        selected: row.session.sessionId === model.selectedId,
        twoLine: layout.rowHeight === 2,
        glyphs,
        opts,
      };
      for (const text of renderRowLines(row, ctx)) entries.push({ text, sessionId: row.session.sessionId });
    }
  }
  return entries;
}

/**
 * First visible entry, scrolling the minimum needed to keep the selected row on
 * screen. Deterministic on purpose: the window is derived, never remembered, so
 * two identical models render identically.
 */
export function computeListWindow(
  entries: readonly TuiListEntry[],
  capacity: number,
  selectedId: string | null
): number {
  if (capacity <= 0 || entries.length <= capacity) return 0;
  const maxStart = entries.length - capacity;
  if (!selectedId) return 0;
  const first = entries.findIndex((entry) => entry.sessionId === selectedId);
  if (first < 0) return 0;
  let last = first;
  while (last + 1 < entries.length && entries[last + 1].sessionId === selectedId) last++;
  let start = 0;
  if (last >= capacity) start = Math.min(last - capacity + 1, maxStart);
  if (first < start) start = first;
  return start;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

function buildPreviewLines(model: TuiRenderModel, rect: TuiRect, opts: TuiRenderOptions): string[] {
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const lines: string[] = [];
  const selected = model.selectedId
    ? (model
        .groups()
        .flatMap((group) => group.rows)
        .find((row) => row.session.sessionId === model.selectedId) ?? null)
    : null;

  if (!selected) {
    lines.push(padDisplay(paint(' no session selected', SGR.gray), rect.width));
  } else {
    const { session } = selected;
    const parts = [session.mode ?? 'claude', session.workingDir ?? ''].filter((part) => part !== '');
    const title = ` ${rowLabel(session)} ${glyphs.separator} ${parts.join(` ${glyphs.separator} `)}`;
    lines.push(padDisplay(paint(clipStyledLine(title, rect.width), SGR.bold), rect.width));
  }

  const body = previewBody(model, selected, rect, opts);
  for (const line of body) lines.push(line);
  while (lines.length < rect.height) lines.push(' '.repeat(rect.width));
  return lines.slice(0, Math.max(0, rect.height));
}

function previewBody(model: TuiRenderModel, selected: TuiRow | null, rect: TuiRect, opts: TuiRenderOptions): string[] {
  const paint = painterFor(opts.color);
  const capacity = Math.max(0, rect.height - 1);
  if (capacity === 0) return [];
  const hint = (text: string): string[] => [padDisplay(paint(` ${text}`, SGR.gray), rect.width)];

  if (!selected) return [];
  if (model.connection === 'degraded' || model.connection === 'down') {
    return hint('preview unavailable while the server is down');
  }
  const preview = model.preview;
  if (!preview || preview.sessionId !== selected.session.sessionId) return hint('loading preview…');
  if (preview.error) return hint(preview.error);

  const trimmed = [...preview.lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
  if (trimmed.length === 0) return hint('(no output yet)');
  // The tail carries the session's OWN colors, which is the point of the pane,
  // but under NO_COLOR they must go too.
  return trimmed
    .slice(-capacity)
    .map((line) => padDisplay(` ${clipStyledLine(opts.color ? line : stripStyles(line), rect.width - 1)}`, rect.width));
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome
// ─────────────────────────────────────────────────────────────────────────────

function renderHeaderLine(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const { hostname, instance, version, planUsage } = model.header;
  const facts = [
    instance ? `${hostname ?? ''}:${instance}` : (hostname ?? ''),
    version ? `v${version}` : '',
    `${model.sessionCount} session${model.sessionCount === 1 ? '' : 's'}`,
    planUsage ?? '',
  ].filter((part) => part !== '');

  const left = ` ${paint('codeman', SGR.bold)}  ${paint(facts.join(` ${glyphs.separator} `), SGR.gray)}`;
  const right = paint('? help  q quit ', SGR.gray);
  const gap = layout.cols - visibleWidth(left) - visibleWidth(right);
  if (gap < 1) return padDisplay(left, layout.cols);
  return `${left}${' '.repeat(gap)}${right}`;
}

function renderBannerLine(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const [text, color] =
    model.connection === 'degraded'
      ? ['server not running: attach only', SGR.yellow]
      : model.connection === 'reconnecting'
        ? ['reconnecting to the server…', SGR.yellow]
        : ['server unreachable', SGR.red];
  return padDisplay(paint(` ${glyphs.blockedPermission} ${text}`, color), layout.cols);
}

const FOOTER_KEYS: Record<string, (glyphs: TuiGlyphSet) => string> = {
  list: (g) =>
    [
      `${g.updown} select`,
      `${g.enter} attach`,
      '1-9 jump',
      'y/n answer',
      'p prompt',
      'n new',
      'x kill',
      '/ search',
      'g digest',
      '? help',
      'q quit',
    ].join(` ${g.separator} `),
  help: (g) => `esc ${g.separator} ? close`,
  'confirm-kill': (g) => `type the name ${g.separator} ${g.enter} confirm ${g.separator} esc cancel`,
  message: () => 'esc dismiss',
  prompt: (g) => `${g.enter} send ${g.separator} esc cancel`,
  search: (g) => `${g.enter} open ${g.separator} esc cancel`,
};

function renderFooterLine(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const build = FOOTER_KEYS[model.mode] ?? FOOTER_KEYS.list;
  return padDisplay(paint(clipStyledLine(` ${build(glyphs)}`, layout.cols), SGR.gray), layout.cols);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlays
// ─────────────────────────────────────────────────────────────────────────────

interface OverlayContent {
  title: string;
  lines: string[];
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (visibleWidth(candidate) > width && line !== '') {
      out.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') out.push(line);
  return out.length > 0 ? out : [''];
}

function helpLines(glyphs: TuiGlyphSet): string[] {
  const pairs: Array<[string, string]> = [
    [`${glyphs.updown} / j k`, 'select'],
    [glyphs.enter, 'attach'],
    ['1-9', 'jump'],
    ['y / n', 'answer the pending approval'],
    ['p', 'send a prompt'],
    ['n', 'new session'],
    ['x', 'kill (typed confirmation)'],
    ['/', 'search'],
    ['g', 'away digest'],
    ['r', 'resume a recent session'],
    ['?', 'this help'],
    ['q', 'quit'],
  ];
  const keyWidth = Math.max(...pairs.map(([key]) => visibleWidth(key)));
  return pairs.map(([key, description]) => `${padDisplay(key, keyWidth)}  ${description}`);
}

function overlayContent(model: TuiRenderModel, opts: TuiRenderOptions, width: number): OverlayContent | null {
  const glyphs = glyphsFor(opts.glyphs);
  switch (model.mode) {
    case 'help':
      return { title: 'Keys', lines: helpLines(glyphs) };
    case 'confirm-kill': {
      if (!model.confirm) return null;
      const { name, typed } = model.confirm;
      return {
        title: 'Kill session',
        lines: [`Kill ${name}?`, '', 'Type the name to confirm:', `  ${typed}_`],
      };
    }
    case 'message':
      if (!model.message) return null;
      return {
        title: model.message.tone === 'err' ? 'Error' : model.message.tone === 'warn' ? 'Warning' : 'Notice',
        lines: wrapText(model.message.text, Math.max(8, width - 8)),
      };
    default:
      return null;
  }
}

/** Paint an overlay box over the body, centered, replacing whole terminal rows. */
function applyOverlay(lines: string[], model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): void {
  const body = layout.body;
  if (body.height < 3 || body.width < 12) return;
  const content = overlayContent(model, opts, body.width);
  if (!content) return;

  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const maxInner = body.width - 4;
  const visible = content.lines.slice(0, Math.max(1, body.height - 2));
  const inner = Math.min(
    maxInner,
    Math.max(visibleWidth(content.title) + 2, ...visible.map((line) => visibleWidth(line)))
  );
  const boxWidth = inner + 4;
  const boxHeight = visible.length + 2;
  const left = body.col + Math.max(0, Math.floor((body.width - boxWidth) / 2));
  const top = body.row + Math.max(0, Math.floor((body.height - boxHeight) / 2));

  const titleText = ` ${content.title} `;
  const titleFill = Math.max(0, inner + 2 - visibleWidth(titleText));
  const boxLines = [
    `${glyphs.boxTopLeft}${titleText}${glyphs.boxHorizontal.repeat(titleFill)}${glyphs.boxTopRight}`,
    ...visible.map((line) => `${glyphs.boxVertical} ${padDisplay(line, inner)} ${glyphs.boxVertical}`),
    `${glyphs.boxBottomLeft}${glyphs.boxHorizontal.repeat(inner + 2)}${glyphs.boxBottomRight}`,
  ];

  for (let i = 0; i < boxLines.length; i++) {
    const row = top + i - 1;
    if (row < 0 || row >= lines.length) continue;
    lines[row] = `${' '.repeat(left - 1)}${paint(boxLines[i], SGR.cyan)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame
// ─────────────────────────────────────────────────────────────────────────────

function writeBody(lines: string[], model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): void {
  const { list, preview, divider } = layout;
  if (list.height <= 0) return;
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);

  const entries = buildListEntries(model, layout, opts);
  if (entries.length === 0) {
    const hint = paint('No sessions. n to start one, q to quit.', SGR.gray);
    const row = list.row + Math.floor((list.height - 1) / 2);
    lines[row - 1] = centered(hint, layout.cols);
    return;
  }

  const start = computeListWindow(entries, list.height, model.selectedId);
  const previewLines = preview ? buildPreviewLines(model, preview, opts) : [];

  for (let i = 0; i < list.height; i++) {
    const left = entries[start + i]?.text ?? ' '.repeat(list.width);
    if (!preview || !divider) {
      lines[list.row - 1 + i] = left;
      continue;
    }
    const right = previewLines[i] ?? ' '.repeat(preview.width);
    lines[list.row - 1 + i] = `${left}${paint(glyphs.divider, SGR.gray)}${right}`;
  }
}

/**
 * The whole frame as one string: absolute cursor addressing per line, each line
 * closed with an erase-to-end so a shorter line cannot leave the previous
 * frame's tail behind.
 */
export function renderFrame(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): string {
  const lines: string[] = new Array<string>(layout.rows).fill('');
  lines[0] = renderHeaderLine(model, layout, opts);
  if (layout.banner) lines[layout.banner.row - 1] = renderBannerLine(model, layout, opts);
  writeBody(lines, model, layout, opts);
  if (layout.footer.height > 0) lines[layout.footer.row - 1] = renderFooterLine(model, layout, opts);
  applyOverlay(lines, model, layout, opts);

  let frame = '';
  for (let i = 0; i < lines.length; i++) {
    frame += `\x1b[${i + 1};1H${clipStyledLine(lines[i], layout.cols)}\x1b[K`;
  }
  return frame;
}
