// Port: none (pure comparator — no browser, no server).
//
// `CodemanSessionOrder` (src/web/public/constants.js) is the single row order
// behind both home screens: the phone overview and the desktop tab rail. It is
// the one place the two surfaces can disagree about which session you should
// look at next, which is why it is pure and pinned here rather than living
// inside either renderer.
//
// The rule it encodes, and the thing worth protecting: the tiebreak FLIPS
// direction halfway down the list. For a state a session is still in, older is
// more urgent (blocked longest, running longest). For a state it has stopped
// in, newer is more relevant (just finished beats abandoned yesterday).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Row = {
  id: string;
  state: string;
  lastActivityAt?: number;
  lastSubmitAt?: number;
  orderIndex?: number;
};

function loadOrderHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanSessionOrder: {
        RANK: Record<string, number>;
        anchor: (row: Row) => number;
        compare: (a: Row, b: Row) => number;
        sort: (rows: Row[]) => Row[];
      };
    }
  ).CodemanSessionOrder;
}

const order = loadOrderHelper();
const ids = (rows: Row[]) => order.sort(rows).map((r) => r.id);

describe('session overview order: state ranking', () => {
  it('puts everything blocked on a human above everything else', () => {
    // Red question, then a hard error, then the yellow "waiting for input"
    // prompt, then work, then whatever has stopped.
    const rows: Row[] = [
      { id: 'done', state: 'done' },
      { id: 'idle', state: 'idle' },
      { id: 'working', state: 'working' },
      { id: 'waiting', state: 'waiting' },
      { id: 'error', state: 'error' },
      { id: 'needs', state: 'needs' },
    ];
    expect(ids(rows)).toEqual(['needs', 'error', 'waiting', 'working', 'idle', 'done']);
  });

  it('sorts an unknown state last instead of dropping it or crashing', () => {
    // A state added to one renderer and not to the rank map must still render,
    // just at the bottom — a missing row is a worse failure than a misplaced one.
    const rows: Row[] = [
      { id: 'mystery', state: 'quantum' },
      { id: 'done', state: 'done' },
    ];
    expect(ids(rows)).toEqual(['done', 'mystery']);
  });
});

describe('session overview order: in-progress states sort oldest first', () => {
  it('ranks the longest-running turn above a turn that just started', () => {
    const rows: Row[] = [
      { id: 'young', state: 'working', lastSubmitAt: 9_000, lastActivityAt: 10_000 },
      { id: 'old', state: 'working', lastSubmitAt: 1_000, lastActivityAt: 10_000 },
    ];
    expect(ids(rows)).toEqual(['old', 'young']);
  });

  it('measures a running turn from the last Enter, not the last repaint', () => {
    // A working pane repaints about once a second, so last-activity is always
    // "now" and would rank every running turn identically.
    expect(order.anchor({ id: 'w', state: 'working', lastSubmitAt: 1_000, lastActivityAt: 999_000 })).toBe(1_000);
    expect(order.anchor({ id: 'i', state: 'idle', lastSubmitAt: 1_000, lastActivityAt: 999_000 })).toBe(999_000);
  });

  it('falls back to last activity for a working pane that never submitted', () => {
    // Spawned with its prompt on the command line, or an external CLI whose
    // Enter never went through Codeman. Its fallback stamp is ~now, so it sits
    // at the SHORT end of the running group rather than falsely leading it.
    const rows: Row[] = [
      { id: 'no-submit', state: 'working', lastActivityAt: 10_000 },
      { id: 'submitted', state: 'working', lastSubmitAt: 1_000, lastActivityAt: 10_000 },
    ];
    expect(ids(rows)).toEqual(['submitted', 'no-submit']);
  });

  it('ranks the longest-blocked session above one that just asked', () => {
    const rows: Row[] = [
      { id: 'just-asked', state: 'needs', lastActivityAt: 9_000 },
      { id: 'starving', state: 'needs', lastActivityAt: 1_000 },
    ];
    expect(ids(rows)).toEqual(['starving', 'just-asked']);
  });
});

describe('session overview order: stopped states sort newest first', () => {
  it('puts the session that just went quiet above one idle since yesterday', () => {
    const rows: Row[] = [
      { id: 'yesterday', state: 'idle', lastActivityAt: 1_000 },
      { id: 'just-now', state: 'idle', lastActivityAt: 9_000 },
      { id: 'this-morning', state: 'idle', lastActivityAt: 5_000 },
    ];
    expect(ids(rows)).toEqual(['just-now', 'this-morning', 'yesterday']);
  });

  it('applies the same recency rule to finished sessions', () => {
    const rows: Row[] = [
      { id: 'old-exit', state: 'done', lastActivityAt: 1_000 },
      { id: 'fresh-exit', state: 'done', lastActivityAt: 9_000 },
    ];
    expect(ids(rows)).toEqual(['fresh-exit', 'old-exit']);
  });
});

describe('session overview order: tiebreaks', () => {
  it('falls back to the tab order when two rows share a stamp', () => {
    const rows: Row[] = [
      { id: 'third', state: 'idle', lastActivityAt: 5_000, orderIndex: 2 },
      { id: 'first', state: 'idle', lastActivityAt: 5_000, orderIndex: 0 },
    ];
    expect(ids(rows)).toEqual(['first', 'third']);
  });

  it('sorts an unstamped row last within its state, never first', () => {
    // 0 is "we have no stamp", not "the epoch": treating it as a timestamp
    // would park a brand-new session at the head of the oldest-first groups.
    expect(
      ids([
        { id: 'none', state: 'idle', orderIndex: 0 },
        { id: 'stamped', state: 'idle', lastActivityAt: 1_000, orderIndex: 1 },
      ])
    ).toEqual(['stamped', 'none']);
    expect(
      ids([
        { id: 'none', state: 'working', orderIndex: 0 },
        { id: 'stamped', state: 'working', lastSubmitAt: 1_000, orderIndex: 1 },
      ])
    ).toEqual(['stamped', 'none']);
  });

  it('is deterministic: two unstamped rows keep tab order in both directions', () => {
    const a: Row = { id: 'a', state: 'idle', orderIndex: 0 };
    const b: Row = { id: 'b', state: 'idle', orderIndex: 1 };
    expect(order.compare(a, b)).toBeLessThan(0);
    expect(order.compare(b, a)).toBeGreaterThan(0);
    expect(order.compare(a, a)).toBe(0);
  });

  it('copies rather than sorting the caller array in place', () => {
    // Both renderers hand it a filtered slice of a shared row array; mutating
    // that would reorder the other surface's list as a side effect.
    const rows: Row[] = [
      { id: 'b', state: 'idle', lastActivityAt: 1_000 },
      { id: 'a', state: 'idle', lastActivityAt: 9_000 },
    ];
    order.sort(rows);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('survives junk input rather than throwing inside a render', () => {
    expect(order.sort(undefined as unknown as Row[])).toEqual([]);
    expect(order.anchor({} as Row)).toBe(0);
  });
});
