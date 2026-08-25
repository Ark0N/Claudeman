/**
 * @fileoverview Tests for Ralph Wiggum configuration parser
 *
 * Tests parsing of .claude/ralph-loop.local.md and CLAUDE.md
 * for Ralph loop configuration.
 */

import { describe, it, expect } from 'vitest';
import { parseRalphLoopConfigFromContent, extractCompletionPhraseFromContent } from '../src/ralph-config.js';

describe('parseRalphLoopConfigFromContent', () => {
  describe('valid YAML frontmatter', () => {
    it('should parse complete config', () => {
      const content = `---
enabled: true
iteration: 5
max-iterations: 50
completion-promise: "COMPLETE"
---
# Original Prompt

Build a REST API...
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.enabled).toBe(true);
      expect(config!.iteration).toBe(5);
      expect(config!.maxIterations).toBe(50);
      expect(config!.completionPromise).toBe('COMPLETE');
    });

    it('should parse config without quotes around values', () => {
      const content = `---
enabled: true
iteration: 10
max-iterations: 100
completion-promise: TESTS_PASS
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.completionPromise).toBe('TESTS_PASS');
    });

    it('should parse config with hyphenated completion promise', () => {
      const content = `---
enabled: true
completion-promise: "TESTS-PASS"
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.completionPromise).toBe('TESTS-PASS');
    });

    it('should handle partial config (only enabled)', () => {
      const content = `---
enabled: true
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.enabled).toBe(true);
      expect(config!.iteration).toBe(0);
      expect(config!.maxIterations).toBeNull();
      expect(config!.completionPromise).toBeNull();
    });

    it('should handle disabled state', () => {
      const content = `---
enabled: false
iteration: 25
max-iterations: 50
completion-promise: "DONE"
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.enabled).toBe(false);
      expect(config!.iteration).toBe(25);
    });

    it('should convert completion promise to uppercase', () => {
      const content = `---
completion-promise: "lower_case_phrase"
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.completionPromise).toBe('LOWER_CASE_PHRASE');
    });

    it('should handle whitespace in values', () => {
      const content = `---
enabled: true
completion-promise:   "COMPLETE"
iteration:   5
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.completionPromise).toBe('COMPLETE');
      expect(config!.iteration).toBe(5);
    });
  });

  describe('invalid content', () => {
    it('should return null for content without frontmatter', () => {
      const content = `# Just a markdown file

No YAML frontmatter here.
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).toBeNull();
    });

    it('should return null for malformed frontmatter (missing closing)', () => {
      const content = `---
enabled: true
# No closing ---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).toBeNull();
    });

    it('should return null for empty content', () => {
      const config = parseRalphLoopConfigFromContent('');

      expect(config).toBeNull();
    });

    it('should return null for empty frontmatter', () => {
      const content = `---
---
Content here.
`;

      const config = parseRalphLoopConfigFromContent(content);

      // Empty frontmatter (nothing between ---) returns null
      // because there's nothing useful to extract
      expect(config).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle zero iteration', () => {
      const content = `---
iteration: 0
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.iteration).toBe(0);
    });

    it('should handle invalid iteration as zero', () => {
      const content = `---
iteration: not-a-number
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.iteration).toBe(0);
    });

    it('should handle invalid max-iterations as null', () => {
      const content = `---
max-iterations: infinite
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.maxIterations).toBeNull();
    });

    it('should handle mixed valid and invalid values', () => {
      const content = `---
enabled: true
iteration: abc
max-iterations: 50
completion-promise: "VALID-PHRASE"
---
`;

      const config = parseRalphLoopConfigFromContent(content);

      expect(config).not.toBeNull();
      expect(config!.enabled).toBe(true);
      expect(config!.iteration).toBe(0); // Invalid falls back to 0
      expect(config!.maxIterations).toBe(50);
      expect(config!.completionPromise).toBe('VALID-PHRASE');
    });
  });
});

describe('extractCompletionPhraseFromContent', () => {
  describe('standard patterns', () => {
    it('should extract simple completion phrase', () => {
      const content = `Output <promise>COMPLETE</promise> when done.`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('COMPLETE');
    });

    it('should extract phrase with underscores', () => {
      const content = `<promise>ALL_TASKS_DONE</promise>`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('ALL_TASKS_DONE');
    });

    it('should extract phrase with hyphens', () => {
      const content = `Output <promise>TESTS-PASS</promise> when all tests green.`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('TESTS-PASS');
    });

    it('should extract phrase with numbers', () => {
      const content = `<promise>TASK_123</promise>`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('TASK_123');
    });

    it('should extract phrase with mixed characters', () => {
      const content = `<promise>TASK-123_COMPLETE</promise>`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('TASK-123_COMPLETE');
    });
  });

  describe('whitespace handling', () => {
    it('should handle whitespace inside tags', () => {
      const content = `<promise> COMPLETE </promise>`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('COMPLETE');
    });

    it('should handle newlines around phrase', () => {
      const content = `<promise>
DONE
</promise>`;

      // The pattern does match across lines since \s* includes newlines
      // This is acceptable - multi-line promises are unusual but still valid
      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('DONE');
    });
  });

  describe('case handling', () => {
    it('should convert lowercase to uppercase', () => {
      const content = `<promise>complete</promise>`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('COMPLETE');
    });

    it('should convert mixed case to uppercase', () => {
      const content = `<promise>TestsPass</promise>`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('TESTSPASS');
    });
  });

  describe('multiple occurrences', () => {
    it('should return first occurrence', () => {
      const content = `
First: <promise>FIRST_PHRASE</promise>
Second: <promise>SECOND_PHRASE</promise>
Third: <promise>THIRD_PHRASE</promise>
`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('FIRST_PHRASE');
    });
  });

  describe('in backticks', () => {
    it('should extract phrase from within backticks', () => {
      const content = 'Output `<promise>COMPLETE</promise>` when done.';

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('COMPLETE');
    });

    it('should extract phrase from code block', () => {
      const content = `
\`\`\`
<promise>DONE</promise>
\`\`\`
`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('DONE');
    });
  });

  describe('no match cases', () => {
    it('should return null when no pattern found', () => {
      const content = `Just some regular text without any promise tags.`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBeNull();
    });

    it('should return null for empty content', () => {
      const phrase = extractCompletionPhraseFromContent('');

      expect(phrase).toBeNull();
    });

    it('should return null for malformed tags', () => {
      const content = `<promise>INCOMPLETE`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBeNull();
    });

    it('should return null for empty promise', () => {
      const content = `<promise></promise>`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBeNull();
    });

    it('should return null for promise with only whitespace', () => {
      const content = `<promise>   </promise>`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBeNull();
    });
  });

  describe('real-world CLAUDE.md examples', () => {
    it('should extract from typical CLAUDE.md content', () => {
      const content = `
# CLAUDE.md

## Task

Build a REST API for user management.

## Completion Criteria

- All endpoints working
- Tests passing
- Documentation complete

Output <promise>COMPLETE</promise> when all criteria met.
`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('COMPLETE');
    });

    it('should extract from Ralph Loop section', () => {
      const content = `
## Ralph Wiggum Loop

Completion phrase: <promise>TIME_COMPLETE</promise>

Keep working until minimum duration reached.
`;

      const phrase = extractCompletionPhraseFromContent(content);

      expect(phrase).toBe('TIME_COMPLETE');
    });
  });
});
