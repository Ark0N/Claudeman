/**
 * Reusable async test helpers.
 */

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

/** Wait for an EventEmitter to emit a specific event, with timeout */
export function waitForEvent(
  emitter: { once: (event: string, listener: (...args: unknown[]) => void) => void },
  event: string,
  timeoutMs = 5000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`)),
      timeoutMs
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/** Create a deferred promise with external resolve/reject */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Delete a directory tree, but ONLY when it lives inside the test HOME.
 *
 * SAFETY (2026-08-29): `test/setup.ts` redirects `process.env.HOME` to a
 * throwaway dir and `os.homedir()` follows it, so a `rmSync(CASES_DIR,
 * recursive)` normally lands inside the fixture. This gate is defense in depth
 * for the day that stops being true (a test that runs outside setup.ts, an
 * env override that anchors a path elsewhere): it refuses to delete anything
 * not under the redirected `process.env.HOME`, so the failure mode is a
 * leftover temp dir rather than a deleted PRODUCTION `~/codeman-cases`.
 * Lexical `resolve()` is used because the leaf often does not exist and
 * `realpathSync` would throw.
 */
export function safeRmHomeTree(path: string): void {
  const home = process.env.HOME;
  if (!home) return;
  const target = resolve(path);
  const root = resolve(home);
  if (target === root || target.startsWith(root + '/')) {
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * True when `path` resolves strictly inside `process.env.HOME` (or to it).
 * Same rationale as `safeRmHomeTree`; use for guarded non-recursive deletes
 * (single files like `linked-cases.json`) so they can never touch prod state.
 */
export function isUnderTestHome(path: string): boolean {
  const home = process.env.HOME;
  if (!home) return false;
  const target = resolve(path);
  const root = resolve(home);
  return target === root || target.startsWith(root + '/');
}
