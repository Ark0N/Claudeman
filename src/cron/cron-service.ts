/**
 * @fileoverview Cron service: CRUD for cron jobs, manual Run Now,
 * the background due-job tick, and run-history recording.
 *
 * It does NOT own session/tmux logic — it reuses Codeman's existing session
 * layer (create → addSession → setupSessionListeners → startInteractive/Shell →
 * send prompt via writeViaMux/write), mirroring the "quick start" route flow.
 */

import { v4 as uuidv4 } from 'uuid';
import { readFile } from 'node:fs/promises';
import { statSync, realpathSync } from 'node:fs';
import { Session } from '../session.js';
import { SseEvent } from '../web/sse-events.js';
import { CronJobSchema } from '../web/schemas.js';
import { getErrorMessage, createErrorResponse, ApiErrorCode } from '../types/api.js';
import { MAX_CONCURRENT_SESSIONS } from '../config/map-limits.js';
import { CRON_READY_MAX_ATTEMPTS, CRON_READY_SETTLE_MS } from '../config/server-timing.js';
import { isBlockedAttachmentPath, loadAttachmentGuardConfig } from '../config/attachment-guard.js';
import { validateSessionFilePath } from '../web/route-helpers.js';
import { computeNextRunAt, dueKeyFor } from './cron-time.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../web/ports/index.js';
import type { CronJob, CronJobRun, CronJobRunStatus, TriggerType } from '../types/cron.js';
import type { CronJobInput } from './cron-input.js';

/** The subset of the route context the cron depends on. */
export type CronDeps = SessionPort & EventPort & ConfigPort & InfraPort;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class CronService {
  constructor(private readonly deps: CronDeps) {}

  private get store() {
    return this.deps.store;
  }

  // ───────────────────────────── Reads ─────────────────────────────

  listJobs(): CronJob[] {
    return Object.values(this.store.getCronJobs());
  }

  getJob(id: string): CronJob | null {
    return this.store.getCronJob(id);
  }

  listRuns(jobId?: string): CronJobRun[] {
    const all = Object.values(this.store.getCronJobRuns());
    const filtered = jobId ? all.filter((r) => r.cronJobId === jobId) : all;
    return filtered.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Number of active sessions of a given agent type (for the multi-session warning). */
  countActiveAgents(agentType: string): number {
    let n = 0;
    for (const s of this.deps.sessions.values()) if (s.mode === agentType) n++;
    return n;
  }

  // ──────────────────────────── Mutations ───────────────────────────

  createJob(input: CronJobInput): CronJob {
    const now = Date.now();
    const job: CronJob = {
      id: uuidv4(),
      name: input.name,
      agentType: input.agentType,
      workingDir: input.workingDir,
      launchCommand: input.launchCommand,
      promptMode: input.promptMode,
      promptText: input.promptText,
      promptFilePath: input.promptFilePath,
      inputMode: input.inputMode,
      scheduleType: input.scheduleType,
      runAt: input.runAt,
      intervalMinutes: input.intervalMinutes,
      dailyTime: input.dailyTime,
      weeklyDays: input.weeklyDays,
      weeklyTime: input.weeklyTime,
      enabled: input.enabled,
      notes: input.notes,
      concurrencyPolicy: input.concurrencyPolicy,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: null,
      lastDueKey: null,
    };
    job.nextRunAt = job.enabled ? computeNextRunAt(job, now) : null;
    this.store.setCronJob(job.id, job);
    this.broadcastListChanged();
    return job;
  }

  updateJob(id: string, patch: Partial<CronJobInput>): CronJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;
    const now = Date.now();

    // A completed one-time job is only re-armed when the SCHEDULE itself is
    // edited — otherwise a cosmetic edit (rename, notes) would silently
    // resurrect a job that already fired and run it again.
    const scheduleTouched =
      patch.scheduleType !== undefined ||
      patch.runAt !== undefined ||
      patch.intervalMinutes !== undefined ||
      patch.dailyTime !== undefined ||
      patch.weeklyTime !== undefined ||
      patch.weeklyDays !== undefined;
    const reArm = existing.scheduleType !== 'once' || !existing.completedOnce || scheduleTouched;

    const updated: CronJob = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      completedOnce: reArm ? false : existing.completedOnce,
      lastDueKey: null,
    };

    // The PUT schema is `.partial()`, so its cross-field rules don't run on a
    // partial body. Re-validate the MERGED job against the full schema so a
    // partial edit can't leave an enabled job with an inconsistent schedule
    // (e.g. switching to `once` without a `runAt` → a dead `nextRunAt:null`).
    const check = CronJobSchema.safeParse(updated);
    if (!check.success) {
      const msg = check.error.issues[0]?.message ?? 'Invalid cron job update';
      throw Object.assign(new Error(msg), {
        statusCode: 400,
        body: createErrorResponse(ApiErrorCode.INVALID_INPUT, msg),
      });
    }

    updated.nextRunAt = updated.enabled ? computeNextRunAt(updated, now) : null;
    this.store.setCronJob(updated.id, updated);
    this.broadcastListChanged();
    return updated;
  }

  setEnabled(id: string, enabled: boolean): CronJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;
    const now = Date.now();
    existing.enabled = enabled;
    existing.updatedAt = now;
    existing.nextRunAt = enabled ? computeNextRunAt(existing, now) : null;
    this.store.setCronJob(existing.id, existing);
    this.broadcastListChanged();
    return existing;
  }

  deleteJob(id: string): boolean {
    if (!this.getJob(id)) return false;
    this.store.removeCronJob(id);
    for (const run of this.listRuns(id)) this.store.removeCronJobRun(run.id);
    this.deps.broadcast(SseEvent.CronJobDeleted, { id });
    this.broadcastListChanged();
    return true;
  }

  // ──────────────────────────── Execution ───────────────────────────

  /** Manual Run Now — always launches regardless of schedule/enabled state. */
  async runNow(id: string): Promise<CronJobRun | null> {
    const job = this.getJob(id);
    if (!job) return null;
    return this.launch(job, 'manual_run_now');
  }

  /**
   * Background tick: launch every enabled job whose next run is due. Advances
   * each job's schedule and guards against double-launching the same due time.
   */
  async tickDueJobs(now: number = Date.now()): Promise<void> {
    for (const job of this.listJobs()) {
      if (!job.enabled || job.nextRunAt == null || job.nextRunAt > now) continue;

      const key = dueKeyFor(job.id, job.nextRunAt);
      if (job.lastDueKey === key) {
        // This due time was already consumed (overlap/restart) — just advance.
        this.advanceAfterFire(job, now);
        continue;
      }

      // Optional concurrency policy for AUTOMATIC runs.
      if (job.concurrencyPolicy === 'skip_if_same_agent_running' && this.countActiveAgents(job.agentType) > 0) {
        job.lastDueKey = key;
        // Record the skip so the job's run history isn't silently empty when it
        // keeps getting skipped (otherwise it looks like the job never ran).
        this.recordSkippedRun(job);
        this.advanceAfterFire(job, now);
        continue;
      }

      job.lastDueKey = key;
      // Advance the schedule BEFORE launching so a slow launch can't be
      // re-triggered by the next tick.
      this.advanceAfterFire(job, now);
      this.launch(job, 'scheduled').catch((err) =>
        console.error(`[cron] launch failed for job ${job.id}:`, getErrorMessage(err))
      );
    }
  }

  /** Recompute nextRunAt for loaded jobs on boot (e.g. after a restart). */
  init(): void {
    const now = Date.now();
    for (const job of this.listJobs()) {
      const isDeadOnce = job.scheduleType === 'once' && job.completedOnce;
      if (job.enabled && job.nextRunAt == null && !isDeadOnce) {
        job.nextRunAt = computeNextRunAt(job, now);
        this.store.setCronJob(job.id, job);
      }
    }
  }

  // ──────────────────────────── Internals ───────────────────────────

  private advanceAfterFire(job: CronJob, now: number): void {
    if (job.scheduleType === 'once') {
      job.completedOnce = true;
      job.enabled = false;
      job.nextRunAt = null;
    } else {
      job.nextRunAt = computeNextRunAt(job, now);
    }
    job.updatedAt = now;
    this.store.setCronJob(job.id, job);
    this.broadcastListChanged();
  }

  private async launch(job: CronJob, trigger: TriggerType): Promise<CronJobRun> {
    const run: CronJobRun = {
      id: uuidv4(),
      cronJobId: job.id,
      sessionId: null,
      sessionName: null,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'created',
      triggerType: trigger,
      createdSessionUrl: null,
    };
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunCreated, run);

    // Resolve the prompt.
    let prompt: string;
    try {
      prompt = await this.resolvePrompt(job);
    } catch (err) {
      return this.failRun(job, run, `Prompt error: ${getErrorMessage(err)}`);
    }

    // Validate working directory.
    try {
      if (!statSync(job.workingDir).isDirectory()) {
        return this.failRun(job, run, 'workingDir is not a directory');
      }
    } catch {
      return this.failRun(job, run, 'workingDir does not exist');
    }

    // Respect the global session cap.
    if (this.deps.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return this.failRun(job, run, `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
    }

    // Create + start the session (mirrors the quick-start route flow).
    let session: Session;
    try {
      const mode = job.agentType;
      const globalNice = await this.deps.getGlobalNiceConfig();
      const modelConfig = await this.deps.getModelConfig();
      const claudeModeConfig = await this.deps.getClaudeModeConfig();
      const model = mode !== 'shell' ? modelConfig?.defaultModel || undefined : undefined;
      session = new Session({
        workingDir: job.workingDir,
        mode,
        name: job.name,
        mux: this.deps.mux,
        useMux: true,
        niceConfig: globalNice,
        model,
        claudeMode: claudeModeConfig.claudeMode,
        allowedTools: claudeModeConfig.allowedTools,
      });
      this.deps.addSession(session);
      this.store.incrementSessionsCreated();
      this.deps.persistSessionState(session);
      await this.deps.setupSessionListeners(session);
      this.deps.broadcast(SseEvent.SessionCreated, this.deps.getSessionStateWithRespawn(session));
      if (mode === 'shell') {
        await session.startShell();
      } else {
        await session.startInteractive();
      }
      this.deps.broadcast(SseEvent.SessionInteractive, { id: session.id, mode });
    } catch (err) {
      return this.failRun(job, run, `Session launch failed: ${getErrorMessage(err)}`);
    }

    run.sessionId = session.id;
    run.sessionName = session.name;
    run.createdSessionUrl = `/?session=${session.id}`;
    run.status = 'session_started';
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunUpdated, run);
    this.updateJobLastStatus(job.id, 'session_started');

    // Send the prompt once the CLI is ready (async; does not block the caller).
    this.sendPromptWhenReady(session.id, prompt, job, run);
    return run;
  }

  private async resolvePrompt(job: CronJob): Promise<string> {
    if (job.promptMode === 'prompt_file_path') {
      if (!job.promptFilePath) throw new Error('prompt file path is empty');
      const safePath = await this.resolveSafePromptPath(job.promptFilePath, job.workingDir);
      return readFile(safePath, 'utf-8');
    }
    return job.promptText ?? '';
  }

  /**
   * Guards a prompt-file path before it is read. The path is user-supplied via
   * the API, so without this an attacker (or a hostile job config) could read
   * arbitrary host files (e.g. /etc/passwd, SSH keys) into a Claude session.
   *
   * Mirrors the attachment-serving guard (`resolveServableAttachmentPath` in
   * file-routes): realpath-resolve, then reject via the shared blocklist
   * (`/etc`, `/root`, secret locations) plus optional workspace confinement.
   * Returns the symlink-resolved path to read.
   */
  private async resolveSafePromptPath(rawPath: string, workingDir: string): Promise<string> {
    let resolved: string;
    try {
      resolved = realpathSync(rawPath);
    } catch {
      throw new Error('prompt file path could not be resolved');
    }

    const guard = await loadAttachmentGuardConfig();
    const blocked =
      isBlockedAttachmentPath(resolved, guard.blockedTrees) ||
      isBlockedAttachmentPath(rawPath, guard.blockedTrees) ||
      (guard.confineToWorkspace && !validateSessionFilePath(workingDir, resolved));

    if (blocked) throw new Error('prompt file path is blocked');
    return resolved;
  }

  private sendPromptWhenReady(sessionId: string, prompt: string, job: CronJob, run: CronJobRun): void {
    setImmediate(() => {
      const poll = async (): Promise<void> => {
        if (job.agentType !== 'shell') {
          for (let attempt = 0; attempt < CRON_READY_MAX_ATTEMPTS; attempt++) {
            await delay(500);
            const s = this.deps.sessions.get(sessionId);
            if (!s) return; // session was removed
            const buf = s.getTerminalBuffer().slice(-2048);
            if (buf.includes('❯') || buf.includes('tokens')) break;
          }
          await delay(CRON_READY_SETTLE_MS);
        } else {
          await delay(1000);
        }
        const s = this.deps.sessions.get(sessionId);
        if (!s) return;
        try {
          const payload = prompt.endsWith('\r') ? prompt : `${prompt}\r`;
          if (job.inputMode === 'paste') {
            s.write(payload);
          } else {
            await s.writeViaMux(payload);
          }
          run.status = 'prompt_sent';
          run.finishedAt = Date.now();
          this.store.setCronJobRun(run.id, run);
          this.deps.broadcast(SseEvent.CronRunUpdated, run);
          this.updateJobLastStatus(job.id, 'prompt_sent');
        } catch (err) {
          this.failRun(job, run, `Failed to send prompt: ${getErrorMessage(err)}`);
        }
      };
      poll().catch((err) => console.error('[cron] sendPromptWhenReady error:', getErrorMessage(err)));
    });
  }

  private failRun(job: CronJob, run: CronJobRun, message: string): CronJobRun {
    run.status = 'failed';
    run.errorMessage = message;
    run.finishedAt = Date.now();
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunUpdated, run);
    this.updateJobLastStatus(job.id, 'failed');
    return run;
  }

  private recordSkippedRun(job: CronJob): void {
    const now = Date.now();
    const run: CronJobRun = {
      id: uuidv4(),
      cronJobId: job.id,
      sessionId: null,
      sessionName: null,
      startedAt: now,
      finishedAt: now,
      status: 'skipped',
      errorMessage: `Skipped: a ${job.agentType} agent is already running (concurrency policy)`,
      triggerType: 'scheduled',
      createdSessionUrl: null,
    };
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunCreated, run);
    this.updateJobLastStatus(job.id, 'skipped');
  }

  private updateJobLastStatus(jobId: string, status: CronJobRunStatus): void {
    const fresh = this.store.getCronJob(jobId);
    if (!fresh) return;
    const now = Date.now();
    fresh.lastStatus = status;
    fresh.lastRunAt = now;
    fresh.updatedAt = now;
    this.store.setCronJob(fresh.id, fresh);
    this.broadcastListChanged();
  }

  private broadcastListChanged(): void {
    this.deps.broadcast(SseEvent.CronJobsChanged, { jobs: this.listJobs() });
  }
}
