/**
 * @fileoverview Codeman CLI command definitions
 *
 * Defines all CLI commands and subcommands for managing Claude sessions,
 * tasks, Ralph loops, and the web server.
 *
 * @module cli
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'module';
import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { dataPath } from './config/instance.js';
import { installAgentSkillInto, removeAgentSkillFrom, type AgentSkillApplyResult } from './hooks-config.js';
import { getSessionManager } from './session-manager.js';
import { getTaskQueue } from './task-queue.js';
import { getRalphLoop } from './ralph-loop.js';
import { getStore } from './state-store.js';
import { getErrorMessage } from './types.js';
import { isSupportedAttachmentExtension } from './attachment-registry.js';
import { daemonStatus, startDaemon, stopDaemon, type WebLaunchOptions } from './daemon-control.js';
import { installService, serviceStatus, uninstallService } from './service-installer.js';
import { isLoopbackBindHost, isUnauthenticatedNetworkAcknowledged } from './web/network-auth-policy.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program.name('codeman').description('Claude Code session manager with autonomous Ralph Loop').version(pkg.version);

function makeAttachmentMagicLink(filePath: string): string {
  return `codeman://attach?path=${encodeURIComponent(filePath)}`;
}

function readCodemanEnv(): Record<string, string> {
  const envPath = dataPath('.env');
  try {
    const text = readFileSync(envPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
    return result;
  } catch {
    return {};
  }
}

async function postAttachment(apiUrl: string, sessionId: string, filePath: string): Promise<boolean> {
  const envFile = readCodemanEnv();
  const username = process.env.CODEMAN_USERNAME || envFile.CODEMAN_USERNAME || 'admin';
  const password = process.env.CODEMAN_PASSWORD || envFile.CODEMAN_PASSWORD;
  const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, apiUrl);
  const body = JSON.stringify({ path: filePath });
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300)));
      }
    );
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

program
  .command('attach <path>')
  .description('Show an attachment card for a local file')
  .option('-s, --session <id>', 'Codeman session ID (defaults to CODEMAN_SESSION_ID)')
  .option('--url <url>', 'Codeman API URL (defaults to CODEMAN_API_URL or https://127.0.0.1:3000)')
  .action(async (filePath, options) => {
    const extension = String(filePath).split('.').pop()?.toLowerCase() || '';
    if (!isAbsolute(filePath) || !isSupportedAttachmentExtension(extension)) {
      console.error(chalk.red('✗ attach requires an absolute path to a png, pdf, docx, pptx, md, or txt file'));
      process.exit(1);
    }

    const sessionId = options.session || process.env.CODEMAN_SESSION_ID;
    const apiUrl = options.url || process.env.CODEMAN_API_URL || 'https://127.0.0.1:3000';
    if (sessionId && (await postAttachment(apiUrl, sessionId, filePath))) {
      console.log(chalk.green('✓ Attachment card requested'));
      return;
    }

    console.log(makeAttachmentMagicLink(filePath));
  });

// ============ Skill Commands ============

/** Same registry the server resolves case names through (mirrors `case-routes.ts`). */
const LINKED_CASES_FILE = dataPath('linked-cases.json');

/**
 * Case name to directory, checking `linked-cases.json` FIRST and falling back to the
 * shared single-user cases dir. Mirrors `resolveCasePath()` in `case-routes.ts`, which
 * is what the web UI and `quick-start` use. Without the linked-cases lookup this
 * command rejected every case linked in from outside `~/codeman-cases` with
 * "Case not found", even though the server resolved the same name fine.
 *
 * Sync and tolerant on purpose: a missing or malformed registry means "no linked
 * cases", never a crash.
 */
export function resolveCliCasePath(name: string): string {
  try {
    const linked = JSON.parse(readFileSync(LINKED_CASES_FILE, 'utf-8')) as Record<string, string>;
    const target = linked?.[name];
    if (typeof target === 'string' && target) return target;
  } catch {
    // no registry yet, or unreadable/invalid JSON: fall through to the cases dir
  }
  return join(homedir(), 'codeman-cases', name);
}

/**
 * Resolve where `skill install` / `skill uninstall` operate. Global is
 * `~/.claude/skills/codeman` (Claude Code's user-scope skill dir, read by every new
 * session); `--case <name>` targets `<case>/.claude/skills/codeman`, resolved through
 * `resolveCliCasePath()` above. The web server's automatic per-case injection
 * (`agentSkillEnabled`) covers multi-user spaces; this CLI is a local operator tool
 * and stays single-user.
 *
 * A missing case is REPORTED, not exited on: the exit lives in the wrapper below so
 * this resolution (including the linked-cases lookup, which shipped unguarded) can be
 * unit-tested without `process.exit(1)` taking the test runner down with it.
 */
export function resolveSkillTargetPath(options: {
  case?: string;
}): { target: string; missingCase?: undefined } | { target?: undefined; missingCase: string } {
  if (options.case) {
    const casePath = resolveCliCasePath(options.case);
    if (!existsSync(casePath)) return { missingCase: casePath };
    return { target: join(casePath, '.claude', 'skills', 'codeman') };
  }
  return { target: join(homedir(), '.claude', 'skills', 'codeman') };
}

/** Exit-owning wrapper around `resolveSkillTargetPath()` for the two commands below. */
function resolveSkillTarget(options: { case?: string }): string {
  const resolved = resolveSkillTargetPath(options);
  if (resolved.missingCase !== undefined) {
    console.error(chalk.red(`✗ Case not found: ${resolved.missingCase}`));
    process.exit(1);
  }
  return resolved.target;
}

/** Print an AgentSkillApplyResult for humans; exit non-zero when nothing was done. */
function reportSkillResult(result: AgentSkillApplyResult, target: string): void {
  const messages: Record<AgentSkillApplyResult, { ok: boolean; text: string }> = {
    installed: { ok: true, text: `Agent skill installed: ${target}` },
    refreshed: { ok: true, text: `Agent skill refreshed (was stale): ${target}` },
    unchanged: { ok: true, text: `Agent skill already up to date: ${target}` },
    removed: { ok: true, text: `Agent skill removed: ${target}` },
    absent: { ok: true, text: `Nothing to remove at ${target}` },
    foreign: {
      ok: false,
      text: `${target} exists but is not Codeman-managed (no marker), refusing to touch it. Remove it yourself if you want the packaged skill there.`,
    },
    symlink: {
      ok: false,
      text: `${target} (or its parent) is a symlink, refusing to write through it.`,
    },
  };
  const message = messages[result];
  if (message.ok) {
    console.log(chalk.green(`✓ ${message.text}`));
  } else {
    console.error(chalk.red(`✗ ${message.text}`));
    process.exit(1);
  }
}

const skillCmd = program
  .command('skill')
  .description('Manage the Codeman agent skill (lets an agent inside a session drive the API)');

skillCmd
  .command('install')
  .description('Install the agent skill globally (~/.claude/skills/codeman) or into one case')
  .option('-g, --global', 'Install into ~/.claude/skills/codeman, picked up by every new session (the default)')
  .option('-c, --case <name>', 'Install into <case>/.claude/skills/codeman instead (linked cases resolve too)')
  .action(async (options: { global?: boolean; case?: string }) => {
    try {
      const target = resolveSkillTarget(options);
      reportSkillResult(await installAgentSkillInto(target), target);
    } catch (err) {
      console.error(chalk.red(`✗ Failed to install agent skill: ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

skillCmd
  .command('uninstall')
  .description('Remove a Codeman-managed agent skill copy (never touches a user-authored one)')
  .option('-g, --global', 'Remove from ~/.claude/skills/codeman (the default)')
  .option('-c, --case <name>', 'Remove from <case>/.claude/skills/codeman instead (linked cases resolve too)')
  .action(async (options: { global?: boolean; case?: string }) => {
    try {
      const target = resolveSkillTarget(options);
      reportSkillResult(await removeAgentSkillFrom(target), target);
    } catch (err) {
      console.error(chalk.red(`✗ Failed to remove agent skill: ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

// ============ Session Commands ============

const sessionCmd = program.command('session').alias('s').description('Manage Claude sessions');

sessionCmd
  .command('start')
  .description('Start a new Claude session')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .action(async (options) => {
    try {
      const manager = getSessionManager();
      const session = await manager.createSession(options.dir);
      console.log(chalk.green(`✓ Session started: ${session.id}`));
      console.log(`  Working directory: ${session.workingDir}`);
      console.log(`  PID: ${session.pid}`);
    } catch (err) {
      console.error(chalk.red(`✗ Failed to start session: ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

sessionCmd
  .command('stop <id>')
  .description('Stop a session')
  .action(async (id) => {
    try {
      const manager = getSessionManager();
      await manager.stopSession(id);
      console.log(chalk.green(`✓ Session stopped: ${id}`));
    } catch (err) {
      console.error(chalk.red(`✗ Failed to stop session: ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

sessionCmd
  .command('list')
  .alias('ls')
  .description('List all sessions')
  .action(() => {
    const manager = getSessionManager();
    const sessions = manager.getAllSessions();
    const stored = manager.getStoredSessions();

    if (sessions.length === 0 && Object.keys(stored).length === 0) {
      console.log(chalk.yellow('No sessions found'));
      return;
    }

    console.log(chalk.bold('\nActive Sessions:'));
    if (sessions.length === 0) {
      console.log('  (none)');
    } else {
      for (const session of sessions) {
        const status =
          session.status === 'idle'
            ? chalk.green('idle')
            : session.status === 'busy'
              ? chalk.yellow('busy')
              : chalk.red(session.status);
        console.log(`  ${chalk.cyan(session.id.slice(0, 8))} ${status} ${session.workingDir}`);
      }
    }

    const stoppedSessions = Object.values(stored).filter((s) => s.status === 'stopped');
    if (stoppedSessions.length > 0) {
      console.log(chalk.bold('\nStopped Sessions:'));
      for (const session of stoppedSessions) {
        const name = session.name ? ` (${session.name})` : '';
        console.log(`  ${chalk.gray(session.id.slice(0, 8))} ${chalk.gray('stopped')}${name} ${session.workingDir}`);
      }
    }

    // Show active sessions from state (when web server manages them)
    const activeSessions = Object.values(stored).filter((s) => s.status !== 'stopped');
    if (sessions.length === 0 && activeSessions.length > 0) {
      console.log(chalk.bold('\nActive Sessions (from web server):'));
      for (const session of activeSessions) {
        const status =
          session.status === 'idle'
            ? chalk.green('idle')
            : session.status === 'busy'
              ? chalk.yellow('busy')
              : chalk.red(session.status);
        const name = session.name ? ` (${session.name})` : '';
        const mode = session.mode === 'shell' ? chalk.gray(' [shell]') : '';
        const cost = session.totalCost ? chalk.gray(` $${session.totalCost.toFixed(4)}`) : '';
        console.log(`  ${chalk.cyan(session.id.slice(0, 8))} ${status}${name}${mode}${cost} ${session.workingDir}`);
      }
    }
    console.log('');
  });

sessionCmd
  .command('logs <id>')
  .description('View session output')
  .option('-e, --errors', 'Show stderr instead of stdout')
  .action((id, options) => {
    const manager = getSessionManager();
    const output = options.errors ? manager.getSessionError(id) : manager.getSessionOutput(id);

    if (output === null) {
      console.log(chalk.yellow(`Session ${id} not found or not active`));
      return;
    }

    if (output === '') {
      console.log(chalk.gray('(no output)'));
      return;
    }

    console.log(output);
  });

// ============ Task Commands ============

const taskCmd = program.command('task').alias('t').description('Manage tasks');

taskCmd
  .command('add <prompt>')
  .description('Add a new task')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .option('-p, --priority <n>', 'Priority (higher = first)', '0')
  .option('-c, --completion <phrase>', 'Completion phrase to detect')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .action((prompt, options) => {
    const queue = getTaskQueue();
    const task = queue.addTask({
      prompt,
      workingDir: options.dir,
      priority: parseInt(options.priority, 10),
      completionPhrase: options.completion,
      timeoutMs: options.timeout ? parseInt(options.timeout, 10) : undefined,
    });
    console.log(chalk.green(`✓ Task added: ${task.id}`));
    console.log(`  Prompt: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`);
    console.log(`  Priority: ${task.priority}`);
  });

taskCmd
  .command('list')
  .alias('ls')
  .description('List all tasks')
  .option('-s, --status <status>', 'Filter by status (pending, running, completed, failed)')
  .action((options) => {
    const queue = getTaskQueue();
    let tasks = queue.getAllTasks();

    if (options.status) {
      tasks = tasks.filter((t) => t.status === options.status);
    }

    if (tasks.length === 0) {
      console.log(chalk.yellow('No tasks found'));
      return;
    }

    const statusColors = {
      pending: chalk.gray,
      running: chalk.yellow,
      completed: chalk.green,
      failed: chalk.red,
    };

    console.log(chalk.bold('\nTasks:'));
    for (const task of tasks) {
      const color = statusColors[task.status];
      const prompt = task.prompt.slice(0, 40) + (task.prompt.length > 40 ? '...' : '');
      console.log(`  ${chalk.cyan(task.id.slice(0, 8))} ${color(task.status.padEnd(10))} [${task.priority}] ${prompt}`);
    }

    const counts = queue.getCount();
    console.log(chalk.bold('\nSummary:'));
    console.log(
      `  Pending: ${counts.pending}, Running: ${counts.running}, Completed: ${counts.completed}, Failed: ${counts.failed}`
    );
    console.log('');
  });

taskCmd
  .command('status <id>')
  .description('Show task details')
  .action((id) => {
    const queue = getTaskQueue();
    const task = queue.getTask(id);

    if (!task) {
      console.log(chalk.red(`Task ${id} not found`));
      return;
    }

    console.log(chalk.bold('\nTask Details:'));
    console.log(`  ID: ${task.id}`);
    console.log(`  Status: ${task.status}`);
    console.log(`  Priority: ${task.priority}`);
    console.log(`  Prompt: ${task.prompt}`);
    console.log(`  Working Dir: ${task.workingDir}`);
    if (task.assignedSessionId) {
      console.log(`  Session: ${task.assignedSessionId}`);
    }
    if (task.error) {
      console.log(`  Error: ${chalk.red(task.error)}`);
    }
    if (task.output) {
      console.log(chalk.bold('\nOutput:'));
      console.log(task.output.slice(0, 500) + (task.output.length > 500 ? '...' : ''));
    }
    console.log('');
  });

taskCmd
  .command('remove <id>')
  .alias('rm')
  .description('Remove a task')
  .action((id) => {
    const queue = getTaskQueue();
    if (queue.removeTask(id)) {
      console.log(chalk.green(`✓ Task removed: ${id}`));
    } else {
      console.log(chalk.red(`Task ${id} not found`));
    }
  });

taskCmd
  .command('clear')
  .description('Clear completed/failed tasks')
  .option('-a, --all', 'Clear all tasks')
  .option('-f, --failed', 'Clear only failed tasks')
  .action((options) => {
    const queue = getTaskQueue();
    let count: number;

    if (options.all) {
      count = queue.clearAll();
      console.log(chalk.green(`✓ Cleared ${count} tasks`));
    } else if (options.failed) {
      count = queue.clearFailed();
      console.log(chalk.green(`✓ Cleared ${count} failed tasks`));
    } else {
      count = queue.clearCompleted();
      console.log(chalk.green(`✓ Cleared ${count} completed tasks`));
    }
  });

// ============ Ralph Loop Commands ============

const ralphCmd = program.command('ralph').alias('r').description('Control the Ralph autonomous loop');

ralphCmd
  .command('start')
  .description('Start the Ralph loop')
  .option('-m, --min-hours <hours>', 'Minimum duration in hours')
  .option('--no-auto-generate', 'Disable auto-generating follow-up tasks')
  .action(async (options) => {
    const loop = getRalphLoop({
      autoGenerateTasks: options.autoGenerate,
    });

    if (options.minHours) {
      loop.setMinDuration(parseFloat(options.minHours));
    }

    if (loop.isRunning()) {
      console.log(chalk.yellow('Ralph loop is already running'));
      return;
    }

    loop.on('taskAssigned', (taskId, sessionId) => {
      console.log(chalk.cyan(`→ Task ${taskId.slice(0, 8)} assigned to session ${sessionId.slice(0, 8)}`));
    });

    loop.on('taskCompleted', (taskId) => {
      console.log(chalk.green(`✓ Task ${taskId.slice(0, 8)} completed`));
    });

    loop.on('taskFailed', (taskId, error) => {
      console.log(chalk.red(`✗ Task ${taskId.slice(0, 8)} failed: ${error}`));
    });

    loop.on('stopped', () => {
      console.log(chalk.yellow('\nRalph loop stopped'));
      printStats(loop.getStats());
      process.exit(0);
    });

    await loop.start();
    console.log(chalk.green('✓ Ralph loop started'));
    if (options.minHours) {
      console.log(`  Minimum duration: ${options.minHours} hours`);
    }
    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

    // Keep process running
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nStopping Ralph loop...'));
      loop.stop();
    });
  });

ralphCmd
  .command('stop')
  .description('Stop the Ralph loop')
  .action(() => {
    const loop = getRalphLoop();
    if (!loop.isRunning()) {
      console.log(chalk.yellow('Ralph loop is not running'));
      return;
    }
    loop.stop();
    console.log(chalk.green('✓ Ralph loop stopped'));
  });

ralphCmd
  .command('status')
  .description('Show Ralph loop status')
  .action(() => {
    const loop = getRalphLoop();
    const stats = loop.getStats();
    printStats(stats);
  });

function printStats(stats: ReturnType<ReturnType<typeof getRalphLoop>['getStats']>) {
  const statusColor = stats.status === 'running' ? chalk.green : stats.status === 'paused' ? chalk.yellow : chalk.gray;

  console.log(chalk.bold('\nRalph Loop Status:'));
  console.log(`  Status: ${statusColor(stats.status)}`);
  console.log(`  Elapsed: ${stats.elapsedHours.toFixed(2)} hours`);
  if (stats.minDurationMs) {
    const minHours = stats.minDurationMs / (1000 * 60 * 60);
    console.log(
      `  Min Duration: ${minHours.toFixed(2)} hours (${stats.minDurationReached ? 'reached' : 'not reached'})`
    );
  }

  console.log(chalk.bold('\nTasks:'));
  console.log(`  Pending: ${stats.pending}`);
  console.log(`  Running: ${stats.running}`);
  console.log(`  Completed: ${stats.completed} (${stats.tasksCompleted} this session)`);
  console.log(`  Failed: ${stats.failed}`);
  console.log(`  Generated: ${stats.tasksGenerated}`);

  console.log(chalk.bold('\nSessions:'));
  console.log(`  Active: ${stats.activeSessions}`);
  console.log(`  Idle: ${stats.idleSessions}`);
  console.log(`  Busy: ${stats.busySessions}`);
  console.log('');
}

// ============ Utility Commands ============

/** What probing the web server found. */
interface WebServerProbe {
  reachable: boolean;
  /** The URL that answered, or the first candidate when nothing did. */
  url: string;
  statusCode?: number;
  version?: string;
  authRequired?: boolean;
  /** Live session states from `/api/status`, when the probe could read them. */
  sessions?: Array<{ status?: string }>;
}

/**
 * GET `<base>/api/status` with a short timeout, tolerating the self-signed cert an
 * `--https` install uses. ANY HTTP answer proves the server is up: a 401 just
 * means it wants credentials (sent when available, same env → data-dir `.env`
 * fallback as `codeman attach`).
 */
function probeWebServerAt(base: string): Promise<WebServerProbe | null> {
  let url: URL;
  try {
    url = new URL('/api/status', base);
  } catch {
    return Promise.resolve(null);
  }
  const envFile = readCodemanEnv();
  const username = process.env.CODEMAN_USERNAME || envFile.CODEMAN_USERNAME || 'admin';
  const password = process.env.CODEMAN_PASSWORD || envFile.CODEMAN_PASSWORD;
  const transport = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  return new Promise((resolve) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: 'GET',
        path: url.pathname,
        rejectUnauthorized: false,
        headers,
        timeout: 3000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received <= 1024 * 1024) chunks.push(chunk);
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode === 401) {
            resolve({ reachable: true, url: base, statusCode, authRequired: true });
            return;
          }
          let version: string | undefined;
          let sessions: Array<{ status?: string }> | undefined;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              data?: { version?: unknown; sessions?: unknown };
            };
            const data = parsed?.data ?? (parsed as { version?: unknown; sessions?: unknown });
            if (typeof data?.version === 'string') version = data.version;
            if (Array.isArray(data?.sessions)) sessions = data.sessions as Array<{ status?: string }>;
          } catch {
            // Not JSON, but still an answer, so still running.
          }
          resolve({ reachable: true, url: base, statusCode, version, sessions });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

program
  .command('status')
  .description('Show whether the Codeman web server is running, plus session/task state')
  .option('--url <url>', 'Server URL to probe (defaults to CODEMAN_API_URL, then local port)')
  .action(async (options: { url?: string }) => {
    // Issue #230: this command runs in its own fresh process, and the old output
    // reported THAT process's (always-stopped) Ralph loop under a bare "Status:",
    // reading as "the server is down" while the web service ran fine. Probe the
    // real server first; the Ralph loop has its own `codeman ralph status`.
    const port = process.env.CODEMAN_PORT || '3000';
    const candidates = options.url
      ? [options.url]
      : process.env.CODEMAN_API_URL
        ? [process.env.CODEMAN_API_URL]
        : [`https://127.0.0.1:${port}`, `http://127.0.0.1:${port}`];
    let probe: WebServerProbe = { reachable: false, url: candidates[0] };
    for (const candidate of candidates) {
      const answer = await probeWebServerAt(candidate);
      if (answer) {
        probe = answer;
        break;
      }
    }

    console.log(chalk.bold('\nCodeman Status'));
    console.log('─'.repeat(40));

    console.log(chalk.bold('\nWeb Server:'));
    if (probe.reachable) {
      const version = probe.version ? ` (v${probe.version})` : '';
      console.log(`  Status: ${chalk.green('running')}${version} at ${probe.url}`);
      if (probe.authRequired) {
        console.log(chalk.gray('  (answers 401: set CODEMAN_PASSWORD/CODEMAN_USERNAME to see session details)'));
      }
    } else {
      console.log(`  Status: ${chalk.red('not reachable')} at ${candidates.join(' or ')}`);
      console.log(
        chalk.gray('  (start it with `codeman web`, or check your service: systemctl --user status codeman-web)')
      );
    }

    // Prefer the server's live view; fall back to the shared saved state, labeled
    // as such, so the numbers are never silently a different thing.
    if (probe.sessions) {
      const live = probe.sessions;
      console.log(chalk.bold('\nSessions (live, from the server):'));
      console.log(`  Total: ${live.length}`);
      console.log(`  Idle: ${live.filter((s) => s.status === 'idle').length}`);
      console.log(`  Busy: ${live.filter((s) => s.status === 'busy').length}`);
    } else {
      const manager = getSessionManager();
      const storedValues = Object.values(manager.getStoredSessions());
      console.log(chalk.bold('\nSessions (from saved state):'));
      console.log(`  Active: ${storedValues.filter((s) => s.status !== 'stopped').length}`);
      console.log(`  Idle: ${storedValues.filter((s) => s.status === 'idle').length}`);
      console.log(`  Busy: ${storedValues.filter((s) => s.status === 'busy').length}`);
    }

    const taskCounts = getTaskQueue().getCount();
    console.log(chalk.bold('\nTasks:'));
    console.log(`  Total: ${taskCounts.total}`);
    console.log(`  Pending: ${taskCounts.pending}`);
    console.log(`  Running: ${taskCounts.running}`);
    console.log(`  Completed: ${taskCounts.completed}`);
    console.log(`  Failed: ${taskCounts.failed}`);
    console.log('');
  });

program
  .command('reset')
  .description('Reset all state')
  .option('-f, --force', 'Skip confirmation')
  .action(async (options) => {
    if (!options.force) {
      console.log(chalk.yellow('This will stop all sessions and clear all state.'));
      console.log(chalk.yellow('Use --force to confirm.'));
      return;
    }

    const manager = getSessionManager();
    const store = getStore();

    await manager.stopAllSessions();
    store.reset();

    console.log(chalk.green('✓ All state reset'));
  });

// Shorthand commands at root level
program
  .command('start')
  .description('Start a new session (shorthand)')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .action(async (options) => {
    const manager = getSessionManager();
    const session = await manager.createSession(options.dir);
    console.log(chalk.green(`✓ Session started: ${session.id}`));
  });

program
  .command('list')
  .alias('ls')
  .description('List all sessions (shorthand)')
  .action(() => {
    const manager = getSessionManager();
    const sessions = manager.getAllSessions();
    const stored = manager.getStoredSessions();

    if (sessions.length === 0 && Object.keys(stored).length === 0) {
      console.log(chalk.yellow('No sessions found'));
      return;
    }

    console.log(chalk.bold('\nActive Sessions:'));
    if (sessions.length === 0) {
      console.log('  (none)');
    } else {
      for (const session of sessions) {
        const status =
          session.status === 'idle'
            ? chalk.green('idle')
            : session.status === 'busy'
              ? chalk.yellow('busy')
              : chalk.red(session.status);
        console.log(`  ${chalk.cyan(session.id.slice(0, 8))} ${status} ${session.workingDir}`);
      }
    }
    console.log('');
  });

// ============ Web / daemon / service Commands ============

/** Shared option set for the commands that can launch a web server. */
function addWebLaunchOptions(cmd: Command): Command {
  return cmd
    .option('-H, --host <host>', 'Host to bind to', process.env.CODEMAN_HOST || '127.0.0.1')
    .option('-p, --port <port>', 'Port to listen on (env: CODEMAN_PORT)', process.env.CODEMAN_PORT || '3000')
    .option('--https', 'Enable HTTPS with self-signed certificate (only needed for remote access, not localhost)')
    .option('--title-hostname <hostname>', 'Override the hostname shown in the browser title')
    .option(
      '--allow-unauthenticated-network',
      'Allow non-loopback web access without CODEMAN_PASSWORD (dangerous; terminal control is exposed)'
    )
    .option(
      '--multiuser',
      'Enable opt-in multi-user mode (named users in ~/.codeman/users.json; env: CODEMAN_MULTIUSER)'
    );
}

/** Normalize commander's strings into the shape daemon-control/service-installer take. */
function toWebLaunchOptions(options: {
  host: string;
  port: string;
  https?: boolean;
  titleHostname?: string;
  allowUnauthenticatedNetwork?: boolean;
  multiuser?: boolean;
}): WebLaunchOptions {
  const port = parseInt(options.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(chalk.red(`✗ Invalid port: ${options.port}`));
    process.exit(1);
  }
  return {
    host: options.host,
    port,
    https: !!options.https,
    titleHostname: options.titleHostname,
    allowUnauthenticatedNetwork: !!options.allowUnauthenticatedNetwork,
    multiuser: !!options.multiuser,
  };
}

/**
 * The server prints this itself, but into a log file nobody reads when it is
 * detached or supervised. Repeat it where the operator is actually looking.
 */
function warnIfUnauthenticatedNetwork(launch: WebLaunchOptions): void {
  if (isLoopbackBindHost(launch.host)) return;
  if (isUnauthenticatedNetworkAcknowledged(launch.allowUnauthenticatedNetwork)) return;
  console.log(
    chalk.yellow(
      `⚠ Binding ${launch.host} without CODEMAN_PASSWORD: anyone who can reach this port gets terminal control.`
    )
  );
  console.log(chalk.yellow('  Set CODEMAN_PASSWORD, or bind 127.0.0.1 and front it with tailscale serve.'));
}

// Web interface command
const webCmd = addWebLaunchOptions(program.command('web').description('Start the web interface'))
  .option('-d, --daemon', 'Run detached in the background; survives the shell, logs to <data dir>/web.log')
  .option('--stop', 'Stop a server started with --daemon')
  .option('--status', 'Report whether a detached server is running');

webCmd.action(async (options) => {
  // The flag is surfaced to the rest of the process via the env var so
  // isMultiUserMode() has a single source of truth (see config/multiuser.ts).
  if (options.multiuser) process.env.CODEMAN_MULTIUSER = '1';
  const launch = toWebLaunchOptions(options);

  if (options.stop) {
    const result = await stopDaemon(launch);
    if (result.ok && result.reason === 'not-running') {
      console.log(chalk.gray(`○ ${result.message}`));
      return;
    }
    if (result.ok) {
      console.log(chalk.green(`✓ ${result.message ?? `Stopped Codeman (pid ${result.pid})`}`));
      console.log(chalk.gray('  Your agents keep running in tmux.'));
      return;
    }
    console.error(chalk.red(`✗ ${result.message ?? 'Could not stop the server'}`));
    process.exit(1);
  }

  if (options.status) {
    const status = await daemonStatus(launch);
    if (status.responding) {
      const version = status.version ? ` (v${status.version})` : '';
      console.log(chalk.green(`✓ Responding at ${status.url}${version}`));
    } else {
      console.log(chalk.yellow(`○ Nothing answering at ${status.url}`));
    }
    console.log(`  Daemon pid:  ${status.running ? chalk.green(String(status.pid)) : chalk.gray('not running')}`);
    console.log(chalk.gray(`  Pidfile:     ${status.pidFile}`));
    console.log(chalk.gray(`  Log:         ${status.logPath}`));
    if (!status.running && status.responding) {
      console.log(chalk.gray('  (running, but not started with --daemon: probably a service or a foreground run)'));
    }
    return;
  }

  if (options.daemon) {
    warnIfUnauthenticatedNetwork(launch);
    console.log(chalk.cyan('Starting Codeman in the background...'));
    const result = await startDaemon(launch);
    if (result.ok) {
      console.log(chalk.green(`\n✓ Codeman is running at ${result.url} (pid ${result.pid})`));
      console.log(chalk.gray(`  Logs: ${result.logPath}`));
      console.log(chalk.gray('  Stop it with: codeman web --stop'));
      console.log(chalk.gray('  Want it back after a reboot? codeman service install'));
      return;
    }
    console.error(chalk.red(`\n✗ ${result.message ?? 'Failed to start'}`));
    process.exit(1);
  }

  const { startWebServer } = await import('./web/server.js');
  const host = launch.host;
  const port = launch.port;
  const https = launch.https;
  const titleHostname = options.titleHostname;
  const allowUnauthenticatedNetwork = launch.allowUnauthenticatedNetwork ?? false;
  const protocol = https ? 'https' : 'http';
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;

  console.log(chalk.cyan(`Starting Codeman web interface on ${displayHost}:${port}${https ? ' (HTTPS)' : ''}...`));

  try {
    const server = await startWebServer(port, https, false, host, titleHostname, allowUnauthenticatedNetwork);
    console.log(chalk.green(`\n✓ Web interface running at ${protocol}://${displayHost}:${port}`));
    if (https) {
      console.log(chalk.yellow('  Note: Accept the self-signed certificate in your browser on first visit'));
    }
    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

    // Graceful shutdown handler — flush state and clean up on SIGTERM/SIGINT
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(chalk.yellow(`\n${signal} received, shutting down gracefully...`));
      try {
        await server.stop();
      } catch (err) {
        console.error(chalk.red(`Error during shutdown: ${getErrorMessage(err)}`));
      }
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
  } catch (err) {
    console.error(chalk.red(`✗ Failed to start web server: ${getErrorMessage(err)}`));
    process.exit(1);
  }
});

// Supervised service: the "still there after a reboot" answer, where `web -d` is
// the "still there after I close this shell" one (issue #231).
const serviceCmd = program
  .command('service')
  .description('Manage the background service (systemd user unit on Linux, LaunchAgent on macOS)');

addWebLaunchOptions(
  serviceCmd.command('install').description('Install and start the service, then verify it answers')
).action(async (options) => {
  const launch = toWebLaunchOptions(options);
  warnIfUnauthenticatedNetwork(launch);
  console.log(chalk.cyan('Installing the Codeman service...'));

  const result = await installService(launch);
  for (const warning of result.warnings ?? []) console.log(chalk.yellow(`⚠ ${warning}`));

  if (!result.ok) {
    console.error(chalk.red(`✗ ${result.message}`));
    process.exit(1);
  }
  console.log(chalk.green(`✓ ${result.message}`));
  console.log(chalk.gray(`  Unit: ${result.unitPath}`));
  if (process.env.CODEMAN_PASSWORD) {
    console.log(
      chalk.yellow(
        '  Note: CODEMAN_PASSWORD was NOT copied into the unit file. Add it there yourself if the service needs auth.'
      )
    );
  }
});

serviceCmd
  .command('uninstall')
  .description('Stop the service and remove its unit file')
  .action(() => {
    const result = uninstallService();
    if (!result.ok) {
      console.error(chalk.red(`✗ ${result.message}`));
      process.exit(1);
    }
    console.log(chalk.green(`✓ ${result.message}`));
  });

addWebLaunchOptions(
  serviceCmd.command('status').description('Show whether the service is installed and running')
).action(async (options) => {
  const status = await serviceStatus(toWebLaunchOptions(options));
  if (!status.kind) {
    console.log(chalk.yellow(`No supported supervisor on ${process.platform}. Use \`codeman web -d\` instead.`));
    return;
  }
  console.log(`  Supervisor: ${status.kind} (${status.name})`);
  console.log(`  Unit file:  ${status.installed ? chalk.green(status.unitPath) : chalk.gray('not installed')}`);
  console.log(`  Loaded:     ${status.loaded ? chalk.green('yes') : chalk.gray('no')}`);
  const version = status.version ? ` (v${status.version})` : '';
  console.log(
    `  Responding: ${status.responding ? chalk.green(`yes at ${status.url}${version}`) : chalk.gray(`no at ${status.url}`)}`
  );
});

// ============ Multi-user Commands ============
//
// Operate directly on ~/.codeman/users.json (via user-store) with NO running
// server, honoring CODEMAN_INSTANCE. This is the headless bootstrap path and the
// recovery answer to "locked out: last admin forgot password".

/** Read a password from stdin without echoing. Falls back to plain read on non-TTY. */
function promptHiddenPassword(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    // Non-interactive: read a single line from stdin.
    return new Promise((resolve) => {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => (buf += d));
      stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
    });
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\n' || c === '\r' || c === '\u0004') {
          stdin.setRawMode!(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        } else if (c === '\u0003') {
          process.stdout.write('\n');
          process.exit(1);
        } else if (c === '\u007f' || c === '\b') {
          input = input.slice(0, -1);
        } else {
          input += c;
        }
      }
    };
    stdin.on('data', onData);
  });
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
  });
}

const usersCmd = program.command('users').description('Manage multi-user accounts (~/.codeman/users.json)');

usersCmd
  .command('add <name>')
  .description('Create a user (prompts for password; use --password-stdin for scripts)')
  .option('--admin', 'Create as an admin')
  .option('--password-stdin', 'Read the password from stdin instead of prompting')
  .action(async (name, options) => {
    const { createUser, isValidUsername } = await import('./user-store.js');
    if (!isValidUsername(name)) {
      console.error(chalk.red('✗ Username must be lowercase, start alphanumeric, 2-32 chars ([a-z0-9_-])'));
      process.exit(1);
    }
    try {
      let password: string;
      if (options.passwordStdin) {
        password = await readAllStdin();
      } else {
        password = await promptHiddenPassword('New password: ');
        const confirm = await promptHiddenPassword('Confirm password: ');
        if (password !== confirm) {
          console.error(chalk.red('✗ Passwords do not match'));
          process.exit(1);
        }
      }
      if (!password || password.length < 8) {
        console.error(chalk.red('✗ Password must be at least 8 characters'));
        process.exit(1);
      }
      const user = await createUser({ username: name, role: options.admin ? 'admin' : 'user', password });
      console.log(chalk.green(`✓ Created ${user.role} "${user.username}"`));
    } catch (err) {
      console.error(chalk.red(`✗ ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

usersCmd
  .command('passwd <name>')
  .description('Reset a user password')
  .option('--password-stdin', 'Read the new password from stdin instead of prompting')
  .action(async (name, options) => {
    const { setPassword } = await import('./user-store.js');
    try {
      let password: string;
      if (options.passwordStdin) {
        password = await readAllStdin();
      } else {
        password = await promptHiddenPassword('New password: ');
        const confirm = await promptHiddenPassword('Confirm password: ');
        if (password !== confirm) {
          console.error(chalk.red('✗ Passwords do not match'));
          process.exit(1);
        }
      }
      await setPassword(name, password, { mustChangePassword: false });
      console.log(chalk.green(`✓ Password updated for "${name}"`));
    } catch (err) {
      console.error(chalk.red(`✗ ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

usersCmd
  .command('list')
  .alias('ls')
  .description('List all users')
  .action(async () => {
    const { readUsers } = await import('./user-store.js');
    const users = await readUsers(true);
    if (users.length === 0) {
      console.log(chalk.yellow('No users defined (run: codeman users add <name> --admin)'));
      return;
    }
    console.log(chalk.bold('\nUsers:'));
    for (const u of users) {
      const role = u.role === 'admin' ? chalk.magenta('admin') : chalk.cyan('user ');
      const state = u.disabled ? chalk.red('disabled') : chalk.green('enabled ');
      const flags = [u.mustChangePassword ? 'must-change-pw' : '', u.canBypassPermissions ? 'can-bypass' : '']
        .filter(Boolean)
        .join(' ');
      console.log(`  ${role} ${state} ${u.username}${flags ? chalk.gray(`  [${flags}]`) : ''}`);
    }
    console.log('');
  });

usersCmd
  .command('rm <name>')
  .description('Delete a user')
  .option('--delete-space', "Also delete the user's ~/codeman-users/<name> space")
  .action(async (name, options) => {
    const { deleteUser, deleteUserSpace } = await import('./user-store.js');
    try {
      await deleteUser(name);
      if (options.deleteSpace) {
        await deleteUserSpace(name);
        console.log(chalk.green(`✓ Deleted user "${name}" and their space`));
      } else {
        console.log(chalk.green(`✓ Deleted user "${name}" (space left on disk)`));
      }
    } catch (err) {
      console.error(chalk.red(`✗ ${getErrorMessage(err)}`));
      process.exit(1);
    }
  });

program
  .command('doctor')
  .alias('check-deps')
  .description('Check Codeman tool dependencies (Node, Claude CLI, tmux, LibreOffice, MS Office)')
  .option('--json', 'Output structured JSON instead of a table')
  .option('--category <name>', 'Only check one category (core|office|other)')
  .action(async (options) => {
    const { createRealHost, checkAll } = await import('./utils/dependency-checker.js');
    const { renderTable, renderJson, computeExitCode } = await import('./utils/dependency-report.js');
    const { DEPENDENCY_REGISTRY, TOOL_CATEGORIES } = await import('./config/dependency-registry.js');

    if (options.category && !(TOOL_CATEGORIES as readonly string[]).includes(options.category)) {
      console.error(`Unknown category "${options.category}". Valid categories: ${TOOL_CATEGORIES.join(', ')}`);
      process.exit(2);
    }

    const host = createRealHost();
    const registry = options.category
      ? DEPENDENCY_REGISTRY.filter((t) => t.category === options.category)
      : DEPENDENCY_REGISTRY;
    const results = checkAll(registry, host);

    if (options.json) {
      console.log(JSON.stringify(renderJson(results, host.environment), null, 2));
    } else {
      console.log(renderTable(results, host.environment));
    }
    process.exit(computeExitCode(results));
  });

export { program };
