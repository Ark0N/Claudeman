/**
 * Regression tests for issue #208 — "Plain shell PTY exits with code 1 after
 * successful tmux creation in Docker".
 *
 * The shell-mode pane command used to be the literal string `$SHELL`. It ends up
 * inside the `bash -c "…"` argument of the respawn-pane line, which execSync runs
 * through `/bin/sh -c`, so it was expanded by the SERVER process's shell against
 * the SERVER process's env. Containers (and system-level systemd units) do not set
 * SHELL, so it expanded to nothing and the pane command ended in a dangling `&&`:
 *
 *   bash: -c: line 1: syntax error: unexpected end of file
 *
 * These tests pin the resolver's guarantees and assert that a shell launch command
 * survives the outer `sh -c` layer with an unset SHELL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { loginShellArgs, resolveLocalShell } from '../src/utils/shell-resolver.js';

describe('resolveLocalShell', () => {
  const originalShell = process.env.SHELL;

  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  });

  it('returns an absolute executable path when SHELL is unset (container case)', () => {
    delete process.env.SHELL;
    const shell = resolveLocalShell();
    expect(shell).not.toBe('');
    expect(shell.startsWith('/')).toBe(true);
    // Proves the resolved path is really launchable, not just a plausible string.
    expect(execFileSync(shell, ['-c', 'echo ok'], { encoding: 'utf8' }).trim()).toBe('ok');
  });

  it('returns an absolute executable path when SHELL is empty or whitespace', () => {
    for (const value of ['', '   ']) {
      process.env.SHELL = value;
      const shell = resolveLocalShell();
      expect(shell.startsWith('/')).toBe(true);
      expect(execFileSync(shell, ['-c', 'echo ok'], { encoding: 'utf8' }).trim()).toBe('ok');
    }
  });

  it('honors a valid $SHELL', () => {
    process.env.SHELL = '/bin/sh';
    expect(resolveLocalShell()).toBe('/bin/sh');
  });

  it('ignores a $SHELL that does not exist', () => {
    process.env.SHELL = '/nonexistent/shell-that-is-not-here';
    const shell = resolveLocalShell();
    expect(shell).not.toBe('/nonexistent/shell-that-is-not-here');
    expect(shell.startsWith('/')).toBe(true);
  });

  it('ignores a relative $SHELL (never emits a bare word into the launch command)', () => {
    process.env.SHELL = 'bash';
    expect(resolveLocalShell().startsWith('/')).toBe(true);
  });

  it('ignores nologin-style stubs that would exit instantly', () => {
    process.env.SHELL = '/usr/sbin/nologin';
    expect(resolveLocalShell()).not.toContain('nologin');
    process.env.SHELL = '/bin/false';
    expect(resolveLocalShell()).not.toBe('/bin/false');
  });
});

describe('loginShellArgs (#209 login flags, allowlisted)', () => {
  it('asks for a login shell on the POSIX-family shells that accept the flags', () => {
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/zsh', '/usr/local/bin/fish', '/bin/ksh']) {
      expect(loginShellArgs(shell)).toBe(' -i -l');
    }
  });

  it('adds nothing for shells that take neither flag, so the pane cannot die on arrival', () => {
    // The shell path can come from the passwd entry, which is user data and can
    // name anything. A shell that rejects an unknown flag exits immediately —
    // indistinguishable from the #208 dead-pane-on-arrival this module prevents.
    // csh/tcsh are here too: tcsh honors -l only when it is the ONLY flag.
    for (const shell of ['/usr/bin/nu', '/usr/bin/elvish', '/usr/bin/xonsh', '/bin/tcsh', '/bin/csh']) {
      expect(loginShellArgs(shell)).toBe('');
    }
  });

  it('really launches for every allowlisted shell present on this machine', () => {
    // The whole point of the allowlist is that the flags are ACCEPTED, so prove it
    // against the real binaries rather than trusting the set.
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/zsh', '/bin/ksh']) {
      let exists = true;
      try {
        execFileSync('/bin/sh', ['-c', `test -x ${shell}`]);
      } catch {
        exists = false;
      }
      if (!exists) continue;
      const out = execFileSync('/bin/sh', ['-c', `${shell} -i -l -c 'echo ok' 2>/dev/null`], { encoding: 'utf8' });
      expect(out).toContain('ok');
    }
  });
});

describe('shell-mode spawn command (issue #208)', () => {
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    delete process.env.SHELL;
  });

  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  });

  it('never emits an unexpanded $SHELL into the pane command', () => {
    const cmd = buildSpawnCommand({ mode: 'shell', sessionId: 'abc123de-0000-0000-0000-000000000000' });
    expect(cmd).not.toContain('$SHELL');
    expect(cmd.trim()).not.toBe('');
  });

  it('launches a LOGIN shell, matching what tmux does for a pane with no default-command', () => {
    // A tmux pane already hands the shell a tty, so it is interactive either way
    // (`$-` contains `i` for a bare /bin/bash in a pane, which is why ~/.bashrc has
    // always been sourced). `-l` is the flag that changes anything: it is what
    // picks up /etc/profile and /etc/profile.d/*, which a systemd --user service
    // never sourced, so its minimal PATH is what every pane used to inherit.
    const cmd = buildSpawnCommand({ mode: 'shell', sessionId: 'abc123de-0000-0000-0000-000000000000' });
    expect(cmd.trim().endsWith('-i -l')).toBe(true);
  });

  it('produces a launch command that parses after the outer sh -c expansion layer', () => {
    const cmd = buildSpawnCommand({ mode: 'shell', sessionId: 'abc123de-0000-0000-0000-000000000000' });
    // Mirrors tmux-manager: `… bash -c ${JSON.stringify(launchCmd)}` handed to `sh -c`.
    const launchCmd = `cd ${JSON.stringify('/tmp')} && export CODEMAN_MUX=1 && ${cmd}`;
    const outer = `bash -n -c ${JSON.stringify(launchCmd)}`;

    // `bash -n` parses without executing: exits 0 on the fix, 2 with the dangling `&&`.
    const result = execFileSync('/bin/sh', ['-c', `${outer}; echo "rc=$?"`], { encoding: 'utf8' });
    expect(result).toContain('rc=0');
    expect(result).not.toContain('unexpected end of file');
  });
});
