/**
 * @fileoverview Unit tests for WsConnectionRegistry (COD-137).
 *
 * The registry is the pure decision unit extracted out of ws-routes.ts so the
 * connection-limit / clientId-eviction logic is testable without driving real
 * WebSocket upgrades. Uses plain fake sockets (identity only).
 *
 * @dependency src/web/ws-connection-registry.ts
 */

import { describe, it, expect } from 'vitest';
import { WsConnectionRegistry } from '../src/web/ws-connection-registry.js';

/** Fake socket — registry only compares identity, so any object works. */
const sock = (label: string) => ({ readyState: 1, label });

describe('WsConnectionRegistry', () => {
  it('reconnecting client (same cid) reclaims its slot instead of being rejected at the limit', () => {
    const reg = new WsConnectionRegistry(5);
    // Fill all 5 slots with distinct clients, one of which is "alice".
    for (const c of ['alice', 'b', 'c', 'd', 'e']) {
      expect(reg.register('s1', c, sock(c)).admitted).toBe(true);
    }
    expect(reg.liveCount('s1')).toBe(5);

    // Alice's new upgrade lands BEFORE her old socket's async close fires.
    const aliceNew = sock('alice-new');
    const res = reg.register('s1', 'alice', aliceNew);

    expect(res.admitted).toBe(true); // NOT a spurious 4008
    expect(res.evictedSocket).toBeDefined(); // old alice socket handed back to close
    expect(reg.liveCount('s1')).toBe(5); // slot reused, not double-counted
  });

  it('still rejects a genuine (N+1)th DISTINCT client', () => {
    const reg = new WsConnectionRegistry(5);
    for (const c of ['a', 'b', 'c', 'd', 'e']) {
      expect(reg.register('s1', c, sock(c)).admitted).toBe(true);
    }
    const sixth = reg.register('s1', 'f', sock('f'));
    expect(sixth.admitted).toBe(false);
    expect(sixth.evictedSocket).toBeUndefined();
    expect(reg.liveCount('s1')).toBe(5);
  });

  it('eager removal on terminate frees a slot immediately', () => {
    const reg = new WsConnectionRegistry(5);
    const sockets = ['a', 'b', 'c', 'd', 'e'].map((c) => {
      const s = sock(c);
      reg.register('s1', c, s);
      return [c, s] as const;
    });
    expect(reg.register('s1', 'f', sock('f')).admitted).toBe(false);

    // Eagerly unregister one (simulating terminate/error, not async close).
    reg.unregister('s1', sockets[0][1]);
    expect(reg.liveCount('s1')).toBe(4);

    // Now a brand-new distinct client is admitted.
    expect(reg.register('s1', 'f', sock('f')).admitted).toBe(true);
    expect(reg.liveCount('s1')).toBe(5);
  });

  it('cid-less upgrades are admitted up to the limit and never evict a keyed client', () => {
    const reg = new WsConnectionRegistry(5);
    const keyed = sock('keyed');
    reg.register('s1', 'keyed', keyed);

    // Four anonymous upgrades fill the rest of the cap.
    for (let i = 0; i < 4; i++) {
      const res = reg.register('s1', null, sock(`anon${i}`));
      expect(res.admitted).toBe(true);
      expect(res.evictedSocket).toBeUndefined(); // never evicts the keyed client
    }
    expect(reg.liveCount('s1')).toBe(5);

    // 6th anonymous is rejected — anonymous sockets count toward the cap.
    expect(reg.register('s1', null, sock('anon-extra')).admitted).toBe(false);

    // The keyed client is untouched: a same-cid reconnect still reclaims.
    const keyedNew = sock('keyed-new');
    const res = reg.register('s1', 'keyed', keyedNew);
    expect(res.admitted).toBe(true);
    expect(res.evictedSocket).toBe(keyed);
  });

  it('late close of a superseded socket does not evict the reconnected one', () => {
    const reg = new WsConnectionRegistry(5);
    const old = sock('old');
    reg.register('s1', 'alice', old);
    const fresh = sock('fresh');
    reg.register('s1', 'alice', fresh); // supersede

    // The stale socket's async close arrives late — must NOT remove fresh.
    reg.unregister('s1', old);
    expect(reg.liveCount('s1')).toBe(1);

    // Fresh is still the live entry: another reconnect evicts fresh, not old.
    const fresher = sock('fresher');
    expect(reg.register('s1', 'alice', fresher).evictedSocket).toBe(fresh);
  });

  it('two tabs of the same browser (shared clientId, distinct tab nonce) coexist without eviction', () => {
    // The client keys the upgrade by `clientId:tabNonce`, NOT the bare
    // browser-wide clientId — otherwise two windows on one session would
    // supersede each other in a perpetual 4010/5s reconnect ping-pong.
    const reg = new WsConnectionRegistry(5);
    const tabA = sock('tab-a');
    const tabB = sock('tab-b');

    expect(reg.register('s1', 'c-browser:tab-A', tabA).evictedSocket).toBeUndefined();
    const resB = reg.register('s1', 'c-browser:tab-B', tabB);
    expect(resB.admitted).toBe(true);
    expect(resB.evictedSocket).toBeUndefined(); // tab A keeps its socket
    expect(reg.liveCount('s1')).toBe(2);

    // A genuine same-tab reconnect still supersedes only its own socket.
    const tabANew = sock('tab-a-new');
    const res = reg.register('s1', 'c-browser:tab-A', tabANew);
    expect(res.evictedSocket).toBe(tabA);
    expect(reg.liveCount('s1')).toBe(2);
  });

  it('isolates counts per session', () => {
    const reg = new WsConnectionRegistry(2);
    reg.register('s1', 'a', sock('a'));
    reg.register('s1', 'b', sock('b'));
    expect(reg.register('s1', 'c', sock('c')).admitted).toBe(false);
    // s2 has its own budget.
    expect(reg.register('s2', 'a', sock('a2')).admitted).toBe(true);
    expect(reg.liveCount('s2')).toBe(1);
  });
});
