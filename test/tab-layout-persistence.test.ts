/**
 * @fileoverview Owner-scoped tab-layout persistence and legacy migration tests.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/state-store.js';
import {
  SINGLE_USER_LAYOUT_OWNER,
  normalizeOrMigrateOwnerTabLayout,
  ownerLayoutKey,
  type TabLayoutMigrationInput,
} from '../src/tab-layout-persistence.js';
import { MAX_TAB_REFS, TabLayoutValidationError, type TabLayout } from '../src/tab-layout.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const baseInput = (overrides: Partial<TabLayoutMigrationInput> = {}): TabLayoutMigrationInput => ({
  owner: SINGLE_USER_LAYOUT_OWNER,
  layouts: {},
  sessionOrder: [],
  persistedSessions: [],
  liveSessions: [],
  webviews: [],
  updatedAt: '2026-08-16T12:00:00.000Z',
  ...overrides,
});

describe('owner layout key', () => {
  it('uses the reserved single-user key or authenticated username', () => {
    expect(ownerLayoutKey()).toBe('@single');
    expect(ownerLayoutKey('alice')).toBe('alice');
  });
});

describe('normalizeOrMigrateOwnerTabLayout', () => {
  it('filters global sessionOrder by owner and appends remaining sessions deterministically', () => {
    const result = normalizeOrMigrateOwnerTabLayout(
      baseInput({
        owner: 'alice',
        sessionOrder: ['foreign', 'late', 'ordered', 'missing'],
        persistedSessions: [
          { id: 'foreign', owner: 'bob', createdAt: 1 },
          { id: 'late', owner: 'alice', createdAt: 30 },
          { id: 'ordered', owner: 'alice', createdAt: 20 },
          { id: 'tie-b', owner: 'alice', createdAt: 10 },
          { id: 'tie-a', owner: 'alice', createdAt: 10 },
        ],
      })
    );

    expect(result.created).toBe(true);
    expect(result.layout.ungrouped).toEqual([
      { kind: 'session', id: 'late' },
      { kind: 'session', id: 'ordered' },
      { kind: 'session', id: 'tie-a' },
      { kind: 'session', id: 'tie-b' },
    ]);
  });

  it('includes persisted stopped/pinned sessions and de-duplicates live records', () => {
    const result = normalizeOrMigrateOwnerTabLayout(
      baseInput({
        persistedSessions: [
          { id: 'pinned', createdAt: 1 },
          { id: 'shared', createdAt: 5 },
        ],
        liveSessions: [{ id: 'shared', createdAt: 2 }],
      })
    );

    expect(result.layout.ungrouped).toEqual([
      { kind: 'session', id: 'pinned' },
      { kind: 'session', id: 'shared' },
    ]);
  });

  it('treats an ownerless live record as authoritative single-user ownership', () => {
    const result = normalizeOrMigrateOwnerTabLayout(
      baseInput({
        persistedSessions: [{ id: 'moved', owner: 'alice', createdAt: 1 }],
        liveSessions: [{ id: 'moved', createdAt: 2 }],
      })
    );

    expect(result.layout.ungrouped).toEqual([{ kind: 'session', id: 'moved' }]);
  });

  it('treats an absent live parentSessionId as an authoritative root', () => {
    const result = normalizeOrMigrateOwnerTabLayout(
      baseInput({
        sessionOrder: ['child', 'former-parent'],
        persistedSessions: [
          { id: 'child', parentSessionId: 'former-parent', createdAt: 1 },
          { id: 'former-parent', createdAt: 2 },
        ],
        liveSessions: [
          { id: 'child', createdAt: 1 },
          { id: 'former-parent', createdAt: 2 },
        ],
      })
    );

    expect(result.layout.ungrouped).toEqual([
      { kind: 'session', id: 'child' },
      { kind: 'session', id: 'former-parent' },
    ]);
  });

  it('marks migrated children manual when their parent is live and same-owner', () => {
    const result = normalizeOrMigrateOwnerTabLayout(
      baseInput({
        owner: 'alice',
        sessionOrder: ['child', 'parent', 'foreign-child'],
        persistedSessions: [
          { id: 'child', owner: 'alice', parentSessionId: 'parent', createdAt: 2 },
          { id: 'parent', owner: 'alice', createdAt: 1 },
          { id: 'foreign-child', owner: 'alice', parentSessionId: 'foreign-parent', createdAt: 3 },
        ],
        liveSessions: [
          { id: 'parent', owner: 'alice', createdAt: 1 },
          { id: 'foreign-parent', owner: 'bob', createdAt: 1 },
        ],
      })
    );

    expect(result.layout.ungrouped).toEqual([
      { kind: 'session', id: 'child', placement: 'manual' },
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'foreign-child' },
    ]);
  });

  it('appends owner webviews in server store order after sessions', () => {
    const result = normalizeOrMigrateOwnerTabLayout(
      baseInput({
        owner: 'alice',
        persistedSessions: [{ id: 'session', owner: 'alice', createdAt: 1 }],
        webviews: [
          { id: 'second', owner: 'alice' },
          { id: 'foreign', owner: 'bob' },
          { id: 'first', owner: 'alice' },
        ],
      })
    );

    expect(result.layout.ungrouped).toEqual([
      { kind: 'session', id: 'session' },
      { kind: 'webview', id: 'second' },
      { kind: 'webview', id: 'first' },
    ]);
  });

  it('normalizes an existing layout idempotently without pruning unknown refs', () => {
    const existing: TabLayout = {
      version: 7,
      groups: [
        {
          id: 'g',
          name: '  Work  ',
          refs: [
            { kind: 'session', id: 'unknown' },
            { kind: 'session', id: 'foreign' },
          ],
        },
      ],
      ungrouped: [{ kind: 'session', id: 'known' }],
      updatedAt: 'old',
    };
    const input = baseInput({
      layouts: { '@single': existing },
      persistedSessions: [
        { id: 'known', createdAt: 1 },
        { id: 'foreign', owner: 'alice', createdAt: 2 },
      ],
    });

    const once = normalizeOrMigrateOwnerTabLayout(input);
    const twice = normalizeOrMigrateOwnerTabLayout({ ...input, layouts: once.layouts });

    expect(once.created).toBe(false);
    expect(once.layout.groups).toEqual([{ id: 'g', name: 'Work', refs: [{ kind: 'session', id: 'unknown' }] }]);
    expect(twice.layout).toEqual(once.layout);
  });

  it('migrates an owner named constructor instead of reading the inherited prototype key', () => {
    const result = normalizeOrMigrateOwnerTabLayout(
      baseInput({
        owner: 'constructor',
        layouts: {
          alice: {
            version: 1,
            groups: [],
            ungrouped: [],
            updatedAt: 'old',
          },
        },
      })
    );

    expect(result.created).toBe(true);
    expect(result.layouts.constructor).toBeDefined();
    expect(result.layout.version).toBe(0);
  });

  it('accepts exactly 512 refs and rejects 513 atomically without truncation', () => {
    const sessions = Array.from({ length: MAX_TAB_REFS }, (_, i) => ({ id: `s-${i}`, createdAt: i }));
    const accepted = normalizeOrMigrateOwnerTabLayout(baseInput({ persistedSessions: sessions }));
    expect(accepted.layout.ungrouped).toHaveLength(MAX_TAB_REFS);

    const layouts = { untouched: accepted.layout };
    expect(() =>
      normalizeOrMigrateOwnerTabLayout(
        baseInput({ layouts, persistedSessions: [...sessions, { id: 'overflow', createdAt: MAX_TAB_REFS }] })
      )
    ).toThrow(TabLayoutValidationError);
    expect(layouts).toEqual({ untouched: accepted.layout });
  });
});

describe('StateStore tabLayouts allowlist', () => {
  it('persists and reloads full owner layouts across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeman-tab-layout-'));
    tempDirs.push(dir);
    const file = join(dir, 'state.json');
    const layout: TabLayout = {
      version: 3,
      groups: [{ id: 'g', name: 'Work', refs: [{ kind: 'session', id: 's', placement: 'manual' }] }],
      ungrouped: [{ kind: 'webview', id: 'w' }],
      updatedAt: '2026-08-16T12:00:00.000Z',
    };

    const store = new StateStore(file);
    store.setTabLayout('alice', layout);
    store.saveNow();

    expect(JSON.parse(readFileSync(file, 'utf8')).tabLayouts).toEqual({ alice: layout });
    expect(new StateStore(file).getTabLayout('alice')).toEqual(layout);
  });

  it('does not treat an inherited constructor property as a persisted owner layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeman-tab-layout-'));
    tempDirs.push(dir);
    const file = join(dir, 'state.json');
    const layout: TabLayout = {
      version: 3,
      groups: [],
      ungrouped: [],
      updatedAt: '2026-08-16T12:00:00.000Z',
    };

    const store = new StateStore(file);
    store.setTabLayout('alice', layout);
    store.saveNow();

    expect(store.getTabLayout('constructor')).toBeNull();
  });
});
