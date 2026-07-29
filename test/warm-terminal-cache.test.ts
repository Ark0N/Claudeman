import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type WarmTerminalCache = {
  activate: (sessionId: string, now?: number) => void;
  append: (sessionId: string, data: string, now?: number) => boolean;
  consume: (sessionId: string, now?: number) => string | null;
  confirmDelivery: (sessionId: string, now?: number) => void;
  confirmSubscriptions: (sessionIds: string[], now?: number) => void;
  generation: (sessionId: string, now?: number) => number | null;
  ids: (now?: number) => string[];
  invalidateReplay: (sessionId: string, now?: number) => void;
  isReplayable: (sessionId: string, now?: number) => boolean;
  isWarm: (sessionId: string, now?: number) => boolean;
  markCanonical: (sessionId: string, now?: number) => void;
  nextExpiryDelay: (now?: number) => number | null;
  remove: (sessionId: string) => void;
};

type WarmTerminalCacheConstructor = new (options?: {
  limit?: number;
  ttlMs?: number;
  maxDeltaChars?: number;
}) => WarmTerminalCache;

function loadWarmTerminalCache(): WarmTerminalCacheConstructor {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const context = vm.createContext({ console, setTimeout, clearTimeout });
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
    const cache = new WarmTerminalCache({ maxDeltaChars: 32 });

    cache.activate('a', 0);
    cache.confirmSubscriptions(['a'], 0);
    cache.markCanonical('a', 0);
    cache.activate('b', 1);

    cache.confirmSubscriptions(['a', 'b'], 1);
    expect(cache.isReplayable('a', 1)).toBe(true);
    expect(cache.append('a', 'first-', 2)).toBe(true);
    expect(cache.append('a', 'second', 3)).toBe(true);
    expect(cache.consume('a', 4)).toBe('first-second');
    expect(cache.consume('a', 5)).toBe('');
  });

  it('does not retroactively validate a snapshot from a subscription gap', () => {
    const WarmTerminalCache = loadWarmTerminalCache();
    const cache = new WarmTerminalCache();

    cache.activate('a', 0);
    cache.activate('b', 1);
    cache.confirmSubscriptions(['a', 'b'], 2);
    cache.confirmDelivery('a', 3);

    expect(cache.isReplayable('a', 3)).toBe(false);

    cache.activate('a', 4);
    cache.markCanonical('a', 4);
    cache.activate('b', 5);
    expect(cache.isReplayable('a', 5)).toBe(true);
  });

  it('invalidates an in-flight replay without dropping subscription coverage', () => {
    const WarmTerminalCache = loadWarmTerminalCache();
    const cache = new WarmTerminalCache();

    cache.activate('a', 0);
    cache.confirmSubscriptions(['a'], 0);
    cache.markCanonical('a', 0);
    cache.activate('b', 1);
    const generation = cache.generation('a', 1);

    cache.append('a', 'stale', 2);
    cache.invalidateReplay('a', 3);

    expect(cache.generation('a', 3)).not.toBe(generation);
    expect(cache.isReplayable('a', 3)).toBe(false);
    expect(cache.consume('a', 3)).toBe('');

    cache.activate('a', 4);
    cache.markCanonical('a', 4);
    cache.activate('b', 5);
    expect(cache.isReplayable('a', 5)).toBe(true);
  });

  it('does not snapshot a session while canonical state is pending', () => {
    const WarmTerminalCache = loadWarmTerminalCache();
    const cache = new WarmTerminalCache();

    cache.activate('a', 0);
    cache.confirmSubscriptions(['a'], 0);
    cache.activate('b', 1);
    expect(cache.isReplayable('a', 1)).toBe(false);

    cache.activate('a', 2);
    cache.markCanonical('a', 3);
    cache.activate('b', 4);
    expect(cache.isReplayable('a', 4)).toBe(true);
  });

  it('invalidates an overflowing delta and recovers on explicit activation', () => {
    const WarmTerminalCache = loadWarmTerminalCache();
    const cache = new WarmTerminalCache({ maxDeltaChars: 8 });

    cache.activate('a', 0);
    cache.activate('b', 1);
    expect(cache.append('a', '1234', 2)).toBe(true);
    expect(cache.append('a', '56789', 3)).toBe(false);
    expect(cache.isWarm('a', 3)).toBe(false);
    expect(cache.consume('a', 3)).toBeNull();

    cache.activate('a', 4);
    expect(cache.isWarm('a', 4)).toBe(true);
    expect(cache.isReplayable('a', 4)).toBe(false);
    expect(cache.consume('a', 4)).toBe('');
  });

  it('is wired into inactive delivery and skips the canonical fetch only for a valid warm restore', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const inactiveDelivery = source.indexOf('else if (this._warmTerminalCache.isWarm(data.id))');
    const perTabTransport = source.indexOf('`${this._clientId}:${this._wsTabNonce}`');
    const explicitSubscription = source.indexOf('const body = JSON.stringify({');
    const explicitSubscriptionBody = source.slice(explicitSubscription, explicitSubscription + 180);
    const explicitQuery = source.indexOf("_sseParams.set('sessions', terminalSessions.join(','));");
    const subscriptionAck = source.indexOf('this._warmTerminalCache.confirmSubscriptions(sessions);');
    const targetCheck = source.indexOf('const targetWasReplayable = this._warmTerminalCache.isReplayable(sessionId);');
    const deltaReplay = source.indexOf('const warmDelta = this._warmTerminalCache.consume(sessionId);', targetCheck);
    const replayGenerationCheck = source.indexOf(
      'this._warmTerminalCache.generation(sessionId) !== targetWarmGeneration',
      targetCheck
    );
    const fetchStart = source.indexOf("FETCH_START'", deltaReplay);
    const fetchGate = source.lastIndexOf('if (!usedWarmRestore)', fetchStart);
    const canonicalResponse = source.indexOf(
      "Object.prototype.hasOwnProperty.call(data, 'terminalBuffer')",
      fetchStart
    );
    const canonicalMark = source.indexOf(
      'if (canonicalStateReady) this._warmTerminalCache.markCanonical(sessionId);',
      canonicalResponse
    );
    const recoveryInvalidation = source.indexOf('this._invalidateInactiveWarmTerminalSessions();');
    const targetedRecovery = source.lastIndexOf('this._dropWarmTerminalSession(data.id, true);', recoveryInvalidation);
    const inactiveClear = source.indexOf('if (data.id !== this.activeSessionId)', recoveryInvalidation);
    const inactiveDrop = source.indexOf('this._dropWarmTerminalSession(data.id, true);', inactiveClear);

    expect(inactiveDelivery).toBeGreaterThan(-1);
    expect(perTabTransport).toBeGreaterThan(-1);
    expect(explicitSubscription).toBeGreaterThan(-1);
    expect(explicitSubscriptionBody).toContain('sessions,');
    expect(explicitQuery).toBeGreaterThan(-1);
    expect(subscriptionAck).toBeGreaterThan(-1);
    expect(targetCheck).toBeGreaterThan(-1);
    expect(deltaReplay).toBeGreaterThan(targetCheck);
    expect(replayGenerationCheck).toBeGreaterThan(targetCheck);
    expect(replayGenerationCheck).toBeLessThan(deltaReplay);
    expect(fetchGate).toBeGreaterThan(deltaReplay);
    expect(fetchStart).toBeGreaterThan(fetchGate);
    expect(canonicalResponse).toBeGreaterThan(fetchStart);
    expect(canonicalMark).toBeGreaterThan(canonicalResponse);
    expect(recoveryInvalidation).toBeGreaterThan(-1);
    expect(targetedRecovery).toBeGreaterThan(-1);
    expect(targetedRecovery).toBeLessThan(recoveryInvalidation);
    expect(inactiveClear).toBeGreaterThan(recoveryInvalidation);
    expect(inactiveDrop).toBeGreaterThan(inactiveClear);
  });
});
