/**
 * @fileoverview Mux (tmux) session management routes.
 * Provides mux session listing, killing, reconciliation, and stats control.
 */

import { FastifyInstance } from 'fastify';
import type { InfraPort } from '../ports/index.js';
import { STATS_COLLECTION_INTERVAL_MS } from '../../config/server-timing.js';
import { requireAdmin } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';

export function registerMuxRoutes(app: FastifyInstance, ctx: InfraPort): void {
  app.get('/api/mux-sessions', async (req, reply) => {
    // Multi-user: this recovery/debug surface exposes every user's tmux + workdirs → admin-only
    // (requireAdmin is a no-op allow-all in single-user mode, so flag-off is unchanged).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const sessions = await ctx.mux.getSessionsWithStats();
    return {
      sessions,
      muxAvailable: ctx.mux.isAvailable(),
    };
  });

  app.delete('/api/mux-sessions/:sessionId', async (req, reply) => {
    // Multi-user: killing any tmux session by name is a cross-user destructive action → admin-only.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { sessionId } = req.params as { sessionId: string };
    const success = await ctx.mux.killSession(sessionId);
    return { killed: success };
  });

  app.post('/api/mux-sessions/reconcile', async (req, reply) => {
    // Multi-user: process-wide reconcile → admin-only.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const result = await ctx.mux.reconcileSessions();
    return result;
  });

  app.post('/api/mux-sessions/stats/start', async (req, reply) => {
    // Multi-user: process-wide stats collection toggle → admin-only.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
    return {};
  });

  app.post('/api/mux-sessions/stats/stop', async (req, reply) => {
    // Multi-user: process-wide stats collection toggle → admin-only.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    ctx.mux.stopStatsCollection();
    return {};
  });
}
