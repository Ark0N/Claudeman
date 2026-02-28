/**
 * @fileoverview Debounce utilities to replace manual timer management.
 *
 * Two variants:
 * - `Debouncer` — single debounced operation (replaces timer + clearTimeout pattern)
 * - `KeyedDebouncer` — per-key debouncing (replaces Map<string, Timeout> pattern)
 *
 * Both integrate with CleanupManager via dispose().
 *
 * @module utils/debouncer
 */

/**
 * Single-operation debouncer.
 *
 * Replaces the common pattern of:
 * ```
 * private timer: NodeJS.Timeout | null = null;
 * debounce(fn) { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(fn, delay); }
 * cancel() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
 * ```
 *
 * @example
 * ```typescript
 * private saveDeb = new Debouncer(500);
 *
 * onChange() {
 *   this.saveDeb.schedule(() => this.save());
 * }
 *
 * stop() {
 *   this.saveDeb.dispose();
 * }
 * ```
 */
export class Debouncer {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly delayMs: number) {}

  /**
   * Schedule a debounced callback. Resets the timer on each call.
   * If a previous call is pending, it is cancelled.
   */
  schedule(fn: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, this.delayMs);
  }

  /** Cancel any pending execution without invoking the callback. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Whether a callback is currently pending. */
  get isPending(): boolean {
    return this.timer !== null;
  }

  /**
   * Cancel pending callback and flush immediately.
   * Useful for shutdown: cancel the timer but run the action now.
   *
   * @param fn - The flush function to run (typically the same function passed to schedule)
   */
  flush(fn: () => void): void {
    this.cancel();
    fn();
  }

  /** Alias for cancel() — matches CleanupManager/Disposable convention. */
  dispose(): void {
    this.cancel();
  }
}

/**
 * Per-key debouncer for operations that need independent timers per resource.
 *
 * Replaces the common pattern of:
 * ```
 * private timers = new Map<string, NodeJS.Timeout>();
 * debounce(key, fn) {
 *   const existing = this.timers.get(key);
 *   if (existing) clearTimeout(existing);
 *   this.timers.set(key, setTimeout(() => { this.timers.delete(key); fn(); }, delay));
 * }
 * ```
 *
 * @example
 * ```typescript
 * private fileDebouncers = new KeyedDebouncer(100);
 *
 * onFileChange(path: string) {
 *   this.fileDebouncers.schedule(path, () => this.processFile(path));
 * }
 *
 * stop() {
 *   this.fileDebouncers.dispose();
 * }
 * ```
 */
export class KeyedDebouncer {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly delayMs: number) {}

  /**
   * Schedule a debounced callback for a specific key.
   * Each key has its own independent timer.
   */
  schedule(key: string, fn: () => void): void {
    this.cancelKey(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, this.delayMs)
    );
  }

  /** Cancel a pending callback for a specific key. */
  cancelKey(key: string): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  /** Whether a callback is pending for a specific key. */
  has(key: string): boolean {
    return this.timers.has(key);
  }

  /** Number of active timers. */
  get size(): number {
    return this.timers.size;
  }

  /** Get all currently active keys. */
  keys(): IterableIterator<string> {
    return this.timers.keys();
  }

  /** Cancel all pending callbacks. */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Cancel all pending callbacks and run a flush function for each active key.
   * Useful for shutdown: cancel timers but run the action for each pending key.
   *
   * @param fn - Called once per active key with the key as argument
   */
  flushAll(fn: (key: string) => void): void {
    const activeKeys = Array.from(this.timers.keys());
    this.dispose();
    for (const key of activeKeys) {
      fn(key);
    }
  }
}
