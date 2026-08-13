/**
 * SSE staleness policy.
 *
 * `CodemanSseStale.compute(input)` is the pure decision behind app.js's
 * watchdog: given when the last SSE frame arrived, the transport status and
 * the browser's online flag, it says whether the stream has gone quiet while
 * still claiming to be connected: a zombie that has to be rebuilt.
 *
 * The regression it guards: the server's liveness keepalive used to be an SSE
 * `:keepalive` COMMENT, and comments are invisible to `EventSource` by spec.
 * A stream that stopped delivering without erroring (a proxy that idle-closed
 * it, a laptop resumed from sleep, a tailnet reconnect) never fired `onerror`,
 * so the header dot stayed green and tab status dots, sessions created on
 * another device, and renames all froze until the user reloaded the page.
 *
 * Loaded in a plain node VM context (no jsdom), mirroring
 * test/connection-loss-ui.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type StaleInput = {
  lastMessageAt?: number | null;
  now?: number;
  status?: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'offline';
  isOnline?: boolean;
  timeoutMs?: number;
};

function loadPolicy() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanSseStale: { compute: (input: StaleInput) => boolean; TIMEOUT_MS: number };
    }
  ).CodemanSseStale;
}

const T0 = 1_000_000;

describe('SSE staleness policy', () => {
  it('defaults to three missed 15s heartbeats', () => {
    const { TIMEOUT_MS } = loadPolicy();
    expect(TIMEOUT_MS).toBe(45000);
  });

  it('is not stale while frames keep arriving', () => {
    const { compute, TIMEOUT_MS } = loadPolicy();
    expect(compute({ lastMessageAt: T0, now: T0 + TIMEOUT_MS - 1, status: 'connected' })).toBe(false);
  });

  it('is stale once the threshold is reached', () => {
    const { compute, TIMEOUT_MS } = loadPolicy();
    // Boundary is inclusive: exactly three missed heartbeats already means the
    // stream has been silent through a window it was contractually filling.
    expect(compute({ lastMessageAt: T0, now: T0 + TIMEOUT_MS, status: 'connected' })).toBe(true);
    expect(compute({ lastMessageAt: T0, now: T0 + TIMEOUT_MS * 10, status: 'connected' })).toBe(true);
  });

  it('honours a custom timeoutMs (what a browser test shrinks)', () => {
    const { compute } = loadPolicy();
    expect(compute({ lastMessageAt: T0, now: T0 + 999, status: 'connected', timeoutMs: 1000 })).toBe(false);
    expect(compute({ lastMessageAt: T0, now: T0 + 1000, status: 'connected', timeoutMs: 1000 })).toBe(true);
  });

  it('is never stale while the transport is already reconnecting', () => {
    const { compute, TIMEOUT_MS } = loadPolicy();
    // These states already have the backoff machinery running; firing on top
    // of them would stack reconnects. This guard is also the loop breaker:
    // a forced reconnect leaves 'connected' immediately, so the watchdog
    // cannot re-fire while one is in flight.
    for (const status of ['connecting', 'reconnecting', 'disconnected', 'offline'] as const) {
      expect(compute({ lastMessageAt: T0, now: T0 + TIMEOUT_MS * 10, status })).toBe(false);
    }
  });

  it('is never stale while the device is offline', () => {
    const { compute, TIMEOUT_MS } = loadPolicy();
    // Nothing to reconnect to yet; the connection-loss UI already owns this.
    expect(compute({ lastMessageAt: T0, now: T0 + TIMEOUT_MS * 10, status: 'connected', isOnline: false })).toBe(false);
  });

  it('is not stale before any frame has ever arrived', () => {
    const { compute, TIMEOUT_MS } = loadPolicy();
    // The clock starts at onopen, and `init` lands immediately after. A zero
    // stamp means the stream has not opened yet, not that it went quiet. The
    // constructor optimistically seeds status 'connected' before the first
    // connect, so without this guard the watchdog would fire on page load.
    for (const lastMessageAt of [0, null, undefined]) {
      expect(compute({ lastMessageAt, now: T0 + TIMEOUT_MS * 10, status: 'connected' })).toBe(false);
    }
  });

  it('tolerates a missing input object', () => {
    const { compute } = loadPolicy();
    expect(compute(undefined as unknown as StaleInput)).toBe(false);
  });
});
