import { describe, it, expect } from 'vitest';
import {
  isCompletionMessage,
  hasWorkingPattern,
  extractTokenCount,
  PROMPT_PATTERNS,
  WORKING_PATTERNS,
} from '../src/respawn-patterns.js';

describe('isCompletionMessage', () => {
  describe('valid completion messages', () => {
    it('should match "Worked for 2m 46s"', () => {
      expect(isCompletionMessage('Worked for 2m 46s')).toBe(true);
    });

    it('should match "Worked for 46s"', () => {
      expect(isCompletionMessage('Worked for 46s')).toBe(true);
    });

    it('should match "Worked for 1h 2m 3s"', () => {
      expect(isCompletionMessage('Worked for 1h 2m 3s')).toBe(true);
    });

    it('should match "Worked for 5m"', () => {
      expect(isCompletionMessage('Worked for 5m')).toBe(true);
    });

    it('should match "Worked for 2h"', () => {
      expect(isCompletionMessage('Worked for 2h')).toBe(true);
    });

    it('should match case-insensitively', () => {
      expect(isCompletionMessage('worked for 10s')).toBe(true);
      expect(isCompletionMessage('WORKED FOR 10s')).toBe(true);
    });

    it('should match when embedded in larger string', () => {
      expect(isCompletionMessage('Some prefix text Worked for 5m 30s and more text')).toBe(true);
    });

    it('should not match when ANSI escape codes break the word boundary', () => {
      // The regex uses \b word boundary, so ANSI codes right before "Worked"
      // break the match. In practice, data is ANSI-stripped before reaching this function.
      expect(isCompletionMessage('\x1b[32mWorked for 3m 15s\x1b[0m')).toBe(false);
    });

    it('should match ANSI-stripped output', () => {
      // After stripping ANSI codes, the pattern works fine
      expect(isCompletionMessage('Worked for 3m 15s')).toBe(true);
    });
  });

  describe('invalid patterns (should not match)', () => {
    it('should not match "wait for 5s"', () => {
      expect(isCompletionMessage('wait for 5s')).toBe(false);
    });

    it('should not match "run for 2m"', () => {
      expect(isCompletionMessage('run for 2m')).toBe(false);
    });

    it('should not match "for 3s the system..."', () => {
      expect(isCompletionMessage('for 3s the system responded')).toBe(false);
    });

    it('should not match bare time durations', () => {
      expect(isCompletionMessage('2m 46s')).toBe(false);
    });

    it('should not match empty string', () => {
      expect(isCompletionMessage('')).toBe(false);
    });

    it('should not match "Worked" without time pattern', () => {
      expect(isCompletionMessage('Worked on the task')).toBe(false);
    });

    it('should not match "Worked for" without time', () => {
      expect(isCompletionMessage('Worked for a long time')).toBe(false);
    });
  });
});

describe('hasWorkingPattern', () => {
  describe('text working indicators', () => {
    it('should detect "Thinking" in window', () => {
      expect(hasWorkingPattern('Claude is Thinking about your request')).toBe(true);
    });

    it('should detect "Writing" in window', () => {
      expect(hasWorkingPattern('Writing to file src/main.ts')).toBe(true);
    });

    it('should detect "Reading" in window', () => {
      expect(hasWorkingPattern('Reading file contents')).toBe(true);
    });

    it('should detect "Running" in window', () => {
      expect(hasWorkingPattern('Running npm install')).toBe(true);
    });

    it('should detect "Searching" in window', () => {
      expect(hasWorkingPattern('Searching for patterns')).toBe(true);
    });

    it('should detect "Editing" in window', () => {
      expect(hasWorkingPattern('Editing src/utils.ts')).toBe(true);
    });

    it('should detect all defined text patterns', () => {
      const textPatterns = WORKING_PATTERNS.filter((p) => p.length > 2);
      for (const pattern of textPatterns) {
        expect(hasWorkingPattern(`Some text with ${pattern} in it`)).toBe(true);
      }
    });
  });

  describe('current Claude status line', () => {
    it('should detect the randomized gerund by the elapsed timer', () => {
      // Live captures on Claude Code 2.1.220. The word changes every turn, so the
      // WORKING_PATTERNS list above cannot see any of these.
      expect(hasWorkingPattern('✻ Actualizing… (15m 17s · ↓ 47.5k tokens)')).toBe(true);
      expect(hasWorkingPattern('· Finagling… (4m 45s · ↓ 13.3k tokens)')).toBe(true);
      expect(hasWorkingPattern('✽ Herding… (3s · esc to interrupt)')).toBe(true);
    });

    it('should NOT treat the completion line as working', () => {
      expect(hasWorkingPattern('✻ Cooked for 2m 49s')).toBe(false);
      expect(hasWorkingPattern('✻ Brewed for 18m 41s')).toBe(false);
    });
  });

  describe('spinner characters', () => {
    it('should detect braille spinner characters', () => {
      expect(hasWorkingPattern('Loading... \u280B')).toBe(true);
      expect(hasWorkingPattern('\u2839 processing')).toBe(true);
    });

    it('should detect circle spinner characters', () => {
      expect(hasWorkingPattern('\u25D0 working')).toBe(true);
      expect(hasWorkingPattern('status: \u25D3')).toBe(true);
    });

    it('should detect braille block spinners', () => {
      expect(hasWorkingPattern('\u28FE loading')).toBe(true); // ⣾
      expect(hasWorkingPattern('\u28FD processing')).toBe(true); // ⣽
    });
  });

  describe('negative cases', () => {
    it('should return false for empty string', () => {
      expect(hasWorkingPattern('')).toBe(false);
    });

    it('should return false for prompt characters only', () => {
      expect(hasWorkingPattern('\u276F ')).toBe(false);
    });

    it('should return false for regular output text', () => {
      expect(hasWorkingPattern('Here is the result of the computation')).toBe(false);
    });

    it('should return false for completion messages', () => {
      expect(hasWorkingPattern('Worked for 2m 46s')).toBe(false);
    });
  });
});

describe('extractTokenCount', () => {
  describe('basic token patterns', () => {
    it('should extract plain number tokens', () => {
      expect(extractTokenCount('500 tokens')).toBe(500);
    });

    it('should extract decimal number tokens', () => {
      expect(extractTokenCount('123.4 tokens')).toBe(123);
    });

    it('should extract k suffix (thousands)', () => {
      expect(extractTokenCount('123.4k tokens')).toBe(123400);
    });

    it('should extract K suffix (uppercase)', () => {
      expect(extractTokenCount('50K tokens')).toBe(50000);
    });

    it('should extract m suffix (millions)', () => {
      expect(extractTokenCount('1.5m tokens')).toBe(1500000);
    });

    it('should extract M suffix (uppercase)', () => {
      expect(extractTokenCount('2M tokens')).toBe(2000000);
    });

    it('should handle whitespace between number and suffix', () => {
      expect(extractTokenCount('123.4 k tokens')).toBe(123400);
    });
  });

  describe('embedded in text', () => {
    it('should extract from terminal output', () => {
      expect(extractTokenCount('Current usage: 45.2k tokens remaining')).toBe(45200);
    });

    it('should extract from completion message', () => {
      expect(extractTokenCount('Worked for 2m 46s | 150.3k tokens used')).toBe(150300);
    });
  });

  describe('negative cases', () => {
    it('should return null for empty string', () => {
      expect(extractTokenCount('')).toBeNull();
    });

    it('should return null for string without token pattern', () => {
      expect(extractTokenCount('Hello world')).toBeNull();
    });

    it('should return null for "tokens" without a number', () => {
      expect(extractTokenCount('many tokens')).toBeNull();
    });
  });

  describe('rounding', () => {
    it('should round to nearest integer', () => {
      // 1.7k = 1700 (exact, no rounding needed)
      expect(extractTokenCount('1.7k tokens')).toBe(1700);
    });

    it('should round fractional results', () => {
      // 1.23456k = 1234.56 -> rounds to 1235
      expect(extractTokenCount('1.23456k tokens')).toBe(1235);
    });
  });
});

describe('PROMPT_PATTERNS', () => {
  it('should contain standard prompt characters', () => {
    expect(PROMPT_PATTERNS).toContain('\u276F'); // Unicode right-pointing angle
    expect(PROMPT_PATTERNS).toContain('\u23F5'); // Play button variant
  });

  it('should be a non-empty array', () => {
    expect(PROMPT_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('WORKING_PATTERNS', () => {
  it('should be a non-empty array', () => {
    expect(WORKING_PATTERNS.length).toBeGreaterThan(0);
  });

  it('should contain common Claude activity indicators', () => {
    expect(WORKING_PATTERNS).toContain('Thinking');
    expect(WORKING_PATTERNS).toContain('Writing');
    expect(WORKING_PATTERNS).toContain('Reading');
    expect(WORKING_PATTERNS).toContain('Running');
  });

  it('should contain spinner characters', () => {
    expect(WORKING_PATTERNS).toContain('\u280B');
    expect(WORKING_PATTERNS).toContain('\u2819');
  });

  it('should not contain completion indicators like stars', () => {
    // Per source comment: "Note: \u273B and \u273D removed - they appear in completion messages too."
    expect(WORKING_PATTERNS).not.toContain('\u273B');
    expect(WORKING_PATTERNS).not.toContain('\u273D');
  });
});
