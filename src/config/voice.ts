/**
 * @fileoverview Bounds and endpoint config for Claude voice dictation.
 *
 * Backs the browser → Codeman → Anthropic dictation relay (`src/web/voice-stream.ts`,
 * `src/web/routes/voice-routes.ts`; design in `docs/claude-voice-plan.md`).
 *
 * Why everything here is bounded: an open microphone is an open pipe. Each live
 * stream holds a browser socket, an upstream socket and a keepalive timer, and
 * every second of audio is billed against the server owner's Claude subscription.
 * A tab left recording (phone in a pocket, forgotten laptop) must cost a bounded
 * amount, so streams die on their own at `MAX_STREAM_MS` and the server refuses
 * more than `MAX_CONCURRENT_STREAMS` at once.
 *
 * The audio frame cap is a memory guard on a socket that carries attacker-shaped
 * binary data: PCM16 at 16 kHz mono is 32 KB/s, so a 256 ms frame is ~8 KB and
 * anything near 64 KB is either a broken client or an attempt to make the relay
 * buffer for someone else.
 */

/** Upstream speech-to-text service (the one Claude Code's own `/voice` mode uses). */
export const VOICE_STREAM_HOST = 'wss://api.anthropic.com';

/** Path of the streaming speech-to-text endpoint. */
export const VOICE_STREAM_PATH = '/api/ws/speech_to_text/voice_stream';

/**
 * Base override, for tests (point the relay at a local mock) and for users on an
 * Anthropic-compatible gateway. Must be a ws:// or wss:// origin.
 */
export function voiceStreamBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = typeof env.CODEMAN_VOICE_STREAM_BASE === 'string' ? env.CODEMAN_VOICE_STREAM_BASE.trim() : '';
  if (override && /^wss?:\/\//.test(override)) return override.replace(/\/+$/, '');
  return VOICE_STREAM_HOST;
}

/** Upstream drops an idle socket; the CLI pings at 8s and so do we. */
export const KEEPALIVE_INTERVAL_MS = 8000;

/** Hard ceiling on one dictation. Long enough for any real utterance, short enough to bound a forgotten mic. */
export const MAX_STREAM_MS = 5 * 60_000;

/** Concurrent relays server-wide. Dictation is a human-paced, one-at-a-time act. */
export const MAX_CONCURRENT_STREAMS = 4;

/** Largest single audio frame accepted from the browser (~2s of PCM16 @16 kHz mono). */
export const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

/** How long to wait for the final transcript after the client asks to finalize. */
export const FINALIZE_TIMEOUT_MS = 3000;

/** Upstream caps the keyterms header; mirrors the CLI's own limit. */
export const MAX_KEYTERMS_HEADER_CHARS = 1024;

/** Audio format the endpoint is opened with. The browser worklet must match exactly. */
export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_CHANNELS = 1;
