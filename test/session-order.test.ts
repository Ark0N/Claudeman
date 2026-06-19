/**
 * @fileoverview Unit tests for the pure session-order helpers
 * (normalizeSessionOrder, mergeSessionOrder) used by global tab-order sync (COD-131).
 */
import { describe, it, expect } from 'vitest';
import { normalizeSessionOrder, mergeSessionOrder } from '../src/session-order.js';

describe('normalizeSessionOrder', () => {
  it('keeps a clean array unchanged', () => {
    expect(normalizeSessionOrder(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('dedups, first occurrence wins', () => {
    expect(normalizeSessionOrder(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('drops empty strings', () => {
    expect(normalizeSessionOrder(['a', '', 'b', '   '])).toEqual(['a', 'b', '   ']);
    expect(normalizeSessionOrder([''])).toEqual([]);
  });

  it('drops non-string entries', () => {
    expect(normalizeSessionOrder(['a', 1, null, undefined, {}, 'b', true])).toEqual(['a', 'b']);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeSessionOrder(undefined)).toEqual([]);
    expect(normalizeSessionOrder(null)).toEqual([]);
    expect(normalizeSessionOrder('abc')).toEqual([]);
    expect(normalizeSessionOrder(42)).toEqual([]);
    expect(normalizeSessionOrder({ 0: 'a' })).toEqual([]);
  });

  it('returns [] for empty array', () => {
    expect(normalizeSessionOrder([])).toEqual([]);
  });
});

describe('mergeSessionOrder', () => {
  it('incoming order wins', () => {
    expect(mergeSessionOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('appends server-only ids (not in incoming) at the end, preserving their relative order', () => {
    expect(mergeSessionOrder(['a', 'b'], ['x', 'a', 'y', 'b', 'z'])).toEqual(['a', 'b', 'x', 'y', 'z']);
  });

  it('empty incoming yields the existing order (normalized)', () => {
    expect(mergeSessionOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('empty existing yields the incoming order (normalized)', () => {
    expect(mergeSessionOrder(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('both empty yields empty', () => {
    expect(mergeSessionOrder([], [])).toEqual([]);
  });

  it('normalizes both args (dedup + drop junk) before merging', () => {
    expect(mergeSessionOrder(['a', 'a', '', 'b'], ['b', 'c', 'c', ''])).toEqual(['a', 'b', 'c']);
  });

  it('does not duplicate an id present in both', () => {
    expect(mergeSessionOrder(['a', 'b'], ['b', 'a'])).toEqual(['a', 'b']);
  });

  it('handles non-array / junk inputs defensively', () => {
    // @ts-expect-error testing runtime robustness against bad input
    expect(mergeSessionOrder(null, ['a', 'b'])).toEqual(['a', 'b']);
    // @ts-expect-error testing runtime robustness against bad input
    expect(mergeSessionOrder(['a'], 'nope')).toEqual(['a']);
  });
});
