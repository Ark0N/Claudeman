/**
 * Issue #205, round 2: `getClaudeCliVersion()` used to cache FAILURE forever.
 *
 * It stored `null` on any exception and guarded on `!== undefined`, so a single
 * failed probe — the 5s exec timeout, a PATH-starved systemd/launchd
 * environment, a transient fs hiccup — at the first Claude session start left
 * `cliVersion` undefined for every Claude session until the server restarted.
 * An undefined `cliVersion` silently disables wheel-forwarding to Claude's own
 * transcript (`_shouldForwardWheelToApp`), which is the only route to history
 * for a repaint-mode pane: a dead wheel on every device at once, which is what
 * the reporter described (phone + iPad + laptop all broken together points at a
 * SERVER-side cause, not a browser one).
 *
 * The probe itself can't run under vitest (it would spawn a real `claude`), so
 * these drive the cache policy directly with an injected probe and clock.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  claudeVersionRetryDelayMs,
  getClaudeCliVersion,
  resolveClaudeCliVersion,
  type ClaudeVersionProbeState,
} from '../src/utils/claude-cli-resolver.js';

const freshState = (): ClaudeVersionProbeState => ({ failures: 0, lastFailureAt: 0 });

describe('claude --version probe caching', () => {
  it('probes once on success and never spawns again', () => {
    const state = freshState();
    const probe = vi.fn(() => '2.1.223');

    expect(resolveClaudeCliVersion(state, 1_000, probe)).toBe('2.1.223');
    expect(resolveClaudeCliVersion(state, 2_000, probe)).toBe('2.1.223');
    expect(resolveClaudeCliVersion(state, 9_999_999, probe)).toBe('2.1.223');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('RETRIES after a failed probe instead of poisoning the process', () => {
    const state = freshState();
    const probe = vi
      .fn<() => string | null>()
      .mockImplementationOnce(() => {
        throw new Error('spawn claude ETIMEDOUT'); // the shipped failure mode
      })
      .mockImplementationOnce(() => '2.1.223');

    // First session start: probe blows up, no version.
    expect(resolveClaudeCliVersion(state, 1_000, probe)).toBeNull();
    // Immediately after, the negative cache holds — no probe storm.
    expect(resolveClaudeCliVersion(state, 30_000, probe)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);

    // Once the retry window elapses, the next session start probes again and
    // wheel-forwarding comes back without a server restart.
    expect(resolveClaudeCliVersion(state, 61_000, probe)).toBe('2.1.223');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats an unparseable version like a failure (retryable, not cached)', () => {
    const state = freshState();
    const probe = vi.fn<() => string | null>(() => null); // e.g. output without a x.y.z

    expect(resolveClaudeCliVersion(state, 1_000, probe)).toBeNull();
    expect(resolveClaudeCliVersion(state, 61_000, probe)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(state.version).toBeUndefined(); // nothing cached as "known bad"
  });

  it('clears the failure streak once a probe succeeds', () => {
    const state = freshState();
    const probe = vi
      .fn<() => string | null>()
      .mockImplementationOnce(() => null)
      .mockImplementationOnce(() => '2.1.223');

    resolveClaudeCliVersion(state, 1_000, probe);
    expect(state.failures).toBe(1);
    resolveClaudeCliVersion(state, 61_000, probe);
    expect(state.failures).toBe(0);
    expect(state.lastFailureAt).toBe(0);
  });

  it('backs off so a genuinely missing binary cannot probe on every session start', () => {
    expect(claudeVersionRetryDelayMs(0)).toBe(0);
    expect(claudeVersionRetryDelayMs(1)).toBe(60_000);
    expect(claudeVersionRetryDelayMs(2)).toBe(120_000);
    expect(claudeVersionRetryDelayMs(3)).toBe(240_000);
    // Capped, so it keeps retrying forever without ever spinning.
    expect(claudeVersionRetryDelayMs(50)).toBe(15 * 60_000);

    const state = freshState();
    const probe = vi.fn<() => string | null>(() => null);
    resolveClaudeCliVersion(state, 0, probe); // failure 1 → retry at 60s
    resolveClaudeCliVersion(state, 30_000, probe); // still inside the window
    expect(probe).toHaveBeenCalledTimes(1);
    resolveClaudeCliVersion(state, 60_000, probe); // failure 2 → retry at 120s
    resolveClaudeCliVersion(state, 119_000, probe);
    expect(probe).toHaveBeenCalledTimes(2);
    resolveClaudeCliVersion(state, 180_001, probe);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('stays hermetic under vitest without recording a phantom failure', () => {
    // The guard returns before the probe, and — unlike the old code, which wrote
    // null into the cache here — leaves the cache untouched.
    expect(getClaudeCliVersion()).toBeNull();
    expect(getClaudeCliVersion()).toBeNull();
  });
});
