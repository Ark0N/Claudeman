import { describe, expect, it } from 'vitest';
import { Session, isAltScreenStripMode, isMuxAltScreenOnlyStripMode } from '../src/session.js';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
};

function handleOutput(session: Session, data: string): void {
  (session as unknown as SessionInternals)._handleTerminalOutput(data);
}

describe('isAltScreenStripMode', () => {
  it('strips for the controlled TUIs (codex + claude), not shell/opencode', () => {
    expect(isAltScreenStripMode('codex')).toBe(true);
    expect(isAltScreenStripMode('claude')).toBe(true);
    expect(isAltScreenStripMode('shell')).toBe(false);
    expect(isAltScreenStripMode('opencode')).toBe(false);
  });
});

describe('Claude terminal scrollback strip', () => {
  it('strips alt-screen toggles, scrollback-erase, and mouse-tracking', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(session, '\x1b[?1049h\x1b[55;1Hdialog\x1b[3J\x1b[?1006h\x1b[?1049l');

    expect(emitted[0]).toBe('\x1b[55;1Hdialog');
    expect(session.terminalBuffer).toBe('\x1b[55;1Hdialog');
  });

  it('keeps the visible-screen erase (2J / [J) — only scrollback-erase (3J) is dropped', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    handleOutput(session, '\x1b[?1049h\x1b[2Jvisible\x1b[3Jscrollback\x1b[?1049l');

    expect(session.terminalBuffer).toBe('\x1b[2Jvisiblescrollback');
  });

  it('preserves an ordinary erase-display redraw (no scrollback sequences)', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    handleOutput(session, '\x1b[H\x1b[Jclaude redraw');

    expect(session.terminalBuffer).toBe('\x1b[H\x1b[Jclaude redraw');
  });

  it('strips sequences split across PTY chunk boundaries (carry reassembly)', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(session, 'before\x1b[?104');
    handleOutput(session, '9h\x1b[2Jafter\x1b[3');
    handleOutput(session, 'Jtail');

    expect(session.terminalBuffer).toBe('before\x1b[2Jaftertail');
    expect(emitted).toEqual(['before', '\x1b[2Jafter', 'tail']);
  });

  it('emits nothing for a chunk that is only a partial CSI, then completes it', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(session, '\x1b[?100'); // pure partial — held, nothing emitted
    handleOutput(session, '6h done'); // completes ?1006h (stripped); rest passes

    expect(emitted).toEqual([' done']);
    expect(session.terminalBuffer).toBe(' done');
  });

  it('does not touch ordinary Claude conversation output', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    const text = 'Here is line one\r\nHere is line two\r\n\x1b[2mdim status\x1b[0m';
    handleOutput(session, text);

    expect(session.terminalBuffer).toBe(text);
  });
});

describe('Shell terminal output on a DIRECT PTY is NOT stripped (vim/less/htop need the alt screen)', () => {
  it('leaves alt-screen toggles, scrollback-erase, and mouse-tracking intact for shell', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });

    const vimLike = '\x1b[?1049h\x1b[?1002h\x1b[2J~ editing\x1b[3J\x1b[?1002l\x1b[?1049l';
    handleOutput(session, vimLike);

    expect(session.terminalBuffer).toBe(vimLike);
  });
});

describe('isMuxAltScreenOnlyStripMode', () => {
  it('covers exactly the modes the full strip does not, and only under tmux', () => {
    for (const mode of ['shell', 'opencode', 'antigravity'] as const) {
      expect(isMuxAltScreenOnlyStripMode(mode, true)).toBe(true);
      // Direct-PTY fallback: the program's own alt screen really does reach xterm.
      expect(isMuxAltScreenOnlyStripMode(mode, false)).toBe(false);
    }
    // The full strip already owns these; never double-gate them here.
    for (const mode of ['claude', 'codex', 'gemini'] as const) {
      expect(isMuxAltScreenOnlyStripMode(mode, true)).toBe(false);
    }
  });
});

describe('tmux-backed shell: strip tmux’s own client smcup, keep everything else (#205)', () => {
  it('drops alt-screen toggles so xterm keeps a scrollback buffer', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell', useMux: true });

    // What a real `tmux attach` emits as its first bytes.
    handleOutput(session, '\x1b[?1049h\x1b[22;0;0t\x1b[?1h\x1b=\x1b[H\x1b[2Jprompt$ ');

    expect(session.terminalBuffer).toBe('\x1b[22;0;0t\x1b[?1h\x1b=\x1b[H\x1b[2Jprompt$ ');
    expect(session.terminalBuffer).not.toContain('\x1b[?1049h');
  });

  it('KEEPS 3J and mouse-tracking, unlike the full strip', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell', useMux: true });

    // `clear` legitimately wipes scrollback; htop/vim mouse modes are passed
    // through by tmux even with `mouse off` and must keep working.
    handleOutput(session, '\x1b[3J\x1b[?1002h\x1b[?1006hhtop\x1b[?1006l\x1b[?1002l');

    expect(session.terminalBuffer).toBe('\x1b[3J\x1b[?1002h\x1b[?1006hhtop\x1b[?1006l\x1b[?1002l');
  });

  it('reassembles alt-screen sequences split across PTY chunk boundaries', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell', useMux: true });
    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(session, 'before\x1b[?104');
    handleOutput(session, '9h after');

    expect(session.terminalBuffer).toBe('before after');
    expect(emitted).toEqual(['before', ' after']);
  });

  it('applies to opencode and antigravity too', () => {
    for (const mode of ['opencode', 'antigravity'] as const) {
      const session = new Session({ workingDir: '/tmp', mode, useMux: true });
      handleOutput(session, '\x1b[?1049hTUI\x1b[3J');
      expect(session.terminalBuffer).toBe('TUI\x1b[3J');
    }
  });
});

/**
 * Whatever the strip removes, the server has to remember, because after it runs
 * nothing downstream can ever see it. The browser hand-encodes click reports for
 * these modes (`_sendSyntheticSgrTap`), and with no state to consult it did that
 * on EVERY click, delivering mouse reports to a CLI that never asked for them.
 */
describe('stripped mouse-tracking state', () => {
  const trackingOf = (session: Session) => session.toState().cliMouseTracking;

  it('starts off, and stays off for output that never enables tracking', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    expect(trackingOf(session)).toBeUndefined();

    handleOutput(session, 'plain output\x1b[?1049h\x1b[3J');

    expect(trackingOf(session)).toBeUndefined();
  });

  it('follows the CLI enabling and disabling a tracking mode', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const changes: boolean[] = [];
    session.on('mouseTrackingChanged', (active: boolean) => changes.push(active));

    handleOutput(session, '\x1b[?1002hdialog');
    expect(trackingOf(session)).toBe(true);

    handleOutput(session, '\x1b[?1002ldismissed');
    expect(trackingOf(session)).toBeUndefined();
    expect(changes).toEqual([true, false]);
  });

  it('ignores encoding and alt-scroll modes, which do not ask about clicks', () => {
    // 1005/1006 pick an ENCODING and 1007 is alt-scroll. Counting them would put
    // the stray reports straight back: a CLI can select SGR encoding without ever
    // asking to be told where the user clicked.
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    handleOutput(session, '\x1b[?1006h\x1b[?1005h\x1b[?1007h');

    expect(trackingOf(session)).toBeUndefined();
  });

  it('stays on until the LAST tracking mode goes away', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    handleOutput(session, '\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    expect(trackingOf(session)).toBe(true);

    // A TUI may disable a mode it never enabled; that must not clear the rest.
    handleOutput(session, '\x1b[?1003l');
    expect(trackingOf(session)).toBe(true);

    handleOutput(session, '\x1b[?1000l');
    expect(trackingOf(session)).toBe(true);

    handleOutput(session, '\x1b[?1002l');
    expect(trackingOf(session)).toBeUndefined();
  });

  it('emits only on a real transition, so a repainting TUI costs nothing', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const changes: boolean[] = [];
    session.on('mouseTrackingChanged', (active: boolean) => changes.push(active));

    handleOutput(session, '\x1b[?1002h\x1b[?1002h\x1b[?1002h');

    expect(changes).toEqual([true]);
  });

  it('sees a sequence split across PTY chunks, like the strip that carries it', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    handleOutput(session, 'before\x1b[?100');
    handleOutput(session, '2h after');

    expect(session.terminalBuffer).toBe('before after');
    expect(trackingOf(session)).toBe(true);
  });

  it('tracks nothing for a mode whose DECSETs are never stripped', () => {
    // shell keeps its mouse DECSETs, so xterm sees them and owns the reporting.
    // A flag set here would mean a SECOND, hand-encoded report on every click.
    const session = new Session({ workingDir: '/tmp', mode: 'shell', useMux: true });

    handleOutput(session, '\x1b[?1002hhtop');

    expect(trackingOf(session)).toBeUndefined();
    expect(session.terminalBuffer).toBe('\x1b[?1002hhtop');
  });
});
