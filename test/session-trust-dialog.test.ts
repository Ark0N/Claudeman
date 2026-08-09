/**
 * Workspace-trust dialog auto-accept.
 *
 * The bug this pins: `data.includes('trust this folder')` could never match,
 * because tmux repaints a row with cursor-forward escapes instead of spaces, so
 * the wire carries `I\x1b[Ctrust\x1b[Cthis\x1b[Cfolder`. Every session on a fresh
 * directory sat on the dialog until a human pressed Enter.
 *
 * RAW_DIALOG_CHUNK below is a verbatim slice of the PTY stream from a live
 * session parked on that dialog (Claude Code 2.1.220).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../src/session.js';
import { isTrustDialogScreen, compactScreenText, TRUST_DIALOG_MAX_ATTEMPTS } from '../src/session-trust-dialog.js';

/** Verbatim from the wire: note the `\x1b[C` where every space should be. */
const RAW_DIALOG_CHUNK =
  '\x1b[C\x1b[38;5;246m1.\x1b[C\x1b[38;5;153mYes,\x1b[CI\x1b[Ctrust\x1b[Cthis\x1b[Cfolder\x1b[15;4H' +
  '\x1b[38;5;246m2.\x1b[C\x1b[39mNo,\x1b[Cexit\x1b[17;2H\x1b[38;5;246mEnter\x1b[Cto\x1b[Cconfirm\x1b[C·\x1b[CEsc\x1b[Cto\x1b[Ccancel';

/** What `tmux capture-pane -p` shows for the same moment. */
const RENDERED_DIALOG = [
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  ' project, or work from your team). If not, take a moment to review what is in this folder first.',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/** An ordinary working session: no dialog anywhere. */
const RENDERED_MAIN_UI = [
  '✻ Actualizing… (13m 23s · ↓ 47.5k tokens)',
  '────────────────────────────────',
  '❯ ',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

describe('isTrustDialogScreen', () => {
  it('sees the dialog in the raw space-less repaint', () => {
    // The whole point: the literal phrase is NOT in this chunk.
    expect(RAW_DIALOG_CHUNK.includes('trust this folder')).toBe(false);
    expect(isTrustDialogScreen(RAW_DIALOG_CHUNK)).toBe(true);
  });

  it('sees the dialog in the rendered screen', () => {
    expect(isTrustDialogScreen(RENDERED_DIALOG)).toBe(true);
  });

  it('does not fire on a normal session screen', () => {
    expect(isTrustDialogScreen(RENDERED_MAIN_UI)).toBe(false);
    expect(isTrustDialogScreen('')).toBe(false);
  });

  it('does not fire on text that merely quotes the dialog', () => {
    // An agent reading or writing about this feature (this file, for one) must
    // not cause an Enter press. The confirm affordance is what separates the
    // widget from prose about it.
    expect(isTrustDialogScreen('the installer asks you to trust this folder before it runs')).toBe(false);
    expect(isTrustDialogScreen('press Enter to confirm the release')).toBe(false);
  });

  it('compacts away both real spaces and the escapes tmux sends instead', () => {
    expect(compactScreenText('I\x1b[Ctrust\x1b[Cthis\x1b[Cfolder')).toBe('itrustthisfolder');
    expect(compactScreenText('I trust this folder')).toBe('itrustthisfolder');
  });
});

describe('Session trust-dialog auto-accept', () => {
  afterEach(() => vi.useRealTimers());

  /** A session whose pane renders `screen`, recording everything written to it. */
  function sessionShowing(screen: () => string) {
    const writes: string[] = [];
    const mux = {
      isAvailable: () => true,
      capturePaneText: () => screen(),
      sendInput: (_id: string, data: string) => {
        writes.push(data);
        return Promise.resolve(true);
      },
    };
    const session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      mux,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    } as ConstructorParameters<typeof Session>[0]);
    const internals = session as unknown as {
      _maybeAcceptTrustDialog(): void;
      _interactiveStartedAt: number;
    };
    internals._interactiveStartedAt = Date.now();
    return { session, writes, tick: () => internals._maybeAcceptTrustDialog() };
  }

  it('presses Enter when the dialog is on screen', () => {
    vi.useFakeTimers();
    const { writes, tick } = sessionShowing(() => RENDERED_DIALOG);
    tick();
    expect(writes).toEqual(['\r']);
  });

  it('retries a dropped keystroke, then gives up rather than typing forever', () => {
    vi.useFakeTimers();
    // Ink can drop a keystroke while it is still mounting the widget, so one
    // press is not always enough; a stuck dialog must not become an Enter loop.
    const { writes, tick } = sessionShowing(() => RENDERED_DIALOG);
    for (let i = 0; i < 20; i++) {
      tick();
      vi.advanceTimersByTime(2000);
    }
    expect(writes.length).toBe(TRUST_DIALOG_MAX_ATTEMPTS);
  });

  it('stops once the dialog is answered', () => {
    vi.useFakeTimers();
    let screen = RENDERED_DIALOG;
    const { writes, tick } = sessionShowing(() => screen);
    tick();
    expect(writes).toEqual(['\r']);

    screen = RENDERED_MAIN_UI;
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2000);
      tick();
    }
    expect(writes).toEqual(['\r']);
  });

  it('never answers a dialog-looking screen outside the startup window', () => {
    vi.useFakeTimers();
    // A live agent can print this text hours in; only a launching pane can be
    // showing the real widget.
    const { writes, tick } = sessionShowing(() => RENDERED_DIALOG);
    vi.advanceTimersByTime(10 * 60_000);
    tick();
    expect(writes).toEqual([]);
  });

  it('does not press Enter on a normal screen', () => {
    vi.useFakeTimers();
    const { writes, tick } = sessionShowing(() => RENDERED_MAIN_UI);
    for (let i = 0; i < 5; i++) {
      tick();
      vi.advanceTimersByTime(2000);
    }
    expect(writes).toEqual([]);
  });
});
