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

interface RespawnStatus {
  enabled: boolean;
  state: string;
  cycleCount: number;
}

interface StatusBarProps {
  session: ScreenSession | null;
  inputMode?: boolean;
  respawnStatus?: RespawnStatus | null;
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
export function StatusBar({ session, inputMode = false, respawnStatus }: StatusBarProps): React.ReactElement {
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
  const sessionName = session.name || 'unnamed';

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      {/* Left side: Session info */}
      <Box>
        <Text color="cyan" bold>
          {sessionName}
        </Text>
        <Text> | </Text>
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
        {inputMode && (
          <>
            <Text> | </Text>
            <Text color="yellow" bold>INPUT MODE</Text>
          </>
        )}
        {respawnStatus?.enabled && (
          <>
            <Text> | </Text>
            <Text color="magenta">
              respawn: {respawnStatus.state.replace(/_/g, ' ')}
              {respawnStatus.cycleCount > 0 && ` (${respawnStatus.cycleCount})`}
            </Text>
          </>
        )}
      </Box>

      {/* Right side: Keyboard hints */}
      <Box>
        <Text dimColor>? help | Esc back | type to send input</Text>
      </Box>
    </Box>
  );
}
