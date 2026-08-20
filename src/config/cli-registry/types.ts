/**
 * @fileoverview Type definitions for the CLI registry — the single source of truth for
 * which agent CLIs Codeman supports and how each one is discovered, launched and treated.
 *
 * This replaces the hard-coded `SessionMode` union and the ~123 per-mode branches that grew
 * out of it. The guiding rule: NO code may branch on a CLI's id. Behaviour that genuinely
 * differs between CLIs is expressed either as data here, or as a named PROFILE selected by
 * a capability field (see profiles.ts) — never as `mode === 'codex'`.
 *
 * @module config/cli-registry/types
 */

import type { TokenPattern } from './patterns.js';

/**
 * A CLI identifier. Branded so an arbitrary string cannot be passed where a validated id is
 * expected; construct with `asCliId()` at the API boundary.
 */
export type CliId = string & { readonly __cliId: unique symbol };

// ---------------------------------------------------------------------------
// Launch argv DSL
// ---------------------------------------------------------------------------

/** Values the ENGINE supplies. Config may reference these by name but never author them. */
export type EngineValue =
  | 'sessionId'
  | 'sessionName'
  | 'muxName'
  | 'effortLevel'
  | 'effortSettingsJson'
  /** `sessionId` prefixed `codeman_<id>` — codex's unique per-pane rollout originator. */
  | 'codemanPrefixedSessionId';

/**
 * A declared launch parameter. `token` params carry caller-supplied data and are therefore
 * the only ones that need a pattern; `engine` params are produced in code.
 */
export type ParamSpec =
  | { type: 'enum'; values: string[]; default?: string }
  | { type: 'bool' }
  | { type: 'token'; pattern: TokenPattern }
  | { type: 'engine'; source: EngineValue };

/** A boolean guard over parameter state. */
export type Cond =
  | { param: string; is: string | boolean }
  | { param: string; state: 'set' | 'unset' }
  | { allOf: Cond[] }
  | { anyOf: Cond[] }
  | { not: Cond }
  /** Names an entry in `capabilities.gates`. Fail-closed gates omit when version is unknown. */
  | { capabilityGate: string };

/**
 * How a token is quoted when emitted into the bash command string.
 *
 * This exists ONLY to preserve byte-identical output with the hand-written builders being
 * replaced (claude wraps its values in double quotes; the other builders emit bare words).
 * It is never a safety lever: `renderToken()` verifies the value is metacharacter-free
 * before honouring an explicit style, and falls back to single-quote escaping if it is not.
 * So the worst a wrong `quote` can do is make output uglier, never unsafe.
 */
export type QuoteStyle = 'auto' | 'bare' | 'double' | 'single';

/** One argv element. */
export type ArgSpec =
  /** A bare literal word, e.g. the base binary or codex's `resume` subcommand. */
  | { lit: string; when?: Cond }
  /** A valueless flag, e.g. `--no-approve`. */
  | { flag: string; when?: Cond }
  /** A flag with a fixed literal value. */
  | { flag: string; value: string; quote?: QuoteStyle; when?: Cond }
  /** A flag whose value comes from a declared param. */
  | { flag: string; valueFrom: string; quote?: QuoteStyle; when?: Cond }
  /** A bare positional value from a param, e.g. codex's `resume <id>`. */
  | { valueFrom: string; quote?: QuoteStyle; when?: Cond };

/** One alternative command form. */
export interface CliVariant {
  /** Stable name for diagnostics and tests, e.g. 'resume' / 'new'. */
  id: string;
  when?: Cond;
  args: ArgSpec[];
}

export interface CliLaunch {
  params: Record<string, ParamSpec>;
  /**
   * 'first'    — emit the first variant whose `when` passes (the usual case).
   * 'fallback' — emit EVERY passing variant joined by the engine's own ` || `, which is how
   *              claude's `--resume X || --session-id Y` shell fallback is expressed without
   *              config ever containing shell text. The engine owns the operator.
   */
  chain?: 'first' | 'fallback';
  variants: CliVariant[];
  /**
   * Maps a declared param name to the field name it arrives under on the legacy
   * `POST /api/sessions` wire shape (`OpenCodeConfig.continueSession`, etc — the per-mode
   * config objects predate this registry and stay on the wire for compatibility). A param
   * with no entry here is looked up under its own name. This is what lets the spawn-command
   * bridge (`session-cli-registry-bridge.ts`) stay generic: it reads the raw legacy config
   * object through this DATA-declared alias table instead of a per-mode `if (mode === ...)`.
   */
  legacyConfigAliases?: Record<string, string>;
  /**
   * How to APPEND a resume id onto an already-built base command, for the docker in-container
   * "tmux was re-created, resume the surviving transcript" path (`appendResumeFlag` in
   * tmux-manager.ts) — a narrower, append-only sibling of the full `variants` shape above,
   * which builds a whole command from scratch. Absent = this CLI has no resume flag to
   * append (shell, opencode: opencode's docker resume goes through its own config object).
   */
  resumeAppend?: { style: 'flag'; flag: string } | { style: 'positional'; token: string };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface CliVersionProbe {
  arg: string;
  /** Serialized regex, applied to `--version` output only. See compileVersionRegex(). */
  regex?: string;
  /**
   * Treat a binary whose version output does not match as ABSENT rather than as
   * present-with-unknown-version. For CLIs with short, generic binary names (`pi`), where a
   * `which` hit is not by itself evidence the right program is installed.
   */
  requireVersionMatch?: boolean;
  /** Retry a failed probe with backoff instead of caching the failure (claude's behaviour). */
  retryOnTransientFailure?: boolean;
}

export interface CliDiscovery {
  /**
   * Binary name(s), first hit wins.
   *
   * This is why the registry fixes a live bug: the mode name is NOT always the binary
   * name (`antigravity` runs `agy`), and `probeDockerCliVersion` assumed it was.
   */
  binaries: string[];
  /** Extra directories probed after `which`. A leading `~` expands to homedir; nothing else. */
  searchDirs: string[];
  version?: CliVersionProbe;
  install: {
    /** Shown verbatim in "CLI not found. Install with: ...". NEVER executed by the server. */
    command: Partial<Record<'linux' | 'darwin' | 'wsl' | 'win32', string>>;
    /** Feeds generation of docker/agent.Dockerfile. */
    npmPackage?: string;
    docsUrl?: string;
  };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface CliEnv {
  /** `export K=V` in the bash prelude. Values are literals or engine values, never secrets. */
  exports: Array<{ name: string; value: string | { engine: EngineValue }; when?: Cond }>;
  /** `unset K` — e.g. claude's CLAUDECODE, the truecolor CLIs' NO_COLOR. */
  unset: string[];
  /**
   * NAMES ONLY. Values are read from the server's own process.env and pushed via
   * `tmux setenv`, so a secret is structurally unable to reach the command line.
   */
  tmuxSetenvKeys: string[];
  /** NAMES ONLY, forwarded as `docker exec -e NAME`. */
  dockerExecEnvNames: string[];
  /** This entry's contribution to the env-override allowlist. Never widens BLOCKED_ENV_KEYS. */
  allowedPrefixes: string[];
  allowedKeys: string[];
  /**
   * Env var carrying a JSON config blob pushed via `tmux setenv` (opencode's
   * OPENCODE_CONFIG_CONTENT). Generic so it is not an opencode special case.
   */
  configContentVar?: string;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * The closed set of behavioural switches. Each field replaces an id-check somewhere.
 *
 * `hooks`, `transcript` and `altScreen` are INDEPENDENT on purpose. The three predicates
 * they back (`hooksAvailableForMode`, `isExternalCliMode`, `isAltScreenStripMode`) describe
 * three different, deliberately unequal sets, and deriving any one from another has already
 * caused a real bug — a `shell` session has no hooks but is not an "external CLI", so
 * `!isExternalCliMode()` wrongly accepted `until=stop` on it and hung for the full timeout.
 * Keeping them as separate fields makes that invariant structural rather than commented.
 */
export interface CliCapabilities {
  /**
   * Non-Claude run mode that uses its own TUI and output format (`isExternalCliMode`):
   * no Claude transcript, no hooks, no Claude-format token/BashTool parsing. An explicit
   * field rather than derived from `hooks`/`kind`, precisely because it must stay
   * independent — see this interface's own doc comment.
   */
  external: boolean;
  /** No direct-PTY fallback: the CLI must run inside tmux (secrets ride tmux setenv). */
  requiresMux: boolean;
  /** Emits Codeman hook events, so `stop`/`blocked` wait signals can ever fire. */
  hooks: boolean;
  /** Which transcript reader, if any, understands this CLI's on-disk history. */
  transcript: 'claude-jsonl' | 'codex-rollout' | 'none';
  /**
   * 'strip-full'     — alt-screen + erase-scrollback + mouse DECSETs stripped (Ink TUIs).
   * 'strip-mux-only' — only tmux's own attach-time smcup (the safe default).
   * 'preserve'       — leave everything (a direct-PTY shell running vim/less/htop).
   */
  altScreen: 'strip-full' | 'strip-mux-only' | 'preserve';
  echo: {
    policy: 'buffer' | 'predict' | 'off';
    /** How the local-echo overlay locates the composer row. */
    anchor: { kind: 'glyph'; glyph: string; offset: number } | { kind: 'cursor' } | { kind: 'none' };
    /** Names a PREDICT_PROFILES key. Unknown or absent degrades to 'buffer', never to broken. */
    predictProfile?: string;
  };
  /** Forwarding the wheel to the CLI's own transcript. 'never' keeps local scrollback. */
  wheelForward: { mode: 'never' | 'version-gated'; minVersion?: string };
  keyboardAccessory: 'agent' | 'shell';
  /** Multi-user: this CLI is a raw shell, so its commands need the privileged gate. */
  privilegedCommandGate: boolean;
  startMode: 'interactive' | 'shell';
  stripInkBloat: boolean;
  ralph: boolean;
  respawn: boolean;
  effort: boolean;
  agentSkillInjection: boolean;
  statusLineTelemetry: boolean;
  /** Where a model override is delivered. Claude uniquely writes settings.local.json. */
  model: { source: 'flag' | 'claude-settings-file' | 'none'; param?: string };
  /**
   * Params a non-granted multi-user owner may not set freely, and what they are forced to.
   * Data-driven so a CUSTOM CLI's bypass flag is clampable exactly like codex's.
   */
  privilegedParams: Array<{ param: string; clampTo: boolean | string }>;
  /** Version gates referenced by `capabilityGate` conditions. */
  gates: Record<string, { minVersion: string; failClosed: boolean }>;
  /** Cap on a single terminal frame, when this CLI needs a tighter one than the default. */
  maxFrameBytes?: number;
}

// ---------------------------------------------------------------------------
// Location overlays (remote SSH / docker)
// ---------------------------------------------------------------------------

/** Docker credential seeding policy — which host dirs are copied or shared into a container. */
export interface CliCredStore {
  rel: string;
  shareDirs?: string[];
  shareFiles?: string[];
  seedFiles?: string[];
  seedWhole?: boolean;
}

export interface CliOverlays {
  /**
   * The remote/docker DEFAULT pane command: just the CLI invocation (e.g. `claude
   * --dangerously-skip-permissions`), independent of each location's own wrapping
   * (remote: login-shell `-c`; docker: `exec`). Absent `command` = the bare
   * `discovery.binaries[0]`. `disabled: true` = this location has no story for this CLI at
   * all (docker for `shell`) — distinct from "no override", which still gets a default.
   */
  remote?: { command?: string } | { disabled: true };
  docker?: { command?: string } | { disabled: true };
  credStore?: CliCredStore;
}

// ---------------------------------------------------------------------------
// The entry
// ---------------------------------------------------------------------------

export interface CliEntry {
  id: CliId;
  label: string;
  /** Two-ish character tab badge, e.g. 'OC'. */
  shortBadge: string;
  /** Single hex colour. CSS derives every per-CLI gradient from it via --cli-accent. */
  accent: string;
  enabled: boolean;
  /** Set by the loader from the shipped catalog; a user entry can never claim it. */
  stock: boolean;
  order: number;
  /** 'shell' unlocks the raw-shell code paths; everything else is an agent CLI. */
  kind: 'agent' | 'shell';
  discovery: CliDiscovery;
  launch: CliLaunch;
  env: CliEnv;
  capabilities: CliCapabilities;
  overlays: CliOverlays;
}

/** The on-disk shape of ~/.codeman/clis.json — overrides and custom entries only. */
export interface CliRegistryFile {
  schemaVersion: number;
  /**
   * Stock ids already introduced to this install. The ratchet that lets one file both gain
   * newly-shipped CLIs on upgrade AND remember that the user disabled one.
   */
  seededStockIds: string[];
  /** Keyed by id: a partial override of a stock entry, or a complete custom entry. */
  clis: Record<string, unknown>;
}
