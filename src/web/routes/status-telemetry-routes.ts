/**
 * @fileoverview Status-telemetry route.
 *
 * Receives Claude Code statusline payloads POSTed by the Codeman-managed
 * statusLine exporter (see `hooks-config.generateStatusLineCommand`) and
 * broadcasts the parsed plan-usage limits (5-hour + weekly) to SSE clients for
 * the header "Plan Usage Limits" chip. Auth-exempt like `/api/hook-event`
 * (localhost-only; hook-secret-gated while a tunnel runs — see middleware/auth).
 *
 * Returns a compact plain-text status string for the exporter to print as the
 * in-terminal footer (print-through), so injecting our statusLine doesn't leave
 * the terminal footer blank.
 */

import { FastifyInstance } from 'fastify';
import { StatusTelemetrySchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import {
  parseStatusTelemetry,
  parseSessionStatus,
  formatSessionStatusText,
  telemetrySignature,
  type RawStatuslinePayload,
} from '../../usage-telemetry.js';
import { SessionStatusTelemetry } from '../sse-events.js';
import { setLatestPlanUsage } from '../plan-usage-latest.js';
import type { SessionPort, EventPort } from '../ports/index.js';

export function registerStatusTelemetryRoutes(app: FastifyInstance, ctx: SessionPort & EventPort): void {
  // Last broadcast telemetry signature per session — the statusline fires on
  // every assistant message, so we only rebroadcast when the value changes.
  const lastSig = new Map<string, string>();

  app.post('/api/status-telemetry', async (req, reply) => {
    const { sessionId, data } = parseBody(StatusTelemetrySchema, req.body);

    reply.type('text/plain; charset=utf-8');

    // Unknown session — minimal footer, no broadcast.
    if (!ctx.sessions.has(sessionId)) {
      lastSig.delete(sessionId);
      return 'codeman';
    }

    const payload = data as RawStatuslinePayload | undefined;

    // Plan-usage limits (account-wide) → broadcast to the header chip, when
    // present and changed (the statusline fires on every assistant message).
    const telemetry = parseStatusTelemetry(payload);
    if (telemetry) {
      const sig = telemetrySignature(telemetry);
      if (lastSig.get(sessionId) !== sig) {
        lastSig.set(sessionId, sig);
        // Bound the map across long multi-session runs: prune dead sessions.
        if (lastSig.size > 256) {
          for (const id of [...lastSig.keys()]) {
            if (!ctx.sessions.has(id)) lastSig.delete(id);
          }
        }
        const update = { sessionId, ...telemetry };
        const snapshot = setLatestPlanUsage(update); // replayed in the SSE init snapshot for fresh loads
        ctx.broadcast(SessionStatusTelemetry, snapshot);
      }
    }

    // In-terminal statusline footer → CURRENT SESSION status (model / tokens /
    // context %), NOT the plan limits. Available from the first render, even
    // before rate_limits appears.
    return formatSessionStatusText(parseSessionStatus(payload));
  });
}
