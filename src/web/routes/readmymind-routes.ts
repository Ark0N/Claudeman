/**
 * @fileoverview Read My Mind intent routes.
 *
 * Per-case intent profiles feeding the Read My Mind predictor
 * (docs/readmymind-plan.md):
 * - `GET    /api/sessions/:id/intent`: the profile for the session's case
 * - `PUT    /api/sessions/:id/intent`: replace the goals text
 * - `DELETE /api/sessions/:id/intent`: forget the case's profile
 *
 * The profile is keyed by owner + workingDir, so multi-user scoping is
 * structural; session ownership is still enforced via `findSessionOrFail`
 * (with `req`, so a foreign session id 404s) to keep the session-routes
 * no-existence-leak policy.
 *
 * Deliberately session-scoped rather than a raw `/api/intents/:key` surface:
 * the session resolves owner + workingDir server-side, so a caller can never
 * address another case's profile by guessing keys.
 *
 * Registrations use the bare `app.<method>('path', ...)` + `req.params as`
 * shape (session-routes style): these endpoints are documented in the agent
 * skill, and the endpoints.md drift test's scanner does not see registrations
 * with a generic between the method and the path.
 */

import { FastifyInstance } from 'fastify';
import { IntentGoalsSchema } from '../schemas.js';
import { parseBody, findSessionOrFail } from '../route-helpers.js';
import { intentStore } from '../../intent-store.js';
import type { SessionPort } from '../ports/index.js';

export function registerReadMyMindRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get('/api/sessions/:id/intent', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    return { success: true, data: { intent: intentStore.getProfile(session.owner, session.workingDir) } };
  });

  app.put('/api/sessions/:id/intent', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(IntentGoalsSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);
    return { success: true, data: { intent: intentStore.setGoals(session.owner, session.workingDir, body.goals) } };
  });

  app.delete('/api/sessions/:id/intent', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    return { success: true, data: { deleted: intentStore.deleteProfile(session.owner, session.workingDir) } };
  });
}
