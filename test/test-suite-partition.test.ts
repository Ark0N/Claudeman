/**
 * @fileoverview The test runners must PARTITION the repo: every test file
 * reachable by exactly one command, no file reachable by none.
 *
 * `npm test` deliberately skips three suites (browser, mobile, perf) because
 * they cannot pass on an arbitrary machine. The failure mode that creates is
 * silent: exclude a file from the gate, forget to add it to a runner, and it is
 * now tested by nothing — with every command still green, because vitest treats
 * "no files matched" as success. That is not hypothetical; the exclusion list
 * lived as literals in one config for its whole life, and nothing pointed the
 * other way.
 *
 * So the globs live in config/test-suites.ts, every config derives from them,
 * and this file checks the arithmetic actually works out on the files on disk.
 */

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_TEST_GLOBS, MOBILE_TEST_GLOBS, NON_CI_TEST_GLOBS, PERF_TEST_GLOBS } from '../config/test-suites';

const ROOT = resolve(import.meta.dirname, '..');

/** Every `*.test.ts` under test/, repo-relative, POSIX separators. */
function allTestFiles(dir = 'test'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...allTestFiles(rel));
    else if (entry.name.endsWith('.test.ts')) out.push(rel);
  }
  return out.sort();
}

/**
 * Matches the three glob shapes test-suites.ts actually uses, and THROWS on
 * anything else rather than quietly returning false — a glob this cannot read
 * would otherwise make the partition below pass by mis-classifying it.
 */
function matches(glob: string, file: string): boolean {
  if (glob.endsWith('/**')) return file.startsWith(glob.slice(0, -2));
  if (!glob.includes('*')) return file === glob;
  const star = glob.indexOf('*');
  if (glob.indexOf('*', star + 1) !== -1) throw new Error(`unsupported glob (2+ wildcards): ${glob}`);
  const [head, tail] = [glob.slice(0, star), glob.slice(star + 1)];
  if (tail.includes('/')) throw new Error(`unsupported glob (wildcard before a slash): ${glob}`);
  return file.startsWith(head) && file.endsWith(tail) && !file.slice(head.length).includes('/');
}

const claims = (globs: string[], file: string) => globs.some((g) => matches(g, file));

describe('test suite partition', () => {
  it('routes every test file to exactly one runner', () => {
    const runners = {
      'test:browser': BROWSER_TEST_GLOBS,
      'test:mobile': MOBILE_TEST_GLOBS,
      'test:perf': PERF_TEST_GLOBS,
    };

    const orphaned: string[] = [];
    const contested: string[] = [];
    for (const file of allTestFiles()) {
      const owners = Object.entries(runners)
        .filter(([, globs]) => claims(globs, file))
        .map(([name]) => name);
      // Not in any excluded suite == owned by the gate, which is correct and
      // the common case. Only >1 excluded owner is a bug.
      if (owners.length > 1) contested.push(`${file} -> ${owners.join(' + ')}`);
      // An excluded file with no runner is the silent hole this file exists for.
      if (owners.length === 0 && claims(NON_CI_TEST_GLOBS, file)) orphaned.push(file);
    }

    expect(contested, 'a file claimed by two runners runs twice, or not at all').toEqual([]);
    expect(orphaned, 'excluded from `npm test` but no runner picks it up — this file is tested by NOTHING').toEqual([]);
  });

  it('keeps NON_CI_TEST_GLOBS the union of the three excluded suites', () => {
    // The gate excludes NON_CI_TEST_GLOBS; the runners include the three arrays.
    // If the union drifts, the gate skips something no runner covers.
    expect([...NON_CI_TEST_GLOBS].sort()).toEqual(
      [...MOBILE_TEST_GLOBS, ...PERF_TEST_GLOBS, ...BROWSER_TEST_GLOBS].sort()
    );
  });

  it('names only globs the matcher above can actually read', () => {
    // matches() throws on shapes it would otherwise silently mis-classify.
    for (const glob of NON_CI_TEST_GLOBS) expect(() => matches(glob, 'test/x.test.ts')).not.toThrow();
  });

  it('points every excluded glob at files that exist', () => {
    // A stale entry (file renamed or deleted) makes its runner silently empty.
    const files = allTestFiles();
    for (const glob of NON_CI_TEST_GLOBS) {
      expect(
        files.some((f) => matches(glob, f)),
        `${glob} matches no test file`
      ).toBe(true);
    }
  });
});
