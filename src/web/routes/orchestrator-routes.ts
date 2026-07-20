/**
 * @fileoverview Orchestrator loop routes — plan-based autonomous execution.
 *
 * Endpoints:
 * - POST   /api/orchestrator/start       — Start orchestration with a goal
 * - POST   /api/orchestrator/approve      — Approve generated plan
 * - POST   /api/orchestrator/reject       — Reject plan with feedback
 * - POST   /api/orchestrator/pause        — Pause execution
 * - POST   /api/orchestrator/resume       — Resume from pause
 * - POST   /api/orchestrator/stop         — Stop and clean up
 * - GET    /api/orchestrator/status       — Get current status
 * - GET    /api/orchestrator/plan         — Get current plan
 * - POST   /api/orchestrator/phase/:id/skip  — Skip a phase
 * - POST   /api/orchestrator/phase/:id/retry — Retry a failed phase
 *
 * @module web/routes/orchestrator-routes
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { OrchestratorStartSchema, OrchestratorRejectSchema } from '../schemas.js';
import { parseBody, requireAdmin } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { SseEvent } from '../sse-events.js';
import type { EventPort, OrchestratorPort } from '../ports/index.js';

export function registerOrchestratorRoutes(app: FastifyInstance, ctx: OrchestratorPort & EventPort): void {
  // ═══════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════

  function getLoop() {
    const loop = ctx.orchestratorLoop;
    if (!loop) {
      throw Object.assign(new Error('Orchestrator not initialized'), {
        statusCode: 503,
        body: createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'Orchestrator not initialized'),
      });
    }
    return loop;
  }

  const EVENT_MAP: [string, (typeof SseEvent)[keyof typeof SseEvent], string[]][] = [
    ['stateChanged', SseEvent.OrchestratorStateChanged, ['state', 'prevState']],
    ['planProgress', SseEvent.OrchestratorPlanProgress, ['phase', 'detail']],
    ['planReady', SseEvent.OrchestratorPlanReady, ['plan']],
    ['phaseStarted', SseEvent.OrchestratorPhaseStarted, ['phase']],
    ['phaseCompleted', SseEvent.OrchestratorPhaseCompleted, ['phase']],
    ['phaseFailed', SseEvent.OrchestratorPhaseFailed, ['phase', 'reason']],
    ['taskAssigned', SseEvent.OrchestratorTaskAssigned, ['task', 'sessionId']],
    ['taskCompleted', SseEvent.OrchestratorTaskCompleted, ['task']],
    ['taskFailed', SseEvent.OrchestratorTaskFailed, ['task', 'error']],
    ['completed', SseEvent.OrchestratorCompleted, ['stats']],
  ];

  let forwardingLoop: import('../../orchestrator-loop.js').OrchestratorLoop | null = null;
  function setupEventForwarding(loop: import('../../orchestrator-loop.js').OrchestratorLoop) {
    if (forwardingLoop === loop) return; // Already attached to this loop instance
    forwardingLoop = loop;
    for (const [event, sseEvent, argNames] of EVENT_MAP) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loop.on(event, (...args: any[]) => {
        const payload: Record<string, unknown> = {};
        argNames.forEach((name, i) => {
          payload[name] = args[i];
        });
        ctx.broadcast(sseEvent, payload);
      });
    }
    // Special cases with non-trivial payload transforms
    loop.on('verificationResult', (phase, result) => {
      ctx.broadcast(SseEvent.OrchestratorVerification, { phaseId: phase.id, result });
    });
    loop.on('error', (error) => {
      ctx.broadcast(SseEvent.OrchestratorError, { error: error.message });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Start
  // ═══════════════════════════════════════════════════════════════

  app.post('/api/orchestrator/start', async (req, reply) => {
    // Multi-user: the orchestrator is a process-wide singleton with no per-user
    // isolation → admin-only (requireAdmin is a no-op allow-all in single-user mode).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { goal, config } = parseBody(OrchestratorStartSchema, req.body, 'Invalid request body');

    // Initialize loop if needed
    let loop = ctx.orchestratorLoop;
    if (!loop) {
      loop = ctx.initOrchestratorLoop();
      setupEventForwarding(loop);
    }

    // Check if already running
    if (loop.isRunning()) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Orchestrator is already running');
    }

    try {
      // Start is async — kicks off planning
      loop.start(goal).catch((err) => {
        console.error('[Orchestrator Route] Start failed:', getErrorMessage(err));
      });

      return {
        ok: true,
        state: loop.state,
        message: 'Orchestrator started — generating plan',
        config: config ?? null,
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Approve / Reject Plan
  // ═══════════════════════════════════════════════════════════════

  app.post('/api/orchestrator/approve', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = getLoop();

    try {
      loop.approve().catch((err) => {
        console.error('[Orchestrator Route] Approve failed:', getErrorMessage(err));
      });
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post('/api/orchestrator/reject', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = getLoop();

    const { feedback } = parseBody(OrchestratorRejectSchema, req.body, 'Feedback is required');

    try {
      loop.reject(feedback).catch((err) => {
        console.error('[Orchestrator Route] Reject failed:', getErrorMessage(err));
      });
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Pause / Resume / Stop
  // ═══════════════════════════════════════════════════════════════

  app.post('/api/orchestrator/pause', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = getLoop();

    try {
      loop.pause();
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post('/api/orchestrator/resume', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = getLoop();

    try {
      loop.resume().catch((err) => {
        console.error('[Orchestrator Route] Resume failed:', getErrorMessage(err));
      });
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post('/api/orchestrator/stop', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = getLoop();

    try {
      await loop.stop();
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Status / Plan
  // ═══════════════════════════════════════════════════════════════

  app.get('/api/orchestrator/status', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = ctx.orchestratorLoop;
    if (!loop) {
      return { ok: true, state: 'idle', plan: null, stats: null };
    }

    return {
      ok: true,
      ...loop.getStatus(),
    };
  });

  app.get('/api/orchestrator/plan', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = ctx.orchestratorLoop;
    if (!loop) {
      return { ok: true, plan: null };
    }

    return {
      ok: true,
      plan: loop.getPlan(),
      currentPhase: loop.getCurrentPhase(),
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase Operations
  // ═══════════════════════════════════════════════════════════════

  app.post('/api/orchestrator/phase/:id/skip', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = getLoop();
    const { id } = req.params as { id: string };

    try {
      await loop.skipPhase(id);
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post('/api/orchestrator/phase/:id/retry', async (req, reply) => {
    // Multi-user: shared-singleton orchestrator → admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const loop = getLoop();
    const { id } = req.params as { id: string };

    try {
      loop.retryPhase(id).catch((err) => {
        console.error('[Orchestrator Route] Retry failed:', getErrorMessage(err));
      });
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });
}
