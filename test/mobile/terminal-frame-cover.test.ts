// Port 3219 - Stable terminal frame coverage during mobile keyboard resize.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import type { WebServer } from '../src/web/server.js';

const PORT = 3219;
const BASE_URL = `http://localhost:${PORT}`;

describe('mobile terminal frame cover', () => {
  let server: WebServer;
  let page: Page;
  let closePage: () => Promise<void>;

  beforeAll(async () => {
    server = await createTestServer(PORT);
    const result = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL, 'chromium');
    page = result.page;
    closePage = () => result.context.close();
  });

  afterAll(async () => {
    await closePage?.();
    await stopTestServer(server);
    await closeAllBrowsers();
  });

  it('keeps the old frame opaque and inert until xterm paints the replacement', async () => {
    await page.evaluate(() => {
      app.activeSessionId = 'frame-cover-test';
      app.sessions.set('frame-cover-test', { id: 'frame-cover-test', mode: 'codex' });
      app.terminal.write('\x1b[2J\x1b[HOLD STABLE FRAME');
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );
    await page.evaluate(() => {
      KeyboardHandler._beginTerminalFrameCover({ arm: true });
      app.batchTerminalWrite('\x1b[2J\x1b[HNEW DESTINATION FRAME');
    });

    const cover = page.locator('.terminal-resize-frame-cover');
    await expect.poll(() => cover.count()).toBe(1);
    await expect.poll(() => cover.textContent()).toContain('OLD STABLE FRAME');
    expect(await cover.textContent()).not.toContain('NEW DESTINATION FRAME');
    expect(await cover.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    expect(await cover.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');

    await expect.poll(() => cover.count(), { timeout: 3000 }).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const buffer = app.terminal.buffer.active;
          return Array.from({ length: app.terminal.rows }, (_, row) =>
            buffer.getLine(buffer.viewportY + row)?.translateToString(true)
          ).join('\n');
        })
      )
      .toContain('NEW DESTINATION FRAME');
  });
});
