/**
 * @fileoverview TUI entry point for Claudeman
 *
 * Renders the terminal user interface using Ink (React for CLI).
 * This provides a full-screen TUI similar to the web interface,
 * with tabs for sessions and real-time terminal output.
 */

import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

/**
 * Checks if the terminal supports raw mode (required for TUI)
 */
function isRawModeSupported(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    typeof process.stdin.setRawMode === 'function'
  );
}

/**
 * Starts the TUI application
 * @returns Promise that resolves when the app exits
 */
export async function startTUI(): Promise<void> {
  // Check if we're in an interactive terminal
  if (!isRawModeSupported()) {
    console.error('Error: TUI requires an interactive terminal with TTY support.');
    console.error('Make sure you are running this command in a real terminal, not piped.');
    process.exit(1);
  }

  // Clear the terminal for full-screen experience
  process.stdout.write('\x1b[2J\x1b[H');

  const { waitUntilExit } = render(<App />);

  await waitUntilExit();
}
