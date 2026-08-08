/**
 * @fileoverview Bounds for the agent wait primitives.
 *
 * These back the blocking endpoints an agent uses to orchestrate other sessions
 * (`GET /api/sessions/:id/wait`, `GET /api/sessions/:id/wait-output`, and the
 * `wait` field on `POST /api/sessions/:id/input`). Plan: `docs/agent-control-plan.md`.
 *
 * Why every value is bounded:
 * - An unbounded long-poll is a socket leak. A caller that asks for a 12-hour wait
 *   and walks away holds a connection (and a waiter, and a timer) until the process
 *   restarts, so `MAX_WAIT_MS` is a hard ceiling applied server-side.
 * - `DEFAULT_WAIT_MS` is deliberately short (60s). Production is reached through
 *   `tailscale serve` and users also run cloudflared tunnels; both can cut an idle
 *   connection, so the documented pattern is a client-side loop over short waits
 *   rather than one very long call. Fastify itself is happy to hold the request
 *   (`requestTimeout` defaults to 0, and `keepAliveTimeout` applies between
 *   requests, not to an in-flight one), the intermediaries are the constraint.
 * - The waiter caps mirror `MAX_SSE_CLIENTS` in `map-limits.ts`: each pending
 *   waiter costs an open HTTP response plus a timer, so the pool is capped rather
 *   than queued. Exceeding a cap is an explicit error, never a silent wait.
 * - There are THREE caps, not two, because a process-wide pool with no per-user
 *   dimension lets one user deny the primitive to everyone else. `middleware/auth.ts`
 *   already treats that shape as a bug (its `userFailures` bucket exists so "one user
 *   behind a NAT can't lock out everyone else"); `MAX_WAITERS_PER_OWNER` is the same
 *   idea for waiters. It applies only when the caller has an owner, so single-user
 *   mode is byte-identical to having no owner cap at all.
 *
 * All values are env-overridable and clamped to sane hard bounds, so a typo in an
 * env var degrades to the default instead of disabling the protection.
 *
 * @module config/agent-wait
 */

/** Absolute floor for any wait, in ms. Sub-second waits are polling, not waiting. */
export const MIN_WAIT_MS = 1_000;

/** Ceiling the operator-configurable maximum is itself clamped to. */
const HARD_MAX_WAIT_MS = 3_600_000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(min, Math.min(max, raw));
}

/** Longest a single wait may block. Requests above this are clamped down, not rejected. */
export const MAX_WAIT_MS = envInt('CODEMAN_WAIT_MAX_MS', 600_000, MIN_WAIT_MS, HARD_MAX_WAIT_MS);

/** Used when the caller omits `timeout`. Never exceeds MAX_WAIT_MS. */
export const DEFAULT_WAIT_MS = Math.min(
  envInt('CODEMAN_WAIT_DEFAULT_MS', 60_000, MIN_WAIT_MS, HARD_MAX_WAIT_MS),
  MAX_WAIT_MS
);

/** Concurrent waiters (signal + output) allowed against one session. */
export const MAX_WAITERS_PER_SESSION = envInt('CODEMAN_WAIT_MAX_PER_SESSION', 16, 1, 256);

/**
 * Ceiling the operator-configurable total is itself clamped to.
 *
 * 512 rather than the 4096 this started at. Every other knob in this file degrades
 * safely on a bad value; a 4096 ceiling instead lets a well-meaning operator turn the
 * protection into the problem, since 4096 concurrent held responses (each an open
 * socket, a timer and a pending promise) exceeds the 1024 soft `RLIMIT_NOFILE` that is
 * still the default on most Linux distros, before counting PTYs, SSE clients and
 * WebSockets. 512 is ~5x `MAX_SSE_CLIENTS` (100, the pool this one is modelled on), so
 * the knob stays useful for a busy orchestration host while the whole server still fits
 * inside a default fd budget with room to spare.
 */
const HARD_MAX_WAITERS_TOTAL = 512;

/** Concurrent waiters allowed across every session in the process. */
export const MAX_WAITERS_TOTAL = envInt('CODEMAN_WAIT_MAX_TOTAL', 128, 1, HARD_MAX_WAITERS_TOTAL);

/**
 * Concurrent waiters allowed for one owner (multi-user mode's `Session.owner`).
 *
 * Sits between the per-session cap (16) and the process-wide one (128): high enough
 * that one user orchestrating several workers at once never trips it, low enough that
 * a single user cannot occupy the whole pool and deny the primitive to everyone else,
 * admin included. Ignored entirely when the caller has no owner, which is every
 * request in single-user mode.
 */
export const MAX_WAITERS_PER_OWNER = envInt('CODEMAN_WAIT_MAX_PER_OWNER', 48, 1, HARD_MAX_WAITERS_TOTAL);

/** Bounds on the literal `match` string accepted by wait-output. */
export const MIN_MATCH_LENGTH = 1;
export const MAX_MATCH_LENGTH = 200;

/**
 * Tail of the terminal buffer scanned by `wait-output?from=buffer`.
 *
 * The buffer itself runs to 32MB. Scanning all of it would be an ANSI strip over
 * 32MB (a full second copy) on a request an agent may issue in a loop, and the
 * question `from=buffer` answers is "did this appear recently", not "ever". The
 * tail is continuous with the live stream, since `_terminalBuffer.append(data)`
 * and `emit('terminal', data)` receive the same bytes.
 */
export const MAX_BUFFER_SCAN_BYTES = envInt('CODEMAN_WAIT_BUFFER_SCAN_BYTES', 256 * 1024, 4 * 1024, 8 * 1024 * 1024);

/** Characters of surrounding output returned either side of a wait-output match. */
export const MAX_SNIPPET_CONTEXT = 80;

/**
 * Clamp a caller-supplied timeout into [MIN_WAIT_MS, MAX_WAIT_MS].
 * Absent / non-numeric / non-finite input falls back to DEFAULT_WAIT_MS.
 */
export function clampWaitMs(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_WAIT_MS;
  return Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, Math.trunc(n)));
}
