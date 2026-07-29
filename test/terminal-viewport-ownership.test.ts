/**
 * @fileoverview Browser coverage for shared terminal viewport ownership.
 *
 * Port: 3213
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { WebServer } from '../src/web/server.js';

const PORT = 3213;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;
let context: BrowserContext | undefined;
let dataDir: string;
let previousDataDir: string | undefined;

async function freshPage(): Promise<Page> {
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  return context.newPage();
}

async function navigateAndWait(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 5000,
  });
}

async function createSession(page: Page, name: string): Promise<string> {
  const created = await page.evaluate(async (sessionName: string) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: sessionName }),
    });
    const body = await response.json();
    return {
      id: body.data?.session?.id ?? body.data?.id ?? body.session?.id ?? body.id,
      body,
    };
  }, name);
  expect(created.id, JSON.stringify(created.body)).toBeTruthy();
  return created.id;
}

async function deleteSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  }, sessionId);
}

async function selectSession(page: Page, sessionId: string, forceReload = false): Promise<void> {
  await page.evaluate(
    async ({ id, force }: { id: string; force: boolean }) => {
      const app = (
        window as unknown as {
          app: { selectSession: (target: string, options?: { forceReload: boolean }) => Promise<void> };
        }
      ).app;
      await app.selectSession(id, force ? { forceReload: true } : undefined);
    },
    { id: sessionId, force: forceReload }
  );
}

async function waitForSessionSocket(page: Page, sessionId: string): Promise<void> {
  await page.waitForFunction((id: string) => {
    const app = (
      window as unknown as {
        app: { _wsReady: boolean; _wsSessionId: string | null };
      }
    ).app;
    return app._wsReady && app._wsSessionId === id;
  }, sessionId);
}

beforeAll(async () => {
  previousDataDir = process.env.CODEMAN_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), 'codeman-viewport-test-'));
  process.env.CODEMAN_DATA_DIR = dataDir;
  const { WebServer } = await import('../src/web/server.js');
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterEach(async () => {
  await context?.close();
  context = undefined;
});

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

describe('terminal viewport ownership', () => {
  it('forces the full desktop PTY size when a session tab is reactivated', async () => {
    const page = await freshPage();
    await navigateAndWait(page);
    const resizeCalls: Array<{ viewportType?: string; force?: boolean; takeControl?: boolean }> = [];
    await page.route('**/api/sessions/*/resize', async (route) => {
      resizeCalls.push(route.request().postDataJSON());
      await route.continue();
    });
    const sessionId = await createSession(page, 'desktop-reactivation-test');

    try {
      await selectSession(page, sessionId, true);
      await expect
        .poll(() =>
          resizeCalls.some(
            (call) => call.viewportType === 'desktop' && call.force === true && call.takeControl === true
          )
        )
        .toBe(true);
    } finally {
      await deleteSession(page, sessionId);
    }
  });

  it('reclaims desktop sizing over the live WebSocket on a terminal click', async () => {
    const page = await freshPage();
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
    const sessionId = await createSession(page, 'desktop-click-resize-test');

    try {
      await selectSession(page, sessionId);
      await waitForSessionSocket(page, sessionId);
      resizeFrames.length = 0;
      await page.locator('#terminalContainer').click({ position: { x: 40, y: 40 } });
      await vi.waitFor(() => {
        expect(resizeFrames).toEqual(
          expect.arrayContaining([expect.objectContaining({ t: 'z', v: 'desktop', a: true, f: true })])
        );
      });
    } finally {
      await deleteSession(page, sessionId);
    }
  });

  it('reclaims desktop sizing when the page regains focus', async () => {
    const page = await freshPage();
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
    const sessionId = await createSession(page, 'desktop-focus-resize-test');

    try {
      await selectSession(page, sessionId);
      await waitForSessionSocket(page, sessionId);
      resizeFrames.length = 0;
      await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
      await vi.waitFor(() => {
        expect(resizeFrames).toEqual(
          expect.arrayContaining([expect.objectContaining({ t: 'z', v: 'desktop', a: true })])
        );
      });
      const focusFrame = resizeFrames.find((frame) => frame.t === 'z' && frame.a === true);
      expect(focusFrame).not.toHaveProperty('f');
    } finally {
      await deleteSession(page, sessionId);
    }
  });
});
