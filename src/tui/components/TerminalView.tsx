/**
 * @fileoverview TerminalView component
 *
 * Displays PTY output from the active session.
 * Features:
 * - Scrollable viewport showing last N lines
 * - ANSI color support (handled by Ink)
 * - Visual border indicating focus
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ScreenSession } from '../../types.js';

interface TerminalViewProps {
  output: string;
  height: number;
  session: ScreenSession | null;
}

/**
 * TerminalView component for PTY output display
 */
export function TerminalView({
  output,
  height,
  session,
}: TerminalViewProps): React.ReactElement {
  // Split output into lines and get the last N lines that fit
  const displayLines = useMemo(() => {
    if (!output) return [];

    const lines = output.split('\n');
    // Reserve 2 lines for border
    const visibleLines = height - 2;

    if (lines.length <= visibleLines) {
      return lines;
    }

    // Return last N lines
    return lines.slice(-visibleLines);
  }, [output, height]);

  if (!session) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        height={height}
        paddingX={1}
      >
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text dimColor>No session selected</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="green"
      height={height}
      paddingX={1}
      overflow="hidden"
    >
      {/* Terminal content */}
      <Box flexDirection="column" flexGrow={1}>
        {displayLines.length === 0 ? (
          <Text dimColor>Waiting for output...</Text>
        ) : (
          displayLines.map((line, index) => (
            <Text key={index} wrap="truncate">
              {line}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
