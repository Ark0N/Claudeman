/**
 * @fileoverview Issue #273 and its mirror image: abbreviating `$HOME` in path labels.
 *
 * The rule ("show `~/project` rather than `/home/<user>/project`") had three
 * implementations in the frontend, and two of them were platform-specific in
 * opposite directions, so each looked correct to whoever wrote it:
 *
 *   - the Run menu's Recent Sessions rows matched `/home/<user>/` only, so on
 *     macOS nothing was stripped, every row spent its first ~19 characters on an
 *     identical `/Users/<user>/` prefix, and the left-to-right ellipsis removed
 *     the tail that identifies the row (#273),
 *   - the case-manage list matched `/Users/<user>` only, so on a Linux host no
 *     case path was ever abbreviated at all.
 *
 * Both now call `_shortenHomePath()`, which is pinned here for both layouts, and
 * a static guard fails if a fourth copy of the pattern appears.
 *
 * Loaded via `vm` against a stub CodemanApp with a fake DOM, same harness as
 * history-list-controls.test.ts. Port: none (no browser, no server).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

/**
 * The container the vm's `document.getElementById` resolves for the case list.
 * Swapped per test: the closure lives in THIS realm, so the shipping code inside
 * the vm reads whatever the current test installed.
 */
let currentCaseList: { innerHTML: string } | null = null;

function loadTerminalUiPrototype(): Record<string, any> {
  const source = readFileSync(resolve(PUBLIC, 'terminal-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: () => null, createElement: () => ({}) },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as unknown as { __proto: Record<string, any> }).__proto;
}

function loadSessionUiPrototype(): Record<string, any> {
  const source = readFileSync(resolve(PUBLIC, 'session-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    VoiceInput: {},
    escapeHtml: (t: unknown) => String(t ?? ''),
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: (id: string) => (id === 'caseManageList' ? currentCaseList : null) },
    window: { addEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as unknown as { __proto: Record<string, any> }).__proto;
}

const terminalProto = loadTerminalUiPrototype();
const sessionProto = loadSessionUiPrototype();
const shorten = (p: unknown) => terminalProto._shortenHomePath.call(terminalProto, p);

describe('_shortenHomePath', () => {
  it('abbreviates the Linux home prefix', () => {
    expect(shorten('/home/arkon/default/claudeman')).toBe('~/default/claudeman');
  });

  it('abbreviates the macOS home prefix, which the Run menu never did (#273)', () => {
    expect(shorten('/Users/jordanryan/code/facet/facet-agency-ops')).toBe('~/code/facet/facet-agency-ops');
  });

  it('abbreviates the home directory itself, not only paths below it', () => {
    // The case-manage list's old regex had no trailing slash and did collapse
    // this to "~"; keep that, or a case whose path IS $HOME would regress.
    expect(shorten('/home/arkon')).toBe('~');
    expect(shorten('/Users/jordanryan')).toBe('~');
  });

  it('leaves paths that only look like a home prefix alone', () => {
    expect(shorten('/homer/bob/x')).toBe('/homer/bob/x');
    expect(shorten('/Userspace/bob/x')).toBe('/Userspace/bob/x');
    expect(shorten('/home')).toBe('/home');
    expect(shorten('/mnt/d/work')).toBe('/mnt/d/work');
    expect(shorten('/opt/codeman')).toBe('/opt/codeman');
  });

  it('replaces only the leading occurrence', () => {
    expect(shorten('/home/arkon/home/bob/x')).toBe('~/home/bob/x');
  });

  it('tolerates empty and missing input', () => {
    expect(shorten('')).toBe('');
    expect(shorten(undefined)).toBe('');
    expect(shorten(null)).toBe('');
  });
});

describe('renderCaseManageList path labels', () => {
  function render(cases: Array<{ name: string; path: string; location?: string }>): string {
    currentCaseList = { innerHTML: '' };
    const app: any = {
      cases,
      _shortenHomePath: terminalProto._shortenHomePath,
      renderCaseManageList: sessionProto.renderCaseManageList,
    };
    app.renderCaseManageList();
    const html = currentCaseList.innerHTML;
    currentCaseList = null;
    return html;
  }

  it('abbreviates a Linux case path (the mirror of #273)', () => {
    const html = render([{ name: 'demo', path: '/home/arkon/codeman-cases/demo' }]);
    expect(html).toContain('~/codeman-cases/demo');
    expect(html).not.toContain('/home/arkon/codeman-cases/demo');
  });

  it('still abbreviates a macOS case path', () => {
    const html = render([{ name: 'demo', path: '/Users/jordanryan/codeman-cases/demo' }]);
    expect(html).toContain('~/codeman-cases/demo');
    expect(html).not.toContain('/Users/jordanryan/codeman-cases/demo');
  });

  it('renders the row when a case has no path at all', () => {
    const html = render([{ name: 'demo', path: '' }]);
    expect(html).toContain('demo');
    expect(html).toContain('class="case-manage-path"');
  });
});

describe('single implementation of the home-prefix rule', () => {
  /** Every top-level frontend module (vendor/ and subdirs are not ours). */
  const sources = readdirSync(PUBLIC)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, text: readFileSync(resolve(PUBLIC, name), 'utf8') }));

  it('has exactly one home-prefix regex, in terminal-ui.js', () => {
    // Any regex literal anchored at a home root. Three of these had drifted
    // apart; a fourth would drift the same way.
    const pattern = /\/\^\\\/(?:\(\?:home\|Users\)|home|Users)\\\//g;
    const hits = sources.flatMap(({ name, text }) => (text.match(pattern) ?? []).map(() => name));
    expect(hits).toEqual(['terminal-ui.js']);
  });

  it('routes both session-ui path labels through the helper', () => {
    // Deliberately counts calls rather than pinning source lines: the Run menu
    // row is being restructured in #274, and this guard should survive that as
    // long as the label still goes through the helper.
    const sessionUi = sources.find((s) => s.name === 'session-ui.js')!.text;
    const calls = sessionUi.match(/this\._shortenHomePath\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
