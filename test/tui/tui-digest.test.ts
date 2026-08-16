/**
 * @fileoverview Unit tests for the away digest's compact rendering.
 *
 * The digest is read top-down and never studied, so the promises worth pinning
 * are: the counts sit in the first line, every entry is exactly one line, and a
 * long section is capped with a tail rather than pushing the next section off
 * the overlay.
 */
import { describe, it, expect } from 'vitest';
import { formatAwayDigest } from '../../src/tui/tui-digest.js';
import type { AwayDigestItem, AwayDigestResponse } from '../../src/web/away-digest.js';

const NOW = 1_700_000_000_000;

function entry(overrides: Partial<AwayDigestItem> = {}): AwayDigestItem {
  return {
    id: 'e1',
    timestamp: NOW - 120_000,
    category: 'needs_attention',
    severity: 'warning',
    title: 'permission prompt',
    source: 'lifecycle',
    sessionName: 'w4-api',
    ...overrides,
  };
}

function digest(overrides: Partial<AwayDigestResponse> = {}): AwayDigestResponse {
  return {
    range: { range: '24h', since: NOW - 86_400_000, until: NOW },
    generatedAt: NOW,
    dataFreshness: {
      lifecyclePersisted: true,
      tokenStatsPersisted: true,
      runSummariesLiveOnly: true,
      subagentsLiveOnly: true,
    },
    totals: {
      sessionsCreated: 3,
      sessionsExited: 1,
      activeSessions: 2,
      needsAttention: 1,
      completed: 1,
      errors: 0,
      warnings: 1,
      tokenWindowPrecision: 'day',
    },
    sections: { needsAttention: [], completed: [], stillRunning: [], idle: [], informational: [] },
    ...overrides,
  };
}

describe('formatAwayDigest', () => {
  it('opens with the range and the counts', () => {
    const lines = formatAwayDigest(digest(), { now: NOW });
    expect(lines[0]).toBe('the last 24 hours · 3 started · 1 exited · 2 running');
  });

  it('names the range the way the API labels it', () => {
    const since = digest({ range: { range: 'since-last-visit', since: NOW - 1000, until: NOW } });
    expect(formatAwayDigest(since, { now: NOW })[0]).toContain('since your last visit');
  });

  it('gives every entry one line, with its age and session', () => {
    const lines = formatAwayDigest(
      digest({
        sections: {
          needsAttention: [entry({ detail: 'Bash(git push)' })],
          completed: [],
          stillRunning: [],
          idle: [],
          informational: [],
        },
      }),
      { now: NOW }
    );
    expect(lines).toContain('NEEDS ATTENTION (1)');
    expect(lines).toContain('  2m   w4-api  permission prompt — Bash(git push)');
  });

  it('caps a long section instead of burying the next one', () => {
    const many = Array.from({ length: 9 }, (_, i) => entry({ id: `e${i}`, title: `event ${i}` }));
    const lines = formatAwayDigest(
      digest({
        sections: {
          needsAttention: many,
          completed: [entry({ id: 'c1', category: 'completed', title: 'finished' })],
          stillRunning: [],
          idle: [],
          informational: [],
        },
      }),
      { now: NOW, sectionLimit: 3 }
    );
    expect(lines).toContain('NEEDS ATTENTION (9)');
    expect(lines).toContain('  … 6 more');
    expect(lines).toContain('COMPLETED (1)');
  });

  it('says so when nothing happened', () => {
    expect(formatAwayDigest(digest(), { now: NOW })).toContain('nothing happened while you were away');
  });

  it('adds the token totals only when the range had any', () => {
    expect(formatAwayDigest(digest(), { now: NOW }).join('\n')).not.toContain('tokens:');
    const withTokens = digest({
      totals: { ...digest().totals, inputTokens: 45_200, outputTokens: 12_100, estimatedCost: 1.234 },
    });
    expect(formatAwayDigest(withTokens, { now: NOW })).toContain('tokens: 45.2k in · 12.1k out · $1.23');
  });

  it('drops the age column for an entry with no usable timestamp', () => {
    const lines = formatAwayDigest(
      digest({
        sections: {
          needsAttention: [entry({ timestamp: 0, sessionName: undefined, sessionId: 'abcdef1234' })],
          completed: [],
          stillRunning: [],
          idle: [],
          informational: [],
        },
      }),
      { now: NOW }
    );
    expect(lines).toContain('       abcdef12  permission prompt');
  });
});
