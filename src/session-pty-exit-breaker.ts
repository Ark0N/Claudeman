/**
 * @fileoverview Circuit breaker bounding repeated non-zero interactive-PTY exits (COD-118).
 *
 * Defense-in-depth after COD-115: if the interactive PTY exits non-zero repeatedly,
 * external recovery/reconnect paths recreate it indefinitely (COD-115 observed 114
 * `exited with code: 1` events + orphan sessions). This breaker tracks recent
 * non-zero exits within a sliding window and "trips" once they exceed a threshold,
 * so the Session can refuse to respawn and surface an error state instead of looping.
 *
 * Design notes:
 * - PURE + dependency-free. Time is INJECTED (`nowMs` passed to `recordExit`); the
 *   breaker never calls `Date.now()` itself, so trip/window logic is deterministically
 *   unit-testable with no real timers.
 * - A clean (exit code 0) exit resets the counter — a session that exited normally is
 *   not on a crash-loop. (It does NOT clear an already-tripped breaker; only an explicit
 *   `reset()` — e.g. a user-initiated restart — does that.)
 * - Once tripped, stays tripped until `reset()`.
 *
 * @consumedby session (instantiates one per session; records exits in the interactive
 *   PTY `onExit` handler; gates `startInteractive()` when tripped; `reset()` on restart)
 * @module session-pty-exit-breaker
 */

/** Non-zero interactive-PTY exits within the window required to trip the breaker. */
export const DEFAULT_BREAKER_THRESHOLD = 5;

/** Sliding window (ms) over which non-zero exits accumulate toward the threshold. */
export const DEFAULT_BREAKER_WINDOW_MS = 10_000;

export interface InteractivePtyExitBreakerOptions {
  /** Trip after this many non-zero exits within `windowMs` (default 5). */
  threshold?: number;
  /** Sliding window length in ms (default 10_000). */
  windowMs?: number;
}

export interface RecordExitResult {
  /** True once the breaker has tripped (stays true until `reset()`). */
  tripped: boolean;
  /** Number of non-zero exits currently inside the window. */
  count: number;
}

/**
 * Sliding-window counter that trips on rapid repeated non-zero exits.
 *
 * 5 within 10s safely clears normal usage (a single exit, an intentional restart)
 * while tripping fast on a real loop — COD-115 saw 114 exits, far above 5.
 */
export class InteractivePtyExitBreaker {
  private readonly _threshold: number;
  private readonly _windowMs: number;

  /** Timestamps (ms, injected) of recent non-zero exits, oldest first. */
  private _exitTimes: number[] = [];

  private _tripped = false;

  constructor(opts: InteractivePtyExitBreakerOptions = {}) {
    this._threshold = opts.threshold ?? DEFAULT_BREAKER_THRESHOLD;
    this._windowMs = opts.windowMs ?? DEFAULT_BREAKER_WINDOW_MS;
  }

  /** Whether the breaker has tripped (respawn should be blocked). */
  get tripped(): boolean {
    return this._tripped;
  }

  /**
   * Record a PTY exit. A zero (clean) exit resets the non-zero counter; a non-zero
   * exit is added to the window, stale entries are evicted, and the breaker trips
   * once the in-window count reaches the threshold.
   *
   * @param exitCode the PTY exit code (0 = clean)
   * @param nowMs injected current time in ms (never read from a real clock)
   */
  recordExit(exitCode: number, nowMs: number): RecordExitResult {
    if (exitCode === 0) {
      // Clean exit: a normal stop, not a crash-loop. Clear accumulated non-zero
      // exits. Does NOT un-trip an already-tripped breaker (only reset() does).
      this._exitTimes = [];
      return { tripped: this._tripped, count: 0 };
    }

    // Evict exits strictly older than the window, then record this one.
    const cutoff = nowMs - this._windowMs;
    this._exitTimes = this._exitTimes.filter((t) => t > cutoff);
    this._exitTimes.push(nowMs);

    if (this._exitTimes.length >= this._threshold) {
      this._tripped = true;
    }

    return { tripped: this._tripped, count: this._exitTimes.length };
  }

  /** Clear the tripped state and the non-zero counter (e.g. on intentional restart). */
  reset(): void {
    this._exitTimes = [];
    this._tripped = false;
  }
}
