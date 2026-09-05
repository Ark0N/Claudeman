/**
 * @fileoverview PR bot configuration.
 *
 * Read from `~/.codeman/pr-bot.env` (KEY=VALUE lines, mode 0600, the same shape as
 * the data dir's `.env`) with the process environment layered on top, then validated
 * into a typed config. `parseEnvFile` and `buildConfig` are pure so the validation
 * rules are unit-testable without touching the filesystem.
 *
 * Nothing here reads Codeman's own settings: the bot is maintainer tooling that
 * drives a running Codeman over HTTP, it is not part of the server.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface PrBotConfig {
  /** Telegram bot token from BotFather. */
  telegramBotToken: string;
  /** The ONE chat the bot talks to and accepts commands from. Everything else is ignored. */
  telegramChatId: string;
  /** `owner/name` of the repository whose PRs are reviewed. */
  githubRepo: string;
  /** Codeman server the review sessions are spawned on. */
  codemanApiUrl: string;
  codemanUsername?: string;
  codemanPassword?: string;
  /** How often open PRs are listed. */
  pollIntervalMs: number;
  /** The maintainer's checkout; worktrees are added from its git dir. Never checked out by the bot. */
  mainCheckout: string;
  /** State, reports and worktrees live under here. */
  dataDir: string;
  worktreesDir: string;
  /** Optional model / effort for the review sessions (Codeman `modelOverride` / `effort`). */
  model?: string;
  effort?: string;
  /** Hard ceiling for one review turn. */
  reviewTimeoutMs: number;
  /** Hard ceiling for one follow-up turn. */
  followupTimeoutMs: number;
  /** When false, PRs are only reviewed on an explicit `/review N`. */
  autoReview: boolean;
  /** Draft PRs are skipped unless this is on. */
  reviewDrafts: boolean;
}

export const CONFIG_FILE_NAME = 'pr-bot.env';

/**
 * The maintainer's existing Telegram notifier bot (a separate, send-only process)
 * keeps its token and chat id here. The PR bot shares that bot identity by default,
 * so it reads those two keys from the same file rather than making anyone copy a
 * secret around. Override with `PR_BOT_TELEGRAM_ENV_FILE`.
 */
export const DEFAULT_TELEGRAM_ENV_FILE = join('codeman-cases', 'telegram', '.env');
const SHARED_TELEGRAM_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const;

/** The keys the env file understands, for `check` and the docs. */
export const CONFIG_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'GITHUB_REPO',
  'CODEMAN_API_URL',
  'CODEMAN_USERNAME',
  'CODEMAN_PASSWORD',
  'PR_BOT_POLL_INTERVAL',
  'PR_BOT_MAIN_CHECKOUT',
  'PR_BOT_DATA_DIR',
  'PR_BOT_MODEL',
  'PR_BOT_EFFORT',
  'PR_BOT_REVIEW_TIMEOUT',
  'PR_BOT_FOLLOWUP_TIMEOUT',
  'PR_BOT_AUTO_REVIEW',
  'PR_BOT_REVIEW_DRAFTS',
  'PR_BOT_TELEGRAM_ENV_FILE',
] as const;

/** Parse `KEY=VALUE` lines. Comments, blanks, `export ` prefixes and matching quotes are handled. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
    }
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function intFrom(raw: string | undefined, fallback: number, min: number): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, n);
}

function flagFrom(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** Build the typed config from an env map. Throws with every missing key named at once. */
export function buildConfig(
  env: Record<string, string | undefined>,
  defaults: { home: string; repoRoot: string }
): PrBotConfig {
  const missing: string[] = [];
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim() ?? '';
  if (!telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!telegramChatId) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) throw new Error(`pr-bot config is missing: ${missing.join(', ')}`);

  const githubRepo = env.GITHUB_REPO?.trim() || 'Ark0N/Codeman';
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) throw new Error(`GITHUB_REPO must be owner/name, got "${githubRepo}"`);

  const codemanApiUrl = (env.CODEMAN_API_URL?.trim() || 'https://127.0.0.1:3000').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(codemanApiUrl))
    throw new Error(`CODEMAN_API_URL must be http(s)://..., got "${codemanApiUrl}"`);

  const dataDir = resolve(env.PR_BOT_DATA_DIR?.trim() || join(defaults.home, '.codeman', 'pr-bot'));
  const mainCheckout = resolve(env.PR_BOT_MAIN_CHECKOUT?.trim() || defaults.repoRoot);

  return {
    telegramBotToken,
    telegramChatId,
    githubRepo,
    codemanApiUrl,
    codemanUsername: env.CODEMAN_USERNAME?.trim() || undefined,
    codemanPassword: env.CODEMAN_PASSWORD || undefined,
    pollIntervalMs: intFrom(env.PR_BOT_POLL_INTERVAL, 600, 60) * 1000,
    mainCheckout,
    dataDir,
    worktreesDir: join(dataDir, 'worktrees'),
    model: env.PR_BOT_MODEL?.trim() || undefined,
    effort: env.PR_BOT_EFFORT?.trim() || undefined,
    reviewTimeoutMs: intFrom(env.PR_BOT_REVIEW_TIMEOUT, 40, 5) * 60_000,
    followupTimeoutMs: intFrom(env.PR_BOT_FOLLOWUP_TIMEOUT, 20, 2) * 60_000,
    autoReview: flagFrom(env.PR_BOT_AUTO_REVIEW, true),
    reviewDrafts: flagFrom(env.PR_BOT_REVIEW_DRAFTS, false),
  };
}

/** The repository this script lives in (scripts/pr-bot/ -> repo root). */
export function scriptRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function configFilePath(): string {
  return join(process.env.CODEMAN_DATA_DIR || join(homedir(), '.codeman'), CONFIG_FILE_NAME);
}

export function telegramEnvFilePath(fromFile: Record<string, string>): string {
  return resolve(
    process.env.PR_BOT_TELEGRAM_ENV_FILE ||
      fromFile.PR_BOT_TELEGRAM_ENV_FILE ||
      join(homedir(), DEFAULT_TELEGRAM_ENV_FILE)
  );
}

/**
 * Layers, lowest first: the shared Telegram notifier's `.env` (token + chat id only),
 * then `~/.codeman/pr-bot.env`, then the process environment, so a one-off
 * `PR_BOT_MODEL=... npx tsx ...` wins over everything.
 */
export function loadConfig(): PrBotConfig {
  const file = configFilePath();
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  const sharedFile = telegramEnvFilePath(fromFile);
  const shared = existsSync(sharedFile) ? parseEnvFile(readFileSync(sharedFile, 'utf8')) : {};
  const merged: Record<string, string | undefined> = {};
  for (const key of SHARED_TELEGRAM_KEYS) if (shared[key]) merged[key] = shared[key];
  Object.assign(merged, fromFile);
  for (const key of CONFIG_KEYS) {
    const v = process.env[key];
    if (v !== undefined && v !== '') merged[key] = v;
  }
  try {
    return buildConfig(merged, { home: homedir(), repoRoot: scriptRepoRoot() });
  } catch (err) {
    throw new Error(`${(err as Error).message} (config file: ${file}; shared Telegram env: ${sharedFile})`);
  }
}
