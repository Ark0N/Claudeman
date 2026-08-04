/**
 * @fileoverview Unit tests for the Codex run-mode UI surface in session-ui.js /
 * settings-ui.js / index.html. Loads the browser modules into a vm sandbox (no
 * real DOM) and exercises run-mode selection + Codex quick-start wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadRunModeHarness() {
  const elements: Record<string, any> = {};
  const storage = new Map<string, string>();
  const CodemanApp = function CodemanApp(this: any) {};

  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
    },
    console,
  });

  const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
  const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
  vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

  const runModeMenu = { classList: { remove: () => {} } };
  const gearBtn = { className: '' };
  const runBtn = { className: '', nextElementSibling: gearBtn };
  const runBtnLabel = { textContent: '' };
  elements.runModeMenu = runModeMenu;
  elements.runBtn = runBtn;
  elements.runBtnLabel = runBtnLabel;

  const app = new (CodemanApp as any)();
  app.loadAppSettingsFromStorage = () => ({});
  app.saveAppSettingsToStorage = () => {};
  app._apiPut = () => Promise.resolve();

  return { app, storage, runBtnLabel };
}

describe('run mode UI', () => {
  it('updates the visible mode when selecting Claude after server sync set Codex', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'codex' }));
    expect(app.runMode).toBe('codex');
    expect(runBtnLabel.textContent).toBe('Run CX');

    app.setRunMode('claude');

    expect(app.runMode).toBe('claude');
    expect(runBtnLabel.textContent).toBe('Run');
  });

  it('accepts Gemini mode from server sync and updates the run button label', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'gemini' }));

    expect(app.runMode).toBe('gemini');
    expect(runBtnLabel.textContent).toBe('Run GM');
  });

  it('accepts Antigravity mode from server sync and updates the run button label', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'antigravity' }));

    expect(app.runMode).toBe('antigravity');
    expect(runBtnLabel.textContent).toBe('Run AG');
  });
});

describe('Run launch synchronization', () => {
  it('coalesces overlapping Run activations and disables the button while the request is active', async () => {
    const runBtn = {
      disabled: false,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => (id === 'runBtn' ? runBtn : null) },
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app._runMinLockMs = 0;
    let finishRun!: () => void;
    app.runClaude = vi.fn(
      () =>
        new Promise<void>((resolveRun) => {
          finishRun = resolveRun;
        })
    );

    const first = app.run();
    const duplicate = app.run();

    expect(app.runClaude).toHaveBeenCalledTimes(1);
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');

    finishRun();
    await Promise.all([first, duplicate]);

    expect(runBtn.disabled).toBe(false);
    expect(runBtn.removeAttribute).toHaveBeenCalledWith('aria-busy');
  });

  it('renders a POST response session immediately without waiting for SSE', async () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      fetch: vi.fn(),
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.sessions = new Map();
    app._onSessionCreated = vi.fn((session: any) => app.sessions.set(session.id, session));
    app._renderSessionTabsImmediate = vi.fn();
    const snapshot = { id: 'sess-new', name: 'w1-case', workingDir: '/tmp/case' };

    await app._ensureCreatedSessionVisible(snapshot.id, snapshot);

    expect(context.fetch).not.toHaveBeenCalled();
    expect(app.sessions.get(snapshot.id)).toEqual(snapshot);
    expect(app._renderSessionTabsImmediate).toHaveBeenCalledTimes(1);
  });

  it('loads the new session when a quick-start response wins the race with SSE', async () => {
    const snapshot = { id: 'sess-race', name: 'w1-remote', workingDir: '/remote/work' };
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ success: true, data: snapshot }),
    }));
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      fetch: fetchMock,
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.sessions = new Map();
    app._onSessionCreated = vi.fn((session: any) => app.sessions.set(session.id, session));
    app._renderSessionTabsImmediate = vi.fn();

    await app._ensureCreatedSessionVisible(snapshot.id);

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-race');
    expect(app.sessions.get(snapshot.id)).toEqual(snapshot);
    expect(app._renderSessionTabsImmediate).toHaveBeenCalledTimes(1);
  });
});

describe('Codex quick start settings', () => {
  it('renders Codex CLI settings in a dedicated app settings tab', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    expect(html).toContain('data-tab="settings-codex">Codex CLI</button>');

    const claudeTab = html.match(
      /<div class="modal-tab-content hidden" id="settings-claude">([\s\S]*?)<!-- Codex CLI Tab -->/
    );
    expect(claudeTab?.[1]).not.toContain('appSettingsCodexDangerouslyBypassApprovals');

    const codexTab = html.match(
      /<div class="modal-tab-content hidden" id="settings-codex">([\s\S]*?)<\/div>\s*<!-- Models Tab -->/
    );
    expect(codexTab?.[1]).toContain('appSettingsCodexDangerouslyBypassApprovals');
    expect(codexTab?.[1]).not.toContain('appSettingsCodexRenderMode');
  });

  it('passes global Codex settings into quick-start config for new sessions', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'codex-case' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      // Mock responses use the real wire shape: the global preSerialization hook in
      // server.ts wraps route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/codex/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start') return { json: async () => ({ success: true, data: { sessionId: 'sess-1' } }) };
        if (url === '/api/sessions/sess-1')
          return { json: async () => ({ success: true, data: { id: 'sess-1', name: 'w1-codex-case' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({
      codexDangerouslyBypassApprovals: true,
    });
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = vi.fn();
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runCodex();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'codex-case',
      mode: 'codex',
      // tabs follow the w<n>-<case> naming convention (quick-start would otherwise auto-name codeman-<id>)
      sessionName: 'w1-codex-case',
      codexConfig: { dangerouslyBypassApprovals: true, renderMode: 'hybrid' },
    });
    expect(selected).toEqual(['sess-1']);
  });
});

describe('case selector refresh', () => {
  it('sorts case picker options alphabetically and filters by case or host label', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    const cases = [
      { name: 'zeta' },
      { name: 'moneytrove', location: 'remote', remote: { hostId: 'mac-mini', path: '/Users/saqeb/moneytrove' } },
      { name: 'Alpha' },
      { name: 'plex-previews' },
    ];

    const options = app.buildCasePickerOptions(cases);

    expect(options.map((option: any) => option.name)).toEqual([
      'Alpha',
      'moneytrove',
      'plex-previews',
      'testcase',
      'zeta',
    ]);
    expect(options.find((option: any) => option.name === 'moneytrove')?.label).toBe('moneytrove @ mac-mini');
    expect(app.filterCasePickerOptions(options, 'MAC').map((option: any) => option.name)).toEqual(['moneytrove']);
    expect(app.filterCasePickerOptions(options, 'plex').map((option: any) => option.name)).toEqual(['plex-previews']);
  });

  it('labels dockerized cases with a short "(docker)" tag (or the custom host id)', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });
    const app = new (CodemanApp as any)();

    const label = (c: any) => app.formatCasePickerLabel(c);
    // default one-click host, the 'local' Docker-tab default, and per-case override
    // hosts all collapse to the short "(docker)" tag.
    expect(
      label({ name: 'sandbox', location: 'docker', docker: { hostId: 'default', container: 'codeman-case-sandbox' } })
    ).toBe('sandbox (docker)');
    expect(label({ name: 'sandbox', location: 'docker', docker: { hostId: 'local' } })).toBe('sandbox (docker)');
    expect(label({ name: 'sandbox', location: 'docker', docker: { hostId: 'q-sandbox' } })).toBe('sandbox (docker)');
    // a user-named docker host shows its id
    expect(label({ name: 'ml', location: 'docker', docker: { hostId: 'gpu-box' } })).toBe('ml (gpu-box)');
  });

  it('launches the highlighted case with the current run mode when pressing Enter in the picker', () => {
    const elements: Record<string, any> = {};
    const listeners: Record<string, (event: any) => void> = {};
    const CodemanApp = function CodemanApp(this: any) {};

    elements.quickStartCase = {
      value: 'Alpha',
      dataset: {},
    };
    elements.quickStartCaseSearch = {
      value: 'mon',
      dataset: {},
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
        listeners[event] = handler;
      }),
      select: vi.fn(),
    };
    elements.quickStartCaseList = {
      innerHTML: '',
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn(),
    };
    elements.quickStartCasePicker = {
      contains: () => true,
    };

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
        addEventListener: vi.fn(),
      },
      console,
      escapeHtml: (s: string) => s,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.cases = [
      { name: 'Alpha' },
      { name: 'moneytrove', location: 'remote', remote: { hostId: 'mac-mini', path: '/Users/saqeb/moneytrove' } },
      { name: 'zeta' },
    ];
    app.updateDirDisplayForCase = vi.fn();
    app.updateMobileCaseLabel = vi.fn();
    app.saveLastUsedCase = vi.fn();
    app.run = vi.fn(async () => {});

    app.setupQuickStartCasePicker();
    listeners.keydown({ key: 'Enter', preventDefault: vi.fn() });

    expect(elements.quickStartCase.value).toBe('moneytrove');
    expect(app.run).toHaveBeenCalledTimes(1);
  });

  it('creates remote shell sessions by caseName instead of remote display path', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'gpu-work' },
      shellCount: { value: '1' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/cases/gpu-work') {
          return {
            json: async () => ({
              success: true,
              data: {
                name: 'gpu-work',
                path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
                location: 'remote',
                remote: { hostId: 'gpu-box', path: '/home/ubuntu/work' },
              },
            }),
          };
        }
        if (url === '/api/quick-start') {
          return { json: async () => ({ success: true, data: { sessionId: 'sess-1' } }) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.sessions = new Map();
    app.cases = [{ name: 'gpu-work', path: 'ubuntu@10.0.0.42:/home/ubuntu/work', location: 'remote' }];
    app.getTerminalDimensions = () => null;
    app.selectSession = async () => {};

    await app.runShell();

    // Remote cases must ride /api/quick-start (which resolves the remote case and
    // launches over ssh) — POST /api/sessions stat-validates workingDir locally and
    // its schema has no caseName, so the remote display path must never reach it.
    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'gpu-work',
      mode: 'shell',
    });
    expect(requests.find((req) => req.url === '/api/quick-start')?.body).not.toHaveProperty('workingDir');
    expect(requests.some((req) => req.url === '/api/sessions')).toBe(false);
  });

  it('removes a deleted selected case from the dropdown and blurs the native picker', async () => {
    const elements: Record<string, any> = {};
    const requests: Array<{ url: string; method: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};
    const quickStartCase = {
      value: 'deleted-case',
      innerHTML: '<option value="deleted-case">deleted-case</option><option value="kept-case">kept-case</option>',
      dataset: {},
      blur: vi.fn(),
      addEventListener: vi.fn(),
    };

    elements.quickStartCase = quickStartCase;
    elements.caseManageList = { innerHTML: '' };
    elements.mobileCaseName = { textContent: '' };
    elements.dirDisplay = { textContent: '' };
    elements.dirInput = { value: '' };

    const context = vm.createContext({
      CodemanApp,
      MobileDetection: { getDeviceType: () => 'desktop' },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      confirm: () => true,
      fetch: async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/cases/deleted-case')
          return { json: async () => ({ success: true, data: { name: 'deleted-case' } }) };
        // The server's preSerialization hook wraps bare payloads as { success, data },
        // so the frontend reads `.data` off every JSON response — mirror that here.
        if (url === '/api/settings')
          return { ok: true, json: async () => ({ success: true, data: { lastUsedCase: 'deleted-case' } }) };
        if (url === '/api/cases')
          return { json: async () => ({ success: true, data: [{ name: 'kept-case', path: '/tmp/kept-case' }] }) };
        if (url === '/api/cases/kept-case')
          return { json: async () => ({ success: true, data: { path: '/tmp/kept-case' } }) };
        if (url === '/api/settings' && init?.method === 'PUT') return { json: async () => ({ success: true }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
      escapeHtml: (s: string) => s,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.cases = [
      { name: 'deleted-case', path: '/tmp/deleted-case' },
      { name: 'kept-case', path: '/tmp/kept-case' },
    ];
    app.showToast = vi.fn();

    await app.deleteCase('deleted-case');

    expect(quickStartCase.blur).toHaveBeenCalled();
    expect(quickStartCase.innerHTML).not.toContain('deleted-case');
    expect(quickStartCase.innerHTML).toContain('kept-case');
    expect(elements.mobileCaseName.textContent).toBe('kept-case');
    expect(requests).toContainEqual({
      url: '/api/settings',
      method: 'PUT',
      body: { lastUsedCase: 'kept-case' },
    });
  });
});

describe('Gemini quick start', () => {
  // Regression guard for the ApiResponse-envelope unwrap in runGemini(): the
  // status check must read `.data.available` and the quick-start response must
  // read `.data.sessionId`. Reading the raw shape (pre-fix) silently bails on
  // the status check and never selects the new tab — exactly the two blockers
  // caught in PR #134 review.
  it('drives runGemini() through the {success,data} envelope and selects the new session', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'gemini-case' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      // Mock responses use the real wire shape: the server.ts preSerialization
      // hook wraps raw route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/gemini/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start')
          return { json: async () => ({ success: true, data: { sessionId: 'sess-gm' } }) };
        if (url === '/api/sessions/sess-gm')
          return { json: async () => ({ success: true, data: { id: 'sess-gm', name: 'w1-gemini-case' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = vi.fn();
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runGemini();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'gemini-case',
      mode: 'gemini',
      geminiConfig: { approvalMode: 'yolo' },
    });
    expect(selected).toEqual(['sess-gm']);
  });
});

describe('Antigravity quick start', () => {
  // Same envelope-unwrap regression guard as the Gemini block above, for runAntigravity().
  it('drives runAntigravity() through the {success,data} envelope and selects the new session', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'ag-case' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/antigravity/status')
          return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start')
          return { json: async () => ({ success: true, data: { sessionId: 'sess-ag' } }) };
        if (url === '/api/sessions/sess-ag')
          return { json: async () => ({ success: true, data: { id: 'sess-ag', name: 'w1-ag-case' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = vi.fn();
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runAntigravity();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'ag-case',
      mode: 'antigravity',
      antigravityConfig: { dangerouslySkipPermissions: true },
    });
    expect(selected).toEqual(['sess-ag']);
  });
});
