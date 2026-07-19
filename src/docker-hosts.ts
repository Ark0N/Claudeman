/**
 * @fileoverview Docker cases: storage, pure command-arg builders, and daemon probes.
 *
 * Docker mode is a LOCATION OVERLAY on cases (not a 6th SessionMode), the direct
 * analog of the remote-SSH feature in `remote-hosts.ts`. Instead of a local tmux
 * pane running `ssh host` into a durable remote tmux server, a local tmux pane
 * runs `docker exec -it` into a durable IN-CONTAINER tmux server. The container is
 * scoped to the CASE (`codeman-case-<name>`), so multiple sessions can `docker
 * exec` into the same long-lived container.
 *
 * This module mirrors `remote-hosts.ts`:
 *  - JSON storage for hosts (`docker-hosts.json`) and cases (`docker-cases.json`)
 *  - `toSessionDocker()` (mirror of `toSessionRemote`)
 *  - `buildDockerBaseArgs()` / `buildDockerCreateArgs()` (mirror of `buildSshConnectionArgs`)
 *  - `checkDockerAvailable()` / `checkDockerTmuxAvailable()` (mirror of `checkRemoteTmuxAvailable`)
 *
 * The launch/kill command orchestration (`buildDockerLaunchCommand`,
 * `buildDockerKillCommand`, `dockerTmuxSessionName`) lives in `tmux-manager.ts`,
 * mirroring where `buildRemoteLaunchCommand` lives.
 *
 * @module docker-hosts
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DockerCase,
  DockerCommandMode,
  DockerEngine,
  DockerHost,
  DockerNetworkMode,
  DockerResourceLimits,
  SessionDocker,
  SessionMode,
} from './types.js';

const execFileAsync = promisify(execFile);

/** Under vitest, all real `docker` invocations no-op (mirror of tmux-manager's IS_TEST_MODE). */
const IS_TEST_MODE = !!process.env.VITEST;

const DOCKER_HOSTS_FILE = 'docker-hosts.json';
const DOCKER_CASES_FILE = 'docker-cases.json';

/** Locally-built base image (see scripts/build-agent-image.mjs). */
export const DEFAULT_AGENT_IMAGE = 'codeman/agent:base';

/** HOME inside the base image (the `agent` user). Cred mounts + hook-secret land under it. */
export const CONTAINER_HOME = '/home/agent';

/** Per-case container name prefix. The `case` letters deliberately do NOT matter to
 * tmux; this is a DOCKER name (`^[a-zA-Z0-9][a-zA-Z0-9_.-]+$`), and case names are
 * already validated `^[a-zA-Z0-9_-]+$`, so `codeman-case-<name>` is always valid. */
const CONTAINER_NAME_PREFIX = 'codeman-case-';

/** Sensible resource defaults (all overridable per host). */
export const DEFAULT_DOCKER_RESOURCES: DockerResourceLimits = {
  memory: '4g',
  cpus: '2',
  pidsLimit: 512,
  nofile: '4096:8192',
};

// ========== Storage (mirror of remote-hosts.ts) ==========

export function dockerHostsPath(configDir: string): string {
  return join(configDir, DOCKER_HOSTS_FILE);
}

export function dockerCasesPath(configDir: string): string {
  return join(configDir, DOCKER_CASES_FILE);
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

export async function readDockerHosts(configDir: string): Promise<DockerHost[]> {
  return readJsonArray<DockerHost>(dockerHostsPath(configDir));
}

export async function writeDockerHosts(configDir: string, hosts: DockerHost[]): Promise<void> {
  await writeJsonArray(configDir, dockerHostsPath(configDir), hosts);
}

export async function readDockerCases(configDir: string): Promise<DockerCase[]> {
  return readJsonArray<DockerCase>(dockerCasesPath(configDir));
}

export async function writeDockerCases(configDir: string, cases: DockerCase[]): Promise<void> {
  await writeJsonArray(configDir, dockerCasesPath(configDir), cases);
}

// ========== Naming / display / defaults ==========

/** Per-case container name. Mirrors how remote derives a stable name from the case. */
export function dockerContainerName(caseName: string): string {
  return `${CONTAINER_NAME_PREFIX}${caseName}`;
}

/** Default pane command per CLI mode (mirror of defaultRemoteCommandForMode). */
export function defaultDockerCommandForMode(mode: SessionMode): string {
  const commands: Record<DockerCommandMode, string> = {
    shell: 'exec bash -l',
    // Mirror the LOCAL claude default so the in-container agent runs non-interactively.
    claude: 'exec claude --dangerously-skip-permissions',
    opencode: 'exec opencode',
    codex: 'exec codex',
    gemini: 'exec gemini',
  };
  return commands[mode as DockerCommandMode] || commands.shell;
}

/** `container:/workdir` display string (mirror of remoteDisplayPath's `user@host:path`). */
export function dockerDisplayPath(
  docker: Pick<SessionDocker, 'containerName' | 'containerWorkdir'> | { container: string; path: string }
): string {
  if ('containerName' in docker) return `${docker.containerName}:${docker.containerWorkdir}`;
  return `${docker.container}:${docker.path}`;
}

/**
 * The host-callback gateway alias is ENGINE-SPECIFIC: Docker exposes the host as
 * `host.docker.internal`, Podman as `host.containers.internal`. Both are added to
 * the host-guard allowlist so a mixed fleet keeps working.
 */
export function hostGatewayAlias(engine: DockerEngine): string {
  return engine === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
}

/**
 * Rewrite the server's own `CODEMAN_API_URL` to a container-reachable one by
 * swapping ONLY the hostname for the engine's host-gateway alias, preserving
 * scheme AND port (prod is HTTPS on 3000, so hardcoding http://…:3000 breaks
 * every hook). Falls back to `https://<alias>:3000` when the input is absent or
 * unparseable.
 */
export function containerApiUrl(processApiUrl: string | undefined, engine: DockerEngine): string {
  const alias = hostGatewayAlias(engine);
  if (!processApiUrl) return `https://${alias}:3000`;
  try {
    const url = new URL(processApiUrl);
    url.hostname = alias;
    // origin drops any trailing path/slash and keeps scheme + (non-default) port
    return url.origin;
  } catch {
    return `https://${alias}:3000`;
  }
}

/**
 * Stable hash of the drift-relevant `docker create` inputs, stored on the
 * container as the `codeman.confighash` label. On launch, a mismatch between the
 * desired hash and the running container's label triggers the recreate-on-drift
 * prompt (host config edits actually take effect).
 */
export function dockerConfigHash(
  docker: Pick<
    SessionDocker,
    | 'engine'
    | 'image'
    | 'containerWorkdir'
    | 'network'
    | 'networkName'
    | 'resources'
    | 'mountCredentials'
    | 'extraCreateArgs'
  >
): string {
  const normalized = JSON.stringify({
    engine: docker.engine,
    image: docker.image,
    containerWorkdir: docker.containerWorkdir,
    network: docker.network,
    networkName: docker.networkName ?? null,
    resources: docker.resources ?? null,
    mountCredentials: docker.mountCredentials,
    extraCreateArgs: docker.extraCreateArgs ?? null,
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Build the flattened per-session Docker metadata from a host profile + a case,
 * resolving every default (mirror of toSessionRemote). The `configHash` is
 * computed last over the resolved values.
 */
export function toSessionDocker(host: DockerHost, dockerCase: DockerCase): SessionDocker {
  const engine: DockerEngine = host.engine ?? 'docker';
  const containerWorkdir = dockerCase.containerWorkdir ?? dockerCase.hostWorkspacePath;
  const base: Omit<SessionDocker, 'configHash'> = {
    hostId: host.id,
    label: host.label,
    engine,
    image: host.image || DEFAULT_AGENT_IMAGE,
    containerName: dockerCase.container ?? dockerContainerName(dockerCase.name),
    hostWorkspacePath: dockerCase.hostWorkspacePath,
    containerWorkdir,
    network: host.network ?? 'bridge',
    networkName: host.networkName,
    resources: host.resources ?? DEFAULT_DOCKER_RESOURCES,
    mountCredentials: host.mountCredentials ?? true,
    hooksEnabled: host.hooksEnabled ?? true,
    resumeOnStart: host.resumeOnStart ?? true,
    daemonHost: host.daemonHost,
    context: host.context,
    commands: host.commands,
    extraCreateArgs: host.extraCreateArgs,
    extraExecArgs: host.extraExecArgs,
  };
  return { ...base, configHash: dockerConfigHash(base) };
}

// ========== Shell escaping ==========

/**
 * POSIX single-quote shell-escaping (end-quote, escaped-quote, restart-quote).
 * Mirror of the helper in remote-hosts.ts / tmux-manager.ts. Every dynamic value
 * interpolated into the outer `bash -c "..."` launch layer is escaped through
 * this so a path with spaces stays a single shell token. Operator-entered fields
 * are ALSO schema-rejected for `$`/backtick (NO_SHELL_META) as defense in depth.
 */
export function shellescape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ========== Pure command-arg builders ==========

/** A resolved bind mount (source existence already checked by the caller). */
export interface DockerMount {
  src: string;
  dst: string;
  readonly?: boolean;
}

/**
 * Resolved, IO-free context for buildDockerCreateArgs. The caller (tmux-manager)
 * resolves the environment-dependent bits (host uid, existing cred mounts, the
 * derived api url, Desktop detection) so this builder stays pure and unit-testable.
 */
export interface DockerCreateContext {
  docker: SessionDocker;
  /** Codeman session id (only the first 8 chars are used, for the codeman.session label). */
  sessionId: string;
  /** CODEMAN_INSTANCE ('' for prod) — scopes the boot reaper so a beta never reaps prod. */
  instance: string;
  /** Pre-resolved uid/userns tokens: ['--user','1000:0'] | ['--userns','keep-id'] | []. */
  userArgs: string[];
  /** Existing host credential bind mounts (convenient mode). Empty in sealed mode. */
  credentialMounts: DockerMount[];
  /** Extra bind mounts (e.g. the read-only hook-secret file). */
  extraMounts: DockerMount[];
  /** Create-time env (NON-secret, committed-safe): HOME, TERM, COLORTERM, CODEMAN_API_URL, CODEMAN_HOOK_SECRET_FILE. */
  envCreate: Record<string, string>;
  /** Whether to add `--add-host <alias>:host-gateway` (skipped on Docker Desktop, where the alias is native). */
  addHostGateway: boolean;
  /** Engine host-gateway alias (host.docker.internal / host.containers.internal). */
  gatewayAlias: string;
}

/**
 * Engine prefix tokens shared by every docker invocation (mirror of
 * buildSshConnectionArgs). Returns e.g. ['docker'] or ['podman','--context','ctx'].
 */
export function buildDockerBaseArgs(docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost'>): string[] {
  const parts: string[] = [docker.engine === 'podman' ? 'podman' : 'docker'];
  if (docker.context) parts.push('--context', shellescape(docker.context));
  if (docker.daemonHost) parts.push('-H', shellescape(docker.daemonHost));
  return parts;
}

function mountSpec(m: DockerMount): string {
  return `type=bind,src=${m.src},dst=${m.dst}${m.readonly ? ',readonly' : ''}`;
}

function resourceFlags(resources?: DockerResourceLimits): string[] {
  if (!resources) return [];
  const flags: string[] = [];
  if (resources.memory) {
    // memory-swap == memory disables swap, making --memory a REAL OOM cap.
    flags.push('--memory', resources.memory, '--memory-swap', resources.memory);
  }
  if (resources.cpus) flags.push('--cpus', resources.cpus);
  if (resources.pidsLimit) flags.push('--pids-limit', String(resources.pidsLimit));
  if (resources.nofile) flags.push('--ulimit', `nofile=${resources.nofile}`);
  if (resources.shmSize) flags.push('--shm-size', resources.shmSize);
  return flags;
}

function networkArg(network: DockerNetworkMode, networkName?: string): string {
  if (network === 'custom' && networkName) return networkName;
  return network; // 'bridge' | 'none'
}

/**
 * Build the `docker create` token list (from `create` through the `sleep
 * infinity` CMD) for a long-lived, hardened, per-case container. PURE: every
 * dynamic value is shellescaped; the caller joins with spaces into the launch
 * string. Security invariants baked in: --cap-drop ALL, --security-opt
 * no-new-privileges, --pids-limit, --memory==--memory-swap, --init,
 * --pull=never, --restart no, NEVER --privileged, NEVER the docker socket.
 */
export function buildDockerCreateArgs(ctx: DockerCreateContext): string[] {
  const {
    docker,
    sessionId,
    instance,
    userArgs,
    credentialMounts,
    extraMounts,
    envCreate,
    addHostGateway,
    gatewayAlias,
  } = ctx;

  const args: string[] = [
    'create',
    '--name',
    shellescape(docker.containerName),
    '--label',
    'codeman.managed=1',
    '--label',
    shellescape(`codeman.instance=${instance}`),
    '--label',
    shellescape(`codeman.session=${sessionId.slice(0, 8)}`),
    '--label',
    shellescape(`codeman.confighash=${docker.configHash ?? dockerConfigHash(docker)}`),
    '--pull=never',
    '--init',
    '--restart',
    'no',
    ...userArgs,
    '--workdir',
    shellescape(docker.containerWorkdir),
    // Workspace bind: mirror the host path inside the container so the transcript
    // projHash correlates and file features read real host bytes.
    '--mount',
    shellescape(mountSpec({ src: docker.hostWorkspacePath, dst: docker.containerWorkdir })),
    ...credentialMounts.flatMap((m) => ['--mount', shellescape(mountSpec(m))]),
    ...extraMounts.flatMap((m) => ['--mount', shellescape(mountSpec(m))]),
  ];

  if (addHostGateway) args.push('--add-host', `${gatewayAlias}:host-gateway`);

  args.push(
    ...resourceFlags(docker.resources),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    networkArg(docker.network, docker.networkName)
  );

  for (const [key, value] of Object.entries(envCreate)) {
    args.push('--env', shellescape(`${key}=${value}`));
  }

  // Operator escape-hatch args (schema-validated NO_SHELL_INJECTION), escaped again here.
  for (const extra of docker.extraCreateArgs ?? []) {
    args.push(shellescape(extra));
  }

  args.push(shellescape(docker.image), 'sleep', 'infinity');
  return args;
}

// ========== Credential mount resolution (IO) ==========

/** Host cred paths mapped to their in-container HOME location. */
const CREDENTIAL_PATHS: Array<{ rel: string }> = [
  { rel: '.claude' },
  { rel: '.claude.json' },
  { rel: '.codex' },
  { rel: '.gemini' },
  { rel: '.config/gcloud' },
  { rel: '.config/opencode' },
];

/**
 * Resolve which host credential dirs/files EXIST and map them to their container
 * HOME location. Only-existing avoids docker auto-creating root-owned empty dirs
 * in the user's home. `~/.claude` also carries the transcripts (bind-mounted so
 * host watchers + `--resume` see them) and is therefore mounted read-WRITE.
 */
export function resolveCredentialMounts(home: string = homedir()): DockerMount[] {
  const mounts: DockerMount[] = [];
  for (const { rel } of CREDENTIAL_PATHS) {
    const src = join(home, rel);
    if (existsSync(src)) {
      mounts.push({ src, dst: `${CONTAINER_HOME}/${rel}` });
    }
  }
  return mounts;
}

// ========== Daemon probes (IO; no-op under VITEST) ==========

export interface DockerAvailability {
  ok: boolean;
  engine: DockerEngine;
  rootless: boolean;
  isDesktop: boolean;
  cgroupV2: boolean;
  /** Best-effort: are --memory/--cpus/--pids-limit actually enforced on this engine? */
  capsEnforced: boolean;
  error?: string;
}

const DOCKER_PROBE_TIMEOUT_MS = 15_000;

interface DockerInfoJson {
  ServerVersion?: string;
  CgroupVersion?: string;
  SecurityOptions?: string[];
  OperatingSystem?: string;
  OSType?: string;
  Name?: string;
}

async function runDockerInfo(engine: DockerEngine): Promise<DockerInfoJson | null> {
  try {
    const { stdout } = await execFileAsync(engine, ['info', '--format', '{{json .}}'], {
      timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as DockerInfoJson;
  } catch {
    return null;
  }
}

function classifyDockerInfo(engine: DockerEngine, info: DockerInfoJson): DockerAvailability {
  const security = info.SecurityOptions ?? [];
  const rootless = security.some((opt) => opt.includes('rootless'));
  const cgroupV2 = info.CgroupVersion === '2';
  const os = `${info.OperatingSystem ?? ''}`.toLowerCase();
  const isDesktop = os.includes('docker desktop') || os.includes('desktop');
  // Under rootless, resource caps are only reliably enforced with cgroup v2 +
  // systemd delegation. We can't detect delegation from `docker info`, so we
  // treat rootless+cgroupv2 as "likely enforced" and rootless+cgroupv1 as not.
  const capsEnforced = !rootless || cgroupV2;
  return { ok: true, engine, rootless, isDesktop, cgroupV2, capsEnforced };
}

/**
 * Probe the container engine: server up, cgroup version, rootless, Desktop, and
 * whether resource caps are enforceable. Auto-detects docker then podman when no
 * engine is given. No-op canned value under VITEST.
 */
export async function checkDockerAvailable(engine?: DockerEngine): Promise<DockerAvailability> {
  if (IS_TEST_MODE) {
    return {
      ok: true,
      engine: engine ?? 'docker',
      rootless: false,
      isDesktop: false,
      cgroupV2: true,
      capsEnforced: true,
    };
  }
  const candidates: DockerEngine[] = engine ? [engine] : ['docker', 'podman'];
  for (const candidate of candidates) {
    const info = await runDockerInfo(candidate);
    if (info) return classifyDockerInfo(candidate, info);
  }
  return {
    ok: false,
    engine: engine ?? 'docker',
    rootless: false,
    isDesktop: false,
    cgroupV2: false,
    capsEnforced: false,
    error: 'Docker/Podman not available. Install docker (or podman) and ensure the daemon is running.',
  };
}

/** Is the base image present locally? (never triggers an auto-pull). */
export async function checkDockerImagePresent(engine: DockerEngine, image: string): Promise<boolean> {
  if (IS_TEST_MODE) return true;
  try {
    await execFileAsync(engine, ['image', 'inspect', '--format', '{{.Id}}', image], {
      timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export interface DockerTmuxCheckResult {
  ok: boolean;
  tmuxPath?: string;
  /** Distinguishes "image missing" (build it) from "tmux missing in image" (rebuild it). */
  imageMissing?: boolean;
  error?: string;
}

/**
 * Verify the base image is present AND contains tmux (a HARD prerequisite: the
 * in-container tmux is what makes reconnect durable). Never triggers a pull
 * (`--pull=never`). No-op under VITEST. Mirror of checkRemoteTmuxAvailable.
 */
export async function checkDockerTmuxAvailable(
  docker: Pick<SessionDocker, 'engine' | 'image'>
): Promise<DockerTmuxCheckResult> {
  if (IS_TEST_MODE) return { ok: true, tmuxPath: '/usr/bin/tmux' };
  const engine = docker.engine;
  if (!(await checkDockerImagePresent(engine, docker.image))) {
    return {
      ok: false,
      imageMissing: true,
      error: `base image ${docker.image} not present: build it with 'node scripts/build-agent-image.mjs' (or pull it)`,
    };
  }
  try {
    const { stdout } = await execFileAsync(
      engine,
      ['run', '--rm', '--pull=never', docker.image, 'sh', '-lc', 'command -v tmux'],
      { timeout: DOCKER_PROBE_TIMEOUT_MS }
    );
    const tmuxPath = stdout.trim();
    if (!tmuxPath) {
      return { ok: false, error: `base image ${docker.image} is missing tmux (required for durable sessions)` };
    }
    return { ok: true, tmuxPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `could not verify tmux in ${docker.image}: ${msg}` };
  }
}

/**
 * Instance-scoped boot reaper: `docker rm -f` any MANAGED container that belongs
 * to THIS instance (by the `codeman.instance` label) but whose case is no longer
 * in `docker-cases.json`. The instance scoping is what stops a beta from reaping
 * prod's containers (the cross-instance hazard). No-op under VITEST. Best-effort.
 */
export async function reapOrphanedDockerContainers(
  configDir: string,
  instance: string,
  engine: DockerEngine = 'docker'
): Promise<string[]> {
  if (IS_TEST_MODE) return [];
  const bin = engine === 'podman' ? 'podman' : 'docker';
  let rows: Array<{ name: string; inst: string }> = [];
  try {
    const { stdout } = await execFileAsync(
      bin,
      [
        'ps',
        '-a',
        '--filter',
        'label=codeman.managed=1',
        '--format',
        '{{.Names}}\t{{index .Labels "codeman.instance"}}',
      ],
      { timeout: DOCKER_PROBE_TIMEOUT_MS }
    );
    rows = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, inst = ''] = line.split('\t');
        return { name, inst };
      });
  } catch {
    return []; // daemon down / engine absent — nothing to reap
  }
  const cases = await readDockerCases(configDir);
  const expected = new Set(cases.map((c) => c.container ?? dockerContainerName(c.name)));
  const reaped: string[] = [];
  for (const { name, inst } of rows) {
    if (inst !== instance) continue; // only THIS instance's containers
    if (expected.has(name)) continue; // still referenced by a live case
    try {
      await execFileAsync(bin, ['rm', '-f', name], { timeout: DOCKER_PROBE_TIMEOUT_MS });
      reaped.push(name);
    } catch {
      /* best-effort */
    }
  }
  return reaped;
}

/**
 * Read the IN-CONTAINER Claude CLI version (`docker exec <container> claude
 * --version`). Feeds Session.cliVersion for docker sessions (the LOCAL claude
 * would report the wrong version and disable trackpad wheel-forwarding, #154).
 * Returns undefined on any failure. No-op under VITEST.
 */
export async function probeDockerCliVersion(
  docker: Pick<SessionDocker, 'engine' | 'containerName'>,
  mode: SessionMode
): Promise<string | undefined> {
  if (IS_TEST_MODE) return undefined;
  const bin = mode === 'shell' ? null : mode;
  if (!bin) return undefined;
  try {
    const { stdout } = await execFileAsync(docker.engine, ['exec', docker.containerName, bin, '--version'], {
      timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    const match = stdout.trim().match(/\d+\.\d+\.\d+/);
    return match ? match[0] : stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
