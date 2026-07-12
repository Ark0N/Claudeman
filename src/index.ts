#!/usr/bin/env node
/**
 * @fileoverview Codeman CLI entry point
 *
 * This is the main executable entry point for the Codeman CLI.
 * It sets up global error handlers and invokes the CLI parser.
 *
 * @module index
 */

import { program } from './cli.js';

// Detect if we're running the web server (long-lived process)
// In web mode, we should NOT exit on transient errors — log and continue
const isWebMode = process.argv.includes('web');

// COD-115: Codeman IS a tmux controller; it must never present as a tmux *client*.
// If the web server is launched from inside a tmux pane it inherits TMUX/TMUX_PANE,
// and tmux's nesting guard then kills every new attach-bridge PTY (exit 1 → respawn
// loop, crash-looping any new tmux-backed session). Scrub at the root so every
// downstream `{...process.env}` spread (attach, send-keys, create) is clean regardless
// of launch context. `delete` (not `= undefined`, which node-pty serializes as the
// literal string "undefined" and fails to clear).
if (isWebMode) {
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
}

import { MAX_CONSECUTIVE_ERRORS, ERROR_RESET_MS } from './config/server-timing.js';

// Track consecutive unhandled errors in web mode — restart after too many
let consecutiveErrors = 0;
let errorResetTimer: ReturnType<typeof setTimeout> | null = null;

function trackError(): void {
  consecutiveErrors++;
  if (errorResetTimer) clearTimeout(errorResetTimer);
  errorResetTimer = setTimeout(() => {
    consecutiveErrors = 0;
  }, ERROR_RESET_MS);

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.error(`[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive unhandled errors — exiting for systemd restart`);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  if (isWebMode) {
    console.error('[RECOVERED] Server continuing after uncaught exception:', err.stack);
    trackError();
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (isWebMode) {
    console.error('[RECOVERED] Server continuing after unhandled rejection');
    trackError();
  } else {
    process.exit(1);
  }
});

// Run CLI
program.parse();
