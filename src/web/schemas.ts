/**
 * @fileoverview Zod validation schemas for API routes
 *
 * This module contains Zod schemas for validating API request bodies.
 * Schemas are used in src/web/server.ts route handlers.
 *
 * @module web/schemas
 */

import { z } from 'zod';
import { SAFE_PATH_PATTERN, isSafePushEndpoint } from '../utils/index.js';
import {
  MAX_TERMINAL_BUFFER_BYTES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_BUFFER_BYTES,
  MIN_TERMINAL_SCROLLBACK_LINES,
} from '../config/terminal-history.js';

// ========== Path Validation ==========

/** Validate a path string: no shell metacharacters, no traversal, must be absolute */
export function isValidWorkingDir(p: string): boolean {
  if (!p || !p.startsWith('/')) return false;
  if (
    p.includes(';') ||
    p.includes('&') ||
    p.includes('|') ||
    p.includes('$') ||
    p.includes('`') ||
    p.includes('(') ||
    p.includes(')') ||
    p.includes('{') ||
    p.includes('}') ||
    p.includes('<') ||
    p.includes('>') ||
    p.includes("'") ||
    p.includes('"') ||
    p.includes('\n') ||
    p.includes('\r')
  ) {
    return false;
  }
  if (p.includes('..')) return false;
  return SAFE_PATH_PATTERN.test(p);
}

/** Zod refinement for safe absolute path */
const safePathSchema = z.string().max(1000).refine(isValidWorkingDir, {
  message: 'Invalid path: must be absolute, no shell metacharacters or traversal',
});

// ========== Env Var Allowlist ==========

/** Allowlisted env var key prefixes */
const ALLOWED_ENV_PREFIXES = ['CLAUDE_CODE_', 'OPENCODE_', 'CODEX_', 'GEMINI_', 'GOOGLE_'];

/** Env var keys that are always blocked (security-sensitive) */
const BLOCKED_ENV_KEYS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'CODEMAN_MUX_NAME',
  'CODEMAN_TMUX',
  'OPENCODE_SERVER_PASSWORD', // Security-sensitive: server auth password
]);

/** Validate that an env var key is allowed */
function isAllowedEnvKey(key: string): boolean {
  if (BLOCKED_ENV_KEYS.has(key)) return false;
  return ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Zod schema for env overrides with allowlist enforcement */
const safeEnvOverridesSchema = z
  .record(z.string(), z.string())
  .optional()
  .refine(
    (val) => {
      if (!val) return true;
      return Object.keys(val).every(isAllowedEnvKey);
    },
    {
      message:
        'envOverrides contains blocked or disallowed env var keys. Only CLAUDE_CODE_*, OPENCODE_*, CODEX_*, GEMINI_*, and GOOGLE_* keys are allowed.',
    }
  );

// ========== Effort Level ==========

/**
 * Claude CLI effort level for new sessions. Injected as a `--settings` soft default
 * (NOT the CLAUDE_CODE_EFFORT_LEVEL env var, which would hard-lock the session and
 * block in-session `/effort` switching). `ultracode` enables dynamic workflow orchestration.
 */
const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']).optional();

// ========== Session Routes ==========

/**
 * Schema for POST /api/sessions
 * Creates a new session with optional working directory, mode, and name.
 */
/** Schema for OpenCode-specific configuration */
const OpenCodeConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    autoAllowTools: z.boolean().optional(),
    continueSession: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    forkSession: z.boolean().optional(),
    configContent: z
      .string()
      .max(10000)
      .refine(
        (val) => {
          try {
            JSON.parse(val);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'configContent must be valid JSON' }
      )
      .optional(),
  })
  .optional();

/** Schema for Codex (OpenAI CLI)-specific configuration */
const CodexConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    resumeSessionId: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    dangerouslyBypassApprovals: z.boolean().optional(),
    renderMode: z
      .enum(['scrollback', 'hybrid'])
      .optional()
      .transform(() => 'hybrid' as const),
  })
  .optional();

/** Schema for Gemini CLI-specific configuration */
const GeminiConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    approvalMode: z.enum(['default', 'auto_edit', 'yolo', 'plan']).optional(),
    resumeSession: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
  })
  .optional();

export const CreateSessionSchema = z.object({
  workingDir: safePathSchema.optional(),
  mode: z.enum(['claude', 'shell', 'opencode', 'codex', 'gemini']).optional(),
  name: z.string().max(100).optional(),
  envOverrides: safeEnvOverridesSchema,
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort: effortLevelSchema,
  /** Model override to write to .claude/settings.local.json (e.g., "opus[1m]"). Empty string clears. */
  modelOverride: z.string().max(50).optional(),
  /** Inject the plan-usage statusLine exporter into the case (App Settings → Display → "Plan Usage Limits"). Claude-only. */
  statusLineTelemetry: z.boolean().optional(),
  openCodeConfig: OpenCodeConfigSchema,
  codexConfig: CodexConfigSchema,
  geminiConfig: GeminiConfigSchema,
  /** Resume a previous Claude conversation by its session ID (used for reboot recovery) */
  resumeSessionId: z
    .string()
    .max(100)
    .regex(/^[a-f0-9-]+$/, 'resumeSessionId must be a valid UUID')
    .optional(),
});

/**
 * Schema for POST /api/sessions/:id/run
 * Runs a prompt in a session.
 */
export const RunPromptSchema = z.object({
  prompt: z.string().min(1).max(100000),
});

/**
 * Schema for POST /api/sessions/:id/resize
 * Resizes a session's terminal.
 */
export const ResizeSchema = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
  viewportType: z.enum(['mobile', 'tablet', 'desktop']).optional(),
  force: z.boolean().optional(),
});

/**
 * Schema for POST /api/status-telemetry
 * Claude Code statusline payload forwarded by the Codeman-managed statusLine
 * exporter (see hooks-config.generateStatusLineCommand). Validates only the
 * subset Codeman displays; unknown keys (session_id, transcript_path, cwd, …)
 * are stripped by z.object. Auth-exempt like /api/hook-event.
 */
// NOTE: every modeled field is `.nullish()` (not `.optional()`) on purpose.
// Claude's statusline blob is officially shipped but undocumented in exact
// shape, and `z.optional()` REJECTS an explicit `null` (accepts only
// `undefined`) — a single stray `null` (e.g. `cost:{total_cost_usd:null}`)
// would 400 the ENTIRE POST before the deliberately-tolerant parser
// (usage-telemetry.ts, which only acts on `typeof === 'number'/'string'`) ever
// runs, silently killing the chip's data feed. `.nullish()` keeps the schema
// gate as forgiving as the parser it guards.
const RateLimitWindowSchema = z
  .object({
    used_percentage: z.number().nullish(),
    resets_at: z.number().nullish(),
  })
  .nullish();

export const StatusTelemetrySchema = z.object({
  sessionId: z.string().min(1).max(100),
  data: z
    .object({
      rate_limits: z
        .object({
          five_hour: RateLimitWindowSchema,
          seven_day: RateLimitWindowSchema,
        })
        .nullish(),
      context_window: z
        .object({
          used_percentage: z.number().nullish(),
          total_input_tokens: z.number().nullish(),
          total_output_tokens: z.number().nullish(),
        })
        .nullish(),
      cost: z.object({ total_cost_usd: z.number().nullish() }).nullish(),
      model: z.object({ display_name: z.string().max(100).nullish() }).nullish(),
    })
    .nullish(),
});

// ========== Case Routes ==========

/**
 * Schema for POST /api/cases
 * Creates a new case folder.
 */
export const CreateCaseSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.'),
  description: z.string().max(1000).optional(),
});

const RemoteCommandOverridesSchema = z
  .object({
    shell: z.string().min(1).max(300).optional(),
    claude: z.string().min(1).max(300).optional(),
    opencode: z.string().min(1).max(300).optional(),
    codex: z.string().min(1).max(300).optional(),
    gemini: z.string().min(1).max(300).optional(),
  })
  .strict()
  .optional();

// COD-107 — advanced SSH connection options. These ultimately exec as shell
// (ProxyCommand etc.), but are OPERATOR-entered host config (never attacker- or
// terminal-output-influenced), so we validate as defense-in-depth, not as the
// security boundary. Reject newline/NUL/backtick/`$(` shell-injection vectors.
const NO_SHELL_INJECTION = /^[^\n\r\0`]*$/;
const noCommandSubstitution = (s: string) => !s.includes('$(');

export const RemoteHostSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid remote host id'),
  label: z.string().min(1).max(100),
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._:-]+$/, 'Invalid SSH host'),
  username: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid SSH username'),
  port: z.number().int().min(1).max(65535).optional(),
  // Identity (private-key) file PATH only — never key bytes. No newline/NUL.
  identityFile: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\n\r\0]*$/, 'Invalid identity file path')
    .optional(),
  // SOCKS5 proxy as host:port (e.g. 127.0.0.1:1080).
  socksProxy: z
    .string()
    .regex(/^[\w.-]+:\d{1,5}$/, 'SOCKS proxy must be host:port')
    .optional(),
  // SSH jump host: a comma-separated chain of [user@]host[:port] hops. Structural
  // ALLOWLIST (not an open denylist) — only chars valid in user/host/port/IPv6,
  // so no shell metacharacter (;, |, &, space, $, quotes, …) can appear. The value
  // is also shellescaped at command-build time (buildSshConnectionArgs); this is the
  // belt to that suspenders.
  jumpHost: z
    .string()
    .min(1)
    .max(255)
    .regex(
      /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.:\[\]-]+(?::\d{1,5})?(?:,(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.:\[\]-]+(?::\d{1,5})?)*$/,
      'Jump host must be [user@]host[:port] (comma-separated for multiple hops)'
    )
    .optional(),
  // Arbitrary extra -o KEY=VALUE options (escape hatch); each must be KEY=VALUE.
  extraSshOptions: z
    .array(
      z
        .string()
        .min(3)
        .max(1024)
        .regex(/^[A-Za-z][A-Za-z0-9]*=.+$/, 'Extra SSH option must be KEY=VALUE')
        .regex(NO_SHELL_INJECTION, 'Invalid characters in SSH option')
        .refine(noCommandSubstitution, 'Invalid characters in SSH option')
    )
    .max(32)
    .optional(),
  commands: RemoteCommandOverridesSchema,
});

export const RemoteCaseLinkSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  hostId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid remote host id'),
  remotePath: z.string().min(1).max(2000).regex(/^\//, 'Remote path must be absolute'),
});

// ========== Quick Start ==========

/**
 * Schema for POST /api/quick-start
 * Creates case (if needed) and starts interactive session.
 */
export const QuickStartSchema = z.object({
  caseName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.')
    .optional(),
  mode: z.enum(['claude', 'shell', 'opencode', 'codex', 'gemini']).optional(),
  openCodeConfig: OpenCodeConfigSchema,
  codexConfig: CodexConfigSchema,
  geminiConfig: GeminiConfigSchema,
  envOverrides: safeEnvOverridesSchema,
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort: effortLevelSchema,
});

// ========== Hook Events ==========

/**
 * Schema for POST /api/hook-event
 * Receives Claude Code hook events.
 */
export const HookEventSchema = z.object({
  event: z.enum(['permission_prompt', 'elicitation_dialog', 'idle_prompt', 'stop', 'teammate_idle', 'task_completed']),
  sessionId: z.string().min(1),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});

// ========== Configuration ==========

/**
 * Schema for respawn configuration (partial updates allowed)
 * Used in PUT /api/config and respawn endpoints.
 */
export const RespawnConfigSchema = z.object({
  idleTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  updatePrompt: z.string().max(10000).optional(),
  interStepDelayMs: z.number().int().min(100).max(60000).optional(),
  enabled: z.boolean().optional(),
  sendClear: z.boolean().optional(),
  sendInit: z.boolean().optional(),
  kickstartPrompt: z.string().max(10000).optional(),
  completionConfirmMs: z.number().int().min(1000).max(60000).optional(),
  noOutputTimeoutMs: z.number().int().min(5000).max(600000).optional(),
  autoAcceptPrompts: z.boolean().optional(),
  autoAcceptDelayMs: z.number().int().min(1000).max(60000).optional(),
  aiIdleCheckEnabled: z.boolean().optional(),
  aiIdleCheckModel: z.string().max(100).optional(),
  aiIdleCheckMaxContext: z.number().int().min(1000).max(500000).optional(),
  aiIdleCheckTimeoutMs: z.number().int().min(10000).max(300000).optional(),
  aiIdleCheckCooldownMs: z.number().int().min(1000).max(300000).optional(),
  aiPlanCheckEnabled: z.boolean().optional(),
  aiPlanCheckModel: z.string().max(100).optional(),
  aiPlanCheckMaxContext: z.number().int().min(1000).max(500000).optional(),
  aiPlanCheckTimeoutMs: z.number().int().min(10000).max(300000).optional(),
  aiPlanCheckCooldownMs: z.number().int().min(1000).max(300000).optional(),
  adaptiveTimingEnabled: z.boolean().optional(),
  adaptiveMinConfirmMs: z.number().int().min(1000).max(60000).optional(),
  adaptiveMaxConfirmMs: z.number().int().min(1000).max(600000).optional(),
  skipClearWhenLowContext: z.boolean().optional(),
  skipClearThresholdPercent: z.number().int().min(0).max(100).optional(),
});

/**
 * Schema for PUT /api/config
 * Updates application configuration with whitelist of allowed fields.
 */
export const ConfigUpdateSchema = z
  .object({
    pollIntervalMs: z.number().int().min(100).max(60000).optional(),
    defaultTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
    maxConcurrentSessions: z.number().int().min(1).max(50).optional(),
    respawn: RespawnConfigSchema.optional(),
  })
  .strict();

/**
 * Schema for PUT /api/settings
 * Explicit allowlist of known settings fields — prevents arbitrary key persistence.
 */
const NotificationEventSchema = z
  .object({
    enabled: z.boolean().optional(),
    browser: z.boolean().optional(),
    audio: z.boolean().optional(),
    push: z.boolean().optional(),
  })
  .optional();

export const SettingsUpdateSchema = z
  .object({
    // Paths
    defaultClaudeMdPath: z.string().max(500).optional(),
    defaultWorkingDir: z.string().max(500).optional(),
    lastUsedCase: z.string().max(200).optional(),
    // Feature toggles
    ralphTrackerEnabled: z.boolean().optional(),
    subagentTrackingEnabled: z.boolean().optional(),
    subagentActiveTabOnly: z.boolean().optional(),
    /** Ultracode/Workflow run visualization (default OFF). Gates workflowRunWatcher + the master-detail tab. SYNCED. */
    showUltracodeAgents: z.boolean().optional(),
    /** Floating ultracode run windows w/ tab connector lines (default OFF). Also starts workflowRunWatcher. SYNCED. */
    ultracodeFloatingWindows: z.boolean().optional(),
    imageWatcherEnabled: z.boolean().optional(),
    tunnelEnabled: z.boolean().optional(),
    // Action field (NOT persisted): explicit per-request acknowledgment that the
    // operator accepts exposing an UNAUTHENTICATED public tunnel (no CODEMAN_PASSWORD).
    // Lets the UI enable a tunnel after a confirm dialog without the
    // CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK env var. Stripped before persisting.
    acknowledgeUnauthTunnel: z.boolean().optional(),
    tabTwoRows: z.boolean().optional(),
    agentTeamsEnabled: z.boolean().optional(),
    /** Model for new Claude sessions (e.g. "claude-fable-5[1m]", "opus[1m]"); takes precedence over opusContext1mEnabled */
    claudeModel: z.string().max(50).optional(),
    opusContext1mEnabled: z.boolean().optional(),
    thinkingEffort: z.string().max(20).optional(),
    // UI visibility
    showFontControls: z.boolean().optional(),
    showSystemStats: z.boolean().optional(),
    showTokenCount: z.boolean().optional(),
    showCost: z.boolean().optional(),
    showLifecycleLog: z.boolean().optional(),
    showResponseViewer: z.boolean().optional(),
    showMonitor: z.boolean().optional(),
    showProjectInsights: z.boolean().optional(),
    showFileBrowser: z.boolean().optional(),
    showSubagents: z.boolean().optional(),
    showMultiMonitorButton: z.boolean().optional(),
    showPlanUsageLimits: z.boolean().optional(),
    // Action field (NOT persisted as a setting): when true, (re)injects the
    // plan-usage statusLine exporter into active Claude sessions so live usage %
    // starts flowing. Sent on ENABLE only — the chip's DISPLAY is per-device
    // (client-side), but telemetry COLLECTION is server-side, so the per-device
    // toggle signals it out-of-band here rather than via showPlanUsageLimits.
    statusLineTelemetry: z.boolean().optional(),
    showRedrawButton: z.boolean().optional(),
    // Input
    gestureControlEnabled: z.boolean().optional(),
    // Claude CLI settings
    claudeMode: z.string().max(50).optional(),
    allowedTools: z.string().max(2000).optional(),
    // Codex CLI settings
    codexDangerouslyBypassApprovals: z.boolean().optional(),
    // Terminal history and retention
    terminalScrollbackLines: z
      .number()
      .int()
      .min(MIN_TERMINAL_SCROLLBACK_LINES)
      .max(MAX_TERMINAL_SCROLLBACK_LINES)
      .optional(),
    tmuxHistoryLimit: z.number().int().min(MIN_TERMINAL_SCROLLBACK_LINES).max(MAX_TERMINAL_SCROLLBACK_LINES).optional(),
    terminalBufferMaxBytes: z.number().int().min(MIN_TERMINAL_BUFFER_BYTES).max(MAX_TERMINAL_BUFFER_BYTES).optional(),
    terminalBufferTrimBytes: z.number().int().min(MIN_TERMINAL_BUFFER_BYTES).max(MAX_TERMINAL_BUFFER_BYTES).optional(),
    // CPU priority
    nice: z
      .object({
        enabled: z.boolean().optional(),
        niceValue: z.number().int().min(-20).max(19).optional(),
      })
      .optional(),
    // Notification preferences (cross-device sync)
    notificationPreferences: z
      .object({
        enabled: z.boolean().optional(),
        browserNotifications: z.boolean().optional(),
        audioAlerts: z.boolean().optional(),
        stuckThresholdMs: z.number().optional(),
        muteCritical: z.boolean().optional(),
        muteWarning: z.boolean().optional(),
        muteInfo: z.boolean().optional(),
        eventTypes: z
          .object({
            permission_prompt: NotificationEventSchema,
            elicitation_dialog: NotificationEventSchema,
            idle_prompt: NotificationEventSchema,
            stop: NotificationEventSchema,
            session_error: NotificationEventSchema,
            respawn_cycle: NotificationEventSchema,
            token_milestone: NotificationEventSchema,
            ralph_complete: NotificationEventSchema,
            subagent_spawn: NotificationEventSchema,
            subagent_complete: NotificationEventSchema,
          })
          .optional(),
        _version: z.number().optional(),
      })
      .optional(),
    // Voice settings (cross-device sync)
    voiceSettings: z
      .object({
        apiKey: z.string().max(200).optional(),
        language: z.string().max(20).optional(),
        keyterms: z.string().max(500).optional(),
        insertMode: z.string().max(20).optional(),
      })
      .optional(),
    // Run mode preference (cross-device sync)
    runMode: z.string().max(20).optional(),
    // Custom respawn presets (cross-device sync, replaces localStorage-only storage)
    respawnPresets: z
      .array(
        z.object({
          id: z.string().max(100),
          name: z.string().max(100),
          config: z.object({
            idleTimeoutMs: z.number().optional(),
            updatePrompt: z.string().max(5000).optional(),
            interStepDelayMs: z.number().optional(),
            sendClear: z.boolean().optional(),
            sendInit: z.boolean().optional(),
            kickstartPrompt: z.string().max(5000).optional(),
            autoAcceptPrompts: z.boolean().optional(),
          }),
          durationMinutes: z.number().optional(),
          builtIn: z.boolean().optional(),
          createdAt: z.number().optional(),
        })
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((settings, ctx) => {
    if (
      settings.terminalBufferMaxBytes !== undefined &&
      settings.terminalBufferTrimBytes !== undefined &&
      settings.terminalBufferTrimBytes > settings.terminalBufferMaxBytes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminalBufferTrimBytes'],
        message: 'terminalBufferTrimBytes must be less than or equal to terminalBufferMaxBytes',
      });
    }
  });

/**
 * Schema for POST /api/sessions/:id/input with length limit
 */
export const SessionInputWithLimitSchema = z.object({
  input: z.string().max(100000), // 100KB max input
  useMux: z.boolean().optional(),
  // Reliable-delivery dedup (optional; absent for curl/legacy clients). The web
  // client tags each input with a stable clientId + a monotonic per-session seq
  // and redelivers anything it hasn't seen ACKed (e.g. a frame silently dropped
  // by a half-open WebSocket on a flaky link). The server applies each (clientId,
  // seq) at-most-once via Session.shouldApplyInput so a redelivery can't type the
  // prompt twice. `.optional()` (not `.nullish()`) — the client omits them when
  // unset rather than sending null. See docs/reliable-input-delivery.md.
  seq: z.number().int().nonnegative().optional(),
  clientId: z.string().max(128).optional(),
});

// ========== Session Mutation Routes ==========

/** PUT /api/sessions/:id/name */
export const SessionNameSchema = z.object({
  name: z.string().min(0).max(128),
});

/** PUT /api/sessions/:id/color */
export const SessionColorSchema = z.object({
  color: z.string().max(30),
});

/** POST /api/sessions/:id/ralph-config */
export const RalphConfigSchema = z.object({
  enabled: z.boolean().optional(),
  completionPhrase: z.string().max(500).optional(),
  maxIterations: z.number().int().min(0).max(10000).optional(),
  maxTodos: z.number().int().positive().max(10000).optional(),
  todoExpirationMinutes: z.number().int().positive().max(525600).optional(),
  reset: z.union([z.boolean(), z.literal('full')]).optional(),
  disableAutoEnable: z.boolean().optional(),
});

/** POST /api/sessions/:id/fix-plan/import */
export const FixPlanImportSchema = z.object({
  content: z.string().max(500000),
});

/** POST /api/sessions/:id/ralph-prompt/write */
export const RalphPromptWriteSchema = z.object({
  content: z.string().max(500000),
});

/** POST /api/sessions/:id/auto-clear */
export const AutoClearSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(0).max(1000000).optional(),
});

/** POST /api/sessions/:id/auto-compact */
export const AutoCompactSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(0).max(1000000).optional(),
  prompt: z.string().max(10000).optional(),
});

/** POST /api/sessions/:id/auto-resume */
export const AutoResumeSchema = z.object({
  enabled: z.boolean(),
});

/** POST /api/sessions/:id/image-watcher */
export const ImageWatcherSchema = z.object({
  enabled: z.boolean(),
});

/** POST /api/sessions/:id/flicker-filter */
export const FlickerFilterSchema = z.object({
  enabled: z.boolean(),
});

/** POST /api/run */
export const QuickRunSchema = z.object({
  prompt: z.string().min(1).max(100000),
  workingDir: safePathSchema.optional(),
  envOverrides: safeEnvOverridesSchema,
});

/** POST /api/scheduled */
export const ScheduledRunSchema = z.object({
  prompt: z.string().min(1).max(100000),
  workingDir: safePathSchema.optional(),
  durationMinutes: z.number().int().min(1).max(14400).optional(),
});

/** POST /api/cases/link */
export const LinkCaseSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  path: safePathSchema,
});

/** PUT /api/cases/order */
export const CaseOrderSchema = z.object({
  order: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format')),
});

/** POST /api/auth/revoke */
export const RevokeSessionSchema = z.object({
  sessionToken: z.string().min(1).max(200).optional(),
});

/** POST /api/generate-plan */
export const GeneratePlanSchema = z.object({
  taskDescription: z.string().min(1).max(100000),
  detailLevel: z.enum(['brief', 'standard', 'detailed']).optional(),
});

/** POST /api/generate-plan-detailed */
export const GeneratePlanDetailedSchema = z.object({
  taskDescription: z.string().min(1).max(100000),
  caseName: z.string().max(200).optional(),
});

/** POST /api/cancel-plan-generation */
export const CancelPlanSchema = z.object({
  orchestratorId: z.string().max(200).optional(),
});

/** PATCH /api/sessions/:id/plan/task/:taskId */
export const PlanTaskUpdateSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'blocked']).optional(),
  error: z.string().max(10000).optional(),
  incrementAttempts: z.boolean().optional(),
});

/** POST /api/sessions/:id/plan/task (add task) */
export const PlanTaskAddSchema = z.object({
  content: z.string().min(1).max(10000),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  verificationCriteria: z.string().max(10000).optional(),
  dependencies: z.array(z.string().max(200)).optional(),
  insertAfter: z.string().max(200).optional(),
});

/** POST /api/sessions/:id/cpu-limit */
export const CpuLimitSchema = z.object({
  cpuLimit: z.number().int().min(0).max(100).optional(),
  ioClass: z.enum(['idle', 'best-effort', 'realtime']).optional(),
  ioLevel: z.number().int().min(0).max(7).optional(),
});

/** PUT /api/execution/model-config */
export const ModelConfigUpdateSchema = z.record(z.string(), z.unknown());

/** PUT /api/subagent-window-states */
export const SubagentWindowStatesSchema = z
  .object({
    minimized: z.record(z.string(), z.boolean()).optional(),
    open: z.array(z.string()).optional(),
  })
  .passthrough();

/** PUT /api/subagent-parents */
export const SubagentParentMapSchema = z.record(z.string(), z.string());

/** POST /api/sessions/:id/interactive-respawn */
export const InteractiveRespawnSchema = z.object({
  respawnConfig: RespawnConfigSchema.optional(),
  durationMinutes: z.number().int().min(1).max(14400).optional(),
});

/** POST /api/sessions/:id/respawn/enable */
export const RespawnEnableSchema = z.object({
  config: RespawnConfigSchema.optional(),
  durationMinutes: z.number().int().min(1).max(14400).optional(),
});

// ========== Web Push ==========

/** POST /api/push/subscribe */
export const PushSubscribeSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine(isSafePushEndpoint, { message: 'endpoint must be an https URL to a public (non-internal) host' }),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
  userAgent: z.string().max(500).optional(),
  pushPreferences: z.record(z.string(), z.boolean()).optional(),
});

/** PUT /api/push/subscribe/:id */
export const PushPreferencesUpdateSchema = z.object({
  pushPreferences: z.record(z.string(), z.boolean()),
});

// ========== Ralph Loop ==========

/** POST /api/ralph-loop/start */
export const RalphLoopStartSchema = z.object({
  caseName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format')
    .optional()
    .default('testcase'),
  taskDescription: z.string().min(1).max(100000),
  completionPhrase: z.string().max(100).default('COMPLETE'),
  maxIterations: z.number().int().min(0).max(1000).nullable().default(10),
  enableRespawn: z.boolean().default(false),
  envOverrides: safeEnvOverridesSchema,
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort: effortLevelSchema,
  planItems: z
    .array(
      z.object({
        content: z.string(),
        priority: z.string().optional(),
        enabled: z.boolean().default(true),
      })
    )
    .optional(),
});

// ========== Orchestrator Loop ==========

/** POST /api/orchestrator/start */
export const OrchestratorStartSchema = z.object({
  goal: z.string().min(1).max(100000),
  config: z
    .object({
      plannerModel: z.string().max(100).optional(),
      researchEnabled: z.boolean().optional(),
      autoApprove: z.boolean().optional(),
      maxPhaseRetries: z.number().int().min(1).max(10).optional(),
      phaseTimeoutMs: z.number().int().min(60000).max(7200000).optional(),
      enableTeamAgents: z.boolean().optional(),
      maxParallelSessions: z.number().int().min(1).max(10).optional(),
      verificationMode: z.enum(['strict', 'moderate', 'lenient']).optional(),
      compactBetweenPhases: z.boolean().optional(),
    })
    .optional(),
});

/** POST /api/orchestrator/reject */
export const OrchestratorRejectSchema = z.object({
  feedback: z.string().min(1).max(10000),
});

// ========== Cross-Session Search (COD-9) ==========

/** Valid federated source kinds for `GET /api/search?types=`. */
export const SEARCH_SOURCE_TYPES = ['session', 'event', 'file'] as const;

/**
 * GET /api/search query validation.
 *
 * Query params arrive as strings: `q` is bounded (1..200 chars), `types` is an
 * optional comma-separated allowlisted CSV, and `limit` is an optional coerced
 * integer clamped to 1..60. Validation is the first line of defense — a missing
 * or oversized `q`, an unknown type, or a non-numeric limit is rejected with 400.
 */
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Query is required').max(200, 'Query too long (max 200 chars)'),
  types: z
    .string()
    .max(100)
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        v
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .every((t) => (SEARCH_SOURCE_TYPES as readonly string[]).includes(t)),
      { message: 'Invalid types value' }
    ),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});
