/**
 * @fileoverview Claude voice dictation routes.
 *
 * - `GET  /api/voice/status`   — can this server transcribe? (settings gate + credential state)
 * - `GET  /ws/voice/stream`    — one dictation: PCM16 audio up, transcripts down
 *
 * Design and the upstream protocol: `docs/claude-voice-plan.md`. The relay itself
 * lives in `../voice-stream.ts`; this file is the auth, gating and lifetime shell
 * around it.
 *
 * ⚠️ `/api/voice/status` reports STATE, never the token: `{ available, reason,
 * subscriptionType?, expiresAt? }`. The Claude OAuth access token stays inside the
 * server process — the browser sends audio and receives text, nothing else.
 *
 * ⚠️ The WebSocket carries the same upgrade guard as `/ws/sessions/:id/terminal`
 * (allowed Host + same-site Origin, on top of the global auth hook that already ran
 * on the handshake). Without it a cross-site page could open a dictation stream on
 * the user's credentials and bill their subscription.
 *
 * ⚠️ The feature is OFF unless `claudeVoiceEnabled` is set: turning it on spends the
 * server owner's Claude subscription on transcription for anyone who can reach the
 * UI, which is a decision for the operator rather than a default.
 */

import { createRequire } from 'module';
import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import { readClaudeOAuthCredentials } from '../../claude-credentials.js';
import { VoiceStreamRelay } from '../voice-stream.js';
import { MAX_AUDIO_FRAME_BYTES, MAX_CONCURRENT_STREAMS } from '../../config/voice.js';
import type { ConfigPort } from '../ports/index.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../../package.json') as { version: string };

/** Why voice is unavailable, in a form the frontend can branch on. */
export type VoiceUnavailableReason = 'disabled' | 'no-credentials' | 'expired' | 'malformed';

export interface VoiceStatus {
  available: boolean;
  reason?: VoiceUnavailableReason;
  /** Display-only ('max', 'pro'); present when the credential store reported one. */
  subscriptionType?: string;
  expiresAt?: number;
}

/**
 * Resolve the server's dictation readiness. Split out and exported so the status
 * endpoint and the WebSocket upgrade cannot drift apart: the socket must never
 * accept a stream the status endpoint calls unavailable.
 */
export async function resolveVoiceStatus(enabled: boolean): Promise<VoiceStatus> {
  if (!enabled) return { available: false, reason: 'disabled' };
  const creds = await readClaudeOAuthCredentials();
  switch (creds.status) {
    case 'ok':
      return { available: true, subscriptionType: creds.subscriptionType, expiresAt: creds.expiresAt };
    case 'expired':
      return { available: false, reason: 'expired', expiresAt: creds.expiresAt };
    case 'malformed':
      return { available: false, reason: 'malformed' };
    default:
      return { available: false, reason: 'no-credentials' };
  }
}

/** Live relays, server-wide. Dictation is human-paced, so the cap is small. */
let activeStreams = 0;

/** Test seam: the cap is process-wide state, so suites must be able to reset it. */
export function _resetVoiceStreamCountForTesting(): void {
  activeStreams = 0;
}

/** Split a comma-separated keyterms query value into terms. */
function parseKeyterms(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 100);
}

export function registerVoiceRoutes(app: FastifyInstance, ctx: ConfigPort, getHostPolicy: () => HostPolicy): void {
  app.get('/api/voice/status', async (_req, reply) => {
    try {
      return { success: true, data: await resolveVoiceStatus(await ctx.getClaudeVoiceEnabled()) };
    } catch {
      reply.code(500);
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'Failed to read voice status');
    }
  });

  app.get<{ Querystring: { language?: string; keyterms?: string } }>(
    '/ws/voice/stream',
    { websocket: true },
    async (socket: WebSocket, req) => {
      // Cross-site upgrade guard first: this socket spends the operator's Claude
      // subscription, so it must be reachable only from Codeman's own origin.
      const policy = getHostPolicy();
      if (!isAllowedRequestHost(req.headers.host, policy) || !isAllowedRequestOrigin(req.headers.origin, policy)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      const status = await resolveVoiceStatus(await ctx.getClaudeVoiceEnabled());
      if (!status.available) {
        socket.close(4004, status.reason ?? 'unavailable');
        return;
      }
      // Re-read rather than trusting resolveVoiceStatus's discarded token: the
      // status helper deliberately never returns it.
      const creds = await readClaudeOAuthCredentials();
      if (creds.status !== 'ok' || !creds.accessToken) {
        socket.close(4004, 'no-credentials');
        return;
      }

      if (activeStreams >= MAX_CONCURRENT_STREAMS) {
        socket.close(4008, 'Too many voice streams');
        return;
      }
      activeStreams++;

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeStreams--;
      };

      const send = (payload: Record<string, unknown>) => {
        if (socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          /* client vanished mid-write */
        }
      };

      const relay = new VoiceStreamRelay({
        accessToken: creds.accessToken,
        appVersion: APP_VERSION,
        language: req.query.language,
        keyterms: parseKeyterms(req.query.keyterms),
        onReady: () => send({ t: 'ready' }),
        onTranscript: (text, final) => send({ t: 'transcript', text, final }),
        onError: (message) => send({ t: 'error', message }),
        onClose: () => {
          release();
          send({ t: 'closed' });
          if (socket.readyState === 1) {
            try {
              socket.close(1000, 'Voice stream ended');
            } catch {
              /* already closing */
            }
          }
        },
      });

      // Handlers are attached synchronously before any further await
      // (@fastify/websocket drops messages that arrive before they exist).
      socket.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          if (raw.length === 0 || raw.length > MAX_AUDIO_FRAME_BYTES) return;
          relay.sendAudio(raw);
          return;
        }
        try {
          const msg = JSON.parse(String(raw)) as { t?: string };
          if (msg.t === 'finalize') relay.finalize();
          else if (msg.t === 'stop') relay.close();
        } catch {
          /* non-JSON control frame — ignore */
        }
      });

      socket.on('close', () => {
        relay.close();
        release();
      });
      socket.on('error', () => {
        relay.close();
        release();
      });

      relay.connect();
    }
  );
}
