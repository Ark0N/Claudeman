/**
 * @fileoverview Tests for nice-wrapper utility
 *
 * Tests the wrapWithNice function that prepends `nice -n <value>`
 * to shell commands for CPU priority adjustment.
 */

import { describe, it, expect } from 'vitest';
import { wrapWithNice } from '../src/utils/nice-wrapper.js';
import type { NiceConfig } from '../src/types.js';

describe('wrapWithNice', () => {
  it('should return command unchanged when disabled', () => {
    const config: NiceConfig = { enabled: false, niceValue: 10 };
    expect(wrapWithNice('claude --dangerously-skip-permissions', config)).toBe(
      'claude --dangerously-skip-permissions',
    );
  });

  it('should wrap command with nice when enabled', () => {
    const config: NiceConfig = { enabled: true, niceValue: 10 };
    expect(wrapWithNice('claude --dangerously-skip-permissions', config)).toBe(
      'nice -n 10 claude --dangerously-skip-permissions',
    );
  });

  it('should support negative nice values', () => {
    const config: NiceConfig = { enabled: true, niceValue: -5 };
    expect(wrapWithNice('some-cmd', config)).toBe('nice -n -5 some-cmd');
  });

  it('should clamp nice value to max 19', () => {
    const config: NiceConfig = { enabled: true, niceValue: 50 };
    expect(wrapWithNice('cmd', config)).toBe('nice -n 19 cmd');
  });

  it('should clamp nice value to min -20', () => {
    const config: NiceConfig = { enabled: true, niceValue: -100 };
    expect(wrapWithNice('cmd', config)).toBe('nice -n -20 cmd');
  });

  it('should handle zero nice value', () => {
    const config: NiceConfig = { enabled: true, niceValue: 0 };
    expect(wrapWithNice('cmd', config)).toBe('nice -n 0 cmd');
  });

  it('should handle boundary nice values exactly', () => {
    expect(wrapWithNice('cmd', { enabled: true, niceValue: 19 })).toBe('nice -n 19 cmd');
    expect(wrapWithNice('cmd', { enabled: true, niceValue: -20 })).toBe('nice -n -20 cmd');
  });

  it('should preserve complex commands with pipes and redirects', () => {
    const config: NiceConfig = { enabled: true, niceValue: 10 };
    const cmd = 'bash -c "echo hello | grep h > /tmp/out"';
    expect(wrapWithNice(cmd, config)).toBe(`nice -n 10 ${cmd}`);
  });

  it('should handle empty command string', () => {
    const config: NiceConfig = { enabled: true, niceValue: 10 };
    expect(wrapWithNice('', config)).toBe('nice -n 10 ');
  });
});
