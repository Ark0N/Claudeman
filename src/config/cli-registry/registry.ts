/**
 * @fileoverview Loads, merges, seeds and re-validates the CLI registry.
 *
 * `~/.codeman/clis.json` holds OVERRIDES and CUSTOM entries only — never a full copy of the
 * stock catalog — so a shipped fix to a stock definition actually reaches an existing
 * install, and the file stays small enough to hand-edit.
 *
 * Resolution: start from `STOCK_CLIS` → deep-merge each override by id (objects merge
 * key-wise, arrays replace wholesale) → validate every resulting entry. A stock entry that
 * fails validation after merge falls back to its pristine stock definition (a fat-fingered
 * override cannot brick a shipped CLI); a custom entry that fails is dropped. `shell` and
 * `claude` may be disabled but the loader refuses to let either be entirely absent, since
 * huge parts of the app assume at least a shell fallback exists.
 *
 * `seededStockIds` is the ratchet that makes "one file, no generated fragments" survive
 * `install.sh update`: any stock id not yet in that list is a NEWLY SHIPPED CLI, so it is
 * added (enabled) and the id recorded; an id already in the list that carries no override is
 * left exactly as-is, including a user's earlier `enabled: false`.
 *
 * @module config/cli-registry/registry
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../instance.js';
import type { CliEntry, CliId, CliRegistryFile } from './types.js';
import { CliEntrySchema } from './schema.js';
import { STOCK_CLIS } from './stock.js';

const SCHEMA_VERSION = 1;

/** Construct a validated CliId. Throws if `raw` is not a well-formed id — call at API boundaries. */
export function asCliId(raw: string): CliId {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(raw)) {
    throw new Error(`invalid CLI id: ${JSON.stringify(raw)}`);
  }
  return raw as CliId;
}

function filePath(): string {
  return dataPath('clis.json');
}

/** Plain-object deep merge: nested objects merge key-wise, arrays and primitives replace. */
function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return (override === undefined ? base : (override as T)) ?? base;
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return override as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    result[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return result as T;
}

interface LoadResult {
  entries: CliEntry[];
  warnings: string[];
}

/**
 * Refuse a group/world-writable registry file — same posture as the ssh-key discipline.
 *
 * POSIX only: Windows has no meaningful group/world bits on NTFS (Node reports every file
 * as mode 0o666 there regardless of its actual ACL), so this check would flag every file on
 * Windows and silently ignore all user config. `win32` relies on NTFS ACLs instead, which
 * this check cannot see and does not attempt to.
 */
function isUnsafePermissions(path: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

function readRegistryFile(path: string, warnings: string[]): CliRegistryFile | null {
  if (!existsSync(path)) return null;
  if (isUnsafePermissions(path)) {
    warnings.push(`${path} is group/world-writable; ignoring it and falling back to stock CLIs.`);
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    warnings.push(`Failed to read ${path}: ${(err as Error).message}. Falling back to stock CLIs.`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CliRegistryFile;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.clis !== 'object') {
      throw new Error('missing "clis" object');
    }
    return parsed;
  } catch (err) {
    const quarantined = `${path}.invalid-${Date.now()}`;
    try {
      renameSync(path, quarantined);
      warnings.push(`${path} was not valid JSON (${(err as Error).message}); moved to ${quarantined}.`);
    } catch {
      warnings.push(
        `${path} was not valid JSON (${(err as Error).message}); left in place, falling back to stock CLIs.`
      );
    }
    return null;
  }
}

/** Merge the stock catalog with a (possibly absent) registry file. Pure — no IO. */
export function resolveRegistry(stock: CliEntry[], file: CliRegistryFile | null, warnings: string[]): LoadResult {
  const stockById = new Map(stock.map((e) => [e.id as string, e]));
  const seeded = new Set(file?.seededStockIds ?? []);
  const overrides = file?.clis ?? {};
  const entries: CliEntry[] = [];

  for (const stockEntry of stock) {
    const id = stockEntry.id as string;
    const override = overrides[id];
    const merged = override ? deepMerge(stockEntry, override) : stockEntry;
    const parsed = CliEntrySchema.safeParse({ ...merged, id, stock: true });
    if (parsed.success) {
      entries.push(parsed.data as CliEntry);
    } else {
      warnings.push(
        `Override for stock CLI "${id}" failed validation; using the shipped definition. ${parsed.error.message}`
      );
      entries.push(stockEntry);
    }
    seeded.add(id);
  }

  for (const [id, raw] of Object.entries(overrides)) {
    if (stockById.has(id)) continue; // handled above
    const parsed = CliEntrySchema.safeParse({ ...(raw as object), id, stock: false });
    if (parsed.success) {
      entries.push(parsed.data as CliEntry);
    } else {
      warnings.push(`Custom CLI "${id}" failed validation and was dropped. ${parsed.error.message}`);
    }
  }

  entries.sort((a, b) => a.order - b.order);
  return { entries, warnings };
}

/** Persist the ratcheted `seededStockIds` (and any pass-through overrides) atomically. */
function writeSeed(path: string, file: CliRegistryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
}

let cache: LoadResult | null = null;

/**
 * Load the effective registry (stock + user overrides), seeding newly-shipped stock ids into
 * the on-disk file as a side effect. Memoized; call `reloadCliRegistry()` after a settings
 * write to invalidate.
 */
export function loadCliRegistry(): LoadResult {
  if (cache) return cache;
  const path = filePath();
  const warnings: string[] = [];
  const existing = readRegistryFile(path, warnings);

  const knownStockIds = new Set(STOCK_CLIS.map((e) => e.id as string));
  const previouslySeeded = new Set(existing?.seededStockIds ?? []);
  const newlyShipped = [...knownStockIds].filter((id) => !previouslySeeded.has(id));

  const file: CliRegistryFile = {
    schemaVersion: SCHEMA_VERSION,
    seededStockIds: [...previouslySeeded, ...newlyShipped],
    clis: existing?.clis ?? {},
  };

  // Write back when the file is new, or a previously-unseeded stock CLI just joined —
  // otherwise this is a pure read (no write on every boot).
  if (!existing || newlyShipped.length > 0) {
    try {
      writeSeed(path, file);
    } catch (err) {
      warnings.push(`Failed to persist ${path}: ${(err as Error).message}`);
    }
  }

  cache = resolveRegistry(STOCK_CLIS, file, warnings);
  return cache;
}

/** Drop the memoized registry so the next `loadCliRegistry()` re-reads the file. */
export function reloadCliRegistry(): void {
  cache = null;
}

export function listClis(): CliEntry[] {
  return loadCliRegistry().entries;
}

export function enabledClis(): CliEntry[] {
  return listClis().filter((e) => e.enabled);
}

export function getCli(id: string): CliEntry | undefined {
  return listClis().find((e) => (e.id as string) === id);
}

export function cliIds(): string[] {
  return listClis().map((e) => e.id as string);
}

/**
 * Build the "CLI not found" error message for a mode with no resolved binary directory,
 * naming the registry's own label and per-platform install command. Shared by
 * tmux-manager.ts's spawn-time throw and session-routes.ts's create-time pre-flight check
 * (both used to hand-write this string once per external CLI, six throws and ten checks in
 * total, all now reading the SAME data). Returns null for an id the registry doesn't know.
 */
export function missingCliMessage(id: string): string | null {
  const entry = getCli(id);
  if (!entry) return null;
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const command =
    entry.discovery.install.command[platform] ??
    entry.discovery.install.command.linux ??
    Object.values(entry.discovery.install.command)[0];
  return command
    ? `${entry.label} CLI not found. Install with: ${command}`
    : `${entry.label} CLI not found. See its docs for install instructions.`;
}
