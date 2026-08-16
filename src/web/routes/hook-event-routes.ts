/**
 * @fileoverview Hook event route.
 * Receives Claude Code hook events and broadcasts to SSE clients.
 * This endpoint bypasses auth (Claude Code hooks curl from localhost).
 * Prompt events (permission_prompt / elicitation_dialog / idle_prompt) also
 * open Approvals Inbox items; stop and the elicitation-closed events clear
 * them (see web/approval-inbox.ts and docs/approvals-inbox-plan.md).
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { HookEventSchema, isValidWorkingDir } from '../schemas.js';
import { sanitizeHookData, parseBody } from '../route-helpers.js';
import { persistDockerCaseClaudeSessionId } from '../../docker-hosts.js';
import { getDataDir } from '../../config/instance.js';
import { sessionWaits, hooksAvailableForMode } from '../session-wait-registry.js';
import { approvalInbox, type ApprovalKind } from '../approval-inbox.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';

/** Hook events that open an Approvals Inbox item. */
const APPROVAL_KIND_BY_EVENT: Record<string, ApprovalKind> = {
  permission_prompt: 'permission',
  elicitation_dialog: 'question',
  idle_prompt: 'idle',
};

/** Hook events that close a session's pending item without an inbox answer. */
const APPROVAL_RESOLVING_EVENTS = new Set(['stop', 'elicitation_complete', 'elicitation_response']);

export function registerHookEventRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort
): void {
  app.post('/api/hook-event', async (req) => {
    const { event, sessionId, data } = parseBody(HookEventSchema, req.body);
    if (!ctx.sessions.has(sessionId)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // Wake anything blocked on `GET /api/sessions/:id/wait`. Hooks are the only
    // DEFINITIVE signals Codeman gets (`idle` is inferred from output stabilization
    // and can flap mid-turn), so these two are what an orchestrating agent should
    // wait on.
    //
    // Gated on the session's MODE, matching `resolveWaitSignals` on the read side.
    // Without it the guard is one-sided: a caller cannot ASK for `stop` on a shell or
    // codex session, but this endpoint would happily deliver one for it. Hook events
    // carry no identity beyond a per-instance secret shared by every case, so this is
    // also the cheap half of the forgery surface — a `stop` claimed for a session that
    // could never legitimately emit one is now dropped instead of steering another
    // agent's control flow.
    const waitSession = ctx.sessions.get(sessionId);
    if (waitSession && hooksAvailableForMode(waitSession.mode)) {
      if (event === 'stop') {
        sessionWaits.notifySignal(sessionId, 'stop');
      } else if (event === 'permission_prompt' || event === 'elicitation_dialog') {
        sessionWaits.notifySignal(sessionId, 'blocked');
      }
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
    const session = ctx.sessions.get(sessionId);
    const sessionName = session?.name ?? sessionId.slice(0, 8);

    // Approvals Inbox: prompt events open an item, dialog-closed/stop events
    // clear it. Mode-gated like the wait signals above (hook events carry no
    // identity beyond the shared per-instance secret, so a prompt claimed for a
    // session that can never show one must not create an answerable item).
    let approvalId: string | undefined;
    const approvalKind = APPROVAL_KIND_BY_EVENT[event];
    if (session && hooksAvailableForMode(session.mode)) {
      if (approvalKind) {
        const toolInput =
          safeData.tool_input && typeof safeData.tool_input === 'object'
            ? (safeData.tool_input as Record<string, unknown>)
            : undefined;
        const toolSummary = toolInput
          ? [toolInput.command, toolInput.file_path, toolInput.description].find((v) => typeof v === 'string')
          : undefined;
        const item = approvalInbox.notePrompt({
          sessionId,
          sessionName,
          kind: approvalKind,
          toolName: typeof safeData.tool_name === 'string' ? safeData.tool_name : undefined,
          toolSummary: typeof toolSummary === 'string' ? toolSummary : undefined,
          message: typeof safeData.message === 'string' ? safeData.message : undefined,
          cwd: typeof safeData.cwd === 'string' ? safeData.cwd : undefined,
          // Visible tmux frame first (it IS the dialog); raw byte-buffer tail as
          // the fallback for direct-PTY sessions and the no-op test mux.
          capture: () => {
            const muxName = session.muxName;
            const frame = muxName ? (ctx.mux.capturePaneBuffer?.(muxName) ?? null) : null;
            return frame ?? session.terminalBuffer.slice(-8192) ?? null;
          },
        });
        approvalId = item.id;
      } else if (APPROVAL_RESOLVING_EVENTS.has(event)) {
        approvalInbox.resolveForSession(sessionId, 'resolved_in_terminal');
      }
    }

    ctx.broadcast(`hook:${event}`, {
      sessionId,
      timestamp: Date.now(),
      ...safeData,
      ...(approvalId && { approvalId }),
    });
    // Full state ride-along, same shape as the working/idle handlers: the home
    // screens rank the blocked group on lastActivityAt, and without this a
    // permission prompt raised after page load kept ranking by whatever stamp
    // the browser loaded with. Debounced, so a hook burst costs one broadcast.
    ctx.broadcastSessionStateDebounced(sessionId);

    // Send push notifications for hook events
    ctx.sendPushNotifications(`hook:${event}`, {
      sessionId,
      sessionName,
      ...safeData,
      ...(approvalId && { approvalId }),
    });

    // Track in run summary
    const summaryTracker = ctx.runSummaryTrackers.get(sessionId);
    if (summaryTracker) {
      summaryTracker.recordHookEvent(event, safeData);
    }

    return {};
  });
}
