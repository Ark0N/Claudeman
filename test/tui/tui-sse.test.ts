/**
 * @fileoverview Unit tests for the TUI's SSE wire decoding and reconnect math.
 *
 * The frames here are byte-for-byte what `sse-stream-manager.ts` writes
 * (`event: <name>\ndata: <json>\n\n`, plus the `:pppp…` tunnel padding line),
 * so a change to the server's writer breaks these tests rather than the
 * dashboard.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_PENDING_BYTES,
  SSE_MAX_BACKOFF_MS,
  SseFrameParser,
  approvalEventKind,
  classifySseEvent,
  sseBackoffDelay,
} from '../../src/tui/tui-sse.js';

/** Feed a whole stream one character at a time: every boundary is a split. */
function feedByChar(parser: SseFrameParser, text: string) {
  const frames = [];
  for (const ch of text) frames.push(...parser.feed(ch));
  return frames;
}

describe('SseFrameParser', () => {
  it('decodes a plain named frame', () => {
    const frames = new SseFrameParser().feed('event: session:created\ndata: {"id":"a"}\n\n');
    expect(frames).toEqual([{ event: 'session:created', data: '{"id":"a"}' }]);
  });

  it('defaults the event name to message', () => {
    expect(new SseFrameParser().feed('data: hello\n\n')).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('survives a frame split across every possible chunk boundary', () => {
    const parser = new SseFrameParser();
    const frames = feedByChar(
      parser,
      'event: session:updated\ndata: {"id":"b","n":1}\n\nevent: sse:heartbeat\ndata: {}\n\n'
    );
    expect(frames).toEqual([
      { event: 'session:updated', data: '{"id":"b","n":1}' },
      { event: 'sse:heartbeat', data: '{}' },
    ]);
  });

  it('joins multi-line data with newlines and strips one leading space per line', () => {
    const frames = new SseFrameParser().feed('event: x\ndata: line one\ndata: line two\ndata:  indented\n\n');
    expect(frames).toEqual([{ event: 'x', data: 'line one\nline two\n indented' }]);
  });

  it('ignores comments, including the tunnel padding that trails a frame', () => {
    const parser = new SseFrameParser();
    const padding = ':' + 'p'.repeat(64) + '\n';
    const frames = parser.feed(`event: a\ndata: 1\n\n${padding}event: b\ndata: 2\n\n`);
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('handles CRLF, including a CR that lands at the end of a chunk', () => {
    const parser = new SseFrameParser();
    expect(parser.feed('event: a\r')).toEqual([]);
    expect(parser.feed('\ndata: 1\r\n\r\n')).toEqual([{ event: 'a', data: '1' }]);
  });

  it('treats a bare CR as a line end, once a following byte proves it is not half a CRLF', () => {
    const parser = new SseFrameParser();
    expect(parser.feed('event: a\rdata: 1\r\r')).toEqual([]);
    expect(parser.feed('event: b\rdata: 2\r\r\n')).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('dispatches nothing for a frame with no data, and clears the event name', () => {
    const parser = new SseFrameParser();
    expect(parser.feed('event: a\n\n')).toEqual([]);
    expect(parser.feed('data: 1\n\n')).toEqual([{ event: 'message', data: '1' }]);
  });

  it('carries id and retry when the server sends them', () => {
    const frames = new SseFrameParser().feed('id: 7\nretry: 2500\nevent: a\ndata: 1\n\n');
    expect(frames).toEqual([{ event: 'a', data: '1', id: '7', retry: 2500 }]);
  });

  it('accepts a field with no colon at all', () => {
    // Per spec `data` alone means an empty data line, which still dispatches.
    expect(new SseFrameParser().feed('data\n\n')).toEqual([{ event: 'message', data: '' }]);
  });

  it('drops a partial frame on reset so a reconnect cannot splice two streams', () => {
    const parser = new SseFrameParser();
    parser.feed('event: a\ndata: half');
    parser.reset();
    expect(parser.feed('data: whole\n\n')).toEqual([{ event: 'message', data: 'whole' }]);
  });

  it('discards a pending tail that grows past the guard', () => {
    const parser = new SseFrameParser();
    parser.feed('x'.repeat(MAX_PENDING_BYTES + 1));
    expect(parser.feed('data: after\n\n')).toEqual([{ event: 'message', data: 'after' }]);
  });
});

describe('classifySseEvent', () => {
  it('routes the events the dashboard reacts to', () => {
    expect(classifySseEvent('init')).toBe('init');
    expect(classifySseEvent('sse:heartbeat')).toBe('heartbeat');
    expect(classifySseEvent('approval:pending')).toBe('approval');
    expect(classifySseEvent('approval:resolved')).toBe('approval');
    expect(classifySseEvent('session:statusTelemetry')).toBe('plan-usage');
    expect(classifySseEvent('session:created')).toBe('resync');
    expect(classifySseEvent('session:deleted')).toBe('resync');
    expect(classifySseEvent('mux:died')).toBe('resync');
  });

  it('ignores the high-volume and irrelevant families', () => {
    // session:terminal is most of the stream and the preview pulls its own tail.
    expect(classifySseEvent('session:terminal')).toBe('ignore');
    expect(classifySseEvent('respawn:log')).toBe('ignore');
    expect(classifySseEvent('subagent:progress')).toBe('ignore');
    expect(classifySseEvent('something:invented')).toBe('ignore');
  });
});

describe('approvalEventKind', () => {
  it('names the three approval events and nothing else', () => {
    expect(approvalEventKind('approval:pending')).toBe('pending');
    expect(approvalEventKind('approval:updated')).toBe('updated');
    expect(approvalEventKind('approval:resolved')).toBe('resolved');
    expect(approvalEventKind('session:created')).toBeNull();
  });
});

describe('sseBackoffDelay', () => {
  it('doubles from the base and stops at the ceiling', () => {
    expect(sseBackoffDelay(1)).toBe(500);
    expect(sseBackoffDelay(2)).toBe(1000);
    expect(sseBackoffDelay(3)).toBe(2000);
    expect(sseBackoffDelay(6)).toBe(15_000);
    expect(sseBackoffDelay(50)).toBe(SSE_MAX_BACKOFF_MS);
  });

  it('treats a zero or negative attempt as the first one', () => {
    expect(sseBackoffDelay(0)).toBe(500);
    expect(sseBackoffDelay(-4)).toBe(500);
  });
});
