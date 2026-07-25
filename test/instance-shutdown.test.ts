import { describe, expect, it } from 'vitest';
import {
  buildSupervisorShutdownCommand,
  parseCodemanSystemdMembership,
  parseLaunchdPid,
  resolveInstanceShutdownStrategy,
} from '../src/web/instance-shutdown.js';

describe('instance shutdown supervisor detection', () => {
  it('accepts only a Codeman service from the current systemd cgroup', () => {
    expect(
      parseCodemanSystemdMembership('0::/user.slice/user-1000.slice/user@1000.service/app.slice/codeman-web.service\n')
    ).toEqual({ unit: 'codeman-web.service', scope: 'user' });
    expect(parseCodemanSystemdMembership('0::/system.slice/docker.service\n')).toBeNull();
  });

  it('resolves a user systemd service without probing a global service', () => {
    expect(
      resolveInstanceShutdownStrategy({
        platform: 'linux',
        pid: 42,
        uid: 1000,
        cgroupText: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/codeman-beta.service\n',
        systemdMainPid: () => 42,
      })
    ).toEqual({
      kind: 'systemd',
      apiName: 'systemd-user',
      scope: 'user',
      unit: 'codeman-beta.service',
    });
  });

  it('does not pretend a non-root process can stop a system service', () => {
    expect(
      resolveInstanceShutdownStrategy({
        platform: 'linux',
        pid: 42,
        uid: 1000,
        cgroupText: '0::/system.slice/codeman-web.service\n',
        systemdMainPid: () => 42,
      })
    ).toMatchObject({ kind: 'unsupported' });
  });

  it('treats an unsupervised process as a manual graceful shutdown', () => {
    expect(
      resolveInstanceShutdownStrategy({
        platform: 'linux',
        pid: 42,
        uid: 1000,
        cgroupText: '0::/user.slice/user-1000.slice/session-2.scope\n',
      })
    ).toEqual({ kind: 'manual', apiName: 'manual' });
  });

  it('does not stop a service inherited by a nested preview process', () => {
    expect(
      resolveInstanceShutdownStrategy({
        platform: 'linux',
        pid: 84,
        uid: 1000,
        cgroupText: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/codeman-web.service\n',
        systemdMainPid: () => 42,
      })
    ).toEqual({ kind: 'manual', apiName: 'manual' });
  });

  it('uses launchd only when its exact job owns the current PID', () => {
    const output = (target: string) => (target === 'gui/501/com.codeman.web' ? '{\n  pid = 73\n}\n' : null);

    expect(
      resolveInstanceShutdownStrategy({
        platform: 'darwin',
        pid: 73,
        uid: 501,
        launchdPrint: output,
      })
    ).toEqual({
      kind: 'launchd',
      apiName: 'launchd-user',
      target: 'gui/501/com.codeman.web',
    });
    expect(
      resolveInstanceShutdownStrategy({
        platform: 'darwin',
        pid: 74,
        uid: 501,
        launchdPrint: output,
      })
    ).toEqual({ kind: 'manual', apiName: 'manual' });
  });

  it('parses launchd PID output defensively', () => {
    expect(parseLaunchdPid('state = running\npid = 123\n')).toBe(123);
    expect(parseLaunchdPid('last exit code = 123\n')).toBeNull();
    expect(parseLaunchdPid(null)).toBeNull();
  });

  it('builds supervisor commands without a shell', () => {
    expect(
      buildSupervisorShutdownCommand({
        kind: 'systemd',
        apiName: 'systemd-user',
        scope: 'user',
        unit: 'codeman-web.service',
      })
    ).toEqual({
      command: 'systemctl',
      args: ['--user', '--no-block', 'stop', 'codeman-web.service'],
    });
    expect(
      buildSupervisorShutdownCommand({
        kind: 'launchd',
        apiName: 'launchd-user',
        target: 'gui/501/com.codeman.web',
      })
    ).toEqual({
      command: 'launchctl',
      args: ['bootout', 'gui/501/com.codeman.web'],
    });
  });
});
