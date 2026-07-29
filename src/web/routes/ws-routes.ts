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
 * Terminal output is micro-batched to group Ink's rapid cursor-up redraws into
 * single frames, preventing flicker from split ANSI sequences. Desktop keeps an
 * 8ms/8KB low-latency budget. Mobile uses 50ms/16KB because synchronized xterm
 * paints are substantially more expensive on phone CPUs; grouping before the
 * DEC-2026 wrapper preserves every PTY byte while removing redundant paints.
 *
 * Protocol (all JSON text frames):
 *   Server -> Client:
 *     {"t":"o","d":"..."} — terminal output
 *     {"t":"c"}           — clear terminal
 *     {"t":"r"}           — needs refresh (reload buffer)
 *     {"t":"ia","seq":N}  — input ACK (echoes the seq of an applied/deduped input frame)
 *     {"t":"ha"}          — terminal-stream handoff ACK
 *   Client -> Server:
 *     {"t":"i","d":"...","seq":N,"cid":"..."} — input (keystroke or paste). seq+cid are
 *                          optional reliable-delivery tags: the server applies each
 *                          (cid,seq) at-most-once and ACKs with {"t":"ia","seq":N}.
 *                          Input also reasserts the connection's last announced viewport.
 *     {"t":"z","c":N,"r":N,"v":"mobile|tablet|desktop","f":bool}
 *                          — resize terminal. f forces SIGWINCH.
 *     {"t":"h"}           — flush WS output and atomically hand terminal delivery to SSE
 */

import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { SessionPort } from '../ports/session-port.js';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import { WsConnectionRegistry } from '../ws-connection-registry.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';

/** Micro-batch interval for terminal output (ms). Short enough for low latency,
 *  long enough to group Ink's rapid cursor-up redraw sequences into single frames. */
const WS_BATCH_INTERVAL_MS = 8;

/** Keep active-view redraw frames small enough for one smooth mobile paint. */
const WS_BATCH_FLUSH_THRESHOLD = 8 * 1024;

/** Phone-specific batching budget: reliably groups two ~30Hz source animation ticks. */
const WS_MOBILE_BATCH_INTERVAL_MS = 50;

/** Match the browser's mobile xterm parse budget while retaining progressive bulk output. */
const WS_MOBILE_BATCH_FLUSH_THRESHOLD = 16 * 1024;

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

function splitTerminalPayload(
  data: string,
  maxBytes: number,
  flushSafeTail: boolean
): { frames: string[]; remainder: string } {
  if (!data) return { frames: [], remainder: '' };
  const chunks: string[] = [];
  let parserState: 'ground' | 'escape' | 'csi' | 'osc' | 'osc-escape' | 'control-string' | 'control-string-escape' =
    'ground';
  let controlSequence = '';
  let synchronizedUpdateOpen = false;
  let start = 0;
  let offset = 0;
  let chunkBytes = 0;
  let lastSafeOffset = 0;
  while (offset < data.length) {
    const codePoint = data.codePointAt(offset) ?? 0;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const codePointBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

    // Split before the next ground-state code point when it would exceed the
    // target. Inside ANSI strings/sequences, correctness wins: wait until the
    // parser returns to ground rather than injecting a sync marker mid-command.
    if (
      parserState === 'ground' &&
      !synchronizedUpdateOpen &&
      chunkBytes > 0 &&
      chunkBytes + codePointBytes > maxBytes
    ) {
      chunks.push(data.slice(start, offset));
      start = offset;
      chunkBytes = 0;
      lastSafeOffset = start;
    }

    chunkBytes += codePointBytes;
    offset += codeUnits;

    switch (parserState) {
      case 'ground':
        if (codePoint === 0x1b) {
          parserState = 'escape';
          controlSequence = '\x1b';
        } else if (codePoint === 0x9b) {
          parserState = 'csi';
          controlSequence = '\x9b';
        } else if (codePoint === 0x9d) {
          parserState = 'osc';
        } else if (codePoint === 0x90 || codePoint === 0x98 || codePoint === 0x9e || codePoint === 0x9f) {
          parserState = 'control-string';
        }
        break;
      case 'escape':
        controlSequence += String.fromCodePoint(codePoint);
        if (codePoint === 0x5b) {
          parserState = 'csi';
        } else if (codePoint === 0x5d) {
          parserState = 'osc';
          controlSequence = '';
        } else if (codePoint === 0x50 || codePoint === 0x58 || codePoint === 0x5e || codePoint === 0x5f) {
          parserState = 'control-string';
          controlSequence = '';
        } else if (codePoint < 0x20 || codePoint > 0x2f) {
          parserState = 'ground';
          controlSequence = '';
        }
        break;
      case 'csi':
        if (codePoint === 0x1b) {
          parserState = 'escape';
          controlSequence = '\x1b';
        } else if (codePoint === 0x18 || codePoint === 0x1a) {
          parserState = 'ground';
          controlSequence = '';
        } else {
          controlSequence += String.fromCodePoint(codePoint);
          if (codePoint >= 0x40 && codePoint <= 0x7e) {
            if (controlSequence === '\x1b[?2026h' || controlSequence === '\x9b?2026h') {
              synchronizedUpdateOpen = true;
            } else if (controlSequence === '\x1b[?2026l' || controlSequence === '\x9b?2026l') {
              synchronizedUpdateOpen = false;
            }
            parserState = 'ground';
            controlSequence = '';
          }
        }
        break;
      case 'osc':
        if (codePoint === 0x07 || codePoint === 0x9c) {
          parserState = 'ground';
        } else if (codePoint === 0x1b) {
          parserState = 'osc-escape';
        }
        break;
      case 'osc-escape':
        if (codePoint === 0x5c || codePoint === 0x9c || codePoint === 0x07) {
          parserState = 'ground';
        } else {
          parserState = codePoint === 0x1b ? 'osc-escape' : 'osc';
        }
        break;
      case 'control-string':
        if (codePoint === 0x9c) {
          parserState = 'ground';
        } else if (codePoint === 0x1b) {
          parserState = 'control-string-escape';
        }
        break;
      case 'control-string-escape':
        if (codePoint === 0x5c || codePoint === 0x9c) {
          parserState = 'ground';
        } else {
          parserState = codePoint === 0x1b ? 'control-string-escape' : 'control-string';
        }
        break;
    }

    if (parserState === 'ground' && !synchronizedUpdateOpen) {
      lastSafeOffset = offset;
      if (chunkBytes >= maxBytes) {
        chunks.push(data.slice(start, offset));
        start = offset;
        chunkBytes = 0;
        lastSafeOffset = start;
      }
    }
  }
  if (flushSafeTail && lastSafeOffset > start) {
    chunks.push(data.slice(start, lastSafeOffset));
    start = lastSafeOffset;
  }
  return {
    frames: chunks,
    remainder: data.slice(start),
  };
}

/**
 * Track live WS connections per session, keyed by clientId (COD-137).
 * Replaces a bare counter that over-counted across the async-close gap on
 * reconnect (spurious 4008). A same-`cid` reconnect supersedes its own socket
 * (reclaims the slot) instead of consuming a new one; cid-less upgrades are
 * admitted anonymously up to the cap. See ws-connection-registry.ts.
 */
const sessionWsRegistry = new WsConnectionRegistry<WebSocket>(MAX_WS_PER_SESSION);

export interface TerminalStreamCoordinator {
  suspendSseTerminal(clientId: string, sessionId: string): void;
  resumeSseTerminal(clientId: string, sessionId: string, recover: boolean): void;
}

const NOOP_STREAM_COORDINATOR: TerminalStreamCoordinator = {
  suspendSseTerminal: () => {},
  resumeSseTerminal: () => {},
};

export function registerWsRoutes(
  app: FastifyInstance,
  ctx: SessionPort,
  getHostPolicy: () => HostPolicy,
  streamCoordinator: TerminalStreamCoordinator = NOOP_STREAM_COORDINATOR
): void {
  app.get<{ Params: { id: string }; Querystring: { cid?: string } }>(
    '/ws/sessions/:id/terminal',
    { websocket: true },
    (socket: WebSocket, req) => {
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

      // Multi-user owner gate: writing to this socket injects keystrokes into the
      // agent, so a non-admin may only attach to their OWN session. The global auth
      // hook already ran on the upgrade request and decorated req.authUser (an
      // unauthenticated upgrade never reaches here — the hook 401s the handshake).
      // findSessionOrFail throws an HTTP-shaped error, so the check is inlined here
      // as a 4003 close. No-op in single-user mode (canAccessOwned returns true).
      if (!canAccessOwned(getAuthUser(req), session.owner)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      // Structured transport logging — surfaces WS open/close/timeout churn so the
      // tunnel-flap behavior (COD-134) is observable in the server logs. Fastify is
      // configured logger:false, so we log via console (→ journald under systemd).

      // Enforce per-session connection limit, scoped by clientId. A same-cid
      // reconnect reclaims its own slot (registry evicts the stale socket), so a
      // drop+reconnect burst can no longer over-count across the async-close gap
      // and trip a spurious 4008. cid-less upgrades are admitted anonymously.
      const cid = typeof req.query?.cid === 'string' && req.query.cid.length > 0 ? req.query.cid : null;
      const { admitted, evictedSocket } = sessionWsRegistry.register(id, cid, socket);
      if (!admitted) {
        console.warn('[ws] terminal rejected: too many connections', {
          sessionId: id,
          wsCount: sessionWsRegistry.liveCount(id),
        });
        socket.close(4008, 'Too many connections');
        return;
      }
      if (evictedSocket) {
        // Same client reconnected; retire the stale socket so it doesn't linger.
        console.info('[ws] terminal superseded by reconnect', { sessionId: id });
        try {
          evictedSocket.close(4010, 'Superseded by reconnect');
        } catch {
          /* socket may already be closing */
        }
      }
      console.info('[ws] terminal open', { sessionId: id, wsCount: sessionWsRegistry.liveCount(id) });

      if (cid) {
        streamCoordinator.suspendSseTerminal(cid, id);
      }

      let transportReleased = false;
      let detachTerminalTransport = () => {};
      const releaseTerminalTransport = (recover: boolean) => {
        if (transportReleased || !cid) return;
        transportReleased = true;
        if (sessionWsRegistry.hasSocket(id, socket)) {
          streamCoordinator.resumeSseTerminal(cid, id, recover);
        }
      };

      // Eagerly free the slot on error/terminate — don't wait for the async
      // 'close' (idempotent with the 'close' handler below). This is what kills
      // the reconnect over-count: the slot is released the instant the socket dies.
      socket.on('error', () => {
        releaseTerminalTransport(true);
        sessionWsRegistry.unregister(id, socket);
      });

      // Per-connection micro-batch state
      let batchChunks: string[] = [];
      let batchSize = 0;
      let batchTimer: ReturnType<typeof setTimeout> | null = null;
      let announcedViewport: 'mobile' | 'tablet' | 'desktop' | undefined;
      const batchIntervalMs = () =>
        announcedViewport === 'mobile' ? WS_MOBILE_BATCH_INTERVAL_MS : WS_BATCH_INTERVAL_MS;
      const batchFlushThreshold = () =>
        announcedViewport === 'mobile' ? WS_MOBILE_BATCH_FLUSH_THRESHOLD : WS_BATCH_FLUSH_THRESHOLD;

      const flushBatch = (flushSafeTail = true) => {
        batchTimer = null;
        if (batchChunks.length === 0 || socket.readyState !== 1) {
          batchChunks = [];
          batchSize = 0;
          return;
        }
        const data = batchChunks.join('');
        const { frames, remainder } = splitTerminalPayload(data, batchFlushThreshold(), flushSafeTail);
        batchChunks = remainder ? [remainder] : [];
        batchSize = Buffer.byteLength(remainder, 'utf8');
        for (const frame of frames) {
          socket.send(`{"t":"o","d":${JSON.stringify(DEC_2026_START + frame + DEC_2026_END)}}`);
        }
      };
      const flushBatchNow = () => {
        if (batchTimer) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        flushBatch(false);
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
          } else if (msg.t === 'h') {
            if (batchTimer) {
              clearTimeout(batchTimer);
              batchTimer = null;
            }
            flushBatch();
            detachTerminalTransport();
            releaseTerminalTransport(false);
            if (socket.readyState === 1) socket.send('{"t":"ha"}');
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
            announcedViewport = viewportType;
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
        batchSize += Buffer.byteLength(data, 'utf8');
        if (batchSize >= batchFlushThreshold()) flushBatchNow();

        // Start timer if not already running
        if (batchChunks.length > 0 && !batchTimer) {
          batchTimer = setTimeout(flushBatch, batchIntervalMs());
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
      detachTerminalTransport = () => {
        session.off('terminal', onTerminal);
        session.off('clearTerminal', onClearTerminal);
        session.off('needsRefresh', onNeedsRefresh);
      };

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
          // Free the slot eagerly — terminate()'s 'close' may lag, and a client
          // reconnecting after a stale-connection drop must not be over-counted.
          releaseTerminalTransport(true);
          sessionWsRegistry.unregister(id, socket);
          socket.terminate();
        }, WS_PONG_TIMEOUT_MS);
      }, WS_PING_INTERVAL_MS);

      socket.on('close', (code: number, reason: Buffer) => {
        clearInterval(pingInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        if (batchTimer) clearTimeout(batchTimer);
        batchChunks = [];
        detachTerminalTransport();
        session.off('exit', onSessionExit);
        session.releaseDesktopSizing(sizingToken);

        releaseTerminalTransport(code !== 4009);
        // Release this socket's slot. Idempotent and identity-matched: if this
        // socket was already superseded (a same-cid reconnect took its slot) or
        // eagerly unregistered on terminate/error, this is a no-op and the
        // reconnected socket keeps the slot.
        sessionWsRegistry.unregister(id, socket);
        console.info('[ws] terminal close', {
          sessionId: id,
          code,
          reason: String(reason),
          wsCount: sessionWsRegistry.liveCount(id),
        });
      });
    }
  );
}
