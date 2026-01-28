/**
 * Tests for LRUMap utility.
 *
 * Port: N/A (unit tests, no server)
 */

import { LRUMap } from '../../src/utils/lru-map.js';

describe('LRUMap', () => {
  describe('basic operations', () => {
    it('should start empty', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      expect(map.size).toBe(0);
      expect(map.freeSlots).toBe(5);
    });

    it('should set and get values', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('b', 2);

      expect(map.get('a')).toBe(1);
      expect(map.get('b')).toBe(2);
      expect(map.get('c')).toBeUndefined();
    });

    it('should update existing values', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('a', 10);

      expect(map.get('a')).toBe(10);
      expect(map.size).toBe(1);
    });

    it('should delete values', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.delete('a');

      expect(map.get('a')).toBeUndefined();
      expect(map.size).toBe(0);
    });

    it('should check has correctly', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);

      expect(map.has('a')).toBe(true);
      expect(map.has('b')).toBe(false);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entry when maxSize exceeded', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);
      map.set('d', 4);  // Should evict 'a'

      expect(map.size).toBe(3);
      expect(map.has('a')).toBe(false);
      expect(map.get('b')).toBe(2);
      expect(map.get('c')).toBe(3);
      expect(map.get('d')).toBe(4);
    });

    it('should call onEvict callback when evicting', () => {
      const evicted: Array<[string, number]> = [];
      const map = new LRUMap<string, number>({
        maxSize: 2,
        onEvict: (key, value) => evicted.push([key, value]),
      });

      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);  // Evicts 'a'
      map.set('d', 4);  // Evicts 'b'

      expect(evicted).toEqual([['a', 1], ['b', 2]]);
    });

    it('should refresh position on get()', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);

      // Access 'a' to refresh it
      map.get('a');

      // Add 'd' which should evict 'b' (now oldest)
      map.set('d', 4);

      expect(map.has('a')).toBe(true);  // 'a' was refreshed
      expect(map.has('b')).toBe(false); // 'b' was evicted
      expect(map.has('c')).toBe(true);
      expect(map.has('d')).toBe(true);
    });

    it('should refresh position on set() for existing key', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);

      // Update 'a' to refresh it
      map.set('a', 10);

      // Add 'd' which should evict 'b' (now oldest)
      map.set('d', 4);

      expect(map.has('a')).toBe(true);
      expect(map.get('a')).toBe(10);
      expect(map.has('b')).toBe(false);
    });
  });

  describe('peek and oldest/newest', () => {
    it('should peek without refreshing position', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);

      // Peek 'a' (should NOT refresh)
      expect(map.peek('a')).toBe(1);

      // Add 'd' which should evict 'a' (still oldest)
      map.set('d', 4);

      expect(map.has('a')).toBe(false);
    });

    it('should get oldest entry', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);

      expect(map.oldest()).toEqual(['a', 1]);
    });

    it('should get newest entry', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);

      expect(map.newest()).toEqual(['c', 3]);
    });

    it('should return undefined for oldest/newest on empty map', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });

      expect(map.oldest()).toBeUndefined();
      expect(map.newest()).toBeUndefined();
    });
  });

  describe('expireOlderThan', () => {
    it('should expire entries older than maxAge', () => {
      interface Entry { value: number; timestamp: number }
      const map = new LRUMap<string, Entry>({ maxSize: 10 });

      const now = Date.now();
      map.set('old1', { value: 1, timestamp: now - 10000 });  // 10s old
      map.set('old2', { value: 2, timestamp: now - 8000 });   // 8s old
      map.set('new1', { value: 3, timestamp: now - 2000 });   // 2s old
      map.set('new2', { value: 4, timestamp: now - 1000 });   // 1s old

      const evicted = map.expireOlderThan(5000, (v) => v.timestamp);

      expect(evicted).toBe(2);
      expect(map.size).toBe(2);
      expect(map.has('old1')).toBe(false);
      expect(map.has('old2')).toBe(false);
      expect(map.has('new1')).toBe(true);
      expect(map.has('new2')).toBe(true);
    });

    it('should call onEvict for expired entries', () => {
      interface Entry { value: number; timestamp: number }
      const evicted: string[] = [];
      const map = new LRUMap<string, Entry>({
        maxSize: 10,
        onEvict: (key) => evicted.push(key),
      });

      const now = Date.now();
      map.set('old', { value: 1, timestamp: now - 10000 });
      map.set('new', { value: 2, timestamp: now - 1000 });

      map.expireOlderThan(5000, (v) => v.timestamp);

      expect(evicted).toEqual(['old']);
    });
  });

  describe('iteration helpers', () => {
    it('should return keys in order', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);

      expect(map.keysInOrder()).toEqual(['a', 'b', 'c']);
    });

    it('should return values in order', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);

      expect(map.valuesInOrder()).toEqual([1, 2, 3]);
    });
  });

  describe('properties', () => {
    it('should report maxEntries correctly', () => {
      const map = new LRUMap<string, number>({ maxSize: 10 });
      expect(map.maxEntries).toBe(10);
    });

    it('should report freeSlots correctly', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      expect(map.freeSlots).toBe(5);

      map.set('a', 1);
      map.set('b', 2);
      expect(map.freeSlots).toBe(3);

      map.set('c', 3);
      map.set('d', 4);
      map.set('e', 5);
      expect(map.freeSlots).toBe(0);

      // Adding more doesn't go negative
      map.set('f', 6);
      expect(map.freeSlots).toBe(0);
    });
  });
});
