/**
 * @fileoverview Exactly-once input delivery — Session delivery bookkeeping.
 *
 * Guards the server half of the reliable-input-delivery feature: the web client
 * tags each input frame with a stable clientId + a monotonic per-session seq and
 * redelivers anything it hasn't seen ACKed (a half-open socket silently drops
 * frames on a flaky link). The Session delivery API must apply each (clientId, seq)
 * exactly once so a redelivery can never type the prompt twice — while still
 * applying untagged input (curl/legacy) unconditionally at the call sites.
 *
 * See docs/reliable-input-delivery.md.
 */
import { describe, it, expect } from 'vitest';
import { Session } from '../src/session.js';

function makeSession(): Session {
  // workingDir is the only required field; no PTY is spawned until start(),
  // and TmuxManager no-ops under VITEST — so this is a cheap, side-effect-free
  // instance for exercising the pure dedup bookkeeping.
  return new Session({ workingDir: '/tmp' });
}

describe('Session.shouldApplyInput (exactly-once input dedup)', () => {
  it('applies a fresh (clientId, seq) exactly once', () => {
    const s = makeSession();
    expect(s.shouldApplyInput('clientA', 1)).toBe(true);
    // Same seq redelivered (lost ACK) — must NOT apply again.
    expect(s.shouldApplyInput('clientA', 1)).toBe(false);
  });

  it('applies strictly increasing seqs and rejects stale ones', () => {
    const s = makeSession();
    expect(s.shouldApplyInput('c', 1)).toBe(true);
    expect(s.shouldApplyInput('c', 2)).toBe(true);
    expect(s.shouldApplyInput('c', 3)).toBe(true);
    // Out-of-order / replayed lower seqs are duplicates.
    expect(s.shouldApplyInput('c', 2)).toBe(false);
    expect(s.shouldApplyInput('c', 1)).toBe(false);
    // The next genuinely-new seq still applies.
    expect(s.shouldApplyInput('c', 4)).toBe(true);
  });

  it('tracks each client independently', () => {
    const s = makeSession();
    expect(s.shouldApplyInput('a', 5)).toBe(true);
    // A different client at seq 1 is not shadowed by client a's higher seq.
    expect(s.shouldApplyInput('b', 1)).toBe(true);
    expect(s.shouldApplyInput('b', 1)).toBe(false);
    expect(s.shouldApplyInput('a', 6)).toBe(true);
  });

  it('tolerates a seq gap (skips never collapse a new seq to a duplicate)', () => {
    const s = makeSession();
    expect(s.shouldApplyInput('c', 1)).toBe(true);
    // Client jumped seq (e.g. resumed after a reload that kept the counter).
    expect(s.shouldApplyInput('c', 100)).toBe(true);
    expect(s.shouldApplyInput('c', 100)).toBe(false);
    expect(s.shouldApplyInput('c', 50)).toBe(false);
    expect(s.shouldApplyInput('c', 101)).toBe(true);
  });

  it('keeps recent clients dedup-correct past the eviction bound', () => {
    const s = makeSession();
    // Far exceed MAX_INPUT_DEDUP_CLIENTS (256) with one-shot clients, then prove
    // a freshly-active client is still deduped correctly (MRU eviction).
    for (let i = 0; i < 400; i++) {
      expect(s.shouldApplyInput(`oneshot-${i}`, 1)).toBe(true);
    }
    expect(s.shouldApplyInput('recent', 1)).toBe(true);
    expect(s.shouldApplyInput('recent', 1)).toBe(false);
    expect(s.shouldApplyInput('recent', 2)).toBe(true);
  });

  it('keeps an in-flight frame retryable until its writer accepts it', () => {
    const s = makeSession();

    expect(s.reserveInputDelivery('client', 1)).toBe('reserved');
    expect(s.reserveInputDelivery('client', 1)).toBe('pending');
    expect(s.reserveInputDelivery('client', 2)).toBe('pending');

    s.completeInputDelivery('client', 1, false);
    expect(s.reserveInputDelivery('client', 1)).toBe('reserved');
    s.completeInputDelivery('client', 1, true);

    expect(s.reserveInputDelivery('client', 1)).toBe('applied');
    expect(s.reserveInputDelivery('client', 2)).toBe('reserved');
  });
});
