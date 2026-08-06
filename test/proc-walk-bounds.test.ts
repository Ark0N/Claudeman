/**
 * Regression guard for the process-tree walk.
 *
 * On 2026-07-30 an unbounded version took a machine down: it ran `pgrep -P <pid>` per
 * node and recursed with no visited set, no depth limit and no node cap. Across ~28
 * adopted tmux trees the fan-out exploded, and because each `pgrep` blocks in the WSL
 * kernel while reading /proc/<pid>/cgroup, none returned while the walk kept firing
 * more. Result: ~13,000 `pgrep` processes stuck in D-state out of ~39,000 total, load
 * average above 13,000, recoverable only by
 * restarting WSL — which cost every running session.
 *
 * These tests exercise the SHIPPED function. An earlier version of this file carried
 * its own copy of the traversal, which would have passed happily while the real code
 * regressed; that is why the walk now lives in its own module.
 */
import { describe, expect, it, vi } from 'vitest';

import { collectDescendants, PROC_WALK_MAX_DEPTH, PROC_WALK_MAX_NODES } from '../src/proc-tree.js';

/** Build a parent→children map from `[parent, child]` pairs. */
function tree(pairs: [number, number][]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const [p, c] of pairs) m.set(p, [...(m.get(p) ?? []), c]);
  return m;
}

/** A chain 1→2→…→n, i.e. depth n-1. */
function chain(n: number): Map<number, number[]> {
  return tree(Array.from({ length: n - 1 }, (_, i) => [i + 1, i + 2] as [number, number]));
}

describe('collectDescendants', () => {
  it('returns every descendant of a normal tree, root excluded', () => {
    const t = tree([
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 5],
    ]);
    expect(collectDescendants(1, t).sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  it('terminates on a cycle instead of looping forever', () => {
    // A live `ps` snapshot is not atomic; pid reuse can produce a parent loop.
    const t = tree([
      [1, 2],
      [2, 3],
      [3, 1],
      [3, 2],
    ]);
    expect(collectDescendants(1, t).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('does not include the root even when something claims it as a child', () => {
    expect(collectDescendants(1, tree([[1, 1]]))).toEqual([]);
  });

  it('caps the depth, and says so', () => {
    // 40 generations available, only PROC_WALK_MAX_DEPTH may be descended. A silent
    // depth cap hides a deep tree exactly as a silent node cap hides a wide one.
    const onTruncated = vi.fn();
    expect(collectDescendants(1, chain(40), { onTruncated })).toHaveLength(PROC_WALK_MAX_DEPTH);
    expect(onTruncated).toHaveBeenCalledWith(1, PROC_WALK_MAX_DEPTH, 'depth');
  });

  it('stays silent about depth when the tree ends inside the cap', () => {
    const onTruncated = vi.fn();
    collectDescendants(1, chain(4), { onTruncated });
    expect(onTruncated).not.toHaveBeenCalled();
  });

  it('caps the node count and reports the truncation', () => {
    // One parent with far more children than the cap allows.
    const wide = new Map<number, number[]>([[1, Array.from({ length: PROC_WALK_MAX_NODES * 3 }, (_, i) => i + 2)]]);
    const onTruncated = vi.fn();

    const out = collectDescendants(1, wide, { onTruncated });

    expect(out).toHaveLength(PROC_WALK_MAX_NODES);
    expect(onTruncated).toHaveBeenCalledWith(1, PROC_WALK_MAX_NODES, 'nodes');
  });

  it('stays silent when nothing was truncated', () => {
    const onTruncated = vi.fn();
    collectDescendants(1, tree([[1, 2]]), { onTruncated });
    expect(onTruncated).not.toHaveBeenCalled();
  });

  it('survives the shape that caused the incident: many wide, deep trees', () => {
    // 28 adopted trees, branching 4-wide. Depth 6 already gives 4096 nodes per tree —
    // eight times the cap, which is what this asserts. (The real incident's trees were
    // deeper still; building that here would mean materialising 16M map entries and
    // would only test the fixture builder.)
    const t = new Map<number, number[]>();
    let next = 1000;
    const roots: number[] = [];
    for (let r = 0; r < 28; r += 1) {
      const root = next++;
      roots.push(root);
      let frontier = [root];
      for (let d = 0; d < 6; d += 1) {
        const nf: number[] = [];
        for (const p of frontier) {
          const kids = [next++, next++, next++, next++];
          t.set(p, kids);
          nf.push(...kids);
        }
        frontier = nf;
      }
    }

    for (const root of roots) {
      const out = collectDescendants(root, t);
      expect(out.length).toBeLessThanOrEqual(PROC_WALK_MAX_NODES);
    }
  });

  it('honours explicit overrides', () => {
    expect(collectDescendants(1, chain(40), { maxDepth: 3 })).toEqual([2, 3, 4]);
    expect(collectDescendants(1, chain(40), { maxNodes: 2 })).toEqual([2, 3]);
  });

  it('returns nothing for an unknown pid or an empty snapshot', () => {
    expect(collectDescendants(999, tree([[1, 2]]))).toEqual([]);
    expect(collectDescendants(1, new Map())).toEqual([]);
  });
});

/**
 * The bound must be reachable through the code that actually kills things.
 *
 * The unit tests above exercise `collectDescendants` directly, which is necessary but
 * not sufficient: reverting `tmux-manager.ts` to the old unbounded `pgrep -P` recursion
 * left every one of them green. This asserts the wiring — that TmuxManager's descendant
 * lookup goes through the bounded walk and honours its caps.
 *
 * The snapshot refresh is stubbed. Without that the manager runs a real `ps` and
 * replaces the fixture, and the test silently measures the machine's own process tree
 * instead of the tree under test — which is how the first version of this test passed
 * even with both caps bypassed.
 */
describe('TmuxManager uses the bounded walk', () => {
  /** Build a tree `width` wide and `depth` deep, rooted at 1. */
  function bigTree(width: number, depth: number): Map<number, number[]> {
    const t = new Map<number, number[]>();
    let next = 2;
    let frontier = [1];
    for (let d = 0; d < depth; d += 1) {
      const nf: number[] = [];
      for (const p of frontier) {
        const kids = Array.from({ length: width }, () => next++);
        t.set(p, kids);
        nf.push(...kids);
      }
      frontier = nf;
    }
    return t;
  }

  async function walkVia(fixture: Map<number, number[]>): Promise<number[]> {
    const { TmuxManager } = await import('../src/tmux-manager.js');
    const Klass = TmuxManager as unknown as {
      refreshProcSnapshot(): Promise<Map<number, number[]>>;
      procSnapshot: unknown;
    };
    const original = Klass.refreshProcSnapshot;
    Klass.refreshProcSnapshot = () => Promise.resolve(fixture);
    Klass.procSnapshot = { at: Date.now(), byParent: fixture };
    try {
      const mgr = new TmuxManager();
      return await (mgr as unknown as { getChildPidsFresh(pid: number): Promise<number[]> }).getChildPidsFresh(1);
    } finally {
      Klass.refreshProcSnapshot = original;
      Klass.procSnapshot = null;
    }
  }

  it('honours the node cap on a tree far wider than it', async () => {
    // 4096 descendants available; the cap is 500. With the caps bypassed — the shape
    // a regression at the call site would take — this returns thousands.
    const out = await walkVia(bigTree(4, 6));
    expect(out.length).toBe(PROC_WALK_MAX_NODES);
  });

  it('honours the depth cap on a deep chain', async () => {
    const chainTree = new Map<number, number[]>();
    for (let i = 1; i < 40; i += 1) chainTree.set(i, [i + 1]);

    const out = await walkVia(chainTree);

    expect(out.length).toBe(PROC_WALK_MAX_DEPTH);
  });

  it('spawns nothing per node — the walk only reads the snapshot', async () => {
    // A per-node spawn against this fixture would mean thousands of processes; the
    // test completing at all is the assertion, plus the bound holding.
    const out = await walkVia(bigTree(4, 6));
    expect(out.length).toBeLessThanOrEqual(PROC_WALK_MAX_NODES);
  });
});
