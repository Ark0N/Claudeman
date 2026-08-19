/**
 * @fileoverview Tests for the pure file-query matcher (COD-236).
 *
 * Node-safe: no fs, no ports, no jsdom. Just the compile/apply matcher.
 */

import { describe, it, expect } from 'vitest';
import { compileFileQuery, matchFileQuery } from '../src/utils/file-query.js';

describe('compileFileQuery', () => {
  it('returns null for empty / whitespace-only queries', () => {
    expect(compileFileQuery('')).toBeNull();
    expect(compileFileQuery('   ')).toBeNull();
    expect(compileFileQuery('\t\n')).toBeNull();
  });

  it('does a case-insensitive substring match on the name by default', () => {
    const m = compileFileQuery('Route');
    expect(m).not.toBeNull();
    expect(m!('file-routes.ts', 'src/web/file-routes.ts')).toBe(true);
    expect(m!('FILE-ROUTES.TS', 'src/FILE-ROUTES.TS')).toBe(true);
    expect(m!('session.ts', 'src/session.ts')).toBe(false);
  });

  it('matches against the relative path when the query contains a slash (substring)', () => {
    const m = compileFileQuery('web/file');
    expect(m).not.toBeNull();
    // Name alone would not contain the slash — must match the relative path.
    expect(m!('file-routes.ts', 'src/web/file-routes.ts')).toBe(true);
    expect(m!('file-routes.ts', 'src/api/file-routes.ts')).toBe(false);
  });

  it('compiles an anchored, case-insensitive glob for * against the name', () => {
    const m = compileFileQuery('*.ts');
    expect(m).not.toBeNull();
    expect(m!('session.ts', 'src/session.ts')).toBe(true);
    expect(m!('SESSION.TS', 'src/SESSION.TS')).toBe(true);
    // Anchored: .ts must be at the end, not merely contained.
    expect(m!('session.tsx', 'src/session.tsx')).toBe(false);
    expect(m!('notes.md', 'notes.md')).toBe(false);
  });

  it('treats ? as a single-character glob wildcard', () => {
    const m = compileFileQuery('a?c.txt');
    expect(m).not.toBeNull();
    expect(m!('abc.txt', 'abc.txt')).toBe(true);
    expect(m!('axc.txt', 'axc.txt')).toBe(true);
    // ? matches exactly one char, not zero and not two.
    expect(m!('ac.txt', 'ac.txt')).toBe(false);
    expect(m!('abbc.txt', 'abbc.txt')).toBe(false);
  });

  it('escapes regex metacharacters other than * and ? in glob mode', () => {
    // The dot is a literal, not "any char"; the + is literal too.
    const m = compileFileQuery('v1.2+*.log');
    expect(m).not.toBeNull();
    expect(m!('v1.2+final.log', 'v1.2+final.log')).toBe(true);
    expect(m!('v1X2Yfinal.log', 'v1X2Yfinal.log')).toBe(false);
  });

  it('matches a glob against the relative path when it contains a slash', () => {
    const m = compileFileQuery('src/*.ts');
    expect(m).not.toBeNull();
    expect(m!('session.ts', 'src/session.ts')).toBe(true);
    expect(m!('session.ts', 'lib/session.ts')).toBe(false);
  });
});

describe('matchFileQuery', () => {
  it('compiles then applies in one call', () => {
    expect(matchFileQuery('route', 'file-routes.ts', 'src/file-routes.ts')).toBe(true);
    expect(matchFileQuery('*.md', 'readme.md', 'docs/readme.md')).toBe(true);
    expect(matchFileQuery('*.md', 'readme.txt', 'docs/readme.txt')).toBe(false);
  });

  it('returns false when the query compiles to null (empty)', () => {
    expect(matchFileQuery('', 'anything.ts', 'src/anything.ts')).toBe(false);
    expect(matchFileQuery('   ', 'anything.ts', 'src/anything.ts')).toBe(false);
  });
});
