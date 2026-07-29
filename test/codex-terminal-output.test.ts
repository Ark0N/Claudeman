import { describe, expect, it } from 'vitest';
import { Session, type TerminalCursor } from '../src/session.js';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _ptyRows: number;
};

function handleOutput(session: Session, data: string): void {
  (session as unknown as SessionInternals)._handleTerminalOutput(data);
}

describe('Codex terminal output filtering', () => {
  it('emits contiguous terminal cursor ranges and advances the generation after a clear', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    const cursors: TerminalCursor[] = [];
    session.on('terminal', (_data, cursor: TerminalCursor) => cursors.push(cursor));

    handleOutput(session, 'abc');
    handleOutput(session, 'de');
    session.clearBuffers();
    handleOutput(session, 'next');

    expect(cursors[0]).toMatchObject({ generation: 0, start: 0, end: 3 });
    expect(cursors[1]).toMatchObject({ stream: cursors[0].stream, generation: 0, start: 3, end: 5 });
    expect(cursors[2]).toMatchObject({ stream: cursors[0].stream, generation: 1, start: 0, end: 4 });
    expect(session.terminalCursor).toEqual(cursors[2]);
  });

  it('keeps browser scrollback guards but skips Codeman row repair in hybrid render mode', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex', codexConfig: { renderMode: 'hybrid' } });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));
    const hybridRedraw = '\x1b[?1049h\x1b[55;1H\x1b[2m• Working (21s)\x1b[3J\x1b[?1006h\x1b[?1049l';

    handleOutput(session, hybridRedraw);

    expect(emitted[0]).toBe('\x1b[55;1H\x1b[2m• Working (21s)');
    expect(emitted[0]).not.toContain('\x1b[55;1H\x1b[2K');
    expect(session.terminalBuffer).toBe(emitted[0]);
  });

  it('preserves Codex erase-display redraws used by the TUI layout engine', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });

    handleOutput(session, '\x1b[H\x1b[Jidle redraw');

    expect(session.terminalBuffer).toBe('\x1b[H\x1b[Jidle redraw');
  });

  it('strips Codex scrollback erase without stripping visible-screen erase', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });

    handleOutput(session, '\x1b[?1049h\x1b[2Jvisible\x1b[3Jscrollback\x1b[?1049l');

    expect(session.terminalBuffer).toBe('\x1b[2Jvisiblescrollback');
  });

  it('strips sequences split across PTY chunk boundaries (carry reassembly)', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    // '\x1b[?1049h' split mid-sequence, then '\x1b[3J' split before its final byte.
    handleOutput(session, 'before\x1b[?104');
    handleOutput(session, '9h\x1b[2Jafter\x1b[3');
    handleOutput(session, 'Jtail');

    expect(session.terminalBuffer).toBe('before\x1b[2Jaftertail');
    expect(emitted).toEqual(['before', '\x1b[2Jafter', 'tail']);
  });

  it('emits nothing for a chunk that is only a partial CSI, and completes it next chunk', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(session, '\x1b[?100'); // pure partial — held, nothing emitted
    handleOutput(session, '6h\x1b[55;1H• Working'); // completes ?1006h (stripped); rest passes

    expect(emitted).toEqual(['\x1b[55;1H• Working']);
    expect(session.terminalBuffer).toBe('\x1b[55;1H• Working');
  });

  it('preserves Codex erase-display redraw when the user pressed Ctrl+L', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });

    session.write('\x0c');
    handleOutput(session, '\x1b[H\x1b[Jredraw after clear');

    expect(session.terminalBuffer).toBe('\x1b[H\x1b[Jredraw after clear');
  });

  it('passes native Codex TUI prompt/status redraws through without row repair', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const bottomBandRedraw =
      '\x1b[48;2;42;42;42m' +
      '\x1b[60;2H\x1b[K' +
      '\x1b[61;39H\x1b[K' +
      '\x1b[62;2H\x1b[K' +
      '\x1b[52;1H\x1b[49m\x1b[2m• \x1b[1mRunning node -e ...' +
      '\x1b[60;1H\x1b[48;2;42;42;42m \r\n' +
      '\x1b[1m›\x1b[0m\x1b[48;2;42;42;42m \x1b[2mUse /skills to list available skills\r\n' +
      '\x1b[63;3H\x1b[49m\x1b[38;2;246;226;183mgpt-5.5 xhigh\x1b[39m' +
      '\x1b[2m · \x1b[38;2;242;181;144mContext 42% left\x1b[39m' +
      '\x1b[61;3H';

    handleOutput(session, bottomBandRedraw);

    expect(emitted[0]).not.toContain('\x1b[52;1H\x1b[2K');
    expect(emitted[0]).not.toContain('\x1b[60;1H\x1b[2K');
    expect(emitted[0]).not.toContain('\x1b[63;1H\x1b[2K');
    expect(emitted[0]).toContain(bottomBandRedraw);
  });

  it('passes Codex advisory rows through without row repair', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const advisoryRedraw =
      '\x1b[55;1H\x1b[2mMessages\x1b[Cto\x1b[Cbe submitted\x1b[Cafter\x1b[Cnext toolcall ' +
      '(press esc to interrupt and send immediately)\x1b[56;1H';

    handleOutput(session, advisoryRedraw);

    expect(emitted[0]).not.toContain('\x1b[55;1H\x1b[2K');
    expect(emitted[0]).toContain(advisoryRedraw);
  });

  it('does not clear Codex resume-picker rows just because an option is selected', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const resumePickerRedraw =
      '\x1b[1;2H\x1b[36m\x1b[1mResume a previous session' +
      '\x1b[3;2H\x1b[2mType to search      Filter: \x1b[35m[Cwd]\x1b[39m\x1b[2m All' +
      '\x1b[5;3H\x1b[33m\x1b[48;2;42;42;42m\x1b[1m❯ \x1b[2m22h ago     ll' +
      '\x1b[6;3H\x1b[2m  1d ago      $kb-health' +
      '\x1b[60;1H\x1b[2m──── 2 / 2 · 100% ─' +
      '\x1b[61;1H enter resume   esc exit   ↑/↓ browse';

    handleOutput(session, resumePickerRedraw);

    expect(emitted[0]).not.toContain('\x1b[4;1H\x1b[2K');
    expect(emitted[0]).not.toContain('\x1b[5;1H\x1b[2K');
    expect(emitted[0]).toContain(resumePickerRedraw);
  });

  it('does not full-clear sparse Codex resume-picker navigation redraws', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    let sparseResumePickerRedraw = '';
    for (let row = 1; row <= 51; row++) {
      const col = row % 2 === 0 ? 239 : 27;
      sparseResumePickerRedraw += `\x1b[${row};${col}H\x1b[K`;
    }
    sparseResumePickerRedraw +=
      '\x1b[21;3H  \x1b[2m9d ago      \x1b[mreview this webex room webexteams://im?space=672465b0-4fcb-11f1-9d54-51475df86e3a\x1b[K' +
      '\x1b[22;3H\x1b[33m\x1b[1m❯ \x1b[m\x1b[33m\x1b[2m9d ago      \x1b[m\x1b[33mcisco hybrid mesh firewall includes support for smart switch enforcement...\x1b[K' +
      '\x1b[52;229H\x1b[39m\x1b[2m8\x1b[m';

    handleOutput(session, sparseResumePickerRedraw);

    expect(emitted[0]).not.toContain('\x1b[H\x1b[2J');
    expect(emitted[0]).toContain(sparseResumePickerRedraw);
  });

  it('passes Codex UI rows through when the status band moves downward', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(
      session,
      '\x1b[55;1H\x1b[2m• Working (1s)\x1b[56;1H\x1b[1m›\x1b[0m ask\x1b[57;3Hgpt-5.5 · Context 80% left'
    );
    handleOutput(
      session,
      '\x1b[58;1H\x1b[2m• Working (2s)\x1b[59;1H\x1b[1m›\x1b[0m ask\x1b[60;3Hgpt-5.5 · Context 79% left'
    );

    expect(emitted[1]).not.toContain('\x1b[55;1H\x1b[2K');
    expect(emitted[1]).not.toContain('\x1b[56;1H\x1b[2K');
    expect(emitted[1]).not.toContain('\x1b[57;1H\x1b[2K');
    expect(emitted[1]).toContain('\x1b[58;1H');
    expect(emitted[1]).not.toContain('\x1b[54;1H\x1b[2K');
  });

  it('does not full-clear the viewport for stable Codex UI rows at the same position', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const stableRedraw =
      '\x1b[58;1H\x1b[2m• Working (2s)\x1b[59;1H\x1b[1m›\x1b[0m ask\x1b[60;3Hgpt-5.5 · Context 79% left';

    handleOutput(session, stableRedraw);
    handleOutput(session, stableRedraw.replace('2s', '3s'));

    expect(emitted[1]).not.toContain('\x1b[H\x1b[2J');
  });

  it('passes status-only Codex Working redraw rows through', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const workingRedraw = '\x1b[55;1H\x1b[2m• Working (21s)';

    handleOutput(session, workingRedraw);

    expect(emitted[0]).not.toContain('\x1b[55;1H\x1b[2K');
    expect(emitted[0]).toContain(workingRedraw);
    expect(emitted[0]).not.toContain('\x1b[H\x1b[2J');
  });

  it('passes Codex spinner Working rows that omit elapsed time parentheses through', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 29;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const spinnerRedraw = '\x1b[24;1H\x1b[38;5;254m\x1b[1m•\x1b[CWorking\x1b[27;3H';

    handleOutput(session, spinnerRedraw);

    expect(emitted[0]).not.toContain('\x1b[24;1H\x1b[2K');
    expect(emitted[0]).toContain(spinnerRedraw);
    expect(emitted[0]).not.toContain('\x1b[H\x1b[2J');
  });

  it('does not treat ordinary gpt model mentions as Codex status rows', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const outputRow = '\x1b[20;1Hnormal output comparing gpt-5 and another model';

    handleOutput(session, outputRow);

    expect(emitted[0]).toContain(outputRow);
    expect(emitted[0]).not.toContain('\x1b[19;1H\x1b[2K');
    expect(emitted[0]).not.toContain('\x1b[20;1H\x1b[2K');
  });

  it('does not inject row erases during partial Working spinner ticks', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(
      session,
      '\x1b[55;1H\x1b[2m• Working (1s)' +
        '\x1b[56;1H\x1b[1m›\x1b[0m ask' +
        '\x1b[57;3Hgpt-5.5 xhigh fast · codeman · Working · Context 79% left'
    );
    handleOutput(session, '\x1b[55;1H\x1b[2m• Working (2s)');

    expect(emitted[1]).not.toContain('\x1b[55;1H\x1b[2K');
    expect(emitted[1]).not.toContain('\x1b[56;1H\x1b[2K');
    expect(emitted[1]).not.toContain('\x1b[57;1H\x1b[2K');
    expect(emitted[1]).toContain('\x1b[55;1H\x1b[2m• Working (2s)');
  });
});
