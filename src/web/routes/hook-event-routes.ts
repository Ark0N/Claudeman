/**
 * @fileoverview Hook event route.
 * Receives Claude Code hook events and broadcasts to SSE clients.
 * This endpoint bypasses auth (Claude Code hooks curl from localhost).
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { HookEventSchema, isValidWorkingDir } from '../schemas.js';
import { sanitizeHookData, parseBody } from '../route-helpers.js';
import { persistDockerCaseClaudeSessionId } from '../../docker-hosts.js';
import { getDataDir } from '../../config/instance.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';

export function registerHookEventRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort
): void {
  app.post('/api/hook-event', async (req) => {
    const { event, sessionId, data } = parseBody(HookEventSchema, req.body);
    if (!ctx.sessions.has(sessionId)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // Signal the respawn controller based on hook event type
    const controller = ctx.respawnControllers.get(sessionId);
    if (controller) {
      if (event === 'elicitation_dialog') {
        // Block auto-accept for question prompts
        controller.signalElicitation();
      } else if (event === 'stop') {
        // DEFINITIVE idle signal - Claude finished responding
        controller.signalStopHook();
      } else if (event === 'idle_prompt') {
        // DEFINITIVE idle signal - Claude has been idle for 60+ seconds
        controller.signalIdlePrompt();
      }
    }

    // Start transcript watching if transcript_path is provided and safe
    if (data && 'transcript_path' in data) {
      const transcriptPath = String(data.transcript_path);
      if (transcriptPath && isValidWorkingDir(transcriptPath)) {
        ctx.startTranscriptWatcher(sessionId, transcriptPath);
      }
    }

    // Sync Claude's current conversation id. Interactive PTY mode never emits
    // `session_id` on stdout, so hooks are the only reliable way to learn that
    // the user ran `/clear` (which spins up a new conversation jsonl).
    if (data && typeof data.session_id === 'string' && data.session_id) {
      const session = ctx.sessions.get(sessionId);
      const prevClaudeSessionId = session?.claudeSessionId;
      session?.adoptClaudeSessionId(data.session_id);
      // Docker sessions: keep the case's resume seed following the LIVE
      // conversation (post-/clear id switches), so a container stop/reboot
      // relaunch resumes the right transcript.
      if (session?.docker && session.claudeSessionId && session.claudeSessionId !== prevClaudeSessionId) {
        void persistDockerCaseClaudeSessionId(
          getDataDir(),
          session.docker.containerName,
          session.claudeSessionId
        ).catch(() => {});
      }
    }

    // Sanitize forwarded data: only include known safe fields, limit size
    const safeData = sanitizeHookData(data);
    ctx.broadcast(`hook:${event}`, { sessionId, timestamp: Date.now(), ...safeData });

    // Send push notifications for hook events
    const session = ctx.sessions.get(sessionId);
    const sessionName = session?.name ?? sessionId.slice(0, 8);
    ctx.sendPushNotifications(`hook:${event}`, { sessionId, sessionName, ...safeData });

    // Track in run summary
    const summaryTracker = ctx.runSummaryTrackers.get(sessionId);
    if (summaryTracker) {
      summaryTracker.recordHookEvent(event, safeData);
    }

    return {};
  });
}
