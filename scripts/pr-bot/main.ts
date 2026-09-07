#!/usr/bin/env -S npx tsx
/**
 * @fileoverview CLI entry for the PR bot.
 *
 *   npx tsx scripts/pr-bot/main.ts run                 # the daemon (what the service runs)
 *   npx tsx scripts/pr-bot/main.ts check               # config, gh, Codeman, Telegram, git
 *   npx tsx scripts/pr-bot/main.ts scan                # list open PRs and what would be queued
 *   npx tsx scripts/pr-bot/main.ts review N [--no-telegram]   # one review, now
 *   npx tsx scripts/pr-bot/main.ts status              # what the state file knows
 *   npx tsx scripts/pr-bot/main.ts notify N            # resend PR N's review message to Telegram
 *   npx tsx scripts/pr-bot/main.ts install-service     # systemd user unit, enabled + started
 *   npx tsx scripts/pr-bot/main.ts uninstall-service
 *
 * User guide: docs/pr-bot.md
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PrBot, type TelegramLike } from './bot.js';
import { CodemanClient } from './codeman-client.js';
import { configFilePath, loadConfig, type PrBotConfig } from './config.js';
import { ghAuthOk, listOpenPrs } from './github.js';
import { orderBacklog } from './report.js';
import { StateStore } from './state.js';
import { TelegramClient } from './telegram.js';

const SERVICE_NAME = 'codeman-pr-bot';

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

/** Prints what the bot would have sent; used by `review --no-telegram`. */
class ConsoleTelegram implements TelegramLike {
  private nextId = 1;
  isOurChat(): boolean {
    return true;
  }
  async sendMessage(text: string): Promise<number> {
    console.log(`\n--- telegram (html) ---\n${text}\n---`);
    return this.nextId++;
  }
  async sendPlain(text: string): Promise<number> {
    console.log(`\n--- telegram (plain) ---\n${text}\n---`);
    return this.nextId++;
  }
  async editReplyMarkup(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async answerCallback(): Promise<void> {}
  async sendDocument(filename: string, content: string): Promise<void> {
    console.log(`\n--- telegram document ${filename} (${content.length} chars) ---`);
  }
  async getUpdates(): Promise<[]> {
    return [];
  }
  async setMyCommands(): Promise<void> {}
}

function makeCodeman(cfg: PrBotConfig): CodemanClient {
  return new CodemanClient({ apiUrl: cfg.codemanApiUrl, username: cfg.codemanUsername, password: cfg.codemanPassword });
}

export function logFilePath(cfg: PrBotConfig): string {
  return join(cfg.dataDir, 'bot.log');
}

function unitFile(cfg: PrBotConfig): string {
  const tsx = join(cfg.mainCheckout, 'node_modules', '.bin', 'tsx');
  // A user service gets a minimal PATH, which is where `gh` (and an nvm/Homebrew
  // node) are not: the first run failed its scan with `spawn gh ENOENT`. Bake the
  // installing shell's PATH in, as `codeman service install` does.
  const seen = new Set<string>();
  const path = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin')
    .split(':')
    .filter((p) => p && !p.endsWith('/node_modules/.bin') && !seen.has(p) && seen.add(p))
    .join(':');
  return `[Unit]
Description=Codeman PR review bot (Telegram)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${cfg.mainCheckout}
ExecStart=${tsx} scripts/pr-bot/main.ts run
Restart=always
RestartSec=15
Environment=HOME=${homedir()}
Environment=NODE_ENV=production
Environment=PATH=${path}
# A file rather than the journal: on some boxes \`journalctl --user\` cannot read
# the user journal at all, and a review bot whose logs cannot be found is not
# debuggable from a phone.
StandardOutput=append:${logFilePath(cfg)}
StandardError=append:${logFilePath(cfg)}
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=default.target
`;
}

async function cmdCheck(): Promise<void> {
  const cfg = loadConfig();
  console.log(
    `config file: ${configFilePath()}${existsSync(configFilePath()) ? '' : ' (absent, defaults + shared Telegram env)'}`
  );
  console.log(`repo: ${cfg.githubRepo}`);
  console.log(`codeman: ${cfg.codemanApiUrl}`);
  console.log(`main checkout: ${cfg.mainCheckout}`);
  console.log(`data dir: ${cfg.dataDir}`);
  console.log(`model: ${cfg.model ?? '(session default)'}, effort: ${cfg.effort ?? '(default)'}`);
  console.log(
    `poll: every ${cfg.pollIntervalMs / 60_000} min; review timeout ${cfg.reviewTimeoutMs / 60_000} min; auto-review ${cfg.autoReview}`
  );
  let ok = true;
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      console.log(`✔ ${name}: ${await fn()}`);
    } catch (err) {
      ok = false;
      console.log(`✘ ${name}: ${(err as Error).message}`);
    }
  };
  await step('gh auth', async () =>
    (await ghAuthOk()) ? 'logged in' : Promise.reject(new Error('run `gh auth login`'))
  );
  await step('git', async () =>
    execFileSync('git', ['-C', cfg.mainCheckout, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()
  );
  await step('codeman', async () => {
    const s = await makeCodeman(cfg).status();
    return `up (version ${s.version ?? 'unknown'})`;
  });
  await step('telegram', async () => {
    const me = await new TelegramClient(cfg.telegramBotToken, cfg.telegramChatId).getMe();
    return `@${me.username ?? '?'} for chat ${cfg.telegramChatId}`;
  });
  await step('open PRs', async () => `${(await listOpenPrs(cfg.githubRepo)).length}`);
  if (!ok) process.exit(1);
}

async function cmdScan(): Promise<void> {
  const cfg = loadConfig();
  const store = new StateStore(join(cfg.dataDir, 'state.json'));
  const open = await listOpenPrs(cfg.githubRepo);
  const rows = orderBacklog(open).map((pr) => {
    const rec = store.pr(pr.number);
    const state =
      rec?.reviewedSha === pr.headSha ? `reviewed (${rec?.verdict ?? '?'})` : rec?.reviewedSha ? 'updated' : 'new';
    const flags = [pr.isDraft ? 'draft' : '', pr.mergeable === 'CONFLICTING' ? 'conflicts' : '']
      .filter(Boolean)
      .join(', ');
    return `#${pr.number}\t${state}\t+${pr.additions}/-${pr.deletions}\t${pr.author}\t${pr.title}${flags ? `  [${flags}]` : ''}`;
  });
  console.log(`${open.length} open PRs in review order:\n${rows.join('\n')}`);
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const store = new StateStore(join(cfg.dataDir, 'state.json'));
  console.log(`paused: ${store.state.paused}; telegram offset: ${store.state.telegramOffset}`);
  for (const rec of Object.values(store.state.prs).sort((a, b) => b.number - a.number)) {
    console.log(
      `#${rec.number}\t${rec.status}\t${rec.verdict ?? '-'}\t${rec.reviewedSha?.slice(0, 8) ?? '-'}\t${rec.author}\t${rec.title}${
        rec.lastError ? `\n\t${rec.lastError.split('\n')[0]}` : ''
      }`
    );
  }
}

async function cmdReview(args: string[]): Promise<void> {
  const number = parseInt(args.find((a) => /^\d+$/.test(a)) ?? '', 10);
  if (!Number.isFinite(number)) throw new Error('usage: review <pr-number> [--no-telegram]');
  const cfg = loadConfig();
  const telegram = args.includes('--no-telegram')
    ? new ConsoleTelegram()
    : new TelegramClient(cfg.telegramBotToken, cfg.telegramChatId);
  const bot = new PrBot(cfg, { telegram, codeman: makeCodeman(cfg), log });
  const rec = await bot.reviewPr(number);
  console.log(
    `\n#${number}: ${rec.status}${rec.verdict ? ` (${rec.verdict})` : ''}${rec.lastError ? `\n${rec.lastError}` : ''}`
  );
  if (rec.reportMdPath) console.log(`report: ${rec.reportMdPath}`);
  process.exit(rec.status === 'reviewed' ? 0 : 1);
}

async function cmdNotify(args: string[]): Promise<void> {
  const number = parseInt(args[0] ?? '', 10);
  if (!Number.isFinite(number)) throw new Error('usage: notify <pr-number>');
  const cfg = loadConfig();
  const bot = new PrBot(cfg, {
    telegram: new TelegramClient(cfg.telegramBotToken, cfg.telegramChatId),
    codeman: makeCodeman(cfg),
    log,
  });
  const rec = bot.store.pr(number);
  if (!rec?.report) throw new Error(`no review of #${number} in ${cfg.dataDir}`);
  await bot.sendSummary(rec);
  console.log(`sent the review message for #${number}`);
}

async function cmdRun(): Promise<void> {
  const cfg = loadConfig();
  const bot = new PrBot(cfg, {
    telegram: new TelegramClient(cfg.telegramBotToken, cfg.telegramChatId),
    codeman: makeCodeman(cfg),
    log,
  });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    bot
      .stop()
      .catch((err) => log(`stop: ${(err as Error).message}`))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  log(`starting: repo ${cfg.githubRepo}, codeman ${cfg.codemanApiUrl}, data ${cfg.dataDir}`);
  await bot.start();
}

function cmdInstallService(): void {
  const cfg = loadConfig();
  const dir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SERVICE_NAME}.service`);
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(path, unitFile(cfg));
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'inherit' });
  // `restart` rather than `enable --now`: a re-install must pick up the new unit.
  execFileSync('systemctl', ['--user', 'restart', SERVICE_NAME], { stdio: 'inherit' });
  console.log(`installed ${path}\nlogs: tail -f ${logFilePath(cfg)}`);
}

function cmdUninstallService(): void {
  const path = join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  execFileSync('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], { stdio: 'inherit' });
  if (existsSync(path)) execFileSync('rm', ['-f', path]);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  console.log(`removed ${SERVICE_NAME}`);
}

async function main(): Promise<void> {
  const [cmd = 'run', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'run':
      return cmdRun();
    case 'check':
      return cmdCheck();
    case 'scan':
      return cmdScan();
    case 'status':
      return cmdStatus();
    case 'review':
      return cmdReview(rest);
    case 'notify':
      return cmdNotify(rest);
    case 'install-service':
      return cmdInstallService();
    case 'uninstall-service':
      return cmdUninstallService();
    default:
      console.error(
        'usage: main.ts run | check | scan | status | review <N> [--no-telegram] | install-service | uninstall-service'
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  process.exit(1);
});
