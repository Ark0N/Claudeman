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
 * - SessionMode — 'claude' | 'shell' | 'opencode' | 'codex' (which CLI backend)
 * - ClaudeMode — CLI permission mode ('dangerously-skip-permissions' | 'normal' | 'allowedTools')
 * - SessionColor — visual differentiation color
 * - OpenCodeConfig — OpenCode-specific settings (model, autoAllowTools, continueSession)
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
 * - `'normal'`: Standard mode with permission prompts
 * - `'allowedTools'`: Only allow specific tools (requires allowedTools list)
 */
export type ClaudeMode = 'dangerously-skip-permissions' | 'normal' | 'allowedTools';

/** Session mode: which CLI backend a session runs */
export type SessionMode = 'claude' | 'shell' | 'opencode' | 'codex';

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
  /** Claude conversation session ID to resume after reboot (set by restore script) */
  resumeSessionId?: string;
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort?: EffortLevel;
  /** Sanitized per-session attachment history. */
  attachmentHistory?: SessionAttachmentHistoryItem[];
}

/**
 * Output captured from a session
 */
