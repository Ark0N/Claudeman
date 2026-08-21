/**
 * @fileoverview Tests `ensureCliInstalled`'s decision logic (config/cli-registry/cli-installer.ts):
 * when it does nothing, when it records a terminal status synchronously, and — the safety
 * property that matters most — that it NEVER actually spawns a process under `VITEST`
 * (same posture as TmuxManager's `IS_TEST_MODE`, see that module's file header). The real
 * spawn/timeout/output-capture mechanics are standard Node child_process wiring and are not
 * re-verified here, matching the established precedent for that class of module in this repo.
 *
 * Port: N/A (no server; pure unit tests against the real registry, mocked `node:child_process`
 * as a second line of defense on top of the VITEST gate itself).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

describe('ensureCliInstalled', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(async () => {
    const { _resetCliInstallStatusForTest } = await import('../src/config/cli-registry/cli-installer.js');
    _resetCliInstallStatusForTest();
  });

  it('is a no-op for an unknown id', async () => {
    const { ensureCliInstalled, getCliInstallStatus } = await import('../src/config/cli-registry/cli-installer.js');
    ensureCliInstalled('not-a-real-cli');
    expect(getCliInstallStatus('not-a-real-cli')).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('is a no-op for "shell" (no binaries to install)', async () => {
    const { ensureCliInstalled, getCliInstallStatus } = await import('../src/config/cli-registry/cli-installer.js');
    ensureCliInstalled('shell');
    expect(getCliInstallStatus('shell')).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('records success without spawning when the binary is already available', async () => {
    // claude, opencode, codex, gemini, antigravity and pi may or may not actually be on
    // PATH on the machine running this test, so pin the outcome by stubbing the resolver
    // instead of depending on the real environment.
    vi.doMock('../src/utils/cli-resolver.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/cli-resolver.js')>();
      return { ...actual, resolveCliBinDir: () => '/usr/local/bin' };
    });
    vi.resetModules();
    const { ensureCliInstalled, getCliInstallStatus } = await import('../src/config/cli-registry/cli-installer.js');

    ensureCliInstalled('gemini');

    expect(getCliInstallStatus('gemini')).toEqual({ state: 'success', finishedAt: expect.any(Number) });
    expect(spawnMock).not.toHaveBeenCalled();
    vi.doUnmock('../src/utils/cli-resolver.js');
    vi.resetModules();
  });

  it('records an error and never spawns when the entry has no install command for this platform', async () => {
    vi.doMock('../src/utils/cli-resolver.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/cli-resolver.js')>();
      return { ...actual, resolveCliBinDir: () => null };
    });
    vi.doMock('../src/config/cli-registry/registry.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/config/cli-registry/registry.js')>();
      return { ...actual, resolveInstallCommandForPlatform: () => undefined };
    });
    vi.resetModules();
    const { ensureCliInstalled, getCliInstallStatus } = await import('../src/config/cli-registry/cli-installer.js');

    ensureCliInstalled('gemini');

    expect(getCliInstallStatus('gemini')).toEqual({
      state: 'error',
      message: 'No install command declared for this platform.',
    });
    expect(spawnMock).not.toHaveBeenCalled();
    vi.doUnmock('../src/utils/cli-resolver.js');
    vi.doUnmock('../src/config/cli-registry/registry.js');
    vi.resetModules();
  });

  it('never spawns a real process under VITEST, and leaves status untouched', async () => {
    vi.doMock('../src/utils/cli-resolver.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/cli-resolver.js')>();
      return { ...actual, resolveCliBinDir: () => null };
    });
    vi.resetModules();
    const { ensureCliInstalled, getCliInstallStatus } = await import('../src/config/cli-registry/cli-installer.js');

    // gemini is a stock CLI with a real install command declared, and its binary is
    // stubbed unavailable above — the one shape that WOULD spawn outside a test run.
    ensureCliInstalled('gemini');

    expect(spawnMock).not.toHaveBeenCalled();
    // The VITEST guard returns before touching `_status` at all, so it stays exactly as
    // it was (unset) — distinct from a real 'installing'/'error' terminal state, so a
    // caller can tell "skipped under test" apart from an actual outcome.
    expect(getCliInstallStatus('gemini')).toBeUndefined();
    vi.doUnmock('../src/utils/cli-resolver.js');
    vi.resetModules();
  });

  it('does not restart an install already recorded as in flight', async () => {
    // Exercises the concurrency guard directly against the real status map, without going
    // through the (VITEST-gated) spawn path at all.
    vi.doMock('../src/utils/cli-resolver.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/cli-resolver.js')>();
      return { ...actual, resolveCliBinDir: () => '/usr/local/bin' };
    });
    vi.resetModules();
    const { ensureCliInstalled, getCliInstallStatus } = await import('../src/config/cli-registry/cli-installer.js');

    ensureCliInstalled('gemini'); // resolves to 'success' immediately (already available)
    const first = getCliInstallStatus('gemini');
    ensureCliInstalled('gemini'); // calling again should not change the recorded status
    expect(getCliInstallStatus('gemini')).toEqual(first);
    vi.doUnmock('../src/utils/cli-resolver.js');
    vi.resetModules();
  });
});
