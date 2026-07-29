/**
 * @fileoverview Per-session WebSocket connection registry (COD-137).
 *
 * Replaces the bare `Map<sessionId, number>` counter that previously gated
 * `MAX_WS_PER_SESSION`. That counter had two defects:
 *
 *   1. Transient over-count on reconnect: a client that drops and immediately
 *      reconnects could land its new upgrade BEFORE the old socket's async
 *      `close` fired, so the count briefly exceeded the live connection number.
 *      A reconnect burst could hit the cap and the next upgrade was rejected
 *      with 4008 → the client fell back to HTTP. (The real spurious-4008 defect.)
 *   2. No clientId scoping: the limit counted raw sockets, so a reconnecting
 *      client consumed a NEW slot instead of replacing its own.
 *
 * This registry tracks the live socket(s) per session keyed by a per-TAB
 * connection identity (`cid`, parsed from the upgrade URL query). The browser
 * sends `clientId:tabNonce`, NOT the bare localStorage clientId — that one is
 * shared by every tab/window of a profile, so keying on it would make two tabs
 * on one session evict each other in a 4010 ping-pong. A new upgrade for a
 * `cid` that already holds a socket is a SUPERSEDE — the registry evicts the
 * stale socket and reuses its slot, which makes a reconnect reclaim rather
 * than double-count (fixes #1 and #2). The cid is opaque here; input-frame
 * dedup uses the bare clientId separately (Session's input-delivery bookkeeping).
 *
 * Backward-compat: an upgrade with NO `cid` (legacy clients, other tools) is
 * admitted anonymously — it counts toward the limit but never evicts another
 * client, and several anonymous sockets can coexist up to the cap.
 *
 * The class is pure (no `ws`/Fastify imports) and generic over a minimal socket
 * shape so it can be unit-tested with plain fakes. The route owns the actual
 * socket close/terminate; the registry only decides admit/evict and tracks slots.
 */

/** Minimal socket shape the registry needs — satisfied by `ws` WebSocket. */
export interface RegistrableSocket {
  /** Identity comparison only; never dereferenced beyond `===`. */
  readonly readyState?: number;
}

export interface RegisterResult<S> {
  /** Whether the new socket was admitted (false → caller should reject with 4008). */
  admitted: boolean;
  /**
   * A stale socket whose slot the new socket reclaimed (same `cid`). The caller
   * should close it. Present only on a keyed supersede; never set for anonymous
   * upgrades or fresh slots.
   */
  evictedSocket?: S;
}

/** A single live entry: the socket plus its clientId (null = anonymous). */
interface Entry<S> {
  socket: S;
  cid: string | null;
}

export class WsConnectionRegistry<S extends RegistrableSocket = RegistrableSocket> {
  /** sessionId → live entries (keyed + anonymous). */
  private readonly bySession = new Map<string, Entry<S>[]>();

  constructor(private readonly maxPerSession: number) {}

  /**
   * Attempt to register a new socket for `(sessionId, cid)`.
   *
   * - cid present and already holds a socket → SUPERSEDE: evict the old one,
   *   reuse its slot, always admit.
   * - otherwise → admit iff distinct-entry count < maxPerSession.
   *
   * A null/empty `cid` is anonymous: it never matches an existing entry and so
   * never evicts; it just consumes a slot.
   */
  register(sessionId: string, cid: string | null, socket: S): RegisterResult<S> {
    const entries = this.bySession.get(sessionId) ?? [];

    if (cid) {
      const existingIdx = entries.findIndex((e) => e.cid === cid);
      if (existingIdx !== -1) {
        const evicted = entries[existingIdx].socket;
        // Reuse the slot in place — no net change to the live count, so a
        // reconnect can never be rejected by the cap.
        entries[existingIdx] = { socket, cid };
        this.bySession.set(sessionId, entries);
        return { admitted: true, evictedSocket: evicted === socket ? undefined : evicted };
      }
    }

    if (entries.length >= this.maxPerSession) {
      return { admitted: false };
    }

    entries.push({ socket, cid: cid || null });
    this.bySession.set(sessionId, entries);
    return { admitted: true };
  }

  /**
   * Remove a socket from its session. Idempotent — safe to call on `close`,
   * `error`, AND eagerly on `terminate()` (the over-count fix relies on eager
   * removal freeing the slot before the async `close` fires).
   *
   * Matches by socket identity, so a socket that was already superseded
   * (replaced in-slot by a same-cid reconnect) is NOT removed by its late
   * `close` — the new socket keeps the slot.
   */
  unregister(sessionId: string, socket: S): void {
    const entries = this.bySession.get(sessionId);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.socket === socket);
    if (idx === -1) return;
    entries.splice(idx, 1);
    if (entries.length === 0) {
      this.bySession.delete(sessionId);
    } else {
      this.bySession.set(sessionId, entries);
    }
  }

  /** Number of live entries for a session (0 if none). */
  liveCount(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }
}
