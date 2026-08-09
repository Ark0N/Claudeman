/**
 * Connection-loss UI policy.
 *
 * `CodemanConnectionLoss.compute(input)` is the pure decision behind the
 * offline banner and the full-screen "can't reach Codeman" overlay in app.js:
 * given the browser's online flag, the SSE transport status, whether server
 * state has ever loaded this page load, and how long the transport has been
 * down, it returns which surface to show and what it should say.
 *
 * The regression it guards: with the service worker serving the cached app
 * shell, an unreachable server rendered a normal-looking empty dashboard whose
 * only hint was an 8px red dot in the header corner.
 *
 * Loaded in a plain node VM context (no jsdom), mirroring
 * test/ws-reconnect-plan.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type LossInput = {
  isOnline?: boolean;
  status?: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'offline';
  everLoaded?: boolean;
  downSince?: number | null;
  now?: number;
  nextRetryAt?: number | null;
  overlayDismissed?: boolean;
  retryPending?: boolean;
};

type LossState = {
  mode: 'hidden' | 'banner' | 'overlay';
  kind: 'connected' | 'connecting' | 'offline' | 'unreachable';
  title: string;
  detail: string;
  retryInSec: number | null;
};

function loadPolicy() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanConnectionLoss: { compute: (input: LossInput) => LossState; GRACE_MS: number };
    }
  ).CodemanConnectionLoss;
}

const T0 = 1_000_000;

describe('connection-loss UI policy', () => {
  it('shows nothing while the SSE stream is connected', () => {
    const { compute } = loadPolicy();
    expect(compute({ isOnline: true, status: 'connected', everLoaded: true, now: T0 }).mode).toBe('hidden');
  });

  it('stays hidden through a deploy-length blip (the grace window)', () => {
    const { compute, GRACE_MS } = loadPolicy();
    // A COM deploy restarts the server; SSE is back in ~200ms. Shouting on
    // every deploy would train the user to ignore the banner.
    const during = compute({
      isOnline: true,
      status: 'reconnecting',
      everLoaded: true,
      downSince: T0,
      now: T0 + GRACE_MS - 1,
    });
    expect(during.mode).toBe('hidden');
    expect(during.kind).toBe('connecting');

    const after = compute({
      isOnline: true,
      status: 'reconnecting',
      everLoaded: true,
      downSince: T0,
      now: T0 + GRACE_MS,
    });
    expect(after.mode).toBe('banner');
    expect(after.kind).toBe('unreachable');
  });

  it('blocks with the overlay when no server state ever loaded this page load', () => {
    const { compute, GRACE_MS } = loadPolicy();
    // The cold-start case: app shell served from the service-worker cache with
    // nothing reachable behind it. There is no UI worth preserving.
    const state = compute({
      isOnline: true,
      status: 'reconnecting',
      everLoaded: false,
      downSince: T0,
      now: T0 + GRACE_MS + 5000,
    });
    expect(state.mode).toBe('overlay');
    expect(state.title).toMatch(/reach the Codeman server/i);
    // The VPN/Tailscale hint is the whole point on a phone off the tailnet.
    expect(state.detail).toMatch(/Tailscale|VPN/i);
  });

  it('uses the non-blocking banner once state has loaded, so the terminal stays readable', () => {
    const { compute, GRACE_MS } = loadPolicy();
    const state = compute({
      isOnline: true,
      status: 'disconnected',
      everLoaded: true,
      downSince: T0,
      now: T0 + GRACE_MS + 60_000,
    });
    expect(state.mode).toBe('banner');
  });

  it('skips the grace window when the device itself reports no network', () => {
    const { compute } = loadPolicy();
    // navigator.onLine === false is never a 200ms blip.
    const viaFlag = compute({ isOnline: false, status: 'connecting', everLoaded: true, downSince: T0, now: T0 });
    expect(viaFlag.mode).toBe('banner');
    expect(viaFlag.kind).toBe('offline');
    expect(viaFlag.title).toMatch(/no network/i);

    const viaStatus = compute({ isOnline: true, status: 'offline', everLoaded: false, downSince: T0, now: T0 });
    expect(viaStatus.mode).toBe('overlay');
    expect(viaStatus.kind).toBe('offline');
  });

  it('demotes the overlay to the banner once dismissed, never back to hidden', () => {
    const { compute, GRACE_MS } = loadPolicy();
    const base: LossInput = {
      isOnline: true,
      status: 'reconnecting',
      everLoaded: false,
      downSince: T0,
      now: T0 + GRACE_MS + 1000,
    };
    expect(compute(base).mode).toBe('overlay');
    expect(compute({ ...base, overlayDismissed: true }).mode).toBe('banner');
  });

  it('counts down to the next scheduled retry, floored at zero', () => {
    const { compute, GRACE_MS } = loadPolicy();
    const at = (nextRetryAt: number | null, extra: Partial<LossInput> = {}) =>
      compute({
        isOnline: true,
        status: 'reconnecting',
        everLoaded: true,
        downSince: T0,
        now: T0 + GRACE_MS,
        nextRetryAt,
        ...extra,
      }).retryInSec;

    expect(at(T0 + GRACE_MS + 4000)).toBe(4);
    expect(at(T0 + GRACE_MS + 4001)).toBe(5); // rounds up, never shows "0s" while waiting
    expect(at(T0)).toBe(0); // already overdue
    expect(at(null)).toBeNull(); // no retry scheduled -> indeterminate label
    // A user-triggered retry has no scheduled time; the caller renders "Reconnecting…".
    expect(at(T0 + GRACE_MS + 4000, { retryPending: true })).toBeNull();
  });

  it('treats a missing downSince as freshly down rather than long-dead', () => {
    const { compute } = loadPolicy();
    const state = compute({ isOnline: true, status: 'connecting', everLoaded: false, downSince: null, now: T0 });
    expect(state.mode).toBe('hidden');
  });

  it('tolerates an empty input', () => {
    const { compute } = loadPolicy();
    expect(compute({}).mode).toBe('hidden');
  });
});
