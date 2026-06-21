/**
 * @fileoverview COD-143 — resuming a session from the Session Manager must retain its
 * original tab name, not synthesize a fresh `w<N>-<dir>` name every time.
 *
 * Root cause: `resumeHistorySession(sessionId, workingDir)` ignored the row's `name` and
 * always built `w<N>-<dir>` from the working dir. The fix threads the name through and
 * extracts the choice into a pure `_resolveResumeName(existingName, workingDir)` helper:
 * prefer a non-empty existing name; otherwise generate the next free `w<N>-<dir>` by
 * scanning open sessions' names.
 *
 * This pins the helper's contract:
 *   1. a non-empty existing name is returned verbatim (custom name retained),
 *   2. a missing/empty/whitespace name falls back to `w<N>-<dir>`,
 *   3. the generated number is the next free w-index across `this.sessions`,
 *   4. the generated dir segment is the basename of workingDir (or `session` when empty).
 *
 * Loaded via `vm` against a stub `CodemanApp` (no jsdom — same harness as
 * file-browser-reveal.test.ts / connection-indicator.test.ts). terminal-ui.js does
 * `Object.assign(CodemanApp.prototype, {...})` at module-eval, so we capture the real
 * `_resolveResumeName` off the prototype and invoke it against a minimal host whose
 * `sessions` is a Map.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Eval the shipping terminal-ui.js into a vm with a stub CodemanApp, return its prototype. */
function loadTerminalUiPrototype(): Record<string, (...args: unknown[]) => unknown> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Record<string, (...args: unknown[]) => unknown> }).__proto;
}

const proto = loadTerminalUiPrototype();

/** Minimal host carrying the real `_resolveResumeName` + a sessions Map. */
function makeApp(sessionNames: string[] = []) {
  const sessions = new Map<string, { name: string }>();
  sessionNames.forEach((name, i) => sessions.set(`s${i}`, { name }));
  return {
    sessions,
    _resolveResumeName: proto._resolveResumeName as (existingName: unknown, workingDir: unknown) => string,
  };
}

describe('COD-143 _resolveResumeName', () => {
  it('returns a non-empty existing name verbatim (custom name retained)', () => {
    const app = makeApp(['w1-foo', 'w2-bar']);
    expect(app._resolveResumeName.call(app, 'my-custom-tab', '/home/me/proj')).toBe('my-custom-tab');
  });

  it('falls back to w<N>-<dir> when no name is given', () => {
    const app = makeApp([]);
    expect(app._resolveResumeName.call(app, undefined, '/home/me/proj')).toBe('w1-proj');
  });

  it('treats empty / whitespace names as no-name (falls back)', () => {
    const app = makeApp([]);
    expect(app._resolveResumeName.call(app, '', '/a/b/widgets')).toBe('w1-widgets');
    expect(app._resolveResumeName.call(app, '   ', '/a/b/widgets')).toBe('w1-widgets');
  });

  it('generated w-number is the next free index across open sessions', () => {
    const app = makeApp(['w1-foo', 'w3-bar', 'plain-name']);
    // highest w<N> is 3 → next is 4
    expect(app._resolveResumeName.call(app, null, '/x/y/svc')).toBe('w4-svc');
  });

  it('uses "session" as the dir segment when workingDir is empty', () => {
    const app = makeApp([]);
    expect(app._resolveResumeName.call(app, '', '')).toBe('w1-session');
  });

  it('does not let a generated fallback clobber an explicit name even when sessions exist', () => {
    const app = makeApp(['w1-foo', 'w2-bar']);
    expect(app._resolveResumeName.call(app, 'keepme', '/p/q')).toBe('keepme');
  });
});
