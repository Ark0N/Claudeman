/**
 * @fileoverview Tests for the Grok CLI resolver wrapper.
 *
 * Grok is the second resolver with a version probe: `grok` is a binary name
 * with known squatters (the unrelated @vibe-kit/grok-cli npm package also
 * installs a `grok` bin), so a resolved path is only accepted once
 * `grok --version` prints a version-shaped string. The probe EXECUTES the
 * candidate, which is exactly why it must never run under vitest: the
 * hermeticity test below pins that gate with a real executable fixture, the
 * same behavior-level pin test/pi-cli-resolver.test.ts carries.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrokResolverForTest, GROK_VERSION_REGEX } from '../src/utils/grok-cli-resolver.js';
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

describe('Grok CLI resolver', () => {
  it('accepts a candidate the version probe verifies and carries the version as metadata', () => {
    const binaryPath = '/service/bin/grok';
    const probe = vi.fn(() => '1.0.5');
    const resolver = createGrokResolverForTest(
      createHost({ processPathResult: binaryPath, existingPaths: [binaryPath] }),
      probe
    );

    expect(resolver.resolve()).toMatchObject({
      binaryPath,
      directory: '/service/bin',
      source: 'process-path',
      metadata: '1.0.5',
    });
    expect(probe).toHaveBeenCalledWith(binaryPath);
  });

  it('rejects a candidate the probe refuses and falls through to a later one', () => {
    // An unrelated `grok` on the service PATH (probe returns null) must not
    // mask the real coding agent found by the login shell.
    const impostor = '/service/bin/grok';
    const genuine = '/login-shell/bin/grok';
    const probe = vi.fn((binPath: string) => (binPath === genuine ? '1.0.5' : null));
    const resolver = createGrokResolverForTest(
      createHost({
        processPathResult: impostor,
        loginShellResults: [genuine],
        existingPaths: [impostor, genuine],
      }),
      probe
    );

    expect(resolver.resolve()).toMatchObject({ binaryPath: genuine, source: 'login-shell', metadata: '1.0.5' });
  });

  it('negative-caches a miss and retries only after the backoff elapses', () => {
    const binaryPath = '/late/bin/grok';
    let now = 0;
    const probe = vi.fn(() => '1.0.5');
    const resolver = createGrokResolverForTest(
      createHost({ loginShellResults: [null, binaryPath], existingPaths: [binaryPath] }),
      probe,
      () => now
    );

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()).toBeNull(); // within the backoff: no re-run
    expect(probe).not.toHaveBeenCalled();
    now = cliResolveRetryDelayMs(1);
    expect(resolver.resolve()?.metadata).toBe('1.0.5');
    expect(resolver.resolve()?.binaryPath).toBe(binaryPath);
  });

  it('extracts the version from the real output shape (`grok 1.0.5 (5115b46bc9)`)', () => {
    // GROK_VERSION_REGEX is shared with the dependency registry (doctor), so the
    // shape it accepts is contract, not implementation detail.
    expect(GROK_VERSION_REGEX.exec('grok 1.0.5 (5115b46bc9)')?.[1]).toBe('1.0.5');
    expect(GROK_VERSION_REGEX.exec('1.0.5')?.[1]).toBe('1.0.5');
    expect(GROK_VERSION_REGEX.exec('v1.0.5')).toBeNull();
    expect(GROK_VERSION_REGEX.exec('not a version')).toBeNull();
  });

  it('never executes a grok candidate under vitest (the ambient probe is VITEST-gated)', () => {
    // A REAL executable fixture that prints a valid version. If the guard in
    // probeGrokVersion is ever removed, the probe runs this script, the
    // resolution SUCCEEDS, and this test fails, pinning hermeticity by
    // behavior rather than by source text.
    const root = mkdtempSync(join(tmpdir(), 'codeman-grok-vitest-gate-'));
    temporaryDirectories.push(root);
    const binaryPath = join(root, 'grok');
    writeFileSync(binaryPath, '#!/bin/sh\necho "grok 9.9.9 (deadbeef)"\n');
    chmodSync(binaryPath, 0o755);
    const hostOptions = {
      processPath: root,
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'] as string[],
      runCommand: () => '',
      isExecutableFile: (path: string) => path === binaryPath,
    };

    // Default (ambient) probe: the candidate is found but never executed, so
    // the VITEST gate reports it unusable and resolution misses.
    const gated = createGrokResolverForTest(createProductionCliResolverHost(hostOptions));
    expect(gated.resolve()).toBeNull();

    // Control: identical setup with an injected probe resolves, proving the
    // null above comes from the gate, not from the fixture or the host.
    const control = createGrokResolverForTest(createProductionCliResolverHost(hostOptions), () => '9.9.9');
    expect(control.resolve()).toMatchObject({ binaryPath, metadata: '9.9.9' });
  });
});
