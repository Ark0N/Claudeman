/**
 * @fileoverview The PR bot's Telegram command and button handling, driven through
 * `PrBot.handleUpdate` with a recording Telegram stub and a mocked `gh` layer. Pins
 * the one property that matters most: a GitHub write (merge, close, post) happens only
 * after the confirmation tap, exactly once, and never for a foreign chat or a stale
 * nonce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const gh = vi.hoisted(() => ({
  listOpenPrs: vi.fn(async () => []),
  getPrDetail: vi.fn(),
  getCiStatus: vi.fn(async () => ({ state: 'passed', runs: [] })),
  mergePr: vi.fn(async () => 'merged'),
  closePr: vi.fn(async () => 'closed'),
  commentPr: vi.fn(async () => 'commented'),
  approveWorkflowRun: vi.fn(async () => undefined),
  gh: vi.fn(async () => 'MERGED\n'),
}));
vi.mock('../scripts/pr-bot/github.js', () => gh);
vi.mock('../scripts/pr-bot/worktree.js', () => ({
  preparePrWorktree: vi.fn(),
  removePrWorktree: vi.fn(async () => undefined),
}));

import { PrBot, type TelegramLike } from '../scripts/pr-bot/bot.js';
import { buildConfig } from '../scripts/pr-bot/config.js';
import type { CodemanClient } from '../scripts/pr-bot/codeman-client.js';
import type { PrDetail } from '../scripts/pr-bot/github.js';
import type { ReviewReport } from '../scripts/pr-bot/report.js';

class FakeTelegram implements TelegramLike {
  sent: { text: string; markup?: unknown; plain: boolean }[] = [];
  edits: number[] = [];
  private nextId = 100;
  isOurChat(chatId: number | string | undefined): boolean {
    return String(chatId) === '1';
  }
  async sendMessage(text: string, opts: { replyMarkup?: unknown } = {}): Promise<number> {
    this.sent.push({ text, markup: opts.replyMarkup, plain: false });
    return this.nextId++;
  }
  async sendPlain(text: string): Promise<number> {
    this.sent.push({ text, plain: true });
    return this.nextId++;
  }
  async editReplyMarkup(messageId: number): Promise<void> {
    this.edits.push(messageId);
  }
  async deleteMessage(): Promise<void> {}
  async answerCallback(): Promise<void> {}
  async sendDocument(): Promise<void> {}
  async getUpdates(): Promise<[]> {
    return [];
  }
  async setMyCommands(): Promise<void> {}
  last(): string {
    return this.sent[this.sent.length - 1]?.text ?? '';
  }
  /** The confirm callback_data of the last message's keyboard. */
  confirmData(): string {
    const markup = this.sent[this.sent.length - 1]?.markup as { inline_keyboard: { callback_data: string }[][] };
    return markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('confirm:'))!.callback_data;
  }
}

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    number: 381,
    title: 'feat(web): base URL',
    author: 'mtiller',
    headSha: 'abc123abc123',
    baseRef: 'master',
    headRef: 'feat',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    updatedAt: '',
    url: 'https://github.com/Ark0N/Codeman/pull/381',
    isCrossRepository: true,
    labels: [],
    body: '',
    files: [],
    authorAssociation: 'CONTRIBUTOR',
    linkedIssues: [],
    commitCount: 1,
    commentCount: 0,
    reviewDecision: '',
    headRepo: 'mtiller/Codeman',
    ...over,
  };
}

const report: ReviewReport = {
  verdict: 'merge',
  confidence: 'high',
  summary: 's',
  changes: [],
  findings: [],
  checks: [],
  scope: 'focused',
  risk: '',
  recommendation: 'merge it',
  draftComment: 'Thanks, merging.',
  assumptions: [],
};

const msg = (text: string, chat = 1, replyTo?: { message_id: number; text?: string }) => ({
  update_id: 1,
  message: { message_id: 7, chat: { id: chat }, text, reply_to_message: replyTo },
});
const cb = (data: string, chat = 1) => ({
  update_id: 2,
  callback_query: { id: 'q', from: { id: 1 }, data, message: { message_id: 9, chat: { id: chat } } },
});

describe('PrBot commands', () => {
  let bot: PrBot;
  let tg: FakeTelegram;

  beforeEach(() => {
    vi.clearAllMocks();
    gh.getPrDetail.mockImplementation(async () => detail());
    const cfg = buildConfig(
      { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', PR_BOT_DATA_DIR: mkdtempSync(join(tmpdir(), 'prbot-cmd-')) },
      { home: '/h', repoRoot: '/r' }
    );
    tg = new FakeTelegram();
    bot = new PrBot(cfg, { telegram: tg, codeman: {} as CodemanClient, log: () => undefined });
    const rec = bot.store.upsertPr(detail());
    Object.assign(rec, { status: 'reviewed', reviewedSha: 'abc123abc123', verdict: 'merge', report });
    bot.store.save();
  });

  afterEach(async () => {
    await bot.stop();
  });

  it('answers /help only for the configured chat', async () => {
    await bot.handleUpdate(msg('/help', 2));
    expect(tg.sent).toHaveLength(0);
    await bot.handleUpdate(msg('/help'));
    expect(tg.last()).toContain('/merge N');
  });

  it('shows the draft without posting it', async () => {
    await bot.handleUpdate(msg('/draft 381'));
    expect(tg.last()).toContain('Thanks, merging.');
    expect(tg.last()).toContain('not posted');
    expect(gh.commentPr).not.toHaveBeenCalled();
  });

  it('merges only after the confirmation tap, once, and rejects a reused nonce', async () => {
    await bot.handleUpdate(msg('/merge 381'));
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(tg.last()).toContain('Merge <b>#381</b>');
    expect(Object.keys(bot.store.state.pending)).toHaveLength(1);
    const data = tg.confirmData();
    expect(data).toMatch(/^confirm:merge:381:[0-9a-f]{8}$/);

    await bot.handleUpdate(cb(data));
    expect(gh.mergePr).toHaveBeenCalledTimes(1);
    expect(gh.mergePr).toHaveBeenCalledWith('Ark0N/Codeman', 381);
    expect(tg.last()).toContain('Merged <b>#381</b>');
    expect(Object.keys(bot.store.state.pending)).toHaveLength(0);
    expect(tg.edits).toContain(9); // the keyboard is removed from the confirmation message

    await bot.handleUpdate(cb(data));
    expect(gh.mergePr).toHaveBeenCalledTimes(1);
    expect(tg.last()).toContain('no longer valid');
  });

  it('ignores a confirmation tap from a foreign chat', async () => {
    await bot.handleUpdate(msg('/merge 381'));
    await bot.handleUpdate(cb(tg.confirmData(), 2));
    expect(gh.mergePr).not.toHaveBeenCalled();
  });

  it('refuses to offer a merge for a conflicting PR and warns about red CI', async () => {
    gh.getPrDetail.mockImplementationOnce(async () => detail({ mergeable: 'CONFLICTING' }));
    await bot.handleUpdate(msg('/merge 381'));
    expect(tg.last()).toContain('needs a rebase');
    expect(Object.keys(bot.store.state.pending)).toHaveLength(0);

    gh.getCiStatus.mockImplementationOnce(async () => ({ state: 'failed', runs: [] }));
    await bot.handleUpdate(msg('/merge 381'));
    expect(tg.last()).toContain('CI is red');
    expect(Object.keys(bot.store.state.pending)).toHaveLength(1);
  });

  it('cancel drops the pending confirmation', async () => {
    await bot.handleUpdate(msg('/merge 381'));
    const data = tg.confirmData().replace(/^confirm:/, 'cancel:');
    await bot.handleUpdate(cb(data));
    expect(Object.keys(bot.store.state.pending)).toHaveLength(0);
    await bot.handleUpdate(cb(tg.sent[tg.sent.length - 1] ? data.replace(/^cancel:/, 'confirm:') : ''));
    expect(gh.mergePr).not.toHaveBeenCalled();
  });

  it('closes with the given comment after confirmation, and asks for one when missing', async () => {
    await bot.handleUpdate(msg('/close 381'));
    expect(tg.last()).toContain('Reply to this message');
    expect(gh.closePr).not.toHaveBeenCalled();

    await bot.handleUpdate(msg('/close 381 superseded by #372'));
    expect(tg.last()).toContain('superseded by #372');
    await bot.handleUpdate(cb(tg.confirmData()));
    expect(gh.closePr).toHaveBeenCalledWith('Ark0N/Codeman', 381, 'superseded by #372');
  });

  it('posts the draft only after confirmation', async () => {
    await bot.handleUpdate(msg('/post 381'));
    expect(gh.commentPr).not.toHaveBeenCalled();
    expect(tg.sent.some((s) => s.plain && s.text === 'Thanks, merging.')).toBe(true);
    await bot.handleUpdate(cb(tg.confirmData()));
    expect(gh.commentPr).toHaveBeenCalledWith('Ark0N/Codeman', 381, 'Thanks, merging.');
  });

  it('a reply to a review message becomes a follow-up, refused when nothing was reviewed', async () => {
    const rec = bot.store.upsertPr(detail({ number: 390, title: 'other' }));
    bot.store.rememberMessage(55, 390);
    expect(rec.reviewedSha).toBeUndefined();
    await bot.handleUpdate(msg('does it handle X?', 1, { message_id: 55 }));
    expect(tg.last()).toContain('No review of #390 yet');
  });

  it('reports status with verdict icons', async () => {
    await bot.handleUpdate(msg('/status'));
    expect(tg.last()).toContain('✅ <b>#381</b>');
  });
});
