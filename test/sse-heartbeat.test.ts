/**
 * SSE liveness heartbeat.
 *
 * `cleanupDeadClients()` runs every SSE_HEARTBEAT_INTERVAL (15s) and does two
 * jobs: evict clients whose socket died, and write a liveness frame to the
 * ones that are still up.
 *
 * The regression these guard: that frame used to be an SSE `:keepalive`
 * COMMENT, and comments are invisible to `EventSource` by spec. A stream that
 * stopped delivering without erroring was therefore undetectable to the
 * client: `onerror` never fired, the header dot stayed green, and every
 * SSE-driven surface froze until the user reloaded. A named `sse:heartbeat`
 * event reaches a listener, which is what lets the client's staleness
 * watchdog notice the silence (see test/sse-staleness.test.ts).
 *
 * No port needed (the manager is driven directly with fake replies).
 */
import type { FastifyReply } from 'fastify';
import { describe, it, expect } from 'vitest';
import { SSE_PADDING_SIZE } from '../src/config/server-timing.js';
import { SseEvent } from '../src/web/sse-events.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';
import { CleanupManager } from '../src/utils/index.js';

/** A FastifyReply stand-in that records every raw write. */
function fakeClient(opts: { destroyed?: boolean; writable?: boolean; throwOnAccess?: boolean } = {}) {
  const writes: string[] = [];
  const socket = { destroyed: opts.destroyed ?? false, writable: opts.writable ?? true };
  const raw = {
    get socket() {
      if (opts.throwOnAccess) throw new Error('socket gone');
      return socket;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
  return { reply: { raw } as unknown as FastifyReply, writes };
}

function makeManager() {
  const cleanup = new CleanupManager();
  const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  return { manager, cleanup };
}

describe('SSE liveness heartbeat', () => {
  it('writes a NAMED sse:heartbeat event, not an invisible comment', () => {
    const { manager, cleanup } = makeManager();
    const client = fakeClient();
    manager.addClient(client.reply, null, false);

    manager.cleanupDeadClients();

    expect(client.writes).toHaveLength(1);
    const frame = client.writes[0];
    // A comment (`:keepalive`) never reaches an EventSource listener, and that is
    // the entire bug. The frame must be a dispatchable named event.
    expect(frame.startsWith(':')).toBe(false);
    expect(frame).toMatch(/^event: sse:heartbeat\n/);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(SseEvent.Heartbeat).toBe('sse:heartbeat');
    cleanup.dispose();
  });

  it('carries a parseable epoch-ms payload', () => {
    const { manager, cleanup } = makeManager();
    const client = fakeClient();
    manager.addClient(client.reply, null, false);
    const before = Date.now();

    manager.cleanupDeadClients();

    const dataLine = client.writes[0].split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice('data: '.length)) as { t: number };
    expect(payload.t).toBeGreaterThanOrEqual(before);
    expect(payload.t).toBeLessThanOrEqual(Date.now());
    cleanup.dispose();
  });

  it('still appends Cloudflare tunnel padding when a tunnel is active', () => {
    const { manager, cleanup } = makeManager();
    const client = fakeClient();
    manager.addClient(client.reply, null, false);
    manager.setTunnelActive(true);

    manager.cleanupDeadClients();

    const frame = client.writes[0];
    expect(frame).toMatch(/^event: sse:heartbeat\n/);
    // Padding rides AFTER the terminating blank line, so the event still parses.
    const [event, padding] = frame.split('\n\n');
    expect(event).toMatch(/^event: sse:heartbeat\ndata: \{/);
    expect(padding.startsWith(':')).toBe(true);
    expect(padding.length).toBeGreaterThanOrEqual(SSE_PADDING_SIZE);
    cleanup.dispose();
  });

  it('sends no padding without a tunnel', () => {
    const { manager, cleanup } = makeManager();
    const client = fakeClient();
    manager.addClient(client.reply, null, false);

    manager.cleanupDeadClients();

    expect(client.writes[0].length).toBeLessThan(200);
    cleanup.dispose();
  });

  it('still evicts dead clients instead of heartbeating them', () => {
    const { manager, cleanup } = makeManager();
    const alive = fakeClient();
    const destroyed = fakeClient({ destroyed: true });
    const unwritable = fakeClient({ writable: false });
    const exploding = fakeClient({ throwOnAccess: true });
    for (const c of [alive, destroyed, unwritable, exploding]) manager.addClient(c.reply, null, false);
    expect(manager.clientCount).toBe(4);

    manager.cleanupDeadClients();

    expect(manager.clientCount).toBe(1);
    expect(alive.writes).toHaveLength(1);
    for (const c of [destroyed, unwritable, exploding]) expect(c.writes).toHaveLength(0);
    cleanup.dispose();
  });

  it('heartbeats every client on each pass', () => {
    const { manager, cleanup } = makeManager();
    const a = fakeClient();
    const b = fakeClient();
    manager.addClient(a.reply, null, false);
    manager.addClient(b.reply, null, false);

    manager.cleanupDeadClients();
    manager.cleanupDeadClients();

    // The frame carries no session data, so it needs no owner routing and is
    // written per-client rather than through the scoped broadcast() path.
    expect(a.writes).toHaveLength(2);
    expect(b.writes).toHaveLength(2);
    cleanup.dispose();
  });
});
