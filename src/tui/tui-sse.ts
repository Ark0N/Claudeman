/**
 * @fileoverview Pure SSE wire parsing, event classification and reconnect math.
 *
 * Node has no `EventSource`, so the TUI reads `GET /api/events` as a raw stream
 * and decodes the wire format here. Everything in this module is pure: bytes
 * (as decoded strings) in, frames out. The socket, the timers and the backoff
 * loop live in `tui-client.ts`.
 *
 * Three wire details this parser exists to get right:
 *
 * 1. **Frames split across chunk boundaries.** A TCP read can end anywhere,
 *    including between the `\r` and the `\n` of a CRLF, so a lone trailing
 *    `\r` is held back rather than treated as a line end.
 * 2. **Comments are not frames.** The server appends a `:pppp…` padding line
 *    after a frame while a Cloudflare tunnel is up (it flushes the proxy
 *    buffer) and that line carries no blank line after it. Dispatch happens on
 *    a blank line and on nothing else, so padding cannot split a frame.
 * 3. **The keepalive is a NAMED event** (`sse:heartbeat`), because an SSE
 *    comment is invisible to a browser `EventSource` by spec. We treat ANY
 *    inbound bytes as liveness, comments included, which is why comments need
 *    no representation in the returned frames.
 *
 * @module tui/tui-sse
 */

import {
  ApprovalPending,
  ApprovalResolved,
  ApprovalUpdated,
  Heartbeat,
  Init,
  MuxCreated,
  MuxDied,
  MuxKilled,
  RemoteSessionDropped,
  RemoteSessionReconnected,
  SessionCliInfo,
  SessionCompletion,
  SessionCreated,
  SessionDeleted,
  SessionError,
  SessionExit,
  SessionIdle,
  SessionInteractive,
  SessionPinned,
  SessionRunning,
  SessionStatusTelemetry,
  SessionUpdated,
  SessionWorking,
} from '../web/sse-events.js';

/** One dispatched SSE frame. `event` defaults to `message` per the spec. */
export interface SseFrame {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Ceiling on the unterminated tail the parser will hold. The `init` frame
 * carries the whole light state and is legitimately large, so this is not a
 * frame-size limit but a guard against a non-SSE endpoint streaming something
 * with no line terminators at all.
 */
export const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** Incremental decoder. One instance per connection; `reset()` on reconnect. */
export class SseFrameParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  private lastId: string | undefined;
  private retry: number | undefined;

  /** Decode one chunk, returning every frame it completed (possibly none). */
  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let start = 0;

    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // A trailing CR may be the first half of a CRLF the next chunk finishes.
      if (ch === '\r' && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, i);
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
      const frame = this.consumeLine(line);
      if (frame) frames.push(frame);
    }

    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > MAX_PENDING_BYTES) this.reset();
    return frames;
  }

  /** Drop every partial frame. Called when a connection is torn down. */
  reset(): void {
    this.buffer = '';
    this.eventName = '';
    this.dataLines = [];
    this.lastId = undefined;
    this.retry = undefined;
  }

  private consumeLine(line: string): SseFrame | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        this.lastId = value;
        break;
      case 'retry': {
        const ms = Number.parseInt(value, 10);
        if (Number.isSafeInteger(ms) && ms >= 0) this.retry = ms;
        break;
      }
      default:
        break;
    }
    return null;
  }

  /**
   * A blank line ends a frame. Per the spec an empty data buffer dispatches
   * nothing (it still clears the event name), which is what makes a bare
   * `event:` line or a stray blank line harmless.
   */
  private dispatch(): SseFrame | null {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return null;
    }
    const frame: SseFrame = {
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
    };
    if (this.lastId !== undefined) frame.id = this.lastId;
    if (this.retry !== undefined) frame.retry = this.retry;
    this.eventName = '';
    this.dataLines = [];
    return frame;
  }
}

/** What the app layer should do with a frame. */
export type SseEventClass = 'init' | 'heartbeat' | 'resync' | 'approval' | 'plan-usage' | 'ignore';

/**
 * Events that change WHICH sessions exist or WHAT state they are in.
 *
 * The TUI never patches a single row from a payload: it re-fetches the unified
 * list, which is the only source that also carries history rows, so this set
 * only has to answer "is a refetch worth it". `session:terminal` is
 * deliberately absent (it is the bulk of the stream and the preview pane pulls
 * its own tail), as are the ralph/respawn/subagent/orchestrator families, which
 * change nothing the dashboard draws.
 */
const RESYNC_EVENTS: ReadonlySet<string> = new Set<string>([
  SessionCreated,
  SessionUpdated,
  SessionDeleted,
  SessionExit,
  SessionError,
  SessionIdle,
  SessionWorking,
  SessionCompletion,
  SessionInteractive,
  SessionRunning,
  SessionPinned,
  SessionCliInfo,
  MuxCreated,
  MuxKilled,
  MuxDied,
  RemoteSessionDropped,
  RemoteSessionReconnected,
]);

const APPROVAL_EVENTS: ReadonlySet<string> = new Set<string>([ApprovalPending, ApprovalUpdated, ApprovalResolved]);

/** Which approval event this is, or null when the name is not one. */
export function approvalEventKind(name: string): 'pending' | 'updated' | 'resolved' | null {
  if (name === ApprovalPending) return 'pending';
  if (name === ApprovalUpdated) return 'updated';
  if (name === ApprovalResolved) return 'resolved';
  return null;
}

/** Route one event name. Unknown names are ignored, never a resync. */
export function classifySseEvent(name: string): SseEventClass {
  if (name === Init) return 'init';
  if (name === Heartbeat) return 'heartbeat';
  if (APPROVAL_EVENTS.has(name)) return 'approval';
  if (name === SessionStatusTelemetry) return 'plan-usage';
  if (RESYNC_EVENTS.has(name)) return 'resync';
  return 'ignore';
}

/**
 * Silence that means the stream is dead even though the socket never errored.
 * The server heartbeats every 15s, so three missed beats is the signal.
 */
export const SSE_STALE_TIMEOUT_MS = 45_000;

/** Reconnect delay ceiling. A local server is back in milliseconds, not minutes. */
export const SSE_MAX_BACKOFF_MS = 15_000;

/** First reconnect delay; doubles per consecutive failure up to the ceiling. */
export const SSE_BASE_BACKOFF_MS = 500;

/**
 * Delay before reconnect attempt `attempt` (1-based). Deterministic, with no
 * jitter on purpose: one client talks to one loopback server, so there is no
 * herd to spread out and a reproducible delay is testable.
 */
export function sseBackoffDelay(attempt: number, base = SSE_BASE_BACKOFF_MS, max = SSE_MAX_BACKOFF_MS): number {
  const step = Math.max(1, Math.trunc(attempt));
  const exponent = Math.min(step - 1, 30);
  return Math.min(max, base * 2 ** exponent);
}
