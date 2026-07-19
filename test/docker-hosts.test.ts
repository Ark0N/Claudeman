/**
 * Unit tests for the Docker cases storage + pure command-arg builders + probes
 * (src/docker-hosts.ts). Mirrors test/remote-hosts.test.ts. All docker IO no-ops
 * under VITEST, so probes return canned values and never spawn a real daemon.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDockerBaseArgs,
  buildDockerCreateArgs,
  checkDockerAvailable,
  checkDockerImagePresent,
  checkDockerTmuxAvailable,
  containerApiUrl,
  DEFAULT_AGENT_IMAGE,
  DEFAULT_DOCKER_RESOURCES,
  dockerConfigHash,
  dockerContainerName,
  dockerDisplayPath,
  defaultDockerCommandForMode,
  hostGatewayAlias,
  probeDockerCliVersion,
  readDockerCases,
  readDockerHosts,
  resolveCredentialMounts,
  toSessionDocker,
  writeDockerCases,
  writeDockerHosts,
  type DockerCreateContext,
} from '../src/docker-hosts.js';
import type { DockerCase, DockerHost, SessionDocker } from '../src/types.js';

const HOST: DockerHost = { id: 'local', label: 'Local Docker', image: DEFAULT_AGENT_IMAGE };
const CASE: DockerCase = {
  name: 'myproj',
  type: 'docker',
  hostId: 'local',
  hostWorkspacePath: '/home/arkon/cases/myproj',
};

describe('docker-hosts storage', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-docker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips hosts and cases through JSON storage', async () => {
    await writeDockerHosts(dir, [HOST]);
    await writeDockerCases(dir, [{ ...CASE, lastClaudeSessionId: 'abc-123' }]);
    expect(await readDockerHosts(dir)).toEqual([HOST]);
    const cases = await readDockerCases(dir);
    expect(cases[0].lastClaudeSessionId).toBe('abc-123');
  });

  it('returns [] for a missing file', async () => {
    expect(await readDockerHosts(dir)).toEqual([]);
    expect(await readDockerCases(dir)).toEqual([]);
  });
});

describe('naming / display / defaults', () => {
  it('derives a valid per-case container name', () => {
    expect(dockerContainerName('myproj')).toBe('codeman-case-myproj');
    // valid docker name charset: starts alnum, then [a-zA-Z0-9_.-]
    expect(dockerContainerName('my_proj-2')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  });

  it('maps each mode to a default pane command', () => {
    expect(defaultDockerCommandForMode('claude')).toBe('exec claude --dangerously-skip-permissions');
    expect(defaultDockerCommandForMode('shell')).toBe('exec bash -l');
    expect(defaultDockerCommandForMode('codex')).toBe('exec codex');
    expect(defaultDockerCommandForMode('gemini')).toBe('exec gemini');
  });

  it('formats a container:workdir display path from both shapes', () => {
    expect(dockerDisplayPath({ container: 'codeman-case-x', path: '/w' })).toBe('codeman-case-x:/w');
    const sd = toSessionDocker(HOST, CASE);
    expect(dockerDisplayPath(sd)).toBe('codeman-case-myproj:/home/arkon/cases/myproj');
  });
});

describe('hostGatewayAlias / containerApiUrl', () => {
  it('returns the engine-specific gateway alias', () => {
    expect(hostGatewayAlias('docker')).toBe('host.docker.internal');
    expect(hostGatewayAlias('podman')).toBe('host.containers.internal');
  });

  it('swaps only the hostname, preserving scheme and port', () => {
    expect(containerApiUrl('https://127.0.0.1:3000', 'docker')).toBe('https://host.docker.internal:3000');
    expect(containerApiUrl('http://127.0.0.1:3000', 'docker')).toBe('http://host.docker.internal:3000');
    expect(containerApiUrl('https://127.0.0.1:8443', 'docker')).toBe('https://host.docker.internal:8443');
    expect(containerApiUrl('https://127.0.0.1:3000', 'podman')).toBe('https://host.containers.internal:3000');
  });

  it('falls back to https://<alias>:3000 for absent or unparseable input', () => {
    expect(containerApiUrl(undefined, 'docker')).toBe('https://host.docker.internal:3000');
    expect(containerApiUrl('not a url', 'podman')).toBe('https://host.containers.internal:3000');
  });
});

describe('toSessionDocker / dockerConfigHash', () => {
  it('resolves every default (convenient, bridge, resume-on-start)', () => {
    const sd = toSessionDocker(HOST, CASE);
    expect(sd.engine).toBe('docker');
    expect(sd.image).toBe(DEFAULT_AGENT_IMAGE);
    expect(sd.containerName).toBe('codeman-case-myproj');
    expect(sd.hostWorkspacePath).toBe('/home/arkon/cases/myproj');
    expect(sd.containerWorkdir).toBe('/home/arkon/cases/myproj'); // mirror
    expect(sd.network).toBe('bridge');
    expect(sd.resources).toEqual(DEFAULT_DOCKER_RESOURCES);
    expect(sd.mountCredentials).toBe(true);
    expect(sd.hooksEnabled).toBe(true);
    expect(sd.resumeOnStart).toBe(true);
    expect(sd.configHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('honors host overrides and a custom container workdir', () => {
    const host: DockerHost = {
      ...HOST,
      engine: 'podman',
      network: 'none',
      mountCredentials: false,
      hooksEnabled: false,
      resumeOnStart: false,
    };
    const sd = toSessionDocker(host, { ...CASE, containerWorkdir: '/work', container: 'my-box' });
    expect(sd.engine).toBe('podman');
    expect(sd.network).toBe('none');
    expect(sd.mountCredentials).toBe(false);
    expect(sd.containerName).toBe('my-box');
    expect(sd.containerWorkdir).toBe('/work');
  });

  it('hash is stable for equal inputs and changes when a drift field changes', () => {
    const a = toSessionDocker(HOST, CASE);
    const b = toSessionDocker(HOST, CASE);
    expect(a.configHash).toBe(b.configHash);
    const c = toSessionDocker({ ...HOST, image: 'codeman/agent:other' }, CASE);
    expect(c.configHash).not.toBe(a.configHash);
    // lastClaudeSessionId is NOT a drift field
    expect(dockerConfigHash(a)).toBe(dockerConfigHash({ ...a }));
  });
});

describe('buildDockerBaseArgs', () => {
  it('defaults to docker with no extra flags', () => {
    expect(buildDockerBaseArgs({ engine: 'docker' })).toEqual(['docker']);
  });
  it('emits podman + context + daemon host', () => {
    const args = buildDockerBaseArgs({ engine: 'podman', context: 'remote', daemonHost: 'ssh://u@h' });
    expect(args[0]).toBe('podman');
    expect(args.join(' ')).toContain("--context 'remote'");
    expect(args.join(' ')).toContain("-H 'ssh://u@h'");
  });
});

describe('buildDockerCreateArgs', () => {
  function ctx(overrides: Partial<DockerCreateContext> = {}): DockerCreateContext {
    return {
      docker: toSessionDocker(HOST, CASE),
      sessionId: '1a2b3c4d5e6f',
      instance: '',
      userArgs: ['--user', '1000:0'],
      credentialMounts: [{ src: '/home/arkon/.claude', dst: '/home/agent/.claude' }],
      extraMounts: [
        { src: '/home/arkon/.codeman/hook-secret', dst: '/home/agent/.codeman/hook-secret', readonly: true },
      ],
      envCreate: { HOME: '/home/agent', CODEMAN_API_URL: 'https://host.docker.internal:3000' },
      addHostGateway: true,
      gatewayAlias: 'host.docker.internal',
      ...overrides,
    };
  }

  it('bakes in the security + lifecycle invariants', () => {
    const s = buildDockerCreateArgs(ctx()).join(' ');
    expect(s).toContain('--cap-drop ALL');
    expect(s).toContain('--security-opt no-new-privileges');
    expect(s).toContain('--pull=never');
    expect(s).toContain('--init');
    expect(s).toContain('--restart no');
    expect(s).toContain('--memory 4g --memory-swap 4g');
    expect(s).toContain('--pids-limit 512');
    expect(s).toContain('--ulimit nofile=4096:8192');
    expect(s).toContain('codeman.managed=1');
    expect(s).toContain("'codeman.session=1a2b3c4d'"); // first 8 chars only
    expect(s).toContain('--network bridge');
  });

  it('NEVER emits privileged mode or a docker-socket mount', () => {
    const s = buildDockerCreateArgs(ctx()).join(' ');
    expect(s).not.toContain('--privileged');
    expect(s).not.toContain('docker.sock');
  });

  it('ends with the image then the sleep-infinity CMD', () => {
    const args = buildDockerCreateArgs(ctx());
    expect(args.slice(-3)).toEqual([`'${DEFAULT_AGENT_IMAGE}'`, 'sleep', 'infinity']);
  });

  it('includes the resolved user args and the workspace bind', () => {
    const s = buildDockerCreateArgs(ctx()).join(' ');
    expect(s).toContain('--user 1000:0');
    expect(s).toContain("--mount 'type=bind,src=/home/arkon/cases/myproj,dst=/home/arkon/cases/myproj'");
  });

  it('shell-escapes a workspace path containing spaces into a single token', () => {
    const docker = toSessionDocker(HOST, { ...CASE, hostWorkspacePath: '/home/arkon/my cases/proj' });
    const args = buildDockerCreateArgs(ctx({ docker }));
    // the whole mount spec (with the space) is ONE single-quoted token
    expect(args).toContain("'type=bind,src=/home/arkon/my cases/proj,dst=/home/arkon/my cases/proj'");
    // and the workdir is single-quoted too
    expect(args).toContain("'/home/arkon/my cases/proj'");
  });

  it('adds the host-gateway only when requested', () => {
    expect(buildDockerCreateArgs(ctx({ addHostGateway: true })).join(' ')).toContain(
      '--add-host host.docker.internal:host-gateway'
    );
    expect(buildDockerCreateArgs(ctx({ addHostGateway: false })).join(' ')).not.toContain('--add-host');
  });

  it('omits credential mounts in sealed mode', () => {
    const s = buildDockerCreateArgs(ctx({ credentialMounts: [] })).join(' ');
    expect(s).not.toContain('/home/agent/.claude');
  });

  it('emits create-time env flags', () => {
    const s = buildDockerCreateArgs(ctx()).join(' ');
    expect(s).toContain("--env 'HOME=/home/agent'");
    expect(s).toContain("--env 'CODEMAN_API_URL=https://host.docker.internal:3000'");
  });

  it('uses the custom network name for custom mode', () => {
    const docker: SessionDocker = { ...toSessionDocker(HOST, CASE), network: 'custom', networkName: 'codeman-net-x' };
    expect(buildDockerCreateArgs(ctx({ docker })).join(' ')).toContain('--network codeman-net-x');
  });

  it('emits --gpus only when GPUs are requested (and never a storage cap)', () => {
    const withGpu: SessionDocker = { ...toSessionDocker(HOST, CASE), gpus: 'all' };
    const s = buildDockerCreateArgs(ctx({ docker: withGpu })).join(' ');
    expect(s).toContain("--gpus 'all'");
    // elastic disk: no fixed storage cap is ever emitted
    expect(s).not.toContain('--storage-opt');
    expect(buildDockerCreateArgs(ctx()).join(' ')).not.toContain('--gpus');
  });
});

describe('resolveCredentialMounts', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('only mounts credential paths that exist', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const mounts = resolveCredentialMounts(home);
    expect(mounts).toContainEqual({ src: join(home, '.claude'), dst: '/home/agent/.claude' });
    expect(mounts.find((m) => m.dst.endsWith('.codex'))).toBeUndefined();
  });
});

describe('daemon probes (no-op under VITEST)', () => {
  it('checkDockerAvailable returns a canned available result', async () => {
    const a = await checkDockerAvailable();
    expect(a.ok).toBe(true);
    expect(a.capsEnforced).toBe(true);
    expect(a.engine).toBe('docker');
  });

  it('checkDockerTmuxAvailable + image present are canned-true', async () => {
    expect((await checkDockerTmuxAvailable({ engine: 'docker', image: DEFAULT_AGENT_IMAGE })).ok).toBe(true);
    expect(await checkDockerImagePresent('docker', DEFAULT_AGENT_IMAGE)).toBe(true);
  });

  it('probeDockerCliVersion is undefined under test', async () => {
    expect(
      await probeDockerCliVersion({ engine: 'docker', containerName: 'codeman-case-x' }, 'claude')
    ).toBeUndefined();
  });
});
