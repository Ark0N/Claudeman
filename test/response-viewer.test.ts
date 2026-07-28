/**
 * @fileoverview Response viewer source-selection regressions.
 *
 * The "Last Response" action must never substitute the complete terminal
 * scrollback when a structured transcript lookup is temporarily unavailable.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((name) => values.add(name)),
    remove: (...names: string[]) => names.forEach((name) => values.delete(name)),
    contains: (name: string) => values.has(name),
  };
}

function loadCodemanAppClass(elements: Record<string, Record<string, unknown>>) {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
    document: {
      addEventListener: vi.fn(),
      getElementById: (id: string) => elements[id] ?? null,
    },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

describe('Last Response viewer', () => {
  it('does not replace an empty transcript response with the full terminal history', async () => {
    const elements = {
      responseViewer: { classList: fakeClassList() },
      responseViewerBackdrop: { classList: fakeClassList() },
      responseViewerBody: { textContent: '', innerHTML: '', scrollTop: 0 },
      responseViewerTitle: { textContent: '' },
      responseViewerMore: { style: { display: '' }, textContent: '' },
    };
    const CodemanApp = loadCodemanAppClass(elements);
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as {
      activeSessionId: string;
      sessions: Map<string, { mode: string }>;
      toggleResponseViewer: () => Promise<void>;
    };
    app.activeSessionId = 'claude-session';
    app.sessions = new Map([['claude-session', { mode: 'claude' }]]);

    const fetchMock = vi.fn(async () => ({
      json: async () => ({ success: true, data: { text: '', timestamp: '' } }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await app.toggleResponseViewer();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/claude-session/last-response');
    expect(elements.responseViewerBody.textContent).toContain('No response yet');
    expect(elements.responseViewerTitle.textContent).toBe('Last Response');
  });
});
