/**
 * @fileoverview Issue #260 — the home screen's "Resume Conversation" list.
 *
 * With ~35 past sessions the list showed 4 rows, then a button that dumped every
 * remaining row into a fixed 240px box, with no way to sort or filter. The fix
 * moved rendering into `_renderHistoryList()` over a cached corpus, so what is
 * worth pinning is the model, not the pixels:
 *   1. the collapsed page is _HISTORY_INITIAL_COUNT rows, not 4,
 *   2. "Show more" expands the LIST and marks the box expanded (the CSS cap is
 *      class-driven — without the class, expanding just deepens a scroll well),
 *   3. filtering matches name / folder / case label / prompt, and implies
 *      expansion (hiding matches behind "Show more" defeats typing a filter),
 *   4. sorting is alphabetical by name or folder, with pinned rows still on top.
 *
 * Loaded via `vm` against a stub CodemanApp with a fake DOM — same harness as
 * resume-name.test.ts. `_buildHistoryItem` is stubbed: this pins WHICH rows get
 * rendered and in what order, not how one row looks.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface FakeEl {
  id: string;
  value: string;
  textContent: string;
  scrollTop: number;
  className: string;
  children: FakeEl[];
  classes: Set<string>;
  listeners: Record<string, ((ev: unknown) => void)[]>;
  classList: { toggle: (c: string, on: boolean) => void; contains: (c: string) => boolean };
  replaceChildren: () => void;
  appendChild: (child: FakeEl) => FakeEl;
  addEventListener: (type: string, fn: (ev: unknown) => void) => void;
  style: Record<string, string>;
}

function fakeEl(id: string): FakeEl {
  const el = {
    id,
    value: '',
    textContent: '',
    scrollTop: 0,
    className: '',
    children: [] as FakeEl[],
    classes: new Set<string>(),
    listeners: {} as Record<string, ((ev: unknown) => void)[]>,
    style: {} as Record<string, string>,
  } as FakeEl;
  el.classList = {
    toggle: (c: string, on: boolean) => (on ? el.classes.add(c) : el.classes.delete(c)),
    contains: (c: string) => el.classes.has(c),
  };
  el.replaceChildren = () => {
    el.children = [];
  };
  el.appendChild = (child: FakeEl) => {
    el.children.push(child);
    return child;
  };
  el.addEventListener = (type: string, fn: (ev: unknown) => void) => {
    (el.listeners[type] ||= []).push(fn);
  };
  return el;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The element map the vm's `document.getElementById` resolves against. Swapped
 * per test — the closure is defined in THIS realm, so the shipping code inside
 * the vm reads whatever the current test installed.
 */
let currentEls: Record<string, FakeEl> = {};

function loadTerminalUiPrototype(): Record<string, any> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: {
      addEventListener: vi.fn(),
      getElementById: (id: string) => currentEls[id] ?? null,
      createElement: () => fakeEl('created'),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as unknown as { __proto: Record<string, any> }).__proto;
}

const proto = loadTerminalUiPrototype();

type Row = {
  sessionId: string;
  name?: string;
  workingDir?: string;
  firstPrompt?: string;
  pinned?: boolean;
  lastActivityAt?: number;
};

/** Host object carrying the real render/filter/sort methods over a fake DOM. */
function makeApp(rows: Row[], cases: Array<{ name: string; path: string }> = []) {
  const els: Record<string, FakeEl> = {
    historyList: fakeEl('historyList'),
    historyFilter: fakeEl('historyFilter'),
    historySort: fakeEl('historySort'),
    historyCount: fakeEl('historyCount'),
  };
  els.historySort.value = 'recent';

  const app: any = {
    _HISTORY_INITIAL_COUNT: proto._HISTORY_INITIAL_COUNT,
    _historyAll: rows,
    _historyCases: cases,
    _renderHistoryList: proto._renderHistoryList,
    _historyRowMatches: proto._historyRowMatches,
    _sortHistoryRows: proto._sortHistoryRows,
    _historyRowLabel: proto._historyRowLabel,
    _resolveCaseLabel: proto._resolveCaseLabel,
    _shortenHomePath: proto._shortenHomePath,
    // One fake node per row, tagged so assertions can read back the order.
    _buildHistoryItem: (s: Row) => {
      const el = fakeEl('item');
      el.textContent = s.sessionId;
      return el;
    },
    els,
    /** Rendered row ids, excluding the show-more/less button and empty state. */
    renderedIds(): string[] {
      return els.historyList.children.filter((c) => c.id === 'item').map((c) => c.textContent);
    },
    button(): FakeEl | undefined {
      return els.historyList.children.find((c) => c.id === 'created');
    },
  };

  // Point the vm's document at this app's elements, then run the shipping method.
  app._render = () => {
    currentEls = els;
    app._renderHistoryList();
  };
  return app;
}

function rows(n: number, overrides: Partial<Row> = {}): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`,
    name: `w${i}-project${i}`,
    workingDir: `/home/u/project${i}`,
    lastActivityAt: 1000 - i,
    ...overrides,
  }));
}

describe('issue #260 — collapsed page size', () => {
  it('shows more than the old 4 rows before "Show more"', () => {
    expect(proto._HISTORY_INITIAL_COUNT).toBeGreaterThanOrEqual(8);
  });

  it('renders the initial page and a "Show more" button for the rest', () => {
    const app = makeApp(rows(35));
    app._render();
    expect(app.renderedIds()).toHaveLength(proto._HISTORY_INITIAL_COUNT);
    expect(app.button()?.textContent).toBe(`Show ${35 - proto._HISTORY_INITIAL_COUNT} more`);
    expect(app.els.historyList.classList.contains('expanded')).toBe(false);
  });

  it('expanding renders every row AND marks the box expanded', () => {
    const app = makeApp(rows(35));
    app._historyExpanded = true;
    app._render();
    expect(app.renderedIds()).toHaveLength(35);
    // Without this class the CSS max-height stays at the collapsed cap and the
    // extra rows land in a four-row scroll well — the original bug.
    expect(app.els.historyList.classList.contains('expanded')).toBe(true);
    expect(app.button()?.textContent).toBe('Show less');
  });

  it('shows no button at all when everything fits', () => {
    const app = makeApp(rows(3));
    app._render();
    expect(app.renderedIds()).toHaveLength(3);
    expect(app.button()).toBeUndefined();
  });
});

describe('issue #260 — filter', () => {
  it('matches on folder name and shows every match without expanding first', () => {
    const app = makeApp([
      ...rows(30),
      { sessionId: 'x1', name: 'w99-invoices', workingDir: '/home/u/invoices', lastActivityAt: 1 },
      { sessionId: 'x2', name: 'w98-other', workingDir: '/home/u/invoices-archive', lastActivityAt: 2 },
    ]);
    app.els.historyFilter.value = 'invoices';
    app._render();
    expect(app.renderedIds().sort()).toEqual(['x1', 'x2']);
    expect(app.els.historyList.classList.contains('expanded')).toBe(true);
    expect(app.els.historyCount.textContent).toBe('2 of 32');
  });

  it('matches on the case label and on a prompt', () => {
    const app = makeApp(
      [
        { sessionId: 'c1', name: 'w1-x', workingDir: '/home/u/cases/billing', lastActivityAt: 1 },
        {
          sessionId: 'p1',
          name: 'w2-y',
          workingDir: '/home/u/other',
          firstPrompt: 'fix the CSV export',
          lastActivityAt: 2,
        },
      ],
      [{ name: 'billing', path: '/home/u/cases/billing' }]
    );
    app.els.historyFilter.value = '#billing';
    app._render();
    expect(app.renderedIds()).toEqual(['c1']);

    app.els.historyFilter.value = 'csv export';
    app._render();
    expect(app.renderedIds()).toEqual(['p1']);
  });

  it('renders an empty state when nothing matches', () => {
    const app = makeApp(rows(5));
    app.els.historyFilter.value = 'zzzz';
    app._render();
    expect(app.renderedIds()).toEqual([]);
    expect(app.els.historyList.children[0].textContent).toContain('No conversations match');
  });
});

describe('issue #260 — sort', () => {
  const unsorted: Row[] = [
    { sessionId: 'b', name: 'beta', workingDir: '/home/u/zeta', lastActivityAt: 300 },
    { sessionId: 'a', name: 'alpha', workingDir: '/home/u/yankee', lastActivityAt: 200 },
    { sessionId: 'c', name: 'gamma', workingDir: '/home/u/xray', lastActivityAt: 100 },
  ];

  it('recent keeps the backend order', () => {
    const app = makeApp(unsorted);
    app._render();
    expect(app.renderedIds()).toEqual(['b', 'a', 'c']);
  });

  it('sorts by name', () => {
    const app = makeApp(unsorted);
    app.els.historySort.value = 'name';
    app._render();
    expect(app.renderedIds()).toEqual(['a', 'b', 'c']);
  });

  it('sorts by folder basename', () => {
    const app = makeApp(unsorted);
    app.els.historySort.value = 'folder';
    app._render();
    expect(app.renderedIds()).toEqual(['c', 'a', 'b']);
  });

  it('sorts transcript rows (no session name) by the prompt shown as their title', () => {
    // Most past rows come from a transcript and have no name at all. Keying the
    // A–Z sort off `name` alone made "Name A–Z" a no-op for them.
    const app = makeApp([
      { sessionId: 'z', workingDir: '/home/u/one', firstPrompt: 'zebra crossing' },
      { sessionId: 'a', workingDir: '/home/u/two', firstPrompt: 'apple pie' },
      { sessionId: 'm', workingDir: '/home/u/three', firstPrompt: 'middle ground' },
    ]);
    app.els.historySort.value = 'name';
    app._render();
    expect(app.renderedIds()).toEqual(['a', 'm', 'z']);
  });

  it('keeps pinned rows on top in every sort mode', () => {
    const app = makeApp([{ sessionId: 'p', name: 'zulu', workingDir: '/home/u/zulu', pinned: true }, ...unsorted]);
    for (const mode of ['recent', 'name', 'folder']) {
      app.els.historySort.value = mode;
      app._render();
      expect(app.renderedIds()[0]).toBe('p');
    }
  });
});
