import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultRemoteCommandForMode,
  readRemoteCases,
  readRemoteHosts,
  remoteDisplayPath,
  remoteSshTarget,
  writeRemoteCases,
  writeRemoteHosts,
} from '../src/remote-hosts.js';

describe('remote-hosts domain', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function configDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'codeman-remote-hosts-'));
    return dir;
  }

  it('round-trips remote hosts and remote cases from a config directory', async () => {
    const root = configDir();
    await writeRemoteHosts(root, [
      {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    ]);
    await writeRemoteCases(root, [
      { name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    ]);

    await expect(readRemoteHosts(root)).resolves.toEqual([
      {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    ]);
    await expect(readRemoteCases(root)).resolves.toEqual([
      { name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    ]);
  });

  it('returns safe mode defaults and remote display values', () => {
    expect(defaultRemoteCommandForMode('shell')).toBe('exec $SHELL -i -l');
    // Routed through an interactive login shell so per-user PATH entries (e.g.
    // ~/.local/bin, ~/.opencode/bin) resolve — a bare `exec codex` sees only
    // sshd's minimal default PATH and fails with "command not found".
    expect(defaultRemoteCommandForMode('codex')).toBe("exec $SHELL -i -l -c 'codex'");
    // Mirrors the local claude default so the remote agent runs non-interactively.
    expect(defaultRemoteCommandForMode('claude')).toBe("exec $SHELL -i -l -c 'claude --dangerously-skip-permissions'");
    expect(remoteSshTarget({ id: 'h1', label: 'H1', host: 'box.local', username: 'aamer' })).toBe('aamer@box.local');
    expect(remoteDisplayPath({ username: 'aamer', host: 'box.local', path: '/opt/work' })).toBe(
      'aamer@box.local:/opt/work'
    );
  });
});
