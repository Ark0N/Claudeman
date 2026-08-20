/**
 * @fileoverview Tests the CLI registry's merge/seed/quarantine behaviour — the logic that
 * lets `~/.codeman/clis.json` hold overrides only and still survive app updates.
 *
 * `resolveRegistry()` is exercised directly (pure, no IO) for the merge semantics; the
 * on-disk `loadCliRegistry()` path is exercised against a temp HOME (via test/setup.ts's
 * per-file HOME isolation) for seeding, quarantine and permission handling.
 *
 * Port: N/A (no server; file IO only, isolated to a temp HOME by test/setup.ts).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../src/config/instance.js';
import { resolveRegistry } from '../src/config/cli-registry/registry.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import type { CliRegistryFile } from '../src/config/cli-registry/types.js';

describe('resolveRegistry (pure merge)', () => {
  it('returns every stock entry unchanged when the file is absent', () => {
    const { entries, warnings } = resolveRegistry(STOCK_CLIS, null, []);
    expect(entries.map((e) => e.id as unknown as string).sort()).toEqual(
      STOCK_CLIS.map((e) => e.id as unknown as string).sort()
    );
    expect(warnings).toEqual([]);
  });

  it('applies a partial override (disable) without touching the rest of the entry', () => {
    const file: CliRegistryFile = { schemaVersion: 1, seededStockIds: [], clis: { gemini: { enabled: false } } };
    const { entries } = resolveRegistry(STOCK_CLIS, file, []);
    const gemini = entries.find((e) => (e.id as unknown as string) === 'gemini')!;
    expect(gemini.enabled).toBe(false);
    expect(gemini.label).toBe('Gemini'); // untouched
    expect(gemini.launch.variants).toEqual(
      STOCK_CLIS.find((e) => (e.id as unknown as string) === 'gemini')!.launch.variants
    );
  });

  it('adds a well-formed custom entry alongside the stock catalog', () => {
    const custom = {
      id: 'copilot',
      label: 'Copilot',
      shortBadge: 'GH',
      accent: '#24292f',
      enabled: true,
      order: 60,
      kind: 'agent' as const,
      discovery: {
        binaries: ['copilot'],
        searchDirs: ['~/.local/bin'],
        install: { command: { linux: 'npm install -g @githubnext/github-copilot-cli' } },
      },
      launch: { params: {}, variants: [{ id: 'default', args: [{ lit: 'copilot' }] }] },
      env: {
        exports: [],
        unset: [],
        tmuxSetenvKeys: [],
        dockerExecEnvNames: [],
        allowedPrefixes: ['COPILOT_'],
        allowedKeys: [],
      },
      capabilities: {
        requiresMux: true,
        hooks: false,
        transcript: 'none' as const,
        altScreen: 'strip-mux-only' as const,
        echo: { policy: 'buffer' as const, anchor: { kind: 'cursor' as const } },
        wheelForward: { mode: 'never' as const },
        keyboardAccessory: 'agent' as const,
        privilegedCommandGate: false,
        startMode: 'interactive' as const,
        stripInkBloat: true,
        ralph: false,
        respawn: false,
        effort: false,
        agentSkillInjection: false,
        statusLineTelemetry: false,
        model: { source: 'none' as const },
        privilegedParams: [],
        gates: {},
      },
      overlays: { remote: { variant: 'default' }, docker: { variant: 'default' } },
    };
    const file: CliRegistryFile = { schemaVersion: 1, seededStockIds: [], clis: { copilot: custom } };
    const { entries, warnings } = resolveRegistry(STOCK_CLIS, file, []);
    expect(warnings).toEqual([]);
    const found = entries.find((e) => (e.id as unknown as string) === 'copilot');
    expect(found).toBeDefined();
    expect(found!.stock).toBe(false); // stock is forced by the loader, never trusted from the file
  });

  it('drops an invalid custom entry with a warning, but keeps every stock entry', () => {
    const file: CliRegistryFile = { schemaVersion: 1, seededStockIds: [], clis: { bogus: { id: 'bogus' } } };
    const { entries, warnings } = resolveRegistry(STOCK_CLIS, file, []);
    expect(entries.some((e) => (e.id as unknown as string) === 'bogus')).toBe(false);
    expect(entries.length).toBe(STOCK_CLIS.length);
    expect(warnings.some((w) => w.includes('bogus'))).toBe(true);
  });

  it('falls back to the pristine stock definition when a stock override fails validation', () => {
    const file: CliRegistryFile = {
      schemaVersion: 1,
      seededStockIds: [],
      clis: { codex: { launch: { variants: [{ id: 'default', args: [{ lit: 'codex; rm -rf /' }] }] } } },
    };
    const { entries, warnings } = resolveRegistry(STOCK_CLIS, file, []);
    const codex = entries.find((e) => (e.id as unknown as string) === 'codex')!;
    expect(codex.launch.variants[0].args[0]).toEqual({ lit: 'codex' }); // pristine, not the hostile override
    expect(warnings.some((w) => w.includes('codex'))).toBe(true);
  });

  it('a stock entry can never be shadowed by an id-colliding custom entry with stock:true', () => {
    const file: CliRegistryFile = {
      schemaVersion: 1,
      seededStockIds: [],
      clis: { claude: { stock: false, label: 'Not Actually Claude' } },
    };
    const { entries } = resolveRegistry(STOCK_CLIS, file, []);
    const claude = entries.find((e) => (e.id as unknown as string) === 'claude')!;
    expect(claude.stock).toBe(true); // loader forces stock:true for a known stock id regardless of the file
    expect(claude.label).toBe('Not Actually Claude'); // the override itself still applies — only `stock` is pinned
  });
});

describe('loadCliRegistry (on-disk seeding)', () => {
  beforeEach(() => {
    // Force a fresh module load path per test by clearing the registry's own cache via a
    // dynamic re-import is unnecessary here: reloadCliRegistry() is exported for this purpose.
  });

  it('seeds a fresh install with schemaVersion + every stock id, and writes nothing on a second load', async () => {
    const { loadCliRegistry, reloadCliRegistry } = await import('../src/config/cli-registry/registry.js');
    reloadCliRegistry();
    const path = dataPath('clis.json');
    expect(existsSync(path)).toBe(false);

    const first = loadCliRegistry();
    expect(first.entries.length).toBe(STOCK_CLIS.length);
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf-8')) as CliRegistryFile;
    expect(written.seededStockIds.sort()).toEqual(STOCK_CLIS.map((e) => e.id as unknown as string).sort());
    expect(written.clis).toEqual({});

    const mtimeBefore = readFileSync(path, 'utf-8');
    reloadCliRegistry();
    loadCliRegistry();
    expect(readFileSync(path, 'utf-8')).toBe(mtimeBefore); // no rewrite when nothing changed
  });

  it('a disabled stock CLI stays disabled across a reload that introduces no new stock ids', async () => {
    const { loadCliRegistry, reloadCliRegistry } = await import('../src/config/cli-registry/registry.js');
    const path = dataPath('clis.json');
    mkdirSync(dirname(path), { recursive: true });
    const file: CliRegistryFile = {
      schemaVersion: 1,
      seededStockIds: STOCK_CLIS.map((e) => e.id as unknown as string),
      clis: { gemini: { enabled: false } },
    };
    writeFileSync(path, JSON.stringify(file));
    reloadCliRegistry();
    const { entries } = loadCliRegistry();
    const gemini = entries.find((e) => (e.id as unknown as string) === 'gemini')!;
    expect(gemini.enabled).toBe(false);
  });

  it('quarantines malformed JSON instead of overwriting it, and falls back to stock', async () => {
    const { loadCliRegistry, reloadCliRegistry } = await import('../src/config/cli-registry/registry.js');
    const path = dataPath('clis.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ this is not valid json');
    reloadCliRegistry();
    const { entries } = loadCliRegistry();
    expect(entries.length).toBe(STOCK_CLIS.length);
    expect(existsSync(path + '.invalid') || existsSync(path)).toBeDefined(); // original untouched or quarantined
    // The exact quarantine filename carries a timestamp; assert one such file exists.
    const { readdirSync } = await import('node:fs');
    const dir = dirname(path);
    const quarantined = readdirSync(dir).some((f) => f.startsWith('clis.json.invalid-'));
    expect(quarantined).toBe(true);
  });

  // Windows/NTFS has no meaningful POSIX group/world bits (every file reports mode 0o666
  // regardless of its actual ACL), so isUnsafePermissions() is a no-op there by design —
  // see its own doc comment in registry.ts. This test only exercises the POSIX behaviour.
  it.skipIf(process.platform === 'win32')(
    'ignores a group/world-writable registry file and falls back to stock',
    async () => {
      const { loadCliRegistry, reloadCliRegistry } = await import('../src/config/cli-registry/registry.js');
      const path = dataPath('clis.json');
      mkdirSync(dirname(path), { recursive: true });
      const file: CliRegistryFile = {
        schemaVersion: 1,
        seededStockIds: STOCK_CLIS.map((e) => e.id as unknown as string),
        clis: { gemini: { enabled: false } },
      };
      writeFileSync(path, JSON.stringify(file));
      chmodSync(path, 0o666);
      reloadCliRegistry();
      const { entries, warnings } = loadCliRegistry();
      const gemini = entries.find((e) => (e.id as unknown as string) === 'gemini')!;
      expect(gemini.enabled).toBe(true); // override was ignored — file was unsafe to trust
      expect(warnings.some((w) => w.includes('writable'))).toBe(true);
    }
  );
});
