/**
 * @fileoverview `codeman tui`: the full-screen dashboard plus the two
 * non-interactive fast paths (`--list`, `<n>`).
 *
 * This is the IO half of `src/tui/`: it owns the terminal, the timers, stdin
 * and the tmux handoff. Every decision it makes that can be stated as a
 * function of its inputs lives at the top of this file as an exported pure
 * helper (attach planning, the kill confirmation, footer selection, the
 * repaint test, degraded-row building), because none of those can be tested
 * through a real terminal.
 *
 * TERMINAL LIFECYCLE is the part users judge. A TUI that dies leaving the
 * terminal in raw mode with a hidden cursor is unusable until the user types a
 * blind `reset`, so `leave()` is idempotent and runs from every exit path there
 * is: normal quit, SIGINT/SIGTERM, and a `process.on('exit')` backstop that
 * fires even when someone else's handler calls `process.exit()`. The fatal
 * handlers are installed with `prependListener` on purpose: `src/index.ts`
 * already handles `uncaughtException` by exiting, and a listener registered
 * after it would never run.
 *
 * ATTACH is a handoff, never a proxy: the screen is fully restored and tmux
 * gets the real terminal (`stdio: 'inherit'`), so mouse, paste and colors are
 * tmux's own. Inside tmux on the same socket there is nothing to hand off to,
 * so the TUI issues `switch-client` and EXITS: the client it would draw on is
 * now showing the target session, and a dashboard nobody can see must not keep
 * polling the server.
 *
 * REPAINT POLICY: on state change (the model's revision), on resize, and on a
 * 500ms tick that runs only while a WORKING row is on screen (the glyph
 * animates). An idle dashboard writes nothing at all.
 *
 * NOT HERE YET (phase 2 of docs/tui-plan.md): the preview pane's live tail,
 * answering approvals, the prompt composer, search and the away digest. The
 * seams are in place (the preview region renders a placeholder, the client
 * already carries the calls) and the footer advertises only what works.
 *
 * @module tui/tui-app
 */

import { spawnSync } from 'node:child_process';
import { hostname as osHostname } from 'node:os';
import chalk from 'chalk';
import { palette, table, tint, type Tone } from '../cli-style.js';
import { CODEMAN_INSTANCE, resolveTmuxSocketName } from '../config/instance.js';
import { getErrorMessage } from '../types/api.js';
import { TuiClient, type TuiEventStream, type TuiQuickStartOptions, type TuiTmuxSession } from './tui-client.js';
import { createKeyParser, type TuiInputEvent, type TuiKeyParser } from './tui-keys.js';
import { computeLayout, needsBanner } from './tui-layout.js';
import { createTuiModel, type TuiModelStore } from './tui-model.js';
import { detectGlyphTier, glyphsFor, renderFrame, rowLabel, type TuiGlyphSet } from './tui-render.js';
import type { TuiRenderOptions } from './tui-render.js';
import type {
  TuiConfirmState,
  TuiGlyphTier,
  TuiPickerItem,
  TuiRow,
  TuiSessionRow,
  TuiSessionState,
  TuiUiMode,
} from './tui-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Timing
// ─────────────────────────────────────────────────────────────────────────────

/** How long a lone ESC waits for the rest of a sequence before it counts as Escape. */
const ESC_FLUSH_MS = 30;
/** Animation period. Two frames a second is what the plan's WORKING glyph asks for. */
const TICK_MS = 500;
/** A burst of SSE events (one session change fans out to several) becomes one refetch. */
const RESYNC_DEBOUNCE_MS = 250;
/** Poll period once the client reports SSE is not carrying events. */
const POLL_INTERVAL_MS = 2_000;
/** Degraded mode re-probes this often, so a server that starts upgrades the TUI live. */
const REPROBE_INTERVAL_MS = 10_000;
/** Unified-list page size. RECENT is capped far lower by the model. */
const UNIFIED_LIMIT = 60;

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
/** DECSET 2026: terminals that know it show the frame atomically, the rest ignore it. */
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

// ─────────────────────────────────────────────────────────────────────────────
// Attach planning (pure)
// ─────────────────────────────────────────────────────────────────────────────

export type TuiAttachRefusal = 'no-mux-name' | 'nested-foreign-socket';

export type TuiAttachPlan =
  | { kind: 'attach'; file: string; args: string[]; hint: string }
  | { kind: 'switch'; file: string; args: string[] }
  | { kind: 'refuse'; reason: TuiAttachRefusal; message: string };

export interface TuiAttachContext {
  /** This instance's tmux socket name (`-L`). */
  socket: string;
  /** `$TMUX` as tmux sets it inside a pane: `<socket path>,<pid>,<session index>`. */
  tmux?: string;
}

/**
 * The socket NAME behind a `$TMUX` value, or null when we are not inside tmux.
 * tmux itself splits the variable on commas, so the path can be taken as
 * everything before the first one; `-L <name>` sockets live in one directory
 * per user, which makes the basename the name we compare against.
 */
export function tmuxSocketFromEnv(tmux: string | undefined): string | null {
  const raw = (tmux ?? '').trim();
  if (!raw) return null;
  const path = raw.split(',')[0];
  const name = path.split('/').filter(Boolean).pop();
  return name ?? null;
}

/**
 * How to reach a session's pane from where we are standing.
 *
 * Nesting is the case worth spelling out: inside tmux on a FOREIGN socket an
 * attach would either be refused by tmux or produce a terminal inside a
 * terminal whose prefix keys collide, so the TUI explains the situation instead
 * of trying.
 */
export function planAttach(muxName: string | undefined, context: TuiAttachContext): TuiAttachPlan {
  const name = (muxName ?? '').trim();
  if (!name) {
    return {
      kind: 'refuse',
      reason: 'no-mux-name',
      message: 'that session has no tmux pane to attach to (it is history, or it runs on a direct PTY)',
    };
  }
  const inside = tmuxSocketFromEnv(context.tmux);
  if (inside === null) {
    return {
      kind: 'attach',
      file: 'tmux',
      args: ['-L', context.socket, 'attach-session', '-t', name],
      hint: 'detach with Ctrl+B D to come back',
    };
  }
  if (inside === context.socket) {
    return { kind: 'switch', file: 'tmux', args: ['-L', context.socket, 'switch-client', '-t', name] };
  }
  return {
    kind: 'refuse',
    reason: 'nested-foreign-socket',
    message:
      `this terminal is already inside tmux on socket "${inside}", and Codeman's sessions live on "${context.socket}". ` +
      'Detach first (Ctrl+B D), then run codeman tui again.',
  };
}

/**
 * Is this the session the TUI itself runs in? Codeman exports
 * `CODEMAN_SESSION_ID` into every managed pane, and killing that one would take
 * the TUI down with it. Ids reach agents truncated, so either side may be the
 * prefix; anything shorter than 8 characters is not identification.
 */
export function isSelfSession(sessionId: string, env: { CODEMAN_SESSION_ID?: string } = {}): boolean {
  const self = (env.CODEMAN_SESSION_ID ?? '').trim();
  if (self.length < 8 || sessionId.length < 8) return false;
  return sessionId.startsWith(self) || self.startsWith(sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Kill confirmation (pure)
// ─────────────────────────────────────────────────────────────────────────────

export type TuiConfirmStep =
  | { kind: 'typing'; typed: string }
  | { kind: 'confirm' }
  | { kind: 'reject' }
  | { kind: 'cancel' }
  | { kind: 'ignore' };

/** Does the typed text authorize the kill? The shown name, or the id prefix a mux name carries. */
export function confirmAccepts(state: TuiConfirmState, typed = state.typed): boolean {
  const value = typed.trim();
  if (value === '') return false;
  return value === state.name || value === state.sessionId.slice(0, 8);
}

/**
 * One keystroke of the typed confirmation. Enter on text that does not match is
 * a `reject`, never a silent no-op: a confirmation that appears to do nothing
 * reads as a broken key.
 */
export function confirmKillStep(state: TuiConfirmState, event: TuiInputEvent): TuiConfirmStep {
  switch (event.type) {
    case 'char':
      return { kind: 'typing', typed: state.typed + event.value };
    case 'backspace':
      return { kind: 'typing', typed: [...state.typed].slice(0, -1).join('') };
    case 'enter':
      return confirmAccepts(state) ? { kind: 'confirm' } : { kind: 'reject' };
    case 'escape':
      return { kind: 'cancel' };
    case 'ctrl':
      return event.key === 'c' ? { kind: 'cancel' } : { kind: 'ignore' };
    default:
      return { kind: 'ignore' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface TuiKeymapContext {
  /** False in degraded mode, where the only verb that works is attach. */
  server: boolean;
}

/**
 * The footer keys for a mode. This is the honest inventory of what the build
 * actually does, not the plan's full keymap: a footer advertising `p prompt`
 * before the composer exists teaches users that the TUI ignores keys.
 */
export function footerKeysFor(mode: TuiUiMode, glyphs: TuiGlyphSet, context: TuiKeymapContext): string[] {
  switch (mode) {
    case 'help':
      return ['esc close'];
    case 'confirm-kill':
      return ['type the name', `${glyphs.enter} confirm`, 'esc cancel'];
    case 'message':
      return ['esc dismiss'];
    case 'new-session':
      return [`${glyphs.updown} select`, `${glyphs.enter} choose`, 'type to filter', 'esc cancel'];
    case 'prompt':
    case 'search':
      return ['esc cancel'];
    case 'list':
      return context.server
        ? [`${glyphs.updown} select`, `${glyphs.enter} attach`, '1-9 jump', 'n new', 'x kill', '? help', 'q quit']
        : [`${glyphs.updown} select`, `${glyphs.enter} attach`, '1-9 jump', '? help', 'q quit'];
  }
}

/**
 * The help overlay's rows, for the same reason `footerKeysFor` exists: a help
 * screen listing verbs the build does not implement is worse than no help.
 */
export function helpKeysFor(glyphs: TuiGlyphSet, context: TuiKeymapContext): Array<[string, string]> {
  const keys: Array<[string, string]> = [
    [`${glyphs.updown} / j k`, 'select'],
    [glyphs.enter, 'attach'],
    ['1-9', 'jump and attach'],
  ];
  if (context.server) keys.push(['n', 'new session'], ['x', 'kill (typed confirmation)']);
  keys.push(['?', 'this help'], ['esc', 'close an overlay'], ['q', 'quit']);
  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repaint policy (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a frame depends on, cheap enough to compare on every event. */
export interface TuiFrameKey {
  revision: number;
  cols: number;
  rows: number;
  tick: number;
}

export function sameFrame(previous: TuiFrameKey | null, next: TuiFrameKey): boolean {
  return (
    previous !== null &&
    previous.revision === next.revision &&
    previous.cols === next.cols &&
    previous.rows === next.rows &&
    previous.tick === next.tick
  );
}

/** Only a WORKING row animates, so only a WORKING row justifies a tick timer. */
export function shouldAnimate(rows: readonly TuiRow[]): boolean {
  return rows.some((row) => row.state === 'working');
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * tmux sessions as dashboard rows, for when no server answered.
 *
 * They are tagged `live` deliberately: a running pane is the only liveness
 * evidence that exists without a server, and the alternative (no `live` source)
 * would classify every attachable session as history and file it under RECENT.
 * With no classification running they land in IDLE, which is honest: unknown
 * state, still attachable.
 */
export function tmuxRowsToSessions(sessions: readonly TuiTmuxSession[]): TuiSessionRow[] {
  return sessions.map((session) => ({
    sessionId: session.sessionId ?? session.muxName,
    muxName: session.muxName,
    sources: ['live', 'mux'],
    ...(session.name ? { name: session.name } : {}),
    ...(session.mode ? { mode: session.mode } : {}),
    ...(session.workingDir ? { workingDir: session.workingDir } : {}),
    ...(session.createdAt ? { createdAt: session.createdAt, lastActivityAt: session.createdAt } : {}),
  }));
}

/**
 * Stamp each row with the tmux session that backs it. The mux name carries only
 * the first 8 characters of the session id (`codeman-<prefix>`), so the join is
 * by prefix; a row that matches nothing keeps no mux name and cannot be
 * attached, which is exactly what the attach path then reports.
 */
export function applyMuxNames(sessions: readonly TuiSessionRow[], tmux: readonly TuiTmuxSession[]): TuiSessionRow[] {
  if (tmux.length === 0) return sessions.map((session) => ({ ...session }));
  return sessions.map((session) => {
    const match = tmux.find(
      (entry) => entry.sessionId === session.sessionId || session.sessionId.startsWith(entry.sessionIdPrefix)
    );
    return match ? { ...session, muxName: match.muxName } : { ...session };
  });
}

const STATE_WORD: Record<TuiSessionState, string> = {
  'blocked-permission': 'blocked',
  'blocked-question': 'blocked',
  waiting: 'waiting',
  working: 'working',
  idle: 'idle',
  recent: 'done',
};

const STATE_TONE: Record<TuiSessionState, Tone> = {
  'blocked-permission': 'err',
  'blocked-question': 'err',
  waiting: 'warn',
  working: 'ok',
  idle: 'idle',
  recent: 'idle',
};

export interface TuiListLine {
  /** 1-based position, the same number `codeman tui <n>` takes. */
  index: number;
  state: TuiSessionState;
  label: string;
  workingDir: string;
}

/**
 * Label column cap. History rows are labelled by their opening prompt, and one
 * long prompt pads every other row of the table out to its width.
 */
const LIST_LABEL_WIDTH = 48;

function truncateLabel(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

/** `--list` rows, in the dashboard's own order so `<n>` and the TUI agree. */
export function buildListLines(rows: readonly TuiRow[], labelWidth = LIST_LABEL_WIDTH): TuiListLine[] {
  return rows.map((row, i) => ({
    index: i + 1,
    state: row.state,
    label: truncateLabel(rowLabel(row.session), labelWidth),
    workingDir: row.session.workingDir ?? '',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Session modes offered by the new-session picker
// ─────────────────────────────────────────────────────────────────────────────

type TuiRunMode = NonNullable<TuiQuickStartOptions['mode']>;

const MODE_ITEMS: ReadonlyArray<{ id: TuiRunMode; label: string; detail: string }> = [
  { id: 'claude', label: 'claude', detail: 'Claude Code' },
  { id: 'shell', label: 'shell', detail: 'plain shell' },
  { id: 'opencode', label: 'opencode', detail: 'OpenCode' },
  { id: 'codex', label: 'codex', detail: 'OpenAI Codex' },
  { id: 'gemini', label: 'gemini', detail: 'Google Gemini' },
  { id: 'antigravity', label: 'antigravity', detail: 'Google Antigravity' },
  { id: 'pi', label: 'pi', detail: 'pi.dev' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Terminal
// ─────────────────────────────────────────────────────────────────────────────

/** The slices of stdin/stdout the TUI uses; `process.stdin`/`stdout` satisfy both. */
export interface TuiStdin extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TuiStdout {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): unknown;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

/**
 * Alternate screen + raw mode, entered and left as one unit. `leave()` is
 * idempotent and safe to call from a signal handler, an exit hook and the
 * normal path in any order.
 */
class TerminalScreen {
  private entered = false;

  constructor(
    private readonly stdin: TuiStdin,
    private readonly stdout: TuiStdout,
    private readonly onResize: () => void
  ) {}

  get active(): boolean {
    return this.entered;
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.stdout.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
    if (this.stdin.isTTY) this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this.stdout.on('resize', this.onResize);
  }

  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    this.stdout.off('resize', this.onResize);
    if (this.stdin.isTTY) this.stdin.setRawMode?.(false);
    this.stdin.pause();
    this.stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The app
// ─────────────────────────────────────────────────────────────────────────────

export interface TuiRunOptions {
  stdin?: TuiStdin;
  stdout?: TuiStdout;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests; the default builds one from the environment. */
  client?: TuiClient;
  /** Overrides chalk's detection. Chalk owns it everywhere else (see cli-style). */
  color?: boolean;
}

interface PickerRuntime {
  stage: 'case' | 'mode';
  caseName?: string;
  /** Unfiltered items; the model holds the filtered view the renderer paints. */
  all: TuiPickerItem[];
}

class TuiApp {
  private readonly model: TuiModelStore = createTuiModel();
  private readonly parser: TuiKeyParser = createKeyParser();
  private readonly screen: TerminalScreen;
  private readonly stdin: TuiStdin;
  private readonly stdout: TuiStdout;
  private readonly env: NodeJS.ProcessEnv;
  private readonly client: TuiClient;
  private readonly color: boolean;
  private readonly glyphTier: TuiGlyphTier;
  private readonly glyphs: TuiGlyphSet;
  private readonly socket = resolveTmuxSocketName();

  private stream: TuiEventStream | null = null;
  private tick = 0;
  private lastFrame: TuiFrameKey | null = null;
  private escTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private refreshQueued = false;
  private picker: PickerRuntime | null = null;
  private pendingSelectId: string | null = null;
  private exiting = false;
  private resolveExit: ((code: number) => void) | null = null;

  private readonly onData = (chunk: Buffer): void => this.feed(chunk);
  private readonly onResize = (): void => this.paint(true);
  private readonly onProcessExit = (): void => this.screen.leave();
  private readonly onSignal = (): void => this.quit(0);
  private readonly onFatal = (error: unknown): void => {
    this.screen.leave();
    process.stderr.write(`codeman tui: ${getErrorMessage(error)}\n`);
    if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  };

  constructor(options: TuiRunOptions) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.env = options.env ?? process.env;
    this.client = options.client ?? new TuiClient();
    this.color = options.color ?? chalk.level > 0;
    this.glyphTier = detectGlyphTier(this.env);
    this.glyphs = glyphsFor(this.glyphTier);
    this.screen = new TerminalScreen(this.stdin, this.stdout, this.onResize);
  }

  async run(): Promise<number> {
    const server = await this.client.connect();
    if (server?.authRequired) {
      this.client.close();
      process.stderr.write(
        `${palette.err('The Codeman server rejected these credentials.')}\n` +
          `Set ${palette.info('CODEMAN_PASSWORD')} (and ${palette.info('CODEMAN_USERNAME')} if it is not "admin"), ` +
          'or put them in ~/.codeman/.env, then run codeman tui again.\n'
      );
      return 1;
    }

    if (server) {
      this.model.setConnection('connected');
      this.model.setHeader({
        ...(server.hostname ? { hostname: server.hostname } : {}),
        ...(server.instance ? { instance: server.instance } : {}),
        ...(server.version ? { version: server.version } : {}),
      });
    } else {
      this.model.setConnection('degraded');
      // No server to name the machine, and tmux is local by definition.
      this.model.setHeader({
        hostname: osHostname(),
        ...(CODEMAN_INSTANCE ? { instance: CODEMAN_INSTANCE } : {}),
      });
      this.startProbing();
    }

    this.installSafetyNets();
    this.stdin.on('data', this.onData);
    this.screen.enter();
    this.paint(true);

    await this.refresh();
    if (server) this.subscribe();

    return new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private subscribe(): void {
    this.stream = this.client.subscribeEvents({
      onInit: (state) => {
        if (state.version) this.model.setHeader({ version: state.version });
        this.paint();
      },
      onResync: () => this.scheduleRefresh(),
      onApproval: () => this.scheduleRefresh(),
      onStatus: (status, detail) => {
        this.model.setConnection(status === 'connected' ? 'connected' : 'reconnecting');
        if (detail.recommendPolling) this.startPolling();
        else this.stopPolling();
        if (status === 'connected') this.scheduleRefresh();
        this.paint();
      },
    });
  }

  private scheduleRefresh(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      void this.refresh();
    }, RESYNC_DEBOUNCE_MS);
  }

  /**
   * Re-read everything the dashboard shows. Overlapping calls collapse: a burst
   * of events must not queue a burst of round trips, and the last one has to
   * still run or the list would sit one change behind.
   */
  private async refresh(): Promise<void> {
    if (this.exiting) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      if (this.model.connection === 'degraded') await this.refreshDegraded();
      else await this.refreshConnected();
    } finally {
      this.refreshing = false;
    }
    if (this.refreshQueued && !this.exiting) {
      this.refreshQueued = false;
      await this.refresh();
    }
  }

  private async refreshConnected(): Promise<void> {
    try {
      const [sessions, approvals, tmux] = await Promise.all([
        this.client.fetchUnifiedSessions(UNIFIED_LIMIT),
        this.client.fetchApprovals().catch(() => []),
        this.client.enumerateTmuxSessions().catch(() => [] as TuiTmuxSession[]),
      ]);
      this.model.replaceSessions(applyMuxNames(sessions, tmux));
      this.model.setApprovals(approvals);
      if (this.pendingSelectId && this.model.select(this.pendingSelectId)) this.pendingSelectId = null;
      this.syncPreviewPlaceholder();
      this.paint();
    } catch (error) {
      // A failed refresh is a connection symptom, not a reason to lose the list:
      // the rows on screen stay, the banner explains why they may be stale.
      this.model.setConnection('reconnecting');
      this.paint();
      if (this.env.CODEMAN_TUI_DEBUG) process.stderr.write(`refresh failed: ${getErrorMessage(error)}\n`);
    }
  }

  private async refreshDegraded(): Promise<void> {
    const tmux = await this.client.enumerateTmuxSessions().catch(() => [] as TuiTmuxSession[]);
    this.model.replaceSessions(tmuxRowsToSessions(tmux));
    this.syncPreviewPlaceholder();
    this.paint();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Degraded mode: re-probe so a server that comes up upgrades the TUI in place. */
  private startProbing(): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => void this.probe(), REPROBE_INTERVAL_MS);
  }

  private async probe(): Promise<void> {
    if (this.exiting || this.model.connection !== 'degraded') return;
    const server = await this.client.connect().catch(() => null);
    if (!server || server.authRequired) {
      await this.refresh();
      return;
    }
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    this.model.setConnection('connected');
    this.model.setHeader({
      ...(server.hostname ? { hostname: server.hostname } : {}),
      ...(server.instance ? { instance: server.instance } : {}),
      ...(server.version ? { version: server.version } : {}),
    });
    await this.refresh();
    this.subscribe();
  }

  /**
   * The preview pane is phase 2. Until then the selected row still gets a
   * preview object, so the pane says what it is instead of claiming to load
   * something forever.
   */
  private syncPreviewPlaceholder(): void {
    const selected = this.model.selectedId;
    if (!selected) {
      if (this.model.preview) this.model.setPreview(null);
      return;
    }
    if (this.model.preview?.sessionId === selected) return;
    this.model.setPreview({ sessionId: selected, lines: [], error: 'live preview is not wired up yet' });
  }

  // ── Painting ───────────────────────────────────────────────────────────────

  private paint(force = false): void {
    if (this.exiting || !this.screen.active) return;
    const cols = this.stdout.columns ?? 80;
    const rows = this.stdout.rows ?? 24;
    const key: TuiFrameKey = { revision: this.model.revision, cols, rows, tick: this.tick };
    if (!force && sameFrame(this.lastFrame, key)) return;
    this.lastFrame = key;

    const layout = computeLayout(cols, rows, { banner: needsBanner(this.model.connection) });
    const keymap: TuiKeymapContext = { server: this.model.connection !== 'degraded' };
    const options: TuiRenderOptions = {
      color: this.color,
      glyphs: this.glyphTier,
      tick: this.tick,
      now: Date.now(),
      footerKeys: footerKeysFor(this.model.mode, this.glyphs, keymap),
      helpKeys: helpKeysFor(this.glyphs, keymap),
    };
    this.stdout.write(`${SYNC_BEGIN}${renderFrame(this.model, layout, options)}${SYNC_END}`);
    this.syncAnimation();
  }

  private syncAnimation(): void {
    const wanted = shouldAnimate(this.model.rows());
    if (wanted && !this.tickTimer) {
      this.tickTimer = setInterval(() => {
        this.tick++;
        this.paint();
      }, TICK_MS);
      return;
    }
    if (!wanted && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private feed(chunk: Buffer): void {
    for (const event of this.parser.feed(chunk)) this.handle(event);
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    // A held ESC is either a lone Escape or the head of a sequence still in
    // flight; only silence tells the two apart.
    if (this.parser.pending() > 0) {
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        for (const event of this.parser.flush()) this.handle(event);
        this.paint();
      }, ESC_FLUSH_MS);
    }
    this.paint();
  }

  private handle(event: TuiInputEvent): void {
    if (this.exiting) return;
    switch (this.model.mode) {
      case 'confirm-kill':
        this.handleConfirm(event);
        return;
      case 'new-session':
        this.handlePicker(event);
        return;
      case 'help':
      case 'message':
        // Any key dismisses; the footer says esc because that is the one key
        // every overlay in the app answers to.
        if (event.type !== 'mouse') this.model.closeOverlay();
        return;
      default:
        this.handleList(event);
    }
  }

  private handleList(event: TuiInputEvent): void {
    switch (event.type) {
      case 'key':
        if (event.name === 'up') this.model.moveCursor(-1);
        else if (event.name === 'down') this.model.moveCursor(1);
        else if (event.name === 'pageup') this.model.moveCursor(-5);
        else if (event.name === 'pagedown') this.model.moveCursor(5);
        else return;
        this.syncPreviewPlaceholder();
        return;
      case 'enter':
        void this.attachSelected();
        return;
      case 'ctrl':
        if (event.key === 'c') this.quit(0);
        return;
      case 'char':
        this.handleListChar(event.value);
        return;
      default:
        return;
    }
  }

  private handleListChar(value: string): void {
    if (value >= '1' && value <= '9') {
      if (this.model.cursorToIndex(Number.parseInt(value, 10))) {
        this.syncPreviewPlaceholder();
        void this.attachSelected();
      }
      return;
    }
    switch (value) {
      case 'j':
        this.model.moveCursor(1);
        this.syncPreviewPlaceholder();
        return;
      case 'k':
        this.model.moveCursor(-1);
        this.syncPreviewPlaceholder();
        return;
      case 'q':
        this.quit(0);
        return;
      case '?':
        this.model.setMode('help');
        return;
      case 'x':
        this.beginKill();
        return;
      case 'n':
        void this.openNewSession();
        return;
      default:
        return;
    }
  }

  private handleConfirm(event: TuiInputEvent): void {
    const state = this.model.confirm;
    if (!state) {
      this.model.closeOverlay();
      return;
    }
    const step = confirmKillStep(state, event);
    switch (step.kind) {
      case 'typing':
        this.model.setConfirmInput(step.typed);
        return;
      case 'cancel':
        this.model.closeOverlay();
        return;
      case 'reject':
        this.message('warn', `type "${state.name}" exactly, or esc to cancel`);
        return;
      case 'confirm':
        void this.killSession(state.sessionId, state.name);
        return;
      case 'ignore':
        return;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private message(tone: 'info' | 'warn' | 'err', text: string): void {
    this.model.setMessage({ tone, text });
  }

  private async attachSelected(): Promise<void> {
    const row = this.model.selectedSession();
    if (!row) return;
    if (row.group === 'recent') {
      this.message('warn', 'that session is not running; resuming a past session is not wired up yet');
      return;
    }
    const plan = planAttach(row.session.muxName, {
      socket: this.socket,
      ...(this.env.TMUX ? { tmux: this.env.TMUX } : {}),
    });
    if (plan.kind === 'refuse') {
      this.message('warn', plan.message);
      return;
    }

    if (plan.kind === 'switch') {
      // The client this TUI draws on is about to show another session, so the
      // dashboard has nothing left to draw and no reason to keep polling.
      this.screen.leave();
      const result = spawnSync(plan.file, plan.args, { stdio: 'inherit' });
      if (result.error) {
        process.stderr.write(`codeman tui: ${getErrorMessage(result.error)}\n`);
        this.quit(1);
        return;
      }
      this.quit(result.status ?? 0);
      return;
    }

    this.screen.leave();
    this.stdout.write(`${plan.hint}\n`);
    const result = spawnSync(plan.file, plan.args, { stdio: 'inherit' });
    this.screen.enter();
    this.paint(true);
    if (result.error) {
      this.message('err', `tmux attach failed: ${getErrorMessage(result.error)}`);
      return;
    }
    await this.refresh();
    this.paint(true);
  }

  private beginKill(): void {
    const row = this.model.selectedSession();
    if (!row) return;
    if (this.model.connection === 'degraded') {
      this.message('warn', 'killing a session needs the server; only attach works while it is down');
      return;
    }
    if (row.group === 'recent') {
      this.message('warn', 'that row is history: there is no session left to kill');
      return;
    }
    if (isSelfSession(row.session.sessionId, this.env)) {
      this.message('warn', 'that is the session this TUI is running in');
      return;
    }
    this.model.beginConfirmKill(row);
  }

  private async killSession(sessionId: string, name: string): Promise<void> {
    this.model.closeOverlay();
    try {
      await this.client.deleteSession(sessionId);
      await this.refresh();
      this.message('info', `killed ${name}`);
    } catch (error) {
      this.message('err', `could not kill ${name}: ${getErrorMessage(error)}`);
    }
    this.paint();
  }

  private async openNewSession(): Promise<void> {
    if (this.model.connection === 'degraded') {
      this.message('warn', 'starting a session needs the server; only attach works while it is down');
      return;
    }
    this.picker = { stage: 'case', all: [] };
    this.model.setPicker({ title: 'New session', items: [], index: -1, filter: '', hint: 'loading cases…' });
    this.paint();

    let items: TuiPickerItem[];
    try {
      const cases = await this.client.fetchCases();
      items = cases.map((entry) => ({
        id: entry.name,
        label: entry.name,
        ...(entry.location && entry.location !== 'local' ? { detail: entry.location } : {}),
      }));
    } catch (error) {
      this.picker = null;
      this.message('err', `could not list cases: ${getErrorMessage(error)}`);
      this.paint();
      return;
    }

    // The picker can be gone already: fetching cases takes a round trip and esc
    // works throughout it.
    if (!this.picker || this.picker.stage !== 'case') return;
    this.picker.all = items;
    this.showPicker('Pick a case', items.length > 0 ? 'which case should the session run in?' : 'no cases found');
    this.paint();
  }

  private showPicker(title: string, hint: string, filter = ''): void {
    const runtime = this.picker;
    if (!runtime) return;
    const needle = filter.trim().toLowerCase();
    const items = needle ? runtime.all.filter((item) => item.label.toLowerCase().includes(needle)) : [...runtime.all];
    this.model.setPicker({ title, items, index: items.length > 0 ? 0 : -1, filter, hint });
  }

  private handlePicker(event: TuiInputEvent): void {
    const state = this.model.picker;
    const runtime = this.picker;
    if (!state || !runtime) {
      this.model.closeOverlay();
      return;
    }
    switch (event.type) {
      case 'escape':
        this.picker = null;
        this.model.closeOverlay();
        return;
      case 'ctrl':
        if (event.key === 'c') {
          this.picker = null;
          this.model.closeOverlay();
        }
        return;
      case 'key':
        if (event.name === 'up') this.movePicker(-1);
        else if (event.name === 'down') this.movePicker(1);
        return;
      case 'backspace':
        this.showPicker(state.title, state.hint ?? '', [...(state.filter ?? '')].slice(0, -1).join(''));
        return;
      case 'char':
        this.showPicker(state.title, state.hint ?? '', `${state.filter ?? ''}${event.value}`);
        return;
      case 'enter':
        this.choosePicked();
        return;
      default:
        return;
    }
  }

  private movePicker(delta: number): void {
    const state = this.model.picker;
    if (!state || state.items.length === 0) return;
    const next = (((state.index + delta) % state.items.length) + state.items.length) % state.items.length;
    this.model.setPicker({ ...state, index: next });
  }

  private choosePicked(): void {
    const state = this.model.picker;
    const runtime = this.picker;
    if (!state || !runtime || state.index < 0 || state.index >= state.items.length) return;
    const chosen = state.items[state.index];

    if (runtime.stage === 'case') {
      this.picker = {
        stage: 'mode',
        caseName: chosen.id,
        all: MODE_ITEMS.map((mode) => ({ id: mode.id, label: mode.label, detail: mode.detail })),
      };
      this.showPicker('Pick a CLI', `new session in ${chosen.label}`);
      return;
    }

    const caseName = runtime.caseName;
    // Resolved against the table rather than cast: the picker's ids are strings
    // and quick-start refuses a mode the server does not know.
    const mode = MODE_ITEMS.find((entry) => entry.id === chosen.id);
    this.picker = null;
    this.model.closeOverlay();
    if (caseName && mode) void this.startSession(caseName, mode.id);
  }

  private async startSession(caseName: string, mode: TuiRunMode): Promise<void> {
    try {
      const result = await this.client.quickStart({ caseName, mode });
      // The row appears with the next resync; remember which one to select.
      this.pendingSelectId = result.sessionId;
      this.message('info', `started ${mode} in ${caseName}`);
      await this.refresh();
    } catch (error) {
      this.message('err', `could not start a session in ${caseName}: ${getErrorMessage(error)}`);
    }
    this.paint();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private installSafetyNets(): void {
    process.on('exit', this.onProcessExit);
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);
    // Prepended: src/index.ts already handles both by exiting, and a listener
    // registered after it would never run, leaving the terminal in raw mode.
    process.prependListener('uncaughtException', this.onFatal);
    process.prependListener('unhandledRejection', this.onFatal);
  }

  private removeSafetyNets(): void {
    process.off('exit', this.onProcessExit);
    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);
    process.off('uncaughtException', this.onFatal);
    process.off('unhandledRejection', this.onFatal);
  }

  private quit(code: number): void {
    if (this.exiting) return;
    this.exiting = true;
    for (const timer of [this.escTimer, this.resyncTimer]) if (timer) clearTimeout(timer);
    for (const timer of [this.tickTimer, this.pollTimer, this.probeTimer]) if (timer) clearInterval(timer);
    this.escTimer = null;
    this.resyncTimer = null;
    this.tickTimer = null;
    this.pollTimer = null;
    this.probeTimer = null;
    this.stream?.close();
    this.client.close();
    this.stdin.off('data', this.onData);
    this.screen.leave();
    this.removeSafetyNets();
    this.resolveExit?.(code);
    this.resolveExit = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

type Snapshot = { kind: 'ok'; rows: TuiRow[]; degraded: boolean } | { kind: 'auth' };

/**
 * One read of the world for the non-interactive paths. Same client, same
 * classification and same ordering as the dashboard, so `--list`'s numbers are
 * the numbers `codeman tui <n>` takes.
 */
async function snapshot(client: TuiClient): Promise<Snapshot> {
  const server = await client.connect();
  if (server?.authRequired) return { kind: 'auth' };
  const model = createTuiModel();
  if (!server) {
    model.replaceSessions(tmuxRowsToSessions(await client.enumerateTmuxSessions()));
    return { kind: 'ok', rows: model.rows(), degraded: true };
  }
  const [sessions, approvals, tmux] = await Promise.all([
    client.fetchUnifiedSessions(UNIFIED_LIMIT),
    client.fetchApprovals().catch(() => []),
    client.enumerateTmuxSessions().catch(() => [] as TuiTmuxSession[]),
  ]);
  model.replaceSessions(applyMuxNames(sessions, tmux));
  model.setApprovals(approvals);
  return { kind: 'ok', rows: model.rows(), degraded: false };
}

function authHint(): string {
  return (
    `${palette.err('The Codeman server rejected these credentials.')}\n` +
    `Set ${palette.info('CODEMAN_PASSWORD')} (and ${palette.info('CODEMAN_USERNAME')} if it is not "admin"), ` +
    'or put them in ~/.codeman/.env.\n'
  );
}

/** The full-screen dashboard. */
export async function runTui(options: TuiRunOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write(
      `${palette.err('codeman tui needs an interactive terminal.')}\n` +
        `Use ${palette.info('codeman tui --list')} for a plain list, or ${palette.info('codeman tui <n>')} to attach.\n`
    );
    return 1;
  }
  return new TuiApp(options).run();
}

/**
 * `codeman tui --list`: the `sc -l` replacement. Prints and exits, colored when
 * the output is a terminal and plain when it is piped (chalk's call, not ours).
 */
export async function runTuiList(options: TuiRunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const client = options.client ?? new TuiClient();
  try {
    const state = await snapshot(client).catch((error: unknown) => {
      process.stderr.write(`${palette.err(getErrorMessage(error))}\n`);
      return null;
    });
    if (!state) return 1;
    if (state.kind === 'auth') {
      process.stderr.write(authHint());
      return 1;
    }
    if (state.degraded) {
      process.stderr.write(`${palette.warn('server not running: listing tmux sessions only')}\n`);
    }
    const lines = buildListLines(state.rows);
    if (lines.length === 0) {
      process.stderr.write(`${palette.muted('no sessions')}\n`);
      return 0;
    }
    const rows = lines.map((line) => [
      palette.muted(String(line.index)),
      tint(STATE_TONE[line.state], STATE_WORD[line.state]),
      line.label,
      palette.muted(line.workingDir),
    ]);
    stdout.write(`${table(rows, { indent: '  ' })}\n`);
    return 0;
  } finally {
    client.close();
  }
}

/**
 * `codeman tui <n>`: the `sc 2` replacement. No screen setup at all, so it is
 * as fast as the API call it makes.
 */
export async function runTuiAttach(position: number, options: TuiRunOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write(`${palette.err('attaching needs an interactive terminal.')}\n`);
    return 1;
  }
  const env = options.env ?? process.env;
  const client = options.client ?? new TuiClient();
  try {
    const state = await snapshot(client).catch((error: unknown) => {
      process.stderr.write(`${palette.err(getErrorMessage(error))}\n`);
      return null;
    });
    if (!state) return 1;
    if (state.kind === 'auth') {
      process.stderr.write(authHint());
      return 1;
    }
    const row = state.rows[Math.trunc(position) - 1];
    if (!row) {
      process.stderr.write(
        `${palette.err(`there is no session ${position}`)}\nRun ${palette.info('codeman tui --list')} to see the numbers.\n`
      );
      return 1;
    }
    const plan = planAttach(row.session.muxName, {
      socket: resolveTmuxSocketName(),
      ...(env.TMUX ? { tmux: env.TMUX } : {}),
    });
    if (plan.kind === 'refuse') {
      process.stderr.write(`${palette.warn(plan.message)}\n`);
      return 1;
    }
    if (plan.kind === 'attach') stdout.write(`${palette.muted(plan.hint)}\n`);
    const result = spawnSync(plan.file, plan.args, { stdio: 'inherit' });
    if (result.error) {
      process.stderr.write(`${palette.err(getErrorMessage(result.error))}\n`);
      return 1;
    }
    return result.status ?? 0;
  } finally {
    client.close();
  }
}
