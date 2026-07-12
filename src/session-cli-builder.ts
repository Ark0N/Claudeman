/**
 * @fileoverview Pure functions for building CLI arguments and environment variables
 * for Claude and OpenCode CLI spawning.
 *
 * Extracted from Session to keep argument construction logic testable and
 * separate from PTY lifecycle management.
 *
 * @module session-cli-builder
 */

import type { ClaudeMode, EffortLevel } from './types.js';
import { isEffortLevel } from './types.js';
import { getAugmentedPath } from './utils/index.js';
import { dataPath } from './config/instance.js';

/**
 * Build Claude CLI permission flags based on the configured mode.
 * Returns an array of args to pass to the CLI.
 */
function buildPermissionArgs(claudeMode: ClaudeMode, allowedTools?: string): string[] {
  switch (claudeMode) {
    case 'dangerously-skip-permissions':
      return ['--dangerously-skip-permissions'];
    case 'allowedTools':
      if (allowedTools) {
        return ['--allowedTools', allowedTools];
      }
      // Fall back to normal mode if no tools specified
      return [];
    case 'normal':
    default:
      return [];
  }
}

/**
 * Build the CLI args carrying the effort level as a SOFT default (switchable
 * in-session via /effort). The CLAUDE_CODE_EFFORT_LEVEL env var is deliberately
 * avoided — it hard-locks effort and blocks in-session `/effort` switching.
 *
 * Two carriers are needed because neither covers all levels:
 * - regular levels (incl. `max`) → `--effort <level>` (the settings `effortLevel`
 *   key is enum(["low","medium","high","xhigh"]) with .catch(undefined), so `max`
 *   would be SILENTLY dropped there)
 * - `ultracode` → `--settings '{"ultracode":true}'` (its own boolean settings key,
 *   claude >= 2.1.154; rejected by the --effort flag)
 */
export function buildEffortCliArgs(effort?: EffortLevel): string[] {
  if (!effort || !isEffortLevel(effort)) return [];
  return effort === 'ultracode' ? ['--settings', '{"ultracode":true}'] : ['--effort', effort];
}

/**
 * Build args for an interactive Claude CLI session (direct PTY, non-mux fallback).
 *
 * @param sessionId - The Codeman session ID (passed as --session-id to Claude)
 * @param claudeMode - Permission mode for the CLI
 * @param model - Optional model override (e.g., 'opus', 'sonnet')
 * @param allowedTools - Optional comma-separated allowed tools list
 * @param effort - Optional effort level, injected via --settings (overridable in-session)
 * @returns Array of CLI arguments
 */
export function buildInteractiveArgs(
  sessionId: string,
  claudeMode: ClaudeMode,
  model?: string,
  allowedTools?: string,
  effort?: EffortLevel
): string[] {
  const args = [...buildPermissionArgs(claudeMode, allowedTools), '--session-id', sessionId];
  if (model) args.push('--model', model);
  args.push(...buildEffortCliArgs(effort));
  return args;
}

/**
 * Build args for a one-shot Claude CLI prompt (runPrompt mode).
 *
 * @param prompt - The prompt text to send
 * @param model - Optional model override
 * @returns Array of CLI arguments
 */
export function buildPromptArgs(prompt: string, model?: string): string[] {
  const args = ['-p', '--verbose', '--dangerously-skip-permissions', '--output-format', 'stream-json'];
  if (model) {
    args.push('--model', model);
  }
  args.push(prompt);
  return args;
}

/**
 * Build environment variables for Claude CLI processes (direct PTY, non-mux).
 *
 * Augments process.env with:
 * - UTF-8 locale settings
 * - Augmented PATH (includes Claude CLI directory)
 * - xterm-256color terminal type
 * - Codeman session identification vars
 *
 * @param sessionId - The Codeman session ID
 * @returns Environment variables object for pty.spawn
 */
export function buildClaudeEnv(sessionId: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    PATH: getAugmentedPath(),
    TERM: 'xterm-256color',
    // Inform Claude it's running within Codeman (helps prevent self-termination)
    CODEMAN_MUX: '1',
    CODEMAN_SESSION_ID: sessionId,
    CODEMAN_API_URL: process.env.CODEMAN_API_URL || 'http://localhost:3000',
    // Path only (not the secret value) — hook curls cat it at execution time (COD-54)
    CODEMAN_HOOK_SECRET_FILE: dataPath('hook-secret'),
  };
  // COD-115: `delete`, not `= undefined` — node-pty serializes a present-with-undefined
  // key as the literal string "KEY=undefined" (see buildMuxAttachEnv below).
  delete env.COLORTERM;
  delete env.CLAUDECODE;
  return env;
}

/**
 * Build environment variables for mux-attached PTY sessions (tmux attach).
 * Lighter than buildClaudeEnv — no PATH augmentation or Codeman vars needed
 * since the mux session already has those set.
 *
 * @param truecolorEnabled - When true, set COLORTERM=truecolor (COD-75 opt-in);
 *   otherwise leave COLORTERM unset. Mirrors buildEnvExports() so both paths agree.
 * @returns Environment variables object for pty.spawn
 */
export function buildMuxAttachEnv(truecolorEnabled?: boolean): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
  };
  // COD-115: keys to UNSET must be `delete`d, NOT set to `undefined`. On a
  // `{...process.env}` spread the key stays present with value undefined, and node-pty
  // serializes it as the literal string "TMUX=undefined" — a non-empty value that still
  // trips tmux's nesting guard, killing the attach-bridge PTY (exit 1 → respawn loop).
  // The server can be launched from inside tmux; attach clients must never inherit that
  // parent tmux context. (Same fix the working create path uses in tmux-manager.ts.)
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CLAUDECODE;
  if (truecolorEnabled) {
    env.COLORTERM = 'truecolor';
  } else {
    delete env.COLORTERM; // COD-75: unset for non-truecolor (was `: undefined`, same node-pty quirk)
  }
  return env;
}

/**
 * Build environment variables for a direct shell session (non-mux fallback).
 *
 * @param sessionId - The Codeman session ID
 * @returns Environment variables object for pty.spawn
 */
export function buildShellEnv(sessionId: string): Record<string, string | undefined> {
  return {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    CODEMAN_MUX: '1',
    CODEMAN_SESSION_ID: sessionId,
    CODEMAN_API_URL: process.env.CODEMAN_API_URL || 'http://localhost:3000',
    // Path only (not the secret value) — hook curls cat it at execution time (COD-54)
    CODEMAN_HOOK_SECRET_FILE: dataPath('hook-secret'),
  };
}
