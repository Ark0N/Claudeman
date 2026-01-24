/**
 * @fileoverview Tests for timing and scheduling utilities
 *
 * Tests debouncing, throttling, retry logic, and other
 * time-based patterns used in the application.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Timing Utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Debounce', () => {
    const debounce = <T extends (...args: unknown[]) => void>(
      fn: T,
      delay: number
    ): ((...args: Parameters<T>) => void) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      return (...args: Parameters<T>) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
          fn(...args);
          timeoutId = null;
        }, delay);
      };
    };

    it('should delay execution', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced();
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should reset timer on subsequent calls', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced();
      vi.advanceTimersByTime(50);
      debounced();
      vi.advanceTimersByTime(50);

      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should pass arguments', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced('arg1', 'arg2');
      vi.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('should use latest arguments', () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced('first');
      debounced('second');
      debounced('third');

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledWith('third');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Throttle', () => {
    const throttle = <T extends (...args: unknown[]) => void>(
      fn: T,
      limit: number
    ): ((...args: Parameters<T>) => void) => {
      let inThrottle = false;
      let lastArgs: Parameters<T> | null = null;

      return (...args: Parameters<T>) => {
        if (!inThrottle) {
          fn(...args);
          inThrottle = true;
          setTimeout(() => {
            inThrottle = false;
            if (lastArgs) {
              fn(...lastArgs);
              lastArgs = null;
            }
          }, limit);
        } else {
          lastArgs = args;
        }
      };
    };

    it('should execute immediately first time', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100);

      throttled();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throttle subsequent calls', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100);

      throttled();
      throttled();
      throttled();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should execute trailing call after limit', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100);

      throttled('first');
      throttled('second');

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith('second');
    });

    it('should allow execution after limit expires', () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100);

      throttled();
      vi.advanceTimersByTime(100);
      throttled();

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Retry with Backoff', () => {
    const retryWithBackoff = async <T>(
      fn: () => Promise<T>,
      maxRetries: number,
      baseDelay: number
    ): Promise<T> => {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error as Error;
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      throw lastError;
    };

    it('should succeed on first try', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn, 3, 100);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, 3, 100);
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('always fails'));

      const promise = retryWithBackoff(fn, 2, 100);
      const expectation = expect(promise).rejects.toThrow('always fails');

      await vi.advanceTimersByTimeAsync(100); // First retry
      await vi.advanceTimersByTimeAsync(200); // Second retry

      await expectation;
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });

  describe('Timeout Wrapper', () => {
    const withTimeout = <T>(
      promise: Promise<T>,
      timeout: number,
      message: string = 'Operation timed out'
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(message));
        }, timeout);

        promise
          .then((result) => {
            clearTimeout(timeoutId);
            resolve(result);
          })
          .catch((error) => {
            clearTimeout(timeoutId);
            reject(error);
          });
      });
    };

    it('should resolve before timeout', async () => {
      const promise = new Promise<string>(resolve =>
        setTimeout(() => resolve('done'), 50)
      );

      const wrapped = withTimeout(promise, 100);
      await vi.advanceTimersByTimeAsync(50);

      await expect(wrapped).resolves.toBe('done');
    });

    it('should reject on timeout', async () => {
      const promise = new Promise<string>(resolve =>
        setTimeout(() => resolve('done'), 200)
      );

      const wrapped = withTimeout(promise, 100);
      const expectation = expect(wrapped).rejects.toThrow('Operation timed out');
      await vi.advanceTimersByTimeAsync(100);
      await expectation;
    });

    it('should use custom timeout message', async () => {
      const promise = new Promise<string>(resolve =>
        setTimeout(() => resolve('done'), 200)
      );

      const wrapped = withTimeout(promise, 100, 'Custom message');
      const expectation = expect(wrapped).rejects.toThrow('Custom message');
      await vi.advanceTimersByTimeAsync(100);
      await expectation;
    });
  });

  describe('Rate Limiter', () => {
    class RateLimiter {
      private tokens: number;
      private maxTokens: number;
      private refillRate: number;
      private lastRefill: number;

      constructor(maxTokens: number, refillRate: number) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillRate = refillRate;
        this.lastRefill = Date.now();
      }

      private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const newTokens = Math.floor(elapsed / 1000) * this.refillRate;
        this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
        this.lastRefill = now;
      }

      tryAcquire(): boolean {
        this.refill();
        if (this.tokens > 0) {
          this.tokens--;
          return true;
        }
        return false;
      }

      getTokens(): number {
        this.refill();
        return this.tokens;
      }
    }

    it('should allow requests within limit', () => {
      const limiter = new RateLimiter(3, 1);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('should block requests over limit', () => {
      const limiter = new RateLimiter(2, 1);
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('should refill tokens over time', () => {
      const limiter = new RateLimiter(2, 1);
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getTokens()).toBe(0);

      vi.advanceTimersByTime(1000);
      expect(limiter.getTokens()).toBe(1);
    });

    it('should not exceed max tokens', () => {
      const limiter = new RateLimiter(2, 10);
      vi.advanceTimersByTime(10000);
      expect(limiter.getTokens()).toBe(2);
    });
  });

  describe('Interval Manager', () => {
    class IntervalManager {
      private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();

      start(id: string, callback: () => void, interval: number): void {
        this.stop(id);
        this.intervals.set(id, setInterval(callback, interval));
      }

      stop(id: string): void {
        const existing = this.intervals.get(id);
        if (existing) {
          clearInterval(existing);
          this.intervals.delete(id);
        }
      }

      stopAll(): void {
        for (const [id] of this.intervals) {
          this.stop(id);
        }
      }

      isRunning(id: string): boolean {
        return this.intervals.has(id);
      }

      getRunningCount(): number {
        return this.intervals.size;
      }
    }

    it('should start interval', () => {
      const manager = new IntervalManager();
      const callback = vi.fn();

      manager.start('test', callback, 100);
      expect(manager.isRunning('test')).toBe(true);

      vi.advanceTimersByTime(350);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('should stop interval', () => {
      const manager = new IntervalManager();
      const callback = vi.fn();

      manager.start('test', callback, 100);
      manager.stop('test');

      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();
    });

    it('should stop all intervals', () => {
      const manager = new IntervalManager();

      manager.start('a', vi.fn(), 100);
      manager.start('b', vi.fn(), 100);

      expect(manager.getRunningCount()).toBe(2);
      manager.stopAll();
      expect(manager.getRunningCount()).toBe(0);
    });

    it('should replace existing interval', () => {
      const manager = new IntervalManager();
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.start('test', callback1, 100);
      manager.start('test', callback2, 100);

      vi.advanceTimersByTime(100);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe('Scheduled Task', () => {
    class ScheduledTask {
      private timeoutId: ReturnType<typeof setTimeout> | null = null;
      private callback: () => void;
      private scheduledTime: number | null = null;

      constructor(callback: () => void) {
        this.callback = callback;
      }

      scheduleAt(timestamp: number): void {
        this.cancel();
        const delay = Math.max(0, timestamp - Date.now());
        this.scheduledTime = timestamp;
        this.timeoutId = setTimeout(() => {
          this.timeoutId = null;
          this.scheduledTime = null;
          this.callback();
        }, delay);
      }

      scheduleIn(delay: number): void {
        this.scheduleAt(Date.now() + delay);
      }

      cancel(): void {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
          this.scheduledTime = null;
        }
      }

      isScheduled(): boolean {
        return this.timeoutId !== null;
      }

      getScheduledTime(): number | null {
        return this.scheduledTime;
      }
    }

    it('should schedule task', () => {
      const callback = vi.fn();
      const task = new ScheduledTask(callback);

      task.scheduleIn(100);
      expect(task.isScheduled()).toBe(true);

      vi.advanceTimersByTime(100);
      expect(callback).toHaveBeenCalled();
      expect(task.isScheduled()).toBe(false);
    });

    it('should cancel scheduled task', () => {
      const callback = vi.fn();
      const task = new ScheduledTask(callback);

      task.scheduleIn(100);
      task.cancel();

      vi.advanceTimersByTime(100);
      expect(callback).not.toHaveBeenCalled();
      expect(task.isScheduled()).toBe(false);
    });

    it('should reschedule task', () => {
      const callback = vi.fn();
      const task = new ScheduledTask(callback);

      task.scheduleIn(100);
      vi.advanceTimersByTime(50);
      task.scheduleIn(100); // Reschedule

      vi.advanceTimersByTime(50);
      expect(callback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      expect(callback).toHaveBeenCalled();
    });

    it('should schedule at specific time', () => {
      const callback = vi.fn();
      const task = new ScheduledTask(callback);
      const now = Date.now();

      task.scheduleAt(now + 200);
      expect(task.getScheduledTime()).toBe(now + 200);

      vi.advanceTimersByTime(200);
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('Cooldown', () => {
    class Cooldown {
      private cooldownUntil: number = 0;

      constructor(private duration: number) {}

      trigger(): void {
        this.cooldownUntil = Date.now() + this.duration;
      }

      isOnCooldown(): boolean {
        return Date.now() < this.cooldownUntil;
      }

      getRemainingTime(): number {
        return Math.max(0, this.cooldownUntil - Date.now());
      }

      reset(): void {
        this.cooldownUntil = 0;
      }

      tryTrigger(): boolean {
        if (this.isOnCooldown()) return false;
        this.trigger();
        return true;
      }
    }

    it('should start on cooldown after trigger', () => {
      const cooldown = new Cooldown(100);
      cooldown.trigger();
      expect(cooldown.isOnCooldown()).toBe(true);
    });

    it('should end cooldown after duration', () => {
      const cooldown = new Cooldown(100);
      cooldown.trigger();

      vi.advanceTimersByTime(100);
      expect(cooldown.isOnCooldown()).toBe(false);
    });

    it('should report remaining time', () => {
      const cooldown = new Cooldown(100);
      cooldown.trigger();

      vi.advanceTimersByTime(30);
      expect(cooldown.getRemainingTime()).toBe(70);
    });

    it('should reset cooldown', () => {
      const cooldown = new Cooldown(100);
      cooldown.trigger();
      cooldown.reset();
      expect(cooldown.isOnCooldown()).toBe(false);
    });

    it('should prevent trigger during cooldown', () => {
      const cooldown = new Cooldown(100);
      expect(cooldown.tryTrigger()).toBe(true);
      expect(cooldown.tryTrigger()).toBe(false);

      vi.advanceTimersByTime(100);
      expect(cooldown.tryTrigger()).toBe(true);
    });
  });

  describe('Deadline', () => {
    class Deadline {
      private deadline: number;

      constructor(durationMs: number) {
        this.deadline = Date.now() + durationMs;
      }

      isExpired(): boolean {
        return Date.now() >= this.deadline;
      }

      getRemainingTime(): number {
        return Math.max(0, this.deadline - Date.now());
      }

      extend(additionalMs: number): void {
        this.deadline += additionalMs;
      }

      static fromTimestamp(timestamp: number): Deadline {
        const d = new Deadline(0);
        d.deadline = timestamp;
        return d;
      }
    }

    it('should not be expired initially', () => {
      const deadline = new Deadline(100);
      expect(deadline.isExpired()).toBe(false);
    });

    it('should expire after duration', () => {
      const deadline = new Deadline(100);
      vi.advanceTimersByTime(100);
      expect(deadline.isExpired()).toBe(true);
    });

    it('should report remaining time', () => {
      const deadline = new Deadline(100);
      vi.advanceTimersByTime(30);
      expect(deadline.getRemainingTime()).toBe(70);
    });

    it('should extend deadline', () => {
      const deadline = new Deadline(100);
      vi.advanceTimersByTime(80);
      deadline.extend(50);
      vi.advanceTimersByTime(30);
      expect(deadline.isExpired()).toBe(false);
      vi.advanceTimersByTime(40);
      expect(deadline.isExpired()).toBe(true);
    });
  });

  describe('Polling', () => {
    class Poller<T> {
      private intervalId: ReturnType<typeof setInterval> | null = null;
      private fn: () => Promise<T>;
      private interval: number;
      private onResult: (result: T) => void;
      private onError: (error: Error) => void;

      constructor(options: {
        fn: () => Promise<T>;
        interval: number;
        onResult: (result: T) => void;
        onError?: (error: Error) => void;
      }) {
        this.fn = options.fn;
        this.interval = options.interval;
        this.onResult = options.onResult;
        this.onError = options.onError || (() => {});
      }

      start(): void {
        if (this.intervalId) return;
        this.poll();
        this.intervalId = setInterval(() => this.poll(), this.interval);
      }

      stop(): void {
        if (this.intervalId) {
          clearInterval(this.intervalId);
          this.intervalId = null;
        }
      }

      isRunning(): boolean {
        return this.intervalId !== null;
      }

      private async poll(): Promise<void> {
        try {
          const result = await this.fn();
          this.onResult(result);
        } catch (error) {
          this.onError(error as Error);
        }
      }
    }

    it('should poll immediately on start', async () => {
      const fn = vi.fn().mockResolvedValue('result');
      const onResult = vi.fn();

      const poller = new Poller({ fn, interval: 100, onResult });
      poller.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith('result');
    });

    it('should poll at intervals', async () => {
      const fn = vi.fn().mockResolvedValue('result');
      const onResult = vi.fn();

      const poller = new Poller({ fn, interval: 100, onResult });
      poller.start();

      await vi.advanceTimersByTimeAsync(250);
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 intervals
    });

    it('should stop polling', async () => {
      const fn = vi.fn().mockResolvedValue('result');
      const poller = new Poller({ fn, interval: 100, onResult: vi.fn() });

      poller.start();
      poller.stop();

      await vi.advanceTimersByTimeAsync(500);
      expect(fn).toHaveBeenCalledTimes(1); // Only initial call
    });

    it('should handle errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('poll error'));
      const onError = vi.fn();

      const poller = new Poller({ fn, interval: 100, onResult: vi.fn(), onError });
      poller.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalled();
    });
  });

  describe('Duration Parsing', () => {
    const parseDuration = (str: string): number => {
      const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
      if (!match) return NaN;

      const value = parseFloat(match[1]);
      const unit = (match[2] || 'ms').toLowerCase();

      const multipliers: Record<string, number> = {
        ms: 1,
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
      };

      return value * (multipliers[unit] || 1);
    };

    it('should parse milliseconds', () => {
      expect(parseDuration('100')).toBe(100);
      expect(parseDuration('100ms')).toBe(100);
    });

    it('should parse seconds', () => {
      expect(parseDuration('5s')).toBe(5000);
      expect(parseDuration('1.5s')).toBe(1500);
    });

    it('should parse minutes', () => {
      expect(parseDuration('2m')).toBe(120000);
    });

    it('should parse hours', () => {
      expect(parseDuration('1h')).toBe(3600000);
    });

    it('should parse days', () => {
      expect(parseDuration('1d')).toBe(86400000);
    });

    it('should handle invalid input', () => {
      expect(parseDuration('invalid')).toBeNaN();
      expect(parseDuration('')).toBeNaN();
    });
  });

  describe('Time Formatting', () => {
    const formatRelativeTime = (timestamp: number): string => {
      const now = Date.now();
      const diff = now - timestamp;

      if (diff < 1000) return 'just now';
      if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return `${Math.floor(diff / 86400000)}d ago`;
    };

    it('should format just now', () => {
      expect(formatRelativeTime(Date.now())).toBe('just now');
    });

    it('should format seconds ago', () => {
      expect(formatRelativeTime(Date.now() - 30000)).toBe('30s ago');
    });

    it('should format minutes ago', () => {
      expect(formatRelativeTime(Date.now() - 300000)).toBe('5m ago');
    });

    it('should format hours ago', () => {
      expect(formatRelativeTime(Date.now() - 7200000)).toBe('2h ago');
    });

    it('should format days ago', () => {
      expect(formatRelativeTime(Date.now() - 172800000)).toBe('2d ago');
    });
  });
});
