/**
 * @fileoverview Scheduled Jobs routes (cron-style scheduler).
 *
 * CRUD + enable/disable + Run Now + run history for `ScheduledJob`s. These are
 * separate from the legacy `/api/scheduled` (ScheduledRun) endpoints — see
 * SCHEDULER_DISCOVERY.md §0.
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { ScheduledJobSchema, ScheduledJobUpdateSchema, ScheduledJobEnabledSchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import type { SchedulerPort } from '../ports/index.js';

export function registerSchedulerRoutes(app: FastifyInstance, ctx: SchedulerPort): void {
  // ── Jobs ────────────────────────────────────────────────────────────────

  app.get('/api/scheduler/jobs', async () => {
    return ctx.scheduler.listJobs();
  });

  app.post('/api/scheduler/jobs', async (req) => {
    const body = parseBody(ScheduledJobSchema, req.body, 'Invalid scheduled job');
    return { job: ctx.scheduler.createJob(body) };
  });

  app.get('/api/scheduler/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.scheduler.getJob(id);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled job not found');
    return job;
  });

  app.put('/api/scheduler/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ScheduledJobUpdateSchema, req.body, 'Invalid scheduled job update');
    const job = ctx.scheduler.updateJob(id, body);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled job not found');
    return { job };
  });

  app.delete('/api/scheduler/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.scheduler.deleteJob(id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled job not found');
    }
    return {};
  });

  app.put('/api/scheduler/jobs/:id/enabled', async (req) => {
    const { id } = req.params as { id: string };
    const { enabled } = parseBody(ScheduledJobEnabledSchema, req.body, 'Invalid request body');
    const job = ctx.scheduler.setEnabled(id, enabled);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled job not found');
    return { job };
  });

  // ── Run Now ──────────────────────────────────────────────────────────────

  app.post('/api/scheduler/jobs/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.scheduler.getJob(id);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled job not found');
    const run = await ctx.scheduler.runNow(id);
    return { run, activeAgents: ctx.scheduler.countActiveAgents(job.agentType) };
  });

  // ── Run history ──────────────────────────────────────────────────────────

  app.get('/api/scheduler/jobs/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.scheduler.listRuns(id);
  });

  app.get('/api/scheduler/runs', async () => {
    return ctx.scheduler.listRuns();
  });
}
