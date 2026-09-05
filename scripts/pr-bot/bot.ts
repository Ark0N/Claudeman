/**
 * @fileoverview The PR bot: polls the repository's open pull requests, reviews each
 * one (once per head commit) in a Codeman claude session running in a private
 * worktree, and reports to the maintainer over Telegram with a verdict, the ranked
 * findings, a recommendation and action buttons.
 *
 * Three rules shape everything here:
 *
 * 1. Reviews are automatic; GitHub WRITES are not. Merge, close, post-comment and
 *    approve-CI happen only from an explicit Telegram command or button press from
 *    the configured chat, and merge/close/post take a second confirmation tap. The
 *    bot never posts a review comment on its own: the draft is shown first and the
 *    maintainer decides.
 * 2. One review session at a time (`reviewLoop` is serial); follow-up questions run
 *    beside it, at most two, never on a PR whose session is live (`busy`).
 * 3. The bot deletes only sessions it created (`prbot-*`, tracked by id), and touches
 *    git only through worktree.ts, never the maintainer's checkout.
 */
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CodemanClient, stripAnsi, type TurnOutcome } from './codeman-client.js';
import type { PrBotConfig } from './config.js';
import {
  approveWorkflowRun,
  closePr,
  commentPr,
  getCiStatus,
  getPrDetail,
  gh,
  listOpenPrs,
  mergePr,
  type CiStatus,
  type PrSummary,
} from './github.js';
import {
  buildReportKeyboard,
  confirmKeyboard,
  escapeHtml,
  extractJsonObject,
  formatReviewFailure,
  formatStatusList,
  formatTelegramSummary,
  orderBacklog,
  parseReport,
  splitTelegramMessage,
  type ReviewReport,
} from './report.js';
import { buildFollowupBrief, buildReviewBrief, followupKickoffLine, reviewKickoffLine } from './review-task.js';
import { StateStore, type PendingConfirm, type PrRecord } from './state.js';
import {
  parseCallback,
  parseCommand,
  prNumberFromMessageText,
  type TelegramCallbackQuery,
  type TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram.js';
import { preparePrWorktree, removePrWorktree } from './worktree.js';

/** What the bot needs from Telegram; `main.ts review --no-telegram` substitutes a console. */
export type TelegramLike = Pick<
  TelegramClient,
  | 'isOurChat'
  | 'sendMessage'
  | 'sendPlain'
  | 'editReplyMarkup'
  | 'deleteMessage'
  | 'answerCallback'
  | 'sendDocument'
  | 'getUpdates'
  | 'setMyCommands'
>;

export interface PrBotDeps {
  telegram: TelegramLike;
  codeman: CodemanClient;
  log: (msg: string) => void;
}

const CONFIRM_TTL_MS = 15 * 60_000;
const MAX_FOLLOWUPS = 2;
const REPORT_INLINE_MAX = 3000;

const COMMANDS = [
  { command: 'status', description: 'Open PRs with verdicts' },
  { command: 'scan', description: 'Check GitHub now' },
  { command: 'review', description: '/review N: (re)review a PR now' },
  { command: 'report', description: '/report N: the full review' },
  { command: 'summary', description: '/summary N: the review message again' },
  { command: 'draft', description: '/draft N: the draft comment' },
  { command: 'post', description: '/post N: post the draft comment (asks first)' },
  { command: 'merge', description: '/merge N: merge (asks first)' },
  { command: 'close', description: '/close N reason: close with a comment (asks first)' },
  { command: 'approve', description: '/approve N: approve a waiting CI run' },
  { command: 'ask', description: '/ask N question: ask the reviewer' },
  { command: 'pause', description: 'Stop auto-reviewing' },
  { command: 'resume', description: 'Resume auto-reviewing' },
  { command: 'help', description: 'All commands' },
];

const HELP = `<b>Codeman PR bot</b>
Every open PR is reviewed once per head commit in its own Codeman session; you get the verdict here and decide.

/status · open PRs and verdicts
/scan · check GitHub now
/review N · (re)review now, jumps the queue
/report N · full review as a file
/summary N · the review message with its buttons again
/draft N · the comment drafted for the contributor
/post N · post that draft (you confirm first)
/merge N · merge with a merge commit (you confirm first)
/close N reason · close with that comment (you confirm first)
/approve N · approve a CI run waiting on you (first-time contributors)
/ask N question · ask the reviewer session anything; it resumes with its context
/pause · /resume · auto-review on and off

Reply to any review message with plain text to ask about that PR.`;

function isBotAuthor(login: string): boolean {
  return login.endsWith('[bot]') || login.startsWith('app/');
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  return (stderr || e.message || String(err)).slice(0, 1500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PrBot {
  readonly store: StateStore;
  private reviewQueue: number[] = [];
  private readonly busy = new Set<number>();
  private readonly createdSessions = new Set<string>();
  private followupsRunning = 0;
  private stopped = false;
  private scanning = false;
  private scanTimer?: NodeJS.Timeout;
  private wakeQueue: (() => void) | null = null;
  private reviewing: number | null = null;

  constructor(
    private readonly cfg: PrBotConfig,
    private readonly deps: PrBotDeps
  ) {
    mkdirSync(cfg.dataDir, { recursive: true });
    this.store = new StateStore(join(cfg.dataDir, 'state.json'));
  }

  private get telegram(): TelegramLike {
    return this.deps.telegram;
  }

  private get codeman(): CodemanClient {
    return this.deps.codeman;
  }

  private log(msg: string): void {
    this.deps.log(msg);
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    await this.telegram.setMyCommands(COMMANDS).catch((err) => this.log(`setMyCommands: ${errText(err)}`));
    await this.sweepStaleSessions();
    const open = this.store.openPrs().length;
    await this.telegram
      .sendMessage(
        `🤖 <b>PR bot online</b> · ${escapeHtml(this.cfg.githubRepo)} · auto-review ${
          this.cfg.autoReview && !this.store.state.paused ? 'on' : 'off'
        } · polling every ${Math.round(this.cfg.pollIntervalMs / 60_000)} min${open ? ` · ${open} PRs known` : ''}`
      )
      .catch((err) => this.log(`startup message: ${errText(err)}`));
    void this.reviewLoop();
    void this.telegramLoop();
    this.scheduleScan(2000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.wakeQueue?.();
    for (const id of this.createdSessions) {
      await this.codeman.deleteSession(id).catch((err) => this.log(`delete ${id}: ${errText(err)}`));
    }
    this.createdSessions.clear();
    for (const rec of Object.values(this.store.state.prs)) {
      if (rec.status === 'reviewing') rec.status = rec.reviewedSha ? 'reviewed' : 'new';
      rec.activeSessionId = undefined;
    }
    this.store.save();
  }

  /** A crashed run can leave `prbot-*` sessions behind; they are ours by construction. */
  private async sweepStaleSessions(): Promise<void> {
    try {
      const sessions = await this.codeman.listSessions();
      for (const s of sessions) {
        if (!s.name?.startsWith('prbot-')) continue;
        this.log(`sweeping stale session ${s.name} (${s.id.slice(0, 8)})`);
        await this.codeman.deleteSession(s.id).catch((err) => this.log(`sweep ${s.id}: ${errText(err)}`));
      }
    } catch (err) {
      this.log(`session sweep skipped: ${errText(err)}`);
    }
  }

  private scheduleScan(delayMs: number): void {
    if (this.stopped) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      void this.scanOnce('timer')
        .catch((err) => this.log(`scan failed: ${errText(err)}`))
        .finally(() => this.scheduleScan(this.cfg.pollIntervalMs));
    }, delayMs);
  }

  // ---- scanning ------------------------------------------------------------

  /** List open PRs, retire the ones that closed, queue what needs a (re)review. */
  async scanOnce(reason: string): Promise<{ queued: number[]; closed: number[] }> {
    if (this.scanning) return { queued: [], closed: [] };
    this.scanning = true;
    const queued: number[] = [];
    const closed: number[] = [];
    try {
      const open = await listOpenPrs(this.cfg.githubRepo);
      const openNumbers = new Set(open.map((p) => p.number));
      for (const rec of this.store.openPrs()) {
        if (openNumbers.has(rec.number) || this.busy.has(rec.number)) continue;
        await this.onPrClosed(rec);
        closed.push(rec.number);
      }
      const candidates: PrSummary[] = [];
      for (const pr of open) {
        const rec = this.store.upsertPr(pr);
        if (isBotAuthor(pr.author)) {
          rec.status = 'skipped';
          continue;
        }
        if (pr.isDraft && !this.cfg.reviewDrafts) {
          if (rec.status === 'new') rec.status = 'skipped';
          continue;
        }
        if (rec.status === 'skipped') rec.status = rec.reviewedSha ? 'reviewed' : 'new';
        const needsReview = rec.reviewedSha !== pr.headSha;
        if (needsReview && !this.busy.has(pr.number) && !this.reviewQueue.includes(pr.number)) candidates.push(pr);
      }
      if (this.cfg.autoReview && !this.store.state.paused) {
        for (const pr of orderBacklog(candidates)) {
          this.enqueueReview(pr.number, { front: false });
          queued.push(pr.number);
        }
      }
      this.store.save();
      this.log(`scan (${reason}): ${open.length} open, ${queued.length} queued, ${closed.length} closed`);
    } finally {
      this.scanning = false;
    }
    return { queued, closed };
  }

  private async onPrClosed(rec: PrRecord): Promise<void> {
    let merged = false;
    try {
      const out = await gh([
        'pr',
        'view',
        String(rec.number),
        '--repo',
        this.cfg.githubRepo,
        '--json',
        'state',
        '--jq',
        '.state',
      ]);
      merged = out.trim() === 'MERGED';
    } catch (err) {
      this.log(`state lookup for #${rec.number}: ${errText(err)}`);
    }
    rec.status = 'closed';
    rec.closedAs = merged ? 'merged' : 'closed';
    rec.activeSessionId = undefined;
    this.reviewQueue = this.reviewQueue.filter((n) => n !== rec.number);
    await removePrWorktree({
      mainCheckout: this.cfg.mainCheckout,
      worktreesDir: this.cfg.worktreesDir,
      prNumber: rec.number,
      log: (m) => this.log(`[#${rec.number}] ${m}`),
    }).catch((err) => this.log(`worktree cleanup #${rec.number}: ${errText(err)}`));
    await this.telegram
      .sendMessage(
        `${merged ? '🎉 Merged' : '🔒 Closed'} <b>#${rec.number}</b> · ${escapeHtml(rec.title)} <i>(${escapeHtml(rec.author)})</i>`
      )
      .catch((err) => this.log(`close notice: ${errText(err)}`));
  }

  // ---- review queue --------------------------------------------------------

  enqueueReview(number: number, opts: { front: boolean }): 'queued' | 'moved' | 'busy' {
    if (this.busy.has(number)) return 'busy';
    const rec = this.store.pr(number);
    if (rec) rec.status = 'queued';
    const idx = this.reviewQueue.indexOf(number);
    if (idx >= 0) {
      if (!opts.front) return 'queued';
      this.reviewQueue.splice(idx, 1);
      this.reviewQueue.unshift(number);
      this.wakeQueue?.();
      return 'moved';
    }
    if (opts.front) this.reviewQueue.unshift(number);
    else this.reviewQueue.push(number);
    this.wakeQueue?.();
    return 'queued';
  }

  private async reviewLoop(): Promise<void> {
    while (!this.stopped) {
      const next = this.reviewQueue.shift();
      if (next === undefined) {
        await new Promise<void>((resolve) => {
          this.wakeQueue = resolve;
        });
        this.wakeQueue = null;
        continue;
      }
      if (this.busy.has(next)) continue;
      this.busy.add(next);
      this.reviewing = next;
      try {
        await this.reviewPr(next);
      } catch (err) {
        this.log(`[#${next}] review crashed: ${errText(err)}`);
      } finally {
        this.busy.delete(next);
        this.reviewing = null;
      }
    }
  }

  /** One full review of a PR at its current head. Serial by construction (see reviewLoop). */
  async reviewPr(number: number): Promise<PrRecord> {
    const log = (m: string) => this.log(`[#${number}] ${m}`);
    const started = Date.now();
    let rec = this.store.pr(number);
    let sessionId: string | undefined;
    let progressMsg: number | undefined;
    try {
      const detail = await getPrDetail(this.cfg.githubRepo, number);
      rec = this.store.upsertPr(detail);
      const ci = await getCiStatus(this.cfg.githubRepo, detail.headSha);
      rec.ci = ci.state;
      rec.status = 'reviewing';
      rec.lastError = undefined;
      this.store.save();
      progressMsg = await this.telegram.sendMessage(
        `🔍 Reviewing <b>PR #${number}</b> · ${escapeHtml(detail.title)} <i>(${escapeHtml(detail.author)}, +${detail.additions}/−${detail.deletions}, ${detail.changedFiles} files)</i> …`
      );

      const wt = await preparePrWorktree({
        mainCheckout: this.cfg.mainCheckout,
        worktreesDir: this.cfg.worktreesDir,
        prNumber: number,
        reset: true,
        log,
      });
      rec.worktreeDir = wt.dir;
      if (wt.headSha !== detail.headSha) log(`head moved during fetch: reviewing ${wt.headSha.slice(0, 8)}`);
      detail.headSha = wt.headSha;

      const jobDir = join(this.cfg.dataDir, 'jobs', `pr-${number}`);
      mkdirSync(jobDir, { recursive: true });
      const briefPath = join(jobDir, 'brief.md');
      const reportJsonPath = join(jobDir, 'report.json');
      const reportMdPath = join(jobDir, 'report.md');
      rmSync(reportJsonPath, { force: true });
      rmSync(reportMdPath, { force: true });
      writeFileSync(
        briefPath,
        buildReviewBrief({
          pr: detail,
          ci,
          mergeBase: wt.mergeBase,
          worktreeDir: wt.dir,
          mainCheckout: this.cfg.mainCheckout,
          reportJsonPath,
          reportMdPath,
        })
      );
      Object.assign(rec, { briefPath, reportJsonPath, reportMdPath });

      sessionId = await this.codeman.createInteractiveSession({
        workingDir: wt.dir,
        name: `prbot-${number}`,
        modelOverride: this.cfg.model,
        effort: this.cfg.effort,
      });
      this.createdSessions.add(sessionId);
      rec.activeSessionId = sessionId;
      this.store.save();
      log(`session ${sessionId.slice(0, 8)} spawned in ${wt.dir}`);
      await this.codeman.ensureReady(sessionId, log);

      const isDone = () => existsSync(reportJsonPath) && existsSync(reportMdPath);
      const outcome = await this.codeman.runTurn(sessionId, reviewKickoffLine(briefPath), {
        deadlineMs: this.cfg.reviewTimeoutMs,
        isDone,
        log,
      });
      log(`turn ended: ${outcome.kind}`);
      if (outcome.kind === 'stop' && isDone()) {
        // Let the session finish its closing line before we read and delete.
        await this.codeman.waitSignal(sessionId, 'stop,exit', 15_000).catch(() => undefined);
      }

      let report: ReviewReport | null = null;
      if (existsSync(reportJsonPath)) report = parseReport(extractJsonObject(readFileSync(reportJsonPath, 'utf8')));
      if (!report) {
        const last = await this.pollLastResponse(sessionId);
        report = parseReport(extractJsonObject(last));
        if (report && !existsSync(reportMdPath)) writeFileSync(reportMdPath, last);
      }
      await this.recordClaudeSessionId(sessionId, rec);
      if (!report) throw new Error(await this.describeFailure(sessionId, outcome, started));

      const durationMin = Math.max(1, Math.round((Date.now() - started) / 60_000));
      Object.assign(rec, {
        status: 'reviewed',
        reviewedSha: detail.headSha,
        reviewedAt: new Date().toISOString(),
        reviewDurationMin: durationMin,
        verdict: report.verdict,
        report,
      });
      Object.assign(rec, {
        additions: detail.additions,
        deletions: detail.deletions,
        changedFiles: detail.changedFiles,
      });
      await this.sendSummary(rec);
      log(`reviewed: ${report.verdict} (${durationMin} min)`);
    } catch (err) {
      const reason = errText(err);
      log(`review failed: ${reason}`);
      if (rec) {
        rec.status = 'failed';
        rec.lastError = reason;
        await this.telegram
          .sendMessage(formatReviewFailure(rec, reason))
          .catch((e) => log(`failure notice: ${errText(e)}`));
      }
    } finally {
      if (progressMsg !== undefined) await this.telegram.deleteMessage(progressMsg);
      if (sessionId) await this.releaseSession(sessionId, log);
      if (rec) rec.activeSessionId = undefined;
      this.store.save();
    }
    if (!rec) throw new Error(`PR #${number} not found`);
    return rec;
  }

  private async releaseSession(sessionId: string, log: (m: string) => void): Promise<void> {
    await this.codeman.deleteSession(sessionId).catch((err) => log(`delete session: ${errText(err)}`));
    this.createdSessions.delete(sessionId);
  }

  private async recordClaudeSessionId(sessionId: string, rec: PrRecord): Promise<void> {
    try {
      const s = await this.codeman.getSession(sessionId);
      if (s.claudeSessionId) rec.claudeSessionId = s.claudeSessionId;
    } catch {
      // The session may already be gone; the follow-up path copes without an id.
    }
  }

  /** The transcript write lags the stop signal; poll briefly like the skill's `last_text`. */
  private async pollLastResponse(sessionId: string): Promise<string> {
    let text = '';
    for (let i = 0; i < 12; i++) {
      text = await this.codeman.lastResponse(sessionId).catch(() => '');
      if (text.trim()) return text;
      await sleep(1000);
    }
    return text;
  }

  private async describeFailure(sessionId: string, outcome: TurnOutcome, started: number): Promise<string> {
    const minutes = Math.round((Date.now() - started) / 60_000);
    switch (outcome.kind) {
      case 'blocked': {
        const screen = stripAnsi(await this.codeman.terminalText(sessionId).catch(() => ''));
        const tail = screen.trim().split('\n').slice(-25).join('\n').slice(-1200);
        return `the reviewer stopped on a question or permission prompt after ${minutes} min:\n${tail}`;
      }
      case 'exit':
        return 'the session exited before writing a report';
      case 'timeout':
        return `timed out after ${minutes} min without a report`;
      default:
        return 'the session finished without writing report.json';
    }
  }

  // ---- follow-ups ----------------------------------------------------------

  private startFollowup(number: number, instruction: string, replyTo?: number): void {
    const rec = this.store.pr(number);
    if (!rec || !rec.reviewedSha) {
      void this.telegram.sendMessage(`No review of #${number} yet. /review ${number} first.`);
      return;
    }
    if (this.busy.has(number)) {
      void this.telegram.sendMessage(`#${number} has a session running right now; ask again in a few minutes.`);
      return;
    }
    if (this.followupsRunning >= MAX_FOLLOWUPS) {
      void this.telegram.sendMessage(`Two follow-ups are already running; try again shortly.`);
      return;
    }
    this.busy.add(number);
    this.followupsRunning++;
    void this.followup(rec, instruction, replyTo).finally(() => {
      this.busy.delete(number);
      this.followupsRunning--;
    });
  }

  private async followup(rec: PrRecord, instruction: string, replyTo?: number): Promise<void> {
    const number = rec.number;
    const log = (m: string) => this.log(`[#${number} ask] ${m}`);
    let sessionId: string | undefined;
    try {
      const wt = await preparePrWorktree({
        mainCheckout: this.cfg.mainCheckout,
        worktreesDir: this.cfg.worktreesDir,
        prNumber: number,
        reset: false,
        log,
      });
      const jobDir = join(this.cfg.dataDir, 'jobs', `pr-${number}`);
      mkdirSync(jobDir, { recursive: true });
      const followupPath = join(jobDir, `followup-${Date.now()}.md`);
      writeFileSync(
        followupPath,
        buildFollowupBrief({
          prNumber: number,
          title: rec.title,
          instruction,
          worktreeDir: wt.dir,
          reportMdPath: rec.reportMdPath ?? join(jobDir, 'report.md'),
          briefPath: rec.briefPath ?? join(jobDir, 'brief.md'),
        })
      );
      const base = {
        workingDir: wt.dir,
        name: `prbot-${number}-ask`,
        modelOverride: this.cfg.model,
        effort: this.cfg.effort,
      };
      if (rec.claudeSessionId) {
        try {
          sessionId = await this.codeman.createInteractiveSession({ ...base, resumeSessionId: rec.claudeSessionId });
        } catch (err) {
          log(`resume of ${rec.claudeSessionId.slice(0, 8)} refused (${errText(err)}); starting fresh`);
        }
      }
      if (!sessionId) sessionId = await this.codeman.createInteractiveSession(base);
      this.createdSessions.add(sessionId);
      rec.activeSessionId = sessionId;
      this.store.save();
      await this.codeman.ensureReady(sessionId, log);
      const outcome = await this.codeman.runTurn(sessionId, followupKickoffLine(followupPath), {
        deadlineMs: this.cfg.followupTimeoutMs,
        log,
      });
      let answer = (await this.pollLastResponse(sessionId)).trim();
      if (!answer) answer = await this.describeFailure(sessionId, outcome, Date.now());
      await this.recordClaudeSessionId(sessionId, rec);
      const moved =
        wt.headSha !== rec.reviewedSha
          ? `⚠️ #${number} has new commits since the review (use /review ${number}).\n\n`
          : '';
      for (const chunk of splitTelegramMessage(`💬 #${number}\n${moved}${answer}`)) {
        const id = await this.telegram.sendPlain(chunk, { replyToMessageId: replyTo });
        this.store.rememberMessage(id, number);
      }
    } catch (err) {
      await this.telegram
        .sendMessage(`⚠️ Follow-up on #${number} failed: ${escapeHtml(errText(err))}`)
        .catch(() => undefined);
    } finally {
      if (sessionId) await this.releaseSession(sessionId, log);
      rec.activeSessionId = undefined;
      this.store.save();
    }
  }

  // ---- telegram ------------------------------------------------------------

  private async telegramLoop(): Promise<void> {
    let backoff = 5000;
    while (!this.stopped) {
      try {
        const updates = await this.telegram.getUpdates(this.store.state.telegramOffset, 50);
        backoff = 5000;
        for (const update of updates) {
          this.store.state.telegramOffset = update.update_id + 1;
          this.store.save();
          try {
            await this.handleUpdate(update);
          } catch (err) {
            this.log(`update ${update.update_id}: ${errText(err)}`);
          }
        }
      } catch (err) {
        if (this.stopped) return;
        this.log(`telegram poll: ${errText(err)}; retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 120_000);
      }
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    if (update.message) return this.handleMessage(update.message);
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    if (!this.telegram.isOurChat(msg.chat.id)) return;
    const cmd = parseCommand(msg.text);
    if (!cmd) {
      const replyId = msg.reply_to_message?.message_id;
      const text = msg.text?.trim();
      if (!text) return;
      if (replyId !== undefined) {
        const reasonPr = this.store.state.reasonPrompts[String(replyId)];
        if (reasonPr !== undefined) {
          delete this.store.state.reasonPrompts[String(replyId)];
          this.store.save();
          return this.startConfirm('close', reasonPr, text);
        }
        const pr = this.store.prForMessage(replyId) ?? prNumberFromMessageText(msg.reply_to_message?.text) ?? undefined;
        if (pr !== undefined) return this.startFollowup(pr, text, msg.message_id);
      }
      await this.telegram.sendMessage('Reply to a review message to ask about that PR, or see /help.');
      return;
    }
    const need = (): number | null => {
      if (cmd.prNumber === undefined) {
        void this.telegram.sendMessage(`Which PR? <code>/${cmd.command} 123</code>`);
        return null;
      }
      return cmd.prNumber;
    };
    switch (cmd.command) {
      case 'start':
      case 'help':
        await this.telegram.sendMessage(HELP);
        return;
      case 'status':
        await this.sendStatus();
        return;
      case 'scan': {
        const r = await this.scanOnce('command');
        await this.telegram.sendMessage(
          `Scanned: ${r.queued.length ? `queued ${r.queued.map((n) => `#${n}`).join(', ')}` : 'nothing new'}${
            r.closed.length ? `; closed ${r.closed.map((n) => `#${n}`).join(', ')}` : ''
          }.`
        );
        return;
      }
      case 'review':
      case 'rescan': {
        const n = need();
        if (n === null) return;
        await this.queueByCommand(n);
        return;
      }
      case 'report': {
        const n = need();
        if (n !== null) await this.sendReport(n);
        return;
      }
      case 'summary': {
        const n = need();
        if (n === null) return;
        const rec = this.store.pr(n);
        if (!rec?.report) await this.telegram.sendMessage(`No review of #${n} yet.`);
        else await this.sendSummary(rec);
        return;
      }
      case 'draft': {
        const n = need();
        if (n !== null) await this.sendDraft(n);
        return;
      }
      case 'post': {
        const n = need();
        if (n !== null) await this.startConfirm('post', n);
        return;
      }
      case 'merge': {
        const n = need();
        if (n !== null) await this.startConfirm('merge', n);
        return;
      }
      case 'close': {
        const n = need();
        if (n === null) return;
        if (cmd.rest) await this.startConfirm('close', n, cmd.rest);
        else await this.askCloseReason(n);
        return;
      }
      case 'approve':
      case 'approveci': {
        const n = need();
        if (n !== null) await this.approveCi(n);
        return;
      }
      case 'ask': {
        const n = need();
        if (n === null) return;
        if (!cmd.rest) {
          await this.telegram.sendMessage(`Ask what? <code>/ask ${n} does this handle X?</code>`);
          return;
        }
        this.startFollowup(n, cmd.rest, msg.message_id);
        return;
      }
      case 'pause':
        this.store.state.paused = true;
        this.store.save();
        await this.telegram.sendMessage('⏸ Auto-review paused. /review N still works; /resume to continue.');
        return;
      case 'resume': {
        this.store.state.paused = false;
        this.store.save();
        const r = await this.scanOnce('resume');
        await this.telegram.sendMessage(
          `▶️ Auto-review resumed${r.queued.length ? `; queued ${r.queued.map((n) => `#${n}`).join(', ')}` : ''}.`
        );
        return;
      }
      default:
        await this.telegram.sendMessage(`Unknown command /${escapeHtml(cmd.command)}. See /help.`);
    }
  }

  private async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    const ack = (text?: string) => this.telegram.answerCallback(cb.id, text).catch(() => undefined);
    if (!cb.message || !this.telegram.isOurChat(cb.message.chat.id)) {
      await ack();
      return;
    }
    const parsed = parseCallback(cb.data);
    if (!parsed) {
      await ack();
      return;
    }
    const n = parsed.prNumber;
    switch (parsed.action) {
      case 'report':
        await ack('Sending the report…');
        await this.sendReport(n);
        return;
      case 'draft':
        await ack();
        await this.sendDraft(n);
        return;
      case 'review': {
        await ack();
        await this.queueByCommand(n);
        return;
      }
      case 'merge':
        await ack();
        await this.startConfirm('merge', n);
        return;
      case 'post':
        await ack();
        await this.startConfirm('post', n);
        return;
      case 'close':
        await ack();
        await this.askCloseReason(n);
        return;
      case 'approveci':
        await ack();
        await this.approveCi(n);
        return;
      case 'confirm':
        await ack();
        await this.runConfirmed(parsed.target ?? '', n, parsed.nonce ?? '', cb.message.message_id);
        return;
      case 'cancel':
        delete this.store.state.pending[parsed.nonce ?? ''];
        this.store.save();
        await this.telegram.editReplyMarkup(cb.message.message_id, { inline_keyboard: [] });
        await ack('Cancelled');
        return;
      default:
        await ack();
    }
  }

  private async queueByCommand(n: number): Promise<void> {
    let rec = this.store.pr(n);
    if (!rec) {
      try {
        rec = this.store.upsertPr(await getPrDetail(this.cfg.githubRepo, n));
        this.store.save();
      } catch (err) {
        await this.telegram.sendMessage(`Could not load #${n}: ${escapeHtml(errText(err))}`);
        return;
      }
    }
    const result = this.enqueueReview(n, { front: true });
    if (result === 'busy') await this.telegram.sendMessage(`#${n} is being reviewed right now.`);
    else {
      const ahead = this.reviewing !== null ? ` after #${this.reviewing} finishes` : '';
      await this.telegram.sendMessage(`Queued #${n} for review${ahead}.`);
    }
  }

  private async sendStatus(): Promise<void> {
    const rows = this.store.openPrs().map((r) => ({
      number: r.number,
      title: r.title,
      author: r.author,
      verdict: r.verdict,
      status: r.status,
      ci: r.ci,
      mergeable: r.mergeable,
      isDraft: r.isDraft,
    }));
    let text = formatStatusList(rows, this.store.state.paused);
    const live = [
      this.reviewing !== null ? `reviewing #${this.reviewing}` : '',
      this.reviewQueue.length ? `queue: ${this.reviewQueue.map((n) => `#${n}`).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (live) text += `\n\n<i>${live}</i>`;
    for (const chunk of splitTelegramMessage(text)) await this.telegram.sendMessage(chunk);
  }

  /** The report message with its buttons; also behind /summary N to bring the buttons back. */
  async sendSummary(rec: PrRecord): Promise<void> {
    if (!rec.report) return;
    const summaryPr: PrSummary = {
      number: rec.number,
      title: rec.title,
      author: rec.author,
      headSha: rec.reviewedSha ?? rec.headSha,
      baseRef: 'master',
      headRef: '',
      isDraft: rec.isDraft,
      mergeable: rec.mergeable,
      mergeState: '',
      additions: rec.additions ?? 0,
      deletions: rec.deletions ?? 0,
      changedFiles: rec.changedFiles ?? 0,
      updatedAt: rec.updatedAt,
      url: rec.url,
      isCrossRepository: true,
      labels: [],
    };
    const ci = rec.ci ?? 'none';
    const text = formatTelegramSummary(summaryPr, rec.report, { ci, durationMin: rec.reviewDurationMin });
    const keyboard = buildReportKeyboard(rec.number, { ci, hasDraft: Boolean(rec.report.draftComment) });
    const msgId = await this.telegram.sendMessage(text, { replyMarkup: { inline_keyboard: keyboard } });
    rec.telegramMessageId = msgId;
    this.store.rememberMessage(msgId, rec.number);
    this.store.save();
  }

  private async sendReport(n: number): Promise<void> {
    const rec = this.store.pr(n);
    if (!rec?.reportMdPath || !existsSync(rec.reportMdPath)) {
      await this.telegram.sendMessage(`No report for #${n} yet.`);
      return;
    }
    const content = readFileSync(rec.reportMdPath, 'utf8');
    if (content.length <= REPORT_INLINE_MAX) {
      const id = await this.telegram.sendPlain(`📄 Review of #${n}\n\n${content}`);
      this.store.rememberMessage(id, n);
      this.store.save();
      return;
    }
    await this.telegram.sendDocument(`pr-${n}-review.md`, content, `📄 Review of #${n} · ${rec.title}`.slice(0, 1000));
  }

  private async sendDraft(n: number): Promise<void> {
    const rec = this.store.pr(n);
    const draft = rec?.report?.draftComment;
    if (!draft) {
      await this.telegram.sendMessage(`No draft comment for #${n}.`);
      return;
    }
    for (const chunk of splitTelegramMessage(
      `💬 Draft comment for #${n} (not posted; /post ${n} to post it):\n\n${draft}`
    )) {
      const id = await this.telegram.sendPlain(chunk);
      this.store.rememberMessage(id, n);
    }
    this.store.save();
  }

  private async askCloseReason(n: number): Promise<void> {
    const id = await this.telegram.sendMessage(
      `Reply to this message with the closing comment for #${n} (it is posted on the PR when you confirm), or use <code>/close ${n} reason</code>.`
    );
    this.store.state.reasonPrompts[String(id)] = n;
    this.store.save();
  }

  private async approveCi(n: number): Promise<void> {
    const rec = this.store.pr(n);
    if (!rec) {
      await this.telegram.sendMessage(`Unknown PR #${n}.`);
      return;
    }
    try {
      const ci = await getCiStatus(this.cfg.githubRepo, rec.headSha);
      const waiting = ci.runs.filter((r) => r.conclusion === 'action_required');
      if (!waiting.length) {
        await this.telegram.sendMessage(`Nothing to approve for #${n} (CI: ${ci.state}).`);
        return;
      }
      for (const run of waiting) await approveWorkflowRun(this.cfg.githubRepo, run.id);
      rec.ci = 'pending';
      this.store.save();
      await this.telegram.sendMessage(
        `▶️ Approved ${waiting.length} workflow run${waiting.length === 1 ? '' : 's'} for #${n}; CI is starting.`
      );
    } catch (err) {
      await this.telegram.sendMessage(`⚠️ Approving CI for #${n} failed: ${escapeHtml(errText(err))}`);
    }
  }

  // ---- confirmations for GitHub writes --------------------------------------

  private async startConfirm(action: PendingConfirm['action'], n: number, reason?: string): Promise<void> {
    const rec = this.store.pr(n);
    if (!rec) {
      await this.telegram.sendMessage(`Unknown PR #${n}.`);
      return;
    }
    let text: string;
    if (action === 'post') {
      const draft = rec.report?.draftComment;
      if (!draft) {
        await this.telegram.sendMessage(`No draft comment for #${n}.`);
        return;
      }
      for (const chunk of splitTelegramMessage(draft)) await this.telegram.sendPlain(chunk);
      text = `📮 Post the comment above on <b>#${n}</b> · ${escapeHtml(rec.title)}? It goes out under your GitHub account.`;
    } else if (action === 'close') {
      if (!reason?.trim()) {
        await this.askCloseReason(n);
        return;
      }
      text = `🗑 Close <b>#${n}</b> · ${escapeHtml(rec.title)} <i>(${escapeHtml(rec.author)})</i> with this comment?\n\n${escapeHtml(reason.trim())}`;
    } else {
      let fresh: PrSummary | undefined;
      let ci: CiStatus | undefined;
      try {
        fresh = await getPrDetail(this.cfg.githubRepo, n);
        ci = await getCiStatus(this.cfg.githubRepo, fresh.headSha);
      } catch (err) {
        await this.telegram.sendMessage(`Could not check #${n} before merging: ${escapeHtml(errText(err))}`);
        return;
      }
      if (fresh.mergeable === 'CONFLICTING') {
        await this.telegram.sendMessage(`#${n} conflicts with master; it needs a rebase before it can be merged.`);
        return;
      }
      const notes: string[] = [];
      if (ci.state === 'failed') notes.push('⚠️ CI is red');
      if (ci.state === 'awaiting-approval') notes.push('⚠️ CI never ran (waiting for your approval)');
      if (ci.state === 'pending') notes.push('⏳ CI still running');
      if (ci.state === 'none') notes.push('⚠️ no CI runs for this head');
      if (rec.reviewedSha && rec.reviewedSha !== fresh.headSha) notes.push('⚠️ new commits since the review');
      if (fresh.isDraft) notes.push('⚠️ still a draft');
      if (rec.verdict && rec.verdict !== 'merge' && rec.verdict !== 'merge-with-fixes')
        notes.push(`⚠️ the review said ${rec.verdict.replace(/-/g, ' ')}`);
      text =
        `✅ Merge <b>#${n}</b> · ${escapeHtml(fresh.title)} <i>(${escapeHtml(fresh.author)})</i> into ${escapeHtml(fresh.baseRef)} with a merge commit?` +
        `\n${fresh.mergeable === 'MERGEABLE' ? 'mergeable' : 'mergeability unknown'} · CI ${ci.state} · head ${fresh.headSha.slice(0, 8)}` +
        (notes.length ? `\n${notes.join('\n')}` : '');
    }
    const nonce = randomBytes(4).toString('hex');
    const pending: PendingConfirm = {
      action,
      prNumber: n,
      createdAt: new Date().toISOString(),
      reason: reason?.trim(),
    };
    const id = await this.telegram.sendMessage(text, {
      replyMarkup: { inline_keyboard: confirmKeyboard(action, n, nonce) },
    });
    pending.messageId = id;
    this.store.state.pending[nonce] = pending;
    this.store.rememberMessage(id, n);
    this.store.save();
  }

  private async runConfirmed(target: string, n: number, nonce: string, messageId: number): Promise<void> {
    const pending = this.store.state.pending[nonce];
    delete this.store.state.pending[nonce];
    this.store.save();
    const fresh = pending && pending.prNumber === n && pending.action === target;
    const expired = !pending || Date.now() - Date.parse(pending.createdAt) > CONFIRM_TTL_MS;
    await this.telegram.editReplyMarkup(messageId, { inline_keyboard: [] });
    if (!fresh || expired) {
      await this.telegram.sendMessage(`That confirmation is no longer valid; run the command again.`);
      return;
    }
    const rec = this.store.pr(n);
    try {
      switch (pending.action) {
        case 'merge': {
          await mergePr(this.cfg.githubRepo, n);
          await this.telegram.sendMessage(`🎉 Merged <b>#${n}</b>${rec ? ` · ${escapeHtml(rec.title)}` : ''}.`);
          this.scheduleScan(5000);
          return;
        }
        case 'close': {
          await closePr(this.cfg.githubRepo, n, pending.reason ?? '');
          await this.telegram.sendMessage(`🔒 Closed <b>#${n}</b>${rec ? ` · ${escapeHtml(rec.title)}` : ''}.`);
          this.scheduleScan(5000);
          return;
        }
        case 'post': {
          const draft = rec?.report?.draftComment;
          if (!draft) throw new Error('the draft comment is gone');
          await commentPr(this.cfg.githubRepo, n, draft);
          await this.telegram.sendMessage(`📮 Posted the review comment on <b>#${n}</b>.`);
          return;
        }
      }
    } catch (err) {
      await this.telegram.sendMessage(`⚠️ ${pending.action} on #${n} failed: ${escapeHtml(errText(err))}`);
    }
  }
}
