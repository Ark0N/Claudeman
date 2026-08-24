/**
 * @fileoverview The DeepSeek Harness -> Codeman status bridge.
 *
 * ## Why this exists
 *
 * Every external CLI mode before this one (opencode, codex, gemini, antigravity,
 * pi, grok) is READINESS-GUESSED: Codeman watches the PTY go quiet and infers a
 * turn ended. Claude is the exception, because Claude Code fires real hooks. The
 * DeepSeek Harness TUI gives us a third option, and a much better one than
 * guessing: the community terminal front door already reports its own lifecycle
 * to an owning supervisor, and it does so through a fully GENERIC, env-var-gated
 * contract it inherited from Herdr (herdr.dev).
 *
 * When all three of `HERDR_ENV=1`, `HERDR_BIN_PATH` and `HERDR_PANE_ID` are set,
 * the TUI shells out on every state change:
 *
 *     "$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
 *         --source custom:dsh-tui --agent dsh-tui \
 *         --state idle|working|blocked [--message <text>] --seq <n>
 *
 * and treats exit code 0 as "delivered" (retrying with backoff otherwise). So
 * Codeman points `HERDR_BIN_PATH` at the script below and gets DEFINITIVE
 * idle/working/blocked signals for dsh sessions: real respawn triggers, real
 * `wait`/`wait-output` stop+blocked signals, and real Approvals Inbox items,
 * on par with Claude's hooks rather than with output stabilization.
 *
 * This is an interface implementation, not an impersonation: we implement the
 * one verb (`pane report-agent`) that the contract defines, and nothing on the
 * machine ever executes a real `herdr` binary — `HERDR_BIN_PATH` is our own
 * script, in our own data dir. `HERDR_ENV=1` is the flag the TUI checks to know
 * a supervisor is present; a supervisor IS present, it is Codeman.
 *
 * ## Why it is generated rather than committed
 *
 * The shim must be an executable file at a stable absolute path in every
 * install shape: a git clone (where `scripts/` exists), an `npm i -g aicodeman`
 * (where `files` ships only `dist` plus two named scripts), and any
 * `CODEMAN_INSTANCE`. Writing it into the data dir at session-create time makes
 * one code path cover all of them, single-sources the content here in TS, and
 * follows the precedent of `self-update-runner.sh`. It is rewritten whenever the
 * embedded version marker changes, so an upgraded Codeman refreshes a stale shim
 * without the user knowing it exists.
 *
 * @module deepseek-status-shim
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './config/instance.js';

/**
 * Bumped whenever SHIM_SOURCE changes. The marker is embedded in the generated
 * file, so `ensureDeepSeekStatusShim()` can tell a current shim from one written
 * by an older Codeman and rewrite only when needed (rather than rewriting on
 * every session create, or — worse — leaving a stale one in place forever).
 */
const SHIM_VERSION = 1;
const SHIM_MARKER = `codeman-dsh-status-shim v${SHIM_VERSION}`;

/**
 * Mapping from the harness's three lifecycle states to Codeman hook events.
 *
 * - `blocked` -> `permission_prompt`: the TUI reports blocked when a tool
 *   approval or an `ask_user_question` questionnaire is on screen, which is
 *   exactly the red "needs you" alert and an answerable Approvals Inbox item.
 * - `idle` -> `stop`: the definitive end-of-turn signal, the one respawn and the
 *   wait endpoints care about.
 * - `working` -> `agent_working`: a turn STARTED. Codeman infers "working" from
 *   PTY output well enough on its own, but the event is what RESOLVES a pending
 *   approval when the user answers a dialog in the terminal instead of in the
 *   inbox. Without it a dsh session's red alert would survive until the next
 *   `stop`, which is the exact stuck-alert bug the claude path already had to
 *   fix once (and the pane-capture staleness sweep that fixed it there is
 *   Claude-dialog-shaped, so it cannot help here).
 */
export const DEEPSEEK_STATE_TO_HOOK_EVENT: Readonly<Record<string, string>> = Object.freeze({
  idle: 'stop',
  blocked: 'permission_prompt',
  working: 'agent_working',
});

/**
 * The generated script.
 *
 * Constraints it must satisfy, each learned from an existing Codeman hook bug:
 * - **TLS**: `CODEMAN_API_URL` is loopback HTTPS with a self-signed cert on
 *   `--https`/tailscale installs, so certificate verification is disabled for
 *   the request. Without this the whole bridge dies silently, exactly as the
 *   claude hook curls did before they grew `-k`.
 * - **Secret**: the hook-secret file is read AT EXECUTION TIME, never baked in,
 *   so rotation needs no respawn and the value never lands on a command line.
 * - **Exit codes**: 0 means delivered. Anything else makes the TUI retry with
 *   backoff, so transport failures self-heal, but an unknown verb or an
 *   unmapped state exits 0 to avoid a pointless retry storm over something that
 *   will never succeed.
 * - **Timeout**: bounded below the caller's own 2s budget, so we lose the race
 *   deliberately rather than being killed mid-flight.
 */
const SHIM_SOURCE = `#!/usr/bin/env node
// ${SHIM_MARKER}
// GENERATED BY CODEMAN — do not edit. Rewritten from src/deepseek-status-shim.ts
// whenever its version marker changes.
//
// Implements the one verb the DeepSeek Harness TUI's supervisor contract uses:
//   pane report-agent <paneId> --state <idle|working|blocked> [--message <t>] ...
// and forwards it to this Codeman instance as a hook event.
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

const STATE_TO_EVENT = ${JSON.stringify(DEEPSEEK_STATE_TO_HOOK_EVENT)}
const TIMEOUT_MS = 1500

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

// Unknown verb: succeed silently. Retrying could never make it succeed, and a
// non-zero exit here would make the caller retry four times per state change.
if (argv[0] !== 'pane' || argv[1] !== 'report-agent') process.exit(0)

const event = STATE_TO_EVENT[String(flag('--state') ?? '')]
if (!event) process.exit(0)

// The pane id we hand the TUI IS the Codeman session id, but prefer the ambient
// env: it is set by the same code that set HERDR_PANE_ID and cannot be spoofed
// by an argument the agent itself could influence.
const sessionId = process.env.CODEMAN_SESSION_ID || argv[2]
const apiUrl = process.env.CODEMAN_API_URL
if (!sessionId || !apiUrl) process.exit(1)

let secret = ''
try {
  secret = readFileSync(process.env.CODEMAN_HOOK_SECRET_FILE || '', 'utf-8').trim()
} catch {
  // Missing file: the loopback bypass still applies when no tunnel is running.
}

const body = JSON.stringify({
  event,
  sessionId,
  data: {
    source: 'dsh-status-shim',
    agent: flag('--agent') || 'dsh',
    ...(flag('--message') ? { message: flag('--message') } : {}),
  },
})

let url
try {
  url = new URL('/api/hook-event', apiUrl)
} catch {
  process.exit(1)
}

const transport = url.protocol === 'https:' ? https : http
const req = transport.request(
  {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Codeman-Hook-Secret': secret,
    },
    // Loopback HTTPS with a self-signed cert (--https / tailscale installs).
    rejectUnauthorized: false,
  },
  (res) => {
    res.resume()
    process.exit(res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1)
  }
)
req.on('timeout', () => {
  req.destroy()
  process.exit(1)
})
req.on('error', () => process.exit(1))
req.end(body)
`;

/** Absolute path of the generated shim for this instance. */
export function deepSeekStatusShimPath(): string {
  return dataPath('dsh-status-shim.mjs');
}

let ensuredThisProcess = false;

/**
 * Write the shim if it is missing or stale, and return its path.
 *
 * Idempotent and cheap: after the first call in a process it does nothing, and
 * even the first call only rewrites when the on-disk marker differs. Never
 * throws — a data dir that cannot be written is a degraded status bridge, not a
 * failed session start, so callers fall back to output-stabilization readiness
 * by receiving null.
 */
export function ensureDeepSeekStatusShim(): string | null {
  const path = deepSeekStatusShimPath();
  if (ensuredThisProcess) return path;
  try {
    let current = '';
    try {
      current = readFileSync(path, 'utf-8');
    } catch {
      // Missing — fall through to the write.
    }
    if (!current.includes(SHIM_MARKER)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, SHIM_SOURCE, { mode: 0o700 });
    }
    // Re-assert the mode even when the content matched: a shim that lost its
    // executable bit (a restored backup, a copied data dir) would make every
    // report fail, and the TUI would retry four times per state change forever.
    chmodSync(path, 0o700);
    ensuredThisProcess = true;
    return path;
  } catch (err) {
    console.warn(`[DeepSeek] Could not install the status shim at ${path}: ${(err as Error).message}`);
    return null;
  }
}

/** Test seam: forget the per-process memo so a fresh temp HOME is re-provisioned. */
export function resetDeepSeekStatusShimForTest(): void {
  ensuredThisProcess = false;
}
