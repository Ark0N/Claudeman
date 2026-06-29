/**
 * Unit tests for the cron's pure next-run-time calculations.
 * Timezone-independent: daily/weekly expectations are asserted via local
 * Date getters rather than hardcoded epoch values.
 */

import { describe, it, expect } from 'vitest';
import { parseHHMM, computeNextRunAt, dueKeyFor } from '../src/cron/cron-time.js';
import type { CronJob } from '../src/types/cron.js';

function baseJob(partial: Partial<CronJob>): CronJob {
  return {
    id: 'j1',
    name: 'test',
    agentType: 'claude',
    workingDir: '/tmp',
    promptMode: 'inline_text',
    promptText: 'hi',
    inputMode: 'typed',
    scheduleType: 'once',
    enabled: true,
    concurrencyPolicy: 'warn_only',
    createdAt: 0,
    updatedAt: 0,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    lastDueKey: null,
    ...partial,
  };
}

describe('parseHHMM', () => {
  it('parses valid 24h times', () => {
    expect(parseHHMM('09:30')).toEqual({ hours: 9, minutes: 30 });
    expect(parseHHMM('23:59')).toEqual({ hours: 23, minutes: 59 });
    expect(parseHHMM('0:00')).toEqual({ hours: 0, minutes: 0 });
  });
  it('rejects invalid times', () => {
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('12:60')).toBeNull();
    expect(parseHHMM('9:5')).toBeNull(); // minutes must be 2 digits
    expect(parseHHMM('abc')).toBeNull();
    expect(parseHHMM(undefined)).toBeNull();
  });
});

describe('computeNextRunAt — once', () => {
  it('returns runAt even when already in the past (missed one-time job still fires)', () => {
    const job = baseJob({ scheduleType: 'once', runAt: 1000 });
    expect(computeNextRunAt(job, 500)).toBe(1000);
    expect(computeNextRunAt(job, 5000)).toBe(1000);
  });
  it('returns null once completed', () => {
    const job = baseJob({ scheduleType: 'once', runAt: 1000, completedOnce: true });
    expect(computeNextRunAt(job, 500)).toBeNull();
  });
  it('returns null with no runAt', () => {
    expect(computeNextRunAt(baseJob({ scheduleType: 'once' }), 0)).toBeNull();
  });
});

describe('computeNextRunAt — interval', () => {
  it('adds intervalMinutes to the after time', () => {
    const job = baseJob({ scheduleType: 'interval', intervalMinutes: 60 });
    expect(computeNextRunAt(job, 1000)).toBe(1000 + 60 * 60_000);
  });
  it('returns null with no/invalid interval', () => {
    expect(computeNextRunAt(baseJob({ scheduleType: 'interval' }), 0)).toBeNull();
    expect(computeNextRunAt(baseJob({ scheduleType: 'interval', intervalMinutes: 0 }), 0)).toBeNull();
  });
});

describe('computeNextRunAt — daily', () => {
  it('schedules today when the time is still ahead', () => {
    const after = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const next = computeNextRunAt(baseJob({ scheduleType: 'daily', dailyTime: '14:30' }), after)!;
    const d = new Date(next);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
    expect(d.getDate()).toBe(1);
    expect(next).toBeGreaterThan(after);
  });
  it('rolls to tomorrow when the time has passed', () => {
    const after = new Date(2026, 0, 1, 16, 0, 0).getTime();
    const next = computeNextRunAt(baseJob({ scheduleType: 'daily', dailyTime: '14:30' }), after)!;
    const d = new Date(next);
    expect(d.getHours()).toBe(14);
    expect(d.getDate()).toBe(2);
    expect(next).toBeGreaterThan(after);
  });
  it('returns null with no time', () => {
    expect(computeNextRunAt(baseJob({ scheduleType: 'daily' }), 0)).toBeNull();
  });
});

describe('computeNextRunAt — weekly', () => {
  it('finds the next selected weekday at the configured time', () => {
    const after = new Date(2026, 0, 1, 12, 0, 0).getTime();
    const targetDay = (new Date(after).getDay() + 2) % 7;
    const job = baseJob({ scheduleType: 'weekly', weeklyDays: [targetDay], weeklyTime: '08:00' });
    const next = computeNextRunAt(job, after)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(targetDay);
    expect(d.getHours()).toBe(8);
    expect(next).toBeGreaterThan(after);
    // Within the coming week.
    expect(next - after).toBeLessThanOrEqual(7 * 24 * 60 * 60_000);
  });
  it('picks the soonest of multiple selected days', () => {
    const after = new Date(2026, 0, 1, 12, 0, 0).getTime();
    const soon = (new Date(after).getDay() + 1) % 7;
    const later = (new Date(after).getDay() + 3) % 7;
    const job = baseJob({ scheduleType: 'weekly', weeklyDays: [later, soon], weeklyTime: '09:00' });
    const next = computeNextRunAt(job, after)!;
    expect(new Date(next).getDay()).toBe(soon);
  });
  it('returns null with no days or no time', () => {
    expect(computeNextRunAt(baseJob({ scheduleType: 'weekly', weeklyTime: '09:00' }), 0)).toBeNull();
    expect(computeNextRunAt(baseJob({ scheduleType: 'weekly', weeklyDays: [1] }), 0)).toBeNull();
  });
});

describe('dueKeyFor', () => {
  it('combines job id and fire time', () => {
    expect(dueKeyFor('j1', 123)).toBe('j1:123');
  });
});
