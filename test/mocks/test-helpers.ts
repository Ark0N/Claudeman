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
 * throwaway dir, but code that resolves paths via `os.homedir()` does NOT
 * follow that redirect on every Linux build/Node version — some read
 * /etc/passwd instead of $HOME. A test that `rmSync(CASES_DIR, recursive)` can
 * therefore delete the PRODUCTION `~/codeman-cases` (or any home-anchored
 * tree) on those platforms. This gate refuses to delete anything not under the
 * (redirected) `process.env.HOME`. Lexical `resolve()` is used because the leaf
 * often does not exist and `realpathSync` would throw.
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
 * (single files like `linked-cases.json`) so they never touch prod state on
 * platforms where `os.homedir()` ignores `$HOME`.
 */
export function isUnderTestHome(path: string): boolean {
  const home = process.env.HOME;
  if (!home) return false;
  const target = resolve(path);
  const root = resolve(home);
  return target === root || target.startsWith(root + '/');
}
