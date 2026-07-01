import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadPaletteHarness(overrides: Record<string, any> = {}) {
  const elements: Record<string, any> = {};
  const listeners: Record<string, (event: any) => void> = {};
  const CodemanApp = function CodemanApp(this: any) {};

  const makeClassList = () => {
    const classes = new Set<string>();
    return {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const shouldAdd = force ?? !classes.has(name);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
    };
  };

  elements.commandPaletteModal = {
    classList: makeClassList(),
    addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
      listeners[`modal:${event}`] = handler;
    }),
  };
  elements.commandPaletteSearch = {
    value: '',
    focus: vi.fn(),
    select: vi.fn(),
    addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
      listeners[`search:${event}`] = handler;
    }),
  };
  elements.commandPaletteList = {
    innerHTML: '',
    addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
      listeners[`list:${event}`] = handler;
    }),
  };

  const context = vm.createContext({
    CodemanApp,
    document: {
      getElementById: (id: string) => elements[id] ?? null,
    },
    console,
    escapeHtml: (value: string) =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
    ...overrides,
  });

  const panelsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  vm.runInContext(panelsUi, context, { filename: 'panels-ui.js' });

  const app = new (CodemanApp as any)();
  app.sessions = new Map([
    [
      'sess-alpha',
      {
        id: 'sess-alpha',
        name: 'Alpha API cleanup',
        workingDir: '/repo/api',
        mode: 'codex',
        status: 'busy',
      },
    ],
    [
      'sess-beta',
      {
        id: 'sess-beta',
        name: 'Billing prompt polish',
        workingDir: '/repo/billing',
        mode: 'claude',
        status: 'idle',
      },
    ],
  ]);
  app.sessionOrder = ['sess-beta', 'sess-alpha'];
  app.selectSession = vi.fn();
  app.run = vi.fn();
  app.closeMobileHeaderUtilities = vi.fn();

  return { app, elements, listeners };
}

describe('Command-K session palette', () => {
  it('recognizes Cmd/Ctrl-K outside text-entry contexts only', () => {
    const { app } = loadPaletteHarness();

    expect(app.shouldOpenCommandPaletteFromShortcut({ key: 'k', metaKey: true, ctrlKey: false, target: null })).toBe(
      true
    );
    expect(app.shouldOpenCommandPaletteFromShortcut({ key: 'K', metaKey: false, ctrlKey: true, target: null })).toBe(
      true
    );
    expect(
      app.shouldOpenCommandPaletteFromShortcut({
        key: 'k',
        metaKey: true,
        ctrlKey: false,
        target: { tagName: 'INPUT', isContentEditable: false },
      })
    ).toBe(false);
    expect(
      app.shouldOpenCommandPaletteFromShortcut({
        key: 'k',
        metaKey: false,
        ctrlKey: true,
        target: { tagName: 'DIV', isContentEditable: true },
      })
    ).toBe(false);
  });

  it('recognizes Ctrl-K from the focused xterm helper textarea', () => {
    const { app } = loadPaletteHarness();

    expect(
      app.shouldOpenCommandPaletteFromShortcut({
        key: 'k',
        code: 'KeyK',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        target: {
          tagName: 'TEXTAREA',
          isContentEditable: false,
          classList: { contains: (name: string) => name === 'xterm-helper-textarea' },
        },
      })
    ).toBe(true);
  });

  it('recognizes macOS Option-K by physical key code', () => {
    const { app } = loadPaletteHarness();

    expect(
      app.shouldOpenCommandPaletteFromShortcut({
        key: '˚',
        code: 'KeyK',
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        target: null,
      })
    ).toBe(true);
  });

  it('opens and focuses the palette search box', () => {
    const { app, elements } = loadPaletteHarness();

    app.openCommandPalette();

    expect(elements.commandPaletteModal.classList.contains('active')).toBe(true);
    expect(elements.commandPaletteSearch.focus).toHaveBeenCalledTimes(1);
    expect(elements.commandPaletteList.innerHTML).toContain('Alpha API cleanup');
  });

  it('filters currently open sessions and always includes a new-session action', () => {
    const { app } = loadPaletteHarness();

    const results = app.buildCommandPaletteItems('bill');

    expect(results.map((item: any) => item.id)).toEqual(['session:sess-beta', 'new-session']);
    expect(results[0]).toMatchObject({ type: 'session', sessionId: 'sess-beta', title: 'Billing prompt polish' });
    expect(results[1]).toMatchObject({ type: 'new-session', title: 'New session' });
  });

  it('activates the highlighted session result', async () => {
    const { app } = loadPaletteHarness();
    app.openCommandPalette();
    app.commandPaletteItems = app.buildCommandPaletteItems('api');
    app.commandPaletteActiveIndex = 0;

    await app.activateCommandPaletteItem();

    expect(app.selectSession).toHaveBeenCalledWith('sess-alpha');
    expect(app.run).not.toHaveBeenCalled();
  });

  it('activates the new-session result through the current run path', async () => {
    const { app } = loadPaletteHarness();
    app.openCommandPalette();
    app.commandPaletteItems = app.buildCommandPaletteItems('does-not-match');
    app.commandPaletteActiveIndex = 0;

    await app.activateCommandPaletteItem();

    expect(app.run).toHaveBeenCalledTimes(1);
    expect(app.selectSession).not.toHaveBeenCalled();
  });

  it('routes Enter from the palette search to the current result', async () => {
    const { app, listeners } = loadPaletteHarness();
    app.openCommandPalette();
    app.commandPaletteItems = app.buildCommandPaletteItems('api');
    app.commandPaletteActiveIndex = 0;

    const event = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await listeners['search:keydown'](event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.selectSession).toHaveBeenCalledWith('sess-alpha');
  });
});

describe('panel close helpers', () => {
  it('closes panels when the mobile header helper is unavailable', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const elements: Record<string, any> = {
      monitorPanel: { classList: { remove: vi.fn() } },
      subagentsPanel: { classList: { remove: vi.fn() } },
    };
    const context = vm.createContext({
      CodemanApp,
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      console,
    });

    const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
    vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });

    const app = new (CodemanApp as any)();
    app.closeSessionOptions = vi.fn();
    app.closeAppSettings = vi.fn();
    app.cancelCloseSession = vi.fn();
    app.closeTokenStats = vi.fn();

    expect(() => app.closeAllPanels()).not.toThrow();
    expect(elements.monitorPanel.classList.remove).toHaveBeenCalledWith('open');
    expect(elements.subagentsPanel.classList.remove).toHaveBeenCalledWith('open');
  });
});
