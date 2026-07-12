/**
 * @fileoverview Cron Jobs routes.
 *
 * CRUD + enable/disable + Run Now + run history for `CronJob`s. These are
 * separate from the legacy `/api/scheduled` (ScheduledRun) endpoints — see
 * docs/cron-discovery.md §0.
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { CronJobSchema, CronJobUpdateSchema, CronJobEnabledSchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import type { CronPort } from '../ports/index.js';

export function registerCronRoutes(app: FastifyInstance, ctx: CronPort): void {
  // ── Jobs ────────────────────────────────────────────────────────────────

  app.get('/api/cron/jobs', async () => {
    return ctx.cron.listJobs();
  });

  app.post('/api/cron/jobs', async (req) => {
    // No custom errorMessage: surface the schema's field-specific messages
    // (e.g. "runAt is required for a one-time schedule").
    const body = parseBody(CronJobSchema, req.body);
    return { job: ctx.cron.createJob(body) };
  });

  app.get('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.cron.getJob(id);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return job;
  });

  app.put('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(CronJobUpdateSchema, req.body);
    const job = ctx.cron.updateJob(id, body);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return { job };
  });

  app.delete('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.cron.deleteJob(id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    }
    return {};
  });

  app.put('/api/cron/jobs/:id/enabled', async (req) => {
    const { id } = req.params as { id: string };
    const { enabled } = parseBody(CronJobEnabledSchema, req.body, 'Invalid request body');
    const job = ctx.cron.setEnabled(id, enabled);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return { job };
  });

  // ── Run Now ──────────────────────────────────────────────────────────────

  app.post('/api/cron/jobs/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.cron.getJob(id);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    const run = await ctx.cron.runNow(id);
    return { run, activeAgents: ctx.cron.countActiveAgents(job.agentType, job.id) };
  });

  // ── Run history ──────────────────────────────────────────────────────────

  app.get('/api/cron/jobs/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.cron.listRuns(id);
  });

  app.get('/api/cron/runs', async () => {
    return ctx.cron.listRuns();
  });
}
