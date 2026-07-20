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
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { dataPath } from './config/instance.js';
import { getSessionManager } from './session-manager.js';
import { getTaskQueue } from './task-queue.js';
import { getRalphLoop } from './ralph-loop.js';
import { getStore } from './state-store.js';
import { getErrorMessage } from './types.js';
import { isSupportedAttachmentExtension } from './attachment-registry.js';

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

program
  .command('status')
  .description('Show overall status')
  .action(() => {
    const manager = getSessionManager();
    const queue = getTaskQueue();
    const loop = getRalphLoop();

    const sessions = manager.getAllSessions();
    const stored = manager.getStoredSessions();
    const storedValues = Object.values(stored);
    const taskCounts = queue.getCount();
    const loopStatus = loop.status;

    // Use live sessions if available, otherwise fall back to stored state
    const activeCount = sessions.length || storedValues.filter((s) => s.status !== 'stopped').length;
    const idleCount = sessions.length
      ? sessions.filter((s) => s.isIdle()).length
      : storedValues.filter((s) => s.status === 'idle').length;
    const busyCount = sessions.length
      ? sessions.filter((s) => s.isBusy()).length
      : storedValues.filter((s) => s.status === 'busy').length;

    console.log(chalk.bold('\nCodeman Status'));
    console.log('─'.repeat(40));

    console.log(chalk.bold('\nSessions:'));
    console.log(`  Active: ${activeCount}`);
    console.log(`  Idle: ${idleCount}`);
    console.log(`  Busy: ${busyCount}`);

    console.log(chalk.bold('\nTasks:'));
    console.log(`  Total: ${taskCounts.total}`);
    console.log(`  Pending: ${taskCounts.pending}`);
    console.log(`  Running: ${taskCounts.running}`);
    console.log(`  Completed: ${taskCounts.completed}`);
    console.log(`  Failed: ${taskCounts.failed}`);

    const statusColor = loopStatus === 'running' ? chalk.green : loopStatus === 'paused' ? chalk.yellow : chalk.gray;
    console.log(chalk.bold('\nRalph Loop:'));
    console.log(`  Status: ${statusColor(loopStatus)}`);
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

// Web interface command
program
  .command('web')
  .description('Start the web interface')
  .option('-H, --host <host>', 'Host to bind to', process.env.CODEMAN_HOST || '127.0.0.1')
  .option('-p, --port <port>', 'Port to listen on (env: CODEMAN_PORT)', process.env.CODEMAN_PORT || '3000')
  .option('--https', 'Enable HTTPS with self-signed certificate (only needed for remote access, not localhost)')
  .option('--title-hostname <hostname>', 'Override the hostname shown in the browser title')
  .option(
    '--allow-unauthenticated-network',
    'Allow non-loopback web access without CODEMAN_PASSWORD (dangerous; terminal control is exposed)'
  )
  .option('--multiuser', 'Enable opt-in multi-user mode (named users in ~/.codeman/users.json; env: CODEMAN_MULTIUSER)')
  .action(async (options) => {
    // The flag is surfaced to the rest of the process via the env var so
    // isMultiUserMode() has a single source of truth (see config/multiuser.ts).
    if (options.multiuser) process.env.CODEMAN_MULTIUSER = '1';
    const { startWebServer } = await import('./web/server.js');
    const host = options.host;
    const port = parseInt(options.port, 10);
    const https = !!options.https;
    const titleHostname = options.titleHostname;
    const allowUnauthenticatedNetwork = !!options.allowUnauthenticatedNetwork;
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
