/**
 * @fileoverview Pure next-run-time calculations for the scheduler.
 *
 * All functions are pure and take an explicit `after` timestamp (epoch ms) so
 * they are deterministic and unit-testable. Times use the SERVER'S LOCAL
 * timezone for v0.1 (per the build brief) — daily/weekly wall-clock times are
 * interpreted via the host's local time.
 */

import type { ScheduledJob } from '../types/scheduler.js';

/** Parse an 'HH:MM' (24-hour) string into hours/minutes, or null if invalid. */
export function parseHHMM(value: string | undefined): { hours: number; minutes: number } | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/**
 * Returns the epoch-ms timestamp for `hours:minutes` (local time) on the day of
 * `base`, shifted by `dayOffset` days.
 */
function atLocalTime(base: number, hours: number, minutes: number, dayOffset: number): number {
  const d = new Date(base);
  d.setHours(hours, minutes, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d.getTime();
}

/**
 * Compute the next fire time strictly relevant to `after`, or null if the job
 * has no future run (e.g. a completed one-time job, or invalid config).
 *
 * For `once`, returns the absolute `runAt` (even if already in the past, so a
 * missed one-time job still fires once) until it has `completedOnce`.
 */
export function computeNextRunAt(job: ScheduledJob, after: number): number | null {
  switch (job.scheduleType) {
    case 'once': {
      if (job.completedOnce) return null;
      return typeof job.runAt === 'number' ? job.runAt : null;
    }
    case 'interval': {
      const minutes = job.intervalMinutes;
      if (!minutes || minutes <= 0) return null;
      return after + minutes * 60_000;
    }
    case 'daily': {
      const t = parseHHMM(job.dailyTime);
      if (!t) return null;
      let next = atLocalTime(after, t.hours, t.minutes, 0);
      if (next <= after) next = atLocalTime(after, t.hours, t.minutes, 1);
      return next;
    }
    case 'weekly': {
      const t = parseHHMM(job.weeklyTime);
      if (!t) return null;
      const days = (job.weeklyDays ?? []).filter((d) => d >= 0 && d <= 6);
      if (days.length === 0) return null;
      for (let offset = 0; offset <= 7; offset++) {
        const cand = atLocalTime(after, t.hours, t.minutes, offset);
        if (cand > after && days.includes(new Date(cand).getDay())) return cand;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Duplicate-launch guard key: identifies a specific due time for a job. The
 * scheduler records the key it last consumed so an overlapping or restarted
 * loop will not launch the same due time twice.
 */
export function dueKeyFor(jobId: string, fireTime: number): string {
  return `${jobId}:${fireTime}`;
}
