/**
 * Password auth for remote hosts that accept no key.
 *
 * The password is handed to ssh through `sshpass -e` (read from the SSHPASS
 * environment variable, never argv), and the variable itself is injected into
 * the pane with socket-scoped `tmux setenv` like every other secret here.
 */
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSshConnectionArgs,
  redactRemoteHost,
  mergeRemoteHostSecret,
  writeRemoteHosts,
  remoteHostsPath,
} from '../src/remote-hosts.js';
import type { RemoteHost } from '../src/types.js';

const host: RemoteHost = { id: 'h1', label: 'box', host: 'example.com', username: 'root' };

describe('ssh connection args with a stored password', () => {
  it('keeps the key-only path byte-identical when no password is set', () => {
    expect(buildSshConnectionArgs(host).slice(0, 2)).toEqual(['ssh', '-o BatchMode=yes']);
  });

  it('switches the launcher to sshpass -e and DROPS BatchMode=yes', () => {
    // MEASURED against a real host: `BatchMode=yes` disables the password prompt,
    // and answering that prompt is exactly how sshpass works, so the pair comes
    // back "Permission denied (publickey,password)" — which reads like a wrong
    // password rather than a wrong flag. This is the assertion that keeps someone
    // from "restoring" BatchMode=yes for consistency with the key path.
    const args = buildSshConnectionArgs({ ...host, password: 'pw' });
    expect(args[0]).toBe('sshpass -e ssh');
    expect(args.join(' ')).not.toContain('BatchMode=yes');
    expect(args).toContain('-o BatchMode=no');
  });

  it('caps password prompts at one so a wrong password fails instead of waiting', () => {
    expect(buildSshConnectionArgs({ ...host, password: 'pw' })).toContain('-o NumberOfPasswordPrompts=1');
  });

  it('never puts the password itself on the command line', () => {
    const joined = buildSshConnectionArgs({ ...host, password: 'hunter2' }).join(' ');
    expect(joined).not.toContain('hunter2');
  });

  it('keeps sshpass as ONE leading token, since callers splice flags by position', () => {
    // buildRemoteLaunchCommand does `const [ssh, batchMode, ...rest]` and inserts
    // `-t` between them; a separate 'sshpass' entry would shift that insertion.
    const args = buildSshConnectionArgs({ ...host, password: 'pw', port: 2222 });
    const [launcher, batch, ...rest] = args;
    expect(launcher.split(' ')).toEqual(['sshpass', '-e', 'ssh']);
    expect([launcher, batch, '-t', ...rest].join(' ')).toMatch(/^sshpass -e ssh -o BatchMode=no -t /);
  });

  it('still carries port and identity alongside the password launcher', () => {
    const args = buildSshConnectionArgs({ ...host, password: 'pw', port: 2222 }).join(' ');
    expect(args).toContain('-p 2222');
  });
});

describe('the password never leaves the server', () => {
  it('redacts it and reports only whether one is set', () => {
    const out = redactRemoteHost({ ...host, password: 'secret' });
    expect(out.passwordSet).toBe(true);
    expect('password' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('reports passwordSet false for a key-only host', () => {
    expect(redactRemoteHost(host).passwordSet).toBe(false);
  });

  it('carries a stored password across an update that omits it', () => {
    // A redacted host round-tripping through the UI has no password field; a blind
    // write would drop it and the next launch would silently fall back to key auth.
    expect(mergeRemoteHostSecret(host, { ...host, password: 'kept' }).password).toBe('kept');
  });

  it('treats an EXPLICIT empty string as "clear it"', () => {
    expect(mergeRemoteHostSecret({ ...host, password: '' }, { ...host, password: 'old' }).password).toBeUndefined();
  });

  it('lets an explicit new password win over the stored one', () => {
    expect(mergeRemoteHostSecret({ ...host, password: 'new' }, { ...host, password: 'old' }).password).toBe('new');
  });
});

describe('remote-hosts.json holds a secret, so it is 0600', () => {
  it('writes the registry unreadable by other users', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-rh-'));
    await writeRemoteHosts(dir, [{ ...host, password: 'secret' }]);
    const mode = (await fs.stat(remoteHostsPath(dir))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('tightens a registry that already existed with looser permissions', async () => {
    // writeFile's `mode` applies only on CREATE, so an install that predates this
    // would keep 0644 forever without the explicit chmod.
    const dir = mkdtempSync(join(tmpdir(), 'cm-rh-'));
    const path = remoteHostsPath(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path, '[]', { mode: 0o644 });
    await writeRemoteHosts(dir, [{ ...host, password: 'secret' }]);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });
});
