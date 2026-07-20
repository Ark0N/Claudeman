/**
 * @fileoverview Tests for Claude CLI startup permission modes, focused on the
 * 'auto' mode (`--permission-mode auto`, Anthropic's recommended low-prompt mode)
 * added alongside the default `--dangerously-skip-permissions`.
 *
 * Covers BOTH spawn paths, which build the permission flags independently:
 * - session-cli-builder.buildInteractiveArgs (direct PTY, non-mux fallback)
 * - tmux-manager.buildSpawnCommand (tmux pane command string)
 * The default must stay 'dangerously-skip-permissions' when the setting is unset.
 */

import { describe, it, expect } from 'vitest';
import { buildInteractiveArgs } from '../src/session-cli-builder.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';

describe('buildInteractiveArgs permission modes (direct PTY path)', () => {
  it('keeps --dangerously-skip-permissions as the skip-mode flag', () => {
    const args = buildInteractiveArgs('sid-1', 'dangerously-skip-permissions');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('auto mode emits --permission-mode auto and never the skip flag', () => {
    const args = buildInteractiveArgs('sid-1', 'auto');
    const idx = args.indexOf('--permission-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('auto');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('normal mode emits no permission flag at all', () => {
    const args = buildInteractiveArgs('sid-1', 'normal');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('allowedTools mode is unchanged by the auto addition', () => {
    const args = buildInteractiveArgs('sid-1', 'allowedTools', undefined, 'Read,Grep');
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Read,Grep']));
    expect(args).not.toContain('--permission-mode');
  });

  it('auto mode composes with model and effort flags', () => {
    const args = buildInteractiveArgs('sid-1', 'auto', 'opus', undefined, 'high');
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'auto', '--model', 'opus', '--effort', 'high']));
  });
});

describe('buildSpawnCommand permission modes (tmux path)', () => {
  it('unset claudeMode defaults to --dangerously-skip-permissions', () => {
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1' });
    expect(cmd).toContain('claude --dangerously-skip-permissions --session-id "sid-1"');
    expect(cmd).not.toContain('--permission-mode');
  });

  it('auto mode emits --permission-mode auto and never the skip flag', () => {
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1', claudeMode: 'auto' });
    expect(cmd).toContain('claude --permission-mode auto --session-id "sid-1"');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  it('auto mode carries into BOTH legs of the resume fallback command', () => {
    const cmd = buildSpawnCommand({
      mode: 'claude',
      sessionId: 'sid-1',
      claudeMode: 'auto',
      resumeSessionId: 'abc-123',
    });
    const [resumeLeg, fallbackLeg] = cmd.split('||');
    expect(resumeLeg).toContain('--permission-mode auto');
    expect(resumeLeg).toContain('--resume "abc-123"');
    expect(fallbackLeg).toContain('--permission-mode auto');
    expect(fallbackLeg).toContain('--session-id "sid-1"');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  it('normal mode emits no permission flag', () => {
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1', claudeMode: 'normal' });
    expect(cmd).toContain('claude --session-id "sid-1"');
    expect(cmd).not.toContain('--permission-mode');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });
});
