/**
 * @fileoverview Cron Jobs routes.
 *
 * CRUD + enable/disable + Run Now + run history for `CronJob`s. These are
 * separate from the legacy `/api/scheduled` (ScheduledRun) endpoints — see
 * docs/cron-discovery.md §0.
 */

import { FastifyInstance } from 'fastify';
import { getCli } from '../../config/cli-registry/registry.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { CronJobSchema, CronJobUpdateSchema, CronJobEnabledSchema } from '../schemas.js';
import { canAccessOwned, getAuthUser, isWorkingDirAllowed, ownerFor, parseBody } from '../route-helpers.js';
import { canUsernameRunPrivilegedCommands } from '../../user-store.js';
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
    // Section 6.2: confine the job's workingDir to the owner's case space (mirrors
    // POST /api/sessions). No-op allow-all for admins/single-user. workingDir is
    // required by CronJobSchema so it is always present here.
    if (!isWorkingDirAllowed(getAuthUser(req), body.workingDir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is outside your workspace');
    }
    // Section 6.3: shell mode / a launchCommand is arbitrary host-account execution.
    // Resolve the owner's grant from the store (AuthUser.role alone can't tell a GRANTED
    // regular user from a plain one); mirrors session-routes + the cron fire-time re-check.
    if (
      (getCli(body.agentType)?.capabilities.privilegedCommandGate || body.launchCommand) &&
      !(await canUsernameRunPrivilegedCommands(ownerFor(req)))
    ) {
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
    // Section 6.2: the update body is partial, so only confine when workingDir is set.
    if (body.workingDir !== undefined && !isWorkingDirAllowed(getAuthUser(req), body.workingDir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is outside your workspace');
    }
    if (
      (getCli(body.agentType ?? 'claude')?.capabilities.privilegedCommandGate || body.launchCommand) &&
      !(await canUsernameRunPrivilegedCommands(ownerFor(req)))
    ) {
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
    // Owner-gate like every other :id handler so a foreign job's run history (session
    // ids, names, deep links) isn't leaked; NOT_FOUND avoids disclosing existence.
    if (!canTouch(req, ctx.cron.getJob(id))) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return ctx.cron.listRuns(id);
  });

  app.get('/api/cron/runs', async (req) => {
    const runs = ctx.cron.listRuns();
    if (!isMultiUserMode()) return runs;
    const user = getAuthUser(req);
    if (user.role === 'admin') return runs;
    // Non-admin: keep only runs whose owning job the caller can access (drops runs
    // whose job is absent from the map — defensive; deleteJob already cascades).
    const ownerByJobId = new Map<string, string | undefined>(
      ctx.cron.listJobs().map((j): [string, string | undefined] => [j.id, j.owner])
    );
    return runs.filter((run) => canAccessOwned(user, ownerByJobId.get(run.cronJobId)));
  });
}
