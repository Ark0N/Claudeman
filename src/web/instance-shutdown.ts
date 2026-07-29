/**
 * @fileoverview Detects and stops the supervisor that owns the running Codeman process.
 *
 * A supervised Codeman service uses an automatic restart policy. Exiting the Node
 * process directly would therefore restart it, so shutdown must target the exact
 * systemd/launchd unit that owns this PID. Unsupervised dev/manual processes use
 * WebServer.stop() instead.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
const LAUNCHD_LABEL = 'com.codeman.web';
const CODEMAN_SYSTEMD_UNIT_RE = /^codeman(?:[-.@][A-Za-z0-9_.@-]+)?\.service$/;

export type ResolvedShutdownStrategy =
  | { kind: 'manual'; apiName: 'manual' }
  | {
      kind: 'systemd';
      apiName: 'systemd-user' | 'systemd-system';
      scope: 'user' | 'system';
      unit: string;
    }
  | {
      kind: 'launchd';
      apiName: 'launchd-user' | 'launchd-system';
      target: string;
    }
  | { kind: 'unsupported'; reason: string };

interface ShutdownProbe {
  platform: NodeJS.Platform;
  pid: number;
  uid: number | undefined;
  cgroupText?: string | null;
  systemdMainPid?: (scope: 'user' | 'system', unit: string) => number | null;
  launchdPrint?: (target: string) => string | null;
}

export function parseCodemanSystemdMembership(cgroupText: string): { unit: string; scope: 'user' | 'system' } | null {
  for (const line of cgroupText.split(/\r?\n/)) {
    const path = line.slice(line.lastIndexOf(':') + 1);
    const segments = path.split('/').filter(Boolean);
    let unit: string | undefined;
    for (let index = segments.length - 1; index >= 0; index--) {
      if (CODEMAN_SYSTEMD_UNIT_RE.test(segments[index])) {
        unit = segments[index];
        break;
      }
    }
    if (unit === undefined) continue;
    const scope = path.includes('/user.slice/') || path.includes('/user@') ? 'user' : 'system';
    return { unit, scope };
  }
  return null;
}

export function parseLaunchdPid(output: string | null): number | null {
  const match = output?.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function resolveInstanceShutdownStrategy(probe: ShutdownProbe): ResolvedShutdownStrategy {
  if (probe.platform === 'linux') {
    const membership = probe.cgroupText ? parseCodemanSystemdMembership(probe.cgroupText) : null;
    if (!membership) return { kind: 'manual', apiName: 'manual' };
    // A preview launched from a service-owned shell can share its cgroup. Stop
    // the unit only when this process is the unit's actual MainPID.
    if (probe.systemdMainPid?.(membership.scope, membership.unit) !== probe.pid) {
      return { kind: 'manual', apiName: 'manual' };
    }
    if (membership.scope === 'system' && probe.uid !== 0) {
      return {
        kind: 'unsupported',
        reason: `Codeman is managed by system service ${membership.unit}; stopping it requires administrator access`,
      };
    }
    return {
      kind: 'systemd',
      apiName: membership.scope === 'user' ? 'systemd-user' : 'systemd-system',
      scope: membership.scope,
      unit: membership.unit,
    };
  }

  if (probe.platform === 'darwin') {
    const printTarget = probe.launchdPrint;
    if (!printTarget) return { kind: 'manual', apiName: 'manual' };

    if (probe.uid !== undefined) {
      const userTarget = `gui/${probe.uid}/${LAUNCHD_LABEL}`;
      if (parseLaunchdPid(printTarget(userTarget)) === probe.pid) {
        return { kind: 'launchd', apiName: 'launchd-user', target: userTarget };
      }
    }

    const systemTarget = `system/${LAUNCHD_LABEL}`;
    if (parseLaunchdPid(printTarget(systemTarget)) === probe.pid) {
      if (probe.uid !== 0) {
        return {
          kind: 'unsupported',
          reason: 'Codeman is managed by a system LaunchDaemon; stopping it requires administrator access',
        };
      }
      return { kind: 'launchd', apiName: 'launchd-system', target: systemTarget };
    }
  }

  return { kind: 'manual', apiName: 'manual' };
}

function tryLaunchdPrint(target: string): string | null {
  try {
    return execFileSync('launchctl', ['print', target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

function trySystemdMainPid(scope: 'user' | 'system', unit: string): number | null {
  try {
    const args =
      scope === 'user'
        ? ['--user', 'show', unit, '--property', 'MainPID', '--value']
        : ['show', unit, '--property', 'MainPID', '--value'];
    const output = execFileSync('systemctl', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    const pid = Number(output);
    return /^\d+$/.test(output) && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function detectInstanceShutdownStrategy(): ResolvedShutdownStrategy {
  let cgroupText: string | null = null;
  if (process.platform === 'linux') {
    try {
      cgroupText = readFileSync('/proc/self/cgroup', 'utf8');
    } catch {
      // Non-systemd Linux and restricted containers are manual processes.
    }
  }

  return resolveInstanceShutdownStrategy({
    platform: process.platform,
    pid: process.pid,
    uid: process.getuid?.(),
    cgroupText,
    systemdMainPid: process.platform === 'linux' ? trySystemdMainPid : undefined,
    launchdPrint: process.platform === 'darwin' ? tryLaunchdPrint : undefined,
  });
}

export function startSupervisorShutdown(
  strategy: Exclude<ResolvedShutdownStrategy, { kind: 'manual' | 'unsupported' }>
): ChildProcess {
  const { command, args } = buildSupervisorShutdownCommand(strategy);
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

export function buildSupervisorShutdownCommand(
  strategy: Exclude<ResolvedShutdownStrategy, { kind: 'manual' | 'unsupported' }>
): { command: 'systemctl' | 'launchctl'; args: string[] } {
  let command: 'systemctl' | 'launchctl';
  let args: string[];

  if (strategy.kind === 'systemd') {
    command = 'systemctl';
    args =
      strategy.scope === 'user'
        ? ['--user', '--no-block', 'stop', strategy.unit]
        : ['--no-block', 'stop', strategy.unit];
  } else {
    command = 'launchctl';
    args = ['bootout', strategy.target];
  }

  return { command, args };
}
