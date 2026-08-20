/**
 * @fileoverview Named code profiles that a `CliEntry.capabilities` field may select BY NAME.
 *
 * This is the escape hatch for behaviour that is genuinely code-shaped and cannot be
 * expressed as data — codex's predictive write-through echo, claude's transcript parsing —
 * without letting any of that code branch on a CLI's id. A capability field names a profile;
 * the profile itself lives here, and later phases plug the real implementations
 * (`CODEX_COMPOSER_ROW_RE`, the claude JSONL reader, the codex rollout reader) in as the
 * corresponding module is migrated.
 *
 * The rule this enforces: `test/cli-registry-no-id-branching.test.ts` fails on any
 * `mode === '<stock id>'` comparison outside `stock.ts`, so a NEW behavioural special case
 * must be added here, named, and referenced from a capability field — never inlined as an id
 * check at the call site.
 *
 * @module config/cli-registry/profiles
 */

/**
 * Predictive local-echo profiles, selected via `capabilities.echo.predictProfile`.
 * A name with no entry here (or `echo.policy !== 'predict'`) degrades to the 'buffer'
 * policy — never to a crash — which is why `predictProfile` is optional in the schema.
 */
export const PREDICT_PROFILES: Record<string, true> = {
  // Phase 5 wires this to the real codex predictive-echo addon
  // (packages/xterm-zerolag-input/src/predictive-echo-addon.ts) and CODEX_COMPOSER_ROW_RE.
  codex: true,
};

/**
 * Transcript readers, selected via `capabilities.transcript`. Unlike the other profile
 * registries this one is closed over the schema enum itself (`'claude-jsonl' |
 * 'codex-rollout' | 'none'`) rather than an open string, since transcript format is a small,
 * genuinely fixed set — see CliCapabilities['transcript'] in types.ts.
 */
export const TRANSCRIPT_READER_NAMES = ['claude-jsonl', 'codex-rollout', 'none'] as const;

/** Composer-row finders, selected via `capabilities.echo.anchor.kind`. Also schema-closed. */
export const COMPOSER_ANCHOR_KINDS = ['glyph', 'cursor', 'none'] as const;

/** True when `name` is a profile this build actually implements. */
export function isKnownPredictProfile(name: string | undefined): boolean {
  return name !== undefined && Object.prototype.hasOwnProperty.call(PREDICT_PROFILES, name);
}
