/**
 * @fileoverview Tests for the DeepSeek Harness (`dsh`) resolver and profile inventory.
 *
 * `dsh` needs the strictest identity probe of any CLI Codeman resolves. pi and
 * grok are short names with npm squatters; `dsh` is worse — it is an EXISTING,
 * widely packaged Unix program (Debian's dancer's shell, `apt install dsh`),
 * which would sail through a version-token probe and then be handed a spawn
 * line. So the resolver demands the harness's own help banner first, and the
 * headline test below is the one that pins that rejection.
 *
 * The second half covers something no sibling resolver has: a profile
 * inventory. `dsh` is a launcher, so "is it installed" and "can it run a
 * session" are different questions, and the availability gate needs both.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeepSeekResolverForTest,
  DEEPSEEK_VERSION_REGEX,
  DEEPSEEK_IDENTITY_REGEX,
  listDeepSeekProfiles,
  resolveDefaultDeepSeekProfile,
  isLaunchableProfile,
  resolveDshHome,
} from '../src/utils/deepseek-cli-resolver.js';
import {
  cliResolveRetryDelayMs,
  createProductionCliResolverHost,
  type CliResolverHost,
} from '../src/utils/cli-executable-resolver.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHost(
  options: {
    processPathResult?: string | null;
    loginShellResults?: Array<string | null>;
    existingPaths?: string[];
  } = {}
): CliResolverHost {
  const loginShellResults = [...(options.loginShellResults ?? [])];
  const existingPaths = new Set(options.existingPaths ?? []);
  return {
    processPath: '/service/bin',
    shellPath: '/bin/zsh',
    shellArgs: ['-l'],
    findOnProcessPath: () => options.processPathResult ?? null,
    findInLoginShell: () => loginShellResults.shift() ?? null,
    exists: (path) => existingPaths.has(path),
  };
}

describe('DeepSeek CLI resolver', () => {
  it('accepts a candidate the probe verifies and carries the version as metadata', () => {
    const binaryPath = '/service/bin/dsh';
    const probe = vi.fn(() => '0.1.1-rc.2');
    const resolver = createDeepSeekResolverForTest(
      createHost({ processPathResult: binaryPath, existingPaths: [binaryPath] }),
      probe
    );

    expect(resolver.resolve()).toMatchObject({
      binaryPath,
      directory: '/service/bin',
      source: 'process-path',
      metadata: '0.1.1-rc.2',
    });
    expect(probe).toHaveBeenCalledWith(binaryPath);
  });

  it('does not let a foreign `dsh` earlier on PATH mask the real one', () => {
    // The dancer's-shell case, at resolver level: a `dsh` that is a real program
    // and answers --version must still be refused, and must not stop the search.
    const impostor = '/usr/bin/dsh';
    const genuine = '/login-shell/bin/dsh';
    const probe = vi.fn((binPath: string) => (binPath === genuine ? '0.1.1-rc.2' : null));
    const resolver = createDeepSeekResolverForTest(
      createHost({
        processPathResult: impostor,
        loginShellResults: [genuine],
        existingPaths: [impostor, genuine],
      }),
      probe
    );

    expect(resolver.resolve()).toMatchObject({ binaryPath: genuine, source: 'login-shell' });
  });

  it('negative-caches a miss and retries only after the backoff elapses', () => {
    const binaryPath = '/late/bin/dsh';
    let now = 0;
    const probe = vi.fn(() => '0.1.1-rc.2');
    const resolver = createDeepSeekResolverForTest(
      createHost({ loginShellResults: [null, binaryPath], existingPaths: [binaryPath] }),
      probe,
      () => now
    );

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()).toBeNull(); // within the backoff: no re-run
    expect(probe).not.toHaveBeenCalled();
    now = cliResolveRetryDelayMs(1);
    expect(resolver.resolve()?.metadata).toBe('0.1.1-rc.2');
  });

  it('extracts the version from the real output shape (a bare `0.1.1-rc.2`)', () => {
    // Shared with the dependency registry (doctor), so the accepted shape is
    // contract. The prerelease tail is part of the token on purpose: dropping it
    // would report a release candidate as a release.
    expect(DEEPSEEK_VERSION_REGEX.exec('0.1.1-rc.2')?.[1]).toBe('0.1.1-rc.2');
    expect(DEEPSEEK_VERSION_REGEX.exec('dsh 1.2.3')?.[1]).toBe('1.2.3');
    expect(DEEPSEEK_VERSION_REGEX.exec('not a version')).toBeNull();
  });

  it('identifies the harness by its help banner and rejects a foreign dsh', () => {
    expect(DEEPSEEK_IDENTITY_REGEX.test('dsh: boot a DeepSeek Harness profile — an ordered stack')).toBe(true);
    // Debian's dancer's shell: a real program, a real version, not our agent.
    expect(DEEPSEEK_IDENTITY_REGEX.test('Usage: dsh [options] [command] ...\nDistributed shell')).toBe(false);
  });

  it('never executes a dsh candidate under vitest (the ambient probe is VITEST-gated)', () => {
    // A REAL executable fixture that answers BOTH probes convincingly. If the
    // guard in probeDeepSeekVersion is ever removed, this script runs, the
    // resolution SUCCEEDS, and this test fails — pinning hermeticity by
    // behavior rather than by source text. That matters more here than for any
    // sibling: `dsh` is a name real machines genuinely carry.
    const root = mkdtempSync(join(tmpdir(), 'codeman-dsh-vitest-gate-'));
    temporaryDirectories.push(root);
    const binaryPath = join(root, 'dsh');
    writeFileSync(
      binaryPath,
      '#!/bin/sh\ncase "$1" in --help) echo "dsh: boot a DeepSeek Harness profile";; *) echo "9.9.9";; esac\n'
    );
    chmodSync(binaryPath, 0o755);
    const hostOptions = {
      processPath: root,
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'] as string[],
      runCommand: () => '',
      isExecutableFile: (path: string) => path === binaryPath,
    };

    const gated = createDeepSeekResolverForTest(createProductionCliResolverHost(hostOptions));
    expect(gated.resolve()).toBeNull();

    // Control: identical setup with an injected probe resolves, proving the null
    // above comes from the gate, not from the fixture or the host.
    const control = createDeepSeekResolverForTest(createProductionCliResolverHost(hostOptions), () => '9.9.9');
    expect(control.resolve()).toMatchObject({ binaryPath, metadata: '9.9.9' });
  });
});

describe('DeepSeek profile inventory', () => {
  let home: string;
  const ORIGINAL_DSH_HOME = process.env.DSH_HOME;

  function writeProfile(name: string, bundles: string[]): void {
    const dir = join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `dsh-profile-${name}`, dsh: { profile: { bundles } } })
    );
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-dsh-home-'));
    temporaryDirectories.push(home);
    process.env.DSH_HOME = home;
  });

  afterEach(() => {
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME;
  });

  it('honours DSH_HOME over the default ~/.dsh', () => {
    expect(resolveDshHome()).toBe(home);
  });

  it('is empty (not an error) when dsh has never been run', () => {
    rmSync(home, { recursive: true, force: true });
    expect(listDeepSeekProfiles()).toEqual([]);
    expect(resolveDefaultDeepSeekProfile()).toBeNull();
  });

  it('classifies the profiles DeepSeek ships as unable to drive a pane', () => {
    writeProfile('web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    writeProfile('headless', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']);

    const profiles = listDeepSeekProfiles();
    expect(profiles.map((p) => `${p.name}:${p.kind}`).sort()).toEqual(['headless:headless', 'web:web']);
    expect(profiles.every((p) => !isLaunchableProfile(p))).toBe(true);
    // The whole point: a perfectly installed dsh with only the shipped profiles
    // still cannot start a Codeman session.
    expect(resolveDefaultDeepSeekProfile()).toBeNull();
  });

  it('prefers an interactive profile and ignores node_modules', () => {
    writeProfile('web', ['@deepseek-ai/dsh-web-app']);
    writeProfile('dsh-tui', ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']);
    mkdirSync(join(home, 'profiles', 'node_modules', 'something'), { recursive: true });

    const names = listDeepSeekProfiles().map((p) => p.name);
    expect(names).not.toContain('node_modules');
    expect(resolveDefaultDeepSeekProfile()).toBe('dsh-tui');
  });

  it('treats an unrecognized third-party profile as launchable', () => {
    // Anyone can publish an app bundle, so an unknown profile must not be hidden
    // from the picker just because this classifier has not heard of it.
    writeProfile('custom', ['@someone/dsh-my-own-surface']);
    const profile = listDeepSeekProfiles().find((p) => p.name === 'custom')!;
    expect(profile.kind).toBe('unknown');
    expect(isLaunchableProfile(profile)).toBe(true);
    expect(resolveDefaultDeepSeekProfile()).toBe('custom');
  });

  it('survives a stray directory under profiles/', () => {
    mkdirSync(join(home, 'profiles', 'not-a-profile'), { recursive: true });
    writeProfile('dsh-tui', ['@deepseek-harness-tui/dsh-tui']);
    expect(listDeepSeekProfiles().map((p) => p.name)).toEqual(['dsh-tui']);
  });
});
