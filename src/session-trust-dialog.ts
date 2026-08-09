/**
 * @fileoverview Recognizing Claude Code's workspace-trust dialog on screen.
 *
 * Claude asks once per directory before it will read or edit anything:
 *
 *   Quick safety check: Is this a project you created or one you trust? ...
 *   ❯ 1. Yes, I trust this folder
 *     2. No, exit
 *   Enter to confirm · Esc to cancel
 *
 * Codeman sessions run permission-skipping or classifier-guarded modes, so the
 * answer is always yes, and a session parked on this dialog is simply stuck.
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
 * How long after the pane starts the dialog is still plausible. It renders
 * before the main UI, so this only has to cover a slow first launch; leaving it
 * open forever would let a transcript that quotes the dialog trigger an Enter.
 */
export const TRUST_DIALOG_WINDOW_MS = 90_000;

/** Minimum gap between two Enter presses, and between two screen reads. */
export const TRUST_DIALOG_RETRY_MS = 1500;

/**
 * Attempts before giving up and leaving the dialog to the user. A keystroke can
 * land while Ink is still mounting the widget and be dropped, which is the other
 * half of why sessions got stuck here; retrying costs nothing, but retrying
 * forever would hammer Enter into whatever came next.
 */
export const TRUST_DIALOG_MAX_ATTEMPTS = 3;

/**
 * How much of the append-only terminal buffer to read on a direct-PTY session,
 * which has no pane to capture. Small on purpose: the dialog scrolls out of a
 * short tail as soon as Claude repaints its main UI, which is what keeps a
 * fallback retry from firing at an already-answered dialog.
 */
export const TRUST_DIALOG_SCAN_BYTES = 4000;
