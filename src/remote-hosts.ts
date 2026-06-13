import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  RemoteCase,
  RemoteCommandMode,
  RemoteHost,
  RemoteSshOptions,
  SessionMode,
  SessionRemote,
} from './types.js';

const execAsync = promisify(exec);

const REMOTE_HOSTS_FILE = 'remote-hosts.json';
const REMOTE_CASES_FILE = 'remote-cases.json';

export function remoteHostsPath(configDir: string): string {
  return join(configDir, REMOTE_HOSTS_FILE);
}

export function remoteCasesPath(configDir: string): string {
  return join(configDir, REMOTE_CASES_FILE);
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(configDir: string, path: string, value: T[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

export async function readRemoteHosts(configDir: string): Promise<RemoteHost[]> {
  return readJsonArray<RemoteHost>(remoteHostsPath(configDir));
}

export async function writeRemoteHosts(configDir: string, hosts: RemoteHost[]): Promise<void> {
  await writeJsonArray(configDir, remoteHostsPath(configDir), hosts);
}

export async function readRemoteCases(configDir: string): Promise<RemoteCase[]> {
  return readJsonArray<RemoteCase>(remoteCasesPath(configDir));
}

export async function writeRemoteCases(configDir: string, cases: RemoteCase[]): Promise<void> {
  await writeJsonArray(configDir, remoteCasesPath(configDir), cases);
}

export function defaultRemoteCommandForMode(mode: SessionMode): string {
  const commands: Record<RemoteCommandMode, string> = {
    shell: 'exec bash -l',
    // Mirror the LOCAL claude default so the remote agent runs non-interactively
    // (no trust-folder/permission prompt that nothing on the remote answers). The
    // per-host `commands.claude` override stays the escape hatch.
    claude: 'exec claude --dangerously-skip-permissions',
    opencode: 'exec opencode',
    codex: 'exec codex',
    gemini: 'exec gemini',
  };
  return commands[mode as RemoteCommandMode] || commands.shell;
}

export function remoteSshTarget(host: Pick<RemoteHost, 'username' | 'host'>): string {
  return `${host.username}@${host.host}`;
}

/**
 * POSIX single-quote shell-escaping (end-quote, escaped-quote, restart-quote).
 * Mirrors the helper in tmux-manager.ts so a value with spaces/metachars stays a
 * single shell token. Used here for identity paths and `-o KEY=VALUE` options.
 */
function shellescape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Expand a leading `~` or `$HOME` in an identity path to an absolute path.
 *
 * ssh does NOT expand `~` inside `-i` (the shell would, but we shellescape the
 * value into a single quoted token so the shell never sees it). So we expand at
 * build time, before escaping. Non-`~`/`$HOME` paths are returned unchanged.
 */
function expandIdentityPath(identityFile: string): string {
  if (identityFile === '~') return homedir();
  if (identityFile.startsWith('~/')) return join(homedir(), identityFile.slice(2));
  if (identityFile === '$HOME') return homedir();
  if (identityFile.startsWith('$HOME/')) return join(homedir(), identityFile.slice('$HOME/'.length));
  return identityFile;
}

/**
 * COD-107 — build the ordered, shell-safe ssh CONNECTION tokens shared by both
 * the durable-launch command (`buildRemoteLaunchCommand`) and the tmux
 * prerequisite probe (`buildRemoteTmuxCheckCommand`), so the prereq check and
 * the real launch connect with IDENTICAL options (they can't drift).
 *
 * Returns the leading tokens of an ssh command line (NOT including `-t`, the
 * target, or any remote command). Order:
 *   ssh -o BatchMode=yes
 *       [-o ConnectTimeout=10]           (default; suppressed if extraSshOptions sets it)
 *       [-p <port>]
 *       [-i <abs-identity>]              (~/$HOME expanded, then shellescaped)
 *       [-J <jumpHost>]                  (shellescaped, single token)
 *       [-o ProxyCommand=nc -X 5 -x <socks> %h %p]   (ONE shellescaped -o token)
 *       [-o <KEY=VALUE>] …               (each extra option, shellescaped)
 *
 * Escaping notes (the risky part):
 *  - The ProxyCommand is emitted as a single shellescaped `-o KEY=VALUE`, so the
 *    whole value (spaces + `%h`/`%p`) reaches ssh as one argument and `%h %p`
 *    survive verbatim — ssh expands them to the real host/port, not the shell.
 *  - A default `-o ConnectTimeout=10` bounds the wait on an unreachable/blackholed
 *    host (else the pane hangs on the OS TCP timeout). It is omitted when the
 *    operator already set ConnectTimeout via extraSshOptions, so their value wins.
 */
export function buildSshConnectionArgs(remote: RemoteSshOptions & Pick<RemoteHost, 'port'>): string[] {
  const parts: string[] = ['ssh', '-o BatchMode=yes'];
  const hasConnectTimeout = (remote.extraSshOptions ?? []).some((opt) => /^ConnectTimeout=/i.test(opt));
  if (!hasConnectTimeout) parts.push('-o ConnectTimeout=10');
  if (remote.port) parts.push(`-p ${remote.port}`);
  if (remote.identityFile) parts.push(`-i ${shellescape(expandIdentityPath(remote.identityFile))}`);
  if (remote.jumpHost) parts.push(`-J ${shellescape(remote.jumpHost)}`);
  if (remote.socksProxy) {
    parts.push(`-o ${shellescape(`ProxyCommand=nc -X 5 -x ${remote.socksProxy} %h %p`)}`);
  }
  for (const opt of remote.extraSshOptions ?? []) {
    parts.push(`-o ${shellescape(opt)}`);
  }
  return parts;
}

/**
 * COD-104 — build the SSH command that checks the remote host has tmux.
 *
 * Durable remote sessions run the agent inside a tmux server ON the remote host
 * (`tmux -L codeman new-session -A …`), so tmux is now a hard prerequisite there.
 * `command -v tmux` exits 0 (and prints the path) when tmux is installed.
 *
 * COD-107 — connects with the SAME options as the real launch
 * (`buildSshConnectionArgs`) so a proxied/custom-port/identity host that the
 * launch can reach also passes the prereq probe (and vice-versa).
 */
export function buildRemoteTmuxCheckCommand(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): string {
  // ConnectTimeout is now a default of buildSshConnectionArgs (shared with the launch).
  return [...buildSshConnectionArgs(host), remoteSshTarget(host), "'command -v tmux'"].join(' ');
}

export interface RemoteTmuxCheckResult {
  ok: boolean;
  /** Resolved tmux path on the remote (when ok). */
  tmuxPath?: string;
  /** Human-readable failure reason (when !ok). */
  error?: string;
}

/**
 * COD-104 — verify the remote host has tmux installed (required for durable
 * remote sessions). Returns a structured result with a clear, user-facing error
 * when tmux is missing or the host is unreachable. Never throws.
 */
export async function checkRemoteTmuxAvailable(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): Promise<RemoteTmuxCheckResult> {
  // Under vitest, never open a real ssh connection — mirrors TmuxManager's
  // no-op-shell-under-VITEST (IS_TEST_MODE). Without this, remote-case
  // create-path tests hit a real ~10s ssh timeout. The command construction is
  // covered by buildRemoteTmuxCheckCommand unit tests; only the live probe is
  // short-circuited here.
  if (process.env.VITEST) {
    return { ok: true, tmuxPath: '(test-mode)' };
  }
  const command = buildRemoteTmuxCheckCommand(host);
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    const tmuxPath = stdout.trim();
    if (!tmuxPath) {
      return {
        ok: false,
        error: `remote host ${host.host} needs tmux installed for durable remote sessions`,
      };
    }
    return { ok: true, tmuxPath };
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
    // `command -v tmux` exits non-zero when tmux is absent (no stderr); a real
    // connection failure surfaces ssh diagnostics on stderr.
    if (stderr.trim()) {
      return {
        ok: false,
        error: `could not verify tmux on remote host ${host.host}: ${stderr.trim()}`,
      };
    }
    return {
      ok: false,
      error: `remote host ${host.host} needs tmux installed for durable remote sessions`,
    };
  }
}

export function remoteDisplayPath(
  remote: Pick<SessionRemote, 'username' | 'host' | 'remotePath'> | { username: string; host: string; path: string }
): string {
  const path = 'remotePath' in remote ? remote.remotePath : remote.path;
  return `${remote.username}@${remote.host}:${path}`;
}

export function toSessionRemote(host: RemoteHost, remoteCase: RemoteCase): SessionRemote {
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    port: host.port,
    remotePath: remoteCase.remotePath,
    commands: host.commands,
    // COD-107 — carry the advanced SSH options from host config into the session
    // so the launch/prereq commands connect the same way the operator configured.
    identityFile: host.identityFile,
    socksProxy: host.socksProxy,
    jumpHost: host.jumpHost,
    extraSshOptions: host.extraSshOptions,
  };
}
