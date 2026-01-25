/**
 * @fileoverview AI-Powered Idle Checker for Respawn Controller
 *
 * Spawns a fresh Claude CLI session in a screen to analyze terminal output
 * and provide a definitive IDLE/WORKING verdict. This replaces the "Worked for Xm Xs"
 * pattern as the primary idle detection signal.
 *
 * ## How It Works
 *
 * 1. Generate temp file path for output capture
 * 2. Spawn screen: `screen -dmS claudeman-aicheck-<short> bash -c 'claude -p ...'`
 * 3. Poll the temp file every 500ms for `__AICHECK_DONE__` marker
 * 4. Parse the file content for IDLE/WORKING on the first word
 * 5. Kill screen and delete temp file
 *
 * ## Error Handling
 *
 * - Screen spawn fails: 1-min cooldown, increment error counter
 * - Check times out (90s): Kill screen, 1-min cooldown
 * - Can't parse IDLE/WORKING: Treat as WORKING, 1-min cooldown
 * - 3 consecutive errors: Disable AI check, fall back to noOutputTimeoutMs
 * - Claude CLI not found: Disable permanently
 *
 * @module ai-idle-checker
 */

import {
  AiCheckerBase,
  type AiCheckerConfigBase,
  type AiCheckerResultBase,
  type AiCheckerStateBase,
  type AiCheckerStatus,
} from './ai-checker-base.js';

// ========== Types ==========

export interface AiIdleCheckConfig extends AiCheckerConfigBase {}

// Re-export the status type for backwards compatibility
export type AiCheckStatus = AiCheckerStatus;
export type AiCheckVerdict = 'IDLE' | 'WORKING' | 'ERROR';

export interface AiCheckResult extends AiCheckerResultBase<AiCheckVerdict> {}

export interface AiCheckState extends AiCheckerStateBase<AiCheckVerdict> {}

/** Events emitted by AiIdleChecker */
export interface AiIdleCheckerEvents {
  checkStarted: () => void;
  checkCompleted: (result: AiCheckResult) => void;
  checkFailed: (error: string) => void;
  cooldownStarted: (endsAt: number) => void;
  cooldownEnded: () => void;
  disabled: (reason: string) => void;
  log: (message: string) => void;
}

// ========== Constants ==========

const DEFAULT_AI_CHECK_CONFIG: AiIdleCheckConfig = {
  enabled: true,
  model: 'claude-opus-4-5-20251101',
  maxContextChars: 16000,
  checkTimeoutMs: 90000,
  cooldownMs: 180000,
  errorCooldownMs: 60000,
  maxConsecutiveErrors: 3,
};

/** Pattern to match IDLE or WORKING as the first word of output */
const VERDICT_PATTERN = /^\s*(IDLE|WORKING)\b/i;

/** The prompt sent to the AI checker */
const AI_CHECK_PROMPT = `Analyze this terminal output from a running Claude Code session. Determine if the session is IDLE (done working, waiting for new input) or WORKING (still actively processing).

IMPORTANT: When in doubt, answer WORKING. Brief pauses between tool executions do NOT mean the session is idle. Claude may be processing or about to output more.

IDLE indicators (need MULTIPLE of these to confirm idle):
- Completion summary shown (e.g., "✻ Worked for 2m 46s", "Worked for 5s")
- Prompt character visible at the end (❯ or similar)
- Cost summary displayed (e.g., "$0.12 spent")
- Clear end of output with no pending work

WORKING indicators (ANY of these means WORKING):
- Spinner characters (⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏ or similar)
- Activity text: Thinking, Writing, Reading, Running, Searching, Editing, Creating, Deleting, Analyzing, Executing, Synthesizing, Compiling, Building, Processing, Loading, Generating, Testing, Checking, Validating
- Tool execution in progress (commands being run)
- Truncated or partial lines at the end
- File operations in progress
- Output that appears mid-stream or incomplete
- No completion summary visible yet

Terminal output (most recent at bottom):
---
{TERMINAL_BUFFER}
---

Answer with EXACTLY one word on the first line: IDLE or WORKING
If uncertain, answer WORKING. Then briefly explain why.`;

// ========== AiIdleChecker Class ==========

/**
 * Manages AI-powered idle detection by spawning a fresh Claude CLI session
 * to analyze terminal output and provide a definitive IDLE/WORKING verdict.
 */
export class AiIdleChecker extends AiCheckerBase<
  AiCheckVerdict,
  AiIdleCheckConfig,
  AiCheckResult,
  AiCheckState
> {
  protected readonly screenNamePrefix = 'claudeman-aicheck-';
  protected readonly doneMarker = '__AICHECK_DONE__';
  protected readonly tempFilePrefix = 'claudeman-aicheck';
  protected readonly logPrefix = '[AiIdleChecker]';
  protected readonly checkDescription = 'AI idle check';

  constructor(sessionId: string, config: Partial<AiIdleCheckConfig> = {}) {
    super(sessionId, DEFAULT_AI_CHECK_CONFIG, config);
  }

  protected buildPrompt(terminalBuffer: string): string {
    return AI_CHECK_PROMPT.replace('{TERMINAL_BUFFER}', terminalBuffer);
  }

  protected parseVerdict(output: string): { verdict: AiCheckVerdict; reasoning: string } | null {
    const match = output.match(VERDICT_PATTERN);
    if (!match) return null;

    const verdict = match[1].toUpperCase() as 'IDLE' | 'WORKING';
    const lines = output.split('\n');
    const reasoning = lines.slice(1).join('\n').trim() || `AI determined: ${verdict}`;

    return { verdict, reasoning };
  }

  protected getPositiveVerdict(): AiCheckVerdict {
    return 'IDLE';
  }

  protected getNegativeVerdict(): AiCheckVerdict {
    return 'WORKING';
  }

  protected getErrorVerdict(): AiCheckVerdict {
    return 'ERROR';
  }

  protected createErrorResult(reasoning: string, durationMs: number): AiCheckResult {
    return { verdict: 'ERROR', reasoning, durationMs };
  }

  protected createResult(verdict: AiCheckVerdict, reasoning: string, durationMs: number): AiCheckResult {
    return { verdict, reasoning, durationMs };
  }
}
