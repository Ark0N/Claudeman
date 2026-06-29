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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    it('clears the dup-guard and preserves createdAt', () => {
      const job = svc.service.createJob(mkInput({ intervalMinutes: 10 }));
      job.lastDueKey = 'stale';
      svc.store.setCronJob(job.id, job);
      const updated = svc.service.updateJob(job.id, { name: 'renamed' });
      expect(updated!.name).toBe('renamed');
      expect(updated!.lastDueKey).toBeNull();
      expect(updated!.createdAt).toBe(job.createdAt);
    });

    it('does NOT re-fire a completed once-job when editing a non-schedule field', async () => {
      const job = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.getJob(job.id)!.completedOnce).toBe(true);

      const updated = svc.service.updateJob(job.id, { name: 'renamed' });
      expect(updated!.name).toBe('renamed');
      // Cosmetic edit must not resurrect a fired one-time job.
      expect(updated!.completedOnce).toBe(true);
      expect(updated!.nextRunAt).toBeNull();
    });

    it('re-arms a completed once-job when the schedule itself is edited', async () => {
      const job = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.getJob(job.id)!.completedOnce).toBe(true);

      const future = Date.now() + 3_600_000;
      const updated = svc.service.updateJob(job.id, { runAt: future, enabled: true });
      expect(updated!.completedOnce).toBe(false);
      expect(updated!.nextRunAt).toBe(future);
    });

    it('rejects a partial update that leaves an inconsistent schedule (no dead enabled job)', () => {
      const job = svc.service.createJob(mkInput({ scheduleType: 'interval', intervalMinutes: 10 }));
      // Switch to 'once' WITHOUT a runAt → would otherwise yield a dead nextRunAt:null.
      expect(() => svc.service.updateJob(job.id, { scheduleType: 'once', intervalMinutes: undefined })).toThrow();
      // The stored job is left untouched.
      const after = svc.service.getJob(job.id)!;
      expect(after.scheduleType).toBe('interval');
      expect(after.nextRunAt).not.toBeNull();
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

      // A 'skipped' run is recorded (so the history isn't silently empty), and
      // the schedule still advanced past the skipped slot.
      const runs = local.service.listRuns(job.id);
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe('skipped');
      const after = local.service.getJob(job.id)!;
      expect(after.lastStatus).toBe('skipped');
      expect(after.nextRunAt!).toBeGreaterThan(fireAt);
      expect(after.lastDueKey).not.toBeNull();
    });
  });

  describe('resolvePrompt path guard', () => {
    it('blocks a prompt_file_path pointing at a sensitive system file', async () => {
      const job = svc.service.createJob(
        mkInput({ promptMode: 'prompt_file_path', promptFilePath: '/etc/passwd', promptText: undefined })
      );
      const run = await svc.service.runNow(job.id);
      expect(run).not.toBeNull();
      expect(run!.status).toBe('failed');
      // Must fail at prompt resolution (blocked), NOT later at the missing workingDir —
      // i.e. the file content must never be read.
      expect(run!.errorMessage).toMatch(/Prompt error/i);
      expect(run!.errorMessage).toMatch(/block/i);
      // No session was created for a blocked job.
      expect(svc.sessions.size).toBe(0);
    });

    it('blocks a prompt_file_path under a default-blocked tree (/root)', async () => {
      const job = svc.service.createJob(
        mkInput({ promptMode: 'prompt_file_path', promptFilePath: '/root/.bashrc', promptText: undefined })
      );
      const run = await svc.service.runNow(job.id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/Prompt error/i);
    });

    it('fails cleanly (no throw) when the prompt file does not exist', async () => {
      const job = svc.service.createJob(
        mkInput({
          promptMode: 'prompt_file_path',
          promptFilePath: '/tmp/codeman-cron-no-such-prompt-file.md',
          promptText: undefined,
        })
      );
      const run = await svc.service.runNow(job.id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/Prompt error/i);
    });

    it('allows an ordinary prompt file outside the blocklist (passes resolution)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'codeman-cron-prompt-'));
      const file = join(dir, 'prompt.md');
      writeFileSync(file, 'do the thing');
      const job = svc.service.createJob(
        mkInput({ promptMode: 'prompt_file_path', promptFilePath: file, promptText: undefined })
      );
      const run = await svc.service.runNow(job.id);
      expect(run!.status).toBe('failed'); // still fails — workingDir (MISSING_DIR) does not exist
      // ...but it got PAST prompt resolution: the failure is the workingDir, not a Prompt error.
      expect(run!.errorMessage).not.toMatch(/Prompt error/i);
      expect(run!.errorMessage).toMatch(/workingDir/i);
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
