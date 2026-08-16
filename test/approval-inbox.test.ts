/**
 * Approvals Inbox store unit tests (src/web/approval-inbox.ts).
 *
 * Pure in-memory registry: no ports, no server. Constructs its own
 * ApprovalInbox instances (never the process singleton) so tests cannot
 * leak state into the route tests that share the module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApprovalInbox,
  normalizeCapturedFrame,
  parseDialogOptions,
  type ApprovalItem,
  type ApprovalResolvedInfo,
} from '../src/web/approval-inbox.js';

const PERMISSION_FRAME = [
  ' Do you want to make this edit to foo.ts?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');

const TWO_OPTION_FRAME = [' Trust the files in this folder?', ' ❯ 1. Yes, proceed', '   2. No, exit'].join('\n');

// The live AskUserQuestion shape (measured on Claude Code v2.1.226): a
// description row under every option and a ─ separator before "Chat about this".
const ASK_USER_QUESTION_FRAME = [
  ' ☐ Color',
  ' Which color do you prefer?',
  '❯ 1. Red',
  '     Prefer red',
  '  2. Blue',
  '     Prefer blue',
  '  3. Green',
  '     Prefer green',
  '  4. Type something.',
  '────────────────────────────────────────',
  '  5. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

function collect(inbox: ApprovalInbox) {
  const pending: ApprovalItem[] = [];
  const updated: ApprovalItem[] = [];
  const resolved: ApprovalResolvedInfo[] = [];
  inbox.onPending = (i) => pending.push(i);
  inbox.onUpdated = (i) => updated.push(i);
  inbox.onResolved = (i) => resolved.push(i);
  return { pending, updated, resolved };
}

describe('parseDialogOptions', () => {
  it('parses a 3-option permission dialog with the ❯ cursor', () => {
    const options = parseDialogOptions(PERMISSION_FRAME);
    expect(options).toEqual([
      { n: 1, label: 'Yes' },
      { n: 2, label: 'Yes, allow all edits during this session (shift+tab)' },
      { n: 3, label: 'No, and tell Claude what to do differently (esc)' },
    ]);
  });

  it('parses a 2-option dialog', () => {
    expect(parseDialogOptions(TWO_OPTION_FRAME)).toHaveLength(2);
  });

  it('returns undefined when nothing parses', () => {
    expect(parseDialogOptions('just some terminal output\nwith no menu')).toBeUndefined();
    expect(parseDialogOptions(undefined)).toBeUndefined();
    // A single numbered line is not a dialog.
    expect(parseDialogOptions('1. lonely item')).toBeUndefined();
  });

  it('requires consecutive numbering from 1', () => {
    expect(parseDialogOptions('2. Yes\n3. No')).toBeUndefined();
  });

  it('takes the LAST complete block in the frame (dialogs render at the bottom)', () => {
    const frame = ['1. old option', '2. old option two', 'some output in between', TWO_OPTION_FRAME].join('\n');
    const options = parseDialogOptions(frame);
    expect(options?.[0].label).toBe('Yes, proceed');
  });

  it('caps option labels at 120 chars', () => {
    const long = 'x'.repeat(300);
    const options = parseDialogOptions(`1. ${long}\n2. No`);
    expect(options?.[0].label).toHaveLength(120);
  });

  it('parses the AskUserQuestion shape (descriptions between options, separator before the last)', () => {
    const options = parseDialogOptions(ASK_USER_QUESTION_FRAME);
    expect(options?.map((o) => o.label)).toEqual(['Red', 'Blue', 'Green', 'Type something.', 'Chat about this']);
  });

  it('a gap of more than 3 lines ends the option block', () => {
    const frame = ['1. Yes', '2. No', 'a', 'b', 'c', 'd', 'unrelated 3. text'].join('\n');
    const options = parseDialogOptions(frame);
    expect(options).toHaveLength(2);
  });
});

describe('normalizeCapturedFrame', () => {
  it('strips ANSI, right-trims, and drops trailing blank lines', () => {
    const raw = '\x1b[31mred\x1b[0m   \nline2\n\n\n';
    expect(normalizeCapturedFrame(raw)).toBe('red\nline2');
  });

  it('keeps only the last 30 lines', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const out = normalizeCapturedFrame(raw)!;
    expect(out.split('\n')).toHaveLength(30);
    expect(out.startsWith('line20')).toBe(true);
  });

  it('returns undefined for empty/null captures', () => {
    expect(normalizeCapturedFrame(null)).toBeUndefined();
    expect(normalizeCapturedFrame('\n\n')).toBeUndefined();
  });

  it('converts absolute row repaints (formatPaneSnapshot frames) into lines', () => {
    // The visible tmux capture carries NO newlines; every row is painted at
    // `ESC[<row>;1H`. Measured against a live dialog frame.
    const raw = '\x1b[12;1H Which color do you prefer?\x1b[13;1H❯ 1. Red\x1b[14;1H     Prefer red\x1b[15;1H  2. Blue';
    const out = normalizeCapturedFrame(raw)!;
    expect(out.split('\n')).toEqual([' Which color do you prefer?', '❯ 1. Red', '     Prefer red', '  2. Blue']);
    expect(parseDialogOptions(out)).toEqual([
      { n: 1, label: 'Red' },
      { n: 2, label: 'Blue' },
    ]);
  });

  it('turns mid-row cursor jumps into spaces instead of gluing words', () => {
    const out = normalizeCapturedFrame('\x1b[5;1Hstatus:\x1b[5;20Hready');
    expect(out).toBe('status: ready');
  });
});

describe('ApprovalInbox', () => {
  let inbox: ApprovalInbox;

  beforeEach(() => {
    vi.useFakeTimers();
    inbox = new ApprovalInbox();
  });

  afterEach(() => {
    inbox.stop();
    vi.useRealTimers();
  });

  it('notePrompt creates a pending item with parsed options and emits onPending', () => {
    const { pending } = collect(inbox);
    const item = inbox.notePrompt({
      sessionId: 's1',
      sessionName: 'w1-case',
      kind: 'permission',
      toolName: 'Edit',
      capture: () => PERMISSION_FRAME,
    });
    expect(item.options).toHaveLength(3);
    expect(item.context).toContain('Do you want to make this edit');
    expect(pending).toHaveLength(1);
    expect(inbox.listPending()).toHaveLength(1);
    expect(inbox.getById(item.id)?.id).toBe(item.id);
    expect(inbox.getForSession('s1')?.id).toBe(item.id);
  });

  it('a new prompt supersedes the session previous item', () => {
    const { resolved } = collect(inbox);
    const first = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission' });
    const second = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'question' });
    expect(inbox.listPending()).toHaveLength(1);
    expect(inbox.getById(first.id)).toBeUndefined();
    expect(inbox.getById(second.id)).toBeDefined();
    expect(resolved).toEqual([expect.objectContaining({ id: first.id, resolution: 'superseded' })]);
  });

  it('idle prompts never get digit options', () => {
    const item = inbox.notePrompt({
      sessionId: 's1',
      sessionName: 'w1',
      kind: 'idle',
      capture: () => PERMISSION_FRAME,
    });
    expect(item.options).toBeUndefined();
    expect(item.context).toBeDefined();
  });

  it('resolveForSession with a kinds filter skips other kinds (working-flap guard)', () => {
    const { resolved } = collect(inbox);
    inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission' });
    inbox.resolveForSession('s1', 'resolved_in_terminal', ['idle']);
    expect(inbox.listPending()).toHaveLength(1);

    inbox.notePrompt({ sessionId: 's2', sessionName: 'w2', kind: 'idle' });
    inbox.resolveForSession('s2', 'resolved_in_terminal', ['idle']);
    expect(inbox.getForSession('s2')).toBeUndefined();
    expect(resolved.filter((r) => r.resolution === 'resolved_in_terminal')).toHaveLength(1);
  });

  it('take removes as answered; restore re-inserts unless superseded', () => {
    const { resolved } = collect(inbox);
    const item = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission' });
    const taken = inbox.take(item.id)!;
    expect(taken.id).toBe(item.id);
    expect(inbox.take(item.id)).toBeUndefined();
    expect(resolved.at(-1)).toMatchObject({ id: item.id, resolution: 'answered' });

    inbox.restore(taken);
    expect(inbox.getById(item.id)).toBeDefined();

    // A newer prompt wins over a restore.
    const taken2 = inbox.take(item.id)!;
    const newer = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'question' });
    inbox.restore(taken2);
    expect(inbox.getForSession('s1')?.id).toBe(newer.id);
  });

  it('acknowledge marks an idle item seen without resolving it, and emits onUpdated once', () => {
    const { updated, resolved } = collect(inbox);
    const item = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'idle' });
    const acked = inbox.acknowledge('s1');
    expect(acked?.id).toBe(item.id);
    expect(acked?.acknowledgedAt).toBeGreaterThan(0);
    // Still pending and still answerable: the human looked, they did not answer.
    expect(inbox.getById(item.id)?.acknowledgedAt).toBeGreaterThan(0);
    expect(inbox.listPending()).toHaveLength(1);
    expect(resolved).toHaveLength(0);
    expect(updated).toEqual([expect.objectContaining({ id: item.id })]);
    // Idempotent: a second view does not re-broadcast.
    expect(inbox.acknowledge('s1')).toBeUndefined();
    expect(updated).toHaveLength(1);
  });

  it('acknowledge never touches a permission/question item (viewing is not answering)', () => {
    const { updated } = collect(inbox);
    const permission = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission' });
    expect(inbox.acknowledge('s1')).toBeUndefined();
    expect(inbox.getById(permission.id)?.acknowledgedAt).toBeUndefined();

    const question = inbox.notePrompt({ sessionId: 's2', sessionName: 'w2', kind: 'question' });
    expect(inbox.acknowledge('s2')).toBeUndefined();
    expect(inbox.getById(question.id)?.acknowledgedAt).toBeUndefined();
    expect(updated).toHaveLength(0);

    expect(inbox.acknowledge('nope')).toBeUndefined();
  });

  it('a new prompt after an acknowledgement arms the alert again', () => {
    inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'idle' });
    inbox.acknowledge('s1');
    const next = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'idle' });
    expect(next.acknowledgedAt).toBeUndefined();
    expect(inbox.getForSession('s1')?.acknowledgedAt).toBeUndefined();
  });

  it('dismiss removes without answering', () => {
    const { resolved } = collect(inbox);
    const item = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'question' });
    expect(inbox.dismiss(item.id)).toBe(true);
    expect(inbox.dismiss(item.id)).toBe(false);
    expect(resolved.at(-1)).toMatchObject({ resolution: 'dismissed' });
  });

  it('items expire after the TTL on read', () => {
    const { resolved } = collect(inbox);
    inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission' });
    vi.advanceTimersByTime(13 * 60 * 60 * 1000);
    expect(inbox.listPending()).toHaveLength(0);
    expect(resolved.at(-1)).toMatchObject({ resolution: 'expired' });
  });

  it('re-captures once after a short delay and emits onUpdated', () => {
    const { updated } = collect(inbox);
    let frame = 'still painting...';
    const item = inbox.notePrompt({
      sessionId: 's1',
      sessionName: 'w1',
      kind: 'permission',
      capture: () => frame,
    });
    expect(item.options).toBeUndefined();
    frame = PERMISSION_FRAME;
    vi.advanceTimersByTime(700);
    expect(updated).toHaveLength(1);
    expect(inbox.getById(item.id)?.options).toHaveLength(3);
  });

  it('the delayed re-capture never touches a superseded item', () => {
    let frame = 'first';
    const first = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission', capture: () => frame });
    const second = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'question', capture: () => frame });
    frame = PERMISSION_FRAME;
    const { updated } = collect(inbox);
    vi.advanceTimersByTime(700);
    expect(updated.every((i) => i.id !== first.id)).toBe(true);
    expect(inbox.getById(second.id)).toBeDefined();
  });

  describe('verifyStillAnswerable', () => {
    it('resolves the item and refuses when a parsed dialog left the screen', () => {
      const { resolved } = collect(inbox);
      let frame = PERMISSION_FRAME;
      const item = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission', capture: () => frame });
      expect(item.options).toHaveLength(3);
      frame = 'the dialog is gone, claude is typing';
      expect(inbox.verifyStillAnswerable(item.id)).toBe(false);
      expect(inbox.getById(item.id)).toBeUndefined();
      expect(resolved.at(-1)).toMatchObject({ id: item.id, resolution: 'resolved_in_terminal' });
    });

    it('refreshes context/options when the dialog is still up', () => {
      let frame = PERMISSION_FRAME;
      const item = inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission', capture: () => frame });
      frame = TWO_OPTION_FRAME;
      expect(inbox.verifyStillAnswerable(item.id)).toBe(true);
      expect(inbox.getById(item.id)?.options).toHaveLength(2);
    });

    it('is inconclusive (allows) for items that never parsed options', () => {
      const item = inbox.notePrompt({
        sessionId: 's1',
        sessionName: 'w1',
        kind: 'permission',
        capture: () => 'unparseable dialog',
      });
      expect(item.options).toBeUndefined();
      expect(inbox.verifyStillAnswerable(item.id)).toBe(true);
    });

    it('is true for unknown ids only as false (missing item refuses)', () => {
      expect(inbox.verifyStillAnswerable('nope:1')).toBe(false);
    });
  });

  it('stop() clears items and silences events', () => {
    const { resolved } = collect(inbox);
    inbox.notePrompt({ sessionId: 's1', sessionName: 'w1', kind: 'permission' });
    inbox.stop();
    expect(inbox.listPending()).toHaveLength(0);
    expect(resolved).toHaveLength(0);
  });
});
