/**
 * @fileoverview Barrel for the CLI registry module.
 * @module config/cli-registry
 */

export type {
  ArgSpec,
  CliCapabilities,
  CliCredStore,
  CliDiscovery,
  CliEntry,
  CliEnv,
  CliId,
  CliIdentityProbe,
  CliLaunch,
  CliOverlays,
  CliRegistryFile,
  CliVariant,
  CliVersionProbe,
  Cond,
  EngineValue,
  ParamSpec,
  QuoteStyle,
} from './types.js';
export {
  matchesPattern,
  TOKEN_PATTERNS,
  SAFE_BARE_TOKEN,
  compileVersionRegex,
  MAX_VERSION_OUTPUT,
} from './patterns.js';
export type { TokenPattern } from './patterns.js';
export { renderLaunch, renderCliCommand } from './argv.js';
export type { EngineValues, ParamValues } from './argv.js';
export { CliEntrySchema } from './schema.js';
export type { ValidatedCliEntry } from './schema.js';
export { STOCK_CLIS } from './stock.js';
export {
  asCliId,
  cliIds,
  enabledCliIds,
  enabledClis,
  getCli,
  listClis,
  loadCliRegistry,
  reloadCliRegistry,
  resolveInstallCommandForPlatform,
  resolveRegistry,
} from './registry.js';
export type { LoadResult } from './registry.js';
export {
  COMPOSER_ANCHOR_KINDS,
  isKnownLauncherProfile,
  isKnownPredictProfile,
  isKnownSetenvProfile,
  LAUNCHER_PROFILE_NAMES,
  PREDICT_PROFILES,
  SETENV_PROFILE_NAMES,
  TRANSCRIPT_READER_NAMES,
} from './profiles.js';
export type { LauncherProfileName, SetenvProfileName } from './profiles.js';
