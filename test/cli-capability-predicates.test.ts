/**
 * @fileoverview Pins the three deliberately-INDEPENDENT capability predicates
 * (`isExternalCliMode`, `isAltScreenStripMode`, `hooksAvailableForMode`) against the stock
 * CLI registry, and reproduces the exact bug that made them independent in the first place:
 * `shell` has no hooks but is NOT an "external CLI", so `!isExternalCliMode()` used to wrongly
 * accept `until=stop` on a shell session and hang for the caller's whole timeout (a plain bash
 * PTY with no Claude Code and no hooks installed never fires `stop`).
 *
 * If a future change collapses any of these three into a derivation of another, the "shell"
 * row below is what catches it: shell is external=false, hooks=false, altScreen='preserve' —
 * a combination none of the other six stock CLIs share, so no single-field shortcut can
 * reproduce all three of shell's answers at once.
 *
 * Port: N/A (pure functions, no server).
 */

import { describe, expect, it } from 'vitest';
import { isExternalCliMode, isAltScreenStripMode } from '../src/session.js';
import { hooksAvailableForMode } from '../src/web/session-wait-registry.js';
import type { SessionMode } from '../src/types/session.js';

describe('CLI capability predicates stay independent', () => {
  it.each<{ mode: SessionMode; external: boolean; altScreenStrip: boolean; hooks: boolean }>([
    { mode: 'claude', external: false, altScreenStrip: true, hooks: true },
    { mode: 'shell', external: false, altScreenStrip: false, hooks: false },
    { mode: 'opencode', external: true, altScreenStrip: false, hooks: false },
    { mode: 'codex', external: true, altScreenStrip: true, hooks: false },
    { mode: 'gemini', external: true, altScreenStrip: true, hooks: false },
    { mode: 'antigravity', external: true, altScreenStrip: false, hooks: false },
    { mode: 'pi', external: true, altScreenStrip: false, hooks: false },
  ])(
    '$mode: external=$external altScreenStrip=$altScreenStrip hooks=$hooks',
    ({ mode, external, altScreenStrip, hooks }) => {
      expect(isExternalCliMode(mode)).toBe(external);
      expect(isAltScreenStripMode(mode)).toBe(altScreenStrip);
      expect(hooksAvailableForMode(mode)).toBe(hooks);
    }
  );

  it('the historic bug: shell is not external, so hook-only wait signals must still be rejected for it', () => {
    // The bug was reasoning `!isExternalCliMode(mode)` implies "hooks work here". It does
    // not — shell falls through both checks. Assert the two predicates disagree on shell,
    // which is exactly the case a derived predicate could not represent.
    expect(isExternalCliMode('shell')).toBe(false);
    expect(hooksAvailableForMode('shell')).toBe(false);
  });

  it('no two of the three predicates are equivalent across the whole stock catalog', () => {
    const modes: SessionMode[] = ['claude', 'shell', 'opencode', 'codex', 'gemini', 'antigravity', 'pi'];
    const external = modes.map(isExternalCliMode);
    const altScreen = modes.map(isAltScreenStripMode);
    const hooks = modes.map(hooksAvailableForMode);

    expect(external).not.toEqual(altScreen);
    expect(external).not.toEqual(hooks);
    expect(altScreen).not.toEqual(hooks);
  });

  it('an unregistered mode defaults conservatively: external (no claude-only assumptions), no hooks', () => {
    const unknown = 'totally-unregistered-cli' as SessionMode;
    expect(isExternalCliMode(unknown)).toBe(true);
    expect(hooksAvailableForMode(unknown)).toBe(false);
  });
});
