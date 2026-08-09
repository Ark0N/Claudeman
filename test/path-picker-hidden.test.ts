/**
 * @fileoverview PathPicker "show hidden" toggle (issue #221).
 *
 * `PathPicker` (keyboard-accessory.js) is the shared browser behind Link
 * Existing's "Browse" and the mobile keyboard's `📁 Path` key, so one toggle
 * serves both. What can silently go wrong here:
 *
 *   1. `showHidden` missing from the browse request (toggle looks dead),
 *   2. `showHidden` missing from the PREVIEW request, which re-resolves the
 *      path independently, so the listing would show a hidden file that then
 *      403s the moment you tap it,
 *   3. the toggle resetting you to the root instead of reloading where you are,
 *   4. the flag not surviving a reopen, or a `localStorage` throw taking the
 *      picker down with it.
 *
 * The picker builds its dialog with innerHTML and drives it through real
 * listeners, so this needs a DOM rather than a `vm` stub. It runs in the DEFAULT
 * node environment and constructs a jsdom window here, matching
 * markdown-sanitizer.test.ts: a per-file jsdom environment directive
 * externalizes node:fs under vite and the suite then fails to load. ⚠️ Do not
 * write that directive's literal name anywhere in this file, not even in prose
 * like this: vitest scans the whole source for it, so merely explaining the trap
 * re-arms it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const accessoryJs = readFileSync(resolve(PUBLIC, 'keyboard-accessory.js'), 'utf8');
const stylesCss = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');

const STORAGE_KEY = 'codeman:pathPickerShowHidden';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://localhost/' });
const jsdomWindow = dom.window as unknown as Window & typeof globalThis;
const jsdomDocument = jsdomWindow.document;

/** Evaluate keyboard-accessory.js against the jsdom window and return PathPicker. */
function loadPathPicker(fetchImpl: (url: string) => Promise<unknown>): any {
  const MobileDetection = { isTouchDevice: () => false };
  const factory = new Function(
    'window',
    'document',
    'localStorage',
    'fetch',
    'MobileDetection',
    `${accessoryJs}\nreturn PathPicker;`
  );
  return factory(jsdomWindow, jsdomDocument, jsdomWindow.localStorage, fetchImpl, MobileDetection);
}

function browseResponse(entries: Array<{ name: string; type: string }>, path = '/home/dev/project') {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: {
        path,
        parent: null,
        root: '/home/dev',
        roots: [{ label: 'Home', path: '/home/dev' }],
        entries: entries.map((e) => ({ ...e, path: `${path}/${e.name}` })),
        truncated: false,
      },
    }),
  };
}

describe('PathPicker show-hidden toggle', () => {
  let PathPicker: any;
  let urls: string[];
  let respond: (url: string) => unknown;

  beforeEach(() => {
    jsdomWindow.localStorage.clear();
    jsdomDocument.body.replaceChildren();
    urls = [];
    respond = () =>
      browseResponse([
        { name: '.github', type: 'directory' },
        { name: 'src', type: 'directory' },
      ]);
    PathPicker = loadPathPicker(async (url: string) => {
      urls.push(url);
      return respond(url);
    });
  });

  afterEach(() => {
    PathPicker?.close?.(false);
    jsdomDocument.body.replaceChildren();
  });

  const open = async (options: Record<string, unknown> = {}) => {
    PathPicker.open({ onSelect: () => {}, ...options });
    await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
  };
  const toggle = () => jsdomDocument.querySelector('.path-picker-hidden') as HTMLButtonElement;
  const previewHref = () =>
    (jsdomDocument.querySelector('.path-preview-open') as HTMLAnchorElement).getAttribute('href') ?? '';

  it('omits showHidden by default', async () => {
    await open();

    expect(urls[0]).not.toContain('showHidden');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().classList.contains('active')).toBe(false);
    expect(toggle().getAttribute('title')).toBe('Show hidden files and folders');
  });

  it('sends showHidden=true after the toggle is pressed, and persists it', async () => {
    await open();
    toggle().click();
    await vi.waitFor(() => expect(urls.length).toBe(2));

    expect(urls[1]).toContain('showHidden=true');
    expect(jsdomWindow.localStorage.getItem(STORAGE_KEY)).toBe('1');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().classList.contains('active')).toBe(true);
    expect(toggle().getAttribute('title')).toBe('Hide hidden files and folders');
  });

  it('restores the preference when the picker is reopened', async () => {
    jsdomWindow.localStorage.setItem(STORAGE_KEY, '1');
    await open();

    expect(urls[0]).toContain('showHidden=true');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('reloads the current folder rather than resetting to the root', async () => {
    jsdomWindow.localStorage.setItem(STORAGE_KEY, '1');
    // Sitting inside a hidden folder, reachable only because the toggle is on.
    respond = () => browseResponse([{ name: 'workflows', type: 'directory' }], '/home/dev/project/.github');
    await open({ initialPath: '/home/dev/project/.github' });

    toggle().click();
    await vi.waitFor(() => expect(urls.length).toBe(2));

    expect(decodeURIComponent(urls[1])).toContain('path=/home/dev/project/.github');
    expect(urls[1]).not.toContain('showHidden=true');
  });

  it('carries the flag into the preview request', async () => {
    jsdomWindow.localStorage.setItem(STORAGE_KEY, '1');
    await open();

    PathPicker.openPreview({ name: '.gitignore', path: '/home/dev/project/.gitignore', previewKind: 'text' });

    expect(previewHref()).toContain('showHidden=true');
  });

  it('leaves the preview flag off when the toggle is off', async () => {
    await open();

    PathPicker.openPreview({ name: 'notes.txt', path: '/home/dev/project/notes.txt', previewKind: 'text' });

    expect(previewHref()).not.toContain('showHidden');
  });

  it('survives a localStorage that throws (private browsing)', async () => {
    const storage = Object.getPrototypeOf(jsdomWindow.localStorage);
    const getItem = vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      await open();
      expect(urls[0]).not.toContain('showHidden');

      toggle().click();
      await vi.waitFor(() => expect(urls.length).toBe(2));
      expect(urls[1]).toContain('showHidden=true');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('styles the active toggle so it reads as on', () => {
    expect(stylesCss).toContain('.path-picker-hidden.active');
  });
});
