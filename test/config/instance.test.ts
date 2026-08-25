/**
 * Per-instance isolation (src/config/instance.ts): the data dir + tmux socket
 * derive from CODEMAN_INSTANCE, defaulting to the production layout so the
 * feature branch is safe to merge to master.
 *
 * instance.ts reads env at module load, so each case re-imports it via
 * vi.resetModules() under a controlled env. node:fs mkdirSync is mocked so
 * getDataDir() never creates real directories on the test machine.
 *
 * Port: N/A (no server).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn() };
});

const ENV_KEYS = ['CODEMAN_INSTANCE', 'CODEMAN_DATA_DIR', 'CODEMAN_TMUX_SOCKET'] as const;
const ORIG: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}) {
  vi.resetModules();
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../../src/config/instance.js');
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.resetModules();
});

describe('config/instance', () => {
  it('defaults to the production layout when CODEMAN_INSTANCE is unset', async () => {
    const m = await load({ CODEMAN_INSTANCE: undefined, CODEMAN_DATA_DIR: undefined });
    expect(m.CODEMAN_INSTANCE).toBe('');
    expect(m.DEFAULT_TMUX_SOCKET).toBe('codeman');
    expect(m.getDataDir()).toBe(join(homedir(), '.codeman'));
    expect(m.dataPath('state.json')).toBe(join(homedir(), '.codeman', 'state.json'));
  });

  it('treats an explicitly-empty CODEMAN_INSTANCE as the production layout', async () => {
    const m = await load({ CODEMAN_INSTANCE: '', CODEMAN_DATA_DIR: undefined });
    expect(m.CODEMAN_INSTANCE).toBe('');
    expect(m.DEFAULT_TMUX_SOCKET).toBe('codeman');
    expect(m.getDataDir()).toBe(join(homedir(), '.codeman'));
  });

  it('scopes BOTH the data dir and the tmux socket for a named instance', async () => {
    const m = await load({ CODEMAN_INSTANCE: 'beta', CODEMAN_DATA_DIR: undefined });
    expect(m.CODEMAN_INSTANCE).toBe('beta');
    expect(m.DEFAULT_TMUX_SOCKET).toBe('codeman-beta');
    expect(m.getDataDir()).toBe(join(homedir(), '.codeman-beta'));
    expect(m.dataPath('mux-sessions.json')).toBe(join(homedir(), '.codeman-beta', 'mux-sessions.json'));
  });

  it('supports an arbitrary instance name', async () => {
    const m = await load({ CODEMAN_INSTANCE: 'foo', CODEMAN_DATA_DIR: undefined });
    expect(m.DEFAULT_TMUX_SOCKET).toBe('codeman-foo');
    expect(m.getDataDir()).toBe(join(homedir(), '.codeman-foo'));
  });

  it('CODEMAN_DATA_DIR overrides the derived data dir (socket still instance-scoped)', async () => {
    const m = await load({ CODEMAN_INSTANCE: 'beta', CODEMAN_DATA_DIR: '/tmp/codeman-test-xyz' });
    expect(m.getDataDir()).toBe('/tmp/codeman-test-xyz');
    expect(m.dataPath('a', 'b')).toBe(join('/tmp/codeman-test-xyz', 'a', 'b'));
    // Socket is derived from the instance name, not the data dir override.
    expect(m.DEFAULT_TMUX_SOCKET).toBe('codeman-beta');
  });
});

describe('resolveTmuxSocketName', () => {
  it('is the instance socket when no override is set', async () => {
    const m = await load({ CODEMAN_INSTANCE: 'beta', CODEMAN_TMUX_SOCKET: undefined });
    expect(m.resolveTmuxSocketName()).toBe('codeman-beta');
  });

  it('honours a safe CODEMAN_TMUX_SOCKET override', async () => {
    const m = await load({ CODEMAN_INSTANCE: undefined, CODEMAN_TMUX_SOCKET: 'codeman-test.1' });
    expect(m.resolveTmuxSocketName()).toBe('codeman-test.1');
  });

  it('ignores an override that could not be passed to `tmux -L` safely', async () => {
    // A socket name reaches a command line, so anything outside the pattern
    // falls back to the instance default rather than being escaped.
    const m = await load({ CODEMAN_INSTANCE: undefined, CODEMAN_TMUX_SOCKET: 'bad; rm -rf /' });
    expect(m.resolveTmuxSocketName()).toBe('codeman');
  });
});
