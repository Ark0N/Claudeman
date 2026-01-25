/**
 * @fileoverview Bash Tool Parser - Detects active Bash tool commands with file paths
 *
 * This module parses terminal output from Claude Code sessions to detect:
 * - Bash tool invocations (● Bash(command) pattern)
 * - File paths within commands (for tail, cat, head, grep, watch, less)
 * - Tool completion (✓ or ✗ status)
 *
 * When a file-viewing command is detected, emits events with clickable paths
 * that can be used to open live log viewer windows.
 *
 * @module bash-tool-parser
 */

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ActiveBashTool } from './types.js';

// ========== Configuration Constants ==========

/**
 * Maximum number of active tools to track per session.
 * Older tools are removed when this limit is reached.
 */
const MAX_ACTIVE_TOOLS = 20;

/**
 * Debounce interval for event emissions (milliseconds).
 * Prevents UI jitter from rapid consecutive updates.
 */
const EVENT_DEBOUNCE_MS = 50;

/**
 * Maximum line buffer size to prevent unbounded growth from long lines.
 */
const MAX_LINE_BUFFER_SIZE = 64 * 1024;

// ========== Pre-compiled Regex Patterns ==========

/**
 * Matches Bash tool invocation line from Claude Code output.
 * Pattern: ● Bash(command) or ● Bash(command) timeout: 5m 0s
 * The tool name can appear with or without the bullet point.
 *
 * Capture groups:
 * - 1: The command being executed
 * - 2: Optional timeout string
 */
const BASH_TOOL_START_PATTERN = /(?:^|\s)●?\s*Bash\((.+?)\)(?:\s+timeout:\s*([^\n]+))?/;

/**
 * Matches tool completion indicators.
 * ✓ indicates success, ✗ indicates failure.
 */
const TOOL_COMPLETION_PATTERN = /(?:✓|✗)\s+Bash/;

/**
 * Commands that view/stream file content (worth tracking for live viewing).
 * These are the commands where clicking to open a log viewer makes sense.
 */
const FILE_VIEWER_COMMANDS = /^(?:tail|cat|head|less|grep|watch|multitail)\s+/;

/**
 * Alternative: Commands with -f flag (follow mode) are especially interesting
 */
const FOLLOW_MODE_PATTERN = /\s-[A-Za-z]*f[A-Za-z]*\s|\s--follow\s/;

/**
 * Extracts file paths from a command string.
 * Matches paths starting with / or ~ followed by path characters.
 * Excludes common non-path patterns like flags.
 *
 * Note: This is a simpler approach - we run it on each command string
 * rather than trying to match globally.
 */
const FILE_PATH_PATTERN = /(?:^|\s|['"]|=)([\/~][^\s'"<>|;&\n]+)/g;

/**
 * Pattern to detect paths that are likely not real files (flags, etc.)
 */
const INVALID_PATH_PATTERN = /^[\/~]-|\/dev\/null$/;

/**
 * Pattern to detect command suggestions in plain text output.
 * Matches lines like "tail -f /path/to/file" without the ● Bash() wrapper.
 * This catches commands Claude mentions but doesn't execute.
 */
const TEXT_COMMAND_PATTERN = /^\s*(tail|cat|head|less|grep|watch|multitail)\s+(?:-[^\s]+\s+)*([\/~][^\s'"<>|;&\n]+)/;

/**
 * Pattern to detect log file paths mentioned in text (even without commands).
 * Matches paths ending in .log, .txt, .out, or in common log directories.
 */
const LOG_FILE_MENTION_PATTERN = /([\/~][^\s'"<>|;&\n]*(?:\.log|\.txt|\.out|\/log\/[^\s'"<>|;&\n]+))/g;

// ========== Event Interfaces ==========

/**
 * Events emitted by BashToolParser.
 */
export interface BashToolParserEvents {
  /** New Bash tool with file paths started */
  toolStart: [tool: ActiveBashTool];
  /** Bash tool completed */
  toolEnd: [tool: ActiveBashTool];
  /** Active tools list updated */
  toolsUpdate: [tools: ActiveBashTool[]];
}

/**
 * Configuration options for BashToolParser.
 */
export interface BashToolParserConfig {
  /** Session ID this parser belongs to */
  sessionId: string;
  /** Whether the parser is enabled (default: true) */
  enabled?: boolean;
}

// ========== BashToolParser Class ==========

/**
 * Parses Claude Code terminal output to detect Bash tool commands with file paths.
 * Emits events when file-viewing commands are detected, allowing the UI to
 * display clickable paths for opening live log viewers.
 *
 * @example
 * ```typescript
 * const parser = new BashToolParser({ sessionId: 'abc123' });
 * parser.on('toolStart', (tool) => {
 *   console.log(`New tool: ${tool.command}`);
 *   console.log(`File paths: ${tool.filePaths.join(', ')}`);
 * });
 * parser.processTerminalData(terminalOutput);
 * ```
 */
export class BashToolParser extends EventEmitter<BashToolParserEvents> {
  private _sessionId: string;
  private _enabled: boolean;
  private _activeTools: Map<string, ActiveBashTool> = new Map();
  private _lineBuffer: string = '';
  private _lastToolId: string | null = null;

  // Debouncing
  private _pendingUpdate: boolean = false;
  private _updateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: BashToolParserConfig) {
    super();
    this._sessionId = config.sessionId;
    this._enabled = config.enabled ?? true;
  }

  // ========== Public Accessors ==========

  /** Whether the parser is currently enabled */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Session ID this parser belongs to */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Currently active tools */
  get activeTools(): ActiveBashTool[] {
    return Array.from(this._activeTools.values());
  }

  // ========== Public Methods ==========

  /**
   * Enables the parser.
   */
  enable(): void {
    this._enabled = true;
  }

  /**
   * Disables the parser.
   */
  disable(): void {
    this._enabled = false;
  }

  /**
   * Resets the parser state, clearing all tracked tools.
   */
  reset(): void {
    this._activeTools.clear();
    this._lineBuffer = '';
    this._lastToolId = null;
    this.emitUpdate();
  }

  /**
   * Process terminal data to detect Bash tool patterns.
   * Call this with each chunk of PTY output.
   *
   * @param data - Raw terminal data (may include ANSI codes)
   */
  processTerminalData(data: string): void {
    if (!this._enabled) return;

    // Append to line buffer
    this._lineBuffer += data;

    // Prevent unbounded growth
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      const trimPoint = this._lineBuffer.lastIndexOf('\n', MAX_LINE_BUFFER_SIZE / 2);
      this._lineBuffer = trimPoint > 0
        ? this._lineBuffer.slice(trimPoint + 1)
        : this._lineBuffer.slice(-MAX_LINE_BUFFER_SIZE / 2);
    }

    // Process complete lines
    const lines = this._lineBuffer.split('\n');

    // Keep the last incomplete line in buffer
    this._lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }
  }

  // ========== Private Methods ==========

  /**
   * Process a single line of terminal output.
   */
  private processLine(line: string): void {
    // Strip ANSI codes for cleaner pattern matching
    const cleanLine = this.stripAnsi(line);

    // Check for tool start
    const startMatch = cleanLine.match(BASH_TOOL_START_PATTERN);
    if (startMatch) {
      const command = startMatch[1];
      const timeout = startMatch[2]?.trim();

      // Check if this is a file-viewing command
      if (this.isFileViewerCommand(command)) {
        const filePaths = this.extractFilePaths(command);

        if (filePaths.length > 0) {
          const tool: ActiveBashTool = {
            id: uuidv4(),
            command,
            filePaths,
            timeout,
            startedAt: Date.now(),
            status: 'running',
            sessionId: this._sessionId,
          };

          // Enforce max tools limit
          if (this._activeTools.size >= MAX_ACTIVE_TOOLS) {
            // Remove oldest tool
            const oldest = Array.from(this._activeTools.entries())
              .sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
            if (oldest) {
              this._activeTools.delete(oldest[0]);
            }
          }

          this._activeTools.set(tool.id, tool);
          this._lastToolId = tool.id;

          this.emit('toolStart', tool);
          this.scheduleUpdate();
        }
      }
      return;
    }

    // Check for tool completion
    if (TOOL_COMPLETION_PATTERN.test(cleanLine) && this._lastToolId) {
      const tool = this._activeTools.get(this._lastToolId);
      if (tool && tool.status === 'running') {
        tool.status = 'completed';
        this.emit('toolEnd', tool);
        this.scheduleUpdate();

        // Remove completed tool after a short delay to allow UI to show completion
        setTimeout(() => {
          this._activeTools.delete(tool.id);
          this.scheduleUpdate();
        }, 2000);
      }
      this._lastToolId = null;
      return;
    }

    // Fallback: Check for command suggestions in plain text (e.g., "tail -f /tmp/file.log")
    const textCmdMatch = cleanLine.match(TEXT_COMMAND_PATTERN);
    if (textCmdMatch) {
      const filePath = textCmdMatch[2];

      // Create a suggestion tool (marked as 'suggestion' status)
      const tool: ActiveBashTool = {
        id: uuidv4(),
        command: cleanLine.trim(),
        filePaths: [filePath],
        timeout: undefined,
        startedAt: Date.now(),
        status: 'running', // Shows as clickable
        sessionId: this._sessionId,
      };

      // Don't add duplicates (same file path within last 5 seconds)
      const isDuplicate = Array.from(this._activeTools.values()).some(
        t => t.filePaths.includes(filePath) && (Date.now() - t.startedAt) < 5000
      );

      if (!isDuplicate) {
        this._activeTools.set(tool.id, tool);
        this.emit('toolStart', tool);
        this.scheduleUpdate();

        // Auto-remove suggestions after 30 seconds
        setTimeout(() => {
          this._activeTools.delete(tool.id);
          this.scheduleUpdate();
        }, 30000);
      }
      return;
    }

    // Last fallback: Check for log file paths mentioned anywhere in the line
    LOG_FILE_MENTION_PATTERN.lastIndex = 0;
    let logMatch;
    while ((logMatch = LOG_FILE_MENTION_PATTERN.exec(cleanLine)) !== null) {
      const filePath = logMatch[1].replace(/[,;:]+$/, ''); // Clean trailing punctuation

      // Skip if it looks invalid
      if (INVALID_PATH_PATTERN.test(filePath)) continue;

      // Don't add duplicates
      const isDuplicate = Array.from(this._activeTools.values()).some(
        t => t.filePaths.includes(filePath) && (Date.now() - t.startedAt) < 10000
      );

      if (!isDuplicate) {
        const tool: ActiveBashTool = {
          id: uuidv4(),
          command: `View: ${filePath}`,
          filePaths: [filePath],
          timeout: undefined,
          startedAt: Date.now(),
          status: 'running',
          sessionId: this._sessionId,
        };

        this._activeTools.set(tool.id, tool);
        this.emit('toolStart', tool);
        this.scheduleUpdate();

        // Auto-remove after 60 seconds
        setTimeout(() => {
          this._activeTools.delete(tool.id);
          this.scheduleUpdate();
        }, 60000);
      }
    }
  }

  /**
   * Check if a command is a file-viewing command worth tracking.
   */
  private isFileViewerCommand(command: string): boolean {
    // Commands that typically view files
    if (FILE_VIEWER_COMMANDS.test(command)) {
      return true;
    }

    // Any command with -f (follow) flag is interesting
    if (FOLLOW_MODE_PATTERN.test(` ${command} `)) {
      return true;
    }

    return false;
  }

  /**
   * Extract file paths from a command string.
   */
  private extractFilePaths(command: string): string[] {
    const paths: string[] = [];
    let match;

    // Reset regex state
    FILE_PATH_PATTERN.lastIndex = 0;

    while ((match = FILE_PATH_PATTERN.exec(command)) !== null) {
      const path = match[1];

      // Skip invalid paths
      if (INVALID_PATH_PATTERN.test(path)) {
        continue;
      }

      // Skip if it looks like a flag (starts with -)
      if (path.includes('/-')) {
        continue;
      }

      // Clean up path (remove trailing punctuation)
      const cleanPath = path.replace(/[,;:]+$/, '');

      if (cleanPath && !paths.includes(cleanPath)) {
        paths.push(cleanPath);
      }
    }

    return paths;
  }

  /**
   * Strip ANSI escape codes from a string.
   */
  private stripAnsi(str: string): string {
    // Comprehensive ANSI pattern
    return str.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[=>])/g, '');
  }

  /**
   * Schedule a debounced update emission.
   */
  private scheduleUpdate(): void {
    if (this._pendingUpdate) return;

    this._pendingUpdate = true;
    this._updateTimer = setTimeout(() => {
      this._pendingUpdate = false;
      this.emitUpdate();
    }, EVENT_DEBOUNCE_MS);
  }

  /**
   * Emit the current active tools list.
   */
  private emitUpdate(): void {
    this.emit('toolsUpdate', this.activeTools);
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }
    this._activeTools.clear();
    this.removeAllListeners();
  }
}
