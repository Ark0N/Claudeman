/**
 * @fileoverview StateStore semantics for the PR bot: upsert keeps review results
 * across scans, a closed PR that reopens comes back as reviewed, saves are atomic
 * and 0600, and the message map is bounded.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StateStore } from '../scripts/pr-bot/state.js';
import type { PrSummary } from '../scripts/pr-bot/github.js';

function summary(over: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 7,
    title: 't',
    author: 'a',
    headSha: 'aaaa',
    baseRef: 'master',
    headRef: 'x',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    updatedAt: '',
    url: 'https://example/7',
    isCrossRepository: true,
    labels: [],
    ...over,
  };
}

describe('StateStore', () => {
  it('starts empty, persists, and reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prbot-state-'));
    const path = join(dir, 'state.json');
    const store = new StateStore(path);
    const rec = store.upsertPr(summary());
    expect(rec.status).toBe('new');
    rec.status = 'reviewed';
    rec.reviewedSha = 'aaaa';
    rec.verdict = 'merge';
    store.state.telegramOffset = 42;
    store.save();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['state.json']); // no tmp file left behind
    const again = new StateStore(path);
    expect(again.pr(7)?.verdict).toBe('merge');
    expect(again.state.telegramOffset).toBe(42);
  });

  it('upsert refreshes metadata but keeps the review; reopening a closed PR restores reviewed', () => {
    const store = new StateStore(join(mkdtempSync(join(tmpdir(), 'prbot-state-')), 'state.json'));
    const rec = store.upsertPr(summary());
    rec.status = 'reviewed';
    rec.reviewedSha = 'aaaa';
    const moved = store.upsertPr(summary({ headSha: 'bbbb', title: 'renamed' }));
    expect(moved).toBe(rec); // same object: a review in flight keeps writing into the stored record
    expect(moved.status).toBe('reviewed');
    expect(moved.reviewedSha).toBe('aaaa');
    expect(moved.headSha).toBe('bbbb');
    expect(moved.title).toBe('renamed');
    moved.status = 'closed';
    moved.closedAs = 'closed';
    expect(store.openPrs()).toHaveLength(0);
    const reopened = store.upsertPr(summary({ headSha: 'bbbb' }));
    expect(reopened.status).toBe('reviewed');
    expect(reopened.closedAs).toBeUndefined();
    expect(store.openPrs()).toHaveLength(1);
  });

  it('bounds the message map on save', () => {
    const store = new StateStore(join(mkdtempSync(join(tmpdir(), 'prbot-state-')), 'state.json'));
    for (let i = 0; i < 2500; i++) store.rememberMessage(i, 1);
    store.save();
    const keys = Object.keys(store.state.messages).map(Number);
    expect(keys).toHaveLength(2000);
    expect(Math.min(...keys)).toBe(500);
    expect(store.prForMessage(2499)).toBe(1);
    expect(store.prForMessage(10)).toBeUndefined();
  });
});
