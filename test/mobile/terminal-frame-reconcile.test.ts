// Port 3220 - Authoritative mobile terminal-frame reconciliation.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import type { WebServer } from '../src/web/server.js';

const PORT = 3220;
const BASE_URL = `http://localhost:${PORT}`;

async function visibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const buffer = app.terminal.buffer.active;
    return Array.from({ length: app.terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true)
    ).join('\n');
  });
}

describe('mobile terminal-frame reconciliation', () => {
  let server: WebServer;
  let page: Page;
  let context: BrowserContext;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await stopTestServer(server);
    await closeAllBrowsers();
  });

  beforeEach(async () => {
    const result = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL, 'chromium');
    page = result.page;
    context = result.context;
  });

  afterEach(async () => {
    await context.close();
  });

  it('captures the latest pane even when local dimensions are unchanged', async () => {
    await page.evaluate(() => {
      const sessionId = 'frame-reconcile-resize';
      app.activeSessionId = sessionId;
      app.sessions.set(sessionId, { id: sessionId, mode: 'codex' });
      app.hideWelcome();
      window.__frameRequests = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes(`/api/sessions/${sessionId}/terminal?latest=1`)) {
          window.__frameRequests.push(url);
          return new Response('AUTHORITATIVE RESIZE FRAME', {
            status: 200,
            headers: {
              'x-codeman-terminal-format': 'stream-v1',
              'x-codeman-terminal-stream': 'stream-a',
              'x-codeman-terminal-generation': '1',
              'x-codeman-terminal-start': '0',
              'x-codeman-terminal-end': '5',
              'x-codeman-terminal-source': 'mux-visible',
            },
          });
        }
        return originalFetch(input, init);
      };
      app.sendResize = async () => false;
      const history = Array.from(
        { length: app.terminal.rows + 8 },
        (_, index) => `HISTORY ${String(index).padStart(3, '0')}\r\n`
      ).join('');
      app.terminal.write(`\x1b[2J\x1b[H${history}OLD RESIZE FRAME`);
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );

    await page.evaluate(async () => {
      KeyboardHandler._beginTerminalFrameCover({ arm: true });
      const reconcile = KeyboardHandler._sendTerminalResize();
      app.batchTerminalWrite('STALE', {
        stream: 'stream-a',
        generation: 1,
        start: 0,
        end: 5,
      });
      await reconcile;
    });

    await expect.poll(() => page.locator('.terminal-resize-frame-cover').count()).toBe(0);
    const state = await page.evaluate(() => {
      const buffer = app.terminal.buffer.active;
      const all = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true)).join(
        '\n'
      );
      return {
        all,
        requests: window.__frameRequests,
      };
    });
    const visible = await visibleTerminalText(page);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toContain('latest=1&tail=131072&format=stream');
    expect(visible).toContain('AUTHORITATIVE RESIZE FRAME');
    expect(visible).not.toContain('STALE');
    expect(state.all).toContain('HISTORY 000');
  });

  it('reconciles a visible dialogue after sending the selected input exactly once', async () => {
    await page.evaluate(() => {
      const sessionId = 'frame-reconcile-dialogue';
      app.activeSessionId = sessionId;
      app.sessions.set(sessionId, { id: sessionId, mode: 'codex' });
      app.hideWelcome();
      window.__sentDialogueInputs = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes(`/api/sessions/${sessionId}/terminal?latest=1`)) {
          return new Response('DIALOGUE RESOLVED FRAME', {
            status: 200,
            headers: {
              'x-codeman-terminal-format': 'stream-v1',
              'x-codeman-terminal-stream': 'dialogue-stream',
              'x-codeman-terminal-generation': '1',
              'x-codeman-terminal-start': '0',
              'x-codeman-terminal-end': '0',
              'x-codeman-terminal-source': 'mux-visible',
            },
          });
        }
        return originalFetch(input, init);
      };
      app._reliableSend = (_sessionId, input) => {
        window.__sentDialogueInputs.push(input);
      };
      app.terminal.write('\x1b[2J\x1b[HApprove deployment?\r\n\u203a 1. Yes\r\n  2. No\r\nPress enter to select');
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );

    const immediate = await page.evaluate(() => {
      const detected = app._shouldReconcileTerminalAction('frame-reconcile-dialogue', '\r');
      app._sendInputAsync('frame-reconcile-dialogue', '\r');
      return {
        detected,
        loading: app._isLoadingBuffer,
        sent: [...window.__sentDialogueInputs],
      };
    });
    expect(immediate).toEqual({ detected: true, loading: true, sent: ['\r'] });

    await page.evaluate(() => app._terminalFrameReconcilePromise);
    await expect.poll(() => page.locator('.terminal-resize-frame-cover').count()).toBe(0);
    const visible = await visibleTerminalText(page);
    expect(visible).toContain('DIALOGUE RESOLVED FRAME');
    expect(visible).not.toContain('Approve deployment?');
    expect(await page.evaluate(() => window.__sentDialogueInputs)).toEqual(['\r']);
  });

  it('covers the first meaningful keyboard-close growth before the hidden threshold', async () => {
    await page.evaluate(() => {
      const sessionId = 'frame-reconcile-close';
      app.activeSessionId = sessionId;
      app.sessions.set(sessionId, { id: sessionId, mode: 'codex' });
      app.hideWelcome();
      app._requestTerminalFrameReconcile = async () => false;
      app.terminal.write('\x1b[2J\x1b[HSTABLE KEYBOARD FRAME');
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );

    const state = await page.evaluate(() => {
      KeyboardHandler.keyboardVisible = true;
      KeyboardHandler._terminalInputRequested = true;
      KeyboardHandler.initialViewportHeight = 800;
      KeyboardHandler.lastViewportHeight = 400;
      KeyboardHandler._keyboardOpenMinHeight = 400;
      KeyboardHandler._keyboardClosing = false;
      Object.defineProperty(window.visualViewport, 'height', {
        configurable: true,
        value: 460,
      });
      KeyboardHandler.handleViewportResize();
      const cover = app.terminal.element?.querySelector('.terminal-resize-frame-cover');
      return {
        keyboardVisible: KeyboardHandler.keyboardVisible,
        keyboardClosing: KeyboardHandler._keyboardClosing,
        coverText: cover?.textContent || '',
      };
    });

    expect(state.keyboardVisible).toBe(true);
    expect(state.keyboardClosing).toBe(true);
    expect(state.coverText).toContain('STABLE KEYBOARD FRAME');
  });
});
