/**
 * Claude Code credential parsing.
 *
 * The voice relay authenticates with the token this parser returns, so every
 * degraded store (absent, truncated, hand-edited, expired) must resolve to a
 * status the caller can act on rather than a throw or a silently empty token.
 */
import { describe, it, expect } from 'vitest';
import { parseClaudeCredentials, claudeCredentialsPath } from '../src/claude-credentials.js';

const NOW = 1_800_000_000_000;

function store(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-test',
      refreshToken: 'sk-ant-ort01-test',
      expiresAt: NOW + 3_600_000,
      subscriptionType: 'max',
      ...overrides,
    },
  });
}

describe('parseClaudeCredentials', () => {
  it('returns the token and display metadata for a live store', () => {
    const result = parseClaudeCredentials(store(), NOW);
    expect(result.status).toBe('ok');
    expect(result.accessToken).toBe('sk-ant-oat01-test');
    expect(result.subscriptionType).toBe('max');
    expect(result.expiresAt).toBe(NOW + 3_600_000);
  });

  it('reports an elapsed token as expired and withholds it', () => {
    const result = parseClaudeCredentials(store({ expiresAt: NOW - 1000 }), NOW);
    expect(result.status).toBe('expired');
    expect(result.accessToken).toBeUndefined();
  });

  it('treats a token expiring within the skew as already expired', () => {
    // A token with 30s left would die mid-dictation; refusing up front turns a
    // confusing mid-utterance disconnect into a clear "refresh your login".
    expect(parseClaudeCredentials(store({ expiresAt: NOW + 30_000 }), NOW).status).toBe('expired');
  });

  it('accepts a store with no expiry at all', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } });
    expect(parseClaudeCredentials(raw, NOW).status).toBe('ok');
  });

  it.each([
    ['not json at all', 'malformed'],
    ['{}', 'malformed'],
    ['null', 'malformed'],
    ['[]', 'malformed'],
    ['{"claudeAiOauth":null}', 'malformed'],
    ['{"claudeAiOauth":{}}', 'malformed'],
    ['{"claudeAiOauth":{"accessToken":""}}', 'malformed'],
    ['{"claudeAiOauth":{"accessToken":"   "}}', 'malformed'],
    ['{"claudeAiOauth":{"accessToken":123}}', 'malformed'],
  ])('reports %s as malformed instead of throwing', (raw, expected) => {
    expect(parseClaudeCredentials(raw, NOW).status).toBe(expected);
  });

  it('trims whitespace around a token written by hand', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: '  sk-ant-oat01-test\n' } });
    expect(parseClaudeCredentials(raw, NOW).accessToken).toBe('sk-ant-oat01-test');
  });
});

describe('claudeCredentialsPath', () => {
  it('honors CLAUDE_CONFIG_DIR like the CLI does', () => {
    expect(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: '/tmp/alt-claude' })).toBe('/tmp/alt-claude/.credentials.json');
  });

  it('falls back to ~/.claude when the override is blank', () => {
    expect(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: '  ' })).toMatch(/\.claude\/\.credentials\.json$/);
  });

  it('falls back to ~/.claude when unset', () => {
    expect(claudeCredentialsPath({})).toMatch(/\.claude\/\.credentials\.json$/);
  });
});
