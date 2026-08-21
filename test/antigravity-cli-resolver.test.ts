/**
 * @fileoverview Tests for the Antigravity CLI resolver wrapper.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAntigravityResolverForTest, isAntigravityAvailable } from '../src/utils/antigravity-cli-resolver.js';
import type { CliResolution, CliResolverHost } from '../src/utils/cli-executable-resolver.js';

const availabilityResolution = vi.hoisted(() => ({ current: null as CliResolution | null }));

vi.mock('../src/utils/cli-executable-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/cli-executable-resolver.js')>();
  return {
    ...actual,
    createCliExecutableResolver: (options: { binary: string; searchDirs: string[] }, host?: CliResolverHost) =>
      host
        ? actual.createCliExecutableResolver(options, host)
        : {
            resolve: () => availabilityResolution.current,
            diagnostics: () => ({
              binary: options.binary,
              processPath: '/service/bin',
              shellPath: '/bin/zsh',
              shellArgs: ['-l'],
              searchDirs: [...options.searchDirs],
            }),
          },
  };
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

describe('Antigravity CLI resolver', () => {
  beforeEach(() => {
    availabilityResolution.current = null;
  });

  it('resolves agy from the service PATH', () => {
    const binaryPath = '/service/bin/agy';
    const resolver = createAntigravityResolverForTest(
      createHost({ processPathResult: binaryPath, existingPaths: [binaryPath] })
    );

    expect(resolver.resolve()?.directory).toBe('/service/bin');
  });

  it('falls back to a common install directory', () => {
    const binaryPath = join(homedir(), '.local', 'bin', 'agy');
    const resolver = createAntigravityResolverForTest(createHost({ existingPaths: [binaryPath] }));

    expect(resolver.resolve()?.directory).toBe(join(homedir(), '.local', 'bin'));
  });

  it('resolves agy found only by the login shell', () => {
    const binaryPath = '/login-shell/bin/agy';
    const resolver = createAntigravityResolverForTest(
      createHost({ loginShellResults: [binaryPath], existingPaths: [binaryPath] })
    );

    expect(resolver.resolve()?.directory).toBe('/login-shell/bin');
  });

  it('returns null when agy is unavailable', () => {
    const resolver = createAntigravityResolverForTest(createHost());

    expect(resolver.resolve()).toBeNull();
  });

  it('retries a failed lookup and caches the first successful login-shell discovery', () => {
    const binaryPath = '/late-login-shell/bin/agy';
    const resolver = createAntigravityResolverForTest(
      createHost({ loginShellResults: [null, binaryPath], existingPaths: [binaryPath] })
    );

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()?.binaryPath).toBe(binaryPath);
    expect(resolver.resolve()?.binaryPath).toBe(binaryPath);
  });

  it('reports the public wrapper as available when agy resolves', () => {
    availabilityResolution.current = {
      binaryPath: '/service/bin/agy',
      directory: '/service/bin',
      source: 'process-path',
    };

    expect(isAntigravityAvailable()).toBe(true);
  });

  it('reports the public wrapper as unavailable when agy does not resolve', () => {
    expect(isAntigravityAvailable()).toBe(false);
  });
});
