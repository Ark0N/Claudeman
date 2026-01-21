/**
 * @fileoverview TabBar component
 *
 * Horizontal tab bar showing all active sessions.
 * Features:
 * - Visual indication of active tab
 * - Status indicator (idle/working)
 * - Tab truncation for long names
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ScreenSession } from '../../types.js';

interface TabBarProps {
  sessions: ScreenSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}

/**
 * TabBar component for session navigation
 */
export function TabBar({
  sessions,
  activeSessionId,
}: TabBarProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>No sessions</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      {sessions.map((session, index) => {
        const isActive = session.sessionId === activeSessionId;
        const name = (session.name || 'unnamed').slice(0, 15);
        // Status indicator: filled circle for alive, hollow for dead
        const statusIcon = session.attached ? '\u25CF' : '\u25CB';
        const statusColor = session.attached ? 'green' : 'red';

        return (
          <Box key={session.sessionId} marginRight={1}>
            {isActive ? (
              <Text backgroundColor="blue" color="white" bold>
                {' '}
                <Text color={statusColor}>{statusIcon}</Text> {name}{' '}
              </Text>
            ) : (
              <Text>
                {' '}
                <Text color={statusColor}>{statusIcon}</Text>{' '}
                <Text dimColor>{name}</Text>{' '}
              </Text>
            )}
            {index < sessions.length - 1 && <Text dimColor>|</Text>}
          </Box>
        );
      })}

      {/* Shortcut hint */}
      <Box flexGrow={1} justifyContent="flex-end">
        <Text dimColor>Ctrl+Tab: switch | Ctrl+W: close</Text>
      </Box>
    </Box>
  );
}
