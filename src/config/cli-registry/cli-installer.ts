/**
 * @fileoverview Auto-installs a CLI's binary the moment it is explicitly ENABLED through the
 * registry write API — closes the gap where a CLI entry can sit in the registry disabled
 * (its binary possibly never installed, since a disabled entry's availability is never
 * checked or cared about) and, once switched on, previously left the operator to go run its
 * install command by hand before the toggle did anything useful.
 *
 * Security model — this is a deliberate, narrow exception to a rule stated elsewhere in this
 * package: `discovery.install.command` used to be pure display text ("Shown verbatim in
 * 'CLI not found. Install with: ...'. NEVER executed by the server" — see the history in
 * types.ts's `CliDiscovery` doc comment, now updated to describe this module instead of
 * contradicting it). `ensureCliInstalled` is the ONE place that command is ever actually run,
 * and only when:
 *   - Called from the `PUT /api/clis/:id/enabled` route with `enabled: true` — an explicit
 *     admin action (multi-user mode is admin-gated at the route; single-user mode has one
 *     trust level, the same one that can already add/edit/remove any CLI entry, stock or
 *     custom, through this same settings surface).
 *   - NEVER from server boot, a background registry reload, or any other implicit trigger.
 *   - The exact command already shown as that entry's `installHint` in the settings UI
 *     BEFORE the toggle was flipped — nothing is invented, combined, or transformed here.
 * A custom CLI's install command is therefore executed with the same trust as the admin who
 * typed it into the "Add CLI" form in the first place; this module adds no NEW privilege,
 * it just removes the extra manual step of running that same command themselves.
 *
 * @module config/cli-registry/cli-installer
 */

import { spawn } from 'node:child_process';
import { getCli, resolveInstallCommandForPlatform } from './registry.js';
import { invalidateCliBinDirCache, resolveCliBinDir } from '../../utils/cli-resolver.js';

export type CliInstallState = 'installing' | 'success' | 'error';

export interface CliInstallStatus {
  state: CliInstallState;
  /** The exact command that ran (or is running) — never re-derived from anything else. */
  command?: string;
  /** Set on `error` only: exit code plus a bounded tail of combined stdout+stderr. */
  message?: string;
  startedAt?: number;
  finishedAt?: number;
}

/**
 * Install commands can be slow (a ~190MB standalone binary download, a cold npm registry) —
 * default 10 minutes, overridable for an unusually constrained network. Bounded 30s-1h so a
 * misconfigured value cannot make this hang the process forever or fire so fast it can never
 * succeed.
 */
function installTimeoutMs(): number {
  const raw = Number(process.env.CODEMAN_CLI_INSTALL_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 600_000;
  return Math.min(Math.max(raw, 30_000), 3_600_000);
}

const _status = new Map<string, CliInstallStatus>();

export function getCliInstallStatus(id: string): CliInstallStatus | undefined {
  return _status.get(id);
}

/** Test-only: reset all tracked install status between tests. */
export function _resetCliInstallStatusForTest(): void {
  _status.clear();
}

/**
 * Ensure `id`'s binary is installed, installing it in the background if it is not already
 * present and no install is already in flight for it. Fire-and-forget by design — the
 * calling route returns immediately with whatever status this synchronously set before the
 * child process resolves; callers observe progress via `getCliInstallStatus` (surfaced in
 * `GET /api/clis` as each entry's `installStatus`) rather than blocking on it, since an
 * install can run for minutes and a PUT request must not hang that long.
 */
export function ensureCliInstalled(id: string): void {
  const existing = _status.get(id);
  if (existing?.state === 'installing') return; // already in flight — don't double-spawn

  const entry = getCli(id);
  if (!entry || entry.discovery.binaries.length === 0) return; // unknown id, or e.g. "shell"

  if (resolveCliBinDir(id)) {
    _status.set(id, { state: 'success', finishedAt: Date.now() });
    return; // already installed — nothing to do
  }

  const command = resolveInstallCommandForPlatform(entry);
  if (!command) {
    _status.set(id, { state: 'error', message: 'No install command declared for this platform.' });
    return;
  }

  // Same posture as TmuxManager's IS_TEST_MODE (src/tmux-manager.ts): the test suite must
  // never spawn a real install command (network access, minutes-long, non-deterministic
  // across machines/CI). This is deliberately a SILENT no-op, not a fake success/error
  // status, so `_status` stays exactly as it was before this call and a test can tell the
  // two apart. Route/unit tests that need to exercise the actual spawn/timeout/output-tail
  // logic mock `node:child_process` themselves (see cli-installer.test.ts) — this guard is
  // defense-in-depth for every OTHER test that merely enables a CLI in passing.
  if (process.env.VITEST) return;

  _status.set(id, { state: 'installing', command, startedAt: Date.now() });

  let child;
  try {
    // `shell: true` is required — install commands are pipelines (`curl ... | bash`), not
    // a single argv, exactly like install.sh's own `download_to_stdout url | bash` and
    // node-pty's own historical resolution. This is the same trust boundary described in
    // the file header, not a new one: the string that runs here is byte-identical to the
    // installHint an admin already saw and to what install.sh runs for the same CLI.
    child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    _status.set(id, { state: 'error', command, message: (err as Error).message, finishedAt: Date.now() });
    return;
  }

  let output = '';
  const OUTPUT_TAIL_BYTES = 4000;
  const appendOutput = (chunk: Buffer) => {
    output += chunk.toString('utf-8');
    if (output.length > OUTPUT_TAIL_BYTES) output = output.slice(-OUTPUT_TAIL_BYTES);
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, installTimeoutMs());
  timer.unref?.(); // never keep the process alive on this alone

  child.on('error', (err) => {
    clearTimeout(timer);
    _status.set(id, { state: 'error', command, message: err.message, finishedAt: Date.now() });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    // The install command is the ground truth for "did it work", not just its exit code:
    // re-probe PATH/search-dirs afterward, and invalidate the memoized resolver first (it
    // caches a negative result forever otherwise — see invalidateCliBinDirCache's own doc).
    invalidateCliBinDirCache(id);
    const nowAvailable = resolveCliBinDir(id) !== null;
    if (code === 0 && nowAvailable) {
      _status.set(id, { state: 'success', command, finishedAt: Date.now() });
    } else {
      const tail = output.trim().slice(-500);
      _status.set(id, {
        state: 'error',
        command,
        message: `Install command exited ${code ?? 'unknown'}.${tail ? ` ${tail}` : ''}`,
        finishedAt: Date.now(),
      });
    }
  });
}
