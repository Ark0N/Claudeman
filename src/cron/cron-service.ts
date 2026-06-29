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
import { MAX_CONCURRENT_SESSIONS, MAX_CRON_RUN_HISTORY } from '../config/map-limits.js';
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

/** Hard ceiling on a prompt-file read (defends against unbounded-read DoS). */
const MAX_PROMPT_FILE_BYTES = 1024 * 1024;

/** Order-insensitive equality for the weekly-days arrays. */
function sameDays(a: number[] | undefined, b: number[] | undefined): boolean {
  const x = [...(a ?? [])].sort((p, q) => p - q);
  const y = [...(b ?? [])].sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

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

    // A completed one-time job is only re-armed when the SCHEDULE actually
    // CHANGES — otherwise a cosmetic edit would silently resurrect a job that
    // already fired. We compare VALUES, not field-presence: the edit form
    // round-trips the full job (incl. unchanged scheduleType/runAt) on every
    // save, so a presence check would always re-arm. Only a real schedule
    // change re-arms.
    const changed = <T>(next: T | undefined, prev: T): boolean => next !== undefined && next !== prev;
    const scheduleChanged =
      changed(patch.scheduleType, existing.scheduleType) ||
      changed(patch.runAt, existing.runAt) ||
      changed(patch.intervalMinutes, existing.intervalMinutes) ||
      changed(patch.dailyTime, existing.dailyTime) ||
      changed(patch.weeklyTime, existing.weeklyTime) ||
      (patch.weeklyDays !== undefined && !sameDays(patch.weeklyDays, existing.weeklyDays));
    const reArm = existing.scheduleType !== 'once' || !existing.completedOnce || scheduleChanged;

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
    this.pruneRunHistory();
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
   * the API and its contents are injected into an agent session (an exfil sink
   * over SSE/terminal), so an unconfined read would let a hostile job config
   * pull arbitrary host files — including the SERVER PROCESS'S OWN secrets via
   * `/proc/self/environ` — into the session.
   *
   * A denylist is the wrong posture for an exfil sink (it kept missing `/proc`,
   * `/dev`, other users' `~/.ssh`, modern cloud creds…). So the PRIMARY gate is
   * an allowlist: the prompt file must resolve INSIDE the job's working
   * directory. A symlink escaping the workspace fails this because we check the
   * realpath-resolved target. We additionally require a regular file (rejects
   * directories, FIFOs, and `/dev/*` character devices that would hang or OOM
   * the unbounded read) within a sane size cap, and keep the shared blocklist as
   * cheap defense-in-depth. Returns the symlink-resolved path to read.
   */
  private async resolveSafePromptPath(rawPath: string, workingDir: string): Promise<string> {
    let resolved: string;
    try {
      resolved = realpathSync(rawPath);
    } catch {
      throw new Error('prompt file path could not be resolved');
    }

    // Defense-in-depth blocklist (secret locations, /etc, /root).
    const guard = await loadAttachmentGuardConfig();
    if (isBlockedAttachmentPath(resolved, guard.blockedTrees)) {
      throw new Error('prompt file path is blocked');
    }

    // Primary gate: the prompt file must live inside the job's workspace.
    if (!validateSessionFilePath(workingDir, resolved)) {
      throw new Error('prompt file path must be inside the job working directory');
    }

    // Reject non-regular files and oversized files (DoS via unbounded read).
    let info;
    try {
      info = statSync(resolved);
    } catch {
      throw new Error('prompt file path could not be resolved');
    }
    if (!info.isFile()) throw new Error('prompt file path is not a regular file');
    if (info.size > MAX_PROMPT_FILE_BYTES) throw new Error('prompt file is too large');

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
    // Coalesce consecutive skips: if the job is already in a skip streak, don't
    // record again — a perpetually-skipped interval job would otherwise write a
    // run every tick forever and bloat state.json.
    if (this.listRuns(job.id)[0]?.status === 'skipped') return;

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
    this.pruneRunHistory();
    this.deps.broadcast(SseEvent.CronRunCreated, run);
    // A skip is NOT a run: surface it as the lastStatus, but do NOT advance
    // lastRunAt (no session was created).
    this.updateJobLastStatus(job.id, 'skipped', { touchLastRun: false });
  }

  /** Prune the oldest run records (by startedAt) once the global cap is exceeded. */
  private pruneRunHistory(): void {
    const runs = Object.values(this.store.getCronJobRuns());
    if (runs.length <= MAX_CRON_RUN_HISTORY) return;
    runs.sort((a, b) => a.startedAt - b.startedAt);
    for (const run of runs.slice(0, runs.length - MAX_CRON_RUN_HISTORY)) {
      this.store.removeCronJobRun(run.id);
    }
  }

  private updateJobLastStatus(jobId: string, status: CronJobRunStatus, opts: { touchLastRun?: boolean } = {}): void {
    const fresh = this.store.getCronJob(jobId);
    if (!fresh) return;
    const now = Date.now();
    fresh.lastStatus = status;
    if (opts.touchLastRun !== false) fresh.lastRunAt = now;
    fresh.updatedAt = now;
    this.store.setCronJob(fresh.id, fresh);
    this.broadcastListChanged();
  }

  private broadcastListChanged(): void {
    this.deps.broadcast(SseEvent.CronJobsChanged, { jobs: this.listJobs() });
  }
}
