/**
 * @fileoverview Core PTY session wrapper for Claude CLI interactions.
 *
 * Manages a PTY (pseudo-terminal) process running Claude CLI or OpenCode CLI.
 * Three operation modes:
 * 1. **One-shot** (`runPrompt`): Single prompt → JSON response
 * 2. **Interactive** (`startInteractive`): Persistent interactive session
 * 3. **Shell** (`startShell`): Plain bash shell for debugging
 *
 * Optionally wraps in a tmux session for persistence across disconnects.
 * Tracks tokens, costs, background tasks, and auto-compact/clear.
 *
 * Key exports:
 * - `Session` class — main entity, extends EventEmitter
 * - `ClaudeMessage` interface — parsed JSON messages from Claude output
 * - `SessionEvents` interface — typed event map
 *
 * Key methods: `runPrompt()`, `startInteractive()`, `startShell()`,
 * `writeViaMux()`, `toState()`, `stop()`, `resize()`, `isIdle()`,
 * `setAutoCompact()`, `findTaskDescriptionNear()`, `getTerminalBuffer()`
 *
 * @dependencies session-cli-builder (args/env), session-auto-ops (auto-compact/clear),
 *   ralph-tracker (todo/completion parsing), bash-tool-parser (tool invocation tracking),
 *   task-tracker (background tasks), mux-interface (tmux abstraction)
 * @consumedby session-manager, web/server, respawn-controller
 * @emits session:terminal, session:idle, session:working, session:completion, session:exit
 *
 * @module session
 */

import { EventEmitter } from 'node:events';
import { execSync, execFileSync } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import {
  SessionState,
  SessionStatus,
  SessionConfig,
  RalphTrackerState,
  RalphTodoItem,
  ActiveBashTool,
  NiceConfig,
  DEFAULT_NICE_CONFIG,
  getErrorMessage,
  isEffortLevel,
  type ClaudeMode,
  type SessionMode,
  type OpenCodeConfig,
  type CodexConfig,
  type EffortLevel,
} from './types.js';
import type { TerminalMultiplexer, MuxSession } from './mux-interface.js';
import { TaskTracker, type BackgroundTask } from './task-tracker.js';
import { RalphTracker } from './ralph-tracker.js';
import { BashToolParser } from './bash-tool-parser.js';
import {
  BufferAccumulator,
  ANSI_ESCAPE_PATTERN_FULL,
  TOKEN_PATTERN,
  SPINNER_PATTERN,
  MAX_SESSION_TOKENS,
  execPattern,
} from './utils/index.js';
import {
  MAX_TERMINAL_BUFFER_SIZE,
  TRIM_TERMINAL_TO as TERMINAL_BUFFER_TRIM_SIZE,
  MAX_TEXT_OUTPUT_SIZE,
  TRIM_TEXT_TO as TEXT_OUTPUT_TRIM_SIZE,
  MAX_MESSAGES,
  MAX_LINE_BUFFER_SIZE,
} from './config/buffer-limits.js';
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
import {
  buildInteractiveArgs,
  buildPromptArgs,
  buildClaudeEnv,
  buildMuxAttachEnv,
  buildShellEnv,
} from './session-cli-builder.js';
import { SessionAutoOps } from './session-auto-ops.js';
import { detectUsageLimitPause } from './usage-limit-patterns.js';
import { SessionTaskCache } from './session-task-cache.js';
import { parseAttachmentMagicLinks } from './attachment-magic.js';
import {
  sanitizeAttachmentHistory,
  upsertAttachmentHistory as upsertAttachmentHistoryList,
} from './session-attachment-history.js';
import type { SessionAttachmentHistoryItem } from './types/session.js';

export type { BackgroundTask } from './task-tracker.js';
export type { RalphTrackerState, RalphTodoItem, ActiveBashTool } from './types.js';

export type ResizeViewportType = 'mobile' | 'tablet' | 'desktop';

/** Line buffer flush interval (100ms) - forces processing of partial lines */
const LINE_BUFFER_FLUSH_INTERVAL = 100;

// ============================================================================
// Timing Constants
// ============================================================================

/** Delay after mux session creation before sending commands (300ms) */
const MUX_STARTUP_DELAY_MS = 300;

/** Delay before declaring session idle after last output (2 seconds) */
const IDLE_DETECTION_DELAY_MS = 2000;

// Note: Auto-compact/clear timing constants moved to session-auto-ops.ts

/** Graceful shutdown delay when stopping session (100ms) */
const GRACEFUL_SHUTDOWN_DELAY_MS = 100;

// Filter out terminal focus escape sequences (focus in/out reports)
// ^[[I (focus in), ^[[O (focus out), and the enable/disable sequences
// eslint-disable-next-line no-control-regex
const FOCUS_ESCAPE_FILTER = /\x1b\[\?1004[hl]|\x1b\[[IO]/g;

// Pattern to match Task tool invocations in terminal output
// Matches: "Explore(Description)", "Task(Description)", "Bash(Description)", etc.
// The prefix characters vary (●, ·, ✶, etc.) so we don't require them
// We look for the tool name followed by (description)
const TASK_TOOL_PATTERN = /\b(Explore|Task|Bash|Plan|general-purpose)\(([^)]+)\)/g;

// Pre-compiled patterns for hot paths (avoid regex compilation per call)
/** Pattern to strip leading ANSI escapes and whitespace from terminal buffer */
// eslint-disable-next-line no-control-regex
const LEADING_ANSI_WHITESPACE_PATTERN = /^(\x1b\[\??[\d;]*[A-Za-z]|[\s\r\n])+/;
/** Pattern to match Ctrl+L (form feed) characters */
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
/** Pattern to split by newlines (CR or LF) */
const NEWLINE_SPLIT_PATTERN = /\r?\n/;

/** True for external-CLI run modes (non-Claude) that use their own TUI and output format. */
export function isExternalCliMode(mode: SessionMode): boolean {
  return mode === 'opencode' || mode === 'codex';
}

// Note: Claude CLI PATH resolution moved to session-cli-builder.ts (buildClaudeEnv)

/** PTY fallback geometry when tmux can't be queried (matches pre-#80 hardcoded values). */
const DEFAULT_PTY_COLS = 120;
const DEFAULT_PTY_ROWS = 40;
const TMUX_DISPLAY_TIMEOUT_MS = 2000;

/**
 * Ask tmux for the current window geometry of `muxName` so a re-attaching PTY
 * client can spawn at the same size and avoid the resize-flicker / scrollback
 * loss documented in #80. Returns `{ cols: 120, rows: 40 }` on any failure
 * (tmux dead, muxName unknown, malformed output) — caller never has to
 * differentiate "tmux unreachable" from "size 120x40".
 *
 * `socket` MUST be the same dedicated socket the session lives on (`mux.muxSocket`);
 * querying the default server would never find the session and silently fall back.
 *
 * Argv form (execFileSync, not execSync) keeps `muxName` out of any shell so
 * a hostile session name can't inject options.
 */
export function queryTmuxWindowSize(muxName: string, socket: string): { cols: number; rows: number } {
  try {
    const sizeStr = execFileSync(
      'tmux',
      ['-L', socket, 'display', '-t', muxName, '-p', '#{window_width} #{window_height}'],
      {
        timeout: TMUX_DISPLAY_TIMEOUT_MS,
        encoding: 'utf8',
      }
    ).trim();
    const [w, h] = sizeStr.split(' ').map(Number);
    if (w > 0 && h > 0) {
      return { cols: w, rows: h };
    }
  } catch {
    /* fall back below */
  }
  return { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS };
}

/**
 * Represents a JSON message from Claude CLI's stream-json output format.
 * Messages are newline-delimited JSON objects parsed from PTY output.
 */
export interface ClaudeMessage {
  /** Message type indicating the role or purpose */
  type: 'system' | 'assistant' | 'user' | 'result';
  /** Optional subtype for further classification */
  subtype?: string;
  /** Claude's internal session identifier */
  session_id?: string;
  /** Message content with optional token usage */
  message?: {
    content: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  /** Final result text (on result messages) */
  result?: string;
  /** Whether this message represents an error */
  is_error?: boolean;
  /** Total cost in USD (on result messages) */
  total_cost_usd?: number;
  /** Total duration in milliseconds (on result messages) */
  duration_ms?: number;
}

/**
 * Event signatures emitted by the Session class.
 * Subscribe using `session.on('eventName', handler)`.
 */

/**
 * Core session class that wraps a PTY process running Claude CLI or a shell.
 *
 * @example
 * ```typescript
 * // Create and start an interactive Claude session
 * const session = new Session({
 *   workingDir: '/path/to/project',
 *   mux: muxManager,
 *   useMux: true
 * });
 * await session.startInteractive();
 *
 * // Listen for events
 * session.on('terminal', (data) => console.log(data));
 * session.on('message', (msg) => console.log('Claude:', msg));
 *
 * // Send input
 * session.write('Hello Claude!\r');
 *
 * // Stop when done
 * await session.stop();
 * ```
 *
 * @fires Session#terminal - Raw terminal output
 * @fires Session#message - Parsed Claude JSON message
 * @fires Session#completion - One-shot prompt completed
 * @fires Session#exit - Process exited
 * @fires Session#autoClear - Token threshold reached, clearing context
 * @fires Session#autoCompact - Token threshold reached, compacting context
 */
export class Session extends EventEmitter {
  readonly id: string;
  readonly workingDir: string;
  readonly createdAt: number;
  readonly mode: SessionMode;

  // Task description cache (extracted to SessionTaskCache)
  private _taskCache = new SessionTaskCache();

  private _name: string;
  private ptyProcess: pty.IPty | null = null;
  private _pid: number | null = null;
  private _status: SessionStatus = 'idle';
  private _currentTaskId: string | null = null;
  // Use BufferAccumulator for hot-path buffers to reduce GC pressure
  private _terminalBuffer = new BufferAccumulator(MAX_TERMINAL_BUFFER_SIZE, TERMINAL_BUFFER_TRIM_SIZE);
  private _textOutput = new BufferAccumulator(MAX_TEXT_OUTPUT_SIZE, TEXT_OUTPUT_TRIM_SIZE);
  private _errorBuffer: string = '';
  private _lastActivityAt: number;
  private _claudeSessionId: string | null = null;
  private _totalCost: number = 0;
  private _messages: ClaudeMessage[] = [];
  private _lineBuffer: string = '';
  private _lineBufferFlushTimer: NodeJS.Timeout | null = null;
  // Codex only: trailing partial CSI held back so sequences split across PTY
  // chunks can't slip past the alt-screen/scrollback strip (see _handleTerminalOutput)
  private _codexSeqCarry: string = '';
  private resolvePromise: ((value: { result: string; cost: number }) => void) | null = null;
  private rejectPromise: ((reason: Error) => void) | null = null;
  private _promptResolved: boolean = false; // Guard against race conditions in runPrompt
  private _isWorking: boolean = false;
  private _lastPromptTime: number = 0;
  private activityTimeout: NodeJS.Timeout | null = null;
  private _awaitingIdleConfirmation: boolean = false; // Prevents timeout reset during idle detection
  private _trustDialogAccepted: boolean = false; // Prevents repeated trust dialog auto-accept
  private _taskTracker: TaskTracker;

  // Token tracking for auto-clear
  private _totalInputTokens: number = 0;
  private _totalOutputTokens: number = 0;

  // Auto-compact/auto-clear automation (extracted to SessionAutoOps)
  private _autoOps!: SessionAutoOps;

  // Image watcher setting (per-session toggle)
  private _imageWatcherEnabled: boolean = false;

  // Flicker filter setting (per-session toggle, applied on frontend)
  private _flickerFilterEnabled: boolean = false;

  // Claude Code CLI info (parsed from terminal startup)
  private _cliVersion: string = '';
  private _cliModel: string = '';
  private _cliAccountType: string = '';
  private _cliLatestVersion: string = '';
  private _cliInfoParsed: boolean = false; // Only parse once per session

  // Timer tracking for cleanup (prevents memory leaks)
  private _promptCheckInterval: NodeJS.Timeout | null = null;
  private _promptCheckTimeout: NodeJS.Timeout | null = null;
  private _shellIdleTimer: NodeJS.Timeout | null = null;

  // Multiplexer session support (tmux)
  private _mux: TerminalMultiplexer | null = null;
  private _muxSession: MuxSession | null = null;
  private _useMux: boolean = false;
  // Flag to prevent new timers after session is stopped
  private _isStopped: boolean = false;

  // Ralph tracking (Ralph Wiggum loops and todo lists inside Claude Code)
  private _ralphTracker: RalphTracker;

  // Agent tree tracking
  private _parentAgentId: string | null = null;
  private _childAgentIds: string[] = [];

  // Bounded dedup set for terminal attachment magic-links already requested.
  private _attachmentMagicSeen = new Set<string>();
  private _attachmentHistory: SessionAttachmentHistoryItem[] = [];

  // Nice prioritying configuration
  private _niceConfig: NiceConfig = { ...DEFAULT_NICE_CONFIG };

  // Claude model override (e.g., 'opus', 'sonnet', 'haiku')
  private _model: string | undefined;

  // Claude CLI startup permission mode
  private _claudeMode: ClaudeMode = 'dangerously-skip-permissions';
  private _allowedTools: string | undefined;

  // OpenCode configuration (only for mode === 'opencode')
  private _openCodeConfig: OpenCodeConfig | undefined;
  // Codex configuration (only for mode === 'codex')
  private _codexConfig: CodexConfig | undefined;
  private _resumeSessionId: string | undefined;

  // Ephemeral env overrides (e.g., CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS). Exported by tmux
  // at spawn, preserved across respawns via persisted state. Not written to .claude/settings.local.json.
  private _envOverrides: Record<string, string> | undefined;

  // Claude CLI effort level — injected as a `--settings` soft default at spawn so the
  // user can still switch in-session via /effort (incl. ultracode). Never carried as
  // the CLAUDE_CODE_EFFORT_LEVEL env var, which would hard-lock the session.
  private _effort: EffortLevel | undefined;

  // Session color for visual differentiation
  private _color: import('./types.js').SessionColor = 'default';

  // Store handler references for cleanup (prevents memory leaks)
  private _taskTrackerHandlers: {
    taskCreated: (task: BackgroundTask) => void;
    taskUpdated: (task: BackgroundTask) => void;
    taskCompleted: (task: BackgroundTask) => void;
    taskFailed: (task: BackgroundTask, error: string) => void;
  } | null = null;

  private _ralphHandlers: {
    loopUpdate: (state: RalphTrackerState) => void;
    todoUpdate: (todos: RalphTodoItem[]) => void;
    completionDetected: (phrase: string) => void;
    statusBlockDetected: (block: import('./types.js').RalphStatusBlock) => void;
    circuitBreakerUpdate: (status: import('./types.js').CircuitBreakerStatus) => void;
    exitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  } | null = null;

  // Bash tool tracking (file paths for live log viewing)
  private _bashToolParser: BashToolParser;
  private _bashToolHandlers: {
    toolStart: (tool: ActiveBashTool) => void;
    toolEnd: (tool: ActiveBashTool) => void;
    toolsUpdate: (tools: ActiveBashTool[]) => void;
  } | null = null;

  // Task descriptions parsed from terminal output — delegated to SessionTaskCache

  // Throttle expensive PTY processing (Ralph, bash parser, task descriptions)
  // Accumulates clean data between processing windows to avoid running regex on every chunk
  private _lastExpensiveProcessTime: number = 0;
  private _pendingCleanData: string = '';
  private _expensiveProcessTimer: NodeJS.Timeout | null = null;
  private static readonly EXPENSIVE_PROCESS_INTERVAL_MS = 150; // Process at most every 150ms

  constructor(
    config: Partial<SessionConfig> & {
      workingDir: string;
      mode?: SessionMode;
      name?: string;
      /** Terminal multiplexer instance (tmux) */
      mux?: TerminalMultiplexer;
      /** Whether to use multiplexer wrapping */
      useMux?: boolean;
      /** Existing mux session for restored sessions */
      muxSession?: MuxSession;
      niceConfig?: NiceConfig; // Nice prioritying configuration
      /** Claude model override (e.g., 'opus', 'sonnet', 'haiku') */
      model?: string;
      /** Claude CLI startup permission mode */
      claudeMode?: ClaudeMode;
      /** Comma-separated allowed tools (for 'allowedTools' mode) */
      allowedTools?: string;
      /** OpenCode configuration (only for mode === 'opencode') */
      openCodeConfig?: OpenCodeConfig;
      /** Codex configuration (only for mode === 'codex') */
      codexConfig?: CodexConfig;
      /** Resume a previous Claude conversation (used after server reboot) */
      resumeSessionId?: string;
      /** Extra env vars exported to the CLI at spawn time (no disk persistence) */
      envOverrides?: Record<string, string>;
      /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
      effort?: EffortLevel;
      /** Restored per-session attachment history. May include server-private external paths. */
      attachmentHistory?: SessionAttachmentHistoryItem[];
    }
  ) {
    super();
    this.setMaxListeners(25);

    // Default error handler prevents unhandled 'error' events from crashing the process.
    // Server attaches its own handler after construction — this is a safety net for the gap.
    this.on('error', (err) => {
      console.error(`[Session] Unhandled error event:`, err);
    });

    this.id = config.id || uuidv4();
    this.workingDir = config.workingDir;
    this.createdAt = config.createdAt || Date.now();
    this.mode = config.mode || 'claude';
    this._name = config.name || '';
    this._resumeSessionId = config.resumeSessionId;
    this._lastActivityAt = this.createdAt;
    // Set claudeSessionId — when resuming, the Claude conversation ID is the resumed one.
    this._claudeSessionId = config.resumeSessionId || this.id;
    this._mux = config.mux || null;
    this._useMux = config.useMux ?? (this._mux !== null && this._mux.isAvailable());
    this._muxSession = config.muxSession || null;

    // Apply Nice priority configuration if provided
    if (config.niceConfig) {
      this._niceConfig = { ...config.niceConfig };
    }

    // Apply model override if provided
    if (config.model) {
      this._model = config.model;
    }

    // Apply Claude CLI permission mode
    if (config.claudeMode) {
      this._claudeMode = config.claudeMode;
    }
    if (config.allowedTools) {
      this._allowedTools = config.allowedTools;
    }

    // Apply OpenCode configuration
    if (config.openCodeConfig) {
      this._openCodeConfig = config.openCodeConfig;
    }

    // Apply Codex configuration
    if (config.codexConfig) {
      this._codexConfig = config.codexConfig;
    }

    // Apply env overrides (exported at spawn, not persisted to disk).
    // Legacy migration: pre-0.7.2 carried effort as the CLAUDE_CODE_EFFORT_LEVEL env var,
    // which hard-locks /effort switching. Extract it into _effort (--settings soft default)
    // and never export it as an env var again. Explicit config.effort wins over legacy.
    if (config.envOverrides && Object.keys(config.envOverrides).length > 0) {
      const { CLAUDE_CODE_EFFORT_LEVEL: legacyEffort, ...restOverrides } = config.envOverrides;
      this._envOverrides = Object.keys(restOverrides).length > 0 ? restOverrides : undefined;
      if (legacyEffort && isEffortLevel(legacyEffort)) {
        this._effort = legacyEffort;
      }
    }
    if (config.effort && isEffortLevel(config.effort)) {
      this._effort = config.effort;
    }
    if (config.attachmentHistory && config.attachmentHistory.length > 0) {
      this.restoreAttachmentHistory(config.attachmentHistory);
    }

    // Initialize task tracker and forward events (store handlers for cleanup)
    this._taskTracker = new TaskTracker();
    this._taskTrackerHandlers = {
      taskCreated: (task) => this.emit('taskCreated', task),
      taskUpdated: (task) => this.emit('taskUpdated', task),
      taskCompleted: (task) => this.emit('taskCompleted', task),
      taskFailed: (task, error) => this.emit('taskFailed', task, error),
    };
    this._taskTracker.on('taskCreated', this._taskTrackerHandlers.taskCreated);
    this._taskTracker.on('taskUpdated', this._taskTrackerHandlers.taskUpdated);
    this._taskTracker.on('taskCompleted', this._taskTrackerHandlers.taskCompleted);
    this._taskTracker.on('taskFailed', this._taskTrackerHandlers.taskFailed);

    // Initialize Ralph tracker and forward events (store handlers for cleanup)
    this._ralphTracker = new RalphTracker();
    this._ralphHandlers = {
      loopUpdate: (state) => this.emit('ralphLoopUpdate', state),
      todoUpdate: (todos) => this.emit('ralphTodoUpdate', todos),
      completionDetected: (phrase) => this.emit('ralphCompletionDetected', phrase),
      statusBlockDetected: (block) => this.emit('ralphStatusBlockDetected', block),
      circuitBreakerUpdate: (status) => this.emit('ralphCircuitBreakerUpdate', status),
      exitGateMet: (data) => this.emit('ralphExitGateMet', data),
    };
    this._ralphTracker.on('loopUpdate', this._ralphHandlers.loopUpdate);
    this._ralphTracker.on('todoUpdate', this._ralphHandlers.todoUpdate);
    this._ralphTracker.on('completionDetected', this._ralphHandlers.completionDetected);
    this._ralphTracker.on('statusBlockDetected', this._ralphHandlers.statusBlockDetected);
    this._ralphTracker.on('circuitBreakerUpdate', this._ralphHandlers.circuitBreakerUpdate);
    this._ralphTracker.on('exitGateMet', this._ralphHandlers.exitGateMet);

    // Initialize Bash tool parser and forward events (store handlers for cleanup)
    this._bashToolParser = new BashToolParser({ sessionId: this.id, workingDir: this.workingDir });
    this._bashToolHandlers = {
      toolStart: (tool) => this.emit('bashToolStart', tool),
      toolEnd: (tool) => this.emit('bashToolEnd', tool),
      toolsUpdate: (tools) => this.emit('bashToolsUpdate', tools),
    };
    this._bashToolParser.on('toolStart', this._bashToolHandlers.toolStart);
    this._bashToolParser.on('toolEnd', this._bashToolHandlers.toolEnd);
    this._bashToolParser.on('toolsUpdate', this._bashToolHandlers.toolsUpdate);

    // Initialize auto-compact/auto-clear automation and forward events
    this._autoOps = new SessionAutoOps({
      writeCommand: (cmd) => this.writeViaMux(cmd),
      isWorking: () => this._isWorking,
      isStopped: () => this._isStopped,
      getTotalTokens: () => this._totalInputTokens + this._totalOutputTokens,
      getSessionId: () => this.id,
    });
    this._autoOps.on('autoCompact', (data) => this.emit('autoCompact', data));
    this._autoOps.on('autoClear', (data) => {
      // Reset token counts on clear
      this._totalInputTokens = 0;
      this._totalOutputTokens = 0;
      this.emit('autoClear', data);
    });
    this._autoOps.on('limitPauseScheduled', (data) => this.emit('limitPauseScheduled', data));
    this._autoOps.on('limitResume', (data) => this.emit('limitResume', data));
    this._autoOps.on('limitResumeCancelled', (data) => this.emit('limitResumeCancelled', data));
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentTaskId(): string | null {
    return this._currentTaskId;
  }

  get pid(): number | null {
    return this._pid;
  }

  get terminalBuffer(): string {
    return this._terminalBuffer.value;
  }

  get terminalBufferLength(): number {
    return this._terminalBuffer.length;
  }

  get textOutput(): string {
    return this._textOutput.value;
  }

  get errorBuffer(): string {
    return this._errorBuffer;
  }

  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  get claudeSessionId(): string | null {
    return this._claudeSessionId;
  }

  // Adopt a Claude conversation ID observed from an external source (e.g. hook
  // payload). In interactive PTY mode Claude CLI emits no JSON to stdout, so
  // `_handleJsonMessage` never sees `session_id`; hooks are the only signal
  // that conveys a post-/clear conversation switch.
  adoptClaudeSessionId(newId: string): void {
    if (!newId || newId === this._claudeSessionId) return;
    this._claudeSessionId = newId;
  }

  /** The tmux session name, if the session is running inside a mux */
  get muxName(): string | null {
    return this._muxSession?.muxName ?? null;
  }

  get totalCost(): number {
    return this._totalCost;
  }

  get messages(): ClaudeMessage[] {
    return this._messages;
  }

  get isWorking(): boolean {
    return this._isWorking;
  }

  /**
   * Check if the session's process tree has active child processes beyond Claude itself.
   * Detects running bash tools, test suites, builds, servers, etc. that Claude spawned.
   *
   * The tmux pane PID is typically "claude" directly (bash exec'd into it). When Claude
   * runs a bash tool, it spawns child processes: claude → bash → npm/node/python/etc.
   * We check direct children of the pane PID, filtering out "claude" itself (for the rare
   * case where bash wraps claude and didn't exec).
   *
   * Returns an array of {pid, command} for each child process, or empty array if none.
   * Returns empty array if no mux session or on error (fail-open to avoid blocking respawn).
   */
  getActiveChildProcesses(): { pid: number; command: string }[] {
    if (!this._muxSession) return [];

    try {
      const panePid = this._muxSession.pid;

      // Single call: get direct children with their command names
      const output = execSync(`ps -o pid=,comm= --ppid ${panePid} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      if (!output) return [];

      const activeProcesses: { pid: number; command: string }[] = [];
      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)/);
        if (!match) continue;
        const pid = parseInt(match[1], 10);
        const command = match[2].trim();
        // Skip the claude process itself (pane_pid may be bash wrapping claude)
        if (command === 'claude') continue;
        activeProcesses.push({ pid, command });
      }

      return activeProcesses;
    } catch {
      // ps returns exit code 1 when no matches — normal (no children)
      return [];
    }
  }

  get lastPromptTime(): number {
    return this._lastPromptTime;
  }

  get taskTracker(): TaskTracker {
    return this._taskTracker;
  }

  get runningTaskCount(): number {
    return this._taskTracker.getRunningCount();
  }

  get taskTree(): BackgroundTask[] {
    return this._taskTracker.getTaskTree();
  }

  get taskStats(): { total: number; running: number; completed: number; failed: number } {
    return this._taskTracker.getStats();
  }

  // Ralph tracking getters
  get ralphTracker(): RalphTracker {
    return this._ralphTracker;
  }

  get ralphLoopState(): RalphTrackerState {
    return this._ralphTracker.loopState;
  }

  get ralphTodos(): RalphTodoItem[] {
    return this._ralphTracker.todos;
  }

  get ralphTodoStats(): { total: number; pending: number; inProgress: number; completed: number } {
    return this._ralphTracker.getTodoStats();
  }

  // Bash tool tracking getters
  get bashToolParser(): BashToolParser {
    return this._bashToolParser;
  }

  get activeTools(): ActiveBashTool[] {
    return this._bashToolParser.activeTools;
  }

  get parentAgentId(): string | null {
    return this._parentAgentId;
  }

  set parentAgentId(value: string | null) {
    this._parentAgentId = value;
  }

  get childAgentIds(): string[] {
    return [...this._childAgentIds];
  }

  addChildAgentId(agentId: string): void {
    if (!this._childAgentIds.includes(agentId)) {
      this._childAgentIds.push(agentId);
    }
  }

  removeChildAgentId(agentId: string): void {
    const idx = this._childAgentIds.indexOf(agentId);
    if (idx >= 0) this._childAgentIds.splice(idx, 1);
  }

  // Nice priority config getters and setters
  get niceConfig(): NiceConfig {
    return { ...this._niceConfig };
  }

  /** Claude CLI startup permission mode */
  get claudeMode(): ClaudeMode {
    return this._claudeMode;
  }

  /** Allowed tools list (for 'allowedTools' mode) */
  get allowedTools(): string | undefined {
    return this._allowedTools;
  }

  /** Codex CLI configuration for this session. */
  get codexConfig(): CodexConfig | undefined {
    return this._codexConfig;
  }

  // Note: _buildPermissionArgs removed — now using buildInteractiveArgs from session-cli-builder.ts

  /**
   * Set CPU priority configuration.
   * Note: This only affects new sessions; existing running processes won't be changed.
   */
  setNice(config: Partial<NiceConfig>): void {
    if (config.enabled !== undefined) {
      this._niceConfig.enabled = config.enabled;
    }
    if (config.niceValue !== undefined) {
      // Clamp to valid range
      this._niceConfig.niceValue = Math.max(-20, Math.min(19, config.niceValue));
    }
  }

  // Session color for visual differentiation
  get color(): import('./types.js').SessionColor {
    return this._color;
  }

  setColor(color: import('./types.js').SessionColor): void {
    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (validColors.includes(color)) {
      this._color = color;
    }
  }

  // Token tracking getters and setters
  get totalTokens(): number {
    return this._totalInputTokens + this._totalOutputTokens;
  }

  get inputTokens(): number {
    return this._totalInputTokens;
  }

  get outputTokens(): number {
    return this._totalOutputTokens;
  }

  /**
   * Restore token and cost values from saved state.
   * Called when recovering sessions after server restart.
   */
  restoreTokens(inputTokens: number, outputTokens: number, totalCost: number): void {
    // Sanity check: reject absurdly large individual values
    if (inputTokens > MAX_SESSION_TOKENS || outputTokens > MAX_SESSION_TOKENS) {
      console.warn(
        `[Session ${this.id}] Rejected absurd restored tokens: input=${inputTokens}, output=${outputTokens}`
      );
      return;
    }
    // Check token sum doesn't overflow MAX_SESSION_TOKENS
    if (inputTokens + outputTokens > MAX_SESSION_TOKENS) {
      console.warn(
        `[Session ${this.id}] Rejected token sum overflow: input=${inputTokens} + output=${outputTokens} = ${inputTokens + outputTokens} > ${MAX_SESSION_TOKENS}`
      );
      return;
    }
    // Reject negative values
    if (inputTokens < 0 || outputTokens < 0 || totalCost < 0) {
      console.warn(
        `[Session ${this.id}] Rejected negative restored tokens: input=${inputTokens}, output=${outputTokens}, cost=${totalCost}`
      );
      return;
    }

    this._totalInputTokens = inputTokens;
    this._totalOutputTokens = outputTokens;
    this._totalCost = totalCost;
  }

  get autoClearThreshold(): number {
    return this._autoOps.autoClearThreshold;
  }

  get autoClearEnabled(): boolean {
    return this._autoOps.autoClearEnabled;
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  setAutoClear(enabled: boolean, threshold?: number): void {
    this._autoOps.setAutoClear(enabled, threshold);
  }

  get autoCompactThreshold(): number {
    return this._autoOps.autoCompactThreshold;
  }

  get autoCompactEnabled(): boolean {
    return this._autoOps.autoCompactEnabled;
  }

  get autoCompactPrompt(): string {
    return this._autoOps.autoCompactPrompt;
  }

  setAutoCompact(enabled: boolean, threshold?: number, prompt?: string): void {
    this._autoOps.setAutoCompact(enabled, threshold, prompt);
  }

  get autoResumeEnabled(): boolean {
    return this._autoOps.autoResumeEnabled;
  }

  /** When the scheduled usage-limit auto-resume fires (epoch ms), or null. */
  get autoResumeAt(): number | null {
    return this._autoOps.autoResumeAt;
  }

  /** True while the session is paused on a Claude usage limit (auto-resume armed). */
  get isLimitPaused(): boolean {
    return this._autoOps.isLimitPaused;
  }

  setAutoResume(enabled: boolean): void {
    this._autoOps.setAutoResume(enabled);
    // Users typically enable this WHILE a session already sits paused — the
    // limit footer won't reprint on its own, so scan the recent buffer once.
    // Only a future reset time counts: stale scrollback must not arm a resume.
    if (enabled && !isExternalCliMode(this.mode)) {
      const tail = this._terminalBuffer.value.slice(-8192).replace(ANSI_ESCAPE_PATTERN_FULL, '');
      const detection = detectUsageLimitPause(tail);
      if (detection && detection.resetAt > Date.now()) {
        this._autoOps.processCleanData(tail);
      }
    }
  }

  /** Restore auto-resume state (and a pending schedule) after Codeman restart. */
  restoreAutoResume(enabled: boolean, resumeAt?: number): void {
    this._autoOps.restoreAutoResume(enabled, resumeAt);
  }

  get imageWatcherEnabled(): boolean {
    return this._imageWatcherEnabled;
  }

  set imageWatcherEnabled(enabled: boolean) {
    this._imageWatcherEnabled = enabled;
  }

  get flickerFilterEnabled(): boolean {
    return this._flickerFilterEnabled;
  }

  set flickerFilterEnabled(enabled: boolean) {
    this._flickerFilterEnabled = enabled;
  }

  isIdle(): boolean {
    return this._status === 'idle';
  }

  isBusy(): boolean {
    return this._status === 'busy';
  }

  isRunning(): boolean {
    return this._status === 'idle' || this._status === 'busy';
  }

  get attachmentHistory(): SessionAttachmentHistoryItem[] {
    return sanitizeAttachmentHistory(this._attachmentHistory);
  }

  upsertAttachmentHistory(item: SessionAttachmentHistoryItem): void {
    this._attachmentHistory = upsertAttachmentHistoryList(this._attachmentHistory, item);
  }

  restoreAttachmentHistory(history: SessionAttachmentHistoryItem[] | undefined): void {
    this._attachmentHistory = [];
    for (const item of [...(history ?? [])].reverse()) {
      this.upsertAttachmentHistory(item);
    }
  }

  getAttachmentHistoryForPersist(): SessionAttachmentHistoryItem[] | undefined {
    return this._attachmentHistory.length > 0 ? this._attachmentHistory.map((item) => ({ ...item })) : undefined;
  }

  toState(): SessionState {
    return {
      id: this.id,
      pid: this.pid,
      status: this._status,
      workingDir: this.workingDir,
      currentTaskId: this._currentTaskId,
      createdAt: this.createdAt,
      lastActivityAt: this._lastActivityAt,
      name: this._name,
      mode: this.mode,
      autoClearEnabled: this._autoOps.autoClearEnabled,
      autoClearThreshold: this._autoOps.autoClearThreshold,
      autoCompactEnabled: this._autoOps.autoCompactEnabled,
      autoCompactThreshold: this._autoOps.autoCompactThreshold,
      autoCompactPrompt: this._autoOps.autoCompactPrompt,
      autoResumeEnabled: this._autoOps.autoResumeEnabled,
      autoResumeAt: this._autoOps.autoResumeAt ?? undefined,
      imageWatcherEnabled: this._imageWatcherEnabled,
      totalCost: this._totalCost,
      inputTokens: this._totalInputTokens,
      outputTokens: this._totalOutputTokens,
      ralphEnabled: this._ralphTracker.enabled,
      ralphAutoEnableDisabled: this._ralphTracker.autoEnableDisabled || undefined,
      ralphCompletionPhrase: this._ralphTracker.loopState.completionPhrase || undefined,
      parentAgentId: this._parentAgentId || undefined,
      childAgentIds: this._childAgentIds.length > 0 ? this._childAgentIds : undefined,
      niceEnabled: this._niceConfig.enabled,
      niceValue: this._niceConfig.niceValue,
      color: this._color,
      flickerFilterEnabled: this._flickerFilterEnabled,
      cliVersion: this._cliVersion || undefined,
      cliModel: this._cliModel || undefined,
      cliAccountType: this._cliAccountType || undefined,
      cliLatestVersion: this._cliLatestVersion || undefined,
      openCodeConfig: this._openCodeConfig,
      codexConfig: this._codexConfig,
      resumeSessionId: this._resumeSessionId,
      effort: this._effort,
      attachmentHistory: this.attachmentHistory.length > 0 ? this.attachmentHistory : undefined,
      // envOverrides intentionally NOT on the public SessionState type — they must not
      // leak into SSE / GET /api/sessions broadcasts (schema allows OPENCODE_*, which
      // can carry secrets). For disk persistence, session-manager calls
      // getEnvOverridesForPersist() and writes alongside state.
    };
  }

  /**
   * Returns a subset of env overrides safe for disk persistence (state.json).
   * Only non-sensitive `CLAUDE_CODE_*` keys are included. `OPENCODE_*` keys are
   * filtered out because the schema permits them and they can carry secrets
   * (e.g., OPENCODE_API_KEY); secrets must not land in `~/.codeman/state.json`.
   * Must NOT be included in any API-bound serializer — see toState() comment.
   */
  getEnvOverridesForPersist(): Record<string, string> | undefined {
    if (!this._envOverrides) return undefined;
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(this._envOverrides)) {
      if (key.startsWith('CLAUDE_CODE_')) safe[key] = value;
    }
    return Object.keys(safe).length > 0 ? safe : undefined;
  }

  toDetailedState() {
    return {
      ...this.toLightDetailedState(),
      textOutput: this._textOutput.value,
      terminalBuffer: this._terminalBuffer.value,
    };
  }

  /**
   * Lightweight detailed state that excludes heavy buffers (textOutput, terminalBuffer).
   * Use for SSE session:updated broadcasts where buffers aren't needed.
   * Full buffers are fetched on-demand via /api/sessions/:id/terminal.
   */
  toLightDetailedState() {
    return {
      ...this.toState(),
      name: this._name,
      mode: this.mode,
      claudeSessionId: this._claudeSessionId,
      totalCost: this._totalCost,
      messageCount: this._messages.length,
      isWorking: this._isWorking,
      lastPromptTime: this._lastPromptTime,
      // Buffer statistics for monitoring long-running sessions
      bufferStats: {
        terminalBufferSize: this._terminalBuffer.length,
        textOutputSize: this._textOutput.length,
        messageCount: this._messages.length,
        maxTerminalBuffer: MAX_TERMINAL_BUFFER_SIZE,
        maxTextOutput: MAX_TEXT_OUTPUT_SIZE,
        maxMessages: MAX_MESSAGES,
      },
      // Background task tracking (light tree strips large output strings)
      taskStats: this._taskTracker.getStats(),
      taskTree: this._taskTracker.getTaskTreeLight(),
      // Token tracking
      tokens: {
        input: this._totalInputTokens,
        output: this._totalOutputTokens,
        total: this._totalInputTokens + this._totalOutputTokens,
      },
      autoClear: {
        enabled: this._autoOps.autoClearEnabled,
        threshold: this._autoOps.autoClearThreshold,
      },
      // CPU priority configuration
      nice: {
        enabled: this._niceConfig.enabled,
        niceValue: this._niceConfig.niceValue,
      },
      // Ralph tracking state
      ralphLoop: this._ralphTracker.loopState,
      ralphTodos: this._ralphTracker.todos,
      ralphTodoStats: this._ralphTracker.getTodoStats(),
    };
  }

  /**
   * Starts an interactive Claude CLI session with full terminal support.
   *
   * This spawns Claude CLI in interactive mode with the configured permission
   * mode (default: `--dangerously-skip-permissions`). If mux wrapping is enabled,
   * the session runs inside a tmux session for persistence across disconnects.
   *
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project', useMux: true });
   * await session.startInteractive();
   * session.on('terminal', (data) => process.stdout.write(data));
   * session.write('help me with this code\r');
   * ```
   */
  private async _setupOrAttachMuxSession(options: {
    respawnPaneOptions: import('./mux-interface.js').RespawnPaneOptions;
    createSessionOptions: import('./mux-interface.js').CreateSessionOptions;
    spawnErrLabel: string;
  }): Promise<{ isRestored: boolean }> {
    const mux = this._mux!;

    // Verify stale mux session — tmux may have been destroyed (e.g., killed externally)
    if (this._muxSession && !mux.muxSessionExists(this._muxSession.muxName)) {
      console.log('[Session] Stale mux session detected (tmux gone):', this._muxSession.muxName);
      this._muxSession = null;
    }

    // Check if session exists but pane is dead (remain-on-exit keeps it alive)
    // Respawn the pane instead of creating a whole new session — preserves tmux scrollback
    let needsNewSession = false;
    if (this._muxSession && mux.isPaneDead(this._muxSession.muxName)) {
      console.log('[Session] Dead pane detected, respawning:', this._muxSession.muxName);
      const newPid = await mux.respawnPane(options.respawnPaneOptions);
      if (!newPid) {
        console.error('[Session] Failed to respawn pane, will create new session');
        needsNewSession = true;
      } else {
        // Wait a moment for the respawned process to fully start
        await new Promise((resolve) => setTimeout(resolve, MUX_STARTUP_DELAY_MS));
      }
    }

    // Check if we already have a mux session (restored session)
    const isRestored = this._muxSession !== null && !needsNewSession;
    if (isRestored) {
      console.log('[Session] Attaching to existing mux session:', this._muxSession!.muxName);
    } else {
      // Create a new mux session
      this._muxSession = await mux.createSession(options.createSessionOptions);
      console.log('[Session] Created mux session:', this._muxSession.muxName);
      // No extra sleep — createSession() already waits for tmux readiness
    }

    // Attach to the mux session via PTY
    // Prevent tmux from letting the newest browser attach dictate global window
    // size; accepted Codeman resize events update it explicitly below.
    mux.setManualWindowSize?.(this._muxSession!.muxName);
    // Query existing tmux window size so re-attach matches (avoids flicker from 120x40 default).
    // MUST go through the dedicated socket (mux.muxSocket); a bare `tmux display` hits the
    // default server, always fails for our socketed sessions, and silently falls back to 120x40.
    const { cols: ptyCols, rows: ptyRows } = queryTmuxWindowSize(this._muxSession!.muxName, mux.muxSocket);
    try {
      this.ptyProcess = pty.spawn(mux.getAttachCommand(), mux.getAttachArgs(this._muxSession!.muxName), {
        name: 'xterm-256color',
        cols: ptyCols,
        rows: ptyRows,
        cwd: this.workingDir,
        env: buildMuxAttachEnv(),
      });
    } catch (spawnErr) {
      console.error(`[Session] Failed to spawn PTY for ${options.spawnErrLabel}:`, spawnErr);
      this.emit('error', `Failed to attach to mux session: ${spawnErr}`);
      throw spawnErr;
    }

    return { isRestored };
  }

  private _handleTerminalOutput(data: string): void {
    // Codex emits sequences that wipe xterm.js scrollback, plus mouse-tracking
    // enables that hijack the scroll wheel so the user can't reach scrollback:
    //   - \x1b[?1049h / \x1b[?47h / \x1b[?1047h: switch to the alt buffer (no
    //     scrollback) — \x1b[?...l switches back.
    //   - \x1b[3J: erase saved lines (scrollback). (\x1b[2J / \x1b[J — erase
    //     the visible viewport — are left intact; the TUI repaints those rows.)
    //   - \x1b[?1000h / 1002h / 1003h / 1005h / 1006h / 1007h: mouse-tracking
    //     modes (X10, button-event, any-event, UTF-8, SGR, alt-scroll). Once on,
    //     xterm.js forwards wheel events to codex instead of scrolling the
    //     viewport, so the conversation is in scrollback but unreachable.
    //     (Focus events at ?1004 are left alone — codeman uses them for
    //     active-tab detection.)
    // Strip them at the source so neither the persisted buffer nor the live
    // SSE/WS stream carries them, keeping everything in the main buffer with
    // scrollback intact. Codex's cursor-positioned redraws overwrite only the
    // cells they actually target, so the non-erased rows keep their content.
    if (this.mode === 'codex') {
      // Reassemble sequences split across PTY chunk boundaries first: a chunk
      // ending mid-sequence ('\x1b[?104' now, '9h' next) would slip past the
      // strip below and leave xterm stuck in the scrollback-less alt buffer
      // until the next buffer replay. Hold back an incomplete digit-only CSI
      // tail (≤7 chars — the longest strippable intro is '\x1b[?1049') and
      // prepend it to the next chunk; complete sequences are never held.
      data = this._codexSeqCarry + data;
      this._codexSeqCarry = '';
      // eslint-disable-next-line no-control-regex
      const splitTail = data.match(/\x1b(?:\[\??[0-9]{0,4})?$/);
      if (splitTail) {
        this._codexSeqCarry = splitTail[0];
        data = data.slice(0, -splitTail[0].length);
        if (!data) return;
      }
      data = data
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[\?(?:47|1047|1049)[hl]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[3J/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g, '');
    }

    // Scan terminal output for `codeman://attach?path=...` magic links and emit
    // an attachmentRequested event for each newly-seen absolute path. The web
    // server turns these into registered attachment cards.
    const attachmentPaths = parseAttachmentMagicLinks(data);
    for (const attachmentPath of attachmentPaths) {
      if (this._attachmentMagicSeen.has(attachmentPath)) continue;
      this._attachmentMagicSeen.add(attachmentPath);
      if (this._attachmentMagicSeen.size > 200) {
        const oldest = this._attachmentMagicSeen.values().next().value;
        if (oldest) this._attachmentMagicSeen.delete(oldest);
      }
      this.emit('attachmentRequested', { sessionId: this.id, path: attachmentPath, timestamp: Date.now() });
    }

    // BufferAccumulator handles auto-trimming when max size exceeded
    this._terminalBuffer.append(data);
    this._lastActivityAt = Date.now();
    this.emit('terminal', data);
    this.emit('output', data);
  }

  async startInteractive(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._resetBuffers();

    const modeLabel = this.mode === 'opencode' ? 'OpenCode' : this.mode === 'codex' ? 'Codex' : 'Claude';
    console.log(
      `[Session] Starting interactive ${modeLabel} session` + (this._useMux ? ` (with ${this._mux!.backend})` : '')
    );

    // If mux wrapping is enabled, create or attach to a mux session
    if (this._useMux && this._mux) {
      try {
        const { isRestored } = await this._setupOrAttachMuxSession({
          respawnPaneOptions: {
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: this.mode,
            niceConfig: this._niceConfig,
            model: this._model,
            claudeMode: this._claudeMode,
            allowedTools: this._allowedTools,
            openCodeConfig: this._openCodeConfig,
            codexConfig: this._codexConfig,
            resumeSessionId: this._resumeSessionId,
            envOverrides: this._envOverrides,
            effort: this._effort,
          },
          createSessionOptions: {
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: this.mode,
            name: this._name,
            niceConfig: this._niceConfig,
            model: this._model,
            claudeMode: this._claudeMode,
            allowedTools: this._allowedTools,
            openCodeConfig: this._openCodeConfig,
            codexConfig: this._codexConfig,
            resumeSessionId: this._resumeSessionId,
            envOverrides: this._envOverrides,
            effort: this._effort,
          },
          spawnErrLabel: 'mux attachment',
        });

        // Set claudeSessionId — when resuming, the Claude conversation ID is the resumed one.
        this._claudeSessionId = this._resumeSessionId || this.id;

        // For NEW mux sessions: wait for readiness then clean buffer
        // For RESTORED mux sessions: don't do anything - client will fetch buffer on tab switch
        if (!isRestored) {
          if (isExternalCliMode(this.mode)) {
            // External CLIs use custom TUIs — no ❯ prompt to detect.
            // Wait for TUI to stabilize (output stops changing), then mark ready.
            // Don't clear the buffer — the TUI's initial render IS the useful content.
            // Emit needsRefresh so the client fetches the full buffer once the TUI has rendered.
            this._promptCheckTimeout = setTimeout(() => {
              this._promptCheckTimeout = null;
              if (this._isStopped) return;
              this._status = 'idle';
              this.emit('needsRefresh');
            }, 3000);
          } else {
            // Claude mode: wait for ❯ prompt
            this._promptCheckInterval = setInterval(() => {
              // Wait for the prompt character (❯) which means Claude is fully initialized
              const bufferValue = this._terminalBuffer.value;
              if (bufferValue.includes('❯') || bufferValue.includes('\u276f')) {
                if (this._promptCheckInterval) {
                  clearInterval(this._promptCheckInterval);
                  this._promptCheckInterval = null;
                }
                if (this._promptCheckTimeout) {
                  clearTimeout(this._promptCheckTimeout);
                  this._promptCheckTimeout = null;
                }
                // Clean the buffer - remove mux init junk before actual content
                // Strip: cursor movement (\x1b[nA/B/C/D), positioning (\x1b[n;nH),
                // clear screen (\x1b[2J), scroll region (\x1b[n;nr), and whitespace
                this._terminalBuffer.set(bufferValue.replace(LEADING_ANSI_WHITESPACE_PATTERN, ''));
                // Signal client to refresh
                this.emit('clearTerminal');
              }
            }, 50);
            // Timeout after 5 seconds if prompt not found
            this._promptCheckTimeout = setTimeout(() => {
              if (this._promptCheckInterval) {
                clearInterval(this._promptCheckInterval);
                this._promptCheckInterval = null;
              }
              this._promptCheckTimeout = null;
            }, 5000);
          }
        }
      } catch (err) {
        console.error('[Session] Failed to create mux session, falling back to direct PTY:', err);
        this._useMux = false;
        this._muxSession = null;
      }
    }

    // Fallback to direct PTY if mux is not used
    if (!this.ptyProcess) {
      // OpenCode sessions require tmux for env var injection (API keys via setenv)
      if (this.mode === 'opencode') {
        throw new Error('OpenCode sessions require tmux. Direct PTY fallback is not supported.');
      }
      // Codex sessions require tmux for OPENAI_API_KEY injection via setenv
      if (this.mode === 'codex') {
        throw new Error('Codex sessions require tmux. Direct PTY fallback is not supported.');
      }
      try {
        // Pass --session-id to use the SAME ID as the Codeman session
        // This ensures subagents can be directly matched to the correct tab
        const args = buildInteractiveArgs(this.id, this._claudeMode, this._model, this._allowedTools, this._effort);
        this.ptyProcess = pty.spawn('claude', args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          // Merge envOverrides after buildClaudeEnv so user settings shadow defaults.
          env: { ...buildClaudeEnv(this.id), ...(this._envOverrides ?? {}) },
        });
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn Claude PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start Claude: ${spawnErr}`);
        throw new Error(`Failed to spawn Claude process: ${spawnErr}`);
      }
    }

    // Set claudeSessionId — when resuming, the Claude conversation ID is the resumed one.
    this._claudeSessionId = this._resumeSessionId || this.id;

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Interactive PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences and Ctrl+L (form feed)
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '').replace(CTRL_L_PATTERN, ''); // Remove Ctrl+L
      if (!data) return; // Skip if only filtered sequences

      this._handleTerminalOutput(data);

      // === Auto-accept workspace trust dialog ===
      // Claude CLI 2.x shows "Yes, I trust this folder" prompt on first launch per directory.
      // Codeman sessions always use --dangerously-skip-permissions, so auto-accept.
      if (!this._trustDialogAccepted && data.includes('trust this folder')) {
        this._trustDialogAccepted = true;
        console.log(`[Session] Auto-accepting workspace trust dialog for: ${this.id}`);
        // Send Enter to accept the default selection ("Yes, I trust this folder")
        this.writeViaMux('\r');
      }

      // === Idle/working detection runs on every chunk (latency-sensitive) ===
      // Detect if Claude is working or at prompt
      // The prompt line contains "❯" when waiting for input
      if (data.includes('❯') || data.includes('\u276f')) {
        // Only start a new timeout if we're not already awaiting idle confirmation
        // This prevents status bar redraws (which include ❯) from resetting the timer
        if (!this._awaitingIdleConfirmation) {
          if (this.activityTimeout) clearTimeout(this.activityTimeout);
          this._awaitingIdleConfirmation = true;
          this.activityTimeout = setTimeout(() => {
            this._awaitingIdleConfirmation = false;
            // Emit idle if either:
            // 1. Claude was working and is now at prompt (normal case)
            // 2. Session just started and is ready (status is 'busy' but _isWorking is false)
            const wasWorking = this._isWorking;
            const isInitialReady = this._status === 'busy' && !this._isWorking;
            if (wasWorking || isInitialReady) {
              this._isWorking = false;
              this._status = 'idle';
              this._lastPromptTime = Date.now();
              this.emit('idle');
            }
          }, IDLE_DETECTION_DELAY_MS);
        }
      }

      // Detect when Claude starts working (thinking, writing, etc)
      // Fast path: check spinner characters on raw data (Unicode, never in ANSI sequences)
      const hasSpinner = SPINNER_PATTERN.test(data);
      if (hasSpinner) {
        if (!this._isWorking) {
          this._isWorking = true;
          this._status = 'busy';
          this.emit('working');
          this._autoOps.notifyWorking();
        }
        this._awaitingIdleConfirmation = false;
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
      }

      // === Expensive processing (ANSI strip, Ralph, bash parser) is throttled ===
      // Instead of running regex-heavy parsers on every PTY chunk, we accumulate
      // raw data and process at most every EXPENSIVE_PROCESS_INTERVAL_MS.
      // This dramatically reduces CPU load with multiple busy sessions.
      const now = Date.now();
      const elapsed = now - this._lastExpensiveProcessTime;
      if (elapsed >= Session.EXPENSIVE_PROCESS_INTERVAL_MS) {
        // Process immediately — include any previously accumulated data
        this._lastExpensiveProcessTime = now;
        const accumulated = this._pendingCleanData ? this._pendingCleanData + data : data;
        this._pendingCleanData = '';
        if (this._expensiveProcessTimer) {
          clearTimeout(this._expensiveProcessTimer);
          this._expensiveProcessTimer = null;
        }
        this._processExpensiveParsers(accumulated);
      } else {
        // Accumulate for deferred processing
        this._pendingCleanData += data;
        // Cap accumulated size to prevent unbounded growth
        if (this._pendingCleanData.length > 64 * 1024) {
          this._pendingCleanData = this._pendingCleanData.slice(-32 * 1024);
        }
        // Schedule deferred processing if not already scheduled
        if (!this._expensiveProcessTimer) {
          this._expensiveProcessTimer = setTimeout(() => {
            this._expensiveProcessTimer = null;
            this._lastExpensiveProcessTime = Date.now();
            const pending = this._pendingCleanData;
            this._pendingCleanData = '';
            if (pending) {
              this._processExpensiveParsers(pending);
            }
          }, Session.EXPENSIVE_PROCESS_INTERVAL_MS - elapsed);
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Interactive PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      this._awaitingIdleConfirmation = false;
      // Clear all timers to prevent memory leaks
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      if (this._promptCheckInterval) {
        clearInterval(this._promptCheckInterval);
        this._promptCheckInterval = null;
      }
      if (this._promptCheckTimeout) {
        clearTimeout(this._promptCheckTimeout);
        this._promptCheckTimeout = null;
      }
      // Clear expensive processing timer and flush any pending data
      if (this._expensiveProcessTimer) {
        clearTimeout(this._expensiveProcessTimer);
        this._expensiveProcessTimer = null;
      }
      this._pendingCleanData = '';
      // If using mux, mark the session as detached but don't kill it
      if (this._muxSession && this._mux) {
        this._mux.setAttached(this.id, false);
      }
      this.emit('exit', exitCode);
    });
  }

  /**
   * Process expensive parsers (ANSI strip, Ralph, bash tool, token, CLI info, task descriptions).
   * Called on a throttled schedule (every EXPENSIVE_PROCESS_INTERVAL_MS) instead of on every
   * PTY data chunk. Receives accumulated raw data to process in one batch.
   */
  private _processExpensiveParsers(rawData: string): void {
    // Skip Claude-specific parsers for external CLI sessions (Ralph tracker,
    // BashToolParser, token + CLI-info parsing all depend on Claude's output format).
    if (isExternalCliMode(this.mode)) return;

    // Lazy ANSI strip: only compute cleanData when a consumer actually needs it.
    let _cleanData: string | null = null;
    const getCleanData = (): string => {
      if (_cleanData === null) {
        _cleanData = rawData.replace(ANSI_ESCAPE_PATTERN_FULL, '');
      }
      return _cleanData;
    };

    // Forward to Ralph tracker to detect Ralph loops and todos
    // (opencode sessions already returned early at line 1209)
    if (this._ralphTracker.enabled || !this._ralphTracker.autoEnableDisabled) {
      this._ralphTracker.processCleanData(getCleanData());
    }

    // Forward to Bash tool parser to detect file-viewing commands
    if (this._bashToolParser.enabled) {
      this._bashToolParser.processCleanData(getCleanData());
    }

    // Usage-limit pause detection (auto-resume on usage limit)
    if (this._autoOps.autoResumeEnabled) {
      this._autoOps.processCleanData(getCleanData());
    }

    // Parse token count from status line (e.g., "123.4k tokens" or "5234 tokens")
    if (rawData.includes('token')) {
      this.parseTokensFromStatusLine(getCleanData());
    }

    // Parse Claude Code CLI info (version, model, account type) from startup
    if (!this._cliInfoParsed) {
      this.parseClaudeCodeInfo(getCleanData());
    }

    // Parse task descriptions from terminal output (e.g., "Explore(Check files)")
    if (rawData.includes('(') && rawData.includes(')')) {
      this.parseTaskDescriptionsFromTerminalData(getCleanData());
    }

    // Work keyword detection (text-based, needs clean data)
    // Only check if spinner didn't already trigger working state
    if (!this._isWorking) {
      const cleanData = getCleanData();
      if (
        cleanData.includes('Thinking') ||
        cleanData.includes('Writing') ||
        cleanData.includes('Reading') ||
        cleanData.includes('Running')
      ) {
        this._isWorking = true;
        this._status = 'busy';
        this.emit('working');
        this._autoOps.notifyWorking();
        this._awaitingIdleConfirmation = false;
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
      }
    }
  }

  /**
   * Starts a plain shell session (bash/zsh) without Claude CLI.
   *
   * Useful for debugging, testing, or when you just need a terminal.
   * Uses the user's default shell from $SHELL or falls back to /bin/bash.
   *
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project', mode: 'shell' });
   * await session.startShell();
   * session.write('ls -la\r');
   * ```
   */
  async startShell(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._resetBuffers();

    // Use user's default shell or bash
    const shell = process.env.SHELL || '/bin/bash';
    console.log(
      '[Session] Starting shell session with:',
      shell + (this._useMux ? ` (with ${this._mux!.backend})` : '')
    );

    // If mux wrapping is enabled, create or attach to a mux session
    if (this._useMux && this._mux) {
      try {
        const { isRestored } = await this._setupOrAttachMuxSession({
          respawnPaneOptions: {
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: 'shell',
            niceConfig: this._niceConfig,
            envOverrides: this._envOverrides,
          },
          createSessionOptions: {
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: 'shell',
            name: this._name,
            niceConfig: this._niceConfig,
            envOverrides: this._envOverrides,
          },
          spawnErrLabel: 'shell mux attachment',
        });

        // For NEW sessions: clear by sending 'clear' command to the shell
        // For RESTORED sessions: don't clear - we want to see the existing output
        if (!isRestored) {
          setTimeout(() => {
            if (this.ptyProcess) {
              this._terminalBuffer.clear();
              this.ptyProcess.write('clear\n');
            }
          }, 100);
        }
      } catch (err) {
        console.error('[Session] Failed to create mux session, falling back to direct PTY:', err);
        this._useMux = false;
        this._muxSession = null;
      }
    }

    // Fallback to direct PTY if mux is not used
    if (!this.ptyProcess) {
      try {
        this.ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: buildShellEnv(this.id),
        });
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn shell PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start shell: ${spawnErr}`);
        throw new Error(`Failed to spawn shell process: ${spawnErr}`);
      }
    }

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Shell PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
      if (!data) return; // Skip if only focus sequences

      this._handleTerminalOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Shell PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      // Clear timers to prevent memory leaks
      if (this._shellIdleTimer) {
        clearTimeout(this._shellIdleTimer);
        this._shellIdleTimer = null;
      }
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      // If using mux, mark the session as detached but don't kill it
      if (this._muxSession && this._mux) {
        this._mux.setAttached(this.id, false);
      }
      this.emit('exit', exitCode);
    });

    // Mark as idle after a short delay (shell is ready)
    this._shellIdleTimer = setTimeout(() => {
      this._shellIdleTimer = null;
      this._status = 'idle';
      this._isWorking = false;
      this.emit('idle');
    }, 500);
  }

  /**
   * Runs a one-shot prompt and returns the result.
   *
   * This spawns Claude CLI with `--output-format stream-json` to get
   * structured JSON output. The promise resolves when Claude completes
   * the response.
   *
   * @param prompt - The prompt text to send to Claude
   * @param options - Optional configuration
   * @param options.model - Model to use ('opus', 'sonnet', or full model name). Defaults to default model.
   * @param options.onProgress - Callback for progress updates (token count, status)
   * @returns Promise resolving to the result text and total cost in USD
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project' });
   * const { result, cost } = await session.runPrompt('Explain this code', { model: 'opus' });
   * console.log(`Response: ${result}`);
   * console.log(`Cost: $${cost.toFixed(4)}`);
   * ```
   */
  async runPrompt(
    prompt: string,
    options?: { model?: string; onProgress?: (info: { tokens?: number; status?: string }) => void }
  ): Promise<{ result: string; cost: number }> {
    return new Promise((resolve, reject) => {
      if (this.ptyProcess) {
        reject(new Error('Session already has a running process'));
        return;
      }

      this._resetBuffers();
      this._promptResolved = false; // Reset race condition guard

      this.resolvePromise = resolve;
      this.rejectPromise = reject;

      try {
        // Spawn claude in a real PTY
        const model = options?.model;
        console.log(
          '[Session] Spawning PTY for claude with prompt:',
          prompt.substring(0, 50),
          model ? `(model: ${model})` : ''
        );

        const args = buildPromptArgs(prompt, model);

        try {
          this.ptyProcess = pty.spawn('claude', args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: this.workingDir,
            // Merge envOverrides after buildClaudeEnv so user settings shadow defaults.
            env: { ...buildClaudeEnv(this.id), ...(this._envOverrides ?? {}) },
          });
        } catch (spawnErr) {
          console.error('[Session] Failed to spawn Claude PTY for runPrompt:', spawnErr);
          this.emit(
            'error',
            `Failed to spawn Claude: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`
          );
          throw spawnErr;
        }

        this._pid = this.ptyProcess.pid;
        console.log('[Session] PTY spawned with PID:', this._pid);

        // Handle terminal data
        this.ptyProcess.onData((rawData: string) => {
          // Filter out focus escape sequences
          const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
          if (!data) return; // Skip if only focus sequences

          this._handleTerminalOutput(data);

          // Also try to parse JSON lines for structured data
          this.processOutput(data);
        });

        // Handle exit
        this.ptyProcess.onExit(({ exitCode }) => {
          console.log('[Session] PTY exited with code:', exitCode);
          this.ptyProcess = null;
          this._pid = null;

          // Guard against race conditions: only process once per runPrompt call
          if (this._promptResolved) {
            this.emit('exit', exitCode);
            return;
          }
          this._promptResolved = true;

          // Capture callbacks atomically before processing
          const resolve = this.resolvePromise;
          const reject = this.rejectPromise;
          this.resolvePromise = null;
          this.rejectPromise = null;

          // Find result from parsed messages or use text output
          const resultMsg = this._messages.find((m) => m.type === 'result');

          if (resultMsg && !resultMsg.is_error) {
            this._status = 'idle';
            const cost = resultMsg.total_cost_usd || 0;
            this._totalCost += cost;
            // Claude CLI stream-json may return empty result field — fall back to accumulated text output
            const result = resultMsg.result || this._textOutput.value || '';
            this.emit('completion', result, cost);
            if (resolve) {
              resolve({ result, cost });
            }
          } else if (exitCode !== 0 || (resultMsg && resultMsg.is_error)) {
            this._status = 'error';
            if (reject) {
              reject(new Error(this._errorBuffer || this._textOutput.value || 'Process exited with error'));
            }
          } else {
            this._status = 'idle';
            if (resolve) {
              resolve({
                result: this._textOutput.value || this._terminalBuffer.value,
                cost: this._totalCost,
              });
            }
          }

          this.emit('exit', exitCode);
        });
      } catch (err) {
        this._status = 'error';
        reject(err);
        // Null callbacks to prevent memory leak (onExit won't run if spawn failed)
        this.resolvePromise = null;
        this.rejectPromise = null;
      }
    });
  }

  private _resetBuffers(): void {
    this._status = 'busy';
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._codexSeqCarry = '';
    this._lastActivityAt = Date.now();
  }

  private _clearAllTimers(): void {
    // Clear activity timeout to prevent memory leak
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }

    // Clear line buffer flush timer
    if (this._lineBufferFlushTimer) {
      clearTimeout(this._lineBufferFlushTimer);
      this._lineBufferFlushTimer = null;
    }

    // Destroy auto-compact/auto-clear automation (clears its timers)
    this._autoOps.destroy();

    // Clear prompt check timers
    if (this._promptCheckInterval) {
      clearInterval(this._promptCheckInterval);
      this._promptCheckInterval = null;
    }
    if (this._promptCheckTimeout) {
      clearTimeout(this._promptCheckTimeout);
      this._promptCheckTimeout = null;
    }

    // Clear shell idle timer
    if (this._shellIdleTimer) {
      clearTimeout(this._shellIdleTimer);
      this._shellIdleTimer = null;
    }

    // Clear expensive processing timer
    if (this._expensiveProcessTimer) {
      clearTimeout(this._expensiveProcessTimer);
      this._expensiveProcessTimer = null;
    }
    this._pendingCleanData = '';
  }

  private _handleJsonMessage(cleanLine: string, rawLine: string): void {
    try {
      const msg = JSON.parse(cleanLine) as ClaudeMessage;
      this._messages.push(msg);
      this.emit('message', msg);

      // Trim messages array for long-running sessions
      if (this._messages.length > MAX_MESSAGES) {
        this._messages = this._messages.slice(-Math.floor(MAX_MESSAGES * 0.8));
      }

      // Extract Claude session ID from messages (can be in any message type).
      // Support both sessionId (camelCase) and session_id (snake_case).
      // The constructor seeds _claudeSessionId with this.id as a placeholder;
      // once Claude CLI emits its real session ID, adopt it so JSONL lookups
      // (e.g. /api/sessions/:id/last-response) can find the transcript file.
      const msgSessionId =
        ((msg as unknown as Record<string, unknown>).sessionId as string | undefined) ?? msg.session_id;
      if (msgSessionId && msgSessionId !== this._claudeSessionId) {
        this._claudeSessionId = msgSessionId;
      }

      // Process message for task tracking
      this._taskTracker.processMessage(msg);

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            this._textOutput.append(block.text);
          }
        }
        // Track tokens from usage (with validation)
        if (msg.message.usage) {
          const inputDelta = msg.message.usage.input_tokens || 0;
          const outputDelta = msg.message.usage.output_tokens || 0;

          // Sanity check: max 100k tokens per message (generous limit)
          const MAX_TOKENS_PER_MESSAGE = 100_000;
          if (inputDelta > 0 && inputDelta <= MAX_TOKENS_PER_MESSAGE) {
            this._totalInputTokens += inputDelta;
          }
          if (outputDelta > 0 && outputDelta <= MAX_TOKENS_PER_MESSAGE) {
            this._totalOutputTokens += outputDelta;
          }

          // Check if we should auto-compact or auto-clear
          this._autoOps.checkAutoCompact();
          this._autoOps.checkAutoClear();
        }
      }

      if (msg.type === 'result' && msg.total_cost_usd) {
        this._totalCost = msg.total_cost_usd;
      }
    } catch (parseErr) {
      // Not JSON, just regular output - this is expected for non-JSON lines
      console.debug(
        '[Session] Line not JSON (expected for text output):',
        parseErr instanceof Error ? parseErr.message : parseErr
      );
      this._textOutput.append(rawLine + '\n');
    }
  }

  private processOutput(data: string): void {
    // Early return if session is stopped to prevent any processing or timer creation
    if (this._isStopped) return;

    // Try to extract JSON from output (Claude may output JSON in stream mode)
    this._lineBuffer += data;

    // Prevent unbounded line buffer growth for very long lines
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      // Force flush the oversized buffer as text output
      this._textOutput.append(this._lineBuffer + '\n');
      this._lineBuffer = '';
    }

    // Start flush timer if not running (handles partial lines after 100ms)
    if (!this._lineBufferFlushTimer && this._lineBuffer.length > 0 && !this._isStopped) {
      this._lineBufferFlushTimer = setTimeout(() => {
        this._lineBufferFlushTimer = null;
        if (this._lineBuffer.length > 0 && !this._isStopped) {
          // Flush partial line as text output
          this._textOutput.append(this._lineBuffer);
          this._lineBuffer = '';
        }
      }, LINE_BUFFER_FLUSH_INTERVAL);
    }

    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || '';

    // Clear flush timer if buffer is now empty
    if (this._lineBuffer.length === 0 && this._lineBufferFlushTimer) {
      clearTimeout(this._lineBufferFlushTimer);
      this._lineBufferFlushTimer = null;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      // Remove ANSI escape codes for JSON parsing (use pre-compiled pattern)
      const cleanLine = trimmed.replace(ANSI_ESCAPE_PATTERN_FULL, '');

      if (cleanLine.startsWith('{') && cleanLine.endsWith('}')) {
        this._handleJsonMessage(cleanLine, line);
      } else if (trimmed) {
        this._textOutput.append(line + '\n');
      }

      // Parse task descriptions from terminal output (e.g., "Explore(Description)")
      // This captures the short description from Claude Code's Task tool output
      // Use direct method since cleanLine is already ANSI-stripped (line 1460)
      this.parseTaskDescriptionsDirect(cleanLine);
    }
    // Note: BufferAccumulator auto-trims when max size exceeded
  }

  /**
   * Parse task descriptions from terminal data (may contain multiple lines).
   * Called from interactive mode's onData handler with ANSI-stripped data.
   * @param cleanData - Terminal data with ANSI codes already stripped
   */
  private parseTaskDescriptionsFromTerminalData(cleanData: string): void {
    // Quick pre-check: skip if no parentheses present
    if (!cleanData.includes('(') || !cleanData.includes(')')) return;

    // Split by newlines and process each line (data already ANSI-stripped)
    const lines = cleanData.split(NEWLINE_SPLIT_PATTERN);
    for (const line of lines) {
      this.parseTaskDescriptionsDirect(line);
    }
  }

  /**
   * Parse task descriptions from a pre-cleaned line (no ANSI codes).
   * Used by both processOutput() and parseTaskDescriptionsFromTerminalData().
   */
  private parseTaskDescriptionsDirect(cleanLine: string): void {
    // Quick pre-check: skip expensive regex if no common tool patterns present
    if (!cleanLine.includes('(') || !cleanLine.includes(')')) return;

    execPattern(TASK_TOOL_PATTERN, cleanLine, (match) => {
      const description = match[2].trim();
      if (description && description.length > 0) {
        this._taskCache.add(Date.now(), description);
      }
    });
  }

  /**
   * Get recent task descriptions parsed from terminal output.
   * Returns descriptions sorted by timestamp (most recent first).
   */
  getRecentTaskDescriptions(): Array<{ timestamp: number; description: string }> {
    return this._taskCache.getAll();
  }

  /**
   * Find a task description that was parsed close to a given timestamp.
   * Used to correlate with SubagentWatcher discoveries.
   *
   * @param subagentStartTime - The timestamp when the subagent was discovered
   * @param maxAgeMs - Maximum age difference to consider (default 10 seconds)
   * @returns The matching description or undefined
   */
  findTaskDescriptionNear(subagentStartTime: number, maxAgeMs: number = 10000): string | undefined {
    return this._taskCache.findNear(subagentStartTime, maxAgeMs);
  }

  // Parse token count from Claude's status line in interactive mode
  // Matches patterns like "123.4k tokens", "5234 tokens", "1.2M tokens"
  //
  // SAFETY LIMITS:
  // - Max tokens per session: 500k (Claude's context is ~200k)
  // - Max delta per update: 100k (prevents sudden jumps from parsing errors)
  // - Rejects "M" suffix values > 0.5 (500k) to prevent false matches
  private parseTokensFromStatusLine(cleanData: string): void {
    // Quick pre-check: skip expensive regex if "token" not present (performance optimization)
    if (!cleanData.includes('token')) return;

    // Match patterns: "123.4k tokens", "5234 tokens", "1.2M tokens"
    // The status line typically shows total tokens like "1.2k tokens" near the prompt
    // Note: ANSI codes are already stripped by caller for performance
    const tokenMatch = cleanData.match(TOKEN_PATTERN);

    if (tokenMatch) {
      let tokenCount = parseFloat(tokenMatch[1]);
      const suffix = tokenMatch[2]?.toLowerCase();

      // Convert k/M suffix to actual number
      if (suffix === 'k') {
        tokenCount *= 1000;
      } else if (suffix === 'm') {
        // Safety: Reject M values that would result in > 500k tokens
        // Claude's context window is ~200k, so anything claiming millions is likely a false match
        if (tokenCount > 0.5) {
          console.warn(
            `[Session ${this.id}] Rejected suspicious M token value: ${tokenMatch[0]} (would be ${tokenCount * 1000000} tokens)`
          );
          return;
        }
        tokenCount *= 1000000;
      }

      // Safety: Absolute maximum tokens per session
      if (tokenCount > MAX_SESSION_TOKENS) {
        console.warn(`[Session ${this.id}] Rejected token count exceeding max: ${tokenCount} > ${MAX_SESSION_TOKENS}`);
        return;
      }

      // Only update if the new count is higher (tokens only increase within a session)
      // We use total tokens as an estimate - Claude shows combined input+output
      const currentTotal = this._totalInputTokens + this._totalOutputTokens;
      if (tokenCount > currentTotal) {
        const delta = tokenCount - currentTotal;

        // Safety: Reject suspiciously large jumps (max 100k per update)
        const MAX_DELTA_PER_UPDATE = 100_000;
        if (delta > MAX_DELTA_PER_UPDATE) {
          console.warn(
            `[Session ${this.id}] Rejected suspicious token jump: ${currentTotal} -> ${tokenCount} (delta: ${delta})`
          );
          return;
        }

        // Estimate: split roughly 60% input, 40% output (common ratio)
        // This is an approximation since interactive mode doesn't give us the breakdown
        this._totalInputTokens += Math.round(delta * 0.6);
        this._totalOutputTokens += Math.round(delta * 0.4);

        // Check if we should auto-compact or auto-clear
        this._autoOps.checkAutoCompact();
        this._autoOps.checkAutoClear();
      }
    }
  }

  // Parse Claude Code CLI info from terminal startup output
  // Extracts version, model, and account type for display in Codeman UI
  // Note: Expects cleanData with ANSI codes already stripped by caller
  private parseClaudeCodeInfo(cleanData: string): void {
    // Only parse once per session (during startup)
    if (this._cliInfoParsed) return;

    // Quick pre-checks
    if (
      !cleanData.includes('Claude') &&
      !cleanData.includes('current:') &&
      !cleanData.includes('Opus') &&
      !cleanData.includes('Sonnet')
    ) {
      return;
    }
    let changed = false;

    // Match "Claude Code v2.1.27" or "Claude Code vX.Y.Z"
    if (!this._cliVersion) {
      const versionMatch = cleanData.match(/Claude Code v(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        this._cliVersion = versionMatch[1];
        changed = true;
      }
    }

    // Match model and account: "Opus 4.5 · Claude Max" or "Sonnet 4 · API"
    // The · character separates model from account type
    if (!this._cliModel || !this._cliAccountType) {
      // Try various model patterns
      const modelPatterns = [
        /(Opus \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
        /(Sonnet \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
        /(Haiku \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
      ];

      for (const pattern of modelPatterns) {
        const match = cleanData.match(pattern);
        if (match) {
          if (!this._cliModel) {
            this._cliModel = match[1].trim();
            changed = true;
          }
          if (!this._cliAccountType) {
            this._cliAccountType = match[2].trim();
            changed = true;
          }
          break;
        }
      }
    }

    // Match version check: "current: 2.1.27" and "latest: 2.1.27"
    if (!this._cliLatestVersion) {
      const latestMatch = cleanData.match(/latest:\s*(\d+\.\d+\.\d+)/);
      if (latestMatch) {
        this._cliLatestVersion = latestMatch[1];
        changed = true;
      }
    }

    // Mark as parsed once we have the essential info
    if (this._cliVersion && this._cliModel) {
      this._cliInfoParsed = true;
    }

    // Emit update if anything changed
    if (changed) {
      this.emit('cliInfoUpdated', {
        version: this._cliVersion,
        model: this._cliModel,
        accountType: this._cliAccountType,
        latestVersion: this._cliLatestVersion,
      });
    }
  }

  // Note: checkAutoCompact/checkAutoClear moved to SessionAutoOps (this._autoOps)

  /**
   * Sends input directly to the PTY process.
   *
   * For interactive sessions, this is how you send user input to Claude.
   * Remember to include `\r` (carriage return) to simulate pressing Enter.
   *
   * @param data - The input data to send (text, escape sequences, etc.)
   *
   * @example
   * ```typescript
   * session.write('hello world');  // Text only, no Enter
   * session.write('\r');           // Enter key
   * session.write('ls -la\r');     // Command with Enter
   * ```
   */
  write(data: string): void {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  /**
   * Sends input via the terminal multiplexer's direct input mechanism.
   *
   * More reliable than direct PTY write for programmatic input, especially
   * with Claude CLI which uses Ink (React for terminals).
   * Uses tmux `send-keys -l` to inject text + Enter.
   *
   * @param data - Input data with optional `\r` for Enter
   * @returns true if input was sent, false if no mux session or PTY
   *
   * @example
   * ```typescript
   * session.writeViaMux('/clear\r');  // Send /clear command
   * session.writeViaMux('/init\r');   // Send /init command
   * ```
   */
  async writeViaMux(data: string): Promise<boolean> {
    if (this._mux && this._muxSession) {
      return this._mux.sendInput(this.id, data);
    }
    // Fallback to PTY write
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
      return true;
    }
    return false;
  }

  /** Current PTY dimensions — used to skip no-op resizes that trigger Ink redraws */
  private _ptyCols = 120;
  private _ptyRows = 40;

  /**
   * Live WebSocket connections that have announced a desktop viewport for this
   * session. While at least one is registered, small-viewport (mobile/tablet)
   * resizes are ignored so a phone glancing at the session can't reflow the
   * PTY under an active desktop view. Claims are connection-scoped: ws-routes
   * registers them on a desktop-typed resize and releases them on socket
   * close, so a mobile-only session (no desktop connected) keeps full control
   * of its own size — including narrowing below the spawn default.
   *
   * Deliberate tradeoff: claims are WS-only because only a socket has a
   * liveness signal. A desktop degraded to the stateless HTTP resize fallback
   * still applies its typed resizes but holds no claim, so a concurrent phone
   * can reflow it. This is cooperative UX arbitration, not a security
   * boundary — untyped (legacy/API) resizes bypass claims by design.
   */
  private _desktopSizeClaims = new Set<symbol>();

  /**
   * A desktop sizing claim only blocks small-viewport resizes while the
   * desktop is RECENTLY ACTIVE (claim registration or typed input within this
   * window). An abandoned-but-connected desktop tab (left open at home, screen
   * locked) must not hold a phone's view hostage: without this, the phone
   * renders a desktop-width stream in a narrow xterm — mid-word wraps, tmux
   * dot-fill, and Ink overdraw soup (the 0.9.8–0.9.12 mobile regression).
   */
  private static readonly DESKTOP_CLAIM_IDLE_MS = 90_000;

  /** Last evidence of a live desktop user (claim registered / typed input). */
  private _lastDesktopActivityAt = 0;

  /** Last desktop-typed dimensions, for re-asserting after a mobile override. */
  private _lastDesktopDims: { cols: number; rows: number } | null = null;

  /** True while a small viewport reflowed the pane past an idle desktop claim. */
  private _mobileSizeOverride = false;

  /** Register a live desktop sizing claim (see _desktopSizeClaims). */
  claimDesktopSizing(token: symbol): void {
    this._desktopSizeClaims.add(token);
    this._lastDesktopActivityAt = Date.now();
  }

  /** Release a desktop sizing claim when its connection goes away. */
  releaseDesktopSizing(token: symbol): void {
    this._desktopSizeClaims.delete(token);
  }

  /**
   * Record desktop user activity (typed input over a claim-holding socket).
   * If a phone reflowed the pane while the desktop was idle, the desktop
   * layout is restored — "whoever is actively using the session wins".
   */
  noteDesktopActivity(): void {
    this._lastDesktopActivityAt = Date.now();
    if (this._mobileSizeOverride && this._lastDesktopDims) {
      this._mobileSizeOverride = false;
      this.resize(this._lastDesktopDims.cols, this._lastDesktopDims.rows, { viewportType: 'desktop' });
    }
  }

  /**
   * Resizes the PTY terminal dimensions.
   * Skips the resize if dimensions haven't changed to avoid triggering
   * unnecessary Ink full-screen redraws (visible flicker on tab switch).
   *
   * Arbitration: while a desktop connection holds a sizing claim AND has been
   * active within DESKTOP_CLAIM_IDLE_MS, resizes from small viewports
   * (mobile/tablet) are ignored — shrink AND grow would both reflow the
   * desktop view. Once the desktop goes idle, a phone may take the pane (the
   * desktop re-asserts its size on its next typed input via
   * noteDesktopActivity). Without a desktop connected, small viewports
   * control the PTY size freely.
   *
   * @param cols - Number of columns (width in characters)
   * @param rows - Number of rows (height in lines)
   */
  resize(cols: number, rows: number, options: { viewportType?: ResizeViewportType } = {}): void {
    const isSmallViewport = options.viewportType === 'mobile' || options.viewportType === 'tablet';
    if (options.viewportType === 'desktop') {
      this._lastDesktopDims = { cols, rows };
      this._lastDesktopActivityAt = Date.now();
      this._mobileSizeOverride = false;
    }
    if (isSmallViewport && this._desktopSizeClaims.size > 0) {
      if (Date.now() - this._lastDesktopActivityAt < Session.DESKTOP_CLAIM_IDLE_MS) {
        return;
      }
      this._mobileSizeOverride = true;
    }
    if (this.ptyProcess && (cols !== this._ptyCols || rows !== this._ptyRows)) {
      this._ptyCols = cols;
      this._ptyRows = rows;
      if (this._mux && this._muxSession) {
        this._mux.resizeWindow?.(this._muxSession.muxName, cols, rows);
      }
      this.ptyProcess.resize(cols, rows);
    }
  }

  // Legacy method for compatibility with session-manager
  async start(): Promise<void> {
    this._status = 'idle';
  }

  // Legacy method for sending input - wraps runPrompt
  async sendInput(input: string): Promise<void> {
    this._status = 'busy';
    this._lastActivityAt = Date.now();
    this.runPrompt(input).catch((err) => {
      const errorMsg = getErrorMessage(err);
      // Clean up task state so the task queue doesn't get stuck
      if (this._currentTaskId) {
        const taskId = this._currentTaskId;
        this._currentTaskId = null;
        this._status = 'idle';
        this._lastActivityAt = Date.now();
        this.emit('taskError', taskId, errorMsg);
      } else {
        this._status = 'idle';
      }
      this.emit('error', errorMsg);
    });
  }

  /**
   * Remove event listeners from TaskTracker and RalphTracker.
   * Prevents memory leaks by ensuring handlers don't persist after session stop.
   */
  private cleanupTrackerListeners(): void {
    // Remove TaskTracker handlers
    if (this._taskTrackerHandlers) {
      this._taskTracker.off('taskCreated', this._taskTrackerHandlers.taskCreated);
      this._taskTracker.off('taskUpdated', this._taskTrackerHandlers.taskUpdated);
      this._taskTracker.off('taskCompleted', this._taskTrackerHandlers.taskCompleted);
      this._taskTracker.off('taskFailed', this._taskTrackerHandlers.taskFailed);
      this._taskTrackerHandlers = null;
    }

    // Remove RalphTracker handlers
    if (this._ralphHandlers) {
      this._ralphTracker.off('loopUpdate', this._ralphHandlers.loopUpdate);
      this._ralphTracker.off('todoUpdate', this._ralphHandlers.todoUpdate);
      this._ralphTracker.off('completionDetected', this._ralphHandlers.completionDetected);
      this._ralphTracker.off('statusBlockDetected', this._ralphHandlers.statusBlockDetected);
      this._ralphTracker.off('circuitBreakerUpdate', this._ralphHandlers.circuitBreakerUpdate);
      this._ralphTracker.off('exitGateMet', this._ralphHandlers.exitGateMet);
      this._ralphHandlers = null;
    }

    // Remove BashToolParser handlers
    if (this._bashToolHandlers) {
      this._bashToolParser.off('toolStart', this._bashToolHandlers.toolStart);
      this._bashToolParser.off('toolEnd', this._bashToolHandlers.toolEnd);
      this._bashToolParser.off('toolsUpdate', this._bashToolHandlers.toolsUpdate);
      this._bashToolHandlers = null;
    }

    // Destroy all trackers to release memory and stop timers
    this._bashToolParser.destroy();
    this._taskTracker.destroy();
    this._ralphTracker.destroy();
  }

  /**
   * Stops the session and cleans up resources.
   *
   * This kills the PTY process and optionally the associated tmux session.
   * All buffers are cleared and the session is marked as stopped.
   *
   * @param killMux - Whether to also kill the mux session (default: true)
   *
   * @example
   * ```typescript
   * // Stop and kill everything
   * await session.stop();
   *
   * // Stop but keep mux session running for later reattachment
   * await session.stop(false);
   * ```
   */
  async stop(killMux: boolean = true): Promise<void> {
    // Set stopped flag first to prevent new timers from being created
    this._isStopped = true;

    this._clearAllTimers();

    // Drop desktop sizing claims defensively. Sockets normally release their
    // own claim on close, but a hung client's close event can lag the session
    // teardown by up to a ping cycle — don't let a stale claim suppress
    // mobile resizes if this Session object sees any further use.
    this._desktopSizeClaims.clear();

    // Immediately cleanup Promise callbacks to prevent orphaned references
    // during the rest of stop() processing (e.g., if mux kill times out)
    if (this.rejectPromise && !this._promptResolved) {
      this._promptResolved = true;
      this.rejectPromise(new Error('Session stopped'));
    }
    this.resolvePromise = null;
    this.rejectPromise = null;

    // Remove event listeners from trackers to prevent memory leaks
    this.cleanupTrackerListeners();

    if (this.ptyProcess) {
      if (killMux) {
        // Full kill: SIGTERM → wait → SIGKILL the PTY and its children
        const pid = this.ptyProcess.pid;

        // First try graceful SIGTERM
        try {
          this.ptyProcess.kill();
        } catch (err) {
          console.warn('[Session] Failed to send SIGTERM to PTY process (may already be dead):', err);
        }

        // Give it a moment to terminate gracefully
        await new Promise((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_DELAY_MS));

        // Force kill with SIGKILL if still alive
        try {
          if (pid) {
            process.kill(pid, 'SIGKILL');
          }
        } catch (err) {
          console.warn('[Session] Failed to send SIGKILL to process (already terminated):', err);
        }

        // Also try to kill any child processes in the process group
        try {
          if (pid) {
            process.kill(-pid, 'SIGKILL');
          }
        } catch (err) {
          console.warn('[Session] Failed to send SIGKILL to process group (may not exist):', err);
        }
      } else {
        // Server shutdown: just detach — the process lives on inside tmux
        console.log('[Session] Detaching from PTY (server shutdown) — mux session preserved');
      }

      this.ptyProcess = null;
    }
    this._pid = null;
    this._status = killMux ? 'stopped' : 'idle';
    this._currentTaskId = null;

    // Clear task description cache and agent tree to prevent memory leak
    this._taskCache.clear();
    this._childAgentIds = [];

    // Kill the associated mux session if requested
    if (killMux && this._mux) {
      // Try to kill mux session even if _muxSession is not set (e.g., restored sessions)
      try {
        const killed = await this._mux.killSession(this.id);
        if (killed) {
          console.log('[Session] Killed mux session for:', this.id);
        }
      } catch (err) {
        console.error('[Session] Failed to kill mux session:', err);
      }
      this._muxSession = null;
    } else if (this._muxSession && !killMux) {
      console.log('[Session] Keeping mux session alive:', this._muxSession.muxName);
      this._muxSession = null; // Detach but don't kill
    }
  }

  assignTask(taskId: string): void {
    this._currentTaskId = taskId;
    this._status = 'busy';
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lastActivityAt = Date.now();
  }

  clearTask(): void {
    this._currentTaskId = null;
    this._status = 'idle';
    this._lastActivityAt = Date.now();
  }

  getOutput(): string {
    return this._textOutput.value;
  }

  getError(): string {
    return this._errorBuffer;
  }

  getTerminalBuffer(): string {
    return this._terminalBuffer.value;
  }

  clearBuffers(): void {
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._taskTracker.clear();
    this._ralphTracker.clear();
    this._taskCache.clear();
  }
}
