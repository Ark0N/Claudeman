/**
 * @fileoverview Unit tests for the PR bot's pure helpers: report parsing and
 * Telegram formatting (report.ts), CI classification (github.ts), command and
 * callback parsing (telegram.ts), the trust-dialog reader (codeman-client.ts) and
 * config validation (config.ts). No network, no git, no Telegram.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReportKeyboard,
  confirmKeyboard,
  extractJsonObject,
  formatReviewFailure,
  formatStatusList,
  formatTelegramSummary,
  orderBacklog,
  parseReport,
  splitTelegramMessage,
  TELEGRAM_MAX,
  type ReviewReport,
} from '../scripts/pr-bot/report.js';
import { classifyCi, latestRunPerWorkflow, type PrSummary, type WorkflowRun } from '../scripts/pr-bot/github.js';
import { parseCallback, parseCommand, prNumberFromMessageText } from '../scripts/pr-bot/telegram.js';
import { trustDialogKey } from '../scripts/pr-bot/codeman-client.js';
import { buildConfig, parseEnvFile } from '../scripts/pr-bot/config.js';
import { buildReviewBrief } from '../scripts/pr-bot/review-task.js';

const pr: PrSummary = {
  number: 381,
  title: 'feat(web): support a reverse-proxy base URL',
  author: 'mtiller',
  headSha: '7e4914d991ea864d7dfbefe03f042380d02981c4',
  baseRef: 'master',
  headRef: 'feat/reverse-proxy-base-url',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeState: 'UNSTABLE',
  additions: 664,
  deletions: 112,
  changedFiles: 28,
  updatedAt: '2026-09-04T20:15:52Z',
  url: 'https://github.com/Ark0N/Codeman/pull/381',
  isCrossRepository: true,
  labels: [],
};

const rawReport = {
  verdict: 'request_changes',
  confidence: 'HIGH',
  summary: 'Adds a base path. Two real bugs.',
  changes: ['base-path config', 'ingress rewrite'],
  findings: [
    { severity: 'minor', title: 'nit first in input', file: 'a.ts', line: 1, detail: 'x' },
    { severity: 'blocker', title: 'SSE path not prefixed', file: 'src/web/server.ts', line: 210, detail: 'events 404' },
    { severity: 'bogus', title: 'unknown severity becomes minor', detail: '' },
    { title: '' },
  ],
  checks: [
    { name: 'typecheck', command: 'npm run typecheck', result: 'PASS' },
    { name: 'tests', result: 'fail', notes: '2 failed' },
    { name: '', result: 'pass' },
  ],
  scope: 'MIXED',
  risk: 'r',
  recommendation: 'Ask for the SSE fix, then merge.',
  draftComment: 'Thanks!',
  assumptions: ['none', 42],
};

describe('parseReport', () => {
  it('normalizes case, separators and severities, and sorts findings by severity', () => {
    const r = parseReport(rawReport)!;
    expect(r.verdict).toBe('request-changes');
    expect(r.confidence).toBe('high');
    expect(r.scope).toBe('mixed');
    expect(r.findings.map((f) => f.severity)).toEqual(['blocker', 'minor', 'minor']);
    expect(r.findings[0].file).toBe('src/web/server.ts');
    expect(r.findings[0].line).toBe(210);
    expect(r.checks).toHaveLength(2);
    expect(r.checks[0].result).toBe('pass');
    expect(r.assumptions).toEqual(['none']);
  });

  it('returns null without a recognizable verdict', () => {
    expect(parseReport({ summary: 'no verdict' })).toBeNull();
    expect(parseReport(null)).toBeNull();
    expect(parseReport('merge')).toBeNull();
  });

  it('defaults confidence to medium', () => {
    expect(parseReport({ verdict: 'merge' })!.confidence).toBe('medium');
  });
});

describe('extractJsonObject', () => {
  it('reads bare JSON, fenced JSON and JSON inside prose', () => {
    expect(extractJsonObject('{"verdict":"merge"}')).toEqual({ verdict: 'merge' });
    expect(extractJsonObject('Here:\n```json\n{"verdict":"close"}\n```\nDone.')).toEqual({ verdict: 'close' });
    expect(extractJsonObject('REVIEW COMPLETE {"verdict":"merge","x":1} trailing')).toEqual({ verdict: 'merge', x: 1 });
    expect(extractJsonObject('nothing here')).toBeNull();
  });
});

describe('formatTelegramSummary', () => {
  const report = parseReport(rawReport)!;

  it('carries the verdict, the top findings, checks and the recommendation, HTML-escaped', () => {
    const text = formatTelegramSummary(pr, report, { ci: 'awaiting-approval', durationMin: 7 });
    expect(text).toContain('PR #381');
    expect(text).toContain('REQUEST CHANGES');
    expect(text).toContain('needs your approval');
    expect(text).toContain('🔴 SSE path not prefixed');
    expect(text).toContain('src/web/server.ts:210');
    expect(text).toContain('typecheck ✅');
    expect(text).toContain('tests ❌');
    expect(text).toContain('Ask for the SSE fix');
    expect(text).toContain('review took 7 min');
    expect(text.length).toBeLessThan(TELEGRAM_MAX);
  });

  it('escapes HTML in model output', () => {
    const r: ReviewReport = { ...report, summary: 'uses <script> & friends', findings: [] };
    const text = formatTelegramSummary(pr, r, { ci: 'passed' });
    expect(text).toContain('uses &lt;script&gt; &amp; friends');
    expect(text).not.toContain('<script>');
  });

  it('stays under the Telegram cap with many long findings and says how many are hidden', () => {
    const findings = Array.from({ length: 60 }, (_, i) => ({
      severity: 'major' as const,
      title: `finding ${i} ${'x'.repeat(150)}`,
      file: `src/file-${i}.ts`,
      line: i,
      detail: 'd',
    }));
    const text = formatTelegramSummary(pr, { ...report, findings }, { ci: 'failed' });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(text).toMatch(/… \d+ more in the full report/);
  });
});

describe('splitTelegramMessage', () => {
  it('keeps short text whole and splits long text on line boundaries', () => {
    expect(splitTelegramMessage('a\nb')).toEqual(['a\nb']);
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'y'.repeat(40)}`);
    const chunks = splitTelegramMessage(lines.join('\n'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(chunks.join('\n')).toBe(lines.join('\n'));
  });

  it('hard-splits a single line longer than the cap', () => {
    const chunks = splitTelegramMessage('z'.repeat(9000), 4000);
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000]);
  });
});

describe('keyboards', () => {
  it("keeps every callback_data under Telegram's 64-byte cap and adds the approve button only when CI waits", () => {
    const all = [
      ...buildReportKeyboard(38199, { ci: 'awaiting-approval', hasDraft: true }).flat(),
      ...buildReportKeyboard(1, { ci: 'passed', hasDraft: false }).flat(),
      ...confirmKeyboard('merge', 38199, 'deadbeef').flat(),
    ];
    for (const b of all) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    expect(
      buildReportKeyboard(5, { ci: 'awaiting-approval', hasDraft: true })
        .flat()
        .some((b) => b.callback_data === 'approveci:5')
    ).toBe(true);
    expect(
      buildReportKeyboard(5, { ci: 'passed', hasDraft: true })
        .flat()
        .some((b) => b.callback_data.startsWith('approveci'))
    ).toBe(false);
    expect(
      buildReportKeyboard(5, { ci: 'passed', hasDraft: false })
        .flat()
        .some((b) => b.callback_data === 'post:5')
    ).toBe(false);
  });
});

describe('orderBacklog', () => {
  it('puts mergeable and small first, conflicting last, newer first on ties', () => {
    const rows = [
      { number: 375, mergeable: 'CONFLICTING' as const, additions: 5000, deletions: 100 },
      { number: 383, mergeable: 'MERGEABLE' as const, additions: 29, deletions: 1 },
      { number: 380, mergeable: 'MERGEABLE' as const, additions: 1800, deletions: 400 },
      { number: 362, mergeable: 'CONFLICTING' as const, additions: 200, deletions: 10 },
      { number: 390, mergeable: 'UNKNOWN' as const, additions: 29, deletions: 1 },
    ];
    expect(orderBacklog(rows).map((r) => r.number)).toEqual([390, 383, 380, 362, 375]);
  });
});

describe('formatStatusList + formatReviewFailure', () => {
  it('renders rows with verdict icons and flags', () => {
    const text = formatStatusList(
      [
        {
          number: 1,
          title: 'a',
          author: 'x',
          verdict: 'merge',
          status: 'reviewed',
          ci: 'passed',
          mergeable: 'MERGEABLE',
          isDraft: false,
        },
        { number: 2, title: 'b <c>', author: 'y', status: 'queued', mergeable: 'CONFLICTING', isDraft: true },
      ],
      true
    );
    expect(text).toContain('⏸ auto-review paused');
    expect(text).toContain('✅ <b>#1</b>');
    expect(text).toContain('🕓 <b>#2</b> b &lt;c&gt;');
    expect(text).toContain('conflicts, draft');
    expect(formatStatusList([], false)).toBe('No open pull requests.');
  });

  it('failure notice names the retry command', () => {
    expect(formatReviewFailure(pr, 'timed out')).toContain('/review 381');
  });
});

describe('classifyCi', () => {
  const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
    id: 1,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    ...over,
  });

  it('reads the newest run per workflow only', () => {
    const runs = [
      run({ id: 3, conclusion: 'success' }),
      run({ id: 2, conclusion: 'failure' }),
      run({ id: 1, name: 'Other', conclusion: 'failure' }),
    ];
    expect(latestRunPerWorkflow(runs).map((r) => r.id)).toEqual([3, 1]);
    expect(classifyCi(runs)).toBe('failed');
    expect(classifyCi([run({ id: 3 }), run({ id: 2, conclusion: 'failure' })])).toBe('passed');
  });

  it('maps the fork-PR approval gate, pending and empty cases', () => {
    expect(classifyCi([])).toBe('none');
    expect(classifyCi([run({ conclusion: 'action_required' })])).toBe('awaiting-approval');
    expect(classifyCi([run({ status: 'in_progress', conclusion: null })])).toBe('pending');
    expect(classifyCi([run({ conclusion: 'skipped' })])).toBe('passed');
  });
});

describe('telegram parsers', () => {
  it('parses commands with and without a PR number, and bot-suffixed commands', () => {
    expect(parseCommand('/merge 381')).toEqual({ command: 'merge', prNumber: 381, rest: '' });
    expect(parseCommand('/close #381 superseded by #372')).toEqual({
      command: 'close',
      prNumber: 381,
      rest: 'superseded by #372',
    });
    expect(parseCommand('/ask 12 does it handle\nmultiline?')).toEqual({
      command: 'ask',
      prNumber: 12,
      rest: 'does it handle\nmultiline?',
    });
    expect(parseCommand('/status@arkon85_bot')).toEqual({ command: 'status', rest: '' });
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });

  it('parses callbacks and rejects malformed data', () => {
    expect(parseCallback('merge:381')).toEqual({ action: 'merge', prNumber: 381 });
    expect(parseCallback('confirm:merge:381:ab12')).toEqual({
      action: 'confirm',
      target: 'merge',
      prNumber: 381,
      nonce: 'ab12',
    });
    expect(parseCallback('confirm:merge:381')).toBeNull();
    expect(parseCallback('merge:x')).toBeNull();
    expect(parseCallback(undefined)).toBeNull();
  });

  it('finds the PR number in a report message', () => {
    expect(prNumberFromMessageText('🔍 PR #381 · title')).toBe(381);
    expect(prNumberFromMessageText('no number')).toBeNull();
  });
});

describe('trustDialogKey', () => {
  it('reads the highlighted option off a tmux repaint that lost its spaces', () => {
    const esc = '\x1b';
    const screen = `Security guide\n${esc}[1m❯${esc}[CNo,${esc}[Cexit\n  Yes, I trust this folder\nEnter to confirm`;
    expect(trustDialogKey(screen)).toBe('move');
    expect(trustDialogKey('  No, exit\n❯ Yes, I trust this folder\n')).toBe('confirm');
    expect(trustDialogKey('❯ Try "fix the bug"\n shift+tab to cycle')).toBeNull();
  });

  it('lets the freshest marked row win', () => {
    expect(trustDialogKey('❯ No, exit\n...\n❯ Yes, I trust this folder')).toBe('confirm');
  });
});

describe('config', () => {
  it('parses env files with quotes, comments and export prefixes', () => {
    const env = parseEnvFile('# c\nexport A="x y"\nB=\'z\'\nC=plain\nbad line\n=nokey\n');
    expect(env).toEqual({ A: 'x y', B: 'z', C: 'plain' });
  });

  it('validates required keys and derives paths and units', () => {
    expect(() => buildConfig({}, { home: '/h', repoRoot: '/r' })).toThrow(/TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID/);
    const cfg = buildConfig(
      {
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_CHAT_ID: '1',
        PR_BOT_POLL_INTERVAL: '30',
        PR_BOT_REVIEW_TIMEOUT: '3',
        PR_BOT_AUTO_REVIEW: 'off',
      },
      { home: '/h', repoRoot: '/r' }
    );
    expect(cfg.githubRepo).toBe('Ark0N/Codeman');
    expect(cfg.codemanApiUrl).toBe('https://127.0.0.1:3000');
    expect(cfg.dataDir).toBe('/h/.codeman/pr-bot');
    expect(cfg.worktreesDir).toBe('/h/.codeman/pr-bot/worktrees');
    expect(cfg.mainCheckout).toBe('/r');
    expect(cfg.pollIntervalMs).toBe(60_000); // floored at 60s
    expect(cfg.reviewTimeoutMs).toBe(5 * 60_000); // floored at 5 min
    expect(cfg.autoReview).toBe(false);
    expect(cfg.reviewDrafts).toBe(false);
    expect(() =>
      buildConfig(
        { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', GITHUB_REPO: 'nope' },
        { home: '/h', repoRoot: '/r' }
      )
    ).toThrow(/owner\/name/);
  });
});

describe('buildReviewBrief', () => {
  it('names the report paths, the ground rules and the CI situation', () => {
    const brief = buildReviewBrief({
      pr: {
        ...pr,
        body: 'Body **md**',
        files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
        linkedIssues: [],
        commitCount: 2,
        commentCount: 0,
        reviewDecision: '',
        headRepo: 'mtiller/Codeman',
      },
      ci: { state: 'awaiting-approval', runs: [] },
      mergeBase: 'abcdef0123456789',
      worktreeDir: '/wt/pr-381',
      mainCheckout: '/main',
      reportJsonPath: '/jobs/report.json',
      reportMdPath: '/jobs/report.md',
    });
    expect(brief).toContain('/jobs/report.json');
    expect(brief).toContain('/jobs/report.md');
    expect(brief).toContain('REVIEW COMPLETE');
    expect(brief).toContain('waiting for a maintainer to approve');
    expect(brief).toContain('never bind port 3000');
    expect(brief).toContain('first time contributor');
    expect(brief).toContain('`src/a.ts` (+1/-0)');
  });
});
