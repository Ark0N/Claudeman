/**
 * Terminal viewport ownership and OpenCode UI browser tests
 *
 * Tests shared terminal sizing plus OpenCode-specific UI behavior:
 * - Initial session resize (not stuck at 120x40)
 * - Desktop tab, pointer, and focus sizing takeover
 * - Close modal shows "Kill Tmux & OpenCode" (not "Claude Code")
 * - needsRefresh handler sends resize
 *
 * Port: 3211 (terminal viewport UI tests)
 *
 * Run: npm test -- test/terminal-viewport-resize.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { WebServer } from '../src/web/server.js';

const PORT = 3211;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;
let dataDir: string;
let previousDataDir: string | undefined;

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { context, page };
}

async function navigateAndWait(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}?nowebgl`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 5000,
  });
}

beforeAll(async () => {
  previousDataDir = process.env.CODEMAN_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), 'codeman-viewport-test-'));
  process.env.CODEMAN_DATA_DIR = dataDir;
  const { WebServer } = await import('../src/web/server.js');
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  try {
    await browser?.close();
    await server?.stop();
  } finally {
    if (previousDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);

describe('Session initialization and viewport resize', () => {
  let context: BrowserContext;
  let page: Page;

  afterEach(async () => {
    await context?.close();
  });

  it('selectSession is not bypassed when runOpenCode sets activeSessionId', async () => {
    // This test verifies at the code level that runOpenCode does NOT
    // pre-set activeSessionId before calling selectSession.
    // If it did, selectSession would early-return and skip sendResize.
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Read the runOpenCode source from the live app and verify
    // it doesn't assign activeSessionId before selectSession
    const hasPreAssignment = await page.evaluate(() => {
      const app = (window as unknown as { app: { runOpenCode: { toString: () => string } } }).app;
      const source = app.runOpenCode.toString();

      // Check: the source should NOT have activeSessionId = ... before selectSession
      // Find positions of both patterns
      const assignIdx = source.indexOf('this.activeSessionId = data.sessionId');
      const selectIdx = source.indexOf('this.selectSession(data.sessionId)');

      // If assign doesn't exist at all, that's the correct fix
      if (assignIdx === -1) return false;

      // If assign comes before select, that's the bug
      return assignIdx < selectIdx;
    });

    expect(hasPreAssignment).toBe(false);
  });

  it('sends resize to server after creating a session via quick-start', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Intercept resize API calls to track when they happen
    const resizeCalls: Array<{ url: string; cols: number; rows: number }> = [];
    await page.route('**/api/sessions/*/resize', async (route) => {
      const request = route.request();
      const body = request.postDataJSON();
      resizeCalls.push({
        url: request.url(),
        cols: body.cols,
        rows: body.rows,
      });
      // Let the request through to the server
      await route.continue();
    });

    // Create a session via API (simulating what quick-start does)
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'oc-resize-test' }),
      });
      const data = await res.json();
      return data.data?.session?.id ?? data.data?.id ?? data.session?.id ?? data.id;
    });

    expect(sessionId).toBeTruthy();

    // Call selectSession (which is what runOpenCode does after fix)
    await page.evaluate(async (sid: string) => {
      const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
      await app.selectSession(sid);
    }, sessionId);

    // Wait for the resize to be sent (it's fire-and-forget in selectSession)
    await page.waitForTimeout(500);

    // Verify resize was called with reasonable dimensions (not 120x40 default)
    expect(resizeCalls.length).toBeGreaterThanOrEqual(1);
    const lastResize = resizeCalls[resizeCalls.length - 1];
    expect(lastResize.url).toContain(sessionId);
    // Browser viewport is 1280x800 — terminal cols/rows should be substantially
    // different from the hardcoded 120x40 default. xterm.js calculates these
    // from container dimensions and cell size, but in headless mode with a
    // 1280x800 viewport, we should get something reasonable (>= 40 cols).
    expect(lastResize.cols).toBeGreaterThanOrEqual(40);
    expect(lastResize.rows).toBeGreaterThanOrEqual(10);

    console.log(`[terminal-viewport-resize] resize sent: ${lastResize.cols}x${lastResize.rows}`);

    // Cleanup
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('forces the full desktop PTY size when a session tab is reactivated', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    const resizeCalls: Array<{
      viewportType?: string;
      force?: boolean;
      takeControl?: boolean;
    }> = [];
    await page.route('**/api/sessions/*/resize', async (route) => {
      resizeCalls.push(route.request().postDataJSON());
      await route.continue();
    });

    const created = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'desktop-reactivation-test' }),
      });
      const data = await res.json();
      return {
        sessionId: data.data?.session?.id ?? data.data?.id ?? data.session?.id ?? data.id,
        response: data,
      };
    });
    expect(created.sessionId, JSON.stringify(created.response)).toBeTruthy();
    const sessionId = created.sessionId;

    await page.evaluate(async (sid: string) => {
      const app = (
        window as unknown as {
          app: { selectSession: (id: string, options: { forceReload: boolean }) => Promise<void> };
        }
      ).app;
      await app.selectSession(sid, { forceReload: true });
    }, sessionId);

    await page.waitForTimeout(500);
    expect(resizeCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewportType: 'desktop',
          force: true,
          takeControl: true,
        }),
      ])
    );

    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('reclaims the full desktop PTY size over its live WebSocket on an ordinary page click', async () => {
    ({ context, page } = await freshPage());
    const resizeFrames: Array<Record<string, unknown>> = [];
    page.on('websocket', (socket) => {
      socket.on('framesent', (event) => {
        try {
          const frame = JSON.parse(String(event.payload)) as Record<string, unknown>;
          if (frame.t === 'z') resizeFrames.push(frame);
        } catch {
          // Ignore non-JSON frames.
        }
      });
    });
    await navigateAndWait(page);

    const created = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'desktop-click-resize-test' }),
      });
      const data = await res.json();
      return {
        sessionId: data.data?.session?.id ?? data.data?.id ?? data.session?.id ?? data.id,
        response: data,
      };
    });
    expect(created.sessionId, JSON.stringify(created.response)).toBeTruthy();
    const sessionId = created.sessionId;

    await page.evaluate(async (sid: string) => {
      const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
      await app.selectSession(sid);
    }, sessionId);

    await page.waitForFunction((sid: string) => {
      const app = (
        window as unknown as {
          app: { _wsReady: boolean; _wsSessionId: string | null };
        }
      ).app;
      return app._wsReady && app._wsSessionId === sid;
    }, sessionId);
    resizeFrames.length = 0;
    await page.locator('#terminalContainer').click({ position: { x: 40, y: 40 } });
    await vi.waitFor(() => {
      expect(resizeFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            t: 'z',
            v: 'desktop',
            a: true,
            f: true,
          }),
        ])
      );
    });

    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('reclaims the full desktop PTY size when the desktop page regains focus', async () => {
    ({ context, page } = await freshPage());
    const resizeFrames: Array<Record<string, unknown>> = [];
    page.on('websocket', (socket) => {
      socket.on('framesent', (event) => {
        try {
          const frame = JSON.parse(String(event.payload)) as Record<string, unknown>;
          if (frame.t === 'z') resizeFrames.push(frame);
        } catch {
          // Ignore non-JSON frames.
        }
      });
    });
    await navigateAndWait(page);

    const created = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'desktop-focus-resize-test' }),
      });
      const data = await res.json();
      return {
        sessionId: data.data?.session?.id ?? data.data?.id ?? data.session?.id ?? data.id,
        response: data,
      };
    });
    expect(created.sessionId, JSON.stringify(created.response)).toBeTruthy();
    const sessionId = created.sessionId;

    await page.evaluate(async (sid: string) => {
      const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
      await app.selectSession(sid);
    }, sessionId);
    await page.waitForFunction((sid: string) => {
      const app = (
        window as unknown as {
          app: { _wsReady: boolean; _wsSessionId: string | null };
        }
      ).app;
      return app._wsReady && app._wsSessionId === sid;
    }, sessionId);

    resizeFrames.length = 0;

    await page.evaluate(() => {
      window.dispatchEvent(new FocusEvent('focus'));
    });
    await vi.waitFor(() => {
      expect(resizeFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            t: 'z',
            v: 'desktop',
            a: true,
          }),
        ])
      );
    });
    const focusFrame = resizeFrames.find((frame) => frame.t === 'z' && frame.a === true);
    expect(focusFrame).not.toHaveProperty('f');

    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('selectSession does NOT early-return for a new session', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Create a session
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'oc-earlyret-test' }),
      });
      const data = await res.json();
      return data.data?.session?.id ?? data.data?.id ?? data.session?.id ?? data.id;
    });

    expect(sessionId).toBeTruthy();

    // Verify activeSessionId is NOT the new session before selectSession
    const activeBeforeSelect = await page.evaluate(() => {
      const app = (window as unknown as { app: { activeSessionId: string | null } }).app;
      return app.activeSessionId;
    });

    // activeSessionId should be null or empty (welcome screen) — not our session
    expect(activeBeforeSelect).not.toBe(sessionId);

    // Now call selectSession and verify it actually runs (sets activeSessionId)
    await page.evaluate(async (sid: string) => {
      const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
      await app.selectSession(sid);
    }, sessionId);

    const activeAfterSelect = await page.evaluate(() => {
      const app = (window as unknown as { app: { activeSessionId: string | null } }).app;
      return app.activeSessionId;
    });

    expect(activeAfterSelect).toBe(sessionId);

    // Cleanup
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('restores a recent busy session from its snapshot and streamed delta without refetching', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    const terminalRequests: string[] = [];
    await page.route('**/api/sessions/*/terminal*', async (route) => {
      const url = new URL(route.request().url());
      const sessionId = url.pathname.split('/')[3];
      terminalRequests.push(sessionId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            terminalBuffer: `${sessionId} initial history\r\n${sessionId} prompt`,
            truncated: false,
          },
        }),
      });
    });

    await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            sessions: Map<string, object>;
            sessionOrder: string[];
            renderSessionTabs: () => void;
            selectSession: (id: string) => Promise<void>;
            _onSessionTerminal: (data: { id: string; data: string }) => void;
          };
        }
      ).app;
      app.sessions.set('warm-a', {
        id: 'warm-a',
        name: 'Warm A',
        mode: 'codex',
        status: 'working',
        pid: 1,
        workingDir: '/tmp',
      });
      app.sessions.set('warm-b', {
        id: 'warm-b',
        name: 'Warm B',
        mode: 'codex',
        status: 'working',
        pid: 1,
        workingDir: '/tmp',
      });
      app.sessionOrder = ['warm-a', 'warm-b'];
      app.renderSessionTabs();

      await app.selectSession('warm-a');
      await app.selectSession('warm-b');
      app._onSessionTerminal({ id: 'warm-a', data: '\r\nwarm-a streamed while away\r\n' });
    });

    const requestsBeforeReturn = terminalRequests.length;
    const restored = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            selectSession: (id: string) => Promise<void>;
            terminal: {
              buffer: {
                active: {
                  length: number;
                  getLine: (index: number) => { translateToString: (trimRight: boolean) => string } | undefined;
                };
              };
            };
            _warmTerminalCache: { ids: () => string[] };
            _terminalSseSubscriptionIds: () => string[];
            _wsReady: boolean;
            _wsSessionId: string | null;
          };
        }
      ).app;
      await app.selectSession('warm-a');
      const buffer = app.terminal.buffer.active;
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index++) {
        lines.push(buffer.getLine(index)?.translateToString(true) || '');
      }
      const previousWsReady = app._wsReady;
      const previousWsSessionId = app._wsSessionId;
      app._wsReady = true;
      app._wsSessionId = 'warm-a';
      const sseIdsWithActiveWs = app._terminalSseSubscriptionIds();
      app._wsReady = previousWsReady;
      app._wsSessionId = previousWsSessionId;
      return {
        text: lines.join('\n'),
        warmIds: app._warmTerminalCache.ids(),
        sseIdsWithActiveWs,
      };
    });

    expect(terminalRequests).toHaveLength(requestsBeforeReturn);
    expect(terminalRequests).toEqual(['warm-a', 'warm-a', 'warm-b', 'warm-b']);
    expect(restored.text).toContain('warm-a initial history');
    expect(restored.text).toContain('warm-a streamed while away');
    expect(restored.warmIds).toEqual(expect.arrayContaining(['warm-a', 'warm-b']));
    // The desired SSE filter keeps both sessions. The server suppresses warm-a
    // while its WebSocket owns output and resumes it atomically on handoff.
    expect(restored.sseIdsWithActiveWs).toEqual(expect.arrayContaining(['warm-a', 'warm-b']));
  });

  it('needsRefresh handler sends resize after restoring buffered output', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    const sessionId = 'needs-refresh-test';
    const resizeCalls = await page.evaluate(async (sid: string) => {
      const app = (
        window as unknown as {
          app: {
            activeSessionId: string | null;
            _isLoadingBuffer: boolean;
            _onSessionNeedsRefresh: () => Promise<void>;
            chunkedTerminalWrite: (data: string) => Promise<void>;
            sendResize: (sessionId: string, options?: object) => Promise<boolean>;
          };
        }
      ).app;
      const originalFetch = window.fetch;
      const originalChunkedTerminalWrite = app.chunkedTerminalWrite;
      const originalSendResize = app.sendResize.bind(app);
      const calls: string[] = [];

      app.activeSessionId = sid;
      app._isLoadingBuffer = false;
      app.chunkedTerminalWrite = async () => {};
      app.sendResize = async (targetSessionId: string) => {
        calls.push(targetSessionId);
        return true;
      };
      window.fetch = async (input, init) => {
        if (String(input).includes(`/api/sessions/${sid}/terminal`)) {
          return new Response(JSON.stringify({ data: { terminalBuffer: 'restored terminal output' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(input, init);
      };

      try {
        await app._onSessionNeedsRefresh();
        return calls;
      } finally {
        window.fetch = originalFetch;
        app.chunkedTerminalWrite = originalChunkedTerminalWrite;
        app.sendResize = originalSendResize;
      }
    }, sessionId);

    expect(resizeCalls).toEqual([sessionId]);
    console.log(`[terminal-viewport-resize] needsRefresh triggered ${resizeCalls.length} resize call(s)`);
  });

  it('cold-loads bounded history and preserves the reader anchor when prepending a page', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    const result = await page.evaluate(async () => {
      const app = (window as unknown as { app: any }).app;
      const sessionId = 'paged-history-browser-test';
      const originalFetch = window.fetch;
      const originalSendResize = app.sendResize;
      const originalConnectWs = app._connectWs;
      const requested: string[] = [];
      const latestFrame = '\x1b[1;1HLATEST PAGED FRAME' + '\x1b[2;1H› current prompt' + '\x1b[2;17H';
      const rows = (prefix: string, start: number, end: number) =>
        Array.from({ length: end - start }, (_, offset) => `${prefix}_${String(start + offset).padStart(4, '0')}`).join(
          '\r\n'
        );
      const recentPage = rows('RECENT', 800, 1200);
      const olderPage = rows('OLDER', 400, 800);
      const streamHeaders = (body: string, extra: Record<string, string> = {}): Record<string, string> => ({
        'content-type': 'text/plain; charset=utf-8',
        'x-codeman-terminal-format': 'stream-v1',
        'x-codeman-terminal-stream': 'paged-browser-stream',
        'x-codeman-terminal-generation': '1',
        'x-codeman-terminal-start': '0',
        'x-codeman-terminal-end': String(body.length),
        'x-codeman-terminal-status': 'idle',
        'x-codeman-terminal-full-size': String(body.length),
        'x-codeman-terminal-truncated': '0',
        'x-codeman-terminal-source': 'mux-history-page',
        ...extra,
      });
      const pageHeaders = (body: string, start: number, end: number): Record<string, string> =>
        streamHeaders(body, {
          'x-codeman-history-start': String(start),
          'x-codeman-history-end': String(end),
          'x-codeman-history-total': '1200',
          'x-codeman-history-more-before': start > 0 ? '1' : '0',
          'x-codeman-history-more-after': end < 1200 ? '1' : '0',
          'x-codeman-history-origin': 'stable-browser-origin',
        });
      const visibleText = () => {
        const buffer = app.terminal.buffer.active;
        return Array.from(
          { length: app.terminal.rows },
          (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || ''
        ).join('\n');
      };

      try {
        app.sessions.set(sessionId, {
          id: sessionId,
          name: 'Paged browser history',
          mode: 'codex',
          status: 'idle',
          pid: 1,
          workingDir: '/tmp',
        });
        app.sessionOrder = [sessionId];
        app.activeSessionId = null;
        app.terminalBufferCache.delete(sessionId);
        app._xtermSnapshots.delete(sessionId);
        app._warmTerminalCache.remove(sessionId);
        app._terminalHistoryPaging.delete(sessionId);
        app.renderSessionTabs();

        app.sendResize = async () => false;
        app._connectWs = () => {};
        window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (!url.includes(`/api/sessions/${sessionId}/terminal`)) {
            return originalFetch.call(window, input, init);
          }
          requested.push(url);
          if (url.includes('latest=1')) {
            return new Response(latestFrame, {
              status: 200,
              headers: streamHeaders(latestFrame, {
                'x-codeman-terminal-source': 'mux-visible',
              }),
            });
          }
          if (url.includes('before=800')) {
            return new Response(olderPage, {
              status: 200,
              headers: pageHeaders(olderPage, 400, 800),
            });
          }
          return new Response(recentPage, {
            status: 200,
            headers: pageHeaders(recentPage, 800, 1200),
          });
        }) as typeof window.fetch;

        await app.selectSession(sessionId);
        const initialState = app._terminalHistoryPaging.get(sessionId);
        const initialStart = initialState.start;
        initialState.loading = true;
        const buffer = app.terminal.buffer.active;
        let markerRow = -1;
        for (let row = 0; row < buffer.length; row++) {
          if (buffer.getLine(row)?.translateToString(true).includes('RECENT_0800')) {
            markerRow = row;
            break;
          }
        }
        if (markerRow >= 0) app.terminal.scrollToLine(markerRow);
        await new Promise<void>((resolve) => app.terminal.write('', resolve));
        const beforeText = visibleText();
        initialState.loading = false;

        const loaded = await app._loadTerminalHistoryPage('older');
        const afterState = app._terminalHistoryPaging.get(sessionId);
        const afterText = visibleText();
        app.terminal.scrollToBottom();
        const latestText = visibleText();

        return {
          loaded,
          requested,
          initialStart,
          markerRow,
          afterStart: afterState.start,
          afterEnd: afterState.end,
          pageCount: afterState.pages.length,
          beforeText,
          afterText,
          latestText,
        };
      } finally {
        window.fetch = originalFetch;
        app.sendResize = originalSendResize;
        app._connectWs = originalConnectWs;
        app.sessions.delete(sessionId);
        app._terminalHistoryPaging.delete(sessionId);
      }
    });

    expect(result.loaded).toBe(true);
    expect(result.requested.some((url: string) => url.includes('historyPage=1'))).toBe(true);
    expect(result.requested.every((url: string) => !url.includes('full=1'))).toBe(true);
    expect(result.initialStart).toBe(800);
    expect(result.markerRow).toBeGreaterThanOrEqual(0);
    expect(result.afterStart).toBe(400);
    expect(result.afterEnd).toBe(1200);
    expect(result.pageCount).toBe(2);
    expect(result.beforeText).toContain('RECENT_0800');
    expect(result.afterText).toContain('RECENT_0800');
    expect(result.latestText).toContain('LATEST PAGED FRAME');
  });
});

describe('OpenCode close modal text', () => {
  let context: BrowserContext;
  let page: Page;

  afterEach(async () => {
    await context?.close();
  });

  it('shows "Kill Tmux & OpenCode" for opencode sessions', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Create a session and mark it as opencode mode
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'oc-close-test', mode: 'opencode' }),
      });
      const data = await res.json();
      return data.data?.session?.id ?? data.data?.id ?? data.session?.id ?? data.id;
    });

    expect(sessionId).toBeTruthy();

    // Wait for SSE to propagate the session
    await page.waitForTimeout(500);

    // Open the close confirmation modal
    await page.evaluate((sid: string) => {
      const app = (window as unknown as { app: { requestCloseSession: (id: string) => void } }).app;
      app.requestCloseSession(sid);
    }, sessionId);

    // Check the kill button text
    const killTitle = await page.locator('#closeConfirmKillTitle').textContent();
    expect(killTitle).toBe('Kill Tmux & OpenCode');

    // Close the modal
    await page.evaluate(() => {
      const app = (window as unknown as { app: { cancelCloseSession: () => void } }).app;
      app.cancelCloseSession();
    });

    // Cleanup
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('shows "Kill Tmux & Claude Code" for claude sessions', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Create a standard claude session
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'cc-close-test' }),
      });
      const data = await res.json();
      return data.data?.session?.id ?? data.data?.id ?? data.session?.id ?? data.id;
    });

    expect(sessionId).toBeTruthy();

    await page.waitForTimeout(500);

    // Open the close confirmation modal
    await page.evaluate((sid: string) => {
      const app = (window as unknown as { app: { requestCloseSession: (id: string) => void } }).app;
      app.requestCloseSession(sid);
    }, sessionId);

    // Check the kill button text
    const killTitle = await page.locator('#closeConfirmKillTitle').textContent();
    expect(killTitle).toBe('Kill Tmux & Claude Code');

    // Close the modal
    await page.evaluate(() => {
      const app = (window as unknown as { app: { cancelCloseSession: () => void } }).app;
      app.cancelCloseSession();
    });

    // Cleanup
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });
});
