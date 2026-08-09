/**
 * @fileoverview Read My Mind predictor: one-shot `claude -p` over the
 * assembled prediction context (docs/readmymind-plan.md).
 *
 * Reuses the AiCheckerBase spawn mechanics (prompt file to dodge E2BIG, a
 * throwaway detached tmux session, done-marker polling, timeout, shell-safety
 * validation) but stays standalone: the base class is verdict-shaped
 * (positive/negative/cooldown) and prediction is freeform JSON, so subclassing
 * would abuse `reasoning` as a payload.
 *
 * The predictor is deliberately dumb, text in / JSON out; all intelligence
 * about WHAT to include lives in the testable assembler
 * (`readmymind-context.ts`). Output parsing (`parsePredictionOutput`) is pure
 * and strict: garbage output is a clean error, never a half-suggestion, and
 * suggestion prompts are collapsed to single lines server-side (multi-line
 * breaks Ink).
 *
 * Exported as a mutable singleton (`readMyMindPredictor`) so route tests can
 * stub `predict` without spawning anything.
 */

import { execSync, spawn as childSpawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isValidModelName, isValidMuxName } from './ai-checker-base.js';
import { getAugmentedPath } from './utils/index.js';
import { getErrorMessage } from './types.js';

// ========== Contract ==========

export type SuggestionKind = 'continue' | 'verify' | 'redirect';

export interface ReadMyMindSuggestion {
  /** The proposed next prompt: single line, bounded. */
  prompt: string;
  /** One-sentence rationale. */
  why: string;
  kind: SuggestionKind;
}

export interface PredictionResult {
  suggestions: ReadMyMindSuggestion[];
  durationMs: number;
}

/** Opus headroom over a ~30 KB prompt (decided in the design doc). */
export const READMYMIND_TIMEOUT_MS = 90_000;

const MAX_SUGGESTION_CHARS = 1_000;
const MAX_WHY_CHARS = 300;
const DONE_MARKER = '__RMM_DONE__';
const POLL_INTERVAL_MS = 500;

/** Lenient on extra keys (zod strips unknowns), strict on shape. */
const SuggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        prompt: z.string(),
        why: z.string().optional(),
        kind: z.enum(['continue', 'verify', 'redirect']),
      })
    )
    .min(1)
    .max(3),
});

/** Collapse to one line: embedded newlines break Ink's composer. */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * Parse the model's raw output into validated suggestions. Strict by design:
 * anything that does not contain the JSON contract is an Error, never a
 * half-suggestion. Tolerates fenced/prosed wrapping by extracting the
 * outermost object literal before parsing.
 */
export function parsePredictionOutput(raw: string): ReadMyMindSuggestion[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Predictor returned no JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Predictor returned malformed JSON');
  }

  const result = SuggestionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Predictor output did not match the suggestions contract');
  }

  const suggestions = result.data.suggestions
    .map((s) => ({
      prompt: singleLine(s.prompt).slice(0, MAX_SUGGESTION_CHARS),
      why: singleLine(s.why ?? '').slice(0, MAX_WHY_CHARS),
      kind: s.kind,
    }))
    .filter((s) => s.prompt.length > 0);

  if (suggestions.length === 0) {
    throw new Error('Predictor returned only empty suggestions');
  }
  return suggestions;
}

// ========== Spawn/poll runner ==========

export interface PredictOptions {
  /** Codeman session id; only its first 8 chars name the throwaway tmux session. */
  sessionId: string;
  /** The assembled context prompt (readmymind-context.ts). */
  prompt: string;
  /** Model name; shell-validated before use. */
  model: string;
  timeoutMs?: number;
}

async function runPrediction(options: PredictOptions): Promise<PredictionResult> {
  const { sessionId, prompt, model } = options;
  const timeoutMs = options.timeoutMs ?? READMYMIND_TIMEOUT_MS;

  if (!isValidModelName(model)) {
    throw new Error(`Invalid model name: ${String(model).substring(0, 50)}`);
  }

  const shortId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'rmm';
  const timestamp = Date.now();
  const outFile = join(tmpdir(), `codeman-rmm-${shortId}-${timestamp}.txt`);
  const stderrFile = join(tmpdir(), `codeman-rmm-stderr-${shortId}-${timestamp}.txt`);
  const promptFile = join(tmpdir(), `codeman-rmm-prompt-${shortId}-${timestamp}.txt`);
  const muxName = `codeman-rmm-${shortId}`;
  if (!isValidMuxName(muxName)) {
    throw new Error(`Invalid mux name generated: ${muxName.substring(0, 50)}`);
  }

  writeFileSync(outFile, '');
  writeFileSync(stderrFile, '');
  // Prompt via file + stdin: ~30 KB exceeds argv comfort (E2BIG).
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  const modelArg = `--model "${model.replace(/"/g, '\\"')}"`;
  const claudeCmd = `cat "${promptFile}" | claude -p ${modelArg} --output-format text`;
  const fullCmd = `export PATH="${getAugmentedPath()}"; ${claudeCmd} > "${outFile}" 2> "${stderrFile}"; echo "${DONE_MARKER}" >> "${outFile}"; rm -f "${promptFile}"`;

  const startTime = Date.now();
  let pollTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const cleanup = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    pollTimer = null;
    timeoutTimer = null;
    try {
      execSync(`tmux kill-session -t "${muxName}" 2>/dev/null`, { timeout: 2000 });
    } catch {
      // Session already gone.
    }
    for (const file of [outFile, stderrFile, promptFile]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  try {
    try {
      execSync(`tmux kill-session -t "${muxName}" 2>/dev/null`, { timeout: 3000 });
    } catch {
      // No leftover session: fine.
    }
    const muxProcess = childSpawn('tmux', ['new-session', '-d', '-s', muxName, 'bash', '-c', fullCmd], {
      detached: true,
      stdio: 'ignore',
    });
    muxProcess.unref();
  } catch (err) {
    cleanup();
    throw new Error(`Failed to spawn prediction tmux session: ${getErrorMessage(err)}`);
  }

  return new Promise<PredictionResult>((resolve, reject) => {
    let settled = false;

    pollTimer = setInterval(() => {
      if (settled) return;
      try {
        if (!existsSync(outFile)) return;
        const content = readFileSync(outFile, 'utf-8');
        if (!content.includes(DONE_MARKER)) return;
        settled = true;
        const durationMs = Date.now() - startTime;
        const output = content.replace(DONE_MARKER, '').trim();
        if (!output) {
          const stderr = readStderr(stderrFile);
          cleanup();
          reject(new Error(`Predictor produced no output${stderr ? `: ${stderr}` : ''}`));
          return;
        }
        try {
          const suggestions = parsePredictionOutput(output);
          cleanup();
          resolve({ suggestions, durationMs });
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(getErrorMessage(err)));
        }
      } catch {
        // Output file mid-write or already removed: keep polling.
      }
    }, POLL_INTERVAL_MS);

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Prediction timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function readStderr(stderrFile: string): string {
  try {
    return existsSync(stderrFile) ? readFileSync(stderrFile, 'utf-8').trim().substring(0, 200) : '';
  } catch {
    return '';
  }
}

/**
 * Mutable singleton: routes call `readMyMindPredictor.predict(...)`; tests
 * stub the property (`vi.spyOn(readMyMindPredictor, 'predict')`).
 */
export const readMyMindPredictor = {
  predict: runPrediction,
};
