/**
 * @fileoverview Ralph Wiggum configuration parser
 *
 * Parses the official Ralph Wiggum plugin state file (.claude/ralph-loop.local.md)
 * and extracts configuration for session tracking.
 *
 * @module ralph-config
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Pattern to extract completion phrase from CLAUDE.md
// Matches <promise>PHRASE</promise> with optional whitespace
// Allows: letters, numbers, underscores, hyphens (e.g., TESTS-PASS, ALL_DONE)
const CLAUDE_MD_PROMISE_PATTERN = /<promise>\s*([A-Z0-9_-]+)\s*<\/promise>/gi;

// Pattern to parse YAML frontmatter from ralph-loop.local.md
// Extracts key: value pairs from between --- markers
const YAML_FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---/;
const YAML_LINE_PATTERN = /^([a-zA-Z_-]+):\s*"?([^"\n]+)"?\s*$/gm;

/**
 * Ralph Loop configuration from .claude/ralph-loop.local.md
 */
export interface RalphLoopConfig {
  enabled: boolean;
  iteration: number;
  maxIterations: number | null;
  completionPromise: string | null;
}

/**
 * Parse Ralph Wiggum loop config from .claude/ralph-loop.local.md
 *
 * The official Ralph Wiggum plugin stores state in this file with YAML frontmatter:
 * ```yaml
 * ---
 * enabled: true
 * iteration: 5
 * max-iterations: 50
 * completion-promise: "COMPLETE"
 * ---
 * # Original Prompt
 * ...
 * ```
 *
 * @param workingDir - Working directory to search in
 * @returns Parsed config or null if file doesn't exist or is invalid
 */
export function parseRalphLoopConfig(workingDir: string): RalphLoopConfig | null {
  const configPath = join(workingDir, '.claude', 'ralph-loop.local.md');

  try {
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, 'utf-8');

    return parseRalphLoopConfigFromContent(content);
  } catch (err) {
    console.error(`[ralph-config] Error reading ralph-loop.local.md: ${err}`);
    return null;
  }
}

/**
 * Parse Ralph Wiggum loop config from file content.
 * Exported for testing.
 *
 * @param content - File content to parse
 * @returns Parsed config or null if content is invalid
 */
export function parseRalphLoopConfigFromContent(content: string): RalphLoopConfig | null {
  // Extract YAML frontmatter
  const frontmatterMatch = content.match(YAML_FRONTMATTER_PATTERN);
  if (!frontmatterMatch) return null;

  const yaml = frontmatterMatch[1];
  const config: RalphLoopConfig = {
    enabled: false,
    iteration: 0,
    maxIterations: null,
    completionPromise: null,
  };

  // Parse each YAML line
  let match;
  YAML_LINE_PATTERN.lastIndex = 0;
  while ((match = YAML_LINE_PATTERN.exec(yaml)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    switch (key) {
      case 'enabled':
        config.enabled = value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
        break;
      case 'iteration':
        config.iteration = parseInt(value, 10) || 0;
        break;
      case 'max-iterations':
        config.maxIterations = parseInt(value, 10) || null;
        break;
      case 'completion-promise':
        config.completionPromise = value.toUpperCase();
        break;
    }
  }

  return config;
}

/**
 * Extract completion phrase from CLAUDE.md content.
 * Looks for <promise>PHRASE</promise> pattern.
 *
 * Handles multiple variations:
 * - Raw text: <promise>PHRASE</promise>
 * - In backticks: `<promise>PHRASE</promise>`
 * - With whitespace: <promise> PHRASE </promise>
 * - Multiple occurrences: returns the first one
 *
 * @param claudeMdPath - Path to CLAUDE.md file
 * @returns The completion phrase (uppercase), or null if not found
 */
export function extractCompletionPhrase(claudeMdPath: string): string | null {
  try {
    if (!existsSync(claudeMdPath)) return null;
    const content = readFileSync(claudeMdPath, 'utf-8');

    return extractCompletionPhraseFromContent(content);
  } catch (err) {
    console.error(`[ralph-config] Error reading CLAUDE.md: ${err}`);
    return null;
  }
}

/**
 * Extract completion phrase from CLAUDE.md content string.
 * Exported for testing.
 *
 * @param content - CLAUDE.md content to parse
 * @returns The completion phrase (uppercase), or null if not found
 */
export function extractCompletionPhraseFromContent(content: string): string | null {
  // Reset regex state (global flag)
  CLAUDE_MD_PROMISE_PATTERN.lastIndex = 0;

  // Find all matches and return the first one
  const match = CLAUDE_MD_PROMISE_PATTERN.exec(content);
  if (match && match[1]) {
    return match[1].trim().toUpperCase();
  }
  return null;
}
