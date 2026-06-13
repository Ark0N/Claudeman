/**
 * @fileoverview COD-107 — Remote-host SSH: custom port + advanced connection options.
 *
 * Unit tests for the shared, pure `buildSshConnectionArgs(remote)` and its two
 * consumers (`buildRemoteLaunchCommand`, `buildRemoteTmuxCheckCommand`). The
 * acceptance target is the aa-desktop option set (custom port 2222, ed25519
 * identity under `~`, a cloudflared SOCKS5 ProxyCommand, plus an arbitrary
 * `-o` escape-hatch option) — the same connection `~/repos/claude-config/bin/
 * ssh-aa-desktop` makes, WITHOUT shelling out to that wrapper.
 *
 * Critical, easy-to-break invariants pinned here:
 *  - `%h %p` in the ProxyCommand reach ssh LITERALLY (one shellescaped
 *    `-o ProxyCommand=…` token; the local shell must not expand/mangle them).
 *  - a leading `~`/`$HOME` in `identityFile` is expanded to an absolute path at
 *    build time (ssh does NOT expand `~` in `-i`), then shellescaped.
 *  - empty options ⇒ byte-identical ssh to today (full back-compat).
 *
 * Pure command-string construction; no real tmux, no ssh. Port: N/A.
 */

import { homedir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { buildSshConnectionArgs, buildRemoteTmuxCheckCommand, remoteSshTarget } from '../src/remote-hosts.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types.js';

const HOME = homedir();

const baseRemote: SessionRemote = {
  hostId: 'gpu-box',
  label: 'GPU Box',
  host: '10.0.0.42',
  username: 'ubuntu',
  remotePath: '/home/ubuntu/work',
};

// The acceptance host: aa-desktop reached over the cloudflared SOCKS5 proxy.
const aaDesktop: SessionRemote = {
  hostId: 'aa-desktop',
  label: 'aa-desktop',
  host: '192.168.55.170',
  username: 'aakht',
  port: 2222,
  remotePath: '/tmp',
  identityFile: '~/.ssh/remote_ed25519',
  socksProxy: '127.0.0.1:1080',
  extraSshOptions: ['StrictHostKeyChecking=accept-new'],
  commands: { shell: 'exec bash -l' },
};

const SESSION_ID = 'cod107chk';

describe('COD-107 buildSshConnectionArgs — shared ssh connection tokens', () => {
  it('always leads with -o BatchMode=yes', () => {
    expect(buildSshConnectionArgs(baseRemote)).toEqual(['ssh', '-o BatchMode=yes']);
  });

  it('emits the full aa-desktop option set in order with escaping + %h %p intact', () => {
    const args = buildSshConnectionArgs(aaDesktop);
    const joined = args.join(' ');

    // -p before -i before the proxy -o; identity ~ expanded absolute, then escaped.
    expect(joined).toContain('-o BatchMode=yes');
    expect(joined).toContain('-p 2222');
    expect(joined).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    // No literal tilde survives into the -i token.
    expect(joined).not.toContain('-i ~');
    expect(joined).not.toContain("-i '~");

    // The whole ProxyCommand (with its spaces and %h %p) is ONE shellescaped -o token.
    expect(joined).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    // %h %p must survive verbatim — they are ssh tokens, not shell tokens.
    expect(joined).toContain('%h %p');

    // The escape-hatch extra option, shellescaped.
    expect(joined).toContain("-o 'StrictHostKeyChecking=accept-new'");

    // Ordering: BatchMode -> port -> identity -> ProxyCommand -> extras.
    const idxBatch = joined.indexOf('BatchMode=yes');
    const idxPort = joined.indexOf('-p 2222');
    const idxIdentity = joined.indexOf('-i ');
    const idxProxy = joined.indexOf('ProxyCommand=');
    const idxExtra = joined.indexOf('StrictHostKeyChecking');
    expect(idxBatch).toBeLessThan(idxPort);
    expect(idxPort).toBeLessThan(idxIdentity);
    expect(idxIdentity).toBeLessThan(idxProxy);
    expect(idxProxy).toBeLessThan(idxExtra);
  });

  it('supports an explicit -J jump host', () => {
    const args = buildSshConnectionArgs({ ...baseRemote, jumpHost: 'bastion@10.0.0.1:22' });
    expect(args.join(' ')).toContain('-J bastion@10.0.0.1:22');
  });

  it('expands a $HOME-prefixed identity path', () => {
    const args = buildSshConnectionArgs({ ...baseRemote, identityFile: '$HOME/.ssh/id_ed25519' });
    expect(args.join(' ')).toContain(`-i '${HOME}/.ssh/id_ed25519'`);
  });

  it('empty options ⇒ exactly the historical token set (back-compat)', () => {
    // Today: ssh -o BatchMode=yes (+ -p only when set). Nothing else.
    expect(buildSshConnectionArgs(baseRemote)).toEqual(['ssh', '-o BatchMode=yes']);
    expect(buildSshConnectionArgs({ ...baseRemote, port: 2200 })).toEqual(['ssh', '-o BatchMode=yes', '-p 2200']);
  });
});

describe('COD-107 buildRemoteLaunchCommand — threads connection args', () => {
  it('emits the aa-desktop ssh connection options ahead of -t and the target', () => {
    const command = buildRemoteLaunchCommand({ mode: 'shell', remote: aaDesktop, sessionId: SESSION_ID });

    expect(command).toContain('-p 2222');
    expect(command).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    expect(command).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    expect(command).toContain("-o 'StrictHostKeyChecking=accept-new'");
    expect(command).toContain('-t');
    expect(command).toContain('aakht@192.168.55.170');
    expect(command).toContain('tmux -L codeman new-session -A');

    // Connection options come BEFORE -t / the target / the tmux command.
    const idxProxy = command.indexOf('ProxyCommand=');
    const idxTarget = command.indexOf('aakht@192.168.55.170');
    expect(idxProxy).toBeLessThan(idxTarget);
  });

  it('back-compat: a remote with no advanced options is byte-identical to the historical form', () => {
    const command = buildRemoteLaunchCommand({ mode: 'shell', remote: baseRemote, sessionId: SESSION_ID });
    // Reconstruct the historical command using the SAME nested POSIX
    // single-quote escaping the production code uses, to prove byte-identity.
    const sh = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const remoteName = `codeman-${SESSION_ID.slice(0, 8)}`;
    const path = sh('/home/ubuntu/work');
    const paneCommand = `cd ${path} && exec bash -l`;
    const tmuxInvocation = [
      `tmux -L codeman new-session -A -s ${remoteName} -c ${path} ${sh(paneCommand)}`,
      'set -g status off',
      'set -g mouse off',
      'set -sg escape-time 0',
      'set -g prefix C-q',
    ].join(' \\; ');
    const expected = `ssh -o BatchMode=yes -t ${remoteSshTarget(baseRemote)} ${sh(tmuxInvocation)}`;
    expect(command).toBe(expected);
  });

  it('back-compat: port-only remote matches the historical -p placement', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      remote: { ...baseRemote, port: 2222 },
      sessionId: SESSION_ID,
    });
    expect(command).toMatch(/^ssh -o BatchMode=yes -t -p 2222 ubuntu@10\.0\.0\.42 /);
  });
});

describe('COD-107 buildRemoteTmuxCheckCommand — same connection options as the launch', () => {
  it('uses the shared connection args (proxy/identity/port) plus ConnectTimeout', () => {
    const cmd = buildRemoteTmuxCheckCommand(aaDesktop);
    expect(cmd).toContain('-o BatchMode=yes');
    expect(cmd).toContain('-o ConnectTimeout=10');
    expect(cmd).toContain('-p 2222');
    expect(cmd).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    expect(cmd).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    expect(cmd).toContain('aakht@192.168.55.170');
    expect(cmd).toContain("'command -v tmux'");
  });

  it('back-compat: no advanced options ⇒ unchanged probe string', () => {
    expect(buildRemoteTmuxCheckCommand({ username: 'ubuntu', host: '10.0.0.42' })).toBe(
      "ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@10.0.0.42 'command -v tmux'"
    );
    expect(buildRemoteTmuxCheckCommand({ username: 'ubuntu', host: '10.0.0.42', port: 2222 })).toContain('-p 2222');
  });
});
