import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { CleanupManager } from '../src/utils/index.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';

describe('SseStreamManager empty terminal filter', () => {
  it('treats an empty session list as receive-none and null as receive-all', () => {
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, {} as CleanupManager);
    const reply = {
      raw: {
        write: () => true,
        once: () => {},
      },
    } as unknown as FastifyReply;

    manager.addClient(reply, null, false, 'client-filter-test');

    expect(manager.updateClientFilter('client-filter-test', [])).toBe(true);
    expect((manager as unknown as { sseClients: Map<FastifyReply, Set<string> | null> }).sseClients.get(reply)).toEqual(
      new Set()
    );

    expect(manager.updateClientFilter('client-filter-test', null)).toBe(true);
    expect(
      (manager as unknown as { sseClients: Map<FastifyReply, Set<string> | null> }).sseClients.get(reply)
    ).toBeNull();
  });
});
