/**
 * @fileoverview Cloudflare tunnel and QR authentication constants.
 *
 * Controls QR token rotation timing, rate limiting,
 * and tunnel process lifecycle.
 *
 * @module config/tunnel-config
 */

// ============================================================================
// QR Token Rotation
// ============================================================================

/** QR token auto-rotation interval (ms) */
export const QR_TOKEN_TTL_MS = 60_000;

/** Grace period — previous token still valid during rotation (ms) */
export const QR_TOKEN_GRACE_MS = 90_000;

/** Length of the short code in QR URL path (chars) */
export const SHORT_CODE_LENGTH = 6;

// ============================================================================
// QR Rate Limiting
// ============================================================================

/** Global rate limit for QR auth attempts across all IPs */
export const QR_RATE_LIMIT_MAX = 30;

/** QR rate limit reset window (ms) */
export const QR_RATE_LIMIT_WINDOW_MS = 60_000;

/** Per-IP rate limit for QR auth failures (separate from Basic Auth AUTH_FAILURE_MAX) */
export const QR_AUTH_FAILURE_MAX = 10;

// ============================================================================
// Tunnel Process Lifecycle
// ============================================================================

/** Max time to wait for cloudflared URL before timeout (ms) */
export const URL_TIMEOUT_MS = 30_000;

/** Restart delay after unexpected tunnel exit (ms) */
export const RESTART_DELAY_MS = 5_000;

/** SIGTERM → SIGKILL escalation timeout (ms) */
export const FORCE_KILL_MS = 5_000;
