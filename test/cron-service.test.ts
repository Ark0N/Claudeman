/**
 * @fileoverview Tests for CronService — the CRUD/bookkeeping + due-tick
 * state machine of the cron. The pure next-run math lives in
 * cron-time.test.ts; this exercises the service that sits on top of it.
 *
 * Launch attempts are steered down the "workingDir does not exist" failure path
 * so no real Session/tmux objects are constructed — we assert the scheduling
 * state machine (due detection, dedup guard, schedule advance, once-completion,
 * concurrency skip, run-history recording), not the session layer it reuses.
 *
 * Port: N/A (no HTTP server).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CronService, type CronDeps } from '../src/cron/cron-service.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';
import type { CronJobInput } from '../src/cron/cron-input.js';

const MISSING_DIR = '/nonexistent-codeman-cron-test-dir';
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function makeStore() {
  const jobs: Record<string, CronJob> = {};
  const runs: Record<string, CronJobRun> = {};
  return {
    getCronJobs: () => jobs,
    getCronJob: (id: string) => jobs[id] ?? null,
    setCronJob: (id: string, j: CronJob) => {
      jobs[id] = j;
    },
    removeCronJob: (id: string) => {
      delete jobs[id];
    },
    getCronJobRuns: () => runs,
    setCronJobRun: (id: string, r: CronJobRun) => {
      runs[id] = r;
    },
    removeCronJobRun: (id: string) => {
      delete runs[id];
    },
    incrementSessionsCreated: vi.fn(),
  };
}

function makeService(sessions = new Map<string, { mode: string }>()) {
  const store = makeStore();
  const broadcast = vi.fn();
  const deps = {
    store,
    broadcast,
    sessions,
  } as unknown as CronDeps;
  return { service: new CronService(deps), store, broadcast, sessions };
}

function mkInput(overrides: Partial<CronJobInput> = {}): CronJobInput {
  return {
    name: 'job',
    agentType: 'claude',
    workingDir: MISSING_DIR,
    promptMode: 'inline_text',
    promptText: 'hello',
    inputMode: 'typed',
    scheduleType: 'interval',
    intervalMinutes: 10,
    enabled: true,
    concurrencyPolicy: 'warn_only',
    ...overrides,
  };
}

describe('CronService', () => {
  let svc: ReturnType<typeof makeService>;

  beforeEach(() => {
    svc = makeService();
  });

  describe('createJob', () => {
    it('computes nextRunAt for an enabled interval job', () => {
      const before = Date.now();
      const job = svc.service.createJob(mkInput({ intervalMinutes: 10 }));
      expect(job.id).toBeTruthy();
      expect(job.nextRunAt).not.toBeNull();
      expect(job.nextRunAt!).toBeGreaterThanOrEqual(before + 10 * 60_000);
      expect(job.lastRunAt).toBeNull();
      expect(job.lastStatus).toBeNull();
    });

    it('leaves nextRunAt null for a disabled job', () => {
      const job = svc.service.createJob(mkInput({ enabled: false }));
      expect(job.nextRunAt).toBeNull();
    });

    it('uses the absolute runAt for a one-time job', () => {
      const runAt = Date.now() + 3_600_000;
      const job = svc.service.createJob(mkInput({ scheduleType: 'once', runAt, intervalMinutes: undefined }));
      expect(job.nextRunAt).toBe(runAt);
    });
  });

  describe('setEnabled', () => {
    it('clears nextRunAt when disabling and recomputes when re-enabling', () => {
      const job = svc.service.createJob(mkInput());
      const disabled = svc.service.setEnabled(job.id, false);
      expect(disabled!.nextRunAt).toBeNull();
      const reenabled = svc.service.setEnabled(job.id, true);
      expect(reenabled!.nextRunAt).not.toBeNull();
    });

    it('returns null for an unknown id', () => {
      expect(svc.service.setEnabled('nope', true)).toBeNull();
    });
  });

  describe('updateJob', () => {
    it('re-arms the dup-guard and once-completion flags', () => {
      const job = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now() + 1000, intervalMinutes: undefined })
      );
      job.lastDueKey = 'stale';
      job.completedOnce = true;
      svc.store.setCronJob(job.id, job);
      const updated = svc.service.updateJob(job.id, { name: 'renamed' });
      expect(updated!.name).toBe('renamed');
      expect(updated!.lastDueKey).toBeNull();
      expect(updated!.completedOnce).toBe(false);
      expect(updated!.createdAt).toBe(job.createdAt);
    });
  });

  describe('deleteJob', () => {
    it('removes the job and its run history', async () => {
      const job = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.listRuns(job.id).length).toBe(1);
      expect(svc.service.deleteJob(job.id)).toBe(true);
      expect(svc.service.getJob(job.id)).toBeNull();
      expect(svc.service.listRuns(job.id).length).toBe(0);
    });

    it('returns false for an unknown id', () => {
      expect(svc.service.deleteJob('nope')).toBe(false);
    });
  });

  describe('listRuns', () => {
    it('returns runs newest-first and filters by job id', async () => {
      const a = svc.service.createJob(
        mkInput({ name: 'a', scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      const b = svc.service.createJob(
        mkInput({ name: 'b', scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      await svc.service.runNow(a.id);
      await svc.service.runNow(b.id);
      const all = svc.service.listRuns();
      expect(all.length).toBe(2);
      expect(all[0].startedAt).toBeGreaterThanOrEqual(all[1].startedAt);
      expect(svc.service.listRuns(a.id).every((r) => r.cronJobId === a.id)).toBe(true);
    });
  });

  describe('init', () => {
    it('recomputes nextRunAt for enabled jobs missing one, but skips a completed once-job', () => {
      const live = svc.service.createJob(mkInput());
      live.nextRunAt = null;
      svc.store.setCronJob(live.id, live);

      const dead = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now(), intervalMinutes: undefined })
      );
      dead.completedOnce = true;
      dead.nextRunAt = null;
      svc.store.setCronJob(dead.id, dead);

      svc.service.init();
      expect(svc.service.getJob(live.id)!.nextRunAt).not.toBeNull();
      expect(svc.service.getJob(dead.id)!.nextRunAt).toBeNull();
    });
  });

  describe('tickDueJobs', () => {
    it('fires a due one-time job exactly once and disables it', async () => {
      const runAt = Date.now() - 5000;
      const job = svc.service.createJob(mkInput({ scheduleType: 'once', runAt, intervalMinutes: undefined }));

      await svc.service.tickDueJobs(Date.now());
      await flush();

      const after = svc.service.getJob(job.id)!;
      expect(after.completedOnce).toBe(true);
      expect(after.enabled).toBe(false);
      expect(after.nextRunAt).toBeNull();
      const runs = svc.service.listRuns(job.id);
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe('failed'); // workingDir missing → fails before session launch

      // A second tick must not re-fire it.
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.listRuns(job.id).length).toBe(1);
    });

    it('advances an interval job to a future nextRunAt after firing', async () => {
      const job = svc.service.createJob(mkInput({ intervalMinutes: 10 }));
      const fireAt = job.nextRunAt! + 1000;

      await svc.service.tickDueJobs(fireAt);
      await flush();

      const after = svc.service.getJob(job.id)!;
      expect(after.enabled).toBe(true);
      expect(after.nextRunAt!).toBeGreaterThan(fireAt);
      expect(after.lastDueKey).not.toBeNull();
      expect(svc.service.listRuns(job.id).length).toBe(1);
    });

    it('does not fire a job whose nextRunAt is still in the future', async () => {
      const job = svc.service.createJob(mkInput({ intervalMinutes: 60 }));
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.listRuns(job.id).length).toBe(0);
    });

    it('skips an automatic run when concurrency policy is skip_if_same_agent_running', async () => {
      const sessions = new Map<string, { mode: string }>([['s1', { mode: 'claude' }]]);
      const local = makeService(sessions);
      const job = local.service.createJob(
        mkInput({ agentType: 'claude', concurrencyPolicy: 'skip_if_same_agent_running', intervalMinutes: 10 })
      );
      const fireAt = job.nextRunAt! + 1000;

      await local.service.tickDueJobs(fireAt);
      await flush();

      // No run recorded, but the schedule still advanced past the skipped slot.
      expect(local.service.listRuns(job.id).length).toBe(0);
      const after = local.service.getJob(job.id)!;
      expect(after.nextRunAt!).toBeGreaterThan(fireAt);
      expect(after.lastDueKey).not.toBeNull();
    });
  });

  describe('runNow', () => {
    it('launches regardless of enabled/schedule state', async () => {
      const job = svc.service.createJob(mkInput({ enabled: false }));
      const run = await svc.service.runNow(job.id);
      expect(run).not.toBeNull();
      expect(run!.triggerType).toBe('manual_run_now');
      // Disabled job stays disabled; a manual run doesn't arm the schedule.
      expect(svc.service.getJob(job.id)!.enabled).toBe(false);
    });

    it('returns null for an unknown id', async () => {
      expect(await svc.service.runNow('nope')).toBeNull();
    });
  });
});
