/**
 * @fileoverview Clipboard routes.
 * Accepts text via POST and broadcasts to connected browsers for clipboard write.
 */

import { FastifyInstance } from 'fastify';
import { SseEvent } from '../sse-events.js';
import type { EventPort, SessionPort } from '../ports/index.js';
import { getAuthUser, canAccessOwned } from '../route-helpers.js';
import { createErrorResponse, ApiErrorCode } from '../../types.js';

export function registerClipboardRoutes(app: FastifyInstance, ctx: EventPort & SessionPort): void {
  app.post('/api/clipboard', async (req) => {
    const body = req.body as { text?: string; sessionId?: string };
    const text = body?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing or empty "text" field');
    }
    // Multi-user: a supplied sessionId must belong to the caller — never let a
    // client target another user's session (no-op in single-user).
    if (body.sessionId && !canAccessOwned(getAuthUser(req), ctx.sessions.get(body.sessionId)?.owner)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Cannot target another user session');
    }
    ctx.broadcast(SseEvent.ClipboardWrite, {
      text,
      sessionId: body.sessionId ?? null,
      // Stamp the trusted caller identity so deriveSseHint routes this write to the
      // caller's own tabs only (multi-user). Undefined in single-user → JSON drops
      // the field and delivery stays global to that one user's browsers.
      callerUsername: req.authUser?.username,
      timestamp: Date.now(),
    });
    return {};
  });
}
