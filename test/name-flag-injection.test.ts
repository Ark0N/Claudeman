/**
 * @fileoverview Tests for the version-gated `--name <session name>` claude spawn flag.
 *
 * The flag makes a Codeman claude worker's cross-session-messaging peer name equal
 * its Codeman session name. The gate MUST be fail-closed: a claude CLI older than
 * 2.1.224 aborts startup on an unknown option, which would kill every session spawn,
 * so an unknown/absent version must produce a command byte-identical to the
 * pre-`--name` one. Covers both spawn paths (buildInteractiveArgs for the direct
 * PTY fallback, buildSpawnCommand for the tmux pane command) plus the allowlist
 * sanitizer that keeps the double-quoted shell interpolation injection-free.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveArgs,
  buildNameCliArgs,
  sanitizeCliSessionName,
  CLAUDE_NAME_FLAG_MIN_VERSION,
} from '../src/session-cli-builder.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';

describe('sanitizeCliSessionName', () => {
  it('passes ordinary Codeman session names through', () => {
    expect(sanitizeCliSessionName('w1-msgtest-worker')).toBe('w1-msgtest-worker');
    expect(sanitizeCliSessionName('w18-claudeman: pi')).toBe('w18-claudeman: pi');
  });

  it('keeps Unicode letters (CJK session names survive)', () => {
    expect(sanitizeCliSessionName('会话-测试 w2')).toBe('会话-测试 w2');
  });

  it('strips every character that is special inside double quotes', () => {
    const cleaned = sanitizeCliSessionName('w1"; $(rm -rf /) `boom` \\ $HOME');
    expect(cleaned).toBeDefined();
    // The double-quote interpolation in buildSpawnCommand is only safe because
    // none of these can survive: " $ ` \ and newlines.
    expect(cleaned).not.toMatch(/["$`\\\n\r]/);
    expect(cleaned).not.toMatch(/[();/]/);
  });

  it('strips leading dashes so the value cannot parse as another CLI option', () => {
    expect(sanitizeCliSessionName('--resume')).toBe('resume');
    expect(sanitizeCliSessionName('-x')).toBe('x');
  });

  it('collapses whitespace and caps length at 64', () => {
    expect(sanitizeCliSessionName('a   b\t c')).toBe('a b c');
    const long = 'x'.repeat(200);
    expect(sanitizeCliSessionName(long)).toHaveLength(64);
  });

  it('returns undefined when nothing safe remains (flag must be omitted, never --name "")', () => {
    expect(sanitizeCliSessionName(undefined)).toBeUndefined();
    expect(sanitizeCliSessionName('')).toBeUndefined();
    expect(sanitizeCliSessionName('"$`\\')).toBeUndefined();
    expect(sanitizeCliSessionName('---')).toBeUndefined();
  });
});

describe('buildNameCliArgs version gate', () => {
  it('emits the flag from the minimum version up', () => {
    // 2.1.224 ships cross-session messaging AND is verified (locally, --help)
    // to accept --name; the constant must never drift below it.
    expect(CLAUDE_NAME_FLAG_MIN_VERSION).toBe('2.1.224');
    expect(buildNameCliArgs('w1-a', '2.1.224')).toEqual(['--name', 'w1-a']);
    expect(buildNameCliArgs('w1-a', '2.1.226')).toEqual(['--name', 'w1-a']);
    expect(buildNameCliArgs('w1-a', '2.2.0')).toEqual(['--name', 'w1-a']);
    expect(buildNameCliArgs('w1-a', '3.0.0')).toEqual(['--name', 'w1-a']);
  });

  it('FAILS CLOSED below the minimum and on unknown versions', () => {
    // An older CLI aborts startup on an unknown flag: [] here is what keeps
    // every spawn alive on old installs.
    expect(buildNameCliArgs('w1-a', '2.1.223')).toEqual([]);
    expect(buildNameCliArgs('w1-a', '2.0.999')).toEqual([]);
    expect(buildNameCliArgs('w1-a', '1.0.128')).toEqual([]);
    expect(buildNameCliArgs('w1-a', null)).toEqual([]);
    expect(buildNameCliArgs('w1-a', undefined)).toEqual([]);
  });

  it('omits the flag entirely when the name sanitizes away or is absent', () => {
    expect(buildNameCliArgs(undefined, '2.1.226')).toEqual([]);
    expect(buildNameCliArgs('"$`', '2.1.226')).toEqual([]);
  });
});

describe('buildInteractiveArgs with a session name (direct PTY path)', () => {
  it('appends --name when the version supports it', () => {
    const args = buildInteractiveArgs(
      'sid-1',
      'dangerously-skip-permissions',
      undefined,
      undefined,
      undefined,
      'w1-a',
      '2.1.226'
    );
    const idx = args.indexOf('--name');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('w1-a');
  });

  it('omits --name on an old or unknown version', () => {
    expect(
      buildInteractiveArgs('sid-1', 'dangerously-skip-permissions', undefined, undefined, undefined, 'w1-a', '2.1.223')
    ).not.toContain('--name');
    expect(
      buildInteractiveArgs('sid-1', 'dangerously-skip-permissions', undefined, undefined, undefined, 'w1-a', null)
    ).not.toContain('--name');
    // Version parameter omitted entirely = same fail-closed omission
    expect(
      buildInteractiveArgs('sid-1', 'dangerously-skip-permissions', undefined, undefined, undefined, 'w1-a')
    ).not.toContain('--name');
  });
});

describe('buildSpawnCommand with a session name (tmux path)', () => {
  const base = {
    mode: 'claude' as const,
    sessionId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
    claudeMode: 'dangerously-skip-permissions' as const,
  };

  it('appends a quoted --name when the injected version supports it', () => {
    const cmd = buildSpawnCommand({ ...base, sessionName: 'w1-msgtest-worker', claudeCliVersion: '2.1.226' });
    expect(cmd).toContain(' --name "w1-msgtest-worker"');
  });

  it('stays byte-identical to the flagless command on an old version', () => {
    const withOld = buildSpawnCommand({ ...base, sessionName: 'w1-a', claudeCliVersion: '2.1.223' });
    const without = buildSpawnCommand({ ...base, claudeCliVersion: '2.1.223' });
    expect(withOld).toBe(without);
    expect(withOld).not.toContain('--name');
  });

  it('stays byte-identical when the version probe failed (null)', () => {
    const cmd = buildSpawnCommand({ ...base, sessionName: 'w1-a', claudeCliVersion: null });
    expect(cmd).toBe(buildSpawnCommand({ ...base, claudeCliVersion: null }));
  });

  it('defaults fail-closed when no version is injected (vitest probe is hermetically null)', () => {
    // In production the omitted field resolves through getClaudeCliVersion();
    // under vitest that is null by design, which doubles as the fail-closed pin.
    const cmd = buildSpawnCommand({ ...base, sessionName: 'w1-a' });
    expect(cmd).not.toContain('--name');
  });

  it('carries the flag in BOTH branches of the resume fallback chain', () => {
    const cmd = buildSpawnCommand({
      ...base,
      sessionName: 'w1-a',
      claudeCliVersion: '2.1.226',
      resumeSessionId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
    });
    const occurrences = cmd.split(' --name "w1-a"').length - 1;
    expect(cmd).toContain(' || ');
    expect(occurrences).toBe(2);
  });

  it('sanitizes a hostile name before interpolation', () => {
    const cmd = buildSpawnCommand({
      ...base,
      sessionName: 'w1"; rm -rf /; echo "',
      claudeCliVersion: '2.1.226',
    });
    const m = cmd.match(/ --name "([^"]*)"/);
    expect(m).not.toBeNull();
    // Whatever remains inside the quotes must be inert: no quote/dollar/backtick/
    // backslash can survive the allowlist, so the shell sees one literal argv.
    expect(m![1]).not.toMatch(/["$`\\;/]/);
  });

  it('never adds --name to non-claude modes', () => {
    const cmd = buildSpawnCommand({ mode: 'shell', sessionId: base.sessionId, sessionName: 'w1-a' });
    expect(cmd).not.toContain('--name');
  });
});
