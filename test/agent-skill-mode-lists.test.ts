/**
 * @fileoverview Static guard: the packaged agent skill's run-mode enumerations stay in
 * step with the modes the server actually accepts.
 *
 * `skills/codeman/**` is injected into cases and read by agents driving Codeman over
 * HTTP, so a mode missing from its lists is not cosmetic: the agent is told a backend
 * does not exist, or that a whole-class caveat ("these modes write no transcript")
 * covers four modes when it covers five. Adding pi (#206) left every one of those lists
 * stale while CI stayed green, because nothing tied the prose to the schema.
 *
 * Two rules, both derived from the RUNTIME source of truth (the Zod enum in schemas.ts,
 * not a copy):
 *
 *  1. The `mode ∈ a|b|c` enumeration in endpoints.md is the mode list, exactly, and the
 *     per-CLI availability probe (`GET /api/<mode>/status`) is documented for every
 *     agent mode. That second half is the narrow, family-scoped answer to "should the
 *     endpoint scanner also check registered-to-documented?". In general it should not:
 *     the skill documents 34 of 217 registered endpoints on purpose (it is an agent
 *     guide, not an API reference), so a blanket reverse check needs a 183-entry
 *     allowlist that fails CI on unrelated routes and gets appended to mechanically.
 *     Grouping by path shape does not rescue it either: the families that produces are
 *     things like `DELETE /api/<any>/:id`, which lumps cases, webviews and docker hosts
 *     together. A family the SCHEMA can enumerate is the exception, since it needs no
 *     allowlist at all.
 *  2. Any prose enumeration of 3+ distinct modes must be COMPLETE with respect to the
 *     external CLIs: those lists exist to describe what `isExternalCliMode()` gates
 *     (no Claude transcript, no hooks, no Claude-format parsers), so naming some but
 *     not all of them is the drift itself. Runs of one or two modes are exempt, since
 *     a legitimate pair ("claude or shell") is not a class claim. The exceptions are
 *     the REAL classes inside the external family, each one a capability some of those
 *     CLIs have and the rest do not:
 *
 *       - "writes no transcript" drops `codex` (a rollout Codeman reads back) and
 *         `deepseek` (a JSONL session file Codeman reads back);
 *       - "delivers no hook signals" drops `deepseek`, whose harness reports its own
 *         lifecycle -- that one is derived from `hooksAvailableForMode()` rather than
 *         restated, so the predicate and the prose cannot drift apart;
 *       - the positive twin of the first: the modes whose answers CAN be read.
 *
 *     Anything else partial is still the drift. A NEW backend belongs to none of these
 *     classes until someone says so, so every one of them grows by a mode and every
 *     stale list fails here -- which is the whole point.
 *
 * Port: N/A (pure static analysis).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CreateSessionSchema, QuickStartSchema, sessionModeIds } from '../src/web/schemas.js';
import { isExternalCliMode } from '../src/session.js';
import { hooksAvailableForMode } from '../src/web/session-wait-registry.js';
import type { SessionMode } from '../src/types/session.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SKILL_DIR = join(HERE, '../skills/codeman');
const SKILL_FILES = [
  'SKILL.md',
  'reference/endpoints.md',
  'reference/messaging.md',
  'reference/recipes.md',
  'reference/verbs.md',
];

/**
 * Modes the API actually accepts, read off the runtime source of truth rather than restated
 * here — the whole point of this file is to catch the skill docs drifting from what the API
 * takes, which a second hardcoded list could not do.
 *
 * `mode` used to be a `z.enum([...])` whose `.options` this unwrapped. It is now resolved at
 * parse time from the enabled CLI registry (so enabling a CLI does not need a restart), and
 * there is no frozen member list on the schema to read; `sessionModeIds()` is that list.
 */
function schemaModes(): SessionMode[] {
  return sessionModeIds() as SessionMode[];
}

const MODES = schemaModes();
const EXTERNAL_MODES = MODES.filter(isExternalCliMode);

/**
 * External modes whose ANSWERS Codeman can read: codex from its rollout,
 * deepseek from `$DSH_HOME/sessions/**`. Stated here rather than derived because
 * `last-response` branches per mode into a per-CLI reader and there is no single
 * predicate to import; the runtime facts are `readCodexLastResponse` and
 * `readDeepSeekLastResponse` in session-routes.ts.
 */
const TRANSCRIPT_EXTERNAL_MODES = new Set<string>(['codex', 'deepseek']);

/**
 * Mode tokens appearing back to back, separated only by list punctuation — `a|b|c`,
 * `a`/`b`/`c`, "`a`, `b` and `c`". Newlines collapse to spaces first so a wrapped list
 * still reads as one run. The separator budget is deliberately small: it must span
 * ", " and " and " without swallowing a sentence between two unrelated mentions.
 */
const MODE_ALTERNATION = MODES.map((m) => `\`?${m}\`?`).join('|');
const ENUMERATION_RUN = new RegExp(`(?:(?:${MODE_ALTERNATION})(?:[\\s,/|]|and\\b|or\\b){0,6}){3,}`, 'g');

function enumerationRuns(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ');
  return [...flat.matchAll(ENUMERATION_RUN)].map((m) => m[0]);
}

function modesIn(run: string): SessionMode[] {
  return MODES.filter((m) => new RegExp(`\\b${m}\\b`).test(run));
}

describe('agent skill run-mode lists', () => {
  it('derives the mode list from the registry, and both endpoints agree', () => {
    expect(MODES).toContain('pi');
    expect(EXTERNAL_MODES.length).toBeGreaterThan(1);
    // Guard against a parsing/registry regression silently making every scan below vacuous.
    expect(MODES.length).toBeGreaterThanOrEqual(9);

    // Both endpoints now share one mode validator, so comparing member lists would compare
    // a thing with itself. Parse through each schema instead: that survives the two
    // drifting apart later, which is what this assertion is actually for.
    for (const mode of MODES) {
      expect(CreateSessionSchema.safeParse({ workingDir: '/tmp', mode }).success).toBe(true);
      expect(QuickStartSchema.safeParse({ caseName: 'demo', mode }).success).toBe(true);
    }
    expect(CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'not-a-cli' }).success).toBe(false);
    expect(QuickStartSchema.safeParse({ caseName: 'demo', mode: 'not-a-cli' }).success).toBe(false);
  });

  it('documents the CLI availability probe for every agent mode', () => {
    // The gap this closes: /api/pi/status shipped undocumented and only a human reading
    // the doc noticed, because the sibling scanner (agent-skill-endpoints-doc.test.ts)
    // only checks documented -> registered. Derived from the schema, so a seventh
    // backend fails here until its probe is documented; the sibling test still proves
    // the reverse, that nothing documented here is a 404.
    const doc = readFileSync(join(SKILL_DIR, 'reference/endpoints.md'), 'utf-8');
    const documented = new Set([...doc.matchAll(/\bGET\s+\/api(?:\/v1)?\/([a-z-]+)\/status\b/g)].map((m) => m[1]));
    const probeable = MODES.filter((m) => m !== 'shell'); // shell has no CLI to probe
    expect([...probeable].filter((m) => !documented.has(m))).toEqual([]);
  });

  it("documents exactly the accepted modes in endpoints.md's `mode ∈ …` enumeration", () => {
    const doc = readFileSync(join(SKILL_DIR, 'reference/endpoints.md'), 'utf-8');
    const match = doc.match(/`mode` ∈ `([a-z|]+)`/);
    expect(match, 'endpoints.md no longer states the accepted `mode` values').not.toBeNull();
    expect(new Set(match![1].split('|'))).toEqual(new Set(MODES));
  });

  it('never enumerates a partial set of external CLI modes', () => {
    const complete = new Set<string>(EXTERNAL_MODES);
    // The real classes inside the family (see the fileoverview). Each is derived, so
    // an eighth backend joins none of them and every list naming the other seven fails.
    const noTranscript = new Set<string>(EXTERNAL_MODES.filter((m) => !TRANSCRIPT_EXTERNAL_MODES.has(m)));
    const withTranscript = new Set<string>(EXTERNAL_MODES.filter((m) => TRANSCRIPT_EXTERNAL_MODES.has(m)));
    const noHookSignals = new Set<string>(EXTERNAL_MODES.filter((m) => !hooksAvailableForMode(m)));
    const allowed = [complete, noTranscript, withTranscript, noHookSignals];
    const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));

    const offenders: string[] = [];
    for (const file of SKILL_FILES) {
      for (const run of enumerationRuns(readFileSync(join(SKILL_DIR, file), 'utf-8'))) {
        const listed = modesIn(run);
        if (listed.length < 3) continue;
        const externals = new Set<string>(listed.filter(isExternalCliMode));
        // Empty is fine (a claude/shell-only list); partial is the drift.
        if (externals.size === 0 || allowed.some((set) => sameSet(externals, set))) continue;
        const missing = EXTERNAL_MODES.filter((m) => !externals.has(m));
        offenders.push(`${file}: "${run.trim()}" is missing ${missing.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
