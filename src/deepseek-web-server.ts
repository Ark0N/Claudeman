/**
 * @fileoverview Supervises the one background `dsh web` process behind the Run
 * menu's "DeepSeek web UI..." entry.
 *
 * The shortcut originally started the server inside an ordinary SHELL SESSION,
 * on the reasoning that Codeman already knows how to supervise those: it was
 * visible, scrollable, killable, and died with its tab, and nothing new had to
 * own a long-lived HTTP server. That reasoning was sound and the result was
 * still wrong in use — clicking "open the DeepSeek web UI" spawned a terminal
 * tab the user never asked for, next to the web tab they did, and the terminal
 * was noise every time after the first.
 *
 * So the server moves here instead: one child process, no session, no tab.
 * What that buys back has to be paid for explicitly, which is what this module
 * is:
 *
 * - **Exactly one.** A second click reuses the running server rather than
 *   racing it for a port. The old shell-session flow could not do this at all,
 *   because two clicks were simply two sessions.
 * - **Restarted when the authority changes.** `--trusted-host` fences dsh's
 *   `/api` against the browser authority, and a Codeman reachable at both
 *   loopback and a tailnet name has two. Whoever asks last wins, because the
 *   asker is by definition the origin about to load the page.
 * - **Killed on shutdown.** A detached child that outlived Codeman would hold
 *   its port against the next start, which is exactly the EADDRINUSE this
 *   feature already got wrong once.
 * - **Failures reported, not swallowed.** The shell tab used to be where the
 *   stack trace landed. With no tab, the spawn's own output is captured and
 *   handed back to the caller instead.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { getErrorMessage } from './types.js';

/**
 * Where the port search starts, and how far it walks.
 *
 * 3080 is `dsh web`'s own default, so it is the friendly first choice — and
 * emphatically not a fixed port. DeepSeek's web UI is a thing users run
 * themselves, which makes the default precisely the port most likely to be
 * taken already; hardcoding it made this feature die with EADDRINUSE against
 * the user's own server.
 */
const PORT_BASE = 3080;
const PORT_SPAN = 40;

/** How long a freshly spawned server gets to answer before we call it failed. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 400;
/** Grace between SIGTERM and SIGKILL when stopping the tree. */
const KILL_GRACE_MS = 3_000;
/** Bound on captured child output, so a chatty boot cannot grow without limit. */
const OUTPUT_CAP = 16_384;

export interface DeepSeekWebStatus {
  running: boolean;
  port: number | null;
  url: string | null;
  /** Browser authority this server was started to trust (`--trusted-host`). */
  authority: string | null;
}

interface RunningServer {
  child: ChildProcess;
  port: number;
  authority: string;
  output: () => string;
}

let current: RunningServer | null = null;

/**
 * True when nothing holds `port` on loopback.
 *
 * Binding is the only honest test: a connect probe cannot tell "free" from
 * "listening but not answering yet", and this runs moments before `dsh web`
 * binds the same port. It is inherently racy, which is why the caller still
 * waits for the server to actually answer before reporting success.
 */
async function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function findFreePort(): Promise<number | null> {
  for (let port = PORT_BASE; port < PORT_BASE + PORT_SPAN; port++) {
    if (await isLoopbackPortFree(port)) return port;
  }
  return null;
}

/** Does the server answer HTTP yet? Any status counts: dsh may 4xx a bare GET. */
async function answersHttp(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal the whole process group.
 *
 * `dsh web` boots a plugin tree and fans out, so signalling only the direct
 * child leaves survivors holding the port. Same negative-pid escalation as
 * `runGit()` in git-clone.ts and the profile installer.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function getDeepSeekWebStatus(): DeepSeekWebStatus {
  if (!current) return { running: false, port: null, url: null, authority: null };
  return {
    running: true,
    port: current.port,
    url: `http://127.0.0.1:${current.port}`,
    authority: current.authority,
  };
}

/** Stop the background server, if one is running. Safe to call when none is. */
export async function stopDeepSeekWeb(): Promise<void> {
  const running = current;
  current = null;
  if (!running) return;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      resolve();
    };
    running.child.once('exit', finish);
    killTree(running.child, 'SIGTERM');
    const hard = setTimeout(() => {
      killTree(running.child, 'SIGKILL');
      finish();
    }, KILL_GRACE_MS);
  });
}

/**
 * Start (or reuse) the background `dsh web` for `authority`.
 *
 * @param dshDir directory holding the resolved `dsh` binary.
 * @param authority browser authority to pass as `--trusted-host`.
 */
export async function startDeepSeekWeb(
  dshDir: string,
  authority: string
): Promise<{ ok: true; port: number; url: string; reused: boolean } | { ok: false; error: string }> {
  // Reuse only when the running server is BOTH healthy and fenced for the
  // authority now asking. A server trusting the other origin renders a page
  // whose every API call 403s, which looks like a broken dashboard rather than
  // a misconfigured one.
  if (current) {
    if (current.authority === authority && (await answersHttp(current.port))) {
      return { ok: true, port: current.port, url: `http://127.0.0.1:${current.port}`, reused: true };
    }
    await stopDeepSeekWeb();
  }

  const port = await findFreePort();
  if (port === null) {
    return { ok: false, error: `No free port for the DeepSeek web UI in ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}` };
  }

  let child: ChildProcess;
  try {
    child = spawn(
      join(dshDir, 'dsh'),
      ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port), '--trusted-host', authority],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so the whole plugin tree can be signalled at once.
        detached: true,
        env: process.env,
      }
    );
  } catch (err) {
    return { ok: false, error: `Failed to start dsh web: ${getErrorMessage(err)}` };
  }

  // The pipes must be drained whether or not anyone reads them: a full pipe
  // blocks the child. Storage is capped; draining is not.
  let output = '';
  const capture = (chunk: Buffer) => {
    if (output.length < OUTPUT_CAP) output += chunk.toString('utf-8');
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  let exited = false;
  child.once('exit', () => {
    exited = true;
    // Only clear if this is still the current server: a restart may have
    // already replaced it, and clearing then would drop the live one.
    if (current?.child === child) current = null;
  });
  child.once('error', () => {
    exited = true;
    if (current?.child === child) current = null;
  });

  const running: RunningServer = { child, port, authority, output: () => output };
  current = running;

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      current = null;
      const tail = output.trim().slice(-800);
      return { ok: false, error: tail ? `dsh web exited during startup: ${tail}` : 'dsh web exited during startup' };
    }
    if (await answersHttp(port)) {
      return { ok: true, port, url: `http://127.0.0.1:${port}`, reused: false };
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }

  await stopDeepSeekWeb();
  const tail = output.trim().slice(-800);
  return {
    ok: false,
    error: tail
      ? `dsh web did not answer on port ${port} within ${READY_TIMEOUT_MS / 1000}s: ${tail}`
      : `dsh web did not answer on port ${port} within ${READY_TIMEOUT_MS / 1000}s`,
  };
}

/** Test seam: forget any tracked child without signalling it. */
export function resetDeepSeekWebForTest(): void {
  current = null;
}
