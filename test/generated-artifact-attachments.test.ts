import { describe, expect, it } from 'vitest';
import {
  buildRemoteGeneratedArtifactFetchArgs,
  isAllowedGeneratedArtifactPath,
} from '../src/generated-artifact-attachments.js';
import type { SessionRemote } from '../src/types/session.js';

describe('generated artifact attachments', () => {
  it('allows workspace artifacts and known Codex generated image directories', () => {
    expect(isAllowedGeneratedArtifactPath('/repo/out/mockup.png', '/repo')).toBe(true);
    expect(isAllowedGeneratedArtifactPath('/Users/aamer/.codex-personal/generated_images/mockup.png', '/repo')).toBe(
      true
    );
    expect(isAllowedGeneratedArtifactPath('/etc/secret.png', '/repo')).toBe(false);
    expect(
      isAllowedGeneratedArtifactPath('/Users/aamer/.codex-personal/generated_images/../../.ssh/id_rsa.png', '/repo')
    ).toBe(false);
  });

  it('builds remote fetch argv from the session SSH configuration', () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'mac-mini',
      host: '192.168.1.20',
      username: 'aamer',
      port: 2222,
      remotePath: '/Users/aamer/projects/app',
      identityFile: '~/.ssh/remote_ed25519',
      socksProxy: '127.0.0.1:1080',
      jumpHost: 'jump.example.com',
      extraSshOptions: ['StrictHostKeyChecking=no'],
    };

    expect(
      buildRemoteGeneratedArtifactFetchArgs(remote, "/Users/aamer/.codex-personal/generated_images/a'b.png")
    ).toEqual([
      '-o',
      'BatchMode=yes',
      '-p',
      '2222',
      '-i',
      expect.stringMatching(/remote_ed25519$/),
      '-J',
      'jump.example.com',
      '-o',
      'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'ConnectTimeout=10',
      'aamer@192.168.1.20',
      "cat -- '/Users/aamer/.codex-personal/generated_images/a'\\''b.png'",
    ]);
  });
});
