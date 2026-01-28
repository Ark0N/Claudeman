/**
 * Tests for BufferAccumulator utility.
 *
 * Port: N/A (unit tests, no server)
 */

import { BufferAccumulator } from '../../src/utils/buffer-accumulator.js';

describe('BufferAccumulator', () => {
  describe('basic operations', () => {
    it('should start empty', () => {
      const buffer = new BufferAccumulator(1000, 800);
      expect(buffer.value).toBe('');
      expect(buffer.length).toBe(0);
      expect(buffer.isEmpty).toBe(true);
    });

    it('should append data', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello');
      buffer.append(' ');
      buffer.append('world');

      expect(buffer.value).toBe('hello world');
      expect(buffer.length).toBe(11);
      expect(buffer.isEmpty).toBe(false);
    });

    it('should ignore empty appends', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello');
      buffer.append('');
      buffer.append(null as unknown as string);
      buffer.append(undefined as unknown as string);

      expect(buffer.value).toBe('hello');
      expect(buffer.length).toBe(5);
    });

    it('should clear the buffer', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello world');
      buffer.clear();

      expect(buffer.value).toBe('');
      expect(buffer.length).toBe(0);
      expect(buffer.isEmpty).toBe(true);
    });

    it('should set buffer to specific value', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello');
      buffer.set('goodbye');

      expect(buffer.value).toBe('goodbye');
      expect(buffer.length).toBe(7);
    });

    it('should set to empty value', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello');
      buffer.set('');

      expect(buffer.value).toBe('');
      expect(buffer.length).toBe(0);
    });
  });

  describe('automatic trimming', () => {
    it('should trim when maxSize is exceeded', () => {
      const buffer = new BufferAccumulator(100, 50);

      // Fill buffer beyond max
      buffer.append('a'.repeat(60));
      buffer.append('b'.repeat(60));  // Total 120, exceeds 100

      // Should have trimmed to 50
      expect(buffer.length).toBe(50);
      // Should keep most recent data (all 'b's)
      expect(buffer.value).toBe('b'.repeat(50));
    });

    it('should call onTrim callback when trimming', () => {
      let trimmedBytes = 0;
      const buffer = new BufferAccumulator({
        maxSize: 100,
        trimSize: 50,
        onTrim: (bytes) => { trimmedBytes = bytes; },
      });

      // Fill buffer beyond max
      buffer.append('a'.repeat(60));
      buffer.append('b'.repeat(60));  // Total 120, trims to 50

      expect(trimmedBytes).toBe(70);  // 120 - 50 = 70
    });

    it('should not call onTrim when no trimming needed', () => {
      let trimCalled = false;
      const buffer = new BufferAccumulator({
        maxSize: 100,
        trimSize: 50,
        onTrim: () => { trimCalled = true; },
      });

      buffer.append('a'.repeat(50));  // Under max

      expect(trimCalled).toBe(false);
    });
  });

  describe('tail and search operations', () => {
    it('should get tail of buffer', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello world');

      expect(buffer.tail(5)).toBe('world');
      expect(buffer.tail(6)).toBe(' world');
      expect(buffer.tail(100)).toBe('hello world');  // Returns all if n > length
    });

    it('should check endsWith', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello world');

      expect(buffer.endsWith('world')).toBe(true);
      expect(buffer.endsWith('hello')).toBe(false);
      expect(buffer.endsWith('')).toBe(true);
      expect(buffer.endsWith('a very long string')).toBe(false);
    });

    it('should search with contains (string)', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello world, how are you?');

      expect(buffer.contains('world')).toBe(true);
      expect(buffer.contains('foo')).toBe(false);
      expect(buffer.contains('you', 10)).toBe(true);
      expect(buffer.contains('hello', 10)).toBe(false);
    });

    it('should search with contains (regex)', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello world 123');

      expect(buffer.contains(/\d+/)).toBe(true);
      expect(buffer.contains(/foo/)).toBe(false);
      expect(buffer.contains(/world/)).toBe(true);
    });
  });

  describe('constructor overloads', () => {
    it('should accept simple number parameters', () => {
      const buffer = new BufferAccumulator(100, 50);
      buffer.append('a'.repeat(120));
      expect(buffer.length).toBe(50);
    });

    it('should accept BufferConfig object', () => {
      const buffer = new BufferAccumulator({
        maxSize: 100,
        trimSize: 50,
      });
      buffer.append('a'.repeat(120));
      expect(buffer.length).toBe(50);
    });
  });

  describe('chunk consolidation', () => {
    it('should consolidate chunks on value access', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('a');
      buffer.append('b');
      buffer.append('c');

      // First access consolidates
      const value1 = buffer.value;
      expect(value1).toBe('abc');

      // Second access should return same value efficiently
      const value2 = buffer.value;
      expect(value2).toBe('abc');
    });

    it('should handle single chunk efficiently', () => {
      const buffer = new BufferAccumulator(1000, 800);
      buffer.append('hello world');

      // Single chunk doesn't need joining
      expect(buffer.value).toBe('hello world');
    });
  });
});
