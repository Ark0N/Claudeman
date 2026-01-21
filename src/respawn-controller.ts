/**
 * @fileoverview Respawn Controller for autonomous Claude Code session cycling
 *
 * The RespawnController manages automatic respawning of Claude Code sessions.
 * When Claude finishes working (detected by idle prompt), it automatically
 * cycles through update → clear → init steps to keep the session productive.
 *
 * ## State Machine
 *
 * ```
 * WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR
 *    ↑                                                               │
 *    │                                                               ▼
 *    │         SENDING_INIT → WAITING_INIT → MONITORING_INIT ───────┘
 *    │                                            │
 *    │                                            ▼ (if no work triggered)
 *    └── SENDING_KICKSTART → WAITING_KICKSTART ──┘
 * ```
 *
 * ## Configuration
 *
 * - `sendClear`: Whether to send /clear after update (default: true)
 * - `sendInit`: Whether to send /init after clear (default: true)
 * - `kickstartPrompt`: Optional prompt if /init doesn't trigger work
 *
 * @module respawn-controller
 */

import { EventEmitter } from 'node:events';
import { Session } from './session.js';

// ========== Configuration Constants ==========

/**
 * Maximum terminal buffer size for respawn controller.
 * Buffer is trimmed when this limit is exceeded to prevent memory issues.
 */
const MAX_RESPAWN_BUFFER_SIZE = 1024 * 1024; // 1MB

/**
 * Size to trim buffer to when MAX_RESPAWN_BUFFER_SIZE is exceeded.
 * Keeps the most recent output for pattern detection.
 */
const RESPAWN_BUFFER_TRIM_SIZE = 512 * 1024; // 512KB

// ========== Constants ==========

/**
 * The definitive "ready for input" indicator.
 * When Claude shows a suggestion, this appears and indicates idle state.
 */
const READY_INDICATOR = '↵ send';

// ========== Buffer Accumulator ==========

/**
 * High-performance buffer accumulator using array-based collection.
 * Reduces GC pressure by avoiding repeated string concatenation.
 */
class BufferAccumulator {
  private chunks: string[] = [];
  private totalLength: number = 0;
  private readonly maxSize: number;
  private readonly trimSize: number;

  constructor(maxSize: number, trimSize: number) {
    this.maxSize = maxSize;
    this.trimSize = trimSize;
  }

  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.totalLength += data.length;
    if (this.totalLength > this.maxSize) {
      this.trim();
    }
  }

  get value(): string {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0];
    const result = this.chunks.join('');
    this.chunks = [result];
    return result;
  }

  get length(): number {
    return this.totalLength;
  }

  clear(): void {
    this.chunks = [];
    this.totalLength = 0;
  }

  private trim(): void {
    const full = this.chunks.join('');
    const trimmed = full.slice(-this.trimSize);
    this.chunks = [trimmed];
    this.totalLength = trimmed.length;
  }
}

// ========== Type Definitions ==========

/**
 * Respawn sequence states.
 *
 * The controller cycles through these states:
 * ```
 * WATCHING → SENDING_UPDATE → WAITING_UPDATE →
 *   SENDING_CLEAR → WAITING_CLEAR →
 *   SENDING_INIT → WAITING_INIT →
 *   MONITORING_INIT → (maybe SENDING_KICKSTART → WAITING_KICKSTART) →
 *   WATCHING (repeat)
 * ```
 *
 * Steps can be skipped via config (`sendClear: false`, `sendInit: false`).
 */
export type RespawnState =
  /** Watching for idle, ready to start respawn sequence */
  | 'watching'
  /** About to send the update docs prompt */
  | 'sending_update'
  /** Waiting for update to complete */
  | 'waiting_update'
  /** About to send /clear command */
  | 'sending_clear'
  /** Waiting for clear to complete */
  | 'waiting_clear'
  /** About to send /init command */
  | 'sending_init'
  /** Waiting for init to complete */
  | 'waiting_init'
  /** Monitoring if /init triggered work */
  | 'monitoring_init'
  /** About to send kickstart prompt */
  | 'sending_kickstart'
  /** Waiting for kickstart to complete */
  | 'waiting_kickstart'
  /** Controller stopped (not running) */
  | 'stopped';

/**
 * Configuration options for the RespawnController.
 */
export interface RespawnConfig {
  /**
   * How long to wait after seeing prompt before considering truly idle.
   * Prevents premature cycling when user is about to type.
   * @default 10000 (10 seconds)
   */
  idleTimeoutMs: number;

  /**
   * The prompt to send when updating docs.
   * Sent at the start of each respawn cycle.
   * @default 'update all the docs and CLAUDE.md'
   */
  updatePrompt: string;

  /**
   * Delay between sending steps (ms).
   * Gives Claude time to process each command.
   * @default 1000 (1 second)
   */
  interStepDelayMs: number;

  /**
   * Whether the respawn loop is enabled.
   * When false, start() will be a no-op.
   * @default true
   */
  enabled: boolean;

  /**
   * Whether to send /clear after update prompt completes.
   * Resets Claude's context for fresh start.
   * @default true
   */
  sendClear: boolean;

  /**
   * Whether to send /init after /clear completes.
   * Re-initializes Claude with CLAUDE.md context.
   * @default true
   */
  sendInit: boolean;

  /**
   * Optional prompt to send if /init doesn't trigger work.
   * Used as a fallback when /init completes but Claude doesn't start working.
   * @default undefined
   */
  kickstartPrompt?: string;
}

/**
 * Events emitted by RespawnController.
 *
 * @event stateChanged - Fired when state machine transitions
 * @event respawnCycleStarted - Fired when a new cycle begins
 * @event respawnCycleCompleted - Fired when a cycle finishes
 * @event stepSent - Fired when a command is sent to the session
 * @event stepCompleted - Fired when a step finishes (ready indicator detected)
 * @event error - Fired on errors
 * @event log - Fired for debug logging
 */
export interface RespawnEvents {
  /** State machine transition */
  stateChanged: (state: RespawnState, prevState: RespawnState) => void;
  /** New respawn cycle started */
  respawnCycleStarted: (cycleNumber: number) => void;
  /** Respawn cycle finished */
  respawnCycleCompleted: (cycleNumber: number) => void;
  /** Command sent to session */
  stepSent: (step: string, input: string) => void;
  /** Step completed (ready indicator detected) */
  stepCompleted: (step: string) => void;
  /** Error occurred */
  error: (error: Error) => void;
  /** Debug log message */
  log: (message: string) => void;
}

/** Default configuration values */
const DEFAULT_CONFIG: RespawnConfig = {
  idleTimeoutMs: 10000,          // 10 seconds of no activity after prompt
  updatePrompt: 'update all the docs and CLAUDE.md',
  interStepDelayMs: 1000,        // 1 second between steps
  enabled: true,
  sendClear: true,               // send /clear after update prompt
  sendInit: true,                // send /init after /clear
};

/**
 * RespawnController - Automatic session cycling for continuous Claude work.
 *
 * Monitors a Claude Code session for idle state and automatically cycles
 * through update → clear → init steps to keep the session productive.
 *
 * ## How It Works
 *
 * 1. **Idle Detection**: Watches terminal output for `↵ send` indicator
 * 2. **Update**: Sends configured prompt (e.g., "update all docs")
 * 3. **Clear**: Sends `/clear` to reset context (optional)
 * 4. **Init**: Sends `/init` to re-initialize with CLAUDE.md (optional)
 * 5. **Kickstart**: If /init doesn't trigger work, sends fallback prompt (optional)
 * 6. **Repeat**: Returns to watching state for next cycle
 *
 * ## Idle Detection
 *
 * Primary indicator: `↵ send` - Claude's suggestion prompt
 * Fallback indicators: Various prompt characters (❯, ⏵, etc.)
 *
 * Working indicators: Thinking, Writing, spinner characters, etc.
 *
 * ## Events
 *
 * - `stateChanged`: State machine transition
 * - `respawnCycleStarted`: New cycle began
 * - `respawnCycleCompleted`: Cycle finished
 * - `stepSent`: Command sent to session
 * - `stepCompleted`: Step finished
 * - `log`: Debug messages
 *
 * @extends EventEmitter
 * @example
 * ```typescript
 * const respawn = new RespawnController(session, {
 *   updatePrompt: 'continue working on the task',
 *   idleTimeoutMs: 5000,
 * });
 *
 * respawn.on('respawnCycleCompleted', (cycle) => {
 *   console.log(`Completed cycle ${cycle}`);
 * });
 *
 * respawn.start();
 * ```
 */
export class RespawnController extends EventEmitter {
  /** The session being controlled */
  private session: Session;

  /** Current configuration */
  private config: RespawnConfig;

  /** Current state machine state */
  private _state: RespawnState = 'stopped';

  /** Timer for idle detection timeout */
  private idleTimer: NodeJS.Timeout | null = null;

  /** Timer for step delays */
  private stepTimer: NodeJS.Timeout | null = null;

  /** Number of completed respawn cycles */
  private cycleCount: number = 0;

  /** Timestamp of last terminal activity */
  private lastActivityTime: number = 0;

  /** Buffer for recent terminal output (uses BufferAccumulator to reduce GC pressure) */
  private terminalBuffer = new BufferAccumulator(MAX_RESPAWN_BUFFER_SIZE, RESPAWN_BUFFER_TRIM_SIZE);

  /** Whether a prompt indicator was detected */
  private promptDetected: boolean = false;

  /** Whether a working indicator was detected */
  private workingDetected: boolean = false;

  /** Reference to terminal event handler (for cleanup) */
  private terminalHandler: ((data: string) => void) | null = null;

  /** Timer for /clear step fallback (sends /init if no prompt detected) */
  private clearFallbackTimer: NodeJS.Timeout | null = null;

  /** Fallback timeout for /clear step (ms) - sends /init without waiting for prompt */
  private static readonly CLEAR_FALLBACK_TIMEOUT_MS = 10000;

  /**
   * Patterns indicating Claude is ready for input.
   * Primary: `↵ send` (suggestion prompt)
   * Fallback: Various prompt characters
   */
  private readonly PROMPT_PATTERNS = [
    '↵ send',   // Suggestion ready to send (strongest indicator of idle)
    '❯',        // Standard prompt
    '\u276f',   // Unicode variant
    '⏵',        // Claude Code prompt variant
    '> ',       // Fallback
    'tokens',   // The status line shows "X tokens" when at prompt
  ];

  /**
   * Patterns indicating Claude is actively working.
   * When detected, resets idle detection.
   */
  private readonly WORKING_PATTERNS = [
    'Thinking', 'Writing', 'Reading', 'Running', 'Searching',
    'Editing', 'Creating', 'Deleting', 'Analyzing', 'Executing',
    'Synthesizing', 'Brewing',  // Claude's processing indicators
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',  // Spinner chars
    '✻', '✽',  // Activity indicators (spinning star)
  ];

  /**
   * Creates a new RespawnController.
   *
   * @param session - The Session instance to control
   * @param config - Partial configuration (merged with defaults)
   */
  constructor(session: Session, config: Partial<RespawnConfig> = {}) {
    super();
    this.session = session;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the current state machine state.
   * @returns Current RespawnState
   */
  get state(): RespawnState {
    return this._state;
  }

  /**
   * Get the current respawn cycle count.
   * Increments each time a new cycle starts.
   * @returns Number of cycles started
   */
  get currentCycle(): number {
    return this.cycleCount;
  }

  /**
   * Check if the controller is currently running.
   * @returns True if state is not 'stopped'
   */
  get isRunning(): boolean {
    return this._state !== 'stopped';
  }

  /**
   * Transition to a new state.
   * Emits 'stateChanged' event with old and new states.
   * No-op if already in the target state.
   *
   * @param newState - State to transition to
   * @fires stateChanged
   */
  private setState(newState: RespawnState): void {
    if (newState === this._state) return;

    const prevState = this._state;
    this._state = newState;
    this.log(`State: ${prevState} → ${newState}`);
    this.emit('stateChanged', newState, prevState);
  }

  /**
   * Emit a timestamped log message.
   * @param message - Log message content
   * @fires log
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.emit('log', `[${timestamp}] [Respawn] ${message}`);
  }

  /**
   * Start watching the session for idle state.
   *
   * Begins monitoring terminal output for idle indicators.
   * When idle is detected, starts the respawn cycle.
   *
   * No-op if:
   * - `config.enabled` is false
   * - Already running (state !== 'stopped')
   *
   * @fires stateChanged - Transitions to 'watching'
   */
  start(): void {
    if (!this.config.enabled) {
      this.log('Respawn is disabled');
      return;
    }

    if (this._state !== 'stopped') {
      this.log('Already running');
      return;
    }

    this.log('Starting respawn controller');
    this.setState('watching');
    this.setupTerminalListener();
    this.lastActivityTime = Date.now();
  }

  /**
   * Stop the respawn controller.
   *
   * Clears all timers, removes terminal listener, and sets state to 'stopped'.
   * Safe to call multiple times.
   *
   * @fires stateChanged - Transitions to 'stopped'
   */
  stop(): void {
    this.log('Stopping respawn controller');
    this.clearTimers();
    this.setState('stopped');
    if (this.terminalHandler) {
      this.session.off('terminal', this.terminalHandler);
      this.terminalHandler = null;
    }
  }

  /**
   * Pause respawn without stopping.
   *
   * Clears timers but keeps listening to terminal.
   * State is preserved; won't trigger idle detection while paused.
   * Use resume() to continue.
   */
  pause(): void {
    this.log('Pausing respawn');
    this.clearTimers();
    // Stay in current state but clear timers
  }

  /**
   * Resume respawn after pause.
   *
   * If in 'watching' state, immediately checks for idle condition.
   * Otherwise, continues from current state.
   */
  resume(): void {
    this.log('Resuming respawn');
    if (this._state === 'watching') {
      this.checkIdleAndMaybeStart();
    }
  }

  /**
   * Set up terminal output listener on the session.
   * Removes any previous listener first to avoid duplicates.
   */
  private setupTerminalListener(): void {
    // Remove our previous listener if any (don't remove other listeners!)
    if (this.terminalHandler) {
      this.session.off('terminal', this.terminalHandler);
    }

    this.terminalHandler = (data: string) => {
      this.handleTerminalData(data);
    };
    this.session.on('terminal', this.terminalHandler);
  }

  /**
   * Process terminal data for idle/working detection.
   *
   * 1. Buffers data (with size limit)
   * 2. Detects working indicators → resets idle
   * 3. Detects ready indicator → triggers state-specific action
   * 4. Detects prompt indicators → starts idle timer
   *
   * @param data - Raw terminal output data
   */
  private handleTerminalData(data: string): void {
    // BufferAccumulator handles auto-trimming when max size exceeded
    this.terminalBuffer.append(data);

    // Check for the definitive "ready for input" indicator
    const isReady = data.includes(READY_INDICATOR);

    // Detect working state
    const isWorking = this.WORKING_PATTERNS.some(pattern => data.includes(pattern));
    if (isWorking) {
      this.workingDetected = true;
      this.promptDetected = false;
      this.lastActivityTime = Date.now();
      this.clearIdleTimer();

      // If we're monitoring init and work started, go to watching (no kickstart needed)
      if (this._state === 'monitoring_init') {
        this.log('/init triggered work, skipping kickstart');
        this.emit('stepCompleted', 'init');
        this.completeCycle();
      }
      return;
    }

    // Detect ready state (↵ send indicator)
    if (isReady) {
      this.promptDetected = true;
      this.workingDetected = false;
      this.lastActivityTime = Date.now();
      this.log('Ready indicator detected (↵ send)');

      // Handle based on current state
      switch (this._state) {
        case 'watching':
          // Start idle timer instead of immediate action - gives user time to type
          this.startIdleTimer();
          break;
        case 'waiting_update':
          this.checkUpdateComplete();
          break;
        case 'waiting_clear':
          this.checkClearComplete();
          break;
        case 'waiting_init':
          this.checkInitComplete();
          break;
        case 'monitoring_init':
          this.checkMonitoringInitIdle();
          break;
        case 'waiting_kickstart':
          this.checkKickstartComplete();
          break;
      }
      return;
    }

    // Fallback: detect prompt characters - start timeout-based check
    const hasPrompt = this.PROMPT_PATTERNS.some(pattern => data.includes(pattern));
    if (hasPrompt) {
      const wasPromptDetected = this.promptDetected;
      this.promptDetected = true;
      this.workingDetected = false;
      this.lastActivityTime = Date.now();

      if (!wasPromptDetected) {
        this.log('Prompt detected');
        // Start fallback timeout for watching state
        if (this._state === 'watching') {
          this.startIdleTimer();
        }
      }
    }
  }

  /**
   * Handle update step completion.
   * Called when ready indicator detected in waiting_update state.
   * Proceeds to clear, init, or completes cycle based on config.
   * @fires stepCompleted - With step 'update'
   */
  private checkUpdateComplete(): void {
    this.clearIdleTimer();
    this.log('Update completed (ready indicator)');
    this.emit('stepCompleted', 'update');

    if (this.config.sendClear) {
      this.sendClear();
    } else if (this.config.sendInit) {
      this.sendInit();
    } else {
      this.completeCycle();
    }
  }

  /**
   * Handle /clear step completion.
   * Proceeds to init or completes cycle based on config.
   * @fires stepCompleted - With step 'clear'
   */
  private checkClearComplete(): void {
    this.clearIdleTimer();
    // Clear the fallback timer since we got prompt detection
    if (this.clearFallbackTimer) {
      clearTimeout(this.clearFallbackTimer);
      this.clearFallbackTimer = null;
    }
    this.log('/clear completed (ready indicator)');
    this.emit('stepCompleted', 'clear');

    if (this.config.sendInit) {
      this.sendInit();
    } else {
      this.completeCycle();
    }
  }

  /**
   * Handle /init step completion.
   * If kickstart is configured, monitors for work.
   * Otherwise completes cycle.
   * @fires stepCompleted - With step 'init' (if no kickstart)
   */
  private checkInitComplete(): void {
    this.clearIdleTimer();
    this.log('/init completed (ready indicator)');

    // If kickstart prompt is configured, monitor to see if /init triggered work
    if (this.config.kickstartPrompt) {
      this.startMonitoringInit();
    } else {
      this.emit('stepCompleted', 'init');
      this.completeCycle();
    }
  }

  /**
   * Start monitoring to see if /init triggered work.
   * Enters 'monitoring_init' state and waits 3s grace period.
   * If no work detected, sends kickstart prompt.
   */
  private startMonitoringInit(): void {
    this.setState('monitoring_init');
    this.terminalBuffer.clear();
    this.workingDetected = false;
    this.log('Monitoring if /init triggered work...');

    // Give Claude a moment to start working before checking for idle
    this.stepTimer = setTimeout(() => {
      // If still in monitoring state and no work detected, consider it idle
      if (this._state === 'monitoring_init' && !this.workingDetected) {
        this.checkMonitoringInitIdle();
      }
    }, 3000); // 3 second grace period for /init to trigger work
  }

  /**
   * Handle monitoring timeout when /init didn't trigger work.
   * Sends kickstart prompt as fallback.
   * @fires stepCompleted - With step 'init'
   */
  private checkMonitoringInitIdle(): void {
    this.clearIdleTimer();
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    this.log('/init did not trigger work, sending kickstart prompt');
    this.emit('stepCompleted', 'init');
    this.sendKickstart();
  }

  /**
   * Send the kickstart prompt to get Claude working.
   * @fires stepSent - With step 'kickstart'
   */
  private sendKickstart(): void {
    this.setState('sending_kickstart');
    this.terminalBuffer.clear();

    this.stepTimer = setTimeout(() => {
      const prompt = this.config.kickstartPrompt!;
      this.log(`Sending kickstart prompt: "${prompt}"`);
      this.session.writeViaScreen(prompt + '\r');  // \r triggers key.return in Ink/Claude CLI
      this.emit('stepSent', 'kickstart', prompt);
      this.setState('waiting_kickstart');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  /**
   * Handle kickstart step completion.
   * @fires stepCompleted - With step 'kickstart'
   */
  private checkKickstartComplete(): void {
    this.clearIdleTimer();
    this.log('Kickstart completed (ready indicator)');
    this.emit('stepCompleted', 'kickstart');
    this.completeCycle();
  }

  /**
   * Start the idle detection timer.
   * After idleTimeoutMs, triggers onIdleDetected if still idle.
   */
  private startIdleTimer(): void {
    this.clearIdleTimer();

    this.idleTimer = setTimeout(() => {
      // Double-check we're still idle and in watching state
      if (this._state === 'watching' && this.promptDetected && !this.workingDetected) {
        const timeSinceActivity = Date.now() - this.lastActivityTime;
        this.log(`Idle timeout fired (${timeSinceActivity}ms since last activity)`);
        this.onIdleDetected();
      }
    }, this.config.idleTimeoutMs);
  }

  /** Clear the idle detection timer if running */
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Clear all timers (idle, step, and clear fallback) */
  private clearTimers(): void {
    this.clearIdleTimer();
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    if (this.clearFallbackTimer) {
      clearTimeout(this.clearFallbackTimer);
      this.clearFallbackTimer = null;
    }
  }

  /**
   * Handle confirmed idle detection.
   * Starts a new respawn cycle.
   * @fires respawnCycleStarted
   */
  private onIdleDetected(): void {
    if (this._state !== 'watching') {
      return;
    }

    // Start the respawn cycle
    this.cycleCount++;
    this.log(`Starting respawn cycle #${this.cycleCount}`);
    this.emit('respawnCycleStarted', this.cycleCount);

    this.sendUpdateDocs();
  }

  /**
   * Send the update docs prompt (first step of cycle).
   * @fires stepSent - With step 'update'
   */
  private sendUpdateDocs(): void {
    this.setState('sending_update');
    this.terminalBuffer.clear(); // Clear buffer for fresh detection

    this.stepTimer = setTimeout(() => {
      const input = this.config.updatePrompt + '\r';  // \r triggers Enter in Ink/Claude CLI
      this.log(`Sending update prompt: "${this.config.updatePrompt}"`);
      this.session.writeViaScreen(input);
      this.emit('stepSent', 'update', this.config.updatePrompt);
      this.setState('waiting_update');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  /**
   * Send /clear command.
   * Starts a 10-second fallback timer - if no prompt is detected after /clear,
   * proceeds to /init anyway (workaround for when Claude doesn't show prompt after /clear).
   * @fires stepSent - With step 'clear'
   */
  private sendClear(): void {
    this.setState('sending_clear');
    this.terminalBuffer.clear();

    this.stepTimer = setTimeout(() => {
      this.log('Sending /clear');
      this.session.writeViaScreen('/clear\r');  // \r triggers Enter in Ink/Claude CLI
      this.emit('stepSent', 'clear', '/clear');
      this.setState('waiting_clear');
      this.promptDetected = false;

      // Start fallback timer - if no prompt detected after 10s, proceed to /init anyway
      this.clearFallbackTimer = setTimeout(() => {
        if (this._state === 'waiting_clear') {
          this.log('/clear fallback: no prompt detected after 10s, proceeding to /init');
          this.emit('stepCompleted', 'clear');
          if (this.config.sendInit) {
            this.sendInit();
          } else {
            this.completeCycle();
          }
        }
      }, RespawnController.CLEAR_FALLBACK_TIMEOUT_MS);
    }, this.config.interStepDelayMs);
  }

  /**
   * Send /init command.
   * @fires stepSent - With step 'init'
   */
  private sendInit(): void {
    this.setState('sending_init');
    this.terminalBuffer.clear();

    this.stepTimer = setTimeout(() => {
      this.log('Sending /init');
      this.session.writeViaScreen('/init\r');  // \r triggers Enter in Ink/Claude CLI
      this.emit('stepSent', 'init', '/init');
      this.setState('waiting_init');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  /**
   * Complete the current respawn cycle.
   * Returns to watching state for next cycle.
   * @fires respawnCycleCompleted
   */
  private completeCycle(): void {
    this.log(`Respawn cycle #${this.cycleCount} completed`);
    this.emit('respawnCycleCompleted', this.cycleCount);

    // Go back to watching state for next cycle
    this.setState('watching');
    this.terminalBuffer.clear();
    this.promptDetected = false;
    this.workingDetected = false;
  }

  /**
   * Check if already idle and start cycle if so.
   * Used when resuming from pause.
   */
  private checkIdleAndMaybeStart(): void {
    // Check if already idle
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > this.config.idleTimeoutMs && this.promptDetected) {
      this.onIdleDetected();
    }
  }

  /**
   * Update configuration at runtime.
   *
   * Merges provided config with existing config.
   * Takes effect immediately for new operations.
   *
   * @param config - Partial configuration to merge
   * @fires log - With updated config details
   */
  updateConfig(config: Partial<RespawnConfig>): void {
    this.config = { ...this.config, ...config };
    this.log(`Config updated: ${JSON.stringify(config)}`);
  }

  /**
   * Get current configuration.
   * @returns Copy of current config (safe to modify)
   */
  getConfig(): RespawnConfig {
    return { ...this.config };
  }

  /**
   * Get comprehensive status information.
   *
   * Useful for debugging and monitoring.
   *
   * @returns Status object with:
   *   - state: Current state machine state
   *   - cycleCount: Number of cycles started
   *   - lastActivityTime: Timestamp of last activity
   *   - timeSinceActivity: Milliseconds since last activity
   *   - promptDetected: Whether prompt indicator seen
   *   - workingDetected: Whether working indicator seen
   *   - config: Current configuration
   */
  getStatus() {
    return {
      state: this._state,
      cycleCount: this.cycleCount,
      lastActivityTime: this.lastActivityTime,
      timeSinceActivity: Date.now() - this.lastActivityTime,
      promptDetected: this.promptDetected,
      workingDetected: this.workingDetected,
      config: this.config,
    };
  }
}
