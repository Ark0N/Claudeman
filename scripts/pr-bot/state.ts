/**
 * @fileoverview The bot's persisted state: one record per PR (what was reviewed at
 * which head, the parsed report, the Claude session to resume for follow-ups, the
 * Telegram messages that belong to it), the Telegram update offset, pending
 * confirmations, and the pause flag. One JSON file, written atomically (tmp + rename)
 * with mode 0600, since reports quote code and draft comments.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { CiState, PrSummary } from './github.js';
import type { ReviewReport } from './report.js';
import type { Verdict } from './review-task.js';

export type PrStatus = 'new' | 'queued' | 'reviewing' | 'reviewed' | 'failed' | 'skipped' | 'closed';

export interface PrRecord {
  number: number;
  title: string;
  author: string;
  url: string;
  headSha: string;
  isDraft: boolean;
  mergeable: PrSummary['mergeable'];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  status: PrStatus;
  ci?: CiState;
  reviewedSha?: string;
  reviewedAt?: string;
  reviewDurationMin?: number;
  verdict?: Verdict;
  report?: ReviewReport;
  briefPath?: string;
  reportJsonPath?: string;
  reportMdPath?: string;
  /** The Claude conversation to resume for follow-ups. */
  claudeSessionId?: string;
  /** The live Codeman session while a turn is running; cleared afterwards. */
  activeSessionId?: string;
  worktreeDir?: string;
  telegramMessageId?: number;
  lastError?: string;
  closedAs?: 'merged' | 'closed';
  updatedAt: string;
}

export interface PendingConfirm {
  action: 'merge' | 'close' | 'post';
  prNumber: number;
  createdAt: string;
  messageId?: number;
  /** Closing comment for `close`. */
  reason?: string;
}

export interface BotState {
  version: 1;
  paused: boolean;
  telegramOffset: number;
  prs: Record<string, PrRecord>;
  pending: Record<string, PendingConfirm>;
  /** Telegram message id -> PR number, so a reply to any of the bot's messages finds its PR. */
  messages: Record<string, number>;
  /** Telegram message id -> PR number for "reply with the closing reason" prompts. */
  reasonPrompts: Record<string, number>;
}

export function emptyState(): BotState {
  return { version: 1, paused: false, telegramOffset: 0, prs: {}, pending: {}, messages: {}, reasonPrompts: {} };
}

const MAX_MESSAGE_MAP = 2000;

export class StateStore {
  state: BotState;

  constructor(private readonly path: string) {
    this.state = emptyState();
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BotState>;
        this.state = { ...emptyState(), ...parsed, version: 1 };
      } catch (err) {
        throw new Error(`state file ${path} is unreadable: ${(err as Error).message}`);
      }
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.pruneMessageMap();
    const tmp = join(dirname(this.path), `.state.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  pr(number: number): PrRecord | undefined {
    return this.state.prs[String(number)];
  }

  /**
   * Refresh a PR's metadata, keeping its review. Mutates the EXISTING record in place:
   * a review in flight holds a reference to it, and a scan that replaced the object
   * with a copy made that review write its verdict into an orphan (first daemon run:
   * PR 363 reported to Telegram, state still said `reviewing`).
   */
  upsertPr(summary: PrSummary): PrRecord {
    const key = String(summary.number);
    const existing = this.state.prs[key];
    const record: PrRecord = existing ?? {
      number: summary.number,
      title: summary.title,
      author: summary.author,
      url: summary.url,
      headSha: summary.headSha,
      isDraft: summary.isDraft,
      mergeable: summary.mergeable,
      status: 'new',
      updatedAt: new Date().toISOString(),
    };
    record.title = summary.title;
    record.author = summary.author;
    record.url = summary.url;
    record.headSha = summary.headSha;
    record.isDraft = summary.isDraft;
    record.mergeable = summary.mergeable;
    record.additions = summary.additions;
    record.deletions = summary.deletions;
    record.changedFiles = summary.changedFiles;
    if (record.status === 'closed') {
      // Reopened.
      record.status = record.reviewedSha ? 'reviewed' : 'new';
      record.closedAs = undefined;
    }
    record.updatedAt = new Date().toISOString();
    this.state.prs[key] = record;
    return record;
  }

  openPrs(): PrRecord[] {
    return Object.values(this.state.prs)
      .filter((r) => r.status !== 'closed')
      .sort((a, b) => b.number - a.number);
  }

  rememberMessage(messageId: number, prNumber: number): void {
    this.state.messages[String(messageId)] = prNumber;
  }

  prForMessage(messageId: number | undefined): number | undefined {
    if (messageId === undefined) return undefined;
    return this.state.messages[String(messageId)];
  }

  private pruneMessageMap(): void {
    const keys = Object.keys(this.state.messages);
    if (keys.length <= MAX_MESSAGE_MAP) return;
    // Message ids grow monotonically per chat; drop the oldest.
    keys.sort((a, b) => Number(a) - Number(b));
    for (const key of keys.slice(0, keys.length - MAX_MESSAGE_MAP)) delete this.state.messages[key];
  }
}
