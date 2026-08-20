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
  enabledClis,
  getCli,
  listClis,
  loadCliRegistry,
  reloadCliRegistry,
  resolveRegistry,
} from './registry.js';
export { PREDICT_PROFILES, isKnownPredictProfile, TRANSCRIPT_READER_NAMES, COMPOSER_ANCHOR_KINDS } from './profiles.js';
