/** Real-browser responsive layout coverage for Session Options. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');

function sessionOptionsMarkup() {
  const start = html.indexOf('<div class="modal" id="sessionOptionsModal">');
  const end = html.indexOf('<!-- Close Session Confirmation Modal -->', start);
  if (start < 0 || end < 0) throw new Error('Session Options markup not found');
  return html.slice(start, end);
}

describe('Session Options responsive layout in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => browser.close());

  async function renderAt(width: number) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`<!doctype html><html><head><style>${styles}</style>
      <style>@media (max-width: 1023px) { ${mobileStyles} }</style></head>
      <body>${sessionOptionsMarkup()}</body></html>`);
    await page.evaluate(() => {
      document.getElementById('sessionOptionsModal')!.classList.add('active');
      document
        .querySelectorAll('#sessionOptionsModal .set-section')
        .forEach((section) => section.classList.add('hidden'));
      document.getElementById('context-tab')!.classList.remove('hidden');
    });
  }

  async function metrics() {
    return page.evaluate(() => {
      const modal = document.querySelector<HTMLElement>('#sessionOptionsModal .modal-content')!;
      const doc = document.getElementById('sessionOptionsDoc')!;
      const panel = document.getElementById('context-tab')!;
      const header = panel.querySelector<HTMLElement>(':scope > .set-section-head')!;
      const blurb = panel.querySelector<HTMLElement>(':scope > .set-section-blurb')!;
      return {
        modalWidth: modal.getBoundingClientRect().width,
        docFits: doc.scrollWidth === doc.clientWidth,
        panelFits: panel.scrollWidth === panel.clientWidth,
        tracks: getComputedStyle(panel).gridTemplateColumns.split(' '),
        headerGridColumn: getComputedStyle(header).gridColumn,
        blurbGridColumn: getComputedStyle(blurb).gridColumn,
      };
    });
  }

  it('uses one fitting column at the tablet-width desktop viewport', async () => {
    await renderAt(974);
    expect(await metrics()).toMatchObject({ docFits: true, panelFits: true, tracks: [expect.any(String)] });
  });

  it('uses two fitting columns with a full-width introduction on wide screens', async () => {
    await renderAt(1440);
    const layout = await metrics();
    expect(layout.modalWidth).toBeGreaterThan(1000);
    expect(layout.tracks).toHaveLength(2);
    expect(layout.headerGridColumn).toBe('1 / -1');
    expect(layout.blurbGridColumn).toBe('1 / -1');
    expect(layout.docFits).toBe(true);
    expect(layout.panelFits).toBe(true);
  });
});
