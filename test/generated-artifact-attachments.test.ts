import { describe, expect, it } from 'vitest';
import { isAllowedGeneratedArtifactPath } from '../src/generated-artifact-attachments.js';

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
});
