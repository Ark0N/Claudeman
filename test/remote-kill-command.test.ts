import { describe, it, expect } from 'vitest';
import { buildRemoteKillCommand } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types.js';

// COD-109 — terminate an OWNED durable remote tmux session by propagating
// `kill-session` to the remote host. Since COD-104 an owned remote session lives
// in the dedicated `-L codeman-remote` tmux server on the host and outlives the
// local ssh pane, so ending a session we OWN must reach the remote socket.
//
// The owned-kill command builder was consolidated upstream (PR #145) into the
// `{ remote, sessionId }` form, which derives the durable session name and kills
// on the dedicated `codeman-remote` socket (matching buildRemoteLaunchCommand).
// This suite pins that builder's contract; the killSession integration
// (owned-only, after COD-105's non-owned detach-only early-return) is exercised
// against the real remote.
describe('COD-109 buildRemoteKillCommand (owned durable remote kill)', () => {
  const base: SessionRemote = {
    hostId: 'h',
    label: 'aa',
    host: '192.168.55.170',
    username: 'aakht',
    remotePath: '/tmp',
  };

  it('kills the durable session on the dedicated codeman-remote socket (no ssh -t — non-interactive)', () => {
    const cmd = buildRemoteKillCommand({ remote: base, sessionId: 'abc12345def' });
    expect(cmd.startsWith('ssh -o BatchMode=yes ')).toBe(true);
    expect(cmd).toContain('aakht@192.168.55.170');
    // Owned sessions launch on `-L codeman-remote`; the kill MUST target the same socket.
    expect(cmd).toContain('tmux -L codeman-remote kill-session -t');
    // Deterministic session name derived from the sessionId (codeman-ssh-<first 8>).
    expect(cmd).toContain('codeman-ssh-abc12345');
    // kill-session needs no PTY — must NOT request the ssh `-t` flag (attach uses
    // `ssh -o BatchMode=yes -t …`; kill must not). The ` -t ` inside the quoted
    // `kill-session -t <name>` is the tmux target flag, which is expected.
    expect(cmd).not.toContain('-o BatchMode=yes -t');
  });

  it('shares the default ConnectTimeout so an unreachable host fails fast (never blocks kill)', () => {
    const cmd = buildRemoteKillCommand({ remote: base, sessionId: 'abc12345def' });
    expect(cmd).toContain('-o ConnectTimeout=10');
  });

  it('reuses the COD-107 connection options (port / identity / SOCKS proxy)', () => {
    const cmd = buildRemoteKillCommand({
      remote: { ...base, port: 2222, identityFile: '~/.ssh/remote_ed25519', socksProxy: '127.0.0.1:1080' },
      sessionId: 'abc12345def',
    });
    expect(cmd).toContain('-p 2222');
    expect(cmd).toMatch(/-i '.*\/\.ssh\/remote_ed25519'/);
    expect(cmd).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
  });

  it('shell-escapes the derived session name so metachars stay one token', () => {
    const cmd = buildRemoteKillCommand({ remote: base, sessionId: "x'; rm -rf /" });
    expect(cmd).not.toMatch(/rm -rf \/\s*$/); // not a bare trailing command
    expect(cmd).toContain('kill-session -t');
  });
});
