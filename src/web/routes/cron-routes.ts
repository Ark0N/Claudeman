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
import { canAccessOwned, getAuthUser, ownerFor, parseBody } from '../route-helpers.js';
import { canRunPrivilegedCommands } from '../../user-store.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import type { CronJob } from '../../types/cron.js';
import type { CronPort } from '../ports/index.js';
import type { FastifyRequest } from 'fastify';

export function registerCronRoutes(app: FastifyInstance, ctx: CronPort): void {
  // A job the caller may see/act on (own, or admin/single-user).
  const canTouch = (req: FastifyRequest, job: CronJob | null | undefined): job is CronJob =>
    !!job && canAccessOwned(getAuthUser(req), job.owner);

  // ── Jobs ────────────────────────────────────────────────────────────────

  app.get('/api/cron/jobs', async (req) => {
    const jobs = ctx.cron.listJobs();
    if (!isMultiUserMode()) return jobs;
    const user = getAuthUser(req);
    if (user.role === 'admin') return jobs;
    return (jobs as CronJob[]).filter((j) => canAccessOwned(user, j.owner));
  });

  app.post('/api/cron/jobs', async (req) => {
    // No custom errorMessage: surface the schema's field-specific messages
    // (e.g. "runAt is required for a one-time schedule").
    const body = parseBody(CronJobSchema, req.body);
    // Section 6.3: shell mode / a launchCommand is arbitrary host-account execution.
    if ((body.agentType === 'shell' || body.launchCommand) && !canRunPrivilegedCommands(getAuthUser(req))) {
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        'Shell/launchCommand cron jobs require the can-bypass-permissions grant'
      );
    }
    return { job: ctx.cron.createJob(body, ownerFor(req)) };
  });

  app.get('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.cron.getJob(id);
    if (!canTouch(req, job)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return job;
  });

  app.put('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!canTouch(req, ctx.cron.getJob(id))) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    const body = parseBody(CronJobUpdateSchema, req.body);
    if ((body.agentType === 'shell' || body.launchCommand) && !canRunPrivilegedCommands(getAuthUser(req))) {
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        'Shell/launchCommand cron jobs require the can-bypass-permissions grant'
      );
    }
    const job = ctx.cron.updateJob(id, body);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return { job };
  });

  app.delete('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!canTouch(req, ctx.cron.getJob(id)) || !ctx.cron.deleteJob(id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    }
    return {};
  });

  app.put('/api/cron/jobs/:id/enabled', async (req) => {
    const { id } = req.params as { id: string };
    if (!canTouch(req, ctx.cron.getJob(id))) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    const { enabled } = parseBody(CronJobEnabledSchema, req.body, 'Invalid request body');
    const job = ctx.cron.setEnabled(id, enabled);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return { job };
  });

  // ── Run Now ──────────────────────────────────────────────────────────────

  app.post('/api/cron/jobs/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.cron.getJob(id);
    if (!canTouch(req, job)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
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
