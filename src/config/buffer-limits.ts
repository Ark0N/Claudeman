/**
 * @fileoverview Centralized buffer size limits for memory management.
 *
 * These constants define the maximum sizes for various buffers throughout
 * Codeman. Consolidating them here ensures consistent limits and makes
 * it easy to tune memory usage.
 *
 * Memory Budget Rationale (for 20 concurrent sessions):
 * - Terminal buffer: 32MB max × 20 = 640MB worst case
 * - Text output: 1MB max × 20 = 20MB worst case
 * - Messages: ~1KB each × 1000 × 20 = 20MB worst case
 *
 * @module config/buffer-limits
 */

import { DEFAULT_TERMINAL_BUFFER_MAX_BYTES, DEFAULT_TERMINAL_BUFFER_TRIM_BYTES } from './terminal-history.js';

// ============================================================================
// Terminal Buffer Limits
// ============================================================================

/**
 * Maximum terminal buffer size in characters.
 * Contains raw terminal output with ANSI escape sequences.
 * Sourced from terminal-history config (env/settings overridable).
 * Override: CODEMAN_MAX_TERMINAL_BUFFER (bytes)
 */
export const MAX_TERMINAL_BUFFER_SIZE = DEFAULT_TERMINAL_BUFFER_MAX_BYTES;

/**
 * Size to trim terminal buffer to when max is exceeded.
 * Keeps the most recent portion to preserve context.
 * Override: CODEMAN_TRIM_TERMINAL_TO (bytes)
 */
export const TRIM_TERMINAL_TO = DEFAULT_TERMINAL_BUFFER_TRIM_BYTES;

// ============================================================================
// Text Output Buffer Limits
// ============================================================================

/**
 * Maximum text output buffer size in characters.
 * Contains ANSI-stripped text for search and analysis.
 * Override: CODEMAN_MAX_TEXT_OUTPUT (bytes)
 */
export const MAX_TEXT_OUTPUT_SIZE = parseInt(process.env.CODEMAN_MAX_TEXT_OUTPUT || '') || 1 * 1024 * 1024;

/**
 * Size to trim text output buffer to when max is exceeded.
 * Override: CODEMAN_TRIM_TEXT_TO (bytes)
 */
export const TRIM_TEXT_TO = parseInt(process.env.CODEMAN_TRIM_TEXT_TO || '') || 768 * 1024;

// ============================================================================
// Message Buffer Limits
// ============================================================================

/**
 * Maximum number of Claude JSON messages to keep in memory per session.
 * Older messages are discarded when limit is exceeded.
 * Override: CODEMAN_MAX_MESSAGES (count)
 */
export const MAX_MESSAGES = parseInt(process.env.CODEMAN_MAX_MESSAGES || '') || 1000;

// ============================================================================
// Line Buffer Limits
// ============================================================================

/**
 * Maximum line buffer size in characters.
 * Prevents unbounded growth for extremely long lines without newlines.
 */
export const MAX_LINE_BUFFER_SIZE = 64 * 1024; // 64KB

// ============================================================================
// Respawn Controller Buffer Limits
// ============================================================================

/**
 * Maximum respawn controller buffer size.
 * Smaller than session buffer since it's only used for idle detection.
 */
export const MAX_RESPAWN_BUFFER_SIZE = 1 * 1024 * 1024; // 1MB

/**
 * Size to trim respawn buffer to when max is exceeded.
 */
export const TRIM_RESPAWN_BUFFER_TO = 512 * 1024; // 512KB

// ============================================================================
// File Peek Limits
// ============================================================================

/**
 * Maximum bytes to read when peeking at the beginning of a file.
 * Used with `createReadStream({ end })` (inclusive) to read the first 8KB,
 * which is enough to extract metadata from the first few JSONL lines.
 */
export const FILE_PEEK_BYTES = 8 * 1024 - 1; // 8KB (inclusive end offset)

// ============================================================================
// Paste-Image Upload Limits
// ============================================================================

/**
 * Maximum size (bytes) of a single image uploaded via POST
 * /api/sessions/:id/paste-image. The mobile picker / drag-drop / paste paths
 * send one file per request (the client uploads up to MAX_PASTE_IMAGES of them
 * per batch), so this caps each individual file, not the batch. Generous enough
 * for full-resolution phone photos and large screenshots; the client downscales
 * very large images before upload, so legitimate uploads land well under this.
 * Override: CODEMAN_MAX_PASTE_IMAGE_BYTES (bytes)
 */
export const MAX_PASTE_IMAGE_BYTES = parseInt(process.env.CODEMAN_MAX_PASTE_IMAGE_BYTES || '') || 50 * 1024 * 1024; // 50MB
