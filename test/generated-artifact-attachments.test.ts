import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAllowedGeneratedArtifactPath,
  registerGeneratedArtifactAttachment,
} from '../src/generated-artifact-attachments.js';
import { attachmentRegistry } from '../src/attachment-registry.js';

describe('generated artifact attachments', () => {
  it('allows workspace artifacts and home-anchored Codex generated image directories', () => {
    const home = homedir();
    expect(isAllowedGeneratedArtifactPath('/repo/out/mockup.png', '/repo')).toBe(true);
    expect(
      isAllowedGeneratedArtifactPath(join(home, '.codex-personal', 'generated_images', 'mockup.png'), '/repo')
    ).toBe(true);
    expect(isAllowedGeneratedArtifactPath(join(home, '.codex', 'generated_artifacts', 'report.pdf'), '/repo')).toBe(
      true
    );
    expect(isAllowedGeneratedArtifactPath('/etc/secret.png', '/repo')).toBe(false);
    expect(
      isAllowedGeneratedArtifactPath(
        join(home, '.codex-personal', 'generated_images', '..', '..', '.ssh', 'id_rsa.png'),
        '/repo'
      )
    ).toBe(false);
  });

  it('rejects .codex marker directories that are not anchored at the user home', () => {
    expect(isAllowedGeneratedArtifactPath('/var/tmp/staging/.codex/generated_images/leak.png', '/repo')).toBe(false);
    expect(isAllowedGeneratedArtifactPath('/var/tmp/.codex-personal/generated_artifacts/leak.md', '/repo')).toBe(false);
  });

  describe('symlink resolution', () => {
    let workspaceDir: string | undefined;
    let outsideDir: string | undefined;
    const sessionId = 'generated-artifact-symlink-test';

    afterEach(async () => {
      attachmentRegistry.clearSession(sessionId);
      for (const dir of [workspaceDir, outsideDir]) {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
      }
      workspaceDir = undefined;
      outsideDir = undefined;
    });

    it('confines on the resolved path: a workspace symlink to an outside file is rejected', async () => {
      // realpath so a symlinked tmpdir (e.g. macOS /var -> /private/var) can't skew containment checks
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-ws-')));
      outsideDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-out-')));
      const outsideFile = join(outsideDir, 'private-notes.md');
      await fs.writeFile(outsideFile, 'secret');
      const linkPath = join(workspaceDir, 'x.md');
      await fs.symlink(outsideFile, linkPath);

      await expect(
        registerGeneratedArtifactAttachment({ sessionId, filePath: linkPath, sessionWorkingDir: workspaceDir })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('registers a real workspace file', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-ws-')));
      const filePath = join(workspaceDir, 'mockup.png');
      await fs.writeFile(filePath, 'png-bytes');

      const event = await registerGeneratedArtifactAttachment({
        sessionId,
        filePath,
        sessionWorkingDir: workspaceDir,
      });

      expect(event.fileName).toBe('mockup.png');
      expect(event.attachmentType).toBe('image');
    });
  });
});
