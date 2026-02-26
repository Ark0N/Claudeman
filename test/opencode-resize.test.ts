/**
 * OpenCode session UI tests
 *
 * Tests OpenCode-specific UI behavior:
 * - Initial terminal resize (not stuck at 120x40)
 * - Close modal shows "Kill Tmux & OpenCode" (not "Claude Code")
 * - needsRefresh handler sends resize
 *
 * Port: 3211 (opencode UI tests)
 *
 * Run: npx vitest run test/opencode-resize.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3211;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { context, page };
}

async function navigateAndWait(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 5000,
  });
}

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

describe('OpenCode session initial resize', () => {
  let context: BrowserContext;
  let page: Page;

  afterAll(async () => {
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
      return data.id ?? data.session?.id;
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

    console.log(`[opencode-resize] resize sent: ${lastResize.cols}x${lastResize.rows}`);

    // Cleanup
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
      return data.id ?? data.session?.id;
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

  it('needsRefresh handler includes sendResize call', async () => {
    // The needsRefresh handler is registered inside a closure (connectSSE),
    // so we can't directly invoke it from tests. Instead, verify that the
    // handler source code dispatched to the EventSource includes sendResize.
    // This is a structural test — if the handler code changes, this test
    // ensures the resize call is preserved.
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Dispatch a needsRefresh event on the EventSource and intercept
    // the resulting resize API call
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'oc-refresh-test' }),
      });
      const data = await res.json();
      return data.id ?? data.session?.id;
    });

    expect(sessionId).toBeTruthy();

    // Select the session first so activeSessionId is set
    await page.evaluate(async (sid: string) => {
      const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
      await app.selectSession(sid);
    }, sessionId);

    await page.waitForTimeout(300);

    // Intercept resize calls
    const resizeCalls: Array<{ url: string }> = [];
    await page.route('**/api/sessions/*/resize', async (route) => {
      resizeCalls.push({ url: route.request().url() });
      await route.continue();
    });

    // Dispatch the needsRefresh event directly on the EventSource
    // (this is how the server sends SSE events — as named events)
    await page.evaluate((sid: string) => {
      const app = (window as unknown as { app: { eventSource: EventSource } }).app;
      if (app.eventSource) {
        const event = new MessageEvent('session:needsRefresh', {
          data: JSON.stringify({ id: sid }),
        });
        app.eventSource.dispatchEvent(event);
      }
    }, sessionId);

    // Wait for the async handler (fetches /terminal buffer + sends resize)
    await page.waitForTimeout(1500);

    // Verify resize was called
    expect(resizeCalls.length).toBeGreaterThanOrEqual(1);
    console.log(`[opencode-resize] needsRefresh triggered ${resizeCalls.length} resize call(s)`);

    // Cleanup
    await page.route('**/api/sessions/*/resize', (route) => route.continue());
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });
});

describe('OpenCode close modal text', () => {
  let context: BrowserContext;
  let page: Page;

  afterAll(async () => {
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
      return data.id ?? data.session?.id;
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
      return data.id ?? data.session?.id;
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
