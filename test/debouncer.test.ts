import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Debouncer, KeyedDebouncer } from '../src/utils/debouncer.js';

describe('Debouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires callback after delay', () => {
    const deb = new Debouncer(100);
    const fn = vi.fn();

    deb.schedule(fn);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('resets timer when schedule() called again — only last callback fires', () => {
    const deb = new Debouncer(100);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    deb.schedule(fn1);
    vi.advanceTimersByTime(50);

    deb.schedule(fn2);
    vi.advanceTimersByTime(100);

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('multiple rapid schedule() calls only fires the last one', () => {
    const deb = new Debouncer(100);
    const callbacks = Array.from({ length: 5 }, () => vi.fn());

    for (const cb of callbacks) {
      deb.schedule(cb);
    }

    vi.advanceTimersByTime(100);

    for (let i = 0; i < callbacks.length - 1; i++) {
      expect(callbacks[i]).not.toHaveBeenCalled();
    }
    expect(callbacks[callbacks.length - 1]).toHaveBeenCalledOnce();
  });

  it('cancel() prevents pending callback from firing', () => {
    const deb = new Debouncer(100);
    const fn = vi.fn();

    deb.schedule(fn);
    vi.advanceTimersByTime(50);
    deb.cancel();

    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('isPending returns true when scheduled, false after fire', () => {
    const deb = new Debouncer(100);
    const fn = vi.fn();

    expect(deb.isPending).toBe(false);

    deb.schedule(fn);
    expect(deb.isPending).toBe(true);

    vi.advanceTimersByTime(100);
    expect(deb.isPending).toBe(false);
  });

  it('isPending returns false after cancel', () => {
    const deb = new Debouncer(100);

    deb.schedule(() => {});
    expect(deb.isPending).toBe(true);

    deb.cancel();
    expect(deb.isPending).toBe(false);
  });

  it('dispose() is alias for cancel()', () => {
    const deb = new Debouncer(100);
    const fn = vi.fn();

    deb.schedule(fn);
    expect(deb.isPending).toBe(true);

    deb.dispose();
    expect(deb.isPending).toBe(false);

    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush() cancels pending and runs provided function immediately', () => {
    const deb = new Debouncer(100);
    const scheduled = vi.fn();
    const flushed = vi.fn();

    deb.schedule(scheduled);
    deb.flush(flushed);

    expect(flushed).toHaveBeenCalledOnce();
    expect(deb.isPending).toBe(false);

    vi.advanceTimersByTime(100);
    expect(scheduled).not.toHaveBeenCalled();
  });

  it('can be reused after firing', () => {
    const deb = new Debouncer(100);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    deb.schedule(fn1);
    vi.advanceTimersByTime(100);
    expect(fn1).toHaveBeenCalledOnce();

    deb.schedule(fn2);
    vi.advanceTimersByTime(100);
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('can be reused after cancel', () => {
    const deb = new Debouncer(100);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    deb.schedule(fn1);
    deb.cancel();

    deb.schedule(fn2);
    vi.advanceTimersByTime(100);

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });
});

describe('KeyedDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires per-key callback after delay', () => {
    const deb = new KeyedDebouncer(100);
    const fn = vi.fn();

    deb.schedule('a', fn);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('independent keys fire at their own timing', () => {
    const deb = new KeyedDebouncer(100);
    const fnA = vi.fn();
    const fnB = vi.fn();

    deb.schedule('a', fnA);
    vi.advanceTimersByTime(50);
    deb.schedule('b', fnB);

    vi.advanceTimersByTime(50);
    expect(fnA).toHaveBeenCalledOnce();
    expect(fnB).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fnB).toHaveBeenCalledOnce();
  });

  it('rescheduling same key resets timer — only last callback fires', () => {
    const deb = new KeyedDebouncer(100);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    deb.schedule('a', fn1);
    vi.advanceTimersByTime(50);
    deb.schedule('a', fn2);

    vi.advanceTimersByTime(100);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('cancelKey() only cancels specific key', () => {
    const deb = new KeyedDebouncer(100);
    const fnA = vi.fn();
    const fnB = vi.fn();

    deb.schedule('a', fnA);
    deb.schedule('b', fnB);

    deb.cancelKey('a');

    vi.advanceTimersByTime(100);
    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).toHaveBeenCalledOnce();
  });

  it('has() returns correct state per key', () => {
    const deb = new KeyedDebouncer(100);

    expect(deb.has('a')).toBe(false);

    deb.schedule('a', () => {});
    expect(deb.has('a')).toBe(true);
    expect(deb.has('b')).toBe(false);

    vi.advanceTimersByTime(100);
    expect(deb.has('a')).toBe(false);
  });

  it('has() returns false after cancelKey()', () => {
    const deb = new KeyedDebouncer(100);

    deb.schedule('a', () => {});
    deb.cancelKey('a');
    expect(deb.has('a')).toBe(false);
  });

  it('size reflects active timer count', () => {
    const deb = new KeyedDebouncer(100);

    expect(deb.size).toBe(0);

    deb.schedule('a', () => {});
    expect(deb.size).toBe(1);

    deb.schedule('b', () => {});
    expect(deb.size).toBe(2);

    vi.advanceTimersByTime(100);
    expect(deb.size).toBe(0);
  });

  it('keys() returns active keys', () => {
    const deb = new KeyedDebouncer(100);

    deb.schedule('x', () => {});
    deb.schedule('y', () => {});
    deb.schedule('z', () => {});

    const activeKeys = Array.from(deb.keys());
    expect(activeKeys).toEqual(['x', 'y', 'z']);
  });

  it('dispose() cancels all keys', () => {
    const deb = new KeyedDebouncer(100);
    const fnA = vi.fn();
    const fnB = vi.fn();

    deb.schedule('a', fnA);
    deb.schedule('b', fnB);
    expect(deb.size).toBe(2);

    deb.dispose();
    expect(deb.size).toBe(0);

    vi.advanceTimersByTime(100);
    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).not.toHaveBeenCalled();
  });

  it('flushAll() cancels all timers and calls flush fn per active key', () => {
    const deb = new KeyedDebouncer(100);
    const scheduled1 = vi.fn();
    const scheduled2 = vi.fn();
    const flushFn = vi.fn();

    deb.schedule('a', scheduled1);
    deb.schedule('b', scheduled2);

    deb.flushAll(flushFn);

    expect(deb.size).toBe(0);
    expect(flushFn).toHaveBeenCalledTimes(2);
    expect(flushFn).toHaveBeenCalledWith('a');
    expect(flushFn).toHaveBeenCalledWith('b');

    vi.advanceTimersByTime(100);
    expect(scheduled1).not.toHaveBeenCalled();
    expect(scheduled2).not.toHaveBeenCalled();
  });

  it('flushAll() with no active keys does nothing', () => {
    const deb = new KeyedDebouncer(100);
    const flushFn = vi.fn();

    deb.flushAll(flushFn);
    expect(flushFn).not.toHaveBeenCalled();
  });

  it('cancelKey() on non-existent key is a no-op', () => {
    const deb = new KeyedDebouncer(100);
    expect(() => deb.cancelKey('nonexistent')).not.toThrow();
  });

  it('can be reused after dispose()', () => {
    const deb = new KeyedDebouncer(100);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    deb.schedule('a', fn1);
    deb.dispose();

    deb.schedule('b', fn2);
    vi.advanceTimersByTime(100);

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });
});
