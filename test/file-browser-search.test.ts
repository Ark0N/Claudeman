/**
 * @fileoverview File Viewer server-side search (COD-341).
 *
 * The browser module is loaded as the real CodemanApp mixin in a VM. The fake
 * DOM intentionally implements only the element contract used by the File
 * Viewer, while fetch responses and timers remain controllable so races can be
 * exercised without jsdom.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const panelsJs = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');

type ClickHandler = () => void;

interface FakeClassList {
  add: (...names: string[]) => void;
  remove: (...names: string[]) => void;
  contains: (name: string) => boolean;
  toggle: (name: string, force?: boolean) => boolean;
}

interface FakeRow {
  dataset: Record<string, string>;
  addEventListener: (type: string, handler: ClickHandler) => void;
  click: () => void;
}

interface FakeElement {
  innerHTML: string;
  textContent: string;
  value: string;
  disabled: boolean;
  attrs: Record<string, string>;
  classList: FakeClassList;
  setAttribute: (name: string, value: string) => void;
  querySelectorAll: (selector: string) => FakeRow[];
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fakeElement(initialClasses: string[] = []): FakeElement {
  const classes = new Set(initialClasses);
  const attrs: Record<string, string> = {};
  const rows: FakeRow[] = [];
  let html = '';

  const classList: FakeClassList = {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      const on = force === undefined ? !classes.has(name) : force;
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
  };

  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
      rows.length = 0;
      const rowPattern = /<div class="file-tree-item[^"]*"([^>]*)>/g;
      for (const match of value.matchAll(rowPattern)) {
        const attributes = match[1];
        const dataset: Record<string, string> = {};
        for (const attr of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
          const key = attr[1].replace(/-([a-z])/g, (_whole, letter: string) => letter.toUpperCase());
          dataset[key] = decodeHtml(attr[2]);
        }
        let clickHandler: ClickHandler | null = null;
        rows.push({
          dataset,
          addEventListener(type, handler) {
            if (type === 'click') clickHandler = handler;
          },
          click() {
            clickHandler?.();
          },
        });
      }
    },
    textContent: '',
    value: '',
    disabled: false,
    attrs,
    classList,
    setAttribute(name, value) {
      attrs[name] = value;
    },
    querySelectorAll(selector) {
      return selector === '.file-tree-item' ? rows : [];
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function response(body: unknown, ok = true): FakeResponse {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function loadPanel(options: { sessionId?: string | null; showHidden?: boolean } = {}) {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, unknown>;
  const elements: Record<string, FakeElement> = {
    fileBrowserPanel: fakeElement(['visible']),
    fileBrowserTree: fakeElement(),
    fileBrowserStatus: fakeElement(),
    fileBrowserSearch: fakeElement(),
    fileBrowserExpandBtn: fakeElement(),
    fileBrowserHiddenBtn: fakeElement(),
  };
  const pending: Array<{ url: string; reply: ReturnType<typeof deferred<FakeResponse>> }> = [];
  const context = vm.createContext({
    CodemanApp,
    console,
    escapeHtml,
    localStorage: { getItem: () => null, setItem: vi.fn() },
    document: { getElementById: () => null, addEventListener: vi.fn(), querySelector: vi.fn() },
    window: { addEventListener: vi.fn() },
    setTimeout,
    clearTimeout,
    fetch: (url: string) => {
      const reply = deferred<FakeResponse>();
      pending.push({ url, reply });
      return reply.promise;
    },
  });
  vm.runInContext(panelsJs, context, { filename: 'panels-ui.js' });

  const app = new CodemanApp() as Record<string, any>;
  app.$ = (id: string) => elements[id] ?? null;
  app.activeSessionId = options.sessionId === undefined ? 'session/A' : options.sessionId;
  app.fileBrowserData = null;
  app.fileBrowserExpandedDirs = new Set<string>();
  app.fileBrowserFilter = '';
  app.fileBrowserAllExpanded = false;
  app.fileBrowserShowHidden = options.showHidden ?? false;
  app.openFilePreview = vi.fn();

  return { app, elements, pending };
}

async function startSearch(app: Record<string, any>, query = 'widget') {
  app.filterFileBrowser(query);
  await vi.advanceTimersByTimeAsync(250);
}

async function settleSearch(
  app: Record<string, any>,
  pending: Array<{ url: string; reply: ReturnType<typeof deferred<FakeResponse>> }>,
  body: unknown,
  ok = true
) {
  await startSearch(app);
  pending[0].reply.resolve(response(body, ok));
  await vi.advanceTimersByTimeAsync(0);
}

function successfulData(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      mode: 'search',
      matches: [],
      truncated: false,
      matchCount: 0,
      ...overrides,
    },
  };
}

describe('File Viewer server search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces for 250ms and encodes the owner and exact trimmed query', async () => {
    const { app, pending } = loadPanel();

    app.filterFileBrowser('src & docs');
    await vi.advanceTimersByTimeAsync(249);
    expect(pending).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toBe('/api/sessions/session%2FA/files?depth=5&showHidden=false&q=src%20%26%20docs');
  });

  it('is a safe no-op without a panel or session and can lazily adopt a later active owner', async () => {
    const { app, elements, pending } = loadPanel({ sessionId: null });
    app.filterFileBrowser('before-session');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(0);

    app.activeSessionId = 'session/B';
    app.filterFileBrowser('after-session');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending[0].url).toBe('/api/sessions/session%2FB/files?depth=5&showHidden=false&q=after-session');

    pending[0].reply.resolve(response(successfulData()));
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.fileBrowserTree.innerHTML).toContain('No matches');

    delete elements.fileBrowserPanel;
    app.filterFileBrowser('without-panel');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(1);
  });

  it('does not schedule when the active session is missing or differs from the retained owner', async () => {
    const { app, elements, pending } = loadPanel();
    app._ensureFileBrowserState();

    app.activeSessionId = null;
    app.filterFileBrowser('missing-active');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(0);
    expect(elements.fileBrowserTree.innerHTML).toBe('');
    expect(app._fileBrowserState.inFlight).toBeNull();

    app.activeSessionId = 'session/B';
    app.filterFileBrowser('wrong-active');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(0);
    expect(elements.fileBrowserTree.innerHTML).toBe('');
    expect(app._fileBrowserState.inFlight).toBeNull();
  });

  it('cancels the prior debounce and clears a deferred directory target on every input', async () => {
    const { app, pending } = loadPanel();
    app._ensureFileBrowserState().deferredDirectoryTarget = {
      ownerSessionId: 'session/A',
      path: 'old-directory',
    };

    app.filterFileBrowser('first query');
    await vi.advanceTimersByTimeAsync(200);
    app._fileBrowserState.deferredDirectoryTarget = {
      ownerSessionId: 'session/A',
      path: 'another-directory',
    };
    app.filterFileBrowser('second query');

    expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
    await vi.advanceTimersByTimeAsync(249);
    expect(pending).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.map(({ url }) => url)).toEqual([
      '/api/sessions/session%2FA/files?depth=5&showHidden=false&q=second%20query',
    ]);
  });

  it('renders flat file and directory matches with captured-owner actions and status', async () => {
    const { app, elements, pending } = loadPanel();
    await settleSearch(
      app,
      pending,
      successfulData({
        matches: [
          { name: 'widget.ts', path: 'src/widget.ts', type: 'file', size: 1536, extension: 'ts' },
          { name: 'widgets', path: 'docs/widgets', type: 'directory' },
        ],
        matchCount: 2,
        truncated: true,
      })
    );

    expect(elements.fileBrowserTree.innerHTML).toContain('class="file-tree-name">widget.ts</span>');
    expect(elements.fileBrowserTree.innerHTML).toContain('class="file-tree-name directory">widgets</span>');
    expect(elements.fileBrowserTree.innerHTML).toContain('class="file-tree-size">1.5 KB</span>');
    expect(elements.fileBrowserTree.innerHTML).toContain('📘');
    expect(elements.fileBrowserTree.innerHTML).toContain('📁');
    expect(elements.fileBrowserTree.innerHTML).toContain('src/widget.ts');
    expect(elements.fileBrowserTree.innerHTML).toContain(
      'href="/api/sessions/session%2FA/file-raw?path=src%2Fwidget.ts&amp;download=true"'
    );
    expect(elements.fileBrowserStatus.textContent).toBe('2 matches (truncated)');
    expect(elements.fileBrowserExpandBtn.disabled).toBe(true);

    app.activeSessionId = 'later-session';
    const rows = elements.fileBrowserTree.querySelectorAll('.file-tree-item');
    rows[0].click();
    rows[1].click();
    expect(app.openFilePreview).toHaveBeenCalledWith('src/widget.ts', 'session/A');
    expect(app._fileBrowserState.deferredDirectoryTarget).toEqual({
      ownerSessionId: 'session/A',
      path: 'docs/widgets',
    });
  });

  it('uses the match list length when matchCount is omitted and renders no matches', async () => {
    const { app, elements, pending } = loadPanel();
    await settleSearch(app, pending, successfulData({ matchCount: undefined }));

    expect(elements.fileBrowserTree.innerHTML).toContain('No matches');
    expect(elements.fileBrowserStatus.textContent).toBe('0 matches');
  });

  it('rejects deferred results after any captured search context changes', async () => {
    const scenarios: Array<{
      name: string;
      mutate: (app: Record<string, any>, elements: Record<string, FakeElement>) => void;
    }> = [
      {
        name: 'raw input',
        mutate: (app) => {
          app._fileBrowserState.filter = 'changed raw input';
        },
      },
      {
        name: 'search epoch',
        mutate: (app) => {
          app._fileBrowserState.searchEpoch++;
        },
      },
      {
        name: 'tree epoch',
        mutate: (app) => {
          app._fileBrowserState.treeEpoch++;
        },
      },
      {
        name: 'owner',
        mutate: (app) => {
          app._fileBrowserState.ownerSessionId = 'another-owner';
        },
      },
      {
        name: 'active session',
        mutate: (app) => {
          app.activeSessionId = 'another-active-session';
        },
      },
      {
        name: 'hidden preference',
        mutate: (app) => {
          app.fileBrowserShowHidden = true;
        },
      },
      {
        name: 'panel visibility',
        mutate: (_app, elements) => {
          elements.fileBrowserPanel.classList.remove('visible');
        },
      },
    ];

    for (const scenario of scenarios) {
      const { app, elements, pending } = loadPanel();
      await startSearch(app);
      expect(app._fileBrowserState.inFlight.treeEpoch, scenario.name).toBe(0);
      scenario.mutate(app, elements);

      pending[0].reply.resolve(
        response(
          successfulData({
            matches: [{ name: `late-${scenario.name}.ts`, path: 'late.ts', type: 'file' }],
            matchCount: 1,
          })
        )
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(elements.fileBrowserTree.innerHTML, scenario.name).toContain('Searching');
      expect(elements.fileBrowserTree.innerHTML, scenario.name).not.toContain(`late-${scenario.name}.ts`);
      expect(app._fileBrowserState.inFlight, scenario.name).toBeNull();
    }
  });

  it('clears a blank query and restores the compatible cached tree immediately without fetching', () => {
    const { app, elements, pending } = loadPanel();
    app.fileBrowserData = {
      tree: [{ name: 'cached.ts', path: 'src/cached.ts', type: 'file', size: 4, extension: 'ts' }],
      totalFiles: 1,
      totalDirectories: 0,
      truncated: false,
    };

    app.filterFileBrowser('cache');
    expect(elements.fileBrowserTree.innerHTML).toContain('Searching');
    app.filterFileBrowser('   ');

    expect(pending).toHaveLength(0);
    expect(elements.fileBrowserTree.innerHTML).toContain('cached.ts');
    expect(elements.fileBrowserStatus.textContent).toBe('1 files, 0 dirs');
    expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
  });

  it('binds normal-tree previews and encoded downloads to the captured owner', () => {
    const { app, elements } = loadPanel();
    app.fileBrowserData = {
      tree: [
        {
          name: 'normal & safe.ts',
          path: 'src/normal & safe.ts',
          type: 'file',
          size: 7,
          extension: 'ts',
        },
      ],
      totalFiles: 1,
      totalDirectories: 0,
      truncated: false,
    };
    app.renderFileBrowserTree();

    expect(elements.fileBrowserTree.innerHTML).toContain(
      'href="/api/sessions/session%2FA/file-raw?path=src%2Fnormal%20%26%20safe.ts&amp;download=true"'
    );
    app.activeSessionId = 'later-session';
    elements.fileBrowserTree.querySelectorAll('.file-tree-item')[0].click();
    expect(app.openFilePreview).toHaveBeenCalledWith('src/normal & safe.ts', 'session/A');
  });

  it('accepts 256 trimmed characters', async () => {
    const { app, pending } = loadPanel();
    app.filterFileBrowser(`  ${'x'.repeat(256)}  `);

    await vi.advanceTimersByTimeAsync(250);

    expect(pending).toHaveLength(1);
    expect(pending[0].url.endsWith(`&q=${'x'.repeat(256)}`)).toBe(true);
  });

  it('rejects 257 trimmed characters without a request', async () => {
    const { app, elements, pending } = loadPanel();
    app.filterFileBrowser('x'.repeat(257));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(pending).toHaveLength(0);
    expect(elements.fileBrowserStatus.textContent).toBe('Search queries are limited to 256 characters');
    expect(app._fileBrowserState.matches).toEqual([]);
    expect(app._fileBrowserState.view).toBe('query-error');
  });

  it('fails closed on a non-2xx response', async () => {
    const { app, elements, pending } = loadPanel();
    await settleSearch(app, pending, { success: true }, false);

    expect(elements.fileBrowserTree.innerHTML).toBe('<div class="file-browser-empty">Search failed</div>');
    expect(elements.fileBrowserStatus.textContent).toBe('Search failed');
    expect(app._fileBrowserState.view).toBe('search-error');
  });

  it('fails closed on an unsuccessful envelope', async () => {
    const { app, elements, pending } = loadPanel();
    await settleSearch(app, pending, { success: false, error: '<b>server detail</b>' });

    expect(elements.fileBrowserTree.innerHTML).toBe('<div class="file-browser-empty">Search failed</div>');
    expect(elements.fileBrowserTree.innerHTML).not.toContain('server detail');
  });

  it.each([
    ['mode is not search', successfulData({ mode: 'tree' })],
    ['matches is not an array', successfulData({ matches: {} })],
    ['a match name is not a string', successfulData({ matches: [{ name: 1, path: 'x', type: 'file' }] })],
    ['a match path is not a string', successfulData({ matches: [{ name: 'x', path: null, type: 'file' }] })],
    ['a match type is unknown', successfulData({ matches: [{ name: 'x', path: 'x', type: 'symlink' }] })],
    [
      'a supplied size is not a number',
      successfulData({ matches: [{ name: 'x', path: 'x', type: 'file', size: '1' }] }),
    ],
    [
      'a supplied extension is not a string',
      successfulData({ matches: [{ name: 'x', path: 'x', type: 'file', extension: 1 }] }),
    ],
    ['truncated is not boolean', successfulData({ truncated: 'false' })],
    ['matchCount is negative', successfulData({ matchCount: -1 })],
    ['matchCount is not finite', successfulData({ matchCount: Number.POSITIVE_INFINITY })],
  ])('rejects a malformed successful envelope when %s', async (_case, body) => {
    const { app, elements, pending } = loadPanel();
    app.fileBrowserData = {
      tree: [{ name: 'cached-safe.ts', path: 'cached-safe.ts', type: 'file' }],
      totalFiles: 1,
      totalDirectories: 0,
      truncated: false,
    };
    const malformed = structuredClone(body);
    if (_case === 'matchCount is not finite') {
      (malformed as { data: { matchCount: number } }).data.matchCount = Number.POSITIVE_INFINITY;
    }
    await settleSearch(app, pending, malformed);

    expect(elements.fileBrowserTree.innerHTML).toBe('<div class="file-browser-empty">Search failed</div>');
    expect(elements.fileBrowserTree.innerHTML).not.toContain('cached-safe.ts');
    expect(app.fileBrowserData.tree[0].name).toBe('cached-safe.ts');
  });

  it('escapes metacharacters in displayed values, attributes, and links', async () => {
    const owner = 'session/"<&\'';
    const path = 'src/"<&\'/evil.ts';
    const name = '<img src=x onerror="boom"> &\'';
    const { app, elements, pending } = loadPanel({ sessionId: owner });
    await settleSearch(
      app,
      pending,
      successfulData({ matches: [{ name, path, type: 'file', extension: 'ts' }], matchCount: 1 })
    );

    const html = elements.fileBrowserTree.innerHTML;
    expect(html).toContain('&lt;img src=x onerror=&quot;boom&quot;&gt; &amp;&#039;');
    expect(html).toContain('src/&quot;&lt;&amp;&#039;/evil.ts');
    expect(html).toContain('data-path="src/&quot;&lt;&amp;&#039;/evil.ts"');
    expect(html).toContain(
      'href="/api/sessions/session%2F%22%3C%26&#039;/file-raw?path=src%2F%22%3C%26&#039;%2Fevil.ts&amp;download=true"'
    );
    expect(html).not.toContain('<img src=x');
  });
});
