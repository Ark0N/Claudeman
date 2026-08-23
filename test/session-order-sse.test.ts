/** @fileoverview Trusted recipient selection for legacy session-order SSE compatibility. */
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SessionOrderProjectionChange } from '../src/tab-layout-service.js';
import { CleanupManager } from '../src/utils/index.js';
import { sessionOrderPayloadFor } from '../src/web/session-order-sse.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';

function changeWith(
  changedOwnerOrders: Record<string, string[]>,
  globalOrder: string[],
  globalChanged: boolean
): SessionOrderProjectionChange {
  return { changedOwnerOrders, globalOrder, globalChanged };
}

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

describe('legacy session-order SSE routing', () => {
  it('selects an owner slice for the matching regular user and nothing for another user', () => {
    const change = changeWith({ alice: ['a2', 'a1'] }, ['a2', 'b1', 'a1'], true);
    expect(sessionOrderPayloadFor({ username: 'alice', role: 'user' }, change)).toEqual({ order: ['a2', 'a1'] });
    expect(sessionOrderPayloadFor({ username: 'bob', role: 'user' }, change)).toBeUndefined();
  });

  it('does not treat inherited object properties as changed owner slices', () => {
    const change = changeWith({ alice: ['a1'] }, ['a1'], true);
    expect(sessionOrderPayloadFor({ username: 'constructor', role: 'user' }, change)).toBeUndefined();
  });

  it('selects the global projection for admins even when only interleaving changed', () => {
    const change = changeWith({}, ['b1', 'a1'], true);
    expect(sessionOrderPayloadFor({ username: 'admin', role: 'admin' }, change)).toEqual({ order: ['b1', 'a1'] });
  });

  it('uses the global projection for identity-less single-user clients', () => {
    const change = changeWith({ '@single': ['s2', 's1'] }, ['s2', 's1'], true);
    expect(sessionOrderPayloadFor(undefined, change)).toEqual({ order: ['s2', 's1'] });
  });

  it('delivers owner slices to every matching device, the global order to admins, and nothing to other users', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alicePhone = client();
    const aliceDesktop = client();
    const bob = client();
    const admin = client();
    manager.addClient(alicePhone.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(aliceDesktop.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    manager.broadcastSessionOrder(changeWith({ alice: ['a2', 'a1'] }, ['a2', 'b1', 'a1'], true));

    const ownerFrame = 'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n';
    expect(alicePhone.writes).toEqual([ownerFrame]);
    expect(aliceDesktop.writes).toEqual([ownerFrame]);
    expect(bob.writes).toEqual([]);
    expect(admin.writes).toEqual(['event: session:orderChanged\ndata: {"order":["a2","b1","a1"]}\n\n']);
    cleanup.dispose();
  });

  it('delivers a global-only interleaving change to admins only', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = client();
    const admin = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    manager.broadcastSessionOrder(changeWith({}, ['b1', 'a1'], true));

    expect(alice.writes).toEqual([]);
    expect(admin.writes).toEqual(['event: session:orderChanged\ndata: {"order":["b1","a1"]}\n\n']);
    cleanup.dispose();
  });

  it.each([
    {
      label: 'order-only repair',
      change: changeWith({ alice: ['a', 'b'] }, ['a', 'bob-1', 'b'], true),
      ownerOrder: ['a', 'b'],
      globalOrder: ['a', 'bob-1', 'b'],
    },
    {
      label: 'legacy-only deletion',
      change: changeWith({ alice: [] }, ['bob-1'], true),
      ownerOrder: [],
      globalOrder: ['bob-1'],
    },
  ])('delivers an $label correction to same-owner devices and admins only', ({ change, ownerOrder, globalOrder }) => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alicePhone = client();
    const aliceDesktop = client();
    const bob = client();
    const admin = client();
    manager.addClient(alicePhone.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(aliceDesktop.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    manager.broadcastSessionOrder(change);

    const ownerFrame = `event: session:orderChanged\ndata: ${JSON.stringify({ order: ownerOrder })}\n\n`;
    expect(alicePhone.writes).toEqual([ownerFrame]);
    expect(aliceDesktop.writes).toEqual([ownerFrame]);
    expect(bob.writes).toEqual([]);
    expect(admin.writes).toEqual([`event: session:orderChanged\ndata: ${JSON.stringify({ order: globalOrder })}\n\n`]);
    cleanup.dispose();
  });

  it('skips an inherited-key username without starving later matching and admin recipients', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const constructorUser = client();
    const alice = client();
    const admin = client();
    manager.addClient(constructorUser.reply, null, false, undefined, { username: 'constructor', role: 'user' });
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    expect(() => manager.broadcastSessionOrder(changeWith({ alice: ['a1'] }, ['a1'], true))).not.toThrow();

    expect(constructorUser.writes).toEqual([]);
    expect(alice.writes).toEqual(['event: session:orderChanged\ndata: {"order":["a1"]}\n\n']);
    expect(admin.writes).toEqual(['event: session:orderChanged\ndata: {"order":["a1"]}\n\n']);
    cleanup.dispose();
  });

  it('coalesces the latest filtered owner order while backpressured and flushes it on drain', () => {
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
    for (const writes of [blockedAlice.writes, liveAlice.writes, bob.writes, admin.writes]) writes.length = 0;

    manager.broadcastSessionOrder(changeWith({ alice: ['a2', 'a1'] }, ['a2', 'b1', 'a1'], true));
    manager.broadcastSessionOrder(changeWith({ alice: ['a1', 'a2'] }, ['b1', 'a1', 'a2'], true));

    expect(blockedAlice.writes).toEqual([]);
    expect(liveAlice.writes).toEqual([
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
      'event: session:orderChanged\ndata: {"order":["a1","a2"]}\n\n',
    ]);
    expect(bob.writes).toEqual([]);
    expect(admin.writes).toEqual([
      'event: session:orderChanged\ndata: {"order":["a2","b1","a1"]}\n\n',
      'event: session:orderChanged\ndata: {"order":["b1","a1","a2"]}\n\n',
    ]);

    blockedAlice.drain();

    expect(blockedAlice.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: session:orderChanged\ndata: {"order":["a1","a2"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('clears a queued owner order when a backpressured client disconnects', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = backpressuredClient();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.broadcast('test:prime-backpressure', {}, { username: 'alice' });
    alice.writes.length = 0;
    manager.broadcastSessionOrder(changeWith({ alice: ['a2', 'a1'] }, ['a2', 'a1'], true));

    manager.removeClient(alice.reply);
    alice.drain();

    expect(alice.writes).toEqual([]);
    cleanup.dispose();
  });

  it('isolates a drain write failure from later healthy recipients', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const brokenAlice = backpressuredClient({ throwAfterBackpressure: true });
    const liveAlice = client();
    const admin = client();
    manager.addClient(brokenAlice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(liveAlice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.broadcast('test:prime-backpressure', {}, { username: 'alice' });
    brokenAlice.writes.length = 0;
    liveAlice.writes.length = 0;
    admin.writes.length = 0;
    manager.broadcastSessionOrder(changeWith({ alice: ['a2', 'a1'] }, ['a2', 'a1'], true));

    expect(() => brokenAlice.drain()).not.toThrow();
    expect(manager.clientCount).toBe(2);

    manager.broadcastSessionOrder(changeWith({ alice: ['a1', 'a2'] }, ['a1', 'a2'], true));
    expect(liveAlice.writes.at(-1)).toBe('event: session:orderChanged\ndata: {"order":["a1","a2"]}\n\n');
    expect(admin.writes.at(-1)).toBe('event: session:orderChanged\ndata: {"order":["a1","a2"]}\n\n');
    cleanup.dispose();
  });
});
