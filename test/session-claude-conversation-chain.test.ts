/**
 * @fileoverview Session.claudeSessionChain — the record of which Claude
 * conversations a pane has actually been on.
 *
 * Which conversation the response viewer reads is `Session.claudeSessionId`,
 * and `start()` reassigns it to the launch id at THREE separate points. That is
 * correct for a fresh pane and a lie for a re-attached one: a mux session that
 * survived a Codeman restart never stopped, so the CLI may have `/clear`ed hours
 * ago and moved to a conversation the launch id knows nothing about. The chain
 * is what carries that across the restart, and its tail must therefore outrank
 * the launch id on the restored path only.
 *
 * Two properties are pinned here because both were broken in ways nothing else
 * caught:
 *
 *  1. **Only a first-hand adoption extends the chain.** The id has to come from
 *     the CLI's own hook payload, delivered under the pane's `$CODEMAN_SESSION_ID`.
 *     A history-correlated guess writing into this record would make the
 *     "showed a stranger's conversation" bug permanent instead of transient.
 *  2. **A restored conversation survives every reset point.** The mux branch and
 *     the unconditional "third reset point" after it both reassign the field, so
 *     patching only the first leaves the restore silently undone.
 *
 * Port: N/A
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';

describe('Session claude conversation chain', () => {
  it('extends the chain only for a first-hand adoption', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    // A correlated guess: adopted for display, but never recorded.
    session.adoptClaudeSessionId('guessed-conversation');
    expect(session.claudeSessionId).toBe('guessed-conversation');
    expect(session.claudeSessionChain).toEqual([]);
    expect(session.claudeSessionIdIsFirstHand).toBe(false);

    // The CLI's own hook: recorded.
    session.adoptClaudeSessionId('hook-conversation', { firstHand: true });
    expect(session.claudeSessionChain).toEqual(['hook-conversation']);
    expect(session.claudeSessionIdIsFirstHand).toBe(true);
  });

  it('records a /clear successor once, however many prompts report it', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    session.adoptClaudeSessionId('conv-1', { firstHand: true });
    session.adoptClaudeSessionId('conv-1', { firstHand: true }); // every prompt reports the same id
    session.adoptClaudeSessionId('conv-2', { firstHand: true }); // the user ran /clear

    expect(session.claudeSessionChain).toEqual(['conv-1', 'conv-2']);
    expect(session.claudeSessionId).toBe('conv-2');
  });

  it('moves a resumed conversation to the tail instead of duplicating it', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    session.adoptClaudeSessionId('conv-1', { firstHand: true });
    session.adoptClaudeSessionId('conv-2', { firstHand: true });
    session.adoptClaudeSessionId('conv-1', { firstHand: true }); // /resume back

    expect(session.claudeSessionChain).toEqual(['conv-2', 'conv-1']);
  });

  it('round-trips the chain through toState and re-pins the conversation on restore', () => {
    const original = new Session({ workingDir: '/tmp', mode: 'claude' });
    original.adoptClaudeSessionId('conv-1', { firstHand: true });
    original.adoptClaudeSessionId('conv-2', { firstHand: true });

    const state = original.toState() as { claudeSessionChain?: string[] };
    expect(state.claudeSessionChain).toEqual(['conv-1', 'conv-2']);

    // Boot recovery rebuilds the pane from that state. The launch id would point
    // the viewer at the pre-/clear conversation; the chain's tail corrects it.
    const restored = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      id: original.id,
      claudeSessionChain: state.claudeSessionChain,
    });
    expect(restored.claudeSessionId).toBe('conv-2');
    // ⚠️ NOT restored: a persisted claim is not a fact. The pane re-earns the
    // guess-free path from its next hook.
    expect(restored.claudeSessionIdIsFirstHand).toBe(false);
  });

  it('omits the chain from toState when the pane never moved conversation', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    expect((session.toState() as { claudeSessionChain?: string[] }).claudeSessionChain).toBeUndefined();
  });

  it('applies the restored conversation at EVERY reset point in start()', () => {
    // ⚠️ Structural pin, not a behavioural one: exercising start() needs a real
    // PTY and mux. start() reassigns _claudeSessionId at three points, and the
    // last one runs unconditionally AFTER the mux branch — so patching only the
    // mux branch leaves the restore silently undone, which is what shipped
    // before this existed. Every assignment built from the launch-id fallback
    // must therefore carry `restoredConversation` first.
    const source = readFileSync(resolve(import.meta.dirname, '../src/session.ts'), 'utf8');
    // The tail of the chain grows as each CLI gains a resume alias of its own
    // (omp, then codex), so the pattern pins the two ends and lets the middle
    // widen. A `[^;]` run cannot cross a statement boundary, so each match is
    // still one assignment.
    const fallbackAssignments = source.match(/_claudeSessionId =[^;]*?_resumeSessionId[^;]*?this\.id;/g);
    expect(fallbackAssignments).not.toBeNull();
    expect(fallbackAssignments!.length).toBeGreaterThanOrEqual(2);
    for (const assignment of fallbackAssignments!) {
      expect(assignment).toContain('restoredConversation ||');
    }
  });

  it('leaves a fresh pane on its launch id', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    expect(session.claudeSessionId).toBe(session.id);
    expect(session.claudeSessionChain).toEqual([]);
  });
});
