/**
 * @fileoverview Atomic StateStore publication tests for tab layouts and their legacy session-order projection.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { recomposeGlobalSessionOrder } from '../src/tab-layout-legacy-order.js';
import type { TabLayout } from '../src/tab-layout.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createStore(seed: { sessionOrder?: string[]; tabLayouts?: Record<string, TabLayout> } = {}): StateStore {
  const dir = mkdtempSync(join(tmpdir(), 'codeman-state-tab-layout-'));
  tempDirs.push(dir);
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify(seed));
  return new StateStore(file);
}

const ownerLayout = (ids: readonly string[], version = 1): TabLayout => ({
  version,
  groups: [],
  ungrouped: ids.map((id) => ({ kind: 'session', id })),
  updatedAt: `2026-08-23T12:00:0${version}.000Z`,
});

describe('StateStore.commitTabLayoutProjection', () => {
  it('returns a defensive snapshot of all stored owner layouts for trusted owner discovery', () => {
    const alice = ownerLayout(['a1'], 1);
    const store = createStore({ tabLayouts: { alice, constructor: ownerLayout(['c1'], 2) } });

    const layouts = store.getTabLayouts();

    expect(Object.keys(layouts)).toEqual(['alice', 'constructor']);
    layouts.alice.ungrouped[0].id = 'caller-mutated';
    expect(store.getTabLayout('alice')).toEqual(alice);
  });

  it('validates all layouts and publishes them with a latest-state projection using one save schedule', () => {
    const originalAlice = ownerLayout(['a1'], 1);
    const store = createStore({ sessionOrder: ['a1'], tabLayouts: { alice: originalAlice } });
    const save = vi.spyOn(store, 'save').mockImplementation(() => undefined);
    const alice = ownerLayout(['a2', 'a1'], 2);
    const constructorOwner = ownerLayout(['constructor'], 1);
    const projected = ['a2', 'a1', 'constructor', 'a2'];

    const result = store.commitTabLayoutProjection({ alice, constructor: constructorOwner }, (latest) => {
      expect(latest).toEqual(['a1']);
      expect(store.getSessionOrder()).toEqual(['a1']);
      expect(store.getTabLayout('alice')).toEqual(originalAlice);
      (latest as string[]).push('projector-local-mutation');
      return projected;
    });

    expect(store.getTabLayout('alice')).toEqual(alice);
    expect(store.getTabLayout('constructor')).toEqual(constructorOwner);
    expect(store.getSessionOrder()).toEqual(['a2', 'a1', 'constructor']);
    expect(result).toEqual({
      layouts: { alice, constructor: constructorOwner },
      sessionOrder: ['a2', 'a1', 'constructor'],
    });
    expect(save).toHaveBeenCalledTimes(1);

    alice.ungrouped[0].id = 'caller-mutated';
    constructorOwner.ungrouped[0].id = 'caller-mutated';
    projected[0] = 'caller-mutated';
    result.layouts.alice.ungrouped[0].id = 'return-mutated';
    result.layouts.constructor.ungrouped[0].id = 'return-mutated';
    result.sessionOrder[0] = 'return-mutated';

    expect(store.getTabLayout('alice')?.ungrouped[0].id).toBe('a2');
    expect(store.getTabLayout('constructor')?.ungrouped[0].id).toBe('constructor');
    expect(store.getSessionOrder()).toEqual(['a2', 'a1', 'constructor']);
  });

  it('changes neither representation and does not project or save when any layout is invalid', () => {
    const original = ownerLayout(['a1'], 1);
    const store = createStore({ sessionOrder: ['a1'], tabLayouts: { alice: original } });
    const save = vi.spyOn(store, 'save').mockImplementation(() => undefined);
    const project = vi.fn(() => ['a2']);
    const invalid = { ...ownerLayout(['b1'], 2), version: -1 };

    expect(() => store.commitTabLayoutProjection({ bob: ownerLayout(['b1'], 2), alice: invalid }, project)).toThrow(
      /version/
    );

    expect(project).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(store.getTabLayout('alice')).toEqual(original);
    expect(store.getTabLayout('bob')).toBeNull();
    expect(store.getSessionOrder()).toEqual(['a1']);
  });

  it('changes neither representation and does not save when projection throws', () => {
    const original = ownerLayout(['a1'], 1);
    const store = createStore({ sessionOrder: ['a1'], tabLayouts: { alice: original } });
    const save = vi.spyOn(store, 'save').mockImplementation(() => undefined);

    expect(() =>
      store.commitTabLayoutProjection({ alice: ownerLayout(['a2'], 2) }, () => {
        throw new Error('projection rejected');
      })
    ).toThrow('projection rejected');

    expect(save).not.toHaveBeenCalled();
    expect(store.getTabLayout('alice')).toEqual(original);
    expect(store.getSessionOrder()).toEqual(['a1']);
  });

  it('derives sequential owner projections from the latest committed order', () => {
    const store = createStore({ sessionOrder: ['a1', 'b1', 'a2', 'b2'] });
    const save = vi.spyOn(store, 'save').mockImplementation(() => undefined);

    store.commitTabLayoutProjection({ alice: ownerLayout(['a2', 'a1'], 2) }, (latest) =>
      recomposeGlobalSessionOrder(latest, [{ owner: 'alice', ownedIds: ['a1', 'a2'], order: ['a2', 'a1'] }])
    );
    store.commitTabLayoutProjection({ bob: ownerLayout(['b2', 'b1'], 2) }, (latest) =>
      recomposeGlobalSessionOrder(latest, [{ owner: 'bob', ownedIds: ['b1', 'b2'], order: ['b2', 'b1'] }])
    );

    expect(store.getSessionOrder()).toEqual(['a2', 'b2', 'a1', 'b1']);
    expect(store.getTabLayout('alice')).toEqual(ownerLayout(['a2', 'a1'], 2));
    expect(store.getTabLayout('bob')).toEqual(ownerLayout(['b2', 'b1'], 2));
    expect(save).toHaveBeenCalledTimes(2);
  });
});
