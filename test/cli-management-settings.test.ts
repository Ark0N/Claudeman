/**
 * @fileoverview Tests for the "Installed CLIs" settings-UI surface (App Settings →
 * Agents & CLIs): the dynamic list backed by GET/PUT/POST/DELETE /api/clis(...), added in
 * settings-ui.js. Loads the real module into a vm sandbox (no real DOM) and drives it
 * against a stubbed `document`/`fetch`, matching the pattern in test/run-mode-ui.test.ts.
 *
 * Port: N/A (no server; vm-sandboxed unit tests).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const STOCK_ROW = (overrides: Record<string, unknown> = {}) => ({
  id: 'gemini',
  label: 'Gemini',
  stock: true,
  enabled: true,
  available: true,
  installHint: null,
  ...overrides,
});

function loadHarness(fetchImpl: (url: string, init?: unknown) => Promise<unknown>) {
  const elements: Record<string, any> = {};
  const CodemanApp = function CodemanApp(this: any) {};
  const context: any = vm.createContext({
    CodemanApp,
    MobileDetection: { getDeviceType: () => 'desktop', isTouchDevice: () => false, isHandheldDevice: () => false },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: (tag: string) => {
        const el: any = {
          tagName: tag,
          className: '',
          textContent: '',
          title: '',
          checked: false,
          disabled: false,
          type: '',
          value: '',
          dataset: {},
          onclick: null,
          onchange: null,
          children: [] as any[],
          append(...nodes: any[]) {
            this.children.push(...nodes);
          },
        };
        return el;
      },
    },
    fetch: fetchImpl,
    confirm: () => true,
    console,
  });
  context.window = context;

  const list = { replaceChildren: vi.fn(), textContent: '', appendChild: vi.fn(), children: [] as any[] };
  elements.appSettingsCliList = list;
  elements.appSettingsAddCliStatus = { textContent: '' };
  elements.addCliFormRow = { style: { display: 'none' } };
  elements.appSettingsNewCliId = { value: '' };
  elements.appSettingsNewCliLabel = { value: '' };
  elements.appSettingsNewCliBinary = { value: '' };
  elements.appSettingsNewCliInstall = { value: '' };

  const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });

  const app = new (CodemanApp as any)();
  app.showToast = vi.fn();
  return { app, elements, list };
}

describe('renderCliManagementList', () => {
  it('fetches /api/clis and builds one row per entry', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/clis');
      return { json: async () => ({ success: true, data: [STOCK_ROW(), STOCK_ROW({ id: 'pi', label: 'Pi' })] }) };
    });
    const { app, list } = loadHarness(fetchMock);

    await app.renderCliManagementList();

    expect(fetchMock).toHaveBeenCalledWith('/api/clis');
    expect(list.replaceChildren).toHaveBeenCalledTimes(1);
    expect(list.appendChild).toHaveBeenCalledTimes(2);
  });

  it('shows the install hint for an unavailable CLI, not a generic message', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({
        success: true,
        data: [
          STOCK_ROW({
            id: 'codex',
            label: 'Codex',
            available: false,
            installHint: 'Codex CLI not found. Install with: npm install -g @openai/codex',
          }),
        ],
      }),
    }));
    const { app, list } = loadHarness(fetchMock);

    await app.renderCliManagementList();

    const row = list.appendChild.mock.calls[0][0];
    const desc = row.children
      .find((c: any) => c.className === 'set-row-text')
      .children.find((c: any) => c.className === 'set-row-desc');
    expect(desc.textContent).toContain('npm install -g @openai/codex');
  });

  it('reports a fetch failure inline instead of throwing', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const { app, list } = loadHarness(fetchMock);

    await app.renderCliManagementList();

    expect(list.textContent).toContain('network down');
    expect(list.appendChild).not.toHaveBeenCalled();
  });

  it('does nothing (does not throw) when the container is absent', async () => {
    const { app, elements } = loadHarness(vi.fn());
    delete elements.appSettingsCliList;
    await expect(app.renderCliManagementList()).resolves.toBeUndefined();
  });
});

describe('CLI row actions', () => {
  it('_setCliEnabled PUTs the new state and re-renders', async () => {
    const calls: Array<{ url: string; init?: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (url.endsWith('/enabled')) return { json: async () => ({ success: true }) };
      return { json: async () => ({ success: true, data: [STOCK_ROW({ enabled: false })] }) };
    });
    const { app } = loadHarness(fetchMock);

    await app._setCliEnabled('gemini', false);

    const putCall = calls.find((c) => c.url === '/api/clis/gemini/enabled');
    expect(putCall).toBeDefined();
    expect(putCall!.init.method).toBe('PUT');
    expect(JSON.parse(putCall!.init.body)).toEqual({ enabled: false });
    // Re-render fetched the list again afterward.
    expect(calls.some((c) => c.url === '/api/clis')).toBe(true);
  });

  it('_setCliEnabled surfaces a failure via showToast without throwing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/enabled')) return { json: async () => ({ success: false, error: 'nope' }) };
      return { json: async () => ({ success: true, data: [] }) };
    });
    const { app } = loadHarness(fetchMock);

    await app._setCliEnabled('gemini', false);

    expect(app.showToast).toHaveBeenCalledWith('nope', 'error');
  });

  it('_moveCliOrder swaps the two ids and PUTs the resulting order', async () => {
    const calls: Array<{ url: string; init?: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (url === '/api/clis/order') return { json: async () => ({ success: true }) };
      return { json: async () => ({ success: true, data: [] }) };
    });
    const { app } = loadHarness(fetchMock);
    const list = [STOCK_ROW({ id: 'a' }), STOCK_ROW({ id: 'b' }), STOCK_ROW({ id: 'c' })];

    await app._moveCliOrder(list, 1, -1);

    const orderCall = calls.find((c) => c.url === '/api/clis/order');
    expect(JSON.parse(orderCall!.init.body)).toEqual({ order: ['b', 'a', 'c'] });
  });

  it('_moveCliOrder is a no-op past either edge of the list', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ success: true, data: [] }) }));
    const { app } = loadHarness(fetchMock);
    const list = [STOCK_ROW({ id: 'a' }), STOCK_ROW({ id: 'b' })];

    await app._moveCliOrder(list, 0, -1);
    await app._moveCliOrder(list, 1, 1);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('_removeCustomCli confirms, DELETEs, and re-renders', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'DELETE') return { json: async () => ({ success: true }) };
      return { json: async () => ({ success: true, data: [] }) };
    });
    const { app } = loadHarness(fetchMock);

    await app._removeCustomCli('copilot', 'Copilot');

    expect(calls).toContain('DELETE /api/clis/copilot');
    expect(calls).toContain('GET /api/clis');
  });
});

describe('add-custom-CLI form', () => {
  it('toggleAddCliForm shows the row and clears fields on hide', () => {
    const { app, elements } = loadHarness(vi.fn());
    elements.appSettingsNewCliId.value = 'leftover';

    app.toggleAddCliForm(true);
    expect(elements.addCliFormRow.style.display).toBe('');

    app.toggleAddCliForm(false);
    expect(elements.addCliFormRow.style.display).toBe('none');
    expect(elements.appSettingsNewCliId.value).toBe('');
  });

  it('rejects an id that is not lowercase-kebab without calling fetch', async () => {
    const fetchMock = vi.fn();
    const { app, elements } = loadHarness(fetchMock);
    elements.appSettingsNewCliId.value = 'Not Valid';
    elements.appSettingsNewCliLabel.value = 'Whatever';
    elements.appSettingsNewCliBinary.value = 'whatever';

    await app.submitAddCliForm();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(elements.appSettingsAddCliStatus.textContent).toContain('lowercase');
  });

  it('requires a label and a binary name', async () => {
    const fetchMock = vi.fn();
    const { app, elements } = loadHarness(fetchMock);
    elements.appSettingsNewCliId.value = 'copilot';

    await app.submitAddCliForm();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(elements.appSettingsAddCliStatus.textContent).toContain('required');
  });

  it('POSTs a conservative default entry and closes the form on success', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return { json: async () => ({ success: true }) };
      return { json: async () => ({ success: true, data: [] }) };
    });
    const { app, elements } = loadHarness(fetchMock);
    elements.appSettingsNewCliId.value = 'copilot';
    elements.appSettingsNewCliLabel.value = 'GitHub Copilot';
    elements.appSettingsNewCliBinary.value = 'copilot';
    elements.appSettingsNewCliInstall.value = 'npm install -g copilot-cli';

    await app.submitAddCliForm();

    const postCall = calls.find((c) => c.url === '/api/clis/copilot');
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.init.body);
    expect(body.label).toBe('GitHub Copilot');
    expect(body.discovery.binaries).toEqual(['copilot']);
    expect(body.discovery.install.command.linux).toBe('npm install -g copilot-cli');
    // Conservative defaults — see submitAddCliForm's own doc comment: same profile as
    // an unrecognized CLI (external agent, no bypass, no hooks, buffered echo).
    expect(body.capabilities.external).toBe(true);
    expect(body.capabilities.requiresMux).toBe(true);
    expect(body.capabilities.hooks).toBe(false);
    expect(body.capabilities.privilegedParams).toEqual([]);
    expect(body.enabled).toBe(true);
    // Form was closed (re-hidden) after success.
    expect(elements.addCliFormRow.style.display).toBe('none');
  });

  it('leaves the form open and shows the server error on failure', async () => {
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST') return { json: async () => ({ success: false, error: 'id already exists' }) };
      return { json: async () => ({ success: true, data: [] }) };
    });
    const { app, elements } = loadHarness(fetchMock);
    elements.appSettingsNewCliId.value = 'copilot';
    elements.appSettingsNewCliLabel.value = 'GitHub Copilot';
    elements.appSettingsNewCliBinary.value = 'copilot';
    elements.addCliFormRow.style.display = '';

    await app.submitAddCliForm();

    expect(elements.appSettingsAddCliStatus.textContent).toBe('id already exists');
    expect(elements.addCliFormRow.style.display).toBe(''); // still open
  });
});
