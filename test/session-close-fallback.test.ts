/**
 * @fileoverview Closing the session you are looking at moves you to the next
 * tab, deterministically.
 *
 * `closeSession()` and the `session_deleted` SSE handler both react to the same
 * delete, and the broadcast routinely lands while the DELETE request is still in
 * flight. Both used to read `this.activeSessionId` and act on it, so whichever
 * won decided what the user saw: the SSE handler nulls the field and shows the
 * welcome screen, which then made closeSession's own "select the next tab"
 * branch a no-op. Closing a tab therefore either switched sessions or dumped you
 * on the home screen, on the same build, depending on timing (measured
 * 2026-08-17 while testing the idle-alert gate).
 *
 * The fix is one owner per outcome: closeSession captures `wasActive` BEFORE the
 * await and announces the delete through `_closingSessions`, and the SSE handler
 * leaves the active-session handoff alone for a close this tab started. A delete
 * from anywhere else still lands on the welcome screen.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), like input-send-order.test.ts.
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadCodemanAppClass() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const constants = readFileSync(resolve(dir, 'constants.js'), 'utf8');
  const source = readFileSync(resolve(dir, 'app.js'), 'utf8');
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();
const A = 'session-a';
const B = 'session-b';

type TestApp = Record<string, unknown> & {
  closeSession: (id: string, killMux?: boolean) => Promise<void>;
  _onSessionDeleted: (data: { id: string }) => void;
  selectSession: ReturnType<typeof vi.fn>;
  showWelcome: ReturnType<typeof vi.fn>;
  activeSessionId: string | null;
  sessionOrder: string[];
  sessions: Map<string, unknown>;
};

/** Instance with the session bookkeeping real and everything visual stubbed. */
function makeApp(active: string | null, order = [A, B]): TestApp {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as TestApp;
  app.activeSessionId = active;
  app.sessionOrder = [...order];
  app.sessions = new Map(order.map((id) => [id, { id }]));
  app._closingSessions = new Set();
  app.detachedSessions = new Set();
  app.isSoloWindow = false;
  app._wsSessionId = null;
  app.terminal = { clear: vi.fn() };
  app._apiDelete = vi.fn(async () => ({ success: true }));
  // The real one touches ~20 maps; the parts this behavior depends on are the
  // session map and the tab order, so those are pruned for real.
  app._cleanupSessionData = vi.fn((id: string) => {
    app.sessions.delete(id);
    const i = app.sessionOrder.indexOf(id);
    if (i !== -1) app.sessionOrder.splice(i, 1);
  });
  app.selectSession = vi.fn();
  app.showWelcome = vi.fn();
  app.renderSessionTabs = vi.fn();
  app.renderRalphStatePanel = vi.fn();
  app.renderProjectInsightsPanel = vi.fn();
  app.stopSystemStatsPolling = vi.fn();
  app.showToast = vi.fn();
  app._disconnectWs = vi.fn();
  app._redock = vi.fn();
  return app;
}

describe('closing the active session', () => {
  it('moves to the next tab when the SSE broadcast arrives DURING the delete', async () => {
    const app = makeApp(A);
    // The losing order that used to strand the user: the broadcast for this very
    // delete lands before the request resolves.
    app._apiDelete = vi.fn(async () => {
      app._onSessionDeleted({ id: A });
      return { success: true };
    });

    await app.closeSession(A);

    expect(app.selectSession).toHaveBeenCalledWith(B, { auto: true });
    expect(app.showWelcome).not.toHaveBeenCalled();
  });

  it('moves to the next tab when the broadcast arrives AFTER the delete', async () => {
    const app = makeApp(A);

    await app.closeSession(A);
    expect(app.selectSession).toHaveBeenCalledWith(B, { auto: true });

    // The late broadcast must not bounce the user off the tab they just landed on.
    app.activeSessionId = B;
    app._onSessionDeleted({ id: A });
    expect(app.showWelcome).not.toHaveBeenCalled();
    expect(app.activeSessionId).toBe(B);
  });

  it('skips ids the cleanup has not caught up with', async () => {
    const app = makeApp(A, [A, 'ghost', B]);
    app.sessions.delete('ghost'); // in the order, already gone from the session map

    await app.closeSession(A);

    expect(app.selectSession).toHaveBeenCalledWith(B, { auto: true });
  });

  it('falls back to the welcome screen when nothing is left', async () => {
    const app = makeApp(A, [A]);

    await app.closeSession(A);

    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.showWelcome).toHaveBeenCalled();
  });

  it('closing a session you are NOT on changes nothing on screen', async () => {
    const app = makeApp(B, [A, B]);

    await app.closeSession(A);

    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.showWelcome).not.toHaveBeenCalled();
    expect(app.activeSessionId).toBe(B);
  });

  it('a delete from ANOTHER client still shows the welcome screen', () => {
    // Nobody here initiated it, so there is no follow-up selection to own: the
    // honest answer is that what you were looking at is gone.
    const app = makeApp(A);

    app._onSessionDeleted({ id: A });

    expect(app.activeSessionId).toBeNull();
    expect(app.showWelcome).toHaveBeenCalled();
  });

  it('stops tracking the close once it finishes, even when the delete throws', async () => {
    const app = makeApp(A);
    app._apiDelete = vi.fn(async () => {
      throw new Error('network');
    });

    await app.closeSession(A);

    expect((app._closingSessions as Set<string>).size).toBe(0);
    expect(app.showToast).toHaveBeenCalledWith('Failed to close session', 'error');
  });
});
