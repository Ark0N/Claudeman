/**
 * @fileoverview Tests for CLI environment builders.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { buildMuxAttachEnv } from '../src/session-cli-builder.js';

describe('buildMuxAttachEnv', () => {
  it('does not pass an inherited tmux context into tmux attach clients', () => {
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    process.env.TMUX = '/tmp/tmux-1000/codeman,1169416,9';
    process.env.TMUX_PANE = '%9';

    try {
      const env = buildMuxAttachEnv();

      expect(env.TMUX).toBeUndefined();
      expect(env.TMUX_PANE).toBeUndefined();
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      if (originalTmuxPane === undefined) {
        delete process.env.TMUX_PANE;
      } else {
        process.env.TMUX_PANE = originalTmuxPane;
      }
    }
  });

  // COD-115: `{...process.env, TMUX: undefined}` leaves the KEY present with value
  // undefined; node-pty serializes that as the literal string "TMUX=undefined", which
  // still trips tmux's nesting guard and kills the attach-bridge PTY (exit 1 → respawn
  // loop). The keys must be genuinely ABSENT, which only `delete` achieves.
  it('deletes tmux/claude context keys entirely (absent, not present-with-undefined) (COD-115)', () => {
    const saved = {
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      CLAUDECODE: process.env.CLAUDECODE,
    };
    process.env.TMUX = '/tmp/tmux-1000/codeman,1169416,9';
    process.env.TMUX_PANE = '%9';
    process.env.CLAUDECODE = '1';

    try {
      const env = buildMuxAttachEnv();

      expect('TMUX' in env).toBe(false);
      expect('TMUX_PANE' in env).toBe(false);
      expect('CLAUDECODE' in env).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });
});
