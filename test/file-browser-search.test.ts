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

function successfulTree(name: string, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      tree: [{ name, path: name, type: 'file', size: 1, extension: 'ts' }],
      totalFiles: 1,
      totalDirectories: 0,
      truncated: false,
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
    expect(elements.fileBrowserTree.innerHTML).toContain('data-path="src/widget.ts"');
    expect(elements.fileBrowserTree.innerHTML).not.toContain('class="file-tree-path"');
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

  it('keeps query B rendered when its response beats an already-launched query A', async () => {
    const { app, elements, pending } = loadPanel();
    app.filterFileBrowser('query A');
    await vi.advanceTimersByTimeAsync(250);
    app.filterFileBrowser('query B');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(2);

    pending[1].reply.resolve(
      response(
        successfulData({
          matches: [{ name: 'result-B.ts', path: 'result-B.ts', type: 'file' }],
          matchCount: 1,
        })
      )
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.fileBrowserTree.innerHTML).toContain('result-B.ts');

    pending[0].reply.resolve(
      response(
        successfulData({
          matches: [{ name: 'result-A.ts', path: 'result-A.ts', type: 'file' }],
          matchCount: 1,
        })
      )
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(elements.fileBrowserTree.innerHTML).toContain('result-B.ts');
    expect(elements.fileBrowserTree.innerHTML).not.toContain('result-A.ts');
    expect(app._fileBrowserState.matches[0].name).toBe('result-B.ts');
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

  describe('normal tree loads', () => {
    it('deduplicates compatible in-flight loads and reuses compatible ready and error states', async () => {
      const ready = loadPanel();
      ready.app._completeDeferredFileBrowserDirectory = vi.fn();
      const first = ready.app.loadFileBrowser('session/A');
      const duplicate = ready.app.loadFileBrowser('session/A');

      expect(duplicate).toBe(first);
      expect(ready.pending).toHaveLength(1);
      ready.pending[0].reply.resolve(response(successfulTree('ready.ts')));
      await first;
      expect(ready.app._fileBrowserState.normalState.phase).toBe('ready');
      expect(ready.elements.fileBrowserTree.innerHTML).toContain('ready.ts');
      expect(ready.app._completeDeferredFileBrowserDirectory).toHaveBeenCalledWith(
        ready.app._fileBrowserState.normalState
      );

      ready.elements.fileBrowserTree.innerHTML = '';
      const reusedReady = ready.app.loadFileBrowser('session/A');
      expect(ready.pending).toHaveLength(1);
      expect(typeof reusedReady.then).toBe('function');
      await reusedReady;
      expect(ready.elements.fileBrowserTree.innerHTML).toContain('ready.ts');

      const failed = loadPanel();
      failed.app._completeDeferredFileBrowserDirectory = vi.fn();
      const failedLoad = failed.app.loadFileBrowser('session/A');
      failed.pending[0].reply.reject(new Error('<img src=x onerror=boom>'));
      await failedLoad;
      expect(failed.app._fileBrowserState.normalState.phase).toBe('error');
      expect(failed.elements.fileBrowserTree.innerHTML).toContain('&lt;img src=x onerror=boom&gt;');
      expect(failed.elements.fileBrowserTree.innerHTML).not.toContain('<img src=x');
      expect(failed.elements.fileBrowserStatus.textContent).toContain('<img src=x onerror=boom>');
      expect(failed.elements.fileBrowserStatus.innerHTML).toBe('');
      expect(failed.app._completeDeferredFileBrowserDirectory).toHaveBeenCalledWith(
        failed.app._fileBrowserState.normalState
      );

      failed.elements.fileBrowserTree.innerHTML = '';
      await failed.app.loadFileBrowser('session/A');
      expect(failed.pending).toHaveLength(1);
      expect(failed.elements.fileBrowserTree.innerHTML).toContain('&lt;img src=x onerror=boom&gt;');
    });

    it('refresh invalidates both work classes, clears navigation state, and forces an epoch-safe replacement', async () => {
      const { app, elements, pending } = loadPanel();
      const stale = app.loadFileBrowser('session/A');
      app.filterFileBrowser('old query');
      app.fileBrowserExpandedDirs.add('src');
      app.fileBrowserAllExpanded = true;
      app._fileBrowserState.deferredDirectoryTarget = { ownerSessionId: 'session/A', path: 'src' };
      const beforeSearchEpoch = app._fileBrowserState.searchEpoch;
      const beforeTreeEpoch = app._fileBrowserState.treeEpoch;

      const replacement = app.refreshFileBrowser();

      expect(app._fileBrowserState.searchEpoch).toBe(beforeSearchEpoch + 1);
      expect(app._fileBrowserState.treeEpoch).toBe(beforeTreeEpoch + 1);
      expect(app._fileBrowserState.filter).toBe('');
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
      expect(app._fileBrowserState.view).toBe('normal');
      expect(app.fileBrowserExpandedDirs.size).toBe(0);
      expect(app.fileBrowserAllExpanded).toBe(false);
      expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
      expect(elements.fileBrowserSearch.value).toBe('');
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(pending).toHaveLength(2);

      pending[0].reply.resolve(response(successfulTree('stale.ts')));
      await stale;
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale.ts');
      expect(app._fileBrowserState.treeInFlight.promise).toBe(replacement);

      pending[1].reply.resolve(response(successfulTree('fresh.ts')));
      await replacement;
      expect(elements.fileBrowserTree.innerHTML).toContain('fresh.ts');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale.ts');
    });

    it('ignores stale pre-refresh failures while the replacement remains loading', async () => {
      const { app, elements, pending } = loadPanel();
      const stale = app.loadFileBrowser('session/A');
      const replacement = app.refreshFileBrowser();

      pending[0].reply.reject(new Error('stale failure'));
      await stale;
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale failure');

      pending[1].reply.resolve(response(successfulTree('replacement.ts')));
      await replacement;
      expect(elements.fileBrowserTree.innerHTML).toContain('replacement.ts');
    });

    it('isolates overlapping owners and does not reuse an unresolved A request after A to B to A', async () => {
      const { app, elements, pending } = loadPanel();
      const firstA = app.loadFileBrowser('session/A');
      app._fileBrowserState.ownerSessionId = 'session/B';
      app.activeSessionId = 'session/B';
      const loadB = app.loadFileBrowser('session/B');

      app._fileBrowserState.ownerSessionId = 'session/A';
      app.activeSessionId = 'session/A';
      const secondA = app.loadFileBrowser('session/A');
      expect(secondA).not.toBe(firstA);
      expect(pending).toHaveLength(3);

      pending[0].reply.resolve(response(successfulTree('stale-A.ts')));
      await firstA;
      expect(app.fileBrowserData).toBeNull();
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale-A.ts');

      pending[1].reply.reject(new Error('late B failure'));
      await loadB;
      expect(elements.fileBrowserTree.innerHTML).not.toContain('late B failure');
      pending[2].reply.resolve(response(successfulTree('current-A.ts')));
      await secondA;
      expect(elements.fileBrowserTree.innerHTML).toContain('current-A.ts');
    });

    it('shows B loading after clearing search while B is unsettled, never cached A data', async () => {
      const { app, elements, pending } = loadPanel();
      const firstA = app.loadFileBrowser('session/A');
      pending[0].reply.resolve(response(successfulTree('cached-A.ts')));
      await firstA;
      expect(elements.fileBrowserTree.innerHTML).toContain('cached-A.ts');

      app._fileBrowserState.ownerSessionId = 'session/B';
      app.activeSessionId = 'session/B';
      const loadB = app.loadFileBrowser('session/B');
      app.filterFileBrowser('temporary');
      app.filterFileBrowser('');

      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('cached-A.ts');
      pending[1].reply.resolve(response(successfulTree('current-B.ts')));
      await loadB;
      expect(elements.fileBrowserTree.innerHTML).toContain('current-B.ts');
    });

    it('settles a compatible tree behind search without repainting and keeps tree/search epochs independent', async () => {
      const { app, elements, pending } = loadPanel();
      const treeLoad = app.loadFileBrowser('session/A');
      app.filterFileBrowser('query A');
      await vi.advanceTimersByTimeAsync(250);
      app.filterFileBrowser('query B');
      await vi.advanceTimersByTimeAsync(250);
      expect(pending).toHaveLength(3);

      pending[0].reply.resolve(response(successfulTree('behind-search.ts')));
      await treeLoad;
      expect(app._fileBrowserState.normalState.phase).toBe('ready');
      expect(app.fileBrowserData.tree[0].name).toBe('behind-search.ts');
      expect(elements.fileBrowserTree.innerHTML).toContain('Searching');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('behind-search.ts');

      app._fileBrowserState.treeEpoch++;
      pending[2].reply.resolve(
        response(successfulData({ matches: [{ name: 'query-B.ts', path: 'query-B.ts', type: 'file' }] }))
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(elements.fileBrowserTree.innerHTML).toContain('query-B.ts');

      pending[1].reply.resolve(
        response(successfulData({ matches: [{ name: 'query-A.ts', path: 'query-A.ts', type: 'file' }] }))
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(elements.fileBrowserTree.innerHTML).not.toContain('query-A.ts');
    });

    it('suppresses invalidated tree responses and hidden-panel repainting', async () => {
      const scenarios = [
        {
          name: 'owner',
          mutate(app: Record<string, any>) {
            app._fileBrowserState.ownerSessionId = 'session/B';
          },
        },
        {
          name: 'tree epoch',
          mutate(app: Record<string, any>) {
            app._fileBrowserState.treeEpoch++;
          },
        },
        {
          name: 'hidden preference',
          mutate(app: Record<string, any>) {
            app.fileBrowserShowHidden = true;
          },
        },
      ];

      for (const scenario of scenarios) {
        const { app, elements, pending } = loadPanel();
        const load = app.loadFileBrowser('session/A');
        scenario.mutate(app);
        pending[0].reply.resolve(response(successfulTree(`late-${scenario.name}.ts`)));
        await load;
        expect(app.fileBrowserData, scenario.name).toBeNull();
        expect(elements.fileBrowserTree.innerHTML, scenario.name).not.toContain(`late-${scenario.name}.ts`);
      }

      const hidden = loadPanel();
      const hiddenLoad = hidden.app.loadFileBrowser('session/A');
      hidden.elements.fileBrowserPanel.classList.remove('visible');
      hidden.pending[0].reply.resolve(response(successfulTree('hidden-ready.ts')));
      await hiddenLoad;
      expect(hidden.app._fileBrowserState.normalState.phase).toBe('ready');
      expect(hidden.elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(hidden.elements.fileBrowserTree.innerHTML).not.toContain('hidden-ready.ts');
    });

    it('compare-and-clears only the exact stale request and preserves replacement deduplication', async () => {
      const { app, pending } = loadPanel();
      const stale = app.loadFileBrowser('session/A');
      const replacement = app.loadFileBrowser('session/A', { force: true });
      const replacementRecord = app._fileBrowserState.treeInFlight;

      pending[0].reply.resolve(response(successfulTree('stale.ts')));
      await stale;
      expect(app._fileBrowserState.treeInFlight).toBe(replacementRecord);

      const reused = app.loadFileBrowser('session/A');
      expect(reused).toBe(replacement);
      expect(pending).toHaveLength(2);

      pending[1].reply.resolve(response(successfulTree('replacement.ts')));
      await replacement;
    });

    it.each([
      ['tree is not an array', successfulTree('x.ts', { tree: {} })],
      ['totalFiles is not finite', successfulTree('x.ts', { totalFiles: Number.POSITIVE_INFINITY })],
      ['the envelope is search-discriminated', successfulTree('x.ts', { mode: 'search', matches: [], matchCount: 0 })],
      [
        'a nested node is malformed',
        successfulTree('x.ts', { tree: [{ name: 'dir', path: 'dir', type: 'directory', children: [{}] }] }),
      ],
    ])('stores an escaped error instead of malformed tree data when %s', async (_case, body) => {
      const { app, elements, pending } = loadPanel();
      const load = app.loadFileBrowser('session/A');
      pending[0].reply.resolve(response(body));
      await load;

      expect(app.fileBrowserData).toBeNull();
      expect(app._fileBrowserState.normalState.phase).toBe('error');
      expect(elements.fileBrowserTree.innerHTML).toContain('Failed to load files');
    });

    it('does not adopt a different owner or fetch without a usable tree surface', () => {
      const wrongOwner = loadPanel();
      wrongOwner.app._ensureFileBrowserState().ownerSessionId = 'session/B';
      expect(wrongOwner.app.loadFileBrowser('session/A')).toBeUndefined();
      expect(wrongOwner.pending).toHaveLength(0);
      expect(wrongOwner.app._fileBrowserState.ownerSessionId).toBe('session/B');

      const missingTree = loadPanel();
      delete missingTree.elements.fileBrowserTree;
      expect(missingTree.app.loadFileBrowser('session/A')).toBeUndefined();
      expect(missingTree.pending).toHaveLength(0);
    });
  });
});
