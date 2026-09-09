/**
 * @fileoverview A detached session's pane is sized by its own window, not by
 * the dashboard.
 *
 * One PTY holds one size. When a session is popped out, the dashboard keeps it
 * active and keeps measuring it, but the dashboard's terminal is narrower than
 * the popup because the session rail takes width the popup does not have. Both
 * windows sizing the same pane makes the CLI draw frames that fit neither, and
 * the popup shows the result as a garbled frame.
 *
 * `sendResize` therefore returns early for a session this window has marked
 * detached, and the debounced window-resize handler skips it for the same
 * reason. A solo window is exempt: it IS the owner. `_maybeRefetchFullHistory`
 * already stood aside on the same condition, so this follows a rule the code
 * had already established.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts), the same way terminal-buffer-flush
 * extracts the real mixin methods from terminal-ui.js.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** The mixin runs inside the vm context, so its `fetch` must live there too. */
let currentFetch: ReturnType<typeof vi.fn> = vi.fn();

function loadTerminalMixin(): Record<string, unknown> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1600 },
    document: { addEventListener: vi.fn() },
    fetch: (...args: unknown[]) => currentFetch(...args),
  });
  vm.runInContext(source, context);
  return FakeCodemanApp.prototype;
}

const mixin = loadTerminalMixin();

const SESSION = 'session-A';

function makeApp(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async () => ({ json: async () => ({ data: { changed: true } }) }));
  currentFetch = fetchMock;
  const app = {
    sendResize: mixin.sendResize,
    getTerminalDimensions: () => ({ cols: 120, rows: 40 }),
    fitAddon: { fit: vi.fn() },
    detachedSessions: new Set<string>(),
    isSoloWindow: false,
    _lastResizeDims: null as { cols: number; rows: number } | null,
    _wsReady: false,
    _wsSessionId: null as string | null,
    ...overrides,
  } as Record<string, unknown> & { sendResize: (id: string, o?: object) => Promise<boolean> };
  return { app, fetchMock };
}

describe('detached sessions own their pane size', () => {
  it('the dashboard does not resize a session showing in its own window', async () => {
    const { app, fetchMock } = makeApp();
    (app.detachedSessions as Set<string>).add(SESSION);
    const changed = await app.sendResize(SESSION);

    expect(changed).toBe(false);
    // No measurement and no request: the popup's size stands.
    expect(fetchMock).not.toHaveBeenCalled();
    expect((app.fitAddon as { fit: ReturnType<typeof vi.fn> }).fit).not.toHaveBeenCalled();
  });

  it('the solo window still sizes the session it displays', async () => {
    const { app, fetchMock } = makeApp({ isSoloWindow: true });
    (app.detachedSessions as Set<string>).add(SESSION);
    await app.sendResize(SESSION);

    // The popup is the owner, so being marked detached must not stop it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((app.fitAddon as { fit: ReturnType<typeof vi.fn> }).fit).toHaveBeenCalled();
  });

  it('the dashboard resizes a session that is not detached', async () => {
    const { app, fetchMock } = makeApp();
    await app.sendResize(SESSION);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
