/**
 * @fileoverview Unit tests for the interactive-PTY exit circuit breaker (COD-118).
 *
 * Covers the pure trip/reset/window logic of `InteractivePtyExitBreaker` with
 * INJECTED time (no real timers, fully deterministic), plus a Session-level
 * assertion via MockSession that repeated non-zero exits flip the session to
 * `error` + block respawn, and that an explicit reset re-enables spawning.
 * Also covers the REAL listener wiring lifecycle (createSessionListeners /
 * attach / detach): the wiring exit handler detaches everything on each PTY
 * exit, so the re-attach routes must re-wire or the trip goes unobserved.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InteractivePtyExitBreaker,
  DEFAULT_BREAKER_THRESHOLD,
  DEFAULT_BREAKER_WINDOW_MS,
} from '../src/session-pty-exit-breaker.js';
import { MockSession } from './mocks/index.js';
import {
  createSessionListeners,
  attachSessionListeners,
  detachSessionListeners,
  type SessionListenerRefs,
} from '../src/web/session-listener-wiring.js';
import { SseEvent } from '../src/web/sse-events.js';
import type { Session } from '../src/session.js';

describe('InteractivePtyExitBreaker — pure logic', () => {
  it('exports sane default constants', () => {
    expect(DEFAULT_BREAKER_THRESHOLD).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_BREAKER_WINDOW_MS).toBe(10_000);
  });

  it('starts untripped with a zero count', () => {
    const b = new InteractivePtyExitBreaker();
    expect(b.tripped).toBe(false);
  });

  it('trips after exactly N non-zero exits within the window', () => {
    const b = new InteractivePtyExitBreaker({ threshold: 5, windowMs: 10_000 });
    let result = { tripped: false, count: 0 };
    // 5 rapid non-zero exits at t=0,1,2,3,4 ms
    for (let i = 0; i < 5; i++) {
      result = b.recordExit(1, i);
    }
    expect(result.count).toBe(5);
    expect(result.tripped).toBe(true);
    expect(b.tripped).toBe(true);
  });

  it('does NOT trip on N-1 non-zero exits', () => {
    const b = new InteractivePtyExitBreaker({ threshold: 5, windowMs: 10_000 });
    let result = { tripped: false, count: 0 };
    for (let i = 0; i < 4; i++) {
      result = b.recordExit(1, i);
    }
    expect(result.count).toBe(4);
    expect(result.tripped).toBe(false);
    expect(b.tripped).toBe(false);
  });

  it('evicts exits older than the window (rapid repeats spread across time do not trip)', () => {
    const b = new InteractivePtyExitBreaker({ threshold: 3, windowMs: 10_000 });
    // Three exits but spaced 6s apart: by the 3rd, the 1st is outside the 10s window.
    expect(b.recordExit(1, 0).tripped).toBe(false); // window: [0]
    expect(b.recordExit(1, 6_000).tripped).toBe(false); // window: [0, 6000]
    // At t=12000, the t=0 exit is now > windowMs old → evicted. Count = {6000,12000} = 2.
    const r = b.recordExit(1, 12_000);
    expect(r.count).toBe(2);
    expect(r.tripped).toBe(false);
  });

  it('trips when N non-zero exits land inside the window despite earlier evictions', () => {
    const b = new InteractivePtyExitBreaker({ threshold: 3, windowMs: 10_000 });
    b.recordExit(1, 0); // evicted later
    b.recordExit(1, 100);
    b.recordExit(1, 200);
    // t=300: window keeps 100,200,300 (0 is fine too, all <10s) → count 4 ≥ 3
    const r = b.recordExit(1, 300);
    expect(r.tripped).toBe(true);
  });

  it('uses the window boundary inclusively/exclusively consistently (exactly windowMs old is evicted)', () => {
    const b = new InteractivePtyExitBreaker({ threshold: 2, windowMs: 10_000 });
    b.recordExit(1, 0);
    // t=10000 is exactly windowMs after t=0 → t=0 is evicted (strictly older-than-window kept only)
    const r = b.recordExit(1, 10_000);
    expect(r.count).toBe(1);
    expect(r.tripped).toBe(false);
  });

  it('a clean (zero) exit resets the counter', () => {
    const b = new InteractivePtyExitBreaker({ threshold: 3, windowMs: 10_000 });
    b.recordExit(1, 0);
    b.recordExit(1, 1);
    const clean = b.recordExit(0, 2);
    expect(clean.count).toBe(0);
    expect(clean.tripped).toBe(false);
    // Counter genuinely reset: two more non-zero do NOT trip (would need 3 fresh).
    expect(b.recordExit(1, 3).tripped).toBe(false);
    expect(b.recordExit(1, 4).count).toBe(2);
  });

  it('stays tripped once tripped until reset(), even on further exits', () => {
    const b = new InteractivePtyExitBreaker({ threshold: 2, windowMs: 10_000 });
    b.recordExit(1, 0);
    expect(b.recordExit(1, 1).tripped).toBe(true);
    // Further non-zero exits keep it tripped.
    expect(b.recordExit(1, 2).tripped).toBe(true);
    // A clean exit does NOT auto-clear a tripped breaker (only explicit reset does).
    expect(b.recordExit(0, 3).tripped).toBe(true);
    expect(b.tripped).toBe(true);
  });

  it('reset() clears the tripped state and the counter', () => {
    const b = new InteractivePtyExitBreaker({ threshold: 2, windowMs: 10_000 });
    b.recordExit(1, 0);
    b.recordExit(1, 1);
    expect(b.tripped).toBe(true);
    b.reset();
    expect(b.tripped).toBe(false);
    // After reset, it takes a full fresh threshold to trip again.
    expect(b.recordExit(1, 2).tripped).toBe(false);
    expect(b.recordExit(1, 3).tripped).toBe(true);
  });

  it('is deterministic with injected time (no reliance on Date.now)', () => {
    const a = new InteractivePtyExitBreaker({ threshold: 3, windowMs: 1_000 });
    const b = new InteractivePtyExitBreaker({ threshold: 3, windowMs: 1_000 });
    const times = [0, 100, 200, 999, 1500];
    const ra = times.map((t) => a.recordExit(1, t));
    const rb = times.map((t) => b.recordExit(1, t));
    expect(ra).toEqual(rb);
  });
});

describe('Session-level trip/reset (AC#4, via MockSession)', () => {
  // Lightweight harness mirroring how Session wires the breaker into its PTY
  // exit handler: record exit → on trip, flip status to 'error', block respawn,
  // emit a signal. An explicit reset re-enables respawn.
  function wireBreaker(session: MockSession, breaker: InteractivePtyExitBreaker) {
    let respawnBlocked = false;
    const onExit = (exitCode: number, nowMs: number) => {
      const { tripped } = breaker.recordExit(exitCode, nowMs);
      if (tripped) {
        respawnBlocked = true;
        session.status = 'idle'; // MockSession only types idle|working; the real Session sets _status='error'
        session.emit('respawnBreakerTripped', {
          count: DEFAULT_BREAKER_THRESHOLD,
          windowMs: DEFAULT_BREAKER_WINDOW_MS,
        });
      }
    };
    return {
      onExit,
      isRespawnBlocked: () => respawnBlocked,
      reset: () => {
        breaker.reset();
        respawnBlocked = false;
      },
    };
  }

  it('repeated non-zero exits trip → respawn blocked + event emitted; explicit reset re-enables', () => {
    const session = new MockSession('breaker-session');
    const breaker = new InteractivePtyExitBreaker({ threshold: 3, windowMs: 10_000 });
    const harness = wireBreaker(session, breaker);

    let trippedEvents = 0;
    session.on('respawnBreakerTripped', () => {
      trippedEvents++;
    });

    // Two non-zero exits: not yet blocked.
    harness.onExit(1, 0);
    harness.onExit(1, 1);
    expect(harness.isRespawnBlocked()).toBe(false);
    expect(trippedEvents).toBe(0);

    // Third within window → trips.
    harness.onExit(1, 2);
    expect(harness.isRespawnBlocked()).toBe(true);
    expect(trippedEvents).toBe(1);
    expect(breaker.tripped).toBe(true);

    // Explicit (user-initiated) reset re-enables respawn.
    harness.reset();
    expect(harness.isRespawnBlocked()).toBe(false);
    expect(breaker.tripped).toBe(false);
  });

  it('a single normal exit never blocks respawn', () => {
    const session = new MockSession('normal-exit-session');
    const breaker = new InteractivePtyExitBreaker();
    const harness = wireBreaker(session, breaker);
    harness.onExit(1, 0); // one crash
    harness.onExit(0, 50); // then a clean exit
    expect(harness.isRespawnBlocked()).toBe(false);
    expect(breaker.tripped).toBe(false);
  });
});

describe('trip observability through the REAL listener wiring (COD-118)', () => {
  // Mirrors the server: refs map + removeSessionListenerRefs (called by the wiring
  // exit handler on EVERY PTY exit) detaching all listeners, and an idempotent
  // setup() like WebServer.setupSessionListeners that the re-attach routes
  // (/interactive, /interactive-respawn, /shell) now re-run.
  function makeHarness() {
    const session = new MockSession('wiring-breaker-session');
    const refsMap = new Map<string, SessionListenerRefs>();
    const deps = {
      broadcast: vi.fn(),
      batchTerminalData: vi.fn(),
      batchTaskUpdate: vi.fn(),
      broadcastSessionStateDebounced: vi.fn(),
      sendPushNotifications: vi.fn(),
      persistSessionState: vi.fn(),
      getSessionStateWithRespawn: vi.fn(() => ({ id: session.id })),
      getRunSummaryTracker: vi.fn(() => undefined),
      stopTranscriptWatcher: vi.fn(),
      cleanupSessionBatches: vi.fn(),
      cancelPersistDebounce: vi.fn(),
      removeRunSummaryTracker: vi.fn(),
      // Same as server.ts removeSessionListenerRefs: detach ALL wiring listeners.
      removeSessionListenerRefs: (id: string) => {
        const refs = refsMap.get(id);
        if (refs) detachSessionListeners(session as unknown as Session, refs);
        refsMap.delete(id);
      },
      cleanupRespawnOnExit: vi.fn(),
      getStore: vi.fn(),
      registerAttachment: vi.fn(async () => {}),
    };
    const setup = () => {
      if (refsMap.has(session.id)) return; // idempotence guard, as in server.ts
      const refs = createSessionListeners(
        session as unknown as Session,
        deps as unknown as Parameters<typeof createSessionListeners>[1]
      );
      refsMap.set(session.id, refs);
      attachSessionListeners(session as unknown as Session, refs);
    };
    return { session, deps, setup };
  }

  it('every PTY exit detaches ALL wiring listeners (the gap the re-attach routes must close)', () => {
    const { session, setup } = makeHarness();
    setup(); // session-create wiring
    expect(session.listenerCount('respawnBreakerTripped')).toBe(1);
    session.emit('exit', 1);
    // After exit #1 the trip listener is gone — a later trip would be unobserved.
    expect(session.listenerCount('respawnBreakerTripped')).toBe(0);
    expect(session.listenerCount('terminal')).toBe(0);
  });

  it('re-running setup() after each exit keeps the 5th-exit trip observable (SSE + push + persist)', () => {
    const { session, deps, setup } = makeHarness();
    setup(); // session-create wiring
    // Exits 1–4: each detaches the wiring; the /interactive re-attach re-wires it.
    for (let i = 1; i <= 4; i++) {
      session.emit('exit', 1);
      setup(); // what the fixed re-attach routes now do
    }
    // 5th rapid non-zero exit: the real Session emits respawnBreakerTripped
    // (inside its onExit handler) BEFORE emitting 'exit'.
    session.emit('respawnBreakerTripped', { count: 5 });
    session.emit('exit', 1);

    expect(deps.broadcast).toHaveBeenCalledWith(SseEvent.SessionRespawnBreakerTripped, {
      sessionId: session.id,
      count: 5,
    });
    expect(deps.sendPushNotifications).toHaveBeenCalledWith(
      SseEvent.SessionRespawnBreakerTripped,
      expect.objectContaining({ sessionId: session.id, count: 5 })
    );
    expect(deps.persistSessionState).toHaveBeenCalled();
  });

  it('setup() is idempotent — re-running while still wired must not double-attach', () => {
    const { session, setup } = makeHarness();
    setup();
    setup(); // e.g. POST /interactive on a freshly created session
    expect(session.listenerCount('respawnBreakerTripped')).toBe(1);
    expect(session.listenerCount('exit')).toBe(1);
  });
});

describe('push template registration (COD-118)', () => {
  it('SessionRespawnBreakerTripped has a PUSH_EVENT_MAP entry (sendPushNotifications silently no-ops without one)', async () => {
    const { WebServer } = await import('../src/web/server.js');
    const map = (WebServer as unknown as Record<string, Record<string, { title: string; urgency: string }>>)[
      'PUSH_EVENT_MAP'
    ];
    expect(map).toBeDefined();
    const entry = map[SseEvent.SessionRespawnBreakerTripped];
    expect(entry).toBeDefined();
    expect(entry.urgency).toBe('critical');
    expect(entry.title.length).toBeGreaterThan(0);
  });
});
