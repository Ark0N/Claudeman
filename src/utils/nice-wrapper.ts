/**
 * @fileoverview Shared utility for wrapping commands with `nice` priority.
 *
 * Extracted from screen-manager.ts so both tmux-manager and screen-manager
 * can use it without cross-dependency on the deprecated screen module.
 *
 * @module utils/nice-wrapper
 */

import type { NiceConfig } from '../types.js';

/**
 * Wraps a command with `nice` for priority adjustment.
 */
export function wrapWithNice(cmd: string, config: NiceConfig): string {
  if (!config.enabled) return cmd;
  const niceValue = Math.max(-20, Math.min(19, config.niceValue));
  return `nice -n ${niceValue} ${cmd}`;
}
