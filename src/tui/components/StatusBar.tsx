/**
 * @fileoverview StatusBar component
 *
 * Bottom status bar showing:
 * - Session status (idle/working)
 * - Token count
 * - Cost
 * - Runtime
 * - Quick keyboard shortcuts
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ScreenSession } from '../../types.js';

interface StatusBarProps {
  session: ScreenSession | null;
}

/**
 * Formats duration from milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * StatusBar component showing session information
 */
export function StatusBar({ session }: StatusBarProps): React.ReactElement {
  if (!session) {
    return (
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text dimColor>No session selected</Text>
        <Text dimColor>Press ? for help | Esc to go back</Text>
      </Box>
    );
  }

  const runtime = formatDuration(Date.now() - session.createdAt);
  const statusColor = session.attached ? 'green' : 'red';
  const statusText = session.attached ? 'alive' : 'dead';

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      {/* Left side: Session info */}
      <Box>
        <Text color={statusColor} bold>
          {'\u25CF'} {statusText}
        </Text>
        <Text> | </Text>
        <Text>
          <Text dimColor>runtime:</Text> {runtime}
        </Text>
        <Text> | </Text>
        <Text>
          <Text dimColor>mode:</Text> {session.mode}
        </Text>
        <Text> | </Text>
        <Text>
          <Text dimColor>screen:</Text> {session.screenName}
        </Text>
      </Box>

      {/* Right side: Keyboard hints */}
      <Box>
        <Text dimColor>? help | Esc back | Ctrl+C exit</Text>
      </Box>
    </Box>
  );
}
