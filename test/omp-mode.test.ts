import { describe, expect, it } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { defaultDockerCommandForMode } from '../src/docker-hosts.js';
import { defaultRemoteCommandForMode } from '../src/remote-hosts.js';
import { isExternalCliMode, isAltScreenStripMode } from '../src/session.js';

describe('OMP mode schemas', () => {
  it('accepts OMP session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'omp',
      ompConfig: {
        model: 'crof/glm-5.2',
      },
    });

    expect(parsed.mode).toBe('omp');
    expect(parsed.ompConfig).toEqual({
      model: 'crof/glm-5.2',
    });
  });

  it('accepts OMP quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'omp-case',
      mode: 'omp',
      ompConfig: {
        resumeSessionId: 'session-1234abcd',
      },
    });

    expect(parsed.mode).toBe('omp');
    expect(parsed.ompConfig?.resumeSessionId).toBe('session-1234abcd');
  });

  it('rejects unsafe OMP model strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'omp',
        ompConfig: { model: 'omp; rm -rf /' },
      })
    ).toThrow();
  });

  it('allows OMP_* env overrides and still rejects unknown prefixes', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'omp',
      envOverrides: { OMP_PROFILE: 'work' },
    });
    expect(parsed.envOverrides).toEqual({ OMP_PROFILE: 'work' });

    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        envOverrides: { RANDOM_PREFIX_KEY: 'x' },
      })
    ).toThrow();
  });
});

describe('OMP spawn command', () => {
  it('builds a bare omp command when no config is sent', () => {
    const cmd = buildSpawnCommand({ mode: 'omp', sessionId: 'abc12345' });
    expect(cmd).toBe('omp');
  });

  it('passes --model and --resume, and drops unsafe ids', () => {
    expect(
      buildSpawnCommand({
        mode: 'omp',
        sessionId: 'abc12345',
        ompConfig: { model: 'crof/glm-5.2', resumeSessionId: 'session-99' },
      })
    ).toBe('omp --model crof/glm-5.2 --resume session-99');

    expect(
      buildSpawnCommand({
        mode: 'omp',
        sessionId: 'abc12345',
        ompConfig: { resumeSessionId: 'x; rm -rf /' },
      })
    ).toBe('omp');
  });

  it('drops unsafe model strings from the spawn command', () => {
    expect(
      buildSpawnCommand({
        mode: 'omp',
        sessionId: 'abc12345',
        ompConfig: { model: 'a`b' },
      })
    ).toBe('omp');
  });
});

describe('OMP mode gates', () => {
  it('is an external CLI mode (readiness/ralph/respawn gating)', () => {
    expect(isExternalCliMode('omp')).toBe(true);
  });

  it('is NOT an alt-screen strip mode (unverified TUI, like opencode/antigravity)', () => {
    expect(isAltScreenStripMode('omp')).toBe(false);
  });

  it('has docker/remote default commands', () => {
    expect(defaultDockerCommandForMode('omp')).toBe('exec omp');
    // Routed through an interactive login shell so per-user PATH entries resolve —
    // same fix as the other remote agent CLIs (see defaultRemoteCommandForMode).
    expect(defaultRemoteCommandForMode('omp')).toBe('exec "${SHELL:-/bin/sh}" -i -l -c \'omp\'');
  });
});
