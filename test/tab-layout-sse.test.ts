/** @fileoverview Minimal tab-layout SSE payload routing to owner plus admins. */
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SessionOrderProjectionChange } from '../src/tab-layout-service.js';
import { CleanupManager } from '../src/utils/index.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';
import { deriveTabLayoutSseHint } from '../src/web/tab-layout-sse.js';

function client() {
  const writes: string[] = [];
  return {
    writes,
    reply: { raw: { write: (chunk: string) => (writes.push(chunk), true) } } as unknown as FastifyReply,
  };
}

function backpressuredClient(options: { throwAfterBackpressure?: boolean } = {}) {
  const writes: string[] = [];
  let firstWrite = true;
  let onDrain: (() => void) | undefined;
  const raw = {
    write(chunk: string) {
      if (!firstWrite && options.throwAfterBackpressure) throw new Error('client disconnected');
      writes.push(chunk);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    },
    once(event: string, callback: () => void) {
      if (event === 'drain') onDrain = callback;
      return raw;
    },
  };
  return {
    writes,
    reply: { raw } as unknown as FastifyReply,
    drain: () => {
      const callback = onDrain;
      onDrain = undefined;
      callback?.();
    },
  };
}

function scriptedBackpressuredClient(outcomes: Array<boolean | Error>) {
  const writes: string[] = [];
  let onDrain: (() => void) | undefined;
  const raw = {
    write(chunk: string) {
      const outcome = outcomes.shift() ?? true;
      if (outcome instanceof Error) throw outcome;
      writes.push(chunk);
      return outcome;
    },
    once(event: string, callback: () => void) {
      if (event === 'drain') onDrain = callback;
      return raw;
    },
  };
  return {
    writes,
    reply: { raw } as unknown as FastifyReply,
    drain: () => {
      const callback = onDrain;
      onDrain = undefined;
      callback?.();
    },
  };
}

const orderChange = (order: string[]): SessionOrderProjectionChange => ({
  changedOwnerOrders: { alice: order },
  globalOrder: order,
  globalChanged: true,
});

describe('tab layout SSE routing', () => {
  it('derives an exact owner hint with fail-closed session scoping', () => {
    expect(deriveTabLayoutSseHint({ owner: 'alice', version: 4 })).toEqual({
      username: 'alice',
      sessionScoped: true,
    });
  });

  it('delivers the minimal event to the owner and admins, but not another user', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = client();
    const bob = client();
    const admin = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    const payload = { owner: 'alice', version: 4 };
    manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));

    expect(alice.writes).toEqual(['event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n']);
    expect(admin.writes).toEqual(alice.writes);
    expect(bob.writes).toEqual([]);
    cleanup.dispose();
  });

  it('coalesces repeated layout invalidations and drains refresh, layout, then legacy order', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const blockedAlice = backpressuredClient();
    const liveAlice = client();
    const bob = client();
    const admin = client();
    manager.addClient(blockedAlice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(liveAlice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    manager.broadcast('test:prime-backpressure', {}, { username: 'alice' });
    for (const target of [blockedAlice.writes, liveAlice.writes, bob.writes, admin.writes]) target.length = 0;

    const first = { owner: 'alice', version: 4 };
    const latest = { owner: 'alice', version: 5 };
    manager.broadcast('tab:layoutChanged', first, deriveTabLayoutSseHint(first));
    manager.broadcast('tab:layoutChanged', latest, deriveTabLayoutSseHint(latest));
    manager.broadcastSessionOrder(orderChange(['a2', 'a1']));

    expect(blockedAlice.writes).toEqual([]);
    expect(liveAlice.writes).toEqual([
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    expect(bob.writes).toEqual([]);
    expect(admin.writes).toEqual(liveAlice.writes);

    blockedAlice.drain();

    expect(blockedAlice.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('retains the latest invalidation for every admin-visible owner while isolating regular users', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const blockedAlice = backpressuredClient();
    const blockedAdmin = backpressuredClient();
    const liveAlice = client();
    const liveAdmin = client();
    const bob = client();
    manager.addClient(blockedAlice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(blockedAdmin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.addClient(liveAlice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(liveAdmin.reply, null, false, undefined, { username: 'ops', role: 'admin' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });

    manager.broadcast('test:prime-admin', {}, { adminOnly: true });
    manager.broadcast('test:prime-alice', {}, { username: 'alice' });
    for (const target of [blockedAlice.writes, blockedAdmin.writes, liveAlice.writes, liveAdmin.writes, bob.writes]) {
      target.length = 0;
    }

    const alice4 = { owner: 'alice', version: 4 };
    const bob8 = { owner: 'bob', version: 8 };
    const alice5 = { owner: 'alice', version: 5 };
    const prototype9 = { owner: 'constructor', version: 9 };
    for (const payload of [alice4, bob8, alice5, prototype9]) {
      manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));
    }
    const change = orderChange(['a2', 'a1']);
    manager.broadcastSessionOrder(change);

    blockedAdmin.drain();
    blockedAlice.drain();

    expect(blockedAdmin.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"bob","version":8}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"constructor","version":9}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    expect(blockedAlice.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    expect(liveAlice.writes).toEqual([
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    expect(bob.writes).toEqual(['event: tab:layoutChanged\ndata: {"owner":"bob","version":8}\n\n']);
    expect(liveAdmin.writes).toEqual([
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"bob","version":8}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"constructor","version":9}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('retains later owners and the final order when a layout recovery write re-enters backpressure', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const admin = scriptedBackpressuredClient([false, true, false, true, true, true]);
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.broadcast('test:prime-backpressure', {}, { adminOnly: true });
    admin.writes.length = 0;

    const alice = { owner: 'alice', version: 5 };
    const bob = { owner: 'bob', version: 8 };
    manager.broadcast('tab:layoutChanged', alice, deriveTabLayoutSseHint(alice));
    manager.broadcast('tab:layoutChanged', bob, deriveTabLayoutSseHint(bob));
    manager.broadcastSessionOrder(orderChange(['a2', 'a1']));

    admin.drain();
    expect(admin.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
    ]);

    admin.drain();
    expect(admin.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"bob","version":8}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('drops remaining recovery state after a partial layout write failure without affecting healthy clients', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const brokenAdmin = scriptedBackpressuredClient([false, true, true, new Error('client disconnected')]);
    const liveAdmin = client();
    manager.addClient(brokenAdmin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.addClient(liveAdmin.reply, null, false, undefined, { username: 'ops', role: 'admin' });
    manager.broadcast('test:prime-backpressure', {}, { adminOnly: true });
    brokenAdmin.writes.length = 0;
    liveAdmin.writes.length = 0;

    const alice = { owner: 'alice', version: 5 };
    const bob = { owner: 'bob', version: 8 };
    manager.broadcast('tab:layoutChanged', alice, deriveTabLayoutSseHint(alice));
    manager.broadcast('tab:layoutChanged', bob, deriveTabLayoutSseHint(bob));
    manager.broadcastSessionOrder(orderChange(['a2', 'a1']));

    expect(() => brokenAdmin.drain()).not.toThrow();

    expect(brokenAdmin.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
    ]);
    expect(manager.clientCount).toBe(1);
    expect(liveAdmin.writes).toEqual([
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"bob","version":8}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('clears a queued layout invalidation on disconnect and ignores its stale drain callback', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = backpressuredClient();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.broadcast('test:prime-backpressure', {}, { username: 'alice' });
    alice.writes.length = 0;

    const payload = { owner: 'alice', version: 4 };
    manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));
    manager.removeClient(alice.reply);
    alice.drain();

    expect(alice.writes).toEqual([]);
    expect(manager.clientCount).toBe(0);
    cleanup.dispose();
  });

  it('clears a queued layout invalidation when drain recovery fails', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = backpressuredClient({ throwAfterBackpressure: true });
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.broadcast('test:prime-backpressure', {}, { username: 'alice' });
    alice.writes.length = 0;

    const payload = { owner: 'alice', version: 4 };
    manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));
    expect(() => alice.drain()).not.toThrow();
    alice.drain();

    expect(alice.writes).toEqual([]);
    expect(manager.clientCount).toBe(0);
    cleanup.dispose();
  });
});
