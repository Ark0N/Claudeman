/**
 * COD-134 — Terminal WebSocket reconnect policy.
 *
 * `CodemanWsReconnect.plan(code, attempt)` is the pure decision behind the
 * client WS `onclose` handler in app.js: given a WebSocket close code and the
 * number of consecutive reconnects already attempted, it returns the action to
 * take (`reconnect` | `retry-fallback` | `give-up`) and a backoff delay. It is
 * exposed on `window.CodemanWsReconnect` and tested here in a plain node VM
 * context (no jsdom — jsdom env setup is broken on some hosts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Plan = { action: 'reconnect' | 'retry-fallback' | 'give-up'; delayMs: number };

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanWsReconnect: { plan: (code: number, attempt: number) => Plan } })
    .CodemanWsReconnect;
}

describe('COD-134 WS reconnect plan policy', () => {
  it('reconnects immediately on the first attempt for a transient close', () => {
    const { plan } = loadHelper();
    expect(plan(1006, 0)).toEqual({ action: 'reconnect', delayMs: 0 });
    expect(plan(1000, 0).action).toBe('reconnect');
    expect(plan(1001, 0).delayMs).toBe(0);
    expect(plan(1005, 0).delayMs).toBe(0);
  });

  it('grows the backoff exponentially with a 10s cap for transient closes', () => {
    const { plan } = loadHelper();
    expect(plan(1006, 0).delayMs).toBe(0);
    expect(plan(1006, 1).delayMs).toBe(250);
    expect(plan(1006, 2).delayMs).toBe(500);
    expect(plan(1006, 3).delayMs).toBe(1000);
    expect(plan(1006, 4).delayMs).toBe(2000);
    expect(plan(1006, 5).delayMs).toBe(4000);
    expect(plan(1006, 6).delayMs).toBe(8000);
    expect(plan(1006, 7).delayMs).toBe(10000); // 16000 capped to 10000
    expect(plan(1006, 8).delayMs).toBe(10000);
    expect(plan(1006, 50).delayMs).toBe(10000); // stays capped no matter how many attempts
    // every transient attempt is still a reconnect
    for (let attempt = 0; attempt < 12; attempt++) {
      expect(plan(1006, attempt).action).toBe('reconnect');
    }
  });

  it('auto-retries the fallback on a too-many-connections (4008) close', () => {
    const { plan } = loadHelper();
    expect(plan(4008, 0)).toEqual({ action: 'retry-fallback', delayMs: 5000 });
    expect(plan(4008, 3)).toEqual({ action: 'retry-fallback', delayMs: 5000 });
  });

  it('gives up on session-not-found (4004) and session-terminated (4009)', () => {
    const { plan } = loadHelper();
    expect(plan(4004, 0)).toEqual({ action: 'give-up', delayMs: 0 });
    expect(plan(4004, 5)).toEqual({ action: 'give-up', delayMs: 0 });
    expect(plan(4009, 0)).toEqual({ action: 'give-up', delayMs: 0 });
    expect(plan(4009, 5)).toEqual({ action: 'give-up', delayMs: 0 });
  });

  it('auto-retries the fallback for an unknown >=4004 code (e.g. 4010, 4005)', () => {
    const { plan } = loadHelper();
    expect(plan(4010, 0)).toEqual({ action: 'retry-fallback', delayMs: 5000 });
    expect(plan(4005, 2)).toEqual({ action: 'retry-fallback', delayMs: 5000 });
    expect(plan(4500, 0)).toEqual({ action: 'retry-fallback', delayMs: 5000 });
  });

  it('treats a sub-4004 close (e.g. 4003 Forbidden) as a transient reconnect', () => {
    const { plan } = loadHelper();
    // 4003 is < 4004, so it is NOT a give-up; it follows the transient backoff.
    expect(plan(4003, 0)).toEqual({ action: 'reconnect', delayMs: 0 });
  });
});
