/**
 * @fileoverview WebSocket terminal I/O route.
 *
 * Provides a low-latency bidirectional channel for terminal input/output,
 * bypassing the HTTP POST + SSE path that adds per-request middleware overhead.
 * Auth is checked once on the WebSocket upgrade handshake (cookies are included
 * automatically by the browser). After upgrade, the connection is raw — no
 * per-message middleware processing.
 *
 * Additive: the existing HTTP POST /api/sessions/:id/input and SSE session:terminal
 * paths remain fully functional. The frontend opts into WS when available and
 * falls back transparently.
 *
 * Terminal output is micro-batched at 8ms to group Ink's rapid cursor-up redraws
 * into single frames, preventing flicker from split ANSI sequences. This matches
 * the SSE path's server-side batching (16-50ms) but at a shorter interval since
 * WS has no Traefik buffering overhead.
 *
 * Protocol (all JSON text frames):
 *   Server -> Client:
 *     {"t":"o","d":"..."} — terminal output
 *     {"t":"c"}           — clear terminal
 *     {"t":"r"}           — needs refresh (reload buffer)
 *     {"t":"ia","seq":N}  — input ACK (echoes the seq of an applied/deduped input frame)
 *   Client -> Server:
 *     {"t":"i","d":"...","seq":N,"cid":"..."} — input (keystroke or paste). seq+cid are
 *                          optional reliable-delivery tags: the server applies each
 *                          (cid,seq) at-most-once and ACKs with {"t":"ia","seq":N}.
 *     {"t":"z","c":N,"r":N,"f":bool} — resize terminal (f=true forces SIGWINCH even if dims unchanged)
 */

import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { SessionPort } from '../ports/session-port.js';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';

/** Micro-batch interval for terminal output (ms). Short enough for low latency,
 *  long enough to group Ink's rapid cursor-up redraw sequences into single frames. */
const WS_BATCH_INTERVAL_MS = 8;

/** Flush immediately when batch exceeds this size (bytes) for responsiveness. */
const WS_BATCH_FLUSH_THRESHOLD = 16384;

/** How often to ping each WebSocket client (ms). Detects stale connections that
 *  TCP keepalive won't catch for minutes, especially through tunnels/proxies. */
const WS_PING_INTERVAL_MS = 30_000;

/** If pong isn't received within this window after a ping, terminate the socket. */
const WS_PONG_TIMEOUT_MS = 10_000;

/** DEC 2026 synchronized update markers. Wrapping output in these tells xterm.js
 *  to buffer all content and render atomically in a single frame — eliminates
 *  flicker from cursor-up redraws that Ink sends without its own sync markers
 *  (DA capability negotiation fails through the PTY→server→WS proxy chain). */
const DEC_2026_START = '\x1b[?2026h';
const DEC_2026_END = '\x1b[?2026l';

/** Max concurrent WS connections per session. Prevents listener/bandwidth multiplication. */
const MAX_WS_PER_SESSION = 5;

/** Track active WS connections per session for connection limiting. */
const sessionWsCount = new Map<string, number>();

export function registerWsRoutes(app: FastifyInstance, ctx: SessionPort, getHostPolicy: () => HostPolicy): void {
  app.get<{ Params: { id: string } }>('/ws/sessions/:id/terminal', { websocket: true }, (socket: WebSocket, req) => {
    // Reject cross-site WebSocket hijacking (CSWSH) and DNS-rebinding before doing
    // anything: the upgrade must come from an allowed Host and (when the browser
    // sends one — it always does for WS) a same-site Origin. Writing to this socket
    // injects keystrokes into a --dangerously-skip-permissions agent, so this gate
    // matters even on the default no-password install. See security review H5.
    const policy = getHostPolicy();
    if (!isAllowedRequestHost(req.headers.host, policy) || !isAllowedRequestOrigin(req.headers.origin, policy)) {
      socket.close(4003, 'Forbidden');
      return;
    }

    const { id } = req.params;
    const session = ctx.sessions.get(id);

    if (!session) {
      socket.close(4004, 'Session not found');
      return;
    }

    // Structured transport logging — surfaces WS open/close/timeout churn so the
    // tunnel-flap behavior (COD-134) is observable in the server logs. Fastify is
    // configured logger:false, so we log via console (→ journald under systemd).

    // Enforce per-session connection limit
    const currentCount = sessionWsCount.get(id) ?? 0;
    if (currentCount >= MAX_WS_PER_SESSION) {
      console.warn('[ws] terminal rejected: too many connections', { sessionId: id, wsCount: currentCount });
      socket.close(4008, 'Too many connections');
      return;
    }
    sessionWsCount.set(id, currentCount + 1);
    console.info('[ws] terminal open', { sessionId: id, wsCount: currentCount + 1 });

    // Swallow socket errors — cleanup happens in 'close'
    socket.on('error', () => {});

    // Per-connection micro-batch state
    let batchChunks: string[] = [];
    let batchSize = 0;
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBatch = () => {
      batchTimer = null;
      if (batchChunks.length === 0 || socket.readyState !== 1) {
        batchChunks = [];
        batchSize = 0;
        return;
      }
      const data = batchChunks.join('');
      batchChunks = [];
      batchSize = 0;
      socket.send(`{"t":"o","d":${JSON.stringify(DEC_2026_START + data + DEC_2026_END)}}`);
    };

    // Per-connection desktop sizing claim — registered on the first
    // desktop-typed resize and released on socket close, so Session.resize()
    // can ignore small-viewport resizes only while a desktop is actually
    // connected (see Session._desktopSizeClaims).
    const sizingToken = Symbol('ws-desktop-sizing');
    let holdsDesktopClaim = false;

    // Attach message handler synchronously BEFORE any async work
    // (@fastify/websocket requirement to avoid dropped messages).
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.t === 'i' && typeof msg.d === 'string') {
          if (msg.d.length > MAX_INPUT_LENGTH) return;
          // Reliable delivery: when the frame carries a clientId + seq, apply it
          // exactly once (skip a duplicate redelivery) but ACK it regardless so
          // the client can drop it from its durable queue. Frames without seq
          // (legacy/other tools) are applied as-is — no behavior change.
          const cid = typeof msg.cid === 'string' ? msg.cid : null;
          const seq = Number.isInteger(msg.seq) ? (msg.seq as number) : null;
          const apply = cid && seq !== null ? session.shouldApplyInput(cid, seq) : true;
          if (apply) {
            // Typed input from a claim-holding desktop keeps the claim "hot"
            // and re-asserts the desktop layout after a mobile override.
            if (holdsDesktopClaim) session.noteDesktopActivity();
            session.write(msg.d);
          }
          if (seq !== null && socket.readyState === 1) {
            socket.send(`{"t":"ia","seq":${seq}}`);
          }
        } else if (
          msg.t === 'z' &&
          Number.isInteger(msg.c) &&
          Number.isInteger(msg.r) &&
          msg.c >= 1 &&
          msg.c <= 500 &&
          msg.r >= 1 &&
          msg.r <= 200
        ) {
          const viewportType = msg.v === 'mobile' || msg.v === 'tablet' || msg.v === 'desktop' ? msg.v : undefined;
          if (viewportType === 'desktop') {
            session.claimDesktopSizing(sizingToken);
            holdsDesktopClaim = true;
          } else if (viewportType) {
            // The connection's viewport can change (e.g. browser window
            // narrowed past the tablet breakpoint) — drop a stale claim.
            session.releaseDesktopSizing(sizingToken);
            holdsDesktopClaim = false;
          }
          const force = msg.f === true;
          session.resize(msg.c, msg.r, { viewportType, force });
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Terminal output -> micro-batched WS send
    const onTerminal = (data: string) => {
      if (socket.readyState !== 1) return;
      batchChunks.push(data);
      batchSize += data.length;

      // Flush immediately for large batches (responsiveness during bulk output)
      if (batchSize > WS_BATCH_FLUSH_THRESHOLD) {
        if (batchTimer) {
          clearTimeout(batchTimer);
        }
        flushBatch();
        return;
      }

      // Start timer if not already running
      if (!batchTimer) {
        batchTimer = setTimeout(flushBatch, WS_BATCH_INTERVAL_MS);
      }
    };

    const onClearTerminal = () => {
      if (socket.readyState === 1) {
        socket.send('{"t":"c"}');
      }
    };

    const onNeedsRefresh = () => {
      if (socket.readyState === 1) {
        socket.send('{"t":"r"}');
      }
    };

    // Close WS when session exits (deleted, respawned, or crashed) — prevents
    // orphaned listeners and stale writes to a dead PTY.
    const onSessionExit = () => {
      socket.close(4009, 'Session terminated');
    };

    session.on('terminal', onTerminal);
    session.on('clearTerminal', onClearTerminal);
    session.on('needsRefresh', onNeedsRefresh);
    session.on('exit', onSessionExit);

    // Heartbeat: detect stale connections (especially through tunnels where
    // TCP RST can take minutes to propagate).
    let pongTimeout: ReturnType<typeof setTimeout> | null = null;

    socket.on('pong', () => {
      if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
      }
    });

    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) return;
      socket.ping();
      pongTimeout = setTimeout(() => {
        console.warn('[ws] terminal ping timeout — terminating', { sessionId: id });
        socket.terminate();
      }, WS_PONG_TIMEOUT_MS);
    }, WS_PING_INTERVAL_MS);

    socket.on('close', (code: number, reason: Buffer) => {
      clearInterval(pingInterval);
      if (pongTimeout) clearTimeout(pongTimeout);
      if (batchTimer) clearTimeout(batchTimer);
      batchChunks = [];
      session.off('terminal', onTerminal);
      session.off('clearTerminal', onClearTerminal);
      session.off('needsRefresh', onNeedsRefresh);
      session.off('exit', onSessionExit);
      session.releaseDesktopSizing(sizingToken);

      // Decrement per-session connection count
      const count = sessionWsCount.get(id) ?? 1;
      const remaining = count <= 1 ? 0 : count - 1;
      if (remaining === 0) {
        sessionWsCount.delete(id);
      } else {
        sessionWsCount.set(id, remaining);
      }
      console.info('[ws] terminal close', { sessionId: id, code, reason: String(reason), wsCount: remaining });
    });
  });
}
