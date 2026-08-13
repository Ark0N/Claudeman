/**
 * @fileoverview Utility module exports.
 *
 * This module re-exports all utility classes and functions for easy import.
 *
 * @module utils
 */

export { BufferAccumulator } from './buffer-accumulator.js';
export { CleanupManager } from './cleanup-manager.js';
export { Debouncer, KeyedDebouncer } from './debouncer.js';
export { startEventLoopMonitor } from './event-loop-monitor.js';
export type { EventLoopMonitorHandle } from './event-loop-monitor.js';
export { StaleExpirationMap } from './stale-expiration-map.js';
export {
  ANSI_ESCAPE_PATTERN_FULL,
  ANSI_ESCAPE_PATTERN_SIMPLE,
  TOKEN_PATTERN,
  SPINNER_PATTERN,
  CLAUDE_WORKING_LINE_PATTERN,
  stripAnsi,
  SAFE_PATH_PATTERN,
  execPattern,
} from './regex-patterns.js';
export { MAX_SESSION_TOKENS } from './token-validation.js';
export { isSafePushEndpoint } from './push-endpoint-validation.js';
export { stringSimilarity, fuzzyPhraseMatch, todoContentHash } from './string-similarity.js';
export { assertNever } from './type-safety.js';
export { wrapWithNice } from './nice-wrapper.js';
export { resolveLocalShell, loginShellArgs } from './shell-resolver.js';
export { findClaudeDir, getAugmentedPath, getClaudeCliVersion, getClaudeBinaryPath } from './claude-cli-resolver.js';
export { spawnPtyWithHelperRepair } from './node-pty-repair.js';
export { resolveOpenCodeDir } from './opencode-cli-resolver.js';
export { resolveCodexDir, isCodexAvailable } from './codex-cli-resolver.js';
export { resolveGeminiDir, isGeminiAvailable } from './gemini-cli-resolver.js';
export { resolveAntigravityDir, isAntigravityAvailable } from './antigravity-cli-resolver.js';
export { resolvePiDir, isPiAvailable, getPiCliVersion } from './pi-cli-resolver.js';
