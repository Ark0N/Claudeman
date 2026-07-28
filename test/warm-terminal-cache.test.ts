import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type WarmTerminalCache = {
  activate: (sessionId: string, now?: number) => void;
  append: (sessionId: string, data: string, now?: number) => boolean;
  consume: (sessionId: string, now?: number) => string | null;
  ids: (now?: number) => string[];
  isWarm: (sessionId: string, now?: number) => boolean;
  nextExpiryDelay: (now?: number) => number | null;
  remove: (sessionId: string) => void;
};

type WarmTerminalCacheConstructor = new (options?: {
  limit?: number;
  ttlMs?: number;
  maxDeltaBytes?: number;
}) => WarmTerminalCache;

function loadWarmTerminalCache(): WarmTerminalCacheConstructor {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context as unknown as { WarmTerminalCache: WarmTerminalCacheConstructor }).WarmTerminalCache;
}

describe('WarmTerminalCache', () => {
  it('keeps the active session and a bounded recent-session range', () => {
    const WarmTerminalCache = loadWarmTerminalCache();
    const cache = new WarmTerminalCache({ limit: 3, ttlMs: 30_000 });

    cache.activate('a', 0);
    cache.activate('b', 1_000);
    cache.activate('c', 2_000);
    cache.activate('d', 3_000);

    expect(cache.ids(3_000)).toEqual(['b', 'c', 'd']);
    expect(cache.isWarm('a', 3_000)).toBe(false);
    expect(cache.isWarm('d', 60_000)).toBe(true);
  });

  it('expires inactive sessions without expiring the active session', () => {
    const WarmTerminalCache = loadWarmTerminalCache();
    const cache = new WarmTerminalCache({ ttlMs: 30_000 });

    cache.activate('a', 10_000);
    cache.activate('b', 20_000);

    expect(cache.nextExpiryDelay(20_000)).toBe(30_000);
    expect(cache.ids(49_999)).toEqual(['a', 'b']);
    expect(cache.ids(50_000)).toEqual(['b']);
    expect(cache.nextExpiryDelay(50_000)).toBeNull();
  });

  it('replays inactive deltas once and in arrival order', () => {
    const WarmTerminalCache = loadWarmTerminalCache();
    const cache = new WarmTerminalCache({ maxDeltaBytes: 32 });

    cache.activate('a', 0);
    cache.activate('b', 1);

    expect(cache.append('a', 'first-', 2)).toBe(true);
    expect(cache.append('a', 'second', 3)).toBe(true);
    expect(cache.consume('a', 4)).toBe('first-second');
    expect(cache.consume('a', 5)).toBe('');
  });

  it('invalidates an overflowing delta so the caller can fetch canonically', () => {
    const WarmTerminalCache = loadWarmTerminalCache();
    const cache = new WarmTerminalCache({ maxDeltaBytes: 8 });

    cache.activate('a', 0);
    cache.activate('b', 1);

    expect(cache.append('a', '1234', 2)).toBe(true);
    expect(cache.append('a', '56789', 3)).toBe(false);
    expect(cache.isWarm('a', 3)).toBe(false);
    expect(cache.consume('a', 3)).toBeNull();

    cache.remove('a');
    expect(cache.ids(3)).toEqual(['b']);
  });

  it('is wired into inactive terminal delivery and session selection', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const inactiveDelivery = source.indexOf('else if (this._warmTerminalCache.isWarm(data.id))');
    const targetCheck = source.indexOf('const targetWasWarm = this._warmTerminalCache.isWarm(sessionId);');
    const deltaReplay = source.indexOf('const warmDelta = this._warmTerminalCache.consume(sessionId);', targetCheck);
    const fetchGate = source.indexOf('if (!usedWarmRestore)', deltaReplay);
    const fetchStart = source.indexOf("FETCH_START'", fetchGate);

    expect(inactiveDelivery).toBeGreaterThan(-1);
    expect(targetCheck).toBeGreaterThan(-1);
    expect(deltaReplay).toBeGreaterThan(targetCheck);
    expect(fetchGate).toBeGreaterThan(deltaReplay);
    expect(fetchStart).toBeGreaterThan(fetchGate);
  });
});
