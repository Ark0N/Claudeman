/**
 * @fileoverview Tests for the OMP CLI resolver wrapper.
 *
 * OMP is a resolver with a version probe: `omp` is a short binary name, so a
 * resolved path is only accepted once `omp --version` prints an `omp/<semver>`
 * string (e.g. `omp/17.4.0`). The probe EXECUTES the candidate, which is
 * exactly why it must never run under vitest — the hermeticity test below pins
 * that gate with a real executable fixture that would make the test fail
 * loudly if the gate were deleted again.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOmpResolverForTest } from '../src/utils/omp-cli-resolver.js';
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

describe('OMP CLI resolver', () => {
  it('accepts a candidate the version probe verifies and carries the version as metadata', () => {
    const binaryPath = '/service/bin/omp';
    const probe = vi.fn(() => '17.4.0');
    const resolver = createOmpResolverForTest(
      createHost({ processPathResult: binaryPath, existingPaths: [binaryPath] }),
      probe
    );

    expect(resolver.resolve()).toMatchObject({
      binaryPath,
      directory: '/service/bin',
      source: 'process-path',
      metadata: '17.4.0',
    });
    expect(probe).toHaveBeenCalledWith(binaryPath);
  });

  it('rejects a candidate the probe refuses and falls through to a later one', () => {
    // An unrelated `omp` on the service PATH (probe returns null) must not mask
    // the real coding agent found by the login shell.
    const impostor = '/service/bin/omp';
    const genuine = '/login-shell/bin/omp';
    const probe = vi.fn((binPath: string) => (binPath === genuine ? '17.4.0' : null));
    const resolver = createOmpResolverForTest(
      createHost({
        processPathResult: impostor,
        loginShellResults: [genuine],
        existingPaths: [impostor, genuine],
      }),
      probe
    );

    expect(resolver.resolve()).toMatchObject({ binaryPath: genuine, source: 'login-shell', metadata: '17.4.0' });
  });

  it('negative-caches a miss and retries only after the backoff elapses', () => {
    const binaryPath = '/late/bin/omp';
    let now = 0;
    const probe = vi.fn(() => '17.4.0');
    const resolver = createOmpResolverForTest(
      createHost({ loginShellResults: [null, binaryPath], existingPaths: [binaryPath] }),
      probe,
      () => now
    );

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()).toBeNull(); // within the backoff: no re-run
    expect(probe).not.toHaveBeenCalled();
    now = cliResolveRetryDelayMs(1);
    expect(resolver.resolve()?.metadata).toBe('17.4.0');
    expect(resolver.resolve()?.binaryPath).toBe(binaryPath);
  });

  it('never executes an omp candidate under vitest (the ambient probe is VITEST-gated)', () => {
    // A REAL executable fixture that prints a valid version. If the guard in
    // probeOmpVersion is ever removed again, the probe runs this script, the
    // resolution SUCCEEDS, and this test fails — pinning hermeticity by
    // behavior rather than by source text. (The suites must never execute
    // whatever `omp` binary the machine running them happens to carry.)
    const root = mkdtempSync(join(tmpdir(), 'codeman-omp-vitest-gate-'));
    temporaryDirectories.push(root);
    const binaryPath = join(root, 'omp');
    writeFileSync(binaryPath, '#!/bin/sh\necho omp/0.99.0\n');
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
    const gated = createOmpResolverForTest(createProductionCliResolverHost(hostOptions));
    expect(gated.resolve()).toBeNull();

    // Control: identical setup with an injected probe resolves, proving the
    // null above comes from the gate, not from the fixture or the host.
    const control = createOmpResolverForTest(createProductionCliResolverHost(hostOptions), () => '0.99.0');
    expect(control.resolve()).toMatchObject({ binaryPath, metadata: '0.99.0' });
  });
});
