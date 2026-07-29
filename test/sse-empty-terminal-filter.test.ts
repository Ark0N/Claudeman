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

  it('suppresses a WebSocket-owned session and resumes it with targeted recovery', () => {
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, {} as CleanupManager);
    const writes: string[] = [];
    const reply = {
      raw: {
        write: (data: string) => {
          writes.push(data);
          return true;
        },
        once: () => {},
      },
    } as unknown as FastifyReply;
    const internals = manager as unknown as {
      terminalBatches: Map<string, string[]>;
      flushSessionTerminalBatch: (sessionId: string) => void;
    };

    manager.addClient(reply, new Set(['session-a']), false, 'page-client-a');
    manager.suspendClientSession('page-client-a', 'session-a');
    internals.terminalBatches.set('session-a', ['hidden while websocket owns output']);
    internals.flushSessionTerminalBatch('session-a');
    expect(writes).toEqual([]);

    manager.resumeClientSession('page-client-a', 'session-a', true);
    expect(writes.join('')).toContain('session:needsRefresh');

    writes.length = 0;
    internals.terminalBatches.set('session-a', ['visible after websocket handoff']);
    internals.flushSessionTerminalBatch('session-a');
    expect(writes.join('')).toContain('visible after websocket handoff');
  });

  it('coalesces contiguous cursor ranges into the terminal SSE event', () => {
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, {} as CleanupManager);
    const writes: string[] = [];
    const reply = {
      raw: {
        write: (data: string) => {
          writes.push(data);
          return true;
        },
        once: () => {},
      },
    } as unknown as FastifyReply;
    const internals = manager as unknown as {
      flushSessionTerminalBatch: (sessionId: string) => void;
    };

    manager.addClient(reply, new Set(['session-a']), false, 'cursor-client');
    manager.batchTerminalData('session-a', 'abc', {
      stream: 'stream-a',
      generation: 3,
      start: 10,
      end: 13,
    });
    manager.batchTerminalData('session-a', 'def', {
      stream: 'stream-a',
      generation: 3,
      start: 13,
      end: 16,
    });
    internals.flushSessionTerminalBatch('session-a');

    const dataLine = writes
      .join('')
      .split('\n')
      .find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    expect(JSON.parse(dataLine!.slice(6))).toMatchObject({
      id: 'session-a',
      data: expect.stringContaining('abcdef'),
      cursor: { stream: 'stream-a', generation: 3, start: 10, end: 16 },
    });
  });
});
