/**
 * Voice stream request building.
 *
 * The audio format lives in the query string, so a drift between these params
 * and the browser worklet does not fail loudly — it transcribes as noise. These
 * tests pin the contract, and pin that the bearer token never leaks into a URL
 * (which would land it in proxy logs).
 */
import { describe, it, expect } from 'vitest';
import {
  buildVoiceStreamHeaders,
  buildVoiceStreamUrl,
  normalizeVoiceLanguage,
  sanitizeKeyterms,
} from '../src/web/voice-stream.js';
import { MAX_KEYTERMS_HEADER_CHARS } from '../src/config/voice.js';

describe('buildVoiceStreamUrl', () => {
  it('pins linear16 / 16 kHz / mono, matching the browser worklet', () => {
    const url = new URL(buildVoiceStreamUrl({}, {}));
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.anthropic.com');
    expect(url.pathname).toBe('/api/ws/speech_to_text/voice_stream');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('channels')).toBe('1');
    expect(url.searchParams.get('stt_provider')).toBe('deepgram-nova3');
  });

  it('carries the language hint', () => {
    expect(new URL(buildVoiceStreamUrl({ language: 'de' }, {})).searchParams.get('language')).toBe('de');
  });

  it('accepts a ws:// or wss:// base override for tests and gateways', () => {
    const url = buildVoiceStreamUrl({}, { CODEMAN_VOICE_STREAM_BASE: 'ws://127.0.0.1:3199/' });
    expect(url.startsWith('ws://127.0.0.1:3199/api/ws/speech_to_text/voice_stream?')).toBe(true);
  });

  it('ignores a non-websocket override rather than building a broken URL', () => {
    expect(buildVoiceStreamUrl({}, { CODEMAN_VOICE_STREAM_BASE: 'https://evil.example' })).toContain(
      'wss://api.anthropic.com'
    );
  });

  it('never puts credentials in the URL', () => {
    expect(buildVoiceStreamUrl({ language: 'en' }, {})).not.toMatch(/token|Bearer|sk-ant/i);
  });
});

describe('normalizeVoiceLanguage', () => {
  it.each([
    ['en', 'en'],
    ['en-US', 'en-US'],
    ['multi', 'multi'],
    ['', 'en'],
    [undefined, 'en'],
    ['not a language', 'en'],
    ['../../etc/passwd', 'en'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeVoiceLanguage(input as string | undefined)).toBe(expected);
  });
});

describe('sanitizeKeyterms', () => {
  it('joins terms with commas', () => {
    expect(sanitizeKeyterms(['tmux', 'respawn'])).toBe('tmux,respawn');
  });

  it('replaces an inner comma with a space so one term cannot become two', () => {
    expect(sanitizeKeyterms(['hello, world'])).toBe('hello world');
  });

  it('drops non-ASCII, which is not portable in a header value', () => {
    expect(sanitizeKeyterms(['café', 'naïve'])).toBe('caf,nave');
  });

  it('strips CR/LF so a term cannot inject a header', () => {
    const result = sanitizeKeyterms(['ok\r\nX-Evil: 1']);
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
    expect(result).toBe('okX-Evil: 1');
  });

  it('dedupes and skips empties', () => {
    expect(sanitizeKeyterms(['a', 'a', '', '   ', 'b'])).toBe('a,b');
  });

  it('truncates on a term boundary rather than mangling the last term', () => {
    const terms = Array.from({ length: 500 }, (_, i) => `term${i}`);
    const result = sanitizeKeyterms(terms);
    expect(result.length).toBeLessThanOrEqual(MAX_KEYTERMS_HEADER_CHARS);
    for (const term of result.split(',')) expect(term).toMatch(/^term\d+$/);
  });
});

describe('buildVoiceStreamHeaders', () => {
  it('sends the bearer token and identifies Codeman honestly', () => {
    const headers = buildVoiceStreamHeaders('sk-ant-oat01-test', '1.2.3');
    expect(headers.Authorization).toBe('Bearer sk-ant-oat01-test');
    expect(headers['User-Agent']).toBe('codeman/1.2.3 (voice-bridge)');
    expect(headers['x-app']).toBe('codeman');
  });

  it('omits the keyterms header when nothing survives sanitizing', () => {
    expect(buildVoiceStreamHeaders('t', '1.0.0', ['', '  '])).not.toHaveProperty('x-config-keyterms');
  });

  it('includes sanitized keyterms when present', () => {
    expect(buildVoiceStreamHeaders('t', '1.0.0', ['tmux', 'respawn'])['x-config-keyterms']).toBe('tmux,respawn');
  });
});
