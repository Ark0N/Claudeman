/**
 * @fileoverview Bridges the legacy per-mode spawn options (`buildSpawnCommand`'s option bag
 * in tmux-manager.ts, unchanged on the wire since before this registry existed) onto the CLI
 * registry's generic argv engine (`renderLaunch`).
 *
 * This is the one place allowed to know the shape of the five legacy `<Mode>Config` objects
 * and claude's discrete top-level fields — a genuine API-compatibility concern (the public
 * `POST /api/sessions` / `/api/quick-start` request shape is unchanged, see
 * `docs/versioning-policy.md`), not a reintroduction of per-CLI command-building logic. The
 * actual TRANSLATION from a legacy field name to a registry param name is DATA
 * (`CliLaunch.legacyConfigAliases`, declared once per entry in `config/cli-registry/stock.ts`),
 * so this file stays a generic reader of that data rather than a per-mode `if` chain.
 *
 * @module session-cli-registry-bridge
 */

import type { CliEntry } from './config/cli-registry/types.js';
import { renderLaunch, type EngineValues, type ParamValues } from './config/cli-registry/argv.js';
import { buildEffortCliArgs, sanitizeCliSessionName } from './session-cli-builder.js';
import { compareVersions } from './utils/dependency-checker.js';
import { getClaudeCliVersion } from './utils/claude-cli-resolver.js';
import type {
  AntigravityConfig,
  ClaudeMode,
  CodexConfig,
  EffortLevel,
  GeminiConfig,
  OpenCodeConfig,
  PiConfig,
} from './types/session.js';

export interface SpawnBridgeOptions {
  mode: string;
  sessionId: string;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  piConfig?: PiConfig;
  resumeSessionId?: string;
  effort?: EffortLevel;
  sessionName?: string;
  claudeCliVersion?: string | null;
}

/**
 * The legacy "raw config" object for each mode, as it already exists on `SpawnBridgeOptions`.
 * Claude has no config object of its own (its fields were always discrete top-level options,
 * predating every other mode's `<Mode>Config` shape), so it is synthesized here from those
 * discrete fields — the one place this bridge treats claude specially, and only to reproduce
 * a pre-existing API shape difference, not to build its command.
 */
function legacyConfigFor(options: SpawnBridgeOptions): Record<string, unknown> | undefined {
  switch (options.mode) {
    case 'claude':
      return {
        claudeMode: options.claudeMode,
        allowedTools: options.allowedTools,
        model: options.model,
        resumeSessionId: options.resumeSessionId,
      };
    case 'opencode':
      return options.openCodeConfig as unknown as Record<string, unknown> | undefined;
    case 'codex':
      return options.codexConfig as unknown as Record<string, unknown> | undefined;
    case 'gemini':
      return options.geminiConfig as unknown as Record<string, unknown> | undefined;
    case 'antigravity':
      return options.antigravityConfig as unknown as Record<string, unknown> | undefined;
    case 'pi':
      return options.piConfig as unknown as Record<string, unknown> | undefined;
    default:
      return undefined;
  }
}

/**
 * Build `ParamValues` for every declared `token`/`bool`/`enum` param by reading it out of the
 * legacy config object through `legacyConfigAliases` (falling back to the param's own name).
 * `engine`-sourced params are skipped — those come from `EngineValues`, never legacy config.
 */
function buildParamsFromLegacyConfig(entry: CliEntry, rawConfig: Record<string, unknown> | undefined): ParamValues {
  const params: ParamValues = {};
  if (!rawConfig) return params;
  const aliases = entry.launch.legacyConfigAliases ?? {};
  for (const [paramName, spec] of Object.entries(entry.launch.params)) {
    if (spec.type === 'engine') continue;
    const legacyKey = aliases[paramName] ?? paramName;
    const value = rawConfig[legacyKey];
    if (value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'boolean') {
      params[paramName] = value;
    }
  }
  return params;
}

/**
 * Which `capabilities.gates` are currently satisfied. `resolveVersion` is called AT MOST
 * ONCE, and only when the entry actually declares a gate — a `claude --version` (or any
 * other CLI's) subprocess probe has no reason to run for an entry with none.
 */
function resolveGatesPassed(entry: CliEntry, resolveVersion: () => string | null): Set<string> {
  const passed = new Set<string>();
  const gateEntries = Object.entries(entry.capabilities.gates);
  if (gateEntries.length === 0) return passed;
  const cliVersion = resolveVersion();
  if (!cliVersion) return passed; // fail-closed: unknown version satisfies no gate
  for (const [name, gate] of gateEntries) {
    if (compareVersions(cliVersion, gate.minVersion) >= 0) passed.add(name);
  }
  return passed;
}

/**
 * Render the spawn command for `entry` from the legacy option bag. Returns `undefined` for a
 * `shell`-kind entry (or any entry declaring no launch variants), which callers take as "fall
 * back to the local login-shell resolution" — shell has no CLI to template.
 */
export function buildSpawnCommandFromRegistry(entry: CliEntry, options: SpawnBridgeOptions): string | undefined {
  if (entry.kind === 'shell' || entry.launch.variants.length === 0) return undefined;

  const params = buildParamsFromLegacyConfig(entry, legacyConfigFor(options));

  const engineValues: EngineValues = {
    sessionId: options.sessionId,
    // Allowlist-sanitized (Unicode letters/digits + ` . _ : -`, 64 chars), matching
    // buildNameCliArgs exactly — sanitizeCliSessionName is the injection guard for this
    // value, not the `quote: 'double'` escaping on the --name arg (which only makes an
    // UNSAFE value inert, it does not launder one into something meaningful).
    sessionName: sanitizeCliSessionName(options.sessionName),
  };
  // Mirrors buildEffortCliArgs exactly: ultracode carries a fixed settings blob, every other
  // level rides a plain `--effort <level>` flag. Reusing the canonical builder here (rather
  // than re-deriving the ultracode special-case) keeps the EFFORT_LEVELS allowlist and the
  // settings-JSON shape single-sourced in session-cli-builder.ts.
  const [effortFlag, effortValue] = buildEffortCliArgs(options.effort);
  if (effortFlag === '--settings') engineValues.effortSettingsJson = effortValue;
  else if (effortFlag === '--effort') engineValues.effortLevel = effortValue;

  // Preserves buildSpawnCommand's original fallback exactly: an EXPLICIT `undefined` probes
  // the local claude CLI (getClaudeCliVersion, null under vitest); an explicit `null` means
  // "known to be unresolvable" and must not probe. Only claude declares a version gate today
  // — the probe itself only ever runs from resolveGatesPassed, and only when an entry
  // actually has a gate, so this stays generic without spawning a stray `claude --version`
  // for every other CLI's launch.
  const gatesPassed = resolveGatesPassed(entry, () =>
    options.claudeCliVersion !== undefined ? options.claudeCliVersion : getClaudeCliVersion()
  );

  return renderLaunch(entry.launch, params, engineValues, gatesPassed);
}
