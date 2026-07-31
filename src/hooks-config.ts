/**
 * @fileoverview Claude Code hooks configuration generator.
 *
 * Generates `.claude/settings.local.json` with hook definitions that POST
 * to Codeman's `/api/hook-event` endpoint when Claude Code fires hooks.
 * Uses `$CODEMAN_API_URL`, `$CODEMAN_SESSION_ID`, and `$CODEMAN_HOOK_SECRET_FILE`
 * env vars (set on every managed session) so the config is static per case
 * directory and free of secret values.
 *
 * Key exports:
 * - `generateHooksConfig()` — returns hooks object for settings.local.json
 * - `writeHooksConfig(casePath)` — writes hooks + env config to disk
 * - `updateCaseEnvVars(casePath, envVars)` — merges env vars into settings
 *
 * Hook events generated: `idle_prompt`, `permission_prompt`, `elicitation_dialog`,
 * `stop`, `teammate_idle`, `task_completed`
 *
 * Hook categories: `Notification` (3 matchers), `Stop` (1), `TeammateIdle` (1),
 * `TaskCompleted` (1), `PostToolUse` (1 self-contained background Bash rewake)
 *
 * @dependencies types (HookEventType), config/auth-config (HOOK_TIMEOUT_SECONDS)
 * @consumedby web/server (session creation), session-cli-builder (env setup)
 *
 * @module hooks-config
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { HookEventType } from './types.js';
import { HOOK_TIMEOUT_SECONDS } from './config/auth-config.js';

/**
 * Serializes read-modify-write access to a `settings.local.json` path. Every
 * writer in this module (hooks, env, model, statusLine) shares this map, so
 * concurrent updates to the SAME file — e.g. session-create writing hooks/model
 * while an App-Settings toggle injects the statusLine into the same repo — can't
 * lose each other's changes through interleaved read-then-write. Per-path chains
 * are independent; the map self-prunes when a path's chain goes idle.
 */
const settingsWriteLocks = new Map<string, Promise<unknown>>();
/**
 * Version-agnostic ownership prefix: every rewake script version embeds a marker
 * starting with this, and `isCodemanHookHandler` matches on the prefix. That way a
 * version bump replaces the old handler instead of duplicating it (matching on the
 * full versioned marker would disown every older script).
 */
const BACKGROUND_WAKE_MARKER_PREFIX = 'CODEMAN_BACKGROUND_REWAKE_V';
/**
 * Current script version. Bump the suffix whenever `generateBackgroundWakeScript`
 * changes: `refreshStaleCodemanHooks` treats the absence of the CURRENT marker as
 * stale, so healed cases pick up the new script on next launch.
 */
const BACKGROUND_WAKE_MARKER = `${BACKGROUND_WAKE_MARKER_PREFIX}2`;
const BACKGROUND_WAKE_TIMEOUT_SECONDS = 6 * 60 * 60;

/**
 * Inline Node helper for Claude Code's `asyncRewake` hook.
 *
 * A background Bash tool returns immediately with a task ID, then Claude writes
 * its completion as a queue-operation in the transcript. Watching that durable
 * record avoids injecting terminal input (which could submit a user's draft).
 * The helper is embedded in settings via `node -e`, so it has no script path
 * that can go stale after an install or plugin-cache cleanup.
 *
 * Self-terminating: Claude Code enforces the hook timeout, but the helper does not
 * rely on it. It exits on its own deadline (same budget) and when orphaned
 * (`ppid === 1`), so a dead session cannot leave a poller stat-ing the transcript
 * forever. The ppid check misses subreaper setups; the deadline is the backstop.
 */
export function generateBackgroundWakeScript(): string {
  return [
    "const fs = require('node:fs');",
    `const ${BACKGROUND_WAKE_MARKER} = true;`,
    `const deadline = Date.now() + ${BACKGROUND_WAKE_TIMEOUT_SECONDS} * 1000;`,
    'let input = {};',
    "try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }",
    'function findTaskId(value) {',
    "  const idKeys = new Set(['taskId', 'task_id', 'shellId', 'shell_id', 'backgroundTaskId', 'background_task_id']);",
    '  const stack = [value];',
    '  const seen = new Set();',
    '  while (stack.length > 0) {',
    '    const current = stack.pop();',
    "    if (!current || typeof current !== 'object' || seen.has(current)) continue;",
    '    seen.add(current);',
    '    for (const [key, nested] of Object.entries(current)) {',
    "      if (idKeys.has(key) && typeof nested === 'string' && /^[A-Za-z0-9_-]+$/.test(nested)) return nested;",
    "      if (nested && typeof nested === 'object') stack.push(nested);",
    '    }',
    '  }',
    "  const serialized = JSON.stringify(value ?? '');",
    '  const messageMatch = serialized.match(/Command running in background with ID:\\s*([A-Za-z0-9_-]+)/i);',
    '  if (messageMatch) return messageMatch[1];',
    '  const pathMatch = serialized.match(/[\\\\/]tasks[\\\\/]([A-Za-z0-9_-]+)\\.output/i);',
    '  return pathMatch ? pathMatch[1] : null;',
    '}',
    'const taskId = findTaskId(input.tool_response);',
    "const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';",
    'if (!taskId || !transcriptPath) process.exit(0);',
    'let position = 0;',
    'try { position = Math.max(0, fs.statSync(transcriptPath).size - 262144); } catch { process.exit(0); }',
    "let carry = '';",
    'function inspect(text) {',
    '  for (const line of text.split(/\\r?\\n/)) {',
    '    if (!line.includes(taskId)) continue;',
    '    let entry;',
    '    try { entry = JSON.parse(line); } catch { continue; }',
    "    if (entry.type !== 'queue-operation' || typeof entry.content !== 'string') continue;",
    "    if (!entry.content.includes('<task-id>' + taskId + '</task-id>')) continue;",
    '    const status = entry.content.match(/<status>(completed|failed|killed|error)<\\/status>/i);',
    '    if (!status) continue;',
    '    const output = entry.content.match(/<output-file>([^<]+)<\\/output-file>/i);',
    "    const location = output ? ' Read ' + output[1] + ' and' : '';",
    "    console.error('Background command ' + taskId + ' ' + status[1].toLowerCase() + '.' + location + ' continue the task.');",
    '    process.exit(2);',
    '  }',
    '}',
    'function poll() {',
    '  if (Date.now() > deadline || process.ppid === 1) process.exit(0);',
    '  try {',
    '    const size = fs.statSync(transcriptPath).size;',
    "    if (size < position) { position = 0; carry = ''; }",
    '    if (size > position) {',
    '      const length = Math.min(size - position, 1048576);',
    '      const buffer = Buffer.allocUnsafe(length);',
    "      const fd = fs.openSync(transcriptPath, 'r');",
    '      const bytes = fs.readSync(fd, buffer, 0, length, position);',
    '      fs.closeSync(fd);',
    '      position += bytes;',
    "      carry = (carry + buffer.subarray(0, bytes).toString('utf8')).slice(-262144);",
    '      inspect(carry);',
    '    }',
    '  } catch {}',
    '  setTimeout(poll, 1000);',
    '}',
    'poll();',
  ].join('\n');
}

function withSettingsLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = settingsWriteLocks.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the prior writer, regardless of its outcome
  // Tail never rejects, so a failed write doesn't poison subsequent writers.
  const tail = run.then(
    () => {},
    () => {}
  );
  settingsWriteLocks.set(path, tail);
  void tail.then(() => {
    if (settingsWriteLocks.get(path) === tail) settingsWriteLocks.delete(path);
  });
  return run;
}

/**
 * Generates the hooks section for .claude/settings.local.json
 *
 * The hook commands read stdin JSON from Claude Code (contains tool_name,
 * tool_input, etc.) and forward it as the `data` field to Codeman's API.
 * Env vars are resolved at runtime by the shell, so the config is static
 * per case directory.
 */
export function generateHooksConfig(): { hooks: Record<string, unknown[]> } {
  // Read Claude Code's stdin JSON and forward it as the data field.
  // Falls back to empty object if stdin is unavailable or malformed.
  // COD-54: present the per-instance hook secret so the bypass keeps working while
  // a tunnel is running. The value is read from the secret file AT EXECUTION TIME
  // (path via $CODEMAN_HOOK_SECRET_FILE, set in every managed session's env), so it
  // never lands in this config and rotation needs no respawn. If the var/file is
  // missing the header is empty — the middleware then allows the request only on
  // the plain loopback bypass (tunnel down), same as pre-secret behavior.
  const curlCmd = (event: HookEventType) =>
    `HOOK_DATA=$(cat 2>/dev/null || echo '{}'); ` +
    `printf '{"event":"${event}","sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$HOOK_DATA" | ` +
    `curl -s -X POST "$CODEMAN_API_URL/api/hook-event" ` +
    `-H 'Content-Type: application/json' ` +
    `-H "X-Codeman-Hook-Secret: $(cat "$CODEMAN_HOOK_SECRET_FILE" 2>/dev/null)" ` +
    `--data @- ` +
    `2>/dev/null || true`;

  return {
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command', command: curlCmd('idle_prompt'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command', command: curlCmd('permission_prompt'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
        {
          matcher: 'elicitation_dialog',
          hooks: [{ type: 'command', command: curlCmd('elicitation_dialog'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: curlCmd('stop'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
      TeammateIdle: [
        {
          hooks: [{ type: 'command', command: curlCmd('teammate_idle'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
      TaskCompleted: [
        {
          hooks: [{ type: 'command', command: curlCmd('task_completed'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['-e', generateBackgroundWakeScript()],
              asyncRewake: true,
              timeout: BACKGROUND_WAKE_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

function isCodemanHookHandler(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    // Prefix, not the versioned marker: older script versions must still be ours.
    return serialized.includes('/api/hook-event') || serialized.includes(BACKGROUND_WAKE_MARKER_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Replace only Codeman-owned command handlers while preserving user events,
 * matcher entries, and sibling handlers in mixed entries.
 */
function mergeCodemanHooks(existingValue: unknown, generated: Record<string, unknown[]>): Record<string, unknown[]> {
  const existing =
    existingValue && typeof existingValue === 'object' && !Array.isArray(existingValue)
      ? (existingValue as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown[]> = {};

  for (const eventName of new Set([...Object.keys(existing), ...Object.keys(generated)])) {
    const existingEntries = Array.isArray(existing[eventName]) ? (existing[eventName] as unknown[]) : [];
    const generatedEntries = generated[eventName];
    if (!generatedEntries) {
      merged[eventName] = existingEntries;
      continue;
    }

    const entries: unknown[] = [];
    let insertedGenerated = false;
    for (const entry of existingEntries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        if (!isCodemanHookHandler(entry)) entries.push(entry);
        continue;
      }

      const record = entry as Record<string, unknown>;
      if (!Array.isArray(record.hooks)) {
        if (isCodemanHookHandler(record)) {
          if (!insertedGenerated) {
            entries.push(...generatedEntries);
            insertedGenerated = true;
          }
        } else {
          entries.push(entry);
        }
        continue;
      }

      const retainedHandlers = record.hooks.filter((handler) => !isCodemanHookHandler(handler));
      const removedCodemanHandler = retainedHandlers.length !== record.hooks.length;
      if (removedCodemanHandler && !insertedGenerated) {
        entries.push(...generatedEntries);
        insertedGenerated = true;
      }
      if (retainedHandlers.length > 0 || !removedCodemanHandler) {
        entries.push(retainedHandlers.length === record.hooks.length ? entry : { ...record, hooks: retainedHandlers });
      }
    }

    if (!insertedGenerated) entries.push(...generatedEntries);
    merged[eventName] = entries;
  }

  return merged;
}

/**
 * Remove a subset of env keys from .claude/settings.local.json.env if present.
 * Used during the disk→tmux-setenv migration: when the caller is actively setting
 * a fresh value for a Codeman-managed key, any stale disk entry for THAT KEY is
 * superseded and should be removed. Keys NOT in `keysToRemove` are left alone
 * (they may be user-managed). No-op if the file/keys don't exist.
 */
export async function stripCaseEnvKeys(casePath: string, keysToRemove: readonly string[]): Promise<void> {
  if (keysToRemove.length === 0) return;

  const settingsPath = join(casePath, '.claude', 'settings.local.json');
  await withSettingsLock(settingsPath, async () => {
    if (!existsSync(settingsPath)) return;

    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      return; // Malformed — don't rewrite it
    }

    const env = existing.env as Record<string, string> | undefined;
    if (!env) return;

    let changed = false;
    for (const key of keysToRemove) {
      if (key in env) {
        delete env[key];
        changed = true;
      }
    }
    if (!changed) return;

    existing.env = env;
    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  });
}

/**
 * Updates env vars in .claude/settings.local.json for the given case path.
 * Merges with existing env field; removes vars set to empty string.
 */
export async function updateCaseEnvVars(casePath: string, envVars: Record<string, string>): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');
  await withSettingsLock(settingsPath, async () => {
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      existing = {};
    }

    const currentEnv = (existing.env as Record<string, string>) || {};
    for (const [key, value] of Object.entries(envVars)) {
      if (value) {
        currentEnv[key] = value;
      } else {
        delete currentEnv[key];
      }
    }
    existing.env = currentEnv;

    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  });
}

/**
 * Updates the `model` field in .claude/settings.local.json for the given case path.
 * Pass a non-empty string to set, or empty/null to remove.
 */
export async function updateCaseModel(casePath: string, model: string | null): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');
  await withSettingsLock(settingsPath, async () => {
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      existing = {};
    }

    if (model) {
      existing.model = model;
    } else {
      delete existing.model;
    }

    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  });
}

/**
 * Writes hooks config to .claude/settings.local.json in the given case path.
 * Merges with existing file content, only touching the `hooks` key.
 */
export async function writeHooksConfig(casePath: string): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');
  await withSettingsLock(settingsPath, async () => {
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      // If file is malformed or doesn't exist, start fresh
      existing = {};
    }

    const hooksConfig = generateHooksConfig();
    const merged = {
      ...existing,
      hooks: mergeCodemanHooks(existing.hooks, hooksConfig.hooks),
    };

    await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  });
}

/**
 * Self-heal a case's Codeman-owned hooks block.
 *
 * `writeHooksConfig` only runs when a case is first CREATED. Cases created before the
 * X-Codeman-Hook-Secret header was added (COD-54, 2026-06-10) keep hook curls in their
 * settings.local.json that POST to /api/hook-event WITHOUT the secret — which, once the
 * gate requires it unconditionally (COD-91), silently 401 on a password-protected install.
 * Older Codeman blocks also lack the background Bash async-rewake hook. Refresh either
 * stale shape on launch so existing cases gain both current behaviors.
 *
 * Deliberately surgical: regenerates ONLY when settings.local.json already contains
 * Codeman's own hook curls (they target `/api/hook-event`) and they are stale. No-op
 * when the file/hooks are absent (we never impose hooks on a user who removed them) or
 * when the hooks aren't ours, so it is cheap enough to call on every Claude spawn.
 */
export async function refreshStaleCodemanHooks(casePath: string): Promise<void> {
  const settingsPath = join(casePath, '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) return;
  await withSettingsLock(settingsPath, async () => {
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      return; // malformed — leave it untouched (case-create owns the happy path)
    }
    const hooksJson = JSON.stringify(existing.hooks ?? null);
    const isOurs = hooksJson.includes('/api/hook-event');
    // The generated curl carries this header literal (see generateHooksConfig); its
    // absence on our own hooks means they predate COD-54 and need regenerating.
    const hasSecret = hooksJson.includes('X-Codeman-Hook-Secret');
    const hasBackgroundWake = hooksJson.includes(BACKGROUND_WAKE_MARKER);
    if (!isOurs || (hasSecret && hasBackgroundWake)) return;
    const generated = generateHooksConfig();
    const merged = {
      ...existing,
      hooks: mergeCodemanHooks(existing.hooks, generated.hooks),
    };
    await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  });
}

/** Unique marker identifying Codeman's own statusLine command (vs a user's). */
const STATUSLINE_MARKER = '/api/status-telemetry';

/**
 * The plan-usage statusLine exporter command. Mirrors the hook `curlCmd` pattern:
 * reads Claude Code's statusline stdin JSON, POSTs `{sessionId,data}` to Codeman,
 * and prints the response body (a compact "⟳ 5h 15% · 7d 34%" footer) back to
 * stdout so the in-terminal statusline stays useful. Env vars resolve at runtime
 * (present in every managed session via tmux setenv), so the config is static.
 */
export function generateStatusLineCommand(): string {
  // `curl -sk`: CODEMAN_API_URL is loopback HTTPS with a self-signed cert in the
  // production setup; without -k curl returns 000 and the statusline shows
  // nothing. -k is safe here (loopback only). Falls back to a brand string so the
  // footer is never blank if Codeman is unreachable.
  return (
    `INPUT=$(cat 2>/dev/null || echo '{}'); ` +
    `printf '{"sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$INPUT" | ` +
    `curl -sk -X POST "$CODEMAN_API_URL${STATUSLINE_MARKER}" ` +
    `-H 'Content-Type: application/json' ` +
    `-H "X-Codeman-Hook-Secret: $(cat "$CODEMAN_HOOK_SECRET_FILE" 2>/dev/null)" ` +
    `--data @- 2>/dev/null || echo codeman`
  );
}

/**
 * Add or remove Codeman's plan-usage statusLine exporter in
 * `.claude/settings.local.json`. Only ever touches a statusLine that is OURS
 * (command targets `/api/status-telemetry`), so a user's hand-authored
 * statusLine is never removed OR overwritten — on both the enable and disable
 * paths we bail out when an existing statusLine isn't ours. Callers gate on
 * Claude mode. Merges, preserving all other keys (hooks, env, model).
 */
export async function applyStatusLineConfig(casePath: string, enabled: boolean): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');

  await withSettingsLock(settingsPath, async () => {
    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
      } catch {
        return; // Malformed — don't rewrite it
      }
    }

    const current = existing.statusLine as { command?: unknown } | undefined;
    const isOurs = !!current && typeof current.command === 'string' && current.command.includes(STATUSLINE_MARKER);

    if (enabled) {
      const desired = generateStatusLineCommand();
      if (isOurs && current?.command === desired) return; // already current — skip rewrite
      if (current && !isOurs) return; // user has their OWN statusLine — never clobber it
      if (!existsSync(claudeDir)) await mkdir(claudeDir, { recursive: true });
      existing.statusLine = { type: 'command', command: desired }; // add, or update an out-of-date ours
    } else {
      if (!isOurs) return; // nothing of ours to remove (leave a user's own statusLine alone)
      delete existing.statusLine;
    }

    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  });
}
