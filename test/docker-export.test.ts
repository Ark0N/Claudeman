/**
 * Unit tests for the pure docker export/import helpers (src/docker-export.ts).
 * The IO paths no-op under VITEST; these cover the naming, tar-traversal guard,
 * load-output parsing, and the sealed-mode refusal.
 */
import { describe, it, expect } from 'vitest';
import {
  dockerArgv,
  exportBundleName,
  exportImageTag,
  importedImageTag,
  isSafeTarMember,
  parseLoadedImageRef,
  exportDockerCase,
  DOCKER_EXPORT_SCHEMA,
} from '../src/docker-export.js';
import { toSessionDocker } from '../src/docker-hosts.js';
import type { DockerCase, DockerHost } from '../src/types.js';

const HOST: DockerHost = { id: 'local', label: 'Local', image: 'codeman/agent:base' };
const CASE: DockerCase = {
  name: 'myproj',
  type: 'docker',
  hostId: 'local',
  hostWorkspacePath: '/home/arkon/cases/myproj',
};

describe('dockerArgv', () => {
  it('is raw (unescaped) argv for spawn', () => {
    expect(dockerArgv({ engine: 'docker' })).toEqual(['docker']);
    expect(dockerArgv({ engine: 'podman', context: 'ctx', daemonHost: 'ssh://h' })).toEqual([
      'podman',
      '--context',
      'ctx',
      '-H',
      'ssh://h',
    ]);
  });
});

describe('bundle / tag naming', () => {
  it('names bundles by case + timestamp + mode', () => {
    expect(exportBundleName('myproj', 1234, 'full')).toBe('myproj-1234.codeman-container.tgz');
    expect(exportBundleName('myproj', 1234, 'workspace')).toBe('myproj-1234.codeman-workspace.tgz');
  });
  it('quarantines imported images and tags export intermediates uniquely', () => {
    expect(importedImageTag('myproj', 99)).toBe('codeman/imported-myproj:99');
    expect(exportImageTag('myproj', 99)).toBe('codeman/export-myproj:99');
  });
});

describe('isSafeTarMember (import traversal guard)', () => {
  it('accepts normal relative members', () => {
    expect(isSafeTarMember('./')).toBe(true);
    expect(isSafeTarMember('src/index.ts')).toBe(true);
    expect(isSafeTarMember('./a/b/c.txt')).toBe(true);
  });
  it('rejects absolute and parent-escaping members', () => {
    expect(isSafeTarMember('/etc/passwd')).toBe(false);
    expect(isSafeTarMember('../outside')).toBe(false);
    expect(isSafeTarMember('a/../../b')).toBe(false);
    expect(isSafeTarMember('./../../x')).toBe(false);
  });
});

describe('parseLoadedImageRef', () => {
  it('parses "Loaded image ID: sha256:..."', () => {
    expect(parseLoadedImageRef('Loaded image ID: sha256:abc123def')).toBe('sha256:abc123def');
  });
  it('parses "Loaded image: repo:tag"', () => {
    expect(parseLoadedImageRef('Loaded image: codeman/export-x:1234')).toBe('codeman/export-x:1234');
  });
  it('returns null on unrecognized output', () => {
    expect(parseLoadedImageRef('some other text')).toBeNull();
  });
});

describe('exportDockerCase (VITEST stub)', () => {
  it('returns a deterministic stub manifest without touching docker', async () => {
    const docker = toSessionDocker(HOST, CASE);
    const res = await exportDockerCase({
      docker,
      caseName: 'myproj',
      timestamp: 42,
      exportsDir: '/tmp/exports',
      mode: 'full',
      codemanVersion: '9.9.9',
    });
    expect(res.manifest.schemaVersion).toBe(DOCKER_EXPORT_SCHEMA);
    expect(res.manifest.caseName).toBe('myproj');
    expect(res.manifest.mode).toBe('full');
    expect(res.bundlePath).toBe('/tmp/exports/myproj-42.codeman-container.tgz');
  });

  it('refuses a full-image export for a sealed container', async () => {
    const docker = toSessionDocker({ ...HOST, mountCredentials: false }, CASE);
    await expect(
      exportDockerCase({
        docker,
        caseName: 'myproj',
        timestamp: 42,
        exportsDir: '/tmp/exports',
        mode: 'full',
        codemanVersion: '9.9.9',
      })
    ).rejects.toThrow(/sealed/);
  });

  it('allows a workspace-only export for a sealed container', async () => {
    const docker = toSessionDocker({ ...HOST, mountCredentials: false }, CASE);
    const res = await exportDockerCase({
      docker,
      caseName: 'myproj',
      timestamp: 42,
      exportsDir: '/tmp/exports',
      mode: 'workspace',
      codemanVersion: '9.9.9',
    });
    expect(res.manifest.mode).toBe('workspace');
  });
});
