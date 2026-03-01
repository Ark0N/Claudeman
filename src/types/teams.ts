/**
 * @fileoverview Agent Teams type definitions
 */

/** Team configuration from ~/.claude/teams/{name}/config.json */
export interface TeamConfig {
  name: string;
  leadSessionId: string;
  members: TeamMember[];
}

/** A single team member (lead or teammate) */
export interface TeamMember {
  agentId: string;
  name: string;
  agentType: 'team-lead' | 'general-purpose' | string;
  color?: string;
  backendType?: string;
  prompt?: string;
  tmuxPaneId?: string;
}

/** A task from ~/.claude/tasks/{team-name}/{N}.json */
export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/** An inbox message from ~/.claude/teams/{name}/inboxes/{member}.json */
export interface InboxMessage {
  from: string;
  text: string;
  timestamp: string;
  read?: boolean;
}

/**
 * Information about a tmux pane within a session.
 * Used for agent team teammate pane management.
 */
export interface PaneInfo {
  /** Pane ID (e.g., "%0", "%1") — immutable within a tmux session */
  paneId: string;
  /** Pane index within the window (0, 1, 2...) */
  paneIndex: number;
  /** PID of the process running in the pane */
  panePid: number;
  /** Pane width in columns */
  width: number;
  /** Pane height in rows */
  height: number;
}
