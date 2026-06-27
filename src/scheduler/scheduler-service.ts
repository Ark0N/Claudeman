/**
 * @fileoverview Scheduler service: CRUD for scheduled jobs, manual Run Now,
 * the background due-job tick, and run-history recording.
 *
 * It does NOT own session/tmux logic — it reuses Codeman's existing session
 * layer (create → addSession → setupSessionListeners → startInteractive/Shell →
 * send prompt via writeViaMux/write), mirroring the "quick start" route flow.
 */

import { v4 as uuidv4 } from 'uuid';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { Session } from '../session.js';
import { SseEvent } from '../web/sse-events.js';
import { getErrorMessage } from '../types/api.js';
import { MAX_CONCURRENT_SESSIONS } from '../config/map-limits.js';
import { SCHEDULER_READY_MAX_ATTEMPTS, SCHEDULER_READY_SETTLE_MS } from '../config/server-timing.js';
import { computeNextRunAt, dueKeyFor } from './scheduler-time.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../web/ports/index.js';
import type { ScheduledJob, ScheduledJobRun, ScheduledJobRunStatus, TriggerType } from '../types/scheduler.js';
import type { ScheduledJobInput } from './scheduler-input.js';

/** The subset of the route context the scheduler depends on. */
export type SchedulerDeps = SessionPort & EventPort & ConfigPort & InfraPort;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SchedulerService {
  constructor(private readonly deps: SchedulerDeps) {}

  private get store() {
    return this.deps.store;
  }

  // ───────────────────────────── Reads ─────────────────────────────

  listJobs(): ScheduledJob[] {
    return Object.values(this.store.getScheduledJobs());
  }

  getJob(id: string): ScheduledJob | null {
    return this.store.getScheduledJob(id);
  }

  listRuns(jobId?: string): ScheduledJobRun[] {
    const all = Object.values(this.store.getScheduledJobRuns());
    const filtered = jobId ? all.filter((r) => r.scheduledJobId === jobId) : all;
    return filtered.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Number of active sessions of a given agent type (for the multi-session warning). */
  countActiveAgents(agentType: string): number {
    let n = 0;
    for (const s of this.deps.sessions.values()) if (s.mode === agentType) n++;
    return n;
  }

  // ──────────────────────────── Mutations ───────────────────────────

  createJob(input: ScheduledJobInput): ScheduledJob {
    const now = Date.now();
    const job: ScheduledJob = {
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
    this.store.setScheduledJob(job.id, job);
    this.broadcastListChanged();
    return job;
  }

  updateJob(id: string, patch: Partial<ScheduledJobInput>): ScheduledJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;
    const now = Date.now();
    const updated: ScheduledJob = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      // Editing a job re-arms it: clear the one-time completion + dup-guard so a
      // changed schedule can fire again.
      completedOnce: false,
      lastDueKey: null,
    };
    updated.nextRunAt = updated.enabled ? computeNextRunAt(updated, now) : null;
    this.store.setScheduledJob(updated.id, updated);
    this.broadcastListChanged();
    return updated;
  }

  setEnabled(id: string, enabled: boolean): ScheduledJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;
    const now = Date.now();
    existing.enabled = enabled;
    existing.updatedAt = now;
    existing.nextRunAt = enabled ? computeNextRunAt(existing, now) : null;
    this.store.setScheduledJob(existing.id, existing);
    this.broadcastListChanged();
    return existing;
  }

  deleteJob(id: string): boolean {
    if (!this.getJob(id)) return false;
    this.store.removeScheduledJob(id);
    for (const run of this.listRuns(id)) this.store.removeScheduledJobRun(run.id);
    this.deps.broadcast(SseEvent.SchedulerJobDeleted, { id });
    this.broadcastListChanged();
    return true;
  }

  // ──────────────────────────── Execution ───────────────────────────

  /** Manual Run Now — always launches regardless of schedule/enabled state. */
  async runNow(id: string): Promise<ScheduledJobRun | null> {
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
        this.advanceAfterFire(job, now);
        continue;
      }

      job.lastDueKey = key;
      // Advance the schedule BEFORE launching so a slow launch can't be
      // re-triggered by the next tick.
      this.advanceAfterFire(job, now);
      this.launch(job, 'scheduled').catch((err) =>
        console.error(`[scheduler] launch failed for job ${job.id}:`, getErrorMessage(err))
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
        this.store.setScheduledJob(job.id, job);
      }
    }
  }

  // ──────────────────────────── Internals ───────────────────────────

  private advanceAfterFire(job: ScheduledJob, now: number): void {
    if (job.scheduleType === 'once') {
      job.completedOnce = true;
      job.enabled = false;
      job.nextRunAt = null;
    } else {
      job.nextRunAt = computeNextRunAt(job, now);
    }
    job.updatedAt = now;
    this.store.setScheduledJob(job.id, job);
    this.broadcastListChanged();
  }

  private async launch(job: ScheduledJob, trigger: TriggerType): Promise<ScheduledJobRun> {
    const run: ScheduledJobRun = {
      id: uuidv4(),
      scheduledJobId: job.id,
      sessionId: null,
      sessionName: null,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'created',
      triggerType: trigger,
      createdSessionUrl: null,
    };
    this.store.setScheduledJobRun(run.id, run);
    this.deps.broadcast(SseEvent.SchedulerRunCreated, run);

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
    this.store.setScheduledJobRun(run.id, run);
    this.deps.broadcast(SseEvent.SchedulerRunUpdated, run);
    this.updateJobLastStatus(job.id, 'session_started');

    // Send the prompt once the CLI is ready (async; does not block the caller).
    this.sendPromptWhenReady(session.id, prompt, job, run);
    return run;
  }

  private async resolvePrompt(job: ScheduledJob): Promise<string> {
    if (job.promptMode === 'prompt_file_path') {
      if (!job.promptFilePath) throw new Error('prompt file path is empty');
      return readFile(job.promptFilePath, 'utf-8');
    }
    return job.promptText ?? '';
  }

  private sendPromptWhenReady(sessionId: string, prompt: string, job: ScheduledJob, run: ScheduledJobRun): void {
    setImmediate(() => {
      const poll = async (): Promise<void> => {
        if (job.agentType !== 'shell') {
          for (let attempt = 0; attempt < SCHEDULER_READY_MAX_ATTEMPTS; attempt++) {
            await delay(500);
            const s = this.deps.sessions.get(sessionId);
            if (!s) return; // session was removed
            const buf = s.getTerminalBuffer().slice(-2048);
            if (buf.includes('❯') || buf.includes('tokens')) break;
          }
          await delay(SCHEDULER_READY_SETTLE_MS);
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
          this.store.setScheduledJobRun(run.id, run);
          this.deps.broadcast(SseEvent.SchedulerRunUpdated, run);
          this.updateJobLastStatus(job.id, 'prompt_sent');
        } catch (err) {
          this.failRun(job, run, `Failed to send prompt: ${getErrorMessage(err)}`);
        }
      };
      poll().catch((err) => console.error('[scheduler] sendPromptWhenReady error:', getErrorMessage(err)));
    });
  }

  private failRun(job: ScheduledJob, run: ScheduledJobRun, message: string): ScheduledJobRun {
    run.status = 'failed';
    run.errorMessage = message;
    run.finishedAt = Date.now();
    this.store.setScheduledJobRun(run.id, run);
    this.deps.broadcast(SseEvent.SchedulerRunUpdated, run);
    this.updateJobLastStatus(job.id, 'failed');
    return run;
  }

  private updateJobLastStatus(jobId: string, status: ScheduledJobRunStatus): void {
    const fresh = this.store.getScheduledJob(jobId);
    if (!fresh) return;
    const now = Date.now();
    fresh.lastStatus = status;
    fresh.lastRunAt = now;
    fresh.updatedAt = now;
    this.store.setScheduledJob(fresh.id, fresh);
    this.broadcastListChanged();
  }

  private broadcastListChanged(): void {
    this.deps.broadcast(SseEvent.SchedulerJobsChanged, { jobs: this.listJobs() });
  }
}
