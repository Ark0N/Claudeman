/**
 * @fileoverview Unit tests for the decisions `codeman tui` makes, without a
 * terminal.
 *
 * Everything the app does that can be stated as a function of its inputs is
 * exported from `tui-app.ts` for exactly this reason: the attach handoff (which
 * changes shape inside tmux), the typed kill confirmation, the footer's honest
 * key inventory, the repaint test and the row building for degraded mode. The
 * full-screen loop itself is covered end-to-end under node-pty in
 * `tui-e2e.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  applyMuxNames,
  buildListLines,
  confirmAccepts,
  confirmKillStep,
  footerKeysFor,
  helpKeysFor,
  isSelfSession,
  planAttach,
  sameFrame,
  shouldAnimate,
  tmuxRowsToSessions,
  tmuxSocketFromEnv,
} from '../../src/tui/tui-app.js';
import { createTuiModel } from '../../src/tui/tui-model.js';
import { glyphsFor } from '../../src/tui/tui-render.js';
import type { TuiTmuxSession } from '../../src/tui/tui-client.js';
import type { TuiConfirmState, TuiRow, TuiSessionRow } from '../../src/tui/tui-types.js';

const GLYPHS = glyphsFor('unicode');

function tmuxSession(overrides: Partial<TuiTmuxSession> & { muxName: string }): TuiTmuxSession {
  return {
    sessionIdPrefix: overrides.muxName.replace(/^codeman-/, ''),
    attached: false,
    ...overrides,
  };
}

function row(state: TuiRow['state'], sessionId = 'abcdef0123'): TuiRow {
  const session: TuiSessionRow = { sessionId, sources: ['live'] };
  return { session, state, group: state === 'working' ? 'working' : 'idle', since: 0 };
}

describe('tmuxSocketFromEnv', () => {
  it('reads the socket name out of a $TMUX value', () => {
    expect(tmuxSocketFromEnv('/tmp/tmux-1000/codeman,31415,0')).toBe('codeman');
    expect(tmuxSocketFromEnv('/tmp/tmux-1000/codeman-beta,7,2')).toBe('codeman-beta');
    // A bare default socket is still the name a `-L` comparison needs.
    expect(tmuxSocketFromEnv('/tmp/tmux-1000/default,7,2')).toBe('default');
  });

  it('reports "not inside tmux" for an absent or empty value', () => {
    expect(tmuxSocketFromEnv(undefined)).toBeNull();
    expect(tmuxSocketFromEnv('')).toBeNull();
    expect(tmuxSocketFromEnv('   ')).toBeNull();
  });
});

describe('planAttach', () => {
  it('attaches with the instance socket when the terminal is not inside tmux', () => {
    const plan = planAttach('codeman-abcdef01', { socket: 'codeman' });
    expect(plan).toEqual({
      kind: 'attach',
      file: 'tmux',
      args: ['-L', 'codeman', 'attach-session', '-t', 'codeman-abcdef01'],
      hint: expect.stringContaining('Ctrl+B D'),
    });
  });

  it('switches the current client when already inside tmux on the same socket', () => {
    const plan = planAttach('codeman-abcdef01', { socket: 'codeman', tmux: '/tmp/tmux-1000/codeman,31415,0' });
    expect(plan).toEqual({
      kind: 'switch',
      file: 'tmux',
      args: ['-L', 'codeman', 'switch-client', '-t', 'codeman-abcdef01'],
    });
  });

  it('refuses to nest when the surrounding tmux is a different server', () => {
    const plan = planAttach('codeman-abcdef01', { socket: 'codeman', tmux: '/tmp/tmux-1000/default,31415,0' });
    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') throw new Error('expected a refusal');
    expect(plan.reason).toBe('nested-foreign-socket');
    expect(plan.message).toContain('default');
    expect(plan.message).toContain('codeman');
  });

  it('refuses a row with no tmux session behind it', () => {
    for (const name of [undefined, '', '   ']) {
      const plan = planAttach(name, { socket: 'codeman' });
      expect(plan.kind).toBe('refuse');
      if (plan.kind !== 'refuse') throw new Error('expected a refusal');
      expect(plan.reason).toBe('no-mux-name');
    }
  });

  it('never builds a shell string: every field is its own argv entry', () => {
    const plan = planAttach('codeman-abcdef01', { socket: 'codeman' });
    if (plan.kind !== 'attach') throw new Error('expected an attach');
    expect(plan.args.some((arg) => arg.includes(' '))).toBe(false);
  });
});

describe('isSelfSession', () => {
  const id = 'abcdef01-2345-6789-abcd-ef0123456789';

  it('recognizes the session the TUI runs in, however the id was truncated', () => {
    expect(isSelfSession(id, { CODEMAN_SESSION_ID: id })).toBe(true);
    expect(isSelfSession(id, { CODEMAN_SESSION_ID: 'abcdef01' })).toBe(true);
    expect(isSelfSession('abcdef01', { CODEMAN_SESSION_ID: id })).toBe(true);
  });

  it('is false for another session, and for env that identifies nothing', () => {
    expect(isSelfSession(id, { CODEMAN_SESSION_ID: 'ffffffff' })).toBe(false);
    expect(isSelfSession(id, {})).toBe(false);
    expect(isSelfSession(id, { CODEMAN_SESSION_ID: 'abc' })).toBe(false);
  });
});

describe('the kill confirmation', () => {
  const state: TuiConfirmState = { sessionId: 'abcdef01-2345', name: 'w4-api', typed: '' };

  it('accepts the shown name or the id prefix a mux name carries, and nothing else', () => {
    expect(confirmAccepts(state, 'w4-api')).toBe(true);
    expect(confirmAccepts(state, '  w4-api  ')).toBe(true);
    expect(confirmAccepts(state, 'abcdef01')).toBe(true);
    expect(confirmAccepts(state, 'w4')).toBe(false);
    expect(confirmAccepts(state, 'W4-API')).toBe(false);
    expect(confirmAccepts(state, '')).toBe(false);
    expect(confirmAccepts(state, '   ')).toBe(false);
  });

  it('types, backspaces and cancels', () => {
    expect(confirmKillStep({ ...state, typed: 'w4' }, { type: 'char', value: '-' })).toEqual({
      kind: 'typing',
      typed: 'w4-',
    });
    expect(confirmKillStep({ ...state, typed: 'w4-' }, { type: 'backspace' })).toEqual({ kind: 'typing', typed: 'w4' });
    expect(confirmKillStep({ ...state, typed: '' }, { type: 'backspace' })).toEqual({ kind: 'typing', typed: '' });
    expect(confirmKillStep(state, { type: 'escape' })).toEqual({ kind: 'cancel' });
    expect(confirmKillStep(state, { type: 'ctrl', key: 'c' })).toEqual({ kind: 'cancel' });
    expect(confirmKillStep(state, { type: 'ctrl', key: 'a' })).toEqual({ kind: 'ignore' });
    expect(confirmKillStep(state, { type: 'tab' })).toEqual({ kind: 'ignore' });
  });

  it('confirms only on a match, and says so rather than doing nothing otherwise', () => {
    expect(confirmKillStep({ ...state, typed: 'w4-api' }, { type: 'enter' })).toEqual({ kind: 'confirm' });
    expect(confirmKillStep({ ...state, typed: 'w4' }, { type: 'enter' })).toEqual({ kind: 'reject' });
    expect(confirmKillStep({ ...state, typed: '' }, { type: 'enter' })).toEqual({ kind: 'reject' });
  });

  it('backspaces one whole character, not one code unit', () => {
    expect(confirmKillStep({ ...state, typed: 'a🙂' }, { type: 'backspace' })).toEqual({ kind: 'typing', typed: 'a' });
  });
});

describe('footerKeysFor', () => {
  it('advertises only the verbs this build implements', () => {
    const keys = footerKeysFor('list', GLYPHS, { server: true }).join(' ');
    expect(keys).toContain('attach');
    expect(keys).toContain('1-9 jump');
    expect(keys).toContain('n new');
    expect(keys).toContain('x kill');
    expect(keys).toContain('q quit');
    for (const missing of ['prompt', 'search', 'digest', 'answer', 'resume']) {
      expect(keys).not.toContain(missing);
    }
  });

  it('drops the server-only verbs in degraded mode', () => {
    const keys = footerKeysFor('list', GLYPHS, { server: false }).join(' ');
    expect(keys).toContain('attach');
    expect(keys).not.toContain('kill');
    expect(keys).not.toContain('new');
  });

  it('keeps the help overlay to the same inventory', () => {
    const help = helpKeysFor(GLYPHS, { server: true });
    expect(help.map(([, description]) => description)).toEqual(
      expect.arrayContaining(['attach', 'new session', 'kill (typed confirmation)', 'quit'])
    );
    expect(help.flat().join(' ')).not.toContain('search');
    expect(helpKeysFor(GLYPHS, { server: false }).flat().join(' ')).not.toContain('kill');
  });

  it('follows the overlay that owns the keyboard', () => {
    expect(footerKeysFor('help', GLYPHS, { server: true })).toEqual(['esc close']);
    expect(footerKeysFor('confirm-kill', GLYPHS, { server: true }).join(' ')).toContain('type the name');
    expect(footerKeysFor('message', GLYPHS, { server: true })).toEqual(['esc dismiss']);
    expect(footerKeysFor('new-session', GLYPHS, { server: true }).join(' ')).toContain('type to filter');
  });
});

describe('the repaint test', () => {
  const key = { revision: 3, cols: 100, rows: 30, tick: 0 };

  it('repaints on a first frame, a state change, a resize and a tick', () => {
    expect(sameFrame(null, key)).toBe(false);
    expect(sameFrame(key, { ...key, revision: 4 })).toBe(false);
    expect(sameFrame(key, { ...key, cols: 80 })).toBe(false);
    expect(sameFrame(key, { ...key, rows: 24 })).toBe(false);
    expect(sameFrame(key, { ...key, tick: 1 })).toBe(false);
  });

  it('writes nothing when nothing changed', () => {
    expect(sameFrame(key, { ...key })).toBe(true);
  });

  it('only animates while a WORKING row is on screen', () => {
    expect(shouldAnimate([row('idle'), row('recent')])).toBe(false);
    expect(shouldAnimate([row('idle'), row('working', 'bbbb1111')])).toBe(true);
    expect(shouldAnimate([])).toBe(false);
  });
});

describe('degraded-mode rows', () => {
  const sessions: TuiTmuxSession[] = [
    tmuxSession({ muxName: 'codeman-abcdef01', sessionId: 'abcdef01-2345', name: 'w4-api', workingDir: '/dev/api' }),
    tmuxSession({ muxName: 'codeman-99887766', createdAt: 1_000_000 }),
  ];

  it('keeps the tmux name and falls back to it as the row key', () => {
    const rows = tmuxRowsToSessions(sessions);
    expect(rows[0]).toMatchObject({
      sessionId: 'abcdef01-2345',
      muxName: 'codeman-abcdef01',
      name: 'w4-api',
      workingDir: '/dev/api',
    });
    // No state.json entry: the mux name is the only identity there is.
    expect(rows[1].sessionId).toBe('codeman-99887766');
    expect(rows[1].muxName).toBe('codeman-99887766');
  });

  it('classifies a running pane as IDLE rather than history', () => {
    const model = createTuiModel();
    model.replaceSessions(tmuxRowsToSessions(sessions));
    const groups = model.groups();
    expect(groups.find((group) => group.key === 'idle')?.rows).toHaveLength(2);
    expect(groups.find((group) => group.key === 'recent')?.rows).toHaveLength(0);
    expect(model.sessionCount).toBe(2);
  });
});

describe('applyMuxNames', () => {
  const tmux: TuiTmuxSession[] = [
    tmuxSession({ muxName: 'codeman-abcdef01', sessionId: 'abcdef01-2345-6789' }),
    tmuxSession({ muxName: 'codeman-99887766' }),
  ];

  it('joins on the 8-character prefix a mux name carries', () => {
    const rows = applyMuxNames(
      [
        { sessionId: 'abcdef01-2345-6789', sources: ['live'] },
        { sessionId: '99887766-0000-1111', sources: ['live'] },
        { sessionId: 'deadbeef-0000-1111', sources: ['history'] },
      ],
      tmux
    );
    expect(rows[0].muxName).toBe('codeman-abcdef01');
    expect(rows[1].muxName).toBe('codeman-99887766');
    // Nothing in tmux backs it, so attach has to refuse rather than guess.
    expect(rows[2].muxName).toBeUndefined();
  });

  it('copies rather than mutating its input, and survives an empty tmux list', () => {
    const input: TuiSessionRow[] = [{ sessionId: 'abcdef01-2345-6789', sources: ['live'] }];
    const rows = applyMuxNames(input, []);
    expect(rows[0]).not.toBe(input[0]);
    expect(rows[0].muxName).toBeUndefined();
    expect(input[0].muxName).toBeUndefined();
  });
});

describe('buildListLines', () => {
  it('numbers rows in the dashboard order, so `tui <n>` and `tui --list` agree', () => {
    const model = createTuiModel();
    model.replaceSessions([
      { sessionId: 'aaaa1111', name: 'quiet', sources: ['live'], lastActivityAt: 10 },
      { sessionId: 'bbbb2222', name: 'busy', sources: ['live'], isWorking: true, lastSubmitAt: 5 },
      { sessionId: 'cccc3333', name: 'past', sources: ['history'], lastActivityAt: 1 },
    ]);
    expect(buildListLines(model.rows())).toEqual([
      { index: 1, state: 'working', label: 'busy', workingDir: '' },
      { index: 2, state: 'idle', label: 'quiet', workingDir: '' },
      { index: 3, state: 'recent', label: 'past', workingDir: '' },
    ]);
  });

  it('truncates the label so one long prompt cannot pad the whole table', () => {
    const model = createTuiModel();
    model.replaceSessions([{ sessionId: 'aaaa1111', firstPrompt: 'x'.repeat(200), sources: ['history'] }]);
    const [line] = buildListLines(model.rows(), 20);
    expect(line.label).toHaveLength(20);
    expect(line.label.endsWith('…')).toBe(true);
  });
});
