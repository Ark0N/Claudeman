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
 *     a legitimate pair ("claude or shell") is not a class claim. ONE exception is
 *     allowed and it is a real one: the "writes no transcript" lists drop `codex`,
 *     which does write a rollout Codeman reads back (the pane carries a unique
 *     originator precisely so `last-response` can find it), so external-minus-codex
 *     is a meaningful class rather than an oversight.
 *
 * Port: N/A (pure static analysis).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { isExternalCliMode } from '../src/session.js';
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

/** Modes the API actually accepts, read off the schema rather than restated here. */
function schemaModes(schema: typeof CreateSessionSchema | typeof QuickStartSchema): SessionMode[] {
  // `mode` is `z.enum([...]).optional()`; unwrap the optional to reach `.options`.
  return (schema as unknown as { shape: { mode: { unwrap(): { options: SessionMode[] } } } }).shape.mode.unwrap()
    .options;
}

const MODES = schemaModes(CreateSessionSchema);
const EXTERNAL_MODES = MODES.filter(isExternalCliMode);

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
  it('derives the mode list from the schema, and both endpoints agree', () => {
    expect(MODES).toContain('pi');
    expect(new Set(schemaModes(QuickStartSchema))).toEqual(new Set(MODES));
    expect(EXTERNAL_MODES.length).toBeGreaterThan(1);
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
    /** The documented exception: codex writes a rollout, so it is absent from the
     *  "no transcript" lists on purpose. Every OTHER external mode must still be there. */
    const withoutCodex = new Set<string>(EXTERNAL_MODES.filter((m) => m !== 'codex'));
    const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));

    const offenders: string[] = [];
    for (const file of SKILL_FILES) {
      for (const run of enumerationRuns(readFileSync(join(SKILL_DIR, file), 'utf-8'))) {
        const listed = modesIn(run);
        if (listed.length < 3) continue;
        const externals = new Set<string>(listed.filter(isExternalCliMode));
        // Empty is fine (a claude/shell-only list); partial is the drift.
        if (externals.size === 0 || sameSet(externals, complete) || sameSet(externals, withoutCodex)) continue;
        const missing = EXTERNAL_MODES.filter((m) => !externals.has(m));
        offenders.push(`${file}: "${run.trim()}" is missing ${missing.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
