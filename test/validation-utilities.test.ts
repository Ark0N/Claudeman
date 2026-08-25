/**
 * @fileoverview Tests for validation utilities
 *
 * Tests input validation, type checking, and schema validation
 * patterns used throughout the application.
 */

import { describe, it, expect } from 'vitest';

describe('Validation Utilities', () => {
  describe('Type Guards', () => {
    const isString = (value: unknown): value is string => {
      return typeof value === 'string';
    };

    const isNumber = (value: unknown): value is number => {
      return typeof value === 'number' && !isNaN(value);
    };

    const isBoolean = (value: unknown): value is boolean => {
      return typeof value === 'boolean';
    };

    const isArray = <T>(value: unknown, itemGuard?: (item: unknown) => item is T): value is T[] => {
      if (!Array.isArray(value)) return false;
      if (itemGuard) {
        return value.every(itemGuard);
      }
      return true;
    };

    const isObject = (value: unknown): value is Record<string, unknown> => {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    };

    it('should detect strings', () => {
      expect(isString('hello')).toBe(true);
      expect(isString('')).toBe(true);
      expect(isString(123)).toBe(false);
      expect(isString(null)).toBe(false);
    });

    it('should detect numbers', () => {
      expect(isNumber(123)).toBe(true);
      expect(isNumber(0)).toBe(true);
      expect(isNumber(-5.5)).toBe(true);
      expect(isNumber(NaN)).toBe(false);
      expect(isNumber('123')).toBe(false);
    });

    it('should detect booleans', () => {
      expect(isBoolean(true)).toBe(true);
      expect(isBoolean(false)).toBe(true);
      expect(isBoolean(1)).toBe(false);
      expect(isBoolean('true')).toBe(false);
    });

    it('should detect arrays', () => {
      expect(isArray([])).toBe(true);
      expect(isArray([1, 2, 3])).toBe(true);
      expect(isArray('array')).toBe(false);
      expect(isArray({})).toBe(false);
    });

    it('should detect typed arrays', () => {
      expect(isArray([1, 2, 3], isNumber)).toBe(true);
      expect(isArray(['a', 'b'], isString)).toBe(true);
      expect(isArray([1, 'a'], isNumber)).toBe(false);
    });

    it('should detect objects', () => {
      expect(isObject({})).toBe(true);
      expect(isObject({ key: 'value' })).toBe(true);
      expect(isObject(null)).toBe(false);
      expect(isObject([])).toBe(false);
    });
  });

  describe('Nullish Checks', () => {
    const isNullish = (value: unknown): value is null | undefined => {
      return value === null || value === undefined;
    };

    const isNotNullish = <T>(value: T | null | undefined): value is T => {
      return value !== null && value !== undefined;
    };

    const coalesce = <T>(value: T | null | undefined, defaultValue: T): T => {
      return isNotNullish(value) ? value : defaultValue;
    };

    it('should detect null', () => {
      expect(isNullish(null)).toBe(true);
    });

    it('should detect undefined', () => {
      expect(isNullish(undefined)).toBe(true);
    });

    it('should not detect falsy values as nullish', () => {
      expect(isNullish(0)).toBe(false);
      expect(isNullish('')).toBe(false);
      expect(isNullish(false)).toBe(false);
    });

    it('should coalesce nullish values', () => {
      expect(coalesce(null, 'default')).toBe('default');
      expect(coalesce(undefined, 'default')).toBe('default');
      expect(coalesce('value', 'default')).toBe('value');
      expect(coalesce(0, 10)).toBe(0);
    });
  });

  describe('String Validation', () => {
    const isNonEmptyString = (value: unknown): value is string => {
      return typeof value === 'string' && value.length > 0;
    };

    const isEmail = (value: string): boolean => {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    };

    const isUrl = (value: string): boolean => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    };

    const isAlphanumeric = (value: string): boolean => {
      return /^[a-zA-Z0-9]+$/.test(value);
    };

    const isSlug = (value: string): boolean => {
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
    };

    it('should validate non-empty strings', () => {
      expect(isNonEmptyString('hello')).toBe(true);
      expect(isNonEmptyString('')).toBe(false);
      expect(isNonEmptyString(null)).toBe(false);
    });

    it('should validate email format', () => {
      expect(isEmail('user@example.com')).toBe(true);
      expect(isEmail('user+tag@example.co.uk')).toBe(true);
      expect(isEmail('invalid')).toBe(false);
      expect(isEmail('@example.com')).toBe(false);
    });

    it('should validate URL format', () => {
      expect(isUrl('https://example.com')).toBe(true);
      expect(isUrl('http://localhost:3000')).toBe(true);
      expect(isUrl('not a url')).toBe(false);
    });

    it('should validate alphanumeric strings', () => {
      expect(isAlphanumeric('abc123')).toBe(true);
      expect(isAlphanumeric('ABC')).toBe(true);
      expect(isAlphanumeric('abc-123')).toBe(false);
      expect(isAlphanumeric('')).toBe(false);
    });

    it('should validate slugs', () => {
      expect(isSlug('hello-world')).toBe(true);
      expect(isSlug('test123')).toBe(true);
      expect(isSlug('Hello-World')).toBe(false);
      expect(isSlug('-invalid')).toBe(false);
    });
  });

  describe('Number Validation', () => {
    const isPositive = (value: number): boolean => {
      return value > 0;
    };

    const isNonNegative = (value: number): boolean => {
      return value >= 0;
    };

    const isInteger = (value: number): boolean => {
      return Number.isInteger(value);
    };

    const isInRange = (value: number, min: number, max: number): boolean => {
      return value >= min && value <= max;
    };

    const isPort = (value: number): boolean => {
      return isInteger(value) && isInRange(value, 1, 65535);
    };

    it('should validate positive numbers', () => {
      expect(isPositive(1)).toBe(true);
      expect(isPositive(0)).toBe(false);
      expect(isPositive(-1)).toBe(false);
    });

    it('should validate non-negative numbers', () => {
      expect(isNonNegative(0)).toBe(true);
      expect(isNonNegative(1)).toBe(true);
      expect(isNonNegative(-1)).toBe(false);
    });

    it('should validate integers', () => {
      expect(isInteger(5)).toBe(true);
      expect(isInteger(5.5)).toBe(false);
      expect(isInteger(-10)).toBe(true);
    });

    it('should validate range', () => {
      expect(isInRange(5, 1, 10)).toBe(true);
      expect(isInRange(1, 1, 10)).toBe(true);
      expect(isInRange(10, 1, 10)).toBe(true);
      expect(isInRange(0, 1, 10)).toBe(false);
    });

    it('should validate port numbers', () => {
      expect(isPort(80)).toBe(true);
      expect(isPort(3000)).toBe(true);
      expect(isPort(0)).toBe(false);
      expect(isPort(65536)).toBe(false);
      expect(isPort(3000.5)).toBe(false);
    });
  });

  describe('Object Validation', () => {
    const hasProperty = <K extends string>(obj: unknown, key: K): obj is Record<K, unknown> => {
      return typeof obj === 'object' && obj !== null && key in obj;
    };

    const hasRequiredProperties = (obj: unknown, keys: string[]): obj is Record<string, unknown> => {
      if (typeof obj !== 'object' || obj === null) return false;
      return keys.every((key) => key in obj);
    };

    const validateShape = <T>(obj: unknown, validators: Record<keyof T, (value: unknown) => boolean>): obj is T => {
      if (typeof obj !== 'object' || obj === null) return false;
      const record = obj as Record<string, unknown>;
      return Object.entries(validators).every(([key, validate]) => {
        return validate(record[key]);
      });
    };

    it('should check property existence', () => {
      expect(hasProperty({ name: 'test' }, 'name')).toBe(true);
      expect(hasProperty({ name: 'test' }, 'age')).toBe(false);
      expect(hasProperty(null, 'name')).toBe(false);
    });

    it('should check required properties', () => {
      const obj = { name: 'test', age: 25 };
      expect(hasRequiredProperties(obj, ['name', 'age'])).toBe(true);
      expect(hasRequiredProperties(obj, ['name', 'email'])).toBe(false);
    });

    it('should validate object shape', () => {
      const isUser = (obj: unknown) =>
        validateShape(obj, {
          name: (v) => typeof v === 'string',
          age: (v) => typeof v === 'number',
        });

      expect(isUser({ name: 'John', age: 25 })).toBe(true);
      expect(isUser({ name: 'John' })).toBe(false);
      expect(isUser({ name: 123, age: 25 })).toBe(false);
    });
  });

  describe('Array Validation', () => {
    const isNonEmpty = <T>(arr: T[]): arr is [T, ...T[]] => {
      return arr.length > 0;
    };

    const hasMinLength = <T>(arr: T[], min: number): boolean => {
      return arr.length >= min;
    };

    const hasMaxLength = <T>(arr: T[], max: number): boolean => {
      return arr.length <= max;
    };

    const hasLength = <T>(arr: T[], min: number, max?: number): boolean => {
      if (max === undefined) {
        return arr.length === min;
      }
      return arr.length >= min && arr.length <= max;
    };

    const allUnique = <T>(arr: T[]): boolean => {
      return new Set(arr).size === arr.length;
    };

    it('should validate non-empty arrays', () => {
      expect(isNonEmpty([1])).toBe(true);
      expect(isNonEmpty([])).toBe(false);
    });

    it('should validate minimum length', () => {
      expect(hasMinLength([1, 2, 3], 2)).toBe(true);
      expect(hasMinLength([1], 2)).toBe(false);
    });

    it('should validate maximum length', () => {
      expect(hasMaxLength([1, 2], 3)).toBe(true);
      expect(hasMaxLength([1, 2, 3, 4], 3)).toBe(false);
    });

    it('should validate exact length', () => {
      expect(hasLength([1, 2, 3], 3)).toBe(true);
      expect(hasLength([1, 2], 3)).toBe(false);
    });

    it('should validate length range', () => {
      expect(hasLength([1, 2, 3], 2, 5)).toBe(true);
      expect(hasLength([1], 2, 5)).toBe(false);
      expect(hasLength([1, 2, 3, 4, 5, 6], 2, 5)).toBe(false);
    });

    it('should check uniqueness', () => {
      expect(allUnique([1, 2, 3])).toBe(true);
      expect(allUnique([1, 2, 2])).toBe(false);
      expect(allUnique([])).toBe(true);
    });
  });

  describe('Custom Validators', () => {
    interface ValidationResult {
      valid: boolean;
      errors: string[];
    }

    const createValidator = <T>(
      validations: Array<{
        check: (value: T) => boolean;
        message: string;
      }>
    ) => {
      return (value: T): ValidationResult => {
        const errors = validations.filter((v) => !v.check(value)).map((v) => v.message);
        return {
          valid: errors.length === 0,
          errors,
        };
      };
    };

    it('should validate with no errors', () => {
      const validatePassword = createValidator<string>([
        { check: (v) => v.length >= 8, message: 'Must be at least 8 characters' },
        { check: (v) => /[A-Z]/.test(v), message: 'Must contain uppercase' },
        { check: (v) => /[0-9]/.test(v), message: 'Must contain number' },
      ]);

      const result = validatePassword('Password123');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should collect all errors', () => {
      const validatePassword = createValidator<string>([
        { check: (v) => v.length >= 8, message: 'Must be at least 8 characters' },
        { check: (v) => /[A-Z]/.test(v), message: 'Must contain uppercase' },
        { check: (v) => /[0-9]/.test(v), message: 'Must contain number' },
      ]);

      const result = validatePassword('pass');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Must be at least 8 characters');
      expect(result.errors).toContain('Must contain uppercase');
      expect(result.errors).toContain('Must contain number');
    });
  });

  describe('Schema Validation', () => {
    type SchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object';

    interface SchemaField {
      type: SchemaType;
      required?: boolean;
      minLength?: number;
      maxLength?: number;
      min?: number;
      max?: number;
      pattern?: RegExp;
      items?: SchemaField;
      properties?: Record<string, SchemaField>;
    }

    const validateField = (value: unknown, schema: SchemaField): string[] => {
      const errors: string[] = [];

      // Check required
      if (value === undefined || value === null) {
        if (schema.required) {
          errors.push('Value is required');
        }
        return errors;
      }

      // Check type
      switch (schema.type) {
        case 'string':
          if (typeof value !== 'string') {
            errors.push('Expected string');
          } else {
            if (schema.minLength && value.length < schema.minLength) {
              errors.push(`Minimum length is ${schema.minLength}`);
            }
            if (schema.maxLength && value.length > schema.maxLength) {
              errors.push(`Maximum length is ${schema.maxLength}`);
            }
            if (schema.pattern && !schema.pattern.test(value)) {
              errors.push('Value does not match pattern');
            }
          }
          break;

        case 'number':
          if (typeof value !== 'number') {
            errors.push('Expected number');
          } else {
            if (schema.min !== undefined && value < schema.min) {
              errors.push(`Minimum value is ${schema.min}`);
            }
            if (schema.max !== undefined && value > schema.max) {
              errors.push(`Maximum value is ${schema.max}`);
            }
          }
          break;

        case 'boolean':
          if (typeof value !== 'boolean') {
            errors.push('Expected boolean');
          }
          break;

        case 'array':
          if (!Array.isArray(value)) {
            errors.push('Expected array');
          } else if (schema.items) {
            value.forEach((item, i) => {
              const itemErrors = validateField(item, schema.items!);
              errors.push(...itemErrors.map((e) => `[${i}]: ${e}`));
            });
          }
          break;

        case 'object':
          if (typeof value !== 'object' || Array.isArray(value)) {
            errors.push('Expected object');
          } else if (schema.properties) {
            const obj = value as Record<string, unknown>;
            for (const [key, fieldSchema] of Object.entries(schema.properties)) {
              const fieldErrors = validateField(obj[key], fieldSchema);
              errors.push(...fieldErrors.map((e) => `${key}: ${e}`));
            }
          }
          break;
      }

      return errors;
    };

    it('should validate strings', () => {
      const schema: SchemaField = { type: 'string', required: true, minLength: 3 };
      expect(validateField('hello', schema)).toHaveLength(0);
      expect(validateField('ab', schema)).toContain('Minimum length is 3');
      expect(validateField(undefined, schema)).toContain('Value is required');
    });

    it('should validate numbers', () => {
      const schema: SchemaField = { type: 'number', min: 0, max: 100 };
      expect(validateField(50, schema)).toHaveLength(0);
      expect(validateField(-1, schema)).toContain('Minimum value is 0');
      expect(validateField(101, schema)).toContain('Maximum value is 100');
    });

    it('should validate booleans', () => {
      const schema: SchemaField = { type: 'boolean' };
      expect(validateField(true, schema)).toHaveLength(0);
      expect(validateField('true', schema)).toContain('Expected boolean');
    });

    it('should validate arrays', () => {
      const schema: SchemaField = {
        type: 'array',
        items: { type: 'number' },
      };
      expect(validateField([1, 2, 3], schema)).toHaveLength(0);
      expect(validateField([1, 'a', 3], schema)).toContain('[1]: Expected number');
    });

    it('should validate objects', () => {
      const schema: SchemaField = {
        type: 'object',
        properties: {
          name: { type: 'string', required: true },
          age: { type: 'number' },
        },
      };
      expect(validateField({ name: 'John', age: 25 }, schema)).toHaveLength(0);
      expect(validateField({ age: 25 }, schema)).toContain('name: Value is required');
    });

    it('should validate string patterns', () => {
      const schema: SchemaField = {
        type: 'string',
        pattern: /^[a-z]+$/,
      };
      expect(validateField('hello', schema)).toHaveLength(0);
      expect(validateField('Hello', schema)).toContain('Value does not match pattern');
    });
  });

  describe('Sanitization', () => {
    const sanitizeString = (value: unknown, defaultValue: string = ''): string => {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return defaultValue;
      return String(value);
    };

    const sanitizeNumber = (value: unknown, defaultValue: number = 0): number => {
      if (typeof value === 'number' && !isNaN(value)) return value;
      const parsed = Number(value);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    const sanitizeBoolean = (value: unknown, defaultValue: boolean = false): boolean => {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      return defaultValue;
    };

    const sanitizeArray = <T>(value: unknown, defaultValue: T[] = []): T[] => {
      if (Array.isArray(value)) return value;
      return defaultValue;
    };

    it('should sanitize strings', () => {
      expect(sanitizeString('hello')).toBe('hello');
      expect(sanitizeString(123)).toBe('123');
      expect(sanitizeString(null, 'default')).toBe('default');
    });

    it('should sanitize numbers', () => {
      expect(sanitizeNumber(42)).toBe(42);
      expect(sanitizeNumber('42')).toBe(42);
      expect(sanitizeNumber('invalid', 0)).toBe(0);
    });

    it('should sanitize booleans', () => {
      expect(sanitizeBoolean(true)).toBe(true);
      expect(sanitizeBoolean('true')).toBe(true);
      expect(sanitizeBoolean('1')).toBe(true);
      expect(sanitizeBoolean('false')).toBe(false);
      expect(sanitizeBoolean(null, false)).toBe(false);
    });

    it('should sanitize arrays', () => {
      expect(sanitizeArray([1, 2, 3])).toEqual([1, 2, 3]);
      expect(sanitizeArray('not array', [])).toEqual([]);
      expect(sanitizeArray(null, [1])).toEqual([1]);
    });
  });

  describe('Deep Equality', () => {
    const deepEqual = (a: unknown, b: unknown): boolean => {
      if (a === b) return true;

      if (typeof a !== typeof b) return false;

      if (a === null || b === null) return a === b;

      if (typeof a !== 'object') return false;

      if (Array.isArray(a) !== Array.isArray(b)) return false;

      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((val, i) => deepEqual(val, b[i]));
      }

      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;

      const keysA = Object.keys(aObj);
      const keysB = Object.keys(bObj);

      if (keysA.length !== keysB.length) return false;

      return keysA.every((key) => deepEqual(aObj[key], bObj[key]));
    };

    it('should compare primitives', () => {
      expect(deepEqual(1, 1)).toBe(true);
      expect(deepEqual('a', 'a')).toBe(true);
      expect(deepEqual(1, 2)).toBe(false);
    });

    it('should compare arrays', () => {
      expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(deepEqual([1, 2, 3], [1, 3, 2])).toBe(false);
    });

    it('should compare objects', () => {
      expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
      expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
      expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    });

    it('should compare nested structures', () => {
      expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
      expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
    });

    it('should handle null and undefined', () => {
      expect(deepEqual(null, null)).toBe(true);
      expect(deepEqual(undefined, undefined)).toBe(true);
      expect(deepEqual(null, undefined)).toBe(false);
    });
  });
});
