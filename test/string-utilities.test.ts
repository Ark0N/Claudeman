/**
 * @fileoverview Tests for string manipulation utilities
 *
 * Tests various string processing patterns used in terminal output,
 * JSON parsing, and text formatting.
 */

import { describe, it, expect } from 'vitest';

describe('String Utilities', () => {
  describe('Truncation', () => {
    const truncate = (str: string, maxLength: number, suffix: string = '...'): string => {
      if (str.length <= maxLength) return str;
      return str.substring(0, maxLength - suffix.length) + suffix;
    };

    it('should not truncate short strings', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('should truncate long strings', () => {
      expect(truncate('hello world', 8)).toBe('hello...');
    });

    it('should use custom suffix', () => {
      expect(truncate('hello world', 8, '…')).toBe('hello w…');
    });

    it('should handle exact length', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });

    it('should handle empty string', () => {
      expect(truncate('', 10)).toBe('');
    });

    it('should handle very short max length', () => {
      expect(truncate('hello', 3)).toBe('...');
    });
  });

  describe('Padding', () => {
    const padLeft = (str: string, length: number, char: string = ' '): string => {
      return str.padStart(length, char);
    };

    const padRight = (str: string, length: number, char: string = ' '): string => {
      return str.padEnd(length, char);
    };

    const padCenter = (str: string, length: number, char: string = ' '): string => {
      if (str.length >= length) return str;
      const totalPad = length - str.length;
      const leftPad = Math.floor(totalPad / 2);
      const rightPad = totalPad - leftPad;
      return char.repeat(leftPad) + str + char.repeat(rightPad);
    };

    it('should pad left', () => {
      expect(padLeft('123', 5)).toBe('  123');
      expect(padLeft('123', 5, '0')).toBe('00123');
    });

    it('should pad right', () => {
      expect(padRight('123', 5)).toBe('123  ');
      expect(padRight('123', 5, '0')).toBe('12300');
    });

    it('should pad center', () => {
      expect(padCenter('abc', 7)).toBe('  abc  ');
      expect(padCenter('ab', 6)).toBe('  ab  ');
    });

    it('should not pad if already long enough', () => {
      expect(padLeft('hello', 3)).toBe('hello');
      expect(padRight('hello', 3)).toBe('hello');
      expect(padCenter('hello', 3)).toBe('hello');
    });
  });

  describe('Case Conversion', () => {
    const toCamelCase = (str: string): string => {
      return str.toLowerCase().replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
    };

    const toSnakeCase = (str: string): string => {
      return str
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase()
        .replace(/^_/, '')
        .replace(/[-\s]+/g, '_');
    };

    const toKebabCase = (str: string): string => {
      return str
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '')
        .replace(/[_\s]+/g, '-');
    };

    const toPascalCase = (str: string): string => {
      const camel = toCamelCase(str);
      return camel.charAt(0).toUpperCase() + camel.slice(1);
    };

    it('should convert to camelCase', () => {
      expect(toCamelCase('hello_world')).toBe('helloWorld');
      expect(toCamelCase('hello-world')).toBe('helloWorld');
      expect(toCamelCase('hello world')).toBe('helloWorld');
      expect(toCamelCase('HelloWorld')).toBe('helloworld');
    });

    it('should convert to snake_case', () => {
      expect(toSnakeCase('helloWorld')).toBe('hello_world');
      expect(toSnakeCase('hello-world')).toBe('hello_world');
      expect(toSnakeCase('hello world')).toBe('hello_world');
    });

    it('should convert to kebab-case', () => {
      expect(toKebabCase('helloWorld')).toBe('hello-world');
      expect(toKebabCase('hello_world')).toBe('hello-world');
      expect(toKebabCase('hello world')).toBe('hello-world');
    });

    it('should convert to PascalCase', () => {
      expect(toPascalCase('hello_world')).toBe('HelloWorld');
      expect(toPascalCase('hello-world')).toBe('HelloWorld');
    });
  });

  describe('Escaping', () => {
    const escapeHtml = (str: string): string => {
      const htmlEscapes: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return str.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
    };

    const escapeRegex = (str: string): string => {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };

    const escapeShell = (str: string): string => {
      return `'${str.replace(/'/g, "'\\''")}'`;
    };

    it('should escape HTML entities', () => {
      expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(escapeHtml('a & b')).toBe('a &amp; b');
      expect(escapeHtml("it's")).toBe('it&#39;s');
    });

    it('should escape regex special chars', () => {
      expect(escapeRegex('a.b*c?')).toBe('a\\.b\\*c\\?');
      expect(escapeRegex('[test]')).toBe('\\[test\\]');
      expect(escapeRegex('(a|b)')).toBe('\\(a\\|b\\)');
    });

    it('should escape shell arguments', () => {
      expect(escapeShell('hello world')).toBe("'hello world'");
      expect(escapeShell("it's")).toBe("'it'\\''s'");
    });

    it('should handle empty strings', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeRegex('')).toBe('');
      expect(escapeShell('')).toBe("''");
    });
  });

  describe('Line Processing', () => {
    const splitLines = (str: string): string[] => {
      return str.split(/\r?\n/);
    };

    const getLines = (str: string, start: number, end?: number): string[] => {
      const lines = splitLines(str);
      return lines.slice(start, end);
    };

    const countLines = (str: string): number => {
      return splitLines(str).length;
    };

    const getLineAt = (str: string, lineNumber: number): string | undefined => {
      const lines = splitLines(str);
      return lines[lineNumber];
    };

    it('should split lines', () => {
      expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
      expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
    });

    it('should get line range', () => {
      const text = 'line0\nline1\nline2\nline3';
      expect(getLines(text, 1, 3)).toEqual(['line1', 'line2']);
    });

    it('should count lines', () => {
      expect(countLines('a\nb\nc')).toBe(3);
      expect(countLines('')).toBe(1);
      expect(countLines('no newlines')).toBe(1);
    });

    it('should get line at index', () => {
      const text = 'line0\nline1\nline2';
      expect(getLineAt(text, 0)).toBe('line0');
      expect(getLineAt(text, 1)).toBe('line1');
      expect(getLineAt(text, 5)).toBeUndefined();
    });
  });

  describe('Word Processing', () => {
    const splitWords = (str: string): string[] => {
      return str.split(/\s+/).filter((w) => w.length > 0);
    };

    const countWords = (str: string): number => {
      return splitWords(str).length;
    };

    const getFirstNWords = (str: string, n: number): string => {
      return splitWords(str).slice(0, n).join(' ');
    };

    const capitalizeWords = (str: string): string => {
      return str.replace(/\b\w/g, (c) => c.toUpperCase());
    };

    it('should split words', () => {
      expect(splitWords('hello world')).toEqual(['hello', 'world']);
      expect(splitWords('  extra   spaces  ')).toEqual(['extra', 'spaces']);
    });

    it('should count words', () => {
      expect(countWords('hello world foo bar')).toBe(4);
      expect(countWords('')).toBe(0);
      expect(countWords('   ')).toBe(0);
    });

    it('should get first N words', () => {
      expect(getFirstNWords('one two three four', 2)).toBe('one two');
    });

    it('should capitalize words', () => {
      expect(capitalizeWords('hello world')).toBe('Hello World');
      expect(capitalizeWords('HELLO WORLD')).toBe('HELLO WORLD');
    });
  });

  describe('Template Strings', () => {
    const interpolate = (template: string, values: Record<string, string>): string => {
      return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] || '');
    };

    const interpolateBrackets = (template: string, values: Record<string, string>): string => {
      return template.replace(/\[(\w+)\]/g, (_, key) => values[key] || `[${key}]`);
    };

    it('should interpolate double braces', () => {
      const template = 'Hello, {{name}}!';
      expect(interpolate(template, { name: 'World' })).toBe('Hello, World!');
    });

    it('should handle multiple placeholders', () => {
      const template = '{{greeting}}, {{name}}!';
      expect(interpolate(template, { greeting: 'Hello', name: 'World' })).toBe('Hello, World!');
    });

    it('should handle missing values', () => {
      const template = 'Hello, {{name}}!';
      expect(interpolate(template, {})).toBe('Hello, !');
    });

    it('should interpolate bracket placeholders', () => {
      const template = 'Project: [PROJECT_NAME]';
      expect(interpolateBrackets(template, { PROJECT_NAME: 'MyApp' })).toBe('Project: MyApp');
    });

    it('should preserve unknown bracket placeholders', () => {
      const template = '[KNOWN] and [UNKNOWN]';
      expect(interpolateBrackets(template, { KNOWN: 'value' })).toBe('value and [UNKNOWN]');
    });
  });

  describe('JSON String Processing', () => {
    const extractJson = (str: string): object | null => {
      const match = str.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    };

    const extractJsonArray = (str: string): unknown[] | null => {
      const match = str.match(/\[[\s\S]*\]/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    };

    const isValidJson = (str: string): boolean => {
      try {
        JSON.parse(str);
        return true;
      } catch {
        return false;
      }
    };

    it('should extract JSON object from text', () => {
      const text = 'Some text {"key": "value"} more text';
      expect(extractJson(text)).toEqual({ key: 'value' });
    });

    it('should extract JSON array from text', () => {
      const text = 'Result: [1, 2, 3]';
      expect(extractJsonArray(text)).toEqual([1, 2, 3]);
    });

    it('should handle invalid JSON', () => {
      expect(extractJson('not json')).toBeNull();
      expect(extractJson('{invalid}')).toBeNull();
    });

    it('should validate JSON strings', () => {
      expect(isValidJson('{"key": "value"}')).toBe(true);
      expect(isValidJson('[1, 2, 3]')).toBe(true);
      expect(isValidJson('not json')).toBe(false);
      expect(isValidJson('')).toBe(false);
    });
  });

  describe('Path Processing', () => {
    const getFileName = (path: string): string => {
      const parts = path.split(/[/\\]/);
      return parts[parts.length - 1];
    };

    const getDirectory = (path: string): string => {
      const parts = path.split(/[/\\]/);
      parts.pop();
      return parts.join('/') || '/';
    };

    const getExtension = (path: string): string => {
      const fileName = getFileName(path);
      const dotIndex = fileName.lastIndexOf('.');
      if (dotIndex === -1 || dotIndex === 0) return '';
      return fileName.substring(dotIndex);
    };

    const removeExtension = (path: string): string => {
      const ext = getExtension(path);
      if (!ext) return path;
      return path.substring(0, path.length - ext.length);
    };

    it('should get file name', () => {
      expect(getFileName('/path/to/file.txt')).toBe('file.txt');
      expect(getFileName('file.txt')).toBe('file.txt');
      expect(getFileName('/path/to/')).toBe('');
    });

    it('should get directory', () => {
      expect(getDirectory('/path/to/file.txt')).toBe('/path/to');
      expect(getDirectory('file.txt')).toBe('/');
    });

    it('should get extension', () => {
      expect(getExtension('file.txt')).toBe('.txt');
      expect(getExtension('file.test.ts')).toBe('.ts');
      expect(getExtension('file')).toBe('');
      expect(getExtension('.gitignore')).toBe('');
    });

    it('should remove extension', () => {
      expect(removeExtension('/path/to/file.txt')).toBe('/path/to/file');
      expect(removeExtension('file')).toBe('file');
    });
  });

  describe('URL Processing', () => {
    const isValidUrl = (str: string): boolean => {
      try {
        new URL(str);
        return true;
      } catch {
        return false;
      }
    };

    const getUrlHost = (url: string): string | null => {
      try {
        return new URL(url).host;
      } catch {
        return null;
      }
    };

    const getUrlPath = (url: string): string | null => {
      try {
        return new URL(url).pathname;
      } catch {
        return null;
      }
    };

    const addQueryParam = (url: string, key: string, value: string): string => {
      const urlObj = new URL(url);
      urlObj.searchParams.set(key, value);
      return urlObj.toString();
    };

    it('should validate URLs', () => {
      expect(isValidUrl('https://example.com')).toBe(true);
      expect(isValidUrl('http://localhost:3000')).toBe(true);
      expect(isValidUrl('not a url')).toBe(false);
      expect(isValidUrl('')).toBe(false);
    });

    it('should get URL host', () => {
      expect(getUrlHost('https://example.com/path')).toBe('example.com');
      expect(getUrlHost('http://localhost:3000')).toBe('localhost:3000');
    });

    it('should get URL path', () => {
      expect(getUrlPath('https://example.com/path/to/page')).toBe('/path/to/page');
      expect(getUrlPath('https://example.com')).toBe('/');
    });

    it('should add query parameters', () => {
      const result = addQueryParam('https://example.com', 'key', 'value');
      expect(result).toBe('https://example.com/?key=value');
    });
  });

  describe('Whitespace Processing', () => {
    const normalizeWhitespace = (str: string): string => {
      return str.replace(/\s+/g, ' ').trim();
    };

    const removeAllWhitespace = (str: string): string => {
      return str.replace(/\s/g, '');
    };

    const trimLines = (str: string): string => {
      return str
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
    };

    const indentLines = (str: string, spaces: number): string => {
      const indent = ' '.repeat(spaces);
      return str
        .split('\n')
        .map((line) => indent + line)
        .join('\n');
    };

    it('should normalize whitespace', () => {
      expect(normalizeWhitespace('  hello   world  ')).toBe('hello world');
      expect(normalizeWhitespace('hello\n\nworld')).toBe('hello world');
    });

    it('should remove all whitespace', () => {
      expect(removeAllWhitespace('hello world')).toBe('helloworld');
      expect(removeAllWhitespace('  a  b  c  ')).toBe('abc');
    });

    it('should trim each line', () => {
      expect(trimLines('  hello  \n  world  ')).toBe('hello\nworld');
    });

    it('should indent lines', () => {
      expect(indentLines('a\nb', 2)).toBe('  a\n  b');
    });
  });

  describe('Search and Replace', () => {
    const replaceAll = (str: string, search: string, replace: string): string => {
      return str.split(search).join(replace);
    };

    const replaceFirst = (str: string, search: string, replace: string): string => {
      const index = str.indexOf(search);
      if (index === -1) return str;
      return str.substring(0, index) + replace + str.substring(index + search.length);
    };

    const replaceLast = (str: string, search: string, replace: string): string => {
      const index = str.lastIndexOf(search);
      if (index === -1) return str;
      return str.substring(0, index) + replace + str.substring(index + search.length);
    };

    it('should replace all occurrences', () => {
      expect(replaceAll('a-b-c', '-', '_')).toBe('a_b_c');
    });

    it('should replace first occurrence', () => {
      expect(replaceFirst('a-b-c', '-', '_')).toBe('a_b-c');
    });

    it('should replace last occurrence', () => {
      expect(replaceLast('a-b-c', '-', '_')).toBe('a-b_c');
    });

    it('should handle no matches', () => {
      expect(replaceAll('abc', 'x', 'y')).toBe('abc');
      expect(replaceFirst('abc', 'x', 'y')).toBe('abc');
      expect(replaceLast('abc', 'x', 'y')).toBe('abc');
    });
  });

  describe('Comparison', () => {
    const levenshteinDistance = (a: string, b: string): number => {
      const matrix: number[][] = [];

      for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
      }

      for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
      }

      for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
          if (b.charAt(i - 1) === a.charAt(j - 1)) {
            matrix[i][j] = matrix[i - 1][j - 1];
          } else {
            matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
          }
        }
      }

      return matrix[b.length][a.length];
    };

    const similarity = (a: string, b: string): number => {
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) return 1;
      const distance = levenshteinDistance(a, b);
      return (maxLen - distance) / maxLen;
    };

    it('should calculate levenshtein distance', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
      expect(levenshteinDistance('abc', 'abc')).toBe(0);
      expect(levenshteinDistance('', 'abc')).toBe(3);
    });

    it('should calculate similarity', () => {
      expect(similarity('abc', 'abc')).toBe(1);
      expect(similarity('', '')).toBe(1);
      expect(similarity('abc', 'abd')).toBeCloseTo(0.67, 1);
    });
  });

  describe('UUID Generation', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const generateUUID = (): string => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };

    const isValidUUID = (str: string): boolean => {
      return uuidRegex.test(str);
    };

    it('should generate valid UUID', () => {
      const uuid = generateUUID();
      expect(isValidUUID(uuid)).toBe(true);
    });

    it('should generate unique UUIDs', () => {
      const uuids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        uuids.add(generateUUID());
      }
      expect(uuids.size).toBe(100);
    });

    it('should validate UUIDs', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('')).toBe(false);
    });
  });

  describe('Slug Generation', () => {
    const slugify = (str: string): string => {
      return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    };

    it('should convert to slug', () => {
      expect(slugify('Hello World')).toBe('hello-world');
      expect(slugify('JavaScript is AWESOME!')).toBe('javascript-is-awesome');
    });

    it('should handle special characters', () => {
      expect(slugify('Café & Restaurant')).toBe('cafe-restaurant');
      expect(slugify('100% Pure!')).toBe('100-pure');
    });

    it('should handle consecutive special chars', () => {
      expect(slugify('hello   world')).toBe('hello-world');
      expect(slugify('---hello---')).toBe('hello');
    });

    it('should handle empty string', () => {
      expect(slugify('')).toBe('');
    });
  });
});
