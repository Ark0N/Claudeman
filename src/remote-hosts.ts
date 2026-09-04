import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getCli } from './config/cli-registry/registry.js';
import type {
  RemoteCase,
  RemoteHost,
  RemoteSessionInfo,
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

/**
 * The remote user's login shell, defaulted and quoted.
 *
 * The default is belt-and-braces, not a live bug: an empty `$SHELL` would expand
 * to `exec  -i -l`, which the shell reads as `exec -i` — "not found", pane dead on
 * arrival, the #208 failure all over again (verified: `sh -c 'exec $SHELL -i -l'`
 * with SHELL unset prints `exec: -i: not found`). In practice tmux always exports
 * SHELL into a pane from its own `default-shell` option, so the command as USED
 * here is safe either way (also verified). The default matters because these
 * strings are the seed values a per-host `commands.*` override is edited from, and
 * nothing constrains where an edited one ends up running. Quoted for a shell path
 * containing spaces. `/bin/sh` exists on every POSIX host.
 */
const REMOTE_LOGIN_SHELL = '"${SHELL:-/bin/sh}"';

/**
 * Run `command` through the remote user's interactive login shell, so per-user
 * PATH entries (~/.local/bin, ~/.opencode/bin, …) are resolved before the CLI name
 * is looked up. ssh's remote-command execution is neither interactive nor login,
 * so a bare `exec claude` sees only sshd's minimal default PATH and dies with
 * "command not found" (exit 127).
 *
 * Shells that take neither flag (nushell, elvish, …) cannot be detected from here
 * the way `loginShellArgs()` detects them locally, since the shell is whatever the
 * REMOTE passwd says. A host like that is what the per-host `commands.*` override
 * is for.
 */
export function remoteLoginShellCommand(command: string): string {
  return `exec ${REMOTE_LOGIN_SHELL} -i -l -c ${shellescape(command)}`;
}

/**
 * The CLI text a location overlay should launch for `mode`, or null when this build has no
 * entry for it. `overlays.<location>.command` when the entry names one, otherwise the bare
 * binary — which is what every non-claude CLI wants, and why only claude declares a command.
 *
 * ⚠️ This returns the CLI INVOCATION only. Each location wraps it its own way (remote: a
 * login-shell `-c`; docker: `exec`), which is exactly why the overlay stores the unwrapped
 * form rather than a ready-made line.
 */
function overlayCliCommand(mode: SessionMode, location: 'remote' | 'docker'): string | null {
  const entry = getCli(mode);
  if (!entry) return null;
  const overlay = entry.overlays[location];
  if (overlay && 'disabled' in overlay) return null;
  return overlay?.command ?? entry.discovery.binaries[0] ?? null;
}

/**
 * The default remote pane command for `mode`.
 *
 * Agent CLIs (claude/opencode/codex/gemini/antigravity/…) are typically installed under
 * per-user paths like ~/.local/bin or ~/.opencode/bin, added to PATH only by the remote
 * user's interactive-login shell startup files (~/.zshrc etc.). ssh's remote-command
 * execution is neither interactive nor login, so a bare `exec claude` sees only sshd's
 * minimal default PATH and fails with "command not found" (exit 127) — confirmed via
 * `tmux capture-pane` on the remain-on-exit-preserved dead pane. Route through
 * `$SHELL -i -l -c`, the same fix shell mode uses, so PATH is fully resolved first.
 *
 * ⚠️ The per-CLI half is now READ FROM THE REGISTRY (`overlays.remote`), not from a
 * hardcoded `Record<RemoteCommandMode, string>`. The table it replaces duplicated the
 * registry exactly, with nothing keeping the two in step — a capability that is both wrong
 * and unread is worse than an absent one, because the next person trusts it. Notes that were
 * attached to individual rows and are still true:
 *   - claude carries `--dangerously-skip-permissions` so the remote agent runs
 *     non-interactively (no trust-folder prompt nothing on the remote can answer);
 *     `overlays.remote.command` on the claude entry is where that now lives.
 *   - `dsh` alone boots nothing — the launcher needs a profile, and the remote box's profile
 *     inventory is unknown here. The per-host `commands.deepseek` override names one.
 * The per-host `commands.*` override remains the escape hatch for every mode.
 */
export function defaultRemoteCommandForMode(mode: SessionMode): string {
  // $SHELL, not a hardcoded bash: sshd sets it from the remote user's /etc/passwd entry, so
  // this launches their actual login shell (zsh, fish, …). `-i -l` so it sources rc files,
  // matching the local shell-mode launch. Not templatable as overlay data: the shell is
  // whatever the REMOTE passwd says, which is why `shell` is the one arm still written here.
  const shellCommand = `exec ${REMOTE_LOGIN_SHELL} -i -l`;
  const cli = overlayCliCommand(mode, 'remote');
  return cli === null ? shellCommand : remoteLoginShellCommand(cli);
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

/**
 * The CLI binary a session mode runs on the remote host, read from the registry rather than
 * from a hardcoded map. `shell` has no CLI to probe and resolves to undefined, which is what
 * makes the probe return null for it.
 *
 * ⚠️ Deriving this CHANGES BEHAVIOUR, deliberately and in one direction. The map it replaces
 * listed claude/opencode/codex/gemini/antigravity/pi/omp and simply omitted `grok` and
 * `deepseek` — its own comment said the rule was "every mode except shell", so the two were
 * an oversight from when those CLIs were added, not a decision. A remote grok or deepseek
 * session therefore reported no version at all. It now probes `grok --version` /
 * `dsh --version` through the same login-shell wrapper as its siblings.
 *
 * (`antigravity` is why this cannot be the mode name: its binary is `agy`.)
 */
function remoteCliBin(mode: SessionMode): string | undefined {
  return getCli(mode)?.discovery.binaries[0];
}

/**
 * Build the SSH command that reads the remote CLI's version (`claude --version`
 * on the remote host). The version query is routed through
 * `remoteLoginShellCommand` (the SAME `$SHELL -i -l -c` wrapper the real
 * launch uses), because agent CLIs live on PATH only after the remote user's
 * interactive-login startup files run (see defaultRemoteCommandForMode); a bare
 * `claude --version` over ssh exits 127. Connection options come from the
 * shared `buildSshConnectionArgs`, so the probe reaches exactly the hosts the
 * launch can reach. Returns null for modes with no CLI (shell).
 */
export function buildRemoteCliVersionProbeCommand(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions,
  mode: SessionMode
): string | null {
  const bin = remoteCliBin(mode);
  if (!bin) return null;
  return [
    ...buildSshConnectionArgs(host),
    remoteSshTarget(host),
    shellescape(remoteLoginShellCommand(`${bin} --version`)),
  ].join(' ');
}

/**
 * Read the CLI version installed ON THE REMOTE HOST. Feeds Session.cliVersion
 * for remote sessions: the deterministic local probe deliberately skips them
 * (it would report the LOCAL host's claude), and the startup-banner scrape is
 * unreliable (newer Claude Code builds print no banner; resumed sessions never
 * do), which left cliVersion undefined and silently disabled wheel-forwarding
 * to the CLI transcript (residual #154, noted in the #205 analysis). The
 * version is parsed as the first semver in stdout, never raw output: an
 * interactive-login shell may echo rc-file noise around it. Returns undefined
 * on any failure. No-op under VITEST (mirrors checkRemoteTmuxAvailable).
 */
export async function probeRemoteCliVersion(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions,
  mode: SessionMode
): Promise<string | undefined> {
  if (process.env.VITEST) return undefined;
  const command = buildRemoteCliVersionProbeCommand(host, mode);
  if (!command) return undefined;
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    const match = stdout.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * COD-105 — build the SSH command that lists `codeman-*` tmux sessions on a
 * remote host's canonical `-L codeman` socket.
 *
 * `list-sessions` exits NON-ZERO with empty output when no sessions exist (and
 * the server isn't running), so `2>/dev/null` swallows tmux's "no server
 * running" stderr; the caller treats a non-zero exit / empty output as "no
 * sessions" rather than an error.
 *
 * COD-107 — connection options come from the shared `buildSshConnectionArgs`, so
 * discovery connects with the SAME port/identity/proxy/jump-host as the launch
 * and the tmux prereq probe.
 */
export function buildRemoteListSessionsCommand(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): string {
  const [ssh, ...connectionArgs] = buildSshConnectionArgs(host);
  const parts = [ssh, connectionArgs[0], '-o ConnectTimeout=10', ...connectionArgs.slice(1)];
  // The tmux list-sessions invocation is passed as ONE shell-quoted argument so
  // the remote login shell runs it verbatim. The `-F` format uses literal `\t`
  // separators (tmux expands them); `2>/dev/null` is inside the quoted command.
  const remoteCmd =
    'tmux -L codeman list-sessions -F "#{session_name}\\t#{session_attached}\\t#{session_created}\\t#{session_windows}" 2>/dev/null';
  parts.push(remoteSshTarget(host), shellescape(remoteCmd));
  return parts.join(' ');
}

/**
 * COD-105 — pure parser for the `tmux list-sessions -F` output emitted by
 * `buildRemoteListSessionsCommand`. Factored out so the parse is unit-testable
 * without opening a real ssh connection.
 *
 * - Splits each non-empty line into [name, attached, created, windows] on the
 *   field separator. IMPORTANT: the remote tmux's `-F "…\t…"` format does NOT
 *   expand `\t` to a real tab — it emits the LITERAL two-character sequence
 *   `\t` (verified on aa-desktop / tmux next-3.7). So we split on the literal
 *   backslash-t sequence; we also tolerate a real tab in case a tmux build
 *   does expand it. (A real TAB is the regex `\t`; a literal backslash-t is the
 *   regex `\\t`.)
 * - Keeps ONLY sessions whose name starts with `codeman-` (ignores foreign tmux
 *   sessions that happen to share the socket).
 * - Coerces: `attached` → boolean (`'1'`), `created`/`windows` → finite ints.
 * - Skips malformed lines (wrong column count or non-numeric created/windows)
 *   rather than emitting garbage.
 */
export function parseRemoteSessionList(stdout: string): RemoteSessionInfo[] {
  const out: RemoteSessionInfo[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split on a literal `\t` (backslash + t, what the remote tmux emits) OR a
    // real tab character. `/\\t|\t/` = the two-char sequence, or a TAB.
    const cols = line.split(/\\t|\t/);
    if (cols.length !== 4) continue;
    const [name, attachedStr, createdStr, windowsStr] = cols;
    if (!name.startsWith('codeman-')) continue;
    const created = Number(createdStr);
    const windows = Number(windowsStr);
    if (!Number.isFinite(created) || !Number.isFinite(windows)) continue;
    // COD-106 — `session_attached` is the CLIENT COUNT (not a 0/1 flag); >1 = shared.
    const attachedNum = Number(attachedStr.trim());
    const attachedClients = Number.isFinite(attachedNum) ? Math.max(0, Math.trunc(attachedNum)) : 0;
    out.push({
      name,
      attached: attachedClients > 0,
      attachedClients,
      created: Math.trunc(created),
      windows: Math.trunc(windows),
    });
  }
  return out;
}

/**
 * COD-105 — discover `codeman-*` tmux sessions already running on a remote host
 * (created by the remote's own Codeman, another instance, or this one), so the
 * operator can attach to one this Codeman didn't launch.
 *
 * NEVER throws: returns `[]` on unreachable host / no tmux / no sessions
 * (`list-sessions` exits non-zero with empty output when there are none).
 *
 * VITEST guard — like `checkRemoteTmuxAvailable`, returns `[]` under test so a
 * real ssh never runs in a request path (which would make route tests hit a
 * ~10s timeout). The command construction is covered by
 * `buildRemoteListSessionsCommand` and the parse by `parseRemoteSessionList`.
 */
export async function listRemoteCodemanSessions(
  remote: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): Promise<RemoteSessionInfo[]> {
  if (process.env.VITEST) {
    return [];
  }
  const command = buildRemoteListSessionsCommand(remote);
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    return parseRemoteSessionList(stdout);
  } catch {
    // Unreachable host, no tmux server, or no sessions (non-zero exit). All map
    // to "nothing to attach to" — never surface as an error to the caller.
    return [];
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
    // COD-105 — the COD-104 launch path creates the remote session, so we own it
    // (an explicit kill may propagate a remote kill-session). Discovered+attached
    // sessions go through `toAttachedSessionRemote` with `owned: false`.
    owned: true,
    // COD-107 — carry the advanced SSH options from host config into the session
    // so the launch/prereq commands connect the same way the operator configured.
    identityFile: host.identityFile,
    socksProxy: host.socksProxy,
    jumpHost: host.jumpHost,
    extraSshOptions: host.extraSshOptions,
  };
}

/**
 * COD-105 — build a NON-owned `SessionRemote` for ATTACHING to a `codeman-*`
 * session already running on a remote host (discovered via
 * `listRemoteCodemanSessions`). The resulting session's pane runs
 * `tmux -L codeman attach -t <remoteSessionName>` (see
 * `buildRemoteAttachCommand`), and because we did NOT create the remote session,
 * `owned: false` means closing the tab DETACHES rather than killing it.
 *
 * `remotePath` is informational here (the attached remote session keeps its own
 * cwd); we record the host's nominal path so display helpers still show
 * `user@host:path`.
 */
export function toAttachedSessionRemote(
  host: RemoteHost,
  remoteSessionName: string,
  remotePath: string
): SessionRemote {
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    port: host.port,
    remotePath,
    commands: host.commands,
    // Discovered + attached — another Codeman created it. Detach-not-kill.
    owned: false,
    remoteSessionName,
    identityFile: host.identityFile,
    socksProxy: host.socksProxy,
    jumpHost: host.jumpHost,
    extraSshOptions: host.extraSshOptions,
  };
}
