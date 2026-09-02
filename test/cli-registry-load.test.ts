/**
 * @fileoverview Loading and merging `~/.codeman/clis.json` over the stock catalog.
 *
 * Two properties matter most here and neither is obvious from reading the loader:
 *
 * 1. A BAD OVERRIDE MUST NOT BRICK A SHIPPED CLI. The file is hand-editable, so a typo is a
 *    matter of when, not if. A stock entry that fails validation after merge falls back to
 *    its pristine definition; a custom entry that fails is dropped. Neither takes the rest
 *    of the catalog down with it.
 * 2. LOADING WRITES NOTHING. There is no settings UI and no write API in this build, so
 *    there is nothing to persist — and `src/web/schemas.ts` imports the registry just to
 *    validate a request, which would make any write here a filesystem side effect of
 *    parsing HTTP input.
 *
 * Port: none (`resolveRegistry` is pure; the on-disk cases use the per-file temp HOME from
 * test/setup.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../src/config/instance.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import { resolveRegistry, loadCliRegistry, reloadCliRegistry, listClis } from '../src/config/cli-registry/registry.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';
import { CreateSessionSchema, sessionModeIds } from '../src/web/schemas.js';

/** A complete, valid custom entry — the minimum a user would have to write by hand. */
function customEntry(id: string): Record<string, unknown> {
  const template = STOCK_CLIS.find((e) => (e.id as string) === 'pi');
  if (!template) throw new Error('pi is missing from the stock catalog');
  return JSON.parse(JSON.stringify({ ...template, id, label: 'Custom', order: 999 })) as Record<string, unknown>;
}

function writeRegistryFile(contents: unknown): void {
  const path = dataPath('clis.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2), { mode: 0o600 });
}

describe('resolveRegistry (pure)', () => {
  it('returns the stock catalog unchanged when there is no file', () => {
    const warnings: string[] = [];
    const { entries } = resolveRegistry(STOCK_CLIS, null, warnings);
    expect(warnings).toEqual([]);
    expect(entries.map((e) => e.id as string)).toEqual(STOCK_CLIS.map((e) => e.id as string));
    expect(entries.every((e) => e.stock)).toBe(true);
  });

  it('applies a partial override without disturbing anything else', () => {
    const warnings: string[] = [];
    const { entries } = resolveRegistry(STOCK_CLIS, { schemaVersion: 1, clis: { grok: { enabled: false } } }, warnings);
    expect(warnings).toEqual([]);
    const byId = new Map(entries.map((e) => [e.id as string, e]));
    expect(byId.get('grok')?.enabled).toBe(false);
    // The override touched one key; everything else about grok, and every other CLI, stands.
    expect(byId.get('grok')?.launch.variants[0].args[0]).toEqual({ lit: 'grok' });
    expect(entries.filter((e) => e.enabled).length).toBe(STOCK_CLIS.length - 1);
  });

  it('replaces arrays wholesale rather than merging them element-wise', () => {
    // A half-merged searchDirs (or worse, a half-merged args list) is not a reasonable
    // thing to hand a spawn path, so arrays replace.
    const warnings: string[] = [];
    const { entries } = resolveRegistry(
      STOCK_CLIS,
      { schemaVersion: 1, clis: { pi: { discovery: { searchDirs: ['/only/this'] } } } },
      warnings
    );
    expect(entries.find((e) => (e.id as string) === 'pi')?.discovery.searchDirs).toEqual(['/only/this']);
  });

  it('adds a well-formed custom entry', () => {
    const warnings: string[] = [];
    const { entries } = resolveRegistry(
      STOCK_CLIS,
      { schemaVersion: 1, clis: { mycli: customEntry('mycli') } },
      warnings
    );
    expect(warnings).toEqual([]);
    const mine = entries.find((e) => (e.id as string) === 'mycli');
    expect(mine?.label).toBe('Custom');
    // Forced false regardless of what the file claimed — provenance is not user-assertable.
    expect(mine?.stock).toBe(false);
  });

  it('drops an invalid custom entry but keeps the whole stock catalog', () => {
    const warnings: string[] = [];
    const { entries } = resolveRegistry(
      STOCK_CLIS,
      { schemaVersion: 1, clis: { broken: { label: 'nope' } } },
      warnings
    );
    expect(entries.map((e) => e.id as string)).toEqual(STOCK_CLIS.map((e) => e.id as string));
    expect(warnings.join(' ')).toContain('broken');
  });

  it('falls back to the PRISTINE definition when an override breaks a stock CLI', () => {
    // This is the one that matters: a fat-fingered override of a shipped CLI must degrade to
    // the shipped behaviour, never to a CLI that cannot launch.
    const warnings: string[] = [];
    const { entries } = resolveRegistry(
      STOCK_CLIS,
      {
        schemaVersion: 1,
        clis: { codex: { launch: { variants: [{ id: 'x', args: [{ lit: 'codex; rm -rf /' }] }] } } },
      },
      warnings
    );
    const codex = entries.find((e) => (e.id as string) === 'codex');
    expect(codex?.launch.variants[0].args[0]).toEqual({ lit: 'codex' });
    expect(warnings.join(' ')).toContain('codex');
  });

  it('refuses to let a custom entry impersonate a stock one', () => {
    const warnings: string[] = [];
    const impostor = { ...customEntry('grok'), stock: true, label: 'Not Grok' };
    const { entries } = resolveRegistry(STOCK_CLIS, { schemaVersion: 1, clis: { grok: impostor } }, warnings);
    const grok = entries.filter((e) => (e.id as string) === 'grok');
    expect(grok).toHaveLength(1);
    expect(grok[0].stock).toBe(true);
  });

  it('sorts by order', () => {
    const { entries } = resolveRegistry(STOCK_CLIS, null, []);
    const orders = entries.map((e) => e.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});

describe('loadCliRegistry (on disk)', () => {
  beforeEach(() => reloadCliRegistry());
  afterEach(() => reloadCliRegistry());

  it('WRITES NOTHING when no file exists', () => {
    const path = dataPath('clis.json');
    expect(existsSync(path)).toBe(false);
    const { entries, warnings } = loadCliRegistry();
    expect(entries).toHaveLength(STOCK_CLIS.length);
    expect(warnings).toEqual([]);
    // The whole reason this build has no seeding ratchet: importing the registry (which
    // schemas.ts does, to validate a request) must not touch the filesystem.
    expect(existsSync(path)).toBe(false);
  });

  it('WRITES NOTHING when a file does exist', () => {
    writeRegistryFile({ schemaVersion: 1, clis: { grok: { enabled: false } } });
    const before = readFileSync(dataPath('clis.json'), 'utf-8');
    loadCliRegistry();
    expect(readFileSync(dataPath('clis.json'), 'utf-8')).toBe(before);
  });

  it('tolerates a file written by a future version that carries seededStockIds', () => {
    // Forward compatibility: a later build persists that key. Reading it must not fail.
    writeRegistryFile({ schemaVersion: 1, seededStockIds: ['claude', 'shell'], clis: {} });
    const { entries, warnings } = loadCliRegistry();
    expect(entries).toHaveLength(STOCK_CLIS.length);
    expect(warnings).toEqual([]);
  });

  it('QUARANTINES malformed JSON rather than overwriting it', () => {
    // The file is hand-editable, so a syntax error is far more likely to be a half-finished
    // edit than junk. Renaming keeps the user's work; truncating would destroy it.
    writeRegistryFile('{ "clis": { oops');
    const { entries, warnings } = loadCliRegistry();
    expect(entries).toHaveLength(STOCK_CLIS.length);
    expect(warnings.join(' ')).toContain('not valid JSON');
    const siblings = readdirSync(dirname(dataPath('clis.json')));
    expect(siblings.some((f) => f.startsWith('clis.json.invalid-'))).toBe(true);
    expect(siblings).not.toContain('clis.json');
  });
});

describe('the mode allowlist resolves at PARSE time, not import time', () => {
  beforeEach(() => reloadCliRegistry());
  afterEach(() => reloadCliRegistry());

  it('stops accepting a mode as soon as its CLI is disabled — no restart', () => {
    // The regression this pins: SESSION_MODE_IDS used to be computed once at module load,
    // so toggling a CLI updated the Run menu while `POST /api/sessions` kept answering
    // INVALID_INPUT until the server restarted. Validation and the menu disagreed about
    // which CLIs existed, and the flow the feature was built around simply did not work.
    expect(sessionModeIds()).toContain('grok');
    expect(CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'grok' }).success).toBe(true);

    writeRegistryFile({ schemaVersion: 1, clis: { grok: { enabled: false } } });
    reloadCliRegistry();

    expect(sessionModeIds()).not.toContain('grok');
    expect(CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'grok' }).success).toBe(false);
    // ...and the schema object itself was never rebuilt.
    expect(CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'claude' }).success).toBe(true);
  });

  it('admits a custom CLI as a run mode the moment it loads', () => {
    expect(CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'mycli' }).success).toBe(false);
    writeRegistryFile({ schemaVersion: 1, clis: { mycli: customEntry('mycli') } });
    reloadCliRegistry();
    expect(CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'mycli' }).success).toBe(true);
  });

  it('follows the registry for env-prefix allowlisting too', () => {
    // Same import-time freeze applied to ALLOWED_ENV_PREFIXES, with the same symptom.
    const withGrokEnv = { workingDir: '/tmp', mode: 'claude', envOverrides: { XAI_API_KEY: 'x' } };
    expect(CreateSessionSchema.safeParse(withGrokEnv).success).toBe(true);

    writeRegistryFile({ schemaVersion: 1, clis: { grok: { enabled: false } } });
    reloadCliRegistry();

    // XAI_ was grok's contribution; with grok disabled nothing allowlists it any more.
    expect(CreateSessionSchema.safeParse(withGrokEnv).success).toBe(false);
  });

  it('never lets a registry entry unblock a hard-blocked key', () => {
    // BLOCKED_ENV_KEYS is deliberately NOT registry-driven. Even a pathological entry
    // claiming a prefix that covers everything must not reach PATH.
    const evil = customEntry('evil');
    (evil as { env: { allowedPrefixes: string[] } }).env.allowedPrefixes = ['P'];
    writeRegistryFile({ schemaVersion: 1, clis: { evil } });
    reloadCliRegistry();
    // The schema rejects a 1-char prefix outright, so the entry is dropped...
    expect(listClis().some((e) => (e.id as string) === 'evil')).toBe(false);
    // ...and PATH stays blocked regardless.
    expect(
      CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'claude', envOverrides: { PATH: '/evil' } }).success
    ).toBe(false);
  });
});
