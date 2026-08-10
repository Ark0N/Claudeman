/**
 * @fileoverview Read-only access to the Claude Code OAuth credentials.
 *
 * Claude Code stores its subscription OAuth tokens in
 * `$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude/.credentials.json`,
 * mode 0600) on Linux/Windows, and in the login keychain on macOS. Codeman reads
 * the access token to authenticate the voice-dictation relay
 * (`src/web/voice-stream.ts`) against the same speech-to-text service the CLI's
 * own `/voice` mode uses.
 *
 * ⚠️ READ-ONLY, deliberately. Codeman never writes this file and never performs
 * an OAuth refresh: a refresh ROTATES the refresh token, so racing Claude Code's
 * own refresh could invalidate the user's CLI login. An expired access token is
 * reported as `expired` and the caller tells the user to run a Claude session
 * (which refreshes it) instead.
 *
 * ⚠️ The token is a bearer secret: it is never logged, never persisted, never
 * included in any API response, and never sent to the browser.
 */

import { readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { homedir, userInfo } from 'os';
import { join } from 'path';

/** Result of inspecting the credential store. The token is present only on 'ok'. */
export type ClaudeCredentialStatus = 'ok' | 'expired' | 'missing' | 'malformed';

export interface ClaudeOAuthCredentials {
  status: ClaudeCredentialStatus;
  /** Bearer token. Present only when status is 'ok'. Never log or serialize this. */
  accessToken?: string;
  /** Epoch ms the access token expires at, when the store reports one. */
  expiresAt?: number;
  /** e.g. 'max', 'pro'. Display-only, safe to surface. */
  subscriptionType?: string;
}

/** Skew applied to the stored expiry so a token that dies mid-stream is refused up front. */
const EXPIRY_SKEW_MS = 60_000;

/** macOS keychain service holding the same JSON blob as `.credentials.json`. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Keychain lookups shell out; keep them short so a locked keychain cannot hang a request. */
const KEYCHAIN_TIMEOUT_MS = 3000;

/**
 * Parse a `.credentials.json` payload. Pure: no IO, no clock read (pass `now`),
 * so the expiry and shape handling are unit-testable.
 *
 * Returns 'malformed' for anything that is not the expected `claudeAiOauth`
 * shape rather than throwing — a hand-edited or half-written file must degrade
 * to "voice unavailable", never to a 500.
 */
export function parseClaudeCredentials(raw: string, now: number): ClaudeOAuthCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'malformed' };
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'malformed' };

  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return { status: 'malformed' };

  const record = oauth as Record<string, unknown>;
  const accessToken = typeof record.accessToken === 'string' ? record.accessToken.trim() : '';
  if (!accessToken) return { status: 'malformed' };

  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : undefined;
  const subscriptionType = typeof record.subscriptionType === 'string' ? record.subscriptionType : undefined;

  // An expired token is a real state (the CLI refreshes on its next run), not a
  // malformed store: report it separately so the UI can say something useful.
  if (expiresAt !== undefined && expiresAt - EXPIRY_SKEW_MS <= now) {
    return { status: 'expired', expiresAt, subscriptionType };
  }
  return { status: 'ok', accessToken, expiresAt, subscriptionType };
}

/** Path of the credentials file, honoring CLAUDE_CONFIG_DIR like the CLI does. */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim();
  return join(configDir || join(homedir(), '.claude'), '.credentials.json');
}

/** Read the macOS keychain entry. Resolves to null on any failure (locked, absent, non-mac). */
function readKeychainCredentials(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-a', userInfo().username, '-w', '-s', KEYCHAIN_SERVICE],
      { encoding: 'utf-8', timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout.trim() || null)
    );
  });
}

/**
 * Locate and parse the Claude Code OAuth credentials.
 *
 * File first (present on every platform once the CLI has run there), keychain
 * second on macOS. Never caches: Claude Code rewrites the store roughly every
 * 8 hours, and a cached token would go stale inside a long-lived server.
 */
export async function readClaudeOAuthCredentials(now: number = Date.now()): Promise<ClaudeOAuthCredentials> {
  let fileResult: ClaudeOAuthCredentials | null = null;
  try {
    fileResult = parseClaudeCredentials(await readFile(claudeCredentialsPath(), 'utf-8'), now);
  } catch {
    fileResult = null;
  }
  if (fileResult && fileResult.status !== 'malformed') return fileResult;

  if (process.platform === 'darwin') {
    const raw = await readKeychainCredentials();
    if (raw) {
      const keychainResult = parseClaudeCredentials(raw, now);
      if (keychainResult.status !== 'malformed') return keychainResult;
    }
  }

  return fileResult ?? { status: 'missing' };
}
