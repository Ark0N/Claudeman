/**
 * @fileoverview Response-viewer turn segmentation (`CodemanApp._buildResponseViewerMessage`).
 *
 * The server now emits one message per model message instead of concatenating a
 * human turn's replies into one card, so a long autonomous run arrives as tens
 * of messages rather than one 12,000-character block. Rendered naively that is
 * card spam — the measured distribution is p50 3 messages per turn, p90 11,
 * max 51, with 58% of messages under 80 characters. So consecutive messages
 * from one speaker inside one `turn` render as SEGMENTS of one card: no
 * repeated role badge, a hairline seam.
 *
 * Pinned here because the badge suppression is the only thing standing between
 * the server change and a wall of 51 "Claude" badges:
 *
 *  1. A continuation carries `rv-msg-cont` and has NO `.rv-role` child, while
 *     keeping its role class so the CSS accent survives (the colour rules match
 *     on both `:has(.rv-role-*)` and `.rv-msg-*` — only the class arm hits here).
 *  2. A queued prompt is marked in the DOM, not in text, so the i18n
 *     MutationObserver cannot rewrite the marker.
 *  3. The 4th argument is genuinely optional: the brief view's 3-argument call
 *     still renders a badge.
 *
 * Loaded via `vm` with a jsdom document injected (same technique as
 * response-viewer-file-links.test.ts).
 * Port: N/A
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const { document, NodeFilter } = dom.window;

interface MessageBuilder {
  _buildResponseViewerMessage(text: string, role: string, agentLabel: string, meta?: unknown): HTMLElement;
  loadFullContext(): Promise<void>;
  activeSessionId?: string;
}

function loadCodemanAppClass() {
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
    fetch: vi.fn(),
    document,
    NodeFilter,
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  // The context is returned too: app.js closes over the context's own `fetch`, so a
  // test that drives loadFullContext has to replace THAT binding, not globalThis'.
  return { CodemanApp: (context as { __CodemanApp: { prototype: MessageBuilder } }).__CodemanApp, context };
}

const { CodemanApp, context: appContext } = loadCodemanAppClass();

function build(text: string, role: string, meta?: unknown): HTMLElement {
  const app = Object.create(CodemanApp.prototype) as MessageBuilder;
  return app._buildResponseViewerMessage(text, role, 'Claude', meta);
}

describe('response viewer turn segmentation', () => {
  it('renders a continuation without a repeated role badge but keeps its role class', () => {
    const div = build('second half of the same turn', 'assistant', { continuation: true, kind: 'response', turn: 3 });

    expect(div.classList.contains('rv-msg-cont')).toBe(true);
    expect(div.classList.contains('rv-msg-assistant')).toBe(true);
    expect(div.querySelector('.rv-role')).toBeNull();
    expect(div.querySelector('.rv-text')).not.toBeNull();
    expect(div.dataset.kind).toBe('response');
  });

  it('marks a prompt the user queued mid-turn in the DOM, not in the text', () => {
    const div = build('actually use PowerShell', 'user', {
      continuation: false,
      kind: 'prompt',
      queued: true,
      turn: 2,
    });

    expect(div.dataset.queued).toBe('1');
    expect(div.dataset.kind).toBe('prompt');
    const badge = div.querySelector('.rv-role');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('rv-role-user')).toBe(true);
    // The marker is a CSS pseudo-element, so the badge text stays translatable.
    expect(badge!.textContent).toBe('You');
  });

  it('still renders a badge for the brief view, which passes no meta', () => {
    const div = build('the last response', 'assistant');

    expect(div.classList.contains('rv-msg-cont')).toBe(false);
    expect(div.querySelector('.rv-role')!.textContent).toBe('Claude');
    expect(div.dataset.kind).toBeUndefined();
    expect(div.dataset.queued).toBeUndefined();
  });
});

/**
 * The empty-state branch deliberately does NOT wipe the body — the brief view has
 * a terminal-buffer fallback this endpoint does not — and deliberately leaves the
 * More button live so a transcript that appears a moment later can still be
 * loaded. Both together mean the notice must be idempotent: without that, every
 * retry stacks another identical line. Upstream got this for free because it
 * assigned `body.textContent`.
 */
describe('response viewer empty full-context state', () => {
  it('reuses one notice across repeated More clicks and keeps the brief card', async () => {
    const body = document.createElement('div');
    body.id = 'responseViewerBody';
    const title = document.createElement('div');
    title.id = 'responseViewerTitle';
    const more = document.createElement('button');
    more.id = 'responseViewerMore';
    document.body.append(body, title, more);
    body.textContent = 'No response yet — send a message in this session first.';

    const app = Object.create(CodemanApp.prototype) as MessageBuilder;
    app.activeSessionId = 's1';
    (appContext as { fetch: unknown }).fetch = vi.fn(async () => ({
      json: async () => ({ data: { messages: [] } }),
    }));

    await app.loadFullContext();
    await app.loadFullContext();
    await app.loadFullContext();

    expect(body.querySelectorAll('.rv-notice')).toHaveLength(1);
    expect(body.textContent).toContain('No response yet');
    // More stays clickable: it is the only retry path once a transcript lands.
    expect(more.style.display).toBe('');

    document.body.innerHTML = '';
  });
});
