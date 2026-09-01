/**
 * @fileoverview Recognizing Claude Code's workspace-trust dialog on screen, and
 * working out which keystroke answers it.
 *
 * Claude asks once per directory before it will read or edit anything. The
 * layout has changed under us at least twice; both of these are live shapes:
 *
 *   Quick safety check: Is this a project you created or one you trust? ...     (<= 2.1.220)
 *   ❯ 1. Yes, I trust this folder
 *     2. No, exit
 *   Enter to confirm · Esc to cancel
 *
 *   Quick safety check: Is this a project you created or one you trust? ...     (2.1.252)
 *   Security guide
 *   ❯ No, exit
 *     Yes, I trust this folder
 *   Enter to confirm · Esc to cancel
 *
 * Codeman sessions run permission-skipping or classifier-guarded modes, so the
 * answer is always yes, and a session parked on this dialog is simply stuck.
 *
 * ⚠️ **Never press Enter without reading the selection.** The options are now
 * unnumbered, REVERSED, and the highlighted default is "No, exit" — so the blind
 * `\r` that answered the old layout picks *exit* on the new one and the pane
 * dies (`Pane is dead (status 1)`) seconds after the session starts, which is
 * exactly what a fresh case did on Claude Code 2.1.252. `trustDialogNextKey()`
 * reads the `❯` marker instead and moves the cursor onto the trust option before
 * it confirms anything.
 *
 * **Why the text has to be compacted.** tmux repaints a row by writing each word
 * and then a cursor-forward (`\x1b[C`) instead of a space, and Ink colours each
 * word separately, so the wire carries `I\x1b[Ctrust\x1b[Cthis\x1b[Cfolder`.
 * Stripping the escapes leaves `Itrustthisfolder`: the spaces are not there to
 * strip, they were never sent. A plain `includes('trust this folder')` therefore
 * never matched a single chunk, which is why the auto-accept had been silently
 * dead. Removing ALL whitespace instead is what survives both that repaint style
 * and the spaced full-screen redraw.
 *
 * **Why two markers are required.** Answering means pressing Enter, so a false
 * positive types into a live session. One phrase is not enough: an agent's own
 * transcript can quote it (this file does). Matching a trust phrase AND the
 * dialog's confirm affordance is the cheap way to require the actual widget, and
 * the caller adds the real guard by only looking during session startup.
 */

import { stripAnsi } from './utils/index.js';

/** Phrases from the question or the "yes" option, whitespace removed, lowercased. */
const TRUST_PHRASES = [
  'trustthisfolder', // 2.x: "1. Yes, I trust this folder"
  'trustthefiles', // older: "Do you trust the files in this folder?"
  'oneyoutrust', // 2.x question: "a project you created or one you trust?"
];

/** The dialog's own affordances. Prose that quotes the question will not have these. */
const CONFIRM_PHRASES = ['entertoconfirm', 'esctocancel', '2.no,exit'];

/** The option that answers yes, compacted. Identical text in both layouts. */
const YES_OPTION = 'yes,itrustthisfolder';

/** The option that quits Claude. It is the highlighted DEFAULT since 2.1.252. */
const NO_OPTION = 'no,exit';

/** Ink's selection marker. The only marked row while the dialog is up. */
const SELECTION_MARK = '❯';

/** A numbered option's `1.` / `2.` prefix, which the 2.1.220 layout put after the marker. */
const OPTION_NUMBER_PREFIX = /^\d+\./;

/** Move the selection one row down / up. Literal, so `send-keys -l` carries them. */
export const TRUST_KEY_DOWN = '\x1b[B';
export const TRUST_KEY_UP = '\x1b[A';

/** Confirm the highlighted option. */
export const TRUST_KEY_CONFIRM = '\r';

/**
 * Charset-select sequences (`ESC ( B`), which tmux emits around styled runs and
 * `stripAnsi` does not cover. Left in, they would land inside a phrase as a
 * literal `(B` and break the match.
 */
// eslint-disable-next-line no-control-regex
const CHARSET_SELECT = /\x1b[()][AB0]/g;

/**
 * Normalize a screen or PTY chunk for phrase matching: escapes dropped, every
 * whitespace run removed, lowercased.
 */
export function compactScreenText(text: string): string {
  return stripAnsi(text).replace(CHARSET_SELECT, '').replace(/\s+/g, '').toLowerCase();
}

/**
 * True when this text is the trust dialog rather than something merely talking
 * about it. Feed the RENDERED SCREEN where possible: the session's terminal
 * buffer is append-only, so the dialog stays in its tail long after it is gone.
 */
export function isTrustDialogScreen(text: string): boolean {
  const compact = compactScreenText(text);
  return TRUST_PHRASES.some((p) => compact.includes(p)) && CONFIRM_PHRASES.some((p) => compact.includes(p));
}

/**
 * Which option the `❯` marker sits on, or null when this text does not say.
 *
 * The LAST marked option wins. A pane capture holds exactly one frame and so
 * exactly one marker, but the direct-PTY fallback reads an append-only buffer
 * where every repaint since launch is still present — there the freshest frame
 * is the one at the end, and an older one must not out-vote it.
 */
function selectedTrustOption(compact: string): { at: number; option: 'yes' | 'no' } | null {
  let selected: { at: number; option: 'yes' | 'no' } | null = null;
  for (let at = compact.indexOf(SELECTION_MARK); at >= 0; at = compact.indexOf(SELECTION_MARK, at + 1)) {
    const after = compact.slice(at + SELECTION_MARK.length).replace(OPTION_NUMBER_PREFIX, '');
    if (after.startsWith(YES_OPTION)) selected = { at, option: 'yes' };
    else if (after.startsWith(NO_OPTION)) selected = { at, option: 'no' };
  }
  return selected;
}

/**
 * The single keystroke that moves this dialog one step closer to "yes", or null
 * when the screen does not show clearly enough to touch.
 *
 * One step per call on purpose: the caller re-reads the screen between
 * keystrokes, so a moved cursor is CONFIRMED before Enter is pressed rather than
 * assumed. Firing arrow+Enter together would re-create the failure this exists
 * to prevent whenever the arrow is dropped (Ink drops keystrokes while it is
 * still mounting a widget) — the Enter would then land on "No, exit".
 *
 * Returning null is the safe answer, not a failure: an unreadable frame means
 * wait for the next repaint, and a layout whose options this cannot name means
 * leave the dialog to the human. The caller's startup window bounds the waiting.
 */
export function trustDialogNextKey(text: string): string | null {
  const compact = compactScreenText(text);
  if (!compact.includes(YES_OPTION)) return null; // no trust option to steer onto
  const selected = selectedTrustOption(compact);
  if (!selected) return null; // marker missing, or not on an option we recognize
  if (selected.option === 'yes') return TRUST_KEY_CONFIRM;
  // On "No, exit". Which way the trust option lies is read from THIS frame — it
  // sits below in 2.1.252 and above in the numbered layout before it — so the
  // order flipping again costs a repaint, not a killed session.
  return compact.includes(YES_OPTION, selected.at) ? TRUST_KEY_DOWN : TRUST_KEY_UP;
}

/**
 * How long after the pane starts the dialog is still plausible. It renders
 * before the main UI, so this only has to cover a slow first launch; leaving it
 * open forever would let a transcript that quotes the dialog trigger an Enter.
 */
export const TRUST_DIALOG_WINDOW_MS = 90_000;

/** Minimum gap between two keystrokes, and between two screen reads. */
export const TRUST_DIALOG_RETRY_MS = 1500;

/**
 * Keystrokes before giving up and leaving the dialog to the user. A keystroke
 * can land while Ink is still mounting the widget and be dropped, which is the
 * other half of why sessions got stuck here; retrying costs nothing, but
 * retrying forever would hammer Enter into whatever came next.
 *
 * Six rather than three because answering is no longer one press: the 2.1.252
 * layout needs an arrow onto the trust option and then Enter, each confirmed
 * against a re-read of the screen, so a cap of three left only one dropped
 * keystroke of slack.
 */
export const TRUST_DIALOG_MAX_ATTEMPTS = 6;

/**
 * How much of the append-only terminal buffer to read on a direct-PTY session,
 * which has no pane to capture. Small on purpose: the dialog scrolls out of a
 * short tail as soon as Claude repaints its main UI, which is what keeps a
 * fallback retry from firing at an already-answered dialog.
 */
export const TRUST_DIALOG_SCAN_BYTES = 4000;
