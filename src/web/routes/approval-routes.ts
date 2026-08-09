/**
 * @fileoverview Approvals Inbox routes.
 *
 * The cross-session queue of prompts waiting on a human (see
 * web/approval-inbox.ts, docs/approvals-inbox-plan.md):
 * - `GET  /api/approvals` — pending items, ownership-scoped in multi-user mode
 * - `POST /api/approvals/:id/answer` — answer in place by sending the
 *   corresponding keystrokes to the session (digit / Esc / idle-prompt text)
 * - `POST /api/approvals/:id/dismiss` — drop the item without keystrokes
 *
 * Normal authed API surface (NOT the localhost hook-secret bypass). Answering
 * is take-then-write: the item is removed BEFORE keystrokes go out so a
 * double-tap (or the service worker retrying a push action) cannot
 * double-send; a failed write restores the item.
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { ApprovalAnswerSchema } from '../schemas.js';
import { parseBody, getAuthUser, canAccessOwned, findSessionOrFail } from '../route-helpers.js';
import { approvalInbox, type ApprovalItem } from '../approval-inbox.js';
import { hooksAvailableForMode } from '../session-wait-registry.js';
import type { SessionPort } from '../ports/index.js';

/**
 * Keystrokes for an answer, or an error string. Menu answers are a single digit
 * or Esc — dialogs react to the keypress itself, so no Enter is ever sent for
 * them. Free text is allowed only for idle prompts (there IS no dialog; the
 * text lands in the composer and `\r` submits it, per the CLAUDE.md input
 * discipline). `option` digits must match a PARSED option so a blind digit can
 * never be routed at a dialog we could not read.
 */
function keystrokesFor(
  item: ApprovalItem,
  answer: { action: 'approve' | 'deny' | 'option' | 'text'; option?: number; text?: string }
): { keys: string } | { error: string } {
  switch (answer.action) {
    case 'approve':
      if (item.kind === 'idle') return { error: 'Idle prompts take a text answer, not approve/deny' };
      return { keys: '1' };
    case 'deny':
      if (item.kind === 'idle') return { error: 'Idle prompts take a text answer, not approve/deny' };
      return { keys: '\x1b' };
    case 'option': {
      if (item.kind === 'idle') return { error: 'Idle prompts take a text answer, not an option digit' };
      if (answer.option === undefined) return { error: 'action "option" requires the option field' };
      if (!item.options?.some((o) => o.n === answer.option)) {
        return { error: `Option ${answer.option} is not among the parsed dialog options` };
      }
      return { keys: String(answer.option) };
    }
    case 'text': {
      if (item.kind !== 'idle') return { error: 'Text answers are only valid for idle prompts' };
      const text = (answer.text ?? '').replace(/[\r\n]+/g, ' ').trim();
      if (!text) return { error: 'action "text" requires non-empty text' };
      return { keys: `${text}\r` };
    }
  }
}

export function registerApprovalRoutes(app: FastifyInstance, ctx: SessionPort): void {
  // List pending approvals. Items whose session is gone resolve lazily; items
  // whose session the caller cannot access are filtered (never 403-leaked),
  // matching the session-list scoping policy.
  app.get('/api/approvals', async (req) => {
    const user = getAuthUser(req);
    const approvals = approvalInbox.listPending().filter((item) => {
      const session = ctx.sessions.get(item.sessionId);
      if (!session) {
        approvalInbox.resolveForSession(item.sessionId, 'session_ended');
        return false;
      }
      return canAccessOwned(user, session.owner);
    });
    return { success: true, data: { approvals } };
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/answer', async (req) => {
    const answer = parseBody(ApprovalAnswerSchema, req.body);
    const item = approvalInbox.getById(req.params.id);
    if (!item) {
      // Covers unknown, already-answered, superseded and expired ids alike.
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Approval not found or no longer pending');
    }
    // Throws 404 (not 403) for sessions the caller does not own — same
    // no-existence-leak rule as every other session route.
    const session = findSessionOrFail(ctx, item.sessionId, req);
    if (!hooksAvailableForMode(session.mode)) {
      return createErrorResponse(ApiErrorCode.CONFLICT, 'Session mode cannot have pending approvals');
    }

    // Re-capture the pane before aiming keystrokes at it: if the dialog was
    // answered in the terminal moments ago, the digit would land in whatever
    // now has focus. Conclusive only for items whose frame parsed options.
    if (!approvalInbox.verifyStillAnswerable(item.id)) {
      return createErrorResponse(ApiErrorCode.CONFLICT, 'The dialog is no longer on screen');
    }

    const resolved = keystrokesFor(item, answer);
    if ('error' in resolved) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, resolved.error);
    }

    const taken = approvalInbox.take(item.id);
    if (!taken) {
      return createErrorResponse(ApiErrorCode.CONFLICT, 'Approval was resolved by another actor');
    }
    const written = await session.writeViaMux(resolved.keys);
    if (!written) {
      approvalInbox.restore(taken);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Session is not accepting input');
    }
    return { success: true, data: { id: item.id, sessionId: item.sessionId, action: answer.action } };
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/dismiss', async (req) => {
    const item = approvalInbox.getById(req.params.id);
    if (!item) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Approval not found or no longer pending');
    }
    findSessionOrFail(ctx, item.sessionId, req);
    approvalInbox.dismiss(item.id);
    return { success: true, data: { id: item.id } };
  });
}
