/**
 * @fileoverview `codeman service install|uninstall|status`: write and load the
 * systemd user unit (Linux) or LaunchAgent (macOS) that supervises `codeman web`.
 *
 * This is the "always running" half of issue #231, next to the "detached right
 * now" half in daemon-control.ts. `install.sh` already does this for people who
 * install with the one-liner; this exists for `npm i -g aicodeman` users, who
 * otherwise have to hand-write a plist.
 *
 * Two details are load-bearing and easy to get wrong by hand:
 *
 * - **PATH.** launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and systemd's
 *   user manager is nearly as bare, so a Homebrew or nvm `node`, `tmux` or
 *   `claude` is simply not found and sessions fail in a way that reads as a
 *   Codeman bug. The unit therefore carries the PATH of the shell that ran the
 *   install, with the running node's own directory in front.
 * - **The job name.** It is the one `install.sh` and the self-updater already use
 *   (config/service-names.ts), so re-running install.sh later updates this unit
 *   instead of supervising a second copy of the server.
 *
 * Secrets are deliberately NOT written here. `CODEMAN_PASSWORD` in the installing
 * shell is not copied into the unit; the caller is told where to add it instead,
 * because a unit file is long-lived, world-readable by default, and gets copied
 * into bug reports.
 *
 * The file writers are pure string builders so they can be unit-tested without
 * touching launchctl/systemctl.
 *
 * @module service-installer
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from './config/service-names.js';
import { CODEMAN_INSTANCE } from './config/instance.js';
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
import {
  buildBaseUrl,
  buildStatusUrl,
  buildWebArgs,
  logFilePath,
  probeServer,
  type WebLaunchOptions,
} from './daemon-control.js';

export type ServiceKind = 'launchd' | 'systemd';

/** Everything a unit file needs, resolved from the environment by the caller. */
export interface ServicePlan {
  kind: ServiceKind;
  /** systemd unit filename or launchd label. */
  name: string;
  nodePath: string;
  /** Runner flags carried over from the current process (tsx loader in dev). */
  execArgv: string[];
  scriptPath: string;
  args: string[];
  env: Record<string, string>;
  logPath: string;
  workingDir: string;
}

export interface ServiceActionResult {
  ok: boolean;
  message: string;
  /** Path of the unit/plist that was written or removed. */
  unitPath?: string;
  warnings?: string[];
}

export interface ServiceStatusResult {
  kind: ServiceKind | null;
  name: string;
  unitPath: string;
  installed: boolean;
  loaded: boolean;
  responding: boolean;
  version?: string;
  url: string;
}

/** Directories worth having on PATH even when the installing shell lacked them. */
const FALLBACK_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// ─────────────────────────────────────────────────────────────────────────────
// Pure builders
// ─────────────────────────────────────────────────────────────────────────────

/** XML text escaping for plist `<string>` values. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * PATH for the supervised process: the running node's directory first (so an nvm
 * or Homebrew node is used rather than whatever the supervisor finds), then the
 * installing shell's PATH, then the fallbacks that are still missing.
 *
 * `node_modules/.bin` entries are dropped. npm and npx inject those for the
 * lifetime of one command, and baking a project's local bin dir into a unit file
 * that outlives the checkout is how a service ends up running a binary the
 * operator deleted months ago.
 */
export function buildServicePath(nodeDir: string, currentPath: string, home: string): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) return;
    if (/(^|\/)node_modules\/\.bin\/?$/.test(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  push(nodeDir);
  for (const dir of currentPath.split(':')) push(dir);
  push(join(home, '.local', 'bin'));
  for (const dir of FALLBACK_PATH_DIRS) push(dir);
  return ordered.join(':');
}

/** Environment written into the unit. Never includes secrets (see module docs). */
export function buildServiceEnv(
  nodeDir: string,
  currentPath: string,
  home: string,
  lang?: string
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: buildServicePath(nodeDir, currentPath, home),
    HOME: home,
    LANG: lang || 'en_US.UTF-8',
  };
  if (CODEMAN_INSTANCE) env.CODEMAN_INSTANCE = CODEMAN_INSTANCE;
  return env;
}

/** systemd accepts double-quoted values; escape the two characters that matter. */
export function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildLaunchAgentPlist(plan: ServicePlan): string {
  const programArguments = [plan.nodePath, ...plan.execArgv, plan.scriptPath, ...plan.args]
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');
  const environment = Object.entries(plan.env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(plan.name)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(plan.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(plan.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(plan.logPath)}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit(plan: ServicePlan): string {
  const execStart = [plan.nodePath, ...plan.execArgv, plan.scriptPath, ...plan.args]
    .map((arg) => (/[\s"'\\]/.test(arg) ? systemdQuote(arg) : arg))
    .join(' ');
  const environment = Object.entries(plan.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join('\n');

  return `[Unit]
Description=Codeman Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${plan.workingDir}
ExecStart=${execStart}
Restart=always
RestartSec=10
# Agents keep running in tmux when the server restarts, so only signal the
# server itself.
KillMode=process
${environment}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codeman
LimitNOFILE=65536

[Install]
WantedBy=default.target
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment resolution
// ─────────────────────────────────────────────────────────────────────────────

export function detectServiceKind(): ServiceKind | null {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  return null;
}

export function unitPathFor(kind: ServiceKind): string {
  return kind === 'launchd'
    ? join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    : join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function entryScript(): string {
  const script = process.argv[1];
  if (!script) throw new Error('cannot determine the codeman entry script to supervise');
  return script;
}

/** Resolve a full plan from the current process and the requested web options. */
export function resolveServicePlan(kind: ServiceKind, options: WebLaunchOptions): ServicePlan {
  const home = homedir();
  return {
    kind,
    name: kind === 'launchd' ? LAUNCHD_LABEL : SYSTEMD_UNIT,
    nodePath: process.execPath,
    execArgv: [...process.execArgv],
    scriptPath: entryScript(),
    args: buildWebArgs(options),
    env: buildServiceEnv(dirname(process.execPath), process.env.PATH || '', home, process.env.LANG),
    logPath: logFilePath(),
    workingDir: home,
  };
}

function run(command: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8');
    return { ok: false, output: (stderr || e.message || '').trim() };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install / uninstall / status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the unit, load it, and confirm the server actually answers before
 * reporting success. `launchctl load` and `systemctl enable` are both quiet about
 * a job that starts and immediately dies, which is the whole reason install.sh
 * verifies too.
 */
export async function installService(options: WebLaunchOptions): Promise<ServiceActionResult> {
  const kind = detectServiceKind();
  if (!kind) {
    return { ok: false, message: `no supported supervisor on ${process.platform}; use \`codeman web -d\` instead` };
  }

  const plan = resolveServicePlan(kind, options);
  const unitPath = unitPathFor(kind);
  const warnings: string[] = [];
  mkdirSync(dirname(unitPath), { recursive: true });

  if (kind === 'launchd') {
    const uid = process.getuid?.() ?? 0;
    // Unload any previous copy first, otherwise bootstrap fails with "service
    // already loaded" and leaves the OLD job running against the NEW file.
    run('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
    writeFileSync(unitPath, buildLaunchAgentPlist(plan), { encoding: 'utf-8', mode: 0o600 });
    const bootstrap = run('launchctl', ['bootstrap', `gui/${uid}`, unitPath]);
    if (!bootstrap.ok) {
      const legacy = run('launchctl', ['load', unitPath]);
      if (!legacy.ok) {
        return {
          ok: false,
          unitPath,
          message: `wrote ${unitPath} but launchctl refused to load it: ${bootstrap.output}`,
        };
      }
    }
  } else {
    writeFileSync(unitPath, buildSystemdUnit(plan), { encoding: 'utf-8', mode: 0o600 });
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    if (!reload.ok) {
      return {
        ok: false,
        unitPath,
        message: `wrote ${unitPath} but \`systemctl --user daemon-reload\` failed: ${reload.output}`,
      };
    }
    const enable = run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    if (!enable.ok) {
      return { ok: false, unitPath, message: `wrote ${unitPath} but enabling it failed: ${enable.output}` };
    }
    // Without lingering the unit stops at logout, which is exactly what someone
    // installing a service does not want. Best effort: it needs polkit rights.
    const linger = run('loginctl', ['enable-linger', userInfo().username]);
    if (!linger.ok) {
      warnings.push(
        `could not enable lingering, so the service will stop when you log out. Run: sudo loginctl enable-linger ${userInfo().username}`
      );
    }
  }

  const url = buildBaseUrl(options);
  const statusUrl = buildStatusUrl(options);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = await probeServer(statusUrl, 1000);
    if (probe.up) {
      return { ok: true, unitPath, warnings, message: `service installed and responding at ${url}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const hint =
    kind === 'launchd' ? `tail -20 ${plan.logPath}` : `journalctl --user -u ${SYSTEMD_UNIT} -n 20 --no-pager`;
  return {
    ok: false,
    unitPath,
    warnings,
    message: `wrote and loaded ${unitPath}, but nothing answered ${url} within 30s. Check: ${hint}`,
  };
}

export function uninstallService(): ServiceActionResult {
  const kind = detectServiceKind();
  if (!kind) return { ok: false, message: `no supported supervisor on ${process.platform}` };

  const unitPath = unitPathFor(kind);
  if (!existsSync(unitPath)) {
    return { ok: false, unitPath, message: `no service installed at ${unitPath}` };
  }

  if (kind === 'launchd') {
    const uid = process.getuid?.() ?? 0;
    const bootout = run('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
    if (!bootout.ok) run('launchctl', ['unload', unitPath]);
  } else {
    run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  }

  try {
    unlinkSync(unitPath);
  } catch (err) {
    return { ok: false, unitPath, message: `stopped the service but could not remove ${unitPath}: ${String(err)}` };
  }
  if (kind === 'systemd') run('systemctl', ['--user', 'daemon-reload']);

  return { ok: true, unitPath, message: `service stopped and ${unitPath} removed. Your tmux sessions are untouched.` };
}

export async function serviceStatus(options: WebLaunchOptions): Promise<ServiceStatusResult> {
  const kind = detectServiceKind();
  const url = buildBaseUrl(options);
  if (!kind) {
    return { kind: null, name: '', unitPath: '', installed: false, loaded: false, responding: false, url };
  }

  const unitPath = unitPathFor(kind);
  const name = kind === 'launchd' ? LAUNCHD_LABEL : SYSTEMD_UNIT;
  const installed = existsSync(unitPath);
  const loaded =
    kind === 'launchd'
      ? run('launchctl', ['list', LAUNCHD_LABEL]).ok
      : run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]).output === 'active';
  const probe = await probeServer(buildStatusUrl(options), 2000);

  return { kind, name, unitPath, installed, loaded, responding: probe.up, version: probe.version, url };
}
