/**
 * @fileoverview Pure formatting of `GET /api/away-digest` into the lines the
 * `g` overlay scrolls.
 *
 * The digest answers "what happened while I was away", so it is read top-down
 * and never studied: every entry is one line (age, session, what happened), a
 * long section is capped with a "… n more" tail rather than allowed to push the
 * next section off screen, and the counts that matter live in the first line
 * where they are visible without scrolling at all.
 *
 * PURE: no IO, no clock of its own (the caller passes `now`), no `process.*`.
 *
 * @module tui/tui-digest
 */

import { formatElapsed, formatTokens } from './tui-render.js';
import type { AwayDigestItem, AwayDigestResponse, AwayDigestSectionName } from '../web/away-digest.js';

/** Entries per section before the tail takes over. */
export const DIGEST_SECTION_LIMIT = 6;

const SECTION_ORDER: ReadonlyArray<readonly [AwayDigestSectionName, string]> = [
  ['needsAttention', 'NEEDS ATTENTION'],
  ['completed', 'COMPLETED'],
  ['stillRunning', 'STILL RUNNING'],
  ['idle', 'IDLE'],
  ['informational', 'INFO'],
];

const RANGE_WORDS: Record<string, string> = {
  'since-last-visit': 'since your last visit',
  '1h': 'the last hour',
  today: 'today',
  '24h': 'the last 24 hours',
  custom: 'the selected window',
};

export interface TuiDigestOptions {
  now: number;
  sectionLimit?: number;
}

function ageColumn(item: AwayDigestItem, now: number): string {
  const age = item.timestamp > 0 ? formatElapsed(now - item.timestamp) : '';
  return age.padEnd(4);
}

function itemLine(item: AwayDigestItem, now: number): string {
  const who = item.sessionName ?? item.sessionId?.slice(0, 8) ?? '';
  const what = [item.title, item.detail].filter((part) => part && part.trim() !== '').join(' · ');
  return `  ${ageColumn(item, now)} ${[who, what].filter((part) => part !== '').join('  ')}`.replace(/\s+$/, '');
}

/**
 * The digest as display lines. The first line is the summary, then one block
 * per non-empty section, then the token totals when the range had any.
 */
export function formatAwayDigest(digest: AwayDigestResponse, options: TuiDigestOptions): string[] {
  const limit = Math.max(1, Math.trunc(options.sectionLimit ?? DIGEST_SECTION_LIMIT));
  const { totals } = digest;
  const lines: string[] = [
    [
      RANGE_WORDS[digest.range.range] ?? 'recently',
      `${totals.sessionsCreated} started`,
      `${totals.sessionsExited} exited`,
      `${totals.activeSessions} running`,
    ].join(' · '),
  ];

  let entries = 0;
  for (const [key, label] of SECTION_ORDER) {
    const items = digest.sections[key] ?? [];
    if (items.length === 0) continue;
    entries += items.length;
    lines.push('', `${label} (${items.length})`);
    for (const item of items.slice(0, limit)) lines.push(itemLine(item, options.now));
    if (items.length > limit) lines.push(`  … ${items.length - limit} more`);
  }

  if (entries === 0) lines.push('', 'nothing happened while you were away');

  const tokens = [
    formatTokens(totals.inputTokens ?? 0) ? `${formatTokens(totals.inputTokens ?? 0)} in` : '',
    formatTokens(totals.outputTokens ?? 0) ? `${formatTokens(totals.outputTokens ?? 0)} out` : '',
    typeof totals.estimatedCost === 'number' && totals.estimatedCost > 0 ? `$${totals.estimatedCost.toFixed(2)}` : '',
  ].filter((part) => part !== '');
  if (tokens.length > 0) lines.push('', `tokens: ${tokens.join(' · ')}`);

  return lines;
}
