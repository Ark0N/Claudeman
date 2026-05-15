/**
 * @fileoverview SSE stream manager — owns all SSE client state, broadcasting, and event batching.
 *
 * Extracted from server.ts for modularity. Handles:
 * - SSE client connection tracking with subscription filtering
 * - Backpressure-aware message delivery
 * - Terminal data batching with adaptive intervals (16-50ms for 60fps)
 * - Task update and session state batching
 * - Dead client cleanup and keepalive
 * - Cloudflare tunnel padding for proxy buffer flushing
 *
 * @dependencies CleanupManager (managed timers), config/server-timing (constants)
 * @consumedby web/server.ts (WebServer delegates all SSE operations here)
 *
 * @module web/sse-stream-manager
 */

import type { FastifyReply } from 'fastify';
import type { BackgroundTask } from '../session.js';
import { CleanupManager, StaleExpirationMap } from '../utils/index.js';
import { SseEvent } from './sse-events.js';
import {
  TERMINAL_BATCH_INTERVAL,
  TASK_UPDATE_BATCH_INTERVAL,
  STATE_UPDATE_DEBOUNCE_INTERVAL,
  BATCH_FLUSH_THRESHOLD,
  SSE_PADDING_SIZE,
  INACTIVITY_TIMEOUT_MS,
} from '../config/server-timing.js';

// SSE padding for Cloudflare tunnel buffer flushing.
// Cloudflare quick tunnels buffer small SSE responses, causing lag for real-time events.
// Appending SSE comment padding (ignored by EventSource) forces the proxy to flush.
// Pre-computed once at startup to avoid repeated string allocation.
const SSE_PADDING = ':' + 'p'.repeat(SSE_PADDING_SIZE) + '\n';

/** Dependencies injected by WebServer — keeps SseStreamManager decoupled from session/respawn state. */
interface SseStreamManagerDeps {
  /** Get session state with respawn info for session:updated broadcasts */
  getSessionStateWithRespawn(sessionId: string): unknown;
}

export class SseStreamManager {
  // ─── SSE Client Tracking ────────────────────────────────
  /**
   * SSE clients mapped to their session subscription filter.
   * Value is a Set of session IDs the client wants events for,
   * or `null` meaning "receive all events" (backwards-compatible default).
   */
  private sseClients: Map<FastifyReply, Set<string> | null> = new Map();
  /** Optional client-supplied IDs → reply, for live filter updates without reconnecting */
  private sseClientsById: Map<string, FastifyReply> = new Map();
  /** SSE clients connecting from non-localhost (i.e. through tunnel) */
  private remoteSseClients: Set<FastifyReply> = new Set();
  /** Clients with backpressure — skip writes until 'drain' fires */
  private backpressuredClients: Set<FastifyReply> = new Set();

  // ─── Tunnel State ───────────────────────────────────────
  /** Cached tunnel active state — updated on TunnelStarted/TunnelStopped to avoid getUrl() on every broadcast */
  private _isTunnelActive: boolean = false;

  // ─── Terminal Batching ──────────────────────────────────
  private terminalBatches: Map<string, string[]> = new Map();
  private terminalBatchSizes: Map<string, number> = new Map(); // Running total avoids O(n) reduce per push
  private terminalBatchTimers: Map<string, NodeJS.Timeout> = new Map(); // Per-session timers (staggered flushes)
  // Adaptive batching: track rapid events to extend batch window (per-session)
  // StaleExpirationMap auto-cleans entries for sessions that stop generating output
  private lastTerminalEventTime: StaleExpirationMap<string, number>;

  // ─── Event Batching ─────────────────────────────────────
  private taskUpdateBatches: Map<string, { sessionId: string; task: BackgroundTask }> = new Map();
  private taskUpdateBatchTimerId: string | null = null;
  // State update batching (reduce expensive toDetailedState() serialization)
  private stateUpdatePending: Set<string> = new Set();
  private stateUpdateTimerId: string | null = null;

  // ─── Lifecycle ──────────────────────────────────────────
  private _isStopping: boolean = false;

  constructor(
    private deps: SseStreamManagerDeps,
    private cleanup: CleanupManager
  ) {
    this.lastTerminalEventTime = new StaleExpirationMap({
      ttlMs: INACTIVITY_TIMEOUT_MS, // 5 minutes - auto-expire stale session timing data
      refreshOnGet: false, // Don't refresh on reads, only on explicit sets
    });
  }

  // ========== SSE Connection Management ==========

  get clientCount(): number {
    return this.sseClients.size;
  }

  get remoteClientCount(): number {
    return this.remoteSseClients.size;
  }

  get isTunnelActive(): boolean {
    return this._isTunnelActive;
  }

  setTunnelActive(active: boolean): void {
    this._isTunnelActive = active;
  }

  addClient(reply: FastifyReply, sessionFilter: Set<string> | null, isRemote: boolean, clientId?: string): void {
    this.sseClients.set(reply, sessionFilter);
    if (isRemote) {
      this.remoteSseClients.add(reply);
    }
    if (clientId) {
      // If a previous reply registered the same id (reconnect), drop the old one.
      const prev = this.sseClientsById.get(clientId);
      if (prev && prev !== reply) {
        this.sseClients.delete(prev);
        this.remoteSseClients.delete(prev);
        this.backpressuredClients.delete(prev);
      }
      this.sseClientsById.set(clientId, reply);
    }
  }

  removeClient(reply: FastifyReply): void {
    this.sseClients.delete(reply);
    this.remoteSseClients.delete(reply);
    this.backpressuredClients.delete(reply);
    // Clear any clientId mappings pointing at this reply
    for (const [id, r] of this.sseClientsById) {
      if (r === reply) this.sseClientsById.delete(id);
    }
  }

  /**
   * Update an existing client's session subscription filter without forcing
   * an SSE reconnect. Returns true if the client was found and updated.
   */
  updateClientFilter(clientId: string, sessions: string[] | null): boolean {
    const reply = this.sseClientsById.get(clientId);
    if (!reply || !this.sseClients.has(reply)) return false;
    const filter = sessions && sessions.length > 0 ? new Set(sessions) : null;
    this.sseClients.set(reply, filter);
    return true;
  }

  /** Send a single SSE event to a specific client. */
  sendSSE(reply: FastifyReply, event: string, data: unknown): void {
    try {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.sseClients.delete(reply);
      this.remoteSseClients.delete(reply);
    }
  }

  /** Send pre-formatted tunnel padding to a specific client. */
  sendPadding(reply: FastifyReply): void {
    if (!this._isTunnelActive) return;
    try {
      reply.raw.write(SSE_PADDING);
    } catch {
      /* client gone */
    }
  }

  // Optimized: send pre-formatted SSE message to a client
  // Returns false if client is backpressured or dead
  private sendSSEPreformatted(reply: FastifyReply, message: string): void {
    // Skip backpressured clients to prevent unbounded memory growth.
    // Terminal data dropped here is recovered via session:needsRefresh on drain.
    if (this.backpressuredClients.has(reply)) return;

    try {
      const ok = reply.raw.write(message);
      if (!ok) {
        // Buffer is full — mark as backpressured, resume on drain
        this.backpressuredClients.add(reply);
        reply.raw.once('drain', () => {
          this.backpressuredClients.delete(reply);
          // Client may have missed terminal data during backpressure.
          // Tell it to reload the active session's buffer to recover.
          try {
            const drainPadding = this._isTunnelActive ? SSE_PADDING : '';
            reply.raw.write(`event: ${SseEvent.SessionNeedsRefresh}\ndata: {}\n\n${drainPadding}`);
          } catch {
            /* client gone */
          }
        });
      }
    } catch {
      this.sseClients.delete(reply);
      this.remoteSseClients.delete(reply);
      this.backpressuredClients.delete(reply);
    }
  }

  // ========== Broadcasting ==========

  broadcast(event: string, data: unknown): void {
    // Skip serialization entirely when no clients are listening
    if (this.sseClients.size === 0) return;

    // Performance optimization: serialize JSON once for all clients.
    // Only append Cloudflare tunnel padding for latency-sensitive events —
    // Recovery events need immediate proxy flush; low-frequency metadata events
    // (session:created, ralph:*, respawn:*, etc.) don't need padding.
    // Note: session:terminal has its own padding in flushSessionTerminalBatch().
    const needsPadding = this._isTunnelActive && event === SseEvent.SessionNeedsRefresh;
    const padding = needsPadding ? SSE_PADDING : '';
    let message: string;
    try {
      message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` + padding;
    } catch (err) {
      // Handle circular references or non-serializable values
      console.error(`[Server] Failed to serialize SSE event "${event}":`, err);
      return;
    }
    // Subscription filtering is intentionally NOT applied here. The
    // `?sessions=` filter is intended to suppress only the high-volume
    // terminal stream — lifecycle/metadata events (session:created,
    // session:updated, ralph:*, hook:*, etc.) are needed for correct UI
    // state across all sessions even when the client subscribes to a single
    // active session's terminal output. Terminal events bypass this method
    // entirely (see flushSessionTerminalBatch — it applies the filter).
    for (const [client] of this.sseClients) {
      this.sendSSEPreformatted(client, message);
    }
  }

  // ========== Terminal Data Batching ==========

  // Batch terminal data for better performance (60fps)
  // Uses per-session timers with adaptive intervals to prevent thundering herd:
  // each session flushes independently rather than all sessions flushing in one burst.
  batchTerminalData(sessionId: string, data: string): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    let chunks = this.terminalBatches.get(sessionId);
    if (!chunks) {
      chunks = [];
      this.terminalBatches.set(sessionId, chunks);
    }
    chunks.push(data);
    const prevSize = this.terminalBatchSizes.get(sessionId) ?? 0;
    const totalLength = prevSize + data.length;
    this.terminalBatchSizes.set(sessionId, totalLength);

    // Adaptive batching: detect rapid events and extend batch window (per-session)
    const now = Date.now();
    const lastEvent = this.lastTerminalEventTime.get(sessionId) ?? 0;
    const eventGap = now - lastEvent;
    this.lastTerminalEventTime.set(sessionId, now);

    // Adjust batch interval based on event frequency (per-session)
    // Rapid events (<10ms gap) = 50ms batch, moderate (<20ms) = 32ms, else 16ms
    let sessionInterval: number;
    if (eventGap > 0 && eventGap < 10) {
      sessionInterval = 50;
    } else if (eventGap > 0 && eventGap < 20) {
      sessionInterval = 32;
    } else {
      sessionInterval = TERMINAL_BATCH_INTERVAL;
    }

    // Flush immediately if batch is large for responsiveness
    if (totalLength > BATCH_FLUSH_THRESHOLD) {
      const existingTimer = this.terminalBatchTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.terminalBatchTimers.delete(sessionId);
      }
      this.flushSessionTerminalBatch(sessionId);
      return;
    }

    // Start per-session batch timer if not already running
    // Each session flushes independently — prevents one busy session from
    // forcing all sessions to flush at its rate (thundering herd)
    if (!this.terminalBatchTimers.has(sessionId)) {
      this.terminalBatchTimers.set(
        sessionId,
        setTimeout(() => {
          this.terminalBatchTimers.delete(sessionId);
          this.flushSessionTerminalBatch(sessionId);
        }, sessionInterval)
      );
    }
  }

  /** Flush a single session's batched terminal data */
  private flushSessionTerminalBatch(sessionId: string): void {
    if (this._isStopping) {
      this.terminalBatches.delete(sessionId);
      this.terminalBatchSizes.delete(sessionId);
      return;
    }
    const chunks = this.terminalBatches.get(sessionId);
    if (chunks && chunks.length > 0) {
      // Join chunks only at flush time (avoids O(n^2) string concatenation in batchTerminalData)
      const data = chunks.join('');
      // Wrap batched output in DEC 2026 synchronized output markers so xterm.js
      // renders the entire batch atomically. Ink spinner frames (cursor-up + redraw)
      // do NOT emit their own 2026 markers, so without this wrapper each partial
      // cursor update renders individually, causing visible flicker.
      // xterm.js 6.0+ handles DEC 2026 natively: it buffers everything between
      // 2026h/2026l and renders in one pass.
      const syncData = '\x1b[?2026h' + data + '\x1b[?2026l';
      // Fast path: build SSE message directly without JSON.stringify on wrapper object.
      // Only the terminal data string needs escaping; sessionId is a UUID (safe to template).
      const escapedData = JSON.stringify(syncData);
      // Append tunnel padding for immediate Cloudflare proxy flush —
      // terminal data is high-frequency and latency-sensitive.
      const padding = this._isTunnelActive ? SSE_PADDING : '';
      const message = `event: session:terminal\ndata: {"id":"${sessionId}","data":${escapedData}}\n\n` + padding;
      for (const [client, filter] of this.sseClients) {
        // Skip clients that have a session filter and aren't subscribed to this session
        if (filter && !filter.has(sessionId)) continue;
        this.sendSSEPreformatted(client, message);
      }
    }
    this.terminalBatches.delete(sessionId);
    this.terminalBatchSizes.delete(sessionId);
  }

  // ========== Task Update Batching ==========

  // Batch task:updated events at 100ms - only send latest update per task
  // Key is sessionId:taskId to avoid collisions when multiple tasks update concurrently
  batchTaskUpdate(sessionId: string, task: BackgroundTask): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    // Use composite key to avoid losing updates when multiple tasks update in same batch window
    const key = `${sessionId}:${task.id}`;
    this.taskUpdateBatches.set(key, { sessionId, task });

    if (!this.taskUpdateBatchTimerId) {
      this.taskUpdateBatchTimerId = this.cleanup.setTimeout(
        () => {
          this.taskUpdateBatchTimerId = null;
          this.flushTaskUpdateBatches();
        },
        TASK_UPDATE_BATCH_INTERVAL,
        { description: 'task update batch flush' }
      );
    }
  }

  private flushTaskUpdateBatches(): void {
    // Skip if server is stopping (timer may have been queued before stop() was called)
    if (this._isStopping) {
      this.taskUpdateBatches.clear();
      return;
    }
    for (const [, { sessionId, task }] of this.taskUpdateBatches) {
      this.broadcast(SseEvent.TaskUpdated, { sessionId, task });
    }
    this.taskUpdateBatches.clear();
  }

  // ========== Session State Batching ==========

  /**
   * Debounce expensive session:updated broadcasts.
   * Instead of calling toDetailedState() on every event, batch requests
   * and only serialize once per STATE_UPDATE_DEBOUNCE_INTERVAL.
   */
  broadcastSessionStateDebounced(sessionId: string): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    this.stateUpdatePending.add(sessionId);

    if (!this.stateUpdateTimerId) {
      this.stateUpdateTimerId = this.cleanup.setTimeout(
        () => {
          this.stateUpdateTimerId = null;
          this.flushStateUpdates();
        },
        STATE_UPDATE_DEBOUNCE_INTERVAL,
        { description: 'state update debounce flush' }
      );
    }
  }

  private flushStateUpdates(): void {
    // Skip if server is stopping (timer may have been queued before stop() was called)
    if (this._isStopping) {
      this.stateUpdatePending.clear();
      return;
    }
    for (const sessionId of this.stateUpdatePending) {
      // Single expensive serialization per batch interval
      const state = this.deps.getSessionStateWithRespawn(sessionId);
      if (state) {
        this.broadcast(SseEvent.SessionUpdated, state);
      }
    }
    this.stateUpdatePending.clear();
  }

  // ========== Client Health ==========

  /**
   * Clean up dead SSE clients and send keep-alive comments.
   * Keep-alive prevents proxy/load-balancer timeouts on idle connections.
   * Dead client cleanup prevents memory leaks from abruptly terminated connections.
   */
  cleanupDeadClients(): void {
    const deadClients: FastifyReply[] = [];

    for (const [client] of this.sseClients) {
      try {
        // Check if the underlying socket is still writable
        const socket = client.raw.socket;
        if (!socket || socket.destroyed || !socket.writable) {
          deadClients.push(client);
        } else {
          // Send SSE comment as keep-alive. Only add padding when tunnel is
          // active — it flushes Cloudflare proxy buffers but wastes bandwidth
          // for direct/Tailscale connections.
          const ka = this._isTunnelActive ? ':keepalive\n' + SSE_PADDING : ':keepalive\n\n';
          client.raw.write(ka);
        }
      } catch {
        // Error accessing socket means client is dead
        deadClients.push(client);
      }
    }

    // Remove dead clients
    for (const client of deadClients) {
      this.sseClients.delete(client);
      this.remoteSseClients.delete(client);
      this.backpressuredClients.delete(client);
    }

    if (deadClients.length > 0) {
      console.log(`[Server] Cleaned up ${deadClients.length} dead SSE client(s)`);
    }
  }

  // ========== Session Cleanup ==========

  /** Clean up all batching state for a session (call on session exit or deletion). */
  cleanupSessionBatches(sessionId: string): void {
    this.terminalBatches.delete(sessionId);
    this.terminalBatchSizes.delete(sessionId);
    const batchTimer = this.terminalBatchTimers.get(sessionId);
    if (batchTimer) {
      clearTimeout(batchTimer);
      this.terminalBatchTimers.delete(sessionId);
    }
    this.taskUpdateBatches.delete(sessionId);
    this.stateUpdatePending.delete(sessionId);
    this.lastTerminalEventTime.delete(sessionId);
  }

  // ========== Lifecycle ==========

  setStopping(): void {
    this._isStopping = true;
  }

  /** Graceful shutdown: notify clients, close connections, clear all state. */
  stop(): void {
    this._isStopping = true;

    // Gracefully close all SSE connections before clearing
    for (const [client] of this.sseClients) {
      try {
        // Send a final event to notify clients of shutdown
        this.sendSSE(client, 'server:shutdown', { reason: 'Server stopping' });
        client.raw.end();
      } catch {
        // Client may already be disconnected
      }
    }
    this.sseClients.clear();
    this.remoteSseClients.clear();
    this.backpressuredClients.clear();

    // Clear per-session batch timers
    for (const timer of this.terminalBatchTimers.values()) {
      clearTimeout(timer);
    }
    this.terminalBatchTimers.clear();
    this.terminalBatches.clear();
    this.terminalBatchSizes.clear();

    this.taskUpdateBatches.clear();
    this.stateUpdatePending.clear();

    // Dispose StaleExpirationMap (stops internal cleanup timer)
    this.lastTerminalEventTime.dispose();
  }
}
