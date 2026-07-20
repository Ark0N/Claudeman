/**
 * @fileoverview Session type definitions.
 *
 * Core domain type — SessionState is the primary entity in the system.
 *
 * Key exports:
 * - SessionState — full session state (status, tokens, respawn, ralph, CLI metadata)
 * - SessionConfig — creation-time config (id, workingDir, createdAt)
 * - SessionOutput — captured stdout/stderr/exitCode
 * - SessionStatus — 'idle' | 'busy' | 'stopped' | 'error'
 * - SessionMode — 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini' (which CLI backend)
 * - ClaudeMode — CLI permission mode ('dangerously-skip-permissions' | 'auto' | 'normal' | 'allowedTools')
 * - SessionColor — visual differentiation color
 * - OpenCodeConfig — OpenCode-specific settings (model, autoAllowTools, continueSession)
 * - CodexConfig — Codex (OpenAI CLI)-specific settings (model, resumeSessionId)
 * - GeminiConfig — Gemini CLI-specific settings (model, approvalMode, resumeSession)
 *
 * Cross-domain relationships:
 * - SessionState.respawnConfig embeds RespawnConfig (respawn domain)
 * - SessionState.id is referenced by: RalphSessionState.sessionId (ralph),
 *   RunSummary.sessionId (run-summary), ActiveBashTool.sessionId (tools),
 *   TeamConfig.leadSessionId (teams), RespawnCycleMetrics.sessionId (respawn),
 *   TaskState.assignedSessionId (task)
 *
 * Persisted to `~/.codeman/state.json`. Served at `GET /api/sessions` and
 * `GET /api/sessions/:id`.
 */

import type { RespawnConfig } from './respawn.js';
import type { AttachmentDetectedType } from './tools.js';

/** Status of a Claude session */
export type SessionStatus = 'idle' | 'busy' | 'stopped' | 'error';

/**
 * Claude CLI startup permission mode.
 * - `'dangerously-skip-permissions'`: Bypass all permission prompts (default)
 * - `'auto'`: Anthropic's classifier-guarded low-prompt mode (`--permission-mode auto`)
 * - `'normal'`: Standard mode with permission prompts
 * - `'allowedTools'`: Only allow specific tools (requires allowedTools list)
 */
export type ClaudeMode = 'dangerously-skip-permissions' | 'auto' | 'normal' | 'allowedTools';

/** Session mode: which CLI backend a session runs */
export type SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini';

export type RemoteCommandMode = Extract<SessionMode, 'shell' | 'claude' | 'opencode' | 'codex' | 'gemini'>;

/**
 * Advanced SSH connection options shared by RemoteHost and SessionRemote.
 *
 * COD-107 — all fields are optional; every field absent reproduces today's
 * behavior (port-22, default-identity, directly-SSH-able hosts). These describe
 * HOW Codeman reaches the host (identity, proxy, jump host, arbitrary `-o`),
 * letting it connect to e.g. a host fronted by a cloudflared SOCKS5 proxy on a
 * custom port — the same connection `ssh-aa-desktop` makes — without a wrapper.
 */
export interface RemoteSshOptions {
  /**
   * Path to an SSH identity (private key) file — path ONLY, never key bytes.
   * A leading `~`/`$HOME` is expanded to an absolute path at command-build time
   * (ssh does not expand `~` in `-i`).
   */
  identityFile?: string;
  /**
   * SOCKS5 proxy as `host:port` (e.g. `127.0.0.1:1080`). Expands to
   * `-o ProxyCommand=nc -X 5 -x <host:port> %h %p` (the cloudflared/SOCKS5 case).
   */
  socksProxy?: string;
  /** SSH jump host (`[user@]host[:port]`) emitted as `-J <jumpHost>`. */
  jumpHost?: string;
  /** Arbitrary additional `-o KEY=VALUE` options (escape hatch). Each `KEY=VALUE`. */
  extraSshOptions?: string[];
}

export interface RemoteHost extends RemoteSshOptions {
  id: string;
  label: string;
  host: string;
  username: string;
  port?: number;
  commands?: Partial<Record<RemoteCommandMode, string>>;
}

export interface RemoteCase {
  name: string;
  type: 'remote';
  /** Owning username in multi-user mode; absent = legacy/unassigned (admin-only). */
  owner?: string;
  hostId: string;
  remotePath: string;
}

export interface SessionRemote extends RemoteSshOptions {
  hostId: string;
  label: string;
  host: string;
  username: string;
  port?: number;
  remotePath: string;
  commands?: Partial<Record<RemoteCommandMode, string>>;
  /**
   * COD-105 — whether THIS Codeman created the remote tmux session.
   *
   * - `true` (default for COD-104 launched sessions): we own the remote session;
   *   an explicit "kill" may propagate a remote `tmux kill-session`.
   * - `false` (discovered + attached an existing remote session another Codeman
   *   created): closing the local tab must DETACH only — we must NEVER issue a
   *   remote `kill-session`, or we'd nuke work the remote's own Codeman (or
   *   another instance) still relies on. See `killSession()` gate.
   *
   * Absent is treated as owned (legacy/COD-104 sessions persisted before this
   * field existed were all launched by us).
   */
  owned?: boolean;
  /**
   * COD-105 — for a NON-owned (discovered + attached) session, the EXISTING
   * remote tmux session name to `attach -t` (e.g. `codeman-disco1`). It differs
   * from this Codeman's deterministic `codeman-<id>` name because the remote
   * session was created elsewhere. Only meaningful when `owned === false`.
   */
  remoteSessionName?: string;
}

/**
 * COD-105 — a `codeman-*` tmux session discovered on a remote host's
 * `tmux -L codeman` socket (may have been created by the remote's own Codeman,
 * another instance, or this one). Returned by `listRemoteCodemanSessions`.
 */
export interface RemoteSessionInfo {
  /** tmux session name (always starts `codeman-`). */
  name: string;
  /** Whether at least one client is currently attached to the remote session. */
  attached: boolean;
  /** COD-106 — number of clients attached (tmux `session_attached`); >1 = shared. */
  attachedClients: number;
  /** tmux `session_created` epoch seconds. */
  created: number;
  /** Number of windows in the remote session. */
  windows: number;
}

// ========== Docker cases (COD-Docker) ==========
//
// Docker mode is a LOCATION OVERLAY on cases (never a 6th SessionMode), the exact
// analog of the remote-SSH feature above: instead of a local tmux pane running
// `ssh host` into a durable remote tmux server, a local tmux pane runs
// `docker exec -it` into a durable in-container tmux server. The container is
// scoped to the CASE (not the session), so multiple sessions can `docker exec`
// into the same long-lived container. See `docs/docker-cases-plan.md`.

/** Which CLI backends a Docker case can run (same set as remote). */
export type DockerCommandMode = Extract<SessionMode, 'shell' | 'claude' | 'opencode' | 'codex' | 'gemini'>;

/** Container engine. Docker and Podman differ in the uid/userns + host-gateway alias. */
export type DockerEngine = 'docker' | 'podman';

/**
 * Container network mode. `host` and any inbound `-p` publish are deliberately
 * unrepresentable (never in this union, never emitted by the flag builder).
 * - `bridge`: own netns, NAT egress, no inbound (default — every API CLI needs egress)
 * - `none`: fully offline sandbox (breaks API CLIs; reserved for `shell`)
 * - `custom`: a user-defined bridge `codeman-net-<slug>` (future egress-allowlist chokepoint)
 */
export type DockerNetworkMode = 'bridge' | 'none' | 'custom';

/** Per-container resource caps. Advisory under non-delegated rootless (see `capsEnforced`). */
export interface DockerResourceLimits {
  /** e.g. '4g' -> --memory 4g --memory-swap 4g (swap==memory: a real OOM cap) */
  memory?: string;
  /** e.g. '2' -> --cpus 2 */
  cpus?: string;
  /** e.g. 512 -> --pids-limit 512 (fork-bomb guard) */
  pidsLimit?: number;
  /** e.g. '4096:8192' -> --ulimit nofile=4096:8192 */
  nofile?: string;
  /** e.g. '256m' -> --shm-size (only when a tool needs /dev/shm) */
  shmSize?: string;
}

/** A reusable Docker engine/image/network/resource profile (mirror of RemoteHost). */
export interface DockerHost {
  id: string;
  label: string;
  /** Engine; when absent the availability probe resolves it (docker, else podman). */
  engine?: DockerEngine;
  /** Base image ref (built locally by scripts/build-agent-image.mjs, e.g. codeman/agent:base). */
  image: string;
  /** Advanced: remote daemon (-H ssh://user@host or a DOCKER_HOST value). */
  daemonHost?: string;
  /** Advanced: docker `--context` name. */
  context?: string;
  /** Network mode (default 'bridge'). */
  network?: DockerNetworkMode;
  /** Custom bridge name when network === 'custom'. */
  networkName?: string;
  resources?: DockerResourceLimits;
  /** GPU allocation, e.g. 'all' / '1' / 'device=0,1' -> `--gpus <value>` (needs the NVIDIA container toolkit). */
  gpus?: string;
  /** true (default) = convenient: bind-mount host cred dirs RW. false = sealed (blocks full-image export). */
  mountCredentials?: boolean;
  /** true (default) = wire in-container hooks (host-gateway callback + workspace scaffold). */
  hooksEnabled?: boolean;
  /** true (default) = a relaunch resumes the last conversation from the bind-mounted transcript. */
  resumeOnStart?: boolean;
  /** Per-mode command overrides (mirror RemoteHost.commands). */
  commands?: Partial<Record<DockerCommandMode, string>>;
  /** Escape hatch: extra `docker create` args (validated like extraSshOptions). */
  extraCreateArgs?: string[];
  /** Escape hatch: extra `docker exec` args. */
  extraExecArgs?: string[];
}

/** A case linked to a Docker container (mirror of RemoteCase). */
export interface DockerCase {
  name: string;
  type: 'docker';
  /** Owning username in multi-user mode; absent = legacy/unassigned (admin-only). */
  owner?: string;
  hostId: string;
  /** Absolute HOST directory: the bind-mount source AND Session.workingDir (real host bytes). */
  hostWorkspacePath: string;
  /** Container path (default = hostWorkspacePath: mirror -> transcript projHash correlates). */
  containerWorkdir?: string;
  /** Container name (default codeman-case-<slug>). */
  container?: string;
  /** Last captured Claude conversation id, replayed via --resume on a fresh launch. */
  lastClaudeSessionId?: string;
}

/**
 * Flattened Docker execution metadata carried on a live session (mirror of
 * SessionRemote). Round-trips through MuxSession/SessionState/mux-sessions.json.
 */
export interface SessionDocker {
  hostId: string;
  label: string;
  engine: DockerEngine;
  image: string;
  /** Per-CASE container name (shared by all sessions of the case). */
  containerName: string;
  hostWorkspacePath: string;
  containerWorkdir: string;
  network: DockerNetworkMode;
  networkName?: string;
  resources?: DockerResourceLimits;
  /** GPU allocation ('all' / '1' / 'device=0,1'). */
  gpus?: string;
  mountCredentials: boolean;
  hooksEnabled: boolean;
  resumeOnStart: boolean;
  daemonHost?: string;
  context?: string;
  commands?: Partial<Record<DockerCommandMode, string>>;
  extraCreateArgs?: string[];
  extraExecArgs?: string[];
  /** Stable hash of the drift-relevant create args (recreate-on-drift detection). */
  configHash?: string;
}

/**
 * Valid Claude CLI effort levels (claude >= 2.1.154).
 * `ultracode` = xhigh effort + standing dynamic-workflow orchestration; it is a
 * separate `ultracode` settings key rather than an `effortLevel` value.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;

/** Claude CLI effort level for new sessions (soft default, switchable via /effort in-session) */
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Type guard: is the string a valid EffortLevel? */
export function isEffortLevel(value: string | undefined): value is EffortLevel {
  return value !== undefined && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** OpenCode session configuration */
export interface OpenCodeConfig {
  /** Model identifier (e.g., "anthropic/claude-sonnet-4-5", "openai/gpt-5.2", "ollama/codellama") */
  model?: string;
  /** Whether to auto-allow all tool executions (sets permission.* = allow) */
  autoAllowTools?: boolean;
  /** Session ID to continue from */
  continueSession?: string;
  /** Whether to fork when continuing (branch the conversation) */
  forkSession?: boolean;
  /** Custom inline config JSON (passed via OPENCODE_CONFIG_CONTENT) */
  configContent?: string;
}

/** Codex (OpenAI CLI) browser rendering strategy. Hybrid TUI is the only supported mode. */
export type CodexRenderMode = 'hybrid';

/** Codex (OpenAI CLI) session configuration */
export interface CodexConfig {
  /** Model identifier (e.g., "gpt-5", "o4-mini"). Passed via --model. */
  model?: string;
  /** Resume a previous codex conversation by session id (passed via --resume) */
  resumeSessionId?: string;
  /** Bypass approval prompts (passes --dangerously-bypass-approvals-and-sandbox) */
  dangerouslyBypassApprovals?: boolean;
  /** Browser rendering strategy for Codex sessions. Hybrid TUI is the only supported mode. */
  renderMode?: CodexRenderMode;
}

/** Gemini CLI session configuration */
export interface GeminiConfig {
  /** Model identifier (e.g., "gemini-2.5-pro"). Passed via --model. */
  model?: string;
  /** Gemini approval mode for tool calls. */
  approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
  /** Resume a previous Gemini session ("latest", index, or session id). */
  resumeSession?: string;
}

/**
 * Configuration for creating a new session
 */
export interface SessionConfig {
  /** Unique session identifier */
  id: string;
  /** Working directory for the session */
  workingDir: string;
  /** Timestamp when session was created */
  createdAt: number;
}

/**
 * Available session colors for visual differentiation
 */
export type SessionColor = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink';

export type SessionAttachmentHistorySource = 'detected' | 'external';

/**
 * Session-scoped attachment history entry.
 *
 * `externalPath` is server-private. It may be present in the internal persisted
 * history copy, but API-bound session state must sanitize it before returning
 * to the browser.
 */
export interface SessionAttachmentHistoryItem {
  /** Stable history identity used for dedupe and list rendering */
  id: string;
  /** Codeman session ID this item belongs to */
  sessionId: string;
  /** Display filename */
  fileName: string;
  /** Lowercase extension without a leading dot */
  extension: string;
  /** Viewer category used by the web UI */
  attachmentType: AttachmentDetectedType;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp in milliseconds, if known */
  mtimeMs: number;
  /** Last time this attachment was seen or explicitly published */
  timestamp: number;
  /** How the attachment entered the session */
  source: SessionAttachmentHistorySource;
  /** Workspace-relative path for detected session files */
  relativePath?: string;
  /** Server-private absolute path for explicitly published external files */
  externalPath?: string;
}

/**
 * Current state of a session
 */
export interface SessionState {
  /** Unique session identifier */
  id: string;
  /** Process ID of the PTY process, null if not running */
  pid: number | null;
  /** Current session status */
  status: SessionStatus;
  /** Working directory path */
  workingDir: string;
  /** Remote execution metadata, present when this session runs over SSH through local tmux */
  remote?: SessionRemote;
  /** Docker execution metadata, present when this session runs inside a container via local tmux + docker exec */
  docker?: SessionDocker;
  /** Owning username in multi-user mode; undefined in single-user (ignored when the flag is off) */
  owner?: string;
  /** ID of currently assigned task, null if none */
  currentTaskId: string | null;
  /** Timestamp when session was created */
  createdAt: number;
  /** Timestamp of last activity */
  lastActivityAt: number;
  /** Session display name */
  name?: string;
  /** Session mode */
  mode?: SessionMode;
  /** Auto-clear enabled */
  autoClearEnabled?: boolean;
  /** Auto-clear token threshold */
  autoClearThreshold?: number;
  /** Auto-compact enabled */
  autoCompactEnabled?: boolean;
  /** Auto-compact token threshold */
  autoCompactThreshold?: number;
  /** Auto-compact prompt */
  autoCompactPrompt?: string;
  /** Auto-resume on usage limit enabled */
  autoResumeEnabled?: boolean;
  /** Pending usage-limit auto-resume fire time (epoch ms), if armed */
  autoResumeAt?: number;
  /** Pinned to the top of the session manager list (COD-139) */
  pinned?: boolean;
  /** When the session was pinned (epoch ms) — orders the pinned group, most-recent-first */
  pinnedAt?: number;
  /** Image watcher enabled for this session */
  imageWatcherEnabled?: boolean;
  /** Total cost in USD */
  totalCost?: number;
  /** Input tokens used */
  inputTokens?: number;
  /** Output tokens used */
  outputTokens?: number;
  /** Whether respawn controller is currently enabled/running */
  respawnEnabled?: boolean;
  /** Respawn controller config (if enabled) */
  respawnConfig?: RespawnConfig & { durationMinutes?: number };
  /** Ralph / Todo tracker enabled */
  ralphEnabled?: boolean;
  /** Ralph auto-enable disabled (user explicitly turned off Ralph) */
  ralphAutoEnableDisabled?: boolean;
  /** Ralph completion phrase (if set) */
  ralphCompletionPhrase?: string;
  /** Parent agent ID if this session is a spawned agent */
  parentAgentId?: string;
  /** Child agent IDs spawned by this session */
  childAgentIds?: string[];
  /** Nice priority enabled */
  niceEnabled?: boolean;
  /** Nice value (-20 to 19) */
  niceValue?: number;
  /** User-assigned color for visual differentiation */
  color?: SessionColor;
  /** Flicker filter enabled (buffers output after screen clears) */
  flickerFilterEnabled?: boolean;
  /** Claude Code CLI version (parsed from terminal, e.g., "2.1.27") */
  cliVersion?: string;
  /** Claude model in use (parsed from terminal, e.g., "Opus 4.5") */
  cliModel?: string;
  /** Account type (parsed from terminal, e.g., "Claude Max", "API") */
  cliAccountType?: string;
  /** Latest CLI version available (parsed from version check) */
  cliLatestVersion?: string;
  /** OpenCode-specific configuration (only for mode === 'opencode') */
  openCodeConfig?: OpenCodeConfig;
  /** Codex-specific configuration (only for mode === 'codex') */
  codexConfig?: CodexConfig;
  /** Gemini-specific configuration (only for mode === 'gemini') */
  geminiConfig?: GeminiConfig;
  /** Claude conversation session ID to resume after reboot (set by restore script) */
  resumeSessionId?: string;
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort?: EffortLevel;
  /** Sanitized per-session attachment history. */
  attachmentHistory?: SessionAttachmentHistoryItem[];
  /**
   * PTY-exit circuit breaker tripped — respawn blocked until an explicit restart
   * (COD-118). Runtime-only: never restored on boot (fresh server = fresh breaker).
   */
  respawnBlocked?: boolean;
}

/**
 * Output captured from a session
 */
