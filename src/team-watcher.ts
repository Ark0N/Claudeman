/**
 * @fileoverview Agent Teams Watcher
 *
 * Polls ~/.claude/teams/ and ~/.claude/tasks/ for agent team activity.
 * Matches teams to Claudeman sessions via leadSessionId and emits
 * events for UI updates and team-aware idle detection.
 *
 * @module team-watcher
 */

import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TeamConfig, TeamTask, InboxMessage } from './types.js';
import { LRUMap } from './utils/lru-map.js';

// ========== Constants ==========

const POLL_INTERVAL_MS = 3000;
const MAX_CACHED_TEAMS = 50;
const MAX_CACHED_TASKS = 200;

// ========== TeamWatcher Class ==========

export class TeamWatcher extends EventEmitter {
  private teamsDir: string;
  private tasksDir: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private teams: LRUMap<string, TeamConfig> = new LRUMap({ maxSize: MAX_CACHED_TEAMS });
  private teamTasks: LRUMap<string, TeamTask[]> = new LRUMap({ maxSize: MAX_CACHED_TASKS });
  private inboxCache: LRUMap<string, InboxMessage[]> = new LRUMap({ maxSize: MAX_CACHED_TASKS });
  // Track config mtimes to avoid re-reading unchanged files
  private configMtimes: Map<string, number> = new Map();
  private taskMtimes: Map<string, number> = new Map();
  private inboxMtimes: Map<string, number> = new Map();

  constructor(teamsDir?: string, tasksDir?: string) {
    super();
    const claudeHome = join(homedir(), '.claude');
    this.teamsDir = teamsDir || join(claudeHome, 'teams');
    this.tasksDir = tasksDir || join(claudeHome, 'tasks');
  }

  start(): void {
    if (this.pollTimer) return;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.teams.clear();
    this.teamTasks.clear();
    this.inboxCache.clear();
    this.configMtimes.clear();
    this.taskMtimes.clear();
    this.inboxMtimes.clear();
  }

  /** Get all discovered teams */
  getTeams(): TeamConfig[] {
    return Array.from(this.teams.values());
  }

  /** Get team associated with a Claudeman session (matched by leadSessionId) */
  getTeamForSession(sessionId: string): TeamConfig | undefined {
    for (const team of this.teams.values()) {
      if (team.leadSessionId === sessionId) {
        return team;
      }
    }
    return undefined;
  }

  /** Get tasks for a team (excluding internal tasks) */
  getTeamTasks(teamName: string): TeamTask[] {
    const tasks = this.teamTasks.get(teamName);
    if (!tasks) return [];
    return tasks.filter(t => !t.metadata?._internal);
  }

  /** Count active (non-completed) tasks for a team */
  getActiveTaskCount(teamName: string): number {
    const tasks = this.getTeamTasks(teamName);
    return tasks.filter(t => t.status !== 'completed').length;
  }

  /** Get inbox messages for a team member (or all members) */
  getInboxMessages(teamName: string, member?: string): InboxMessage[] {
    if (member) {
      const key = `${teamName}/${member}`;
      return this.inboxCache.get(key) || [];
    }
    // Return all messages for team
    const messages: InboxMessage[] = [];
    for (const [key, msgs] of this.inboxCache.entries()) {
      if (key.startsWith(`${teamName}/`)) {
        messages.push(...msgs);
      }
    }
    return messages.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  /** Check if a session has active teammates (for idle detection) */
  hasActiveTeammates(sessionId: string): boolean {
    const team = this.getTeamForSession(sessionId);
    if (!team) return false;

    // Check if any non-lead members exist (they are active by definition while present)
    const teammates = team.members.filter(m => m.agentType !== 'team-lead');
    if (teammates.length === 0) return false;

    // Check if team has active (non-completed) tasks
    const activeTasks = this.getActiveTaskCount(team.name);
    return activeTasks > 0;
  }

  /** Get count of active teammates for a session */
  getActiveTeammateCount(sessionId: string): number {
    const team = this.getTeamForSession(sessionId);
    if (!team) return 0;
    return team.members.filter(m => m.agentType !== 'team-lead').length;
  }

  // ========== Private Methods ==========

  private poll(): void {
    try {
      this.pollTeams();
      this.pollTasks();
      this.pollInboxes();
    } catch (err) {
      // Don't crash on polling errors — filesystem may be temporarily unavailable
    }
  }

  private pollTeams(): void {
    if (!existsSync(this.teamsDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(this.teamsDir);
    } catch {
      return;
    }

    const currentTeamNames = new Set<string>();

    for (const entry of entries) {
      const configPath = join(this.teamsDir, entry, 'config.json');
      if (!existsSync(configPath)) continue;

      currentTeamNames.add(entry);

      // Check mtime to skip unchanged configs
      try {
        const mtime = statSync(configPath).mtimeMs;
        if (this.configMtimes.get(entry) === mtime) continue;
        this.configMtimes.set(entry, mtime);
      } catch {
        continue;
      }

      // Skip if locked
      if (this.isLocked(join(this.teamsDir, entry, 'config.json'))) continue;

      const config = this.readJson<TeamConfig>(configPath);
      if (!config || !config.name) continue;

      const existing = this.teams.get(entry);
      this.teams.set(entry, config);

      if (existing) {
        this.emit('teamUpdated', config);
      } else {
        this.emit('teamCreated', config);
      }
    }

    // Detect removed teams
    for (const name of Array.from(this.teams.keys())) {
      if (!currentTeamNames.has(name)) {
        const removed = this.teams.get(name);
        this.teams.delete(name);
        this.configMtimes.delete(name);
        if (removed) {
          this.emit('teamRemoved', removed);
        }
      }
    }
  }

  private pollTasks(): void {
    if (!existsSync(this.tasksDir)) return;

    let teamDirs: string[];
    try {
      teamDirs = readdirSync(this.tasksDir);
    } catch {
      return;
    }

    for (const teamName of teamDirs) {
      const teamTaskDir = join(this.tasksDir, teamName);
      let taskFiles: string[];
      try {
        taskFiles = readdirSync(teamTaskDir).filter(f => f.endsWith('.json') && f !== '.lock');
      } catch {
        continue;
      }

      // Check combined mtime for all task files
      const mtimeKey = teamName;
      let combinedMtime = 0;
      for (const f of taskFiles) {
        try {
          combinedMtime += statSync(join(teamTaskDir, f)).mtimeMs;
        } catch {
          // File may have been deleted between readdir and stat
        }
      }
      if (this.taskMtimes.get(mtimeKey) === combinedMtime) continue;
      this.taskMtimes.set(mtimeKey, combinedMtime);

      // Skip if locked
      if (this.isLocked(join(teamTaskDir, '.lock'))) continue;

      const tasks: TeamTask[] = [];
      for (const f of taskFiles) {
        const task = this.readJson<TeamTask>(join(teamTaskDir, f));
        if (task && task.id) {
          tasks.push(task);
        }
      }

      this.teamTasks.set(teamName, tasks);
      this.emit('taskUpdated', { teamName, tasks });
    }
  }

  private pollInboxes(): void {
    // Inbox files live under ~/.claude/teams/{name}/inboxes/
    for (const [teamName] of this.teams.entries()) {
      const inboxDir = join(this.teamsDir, teamName, 'inboxes');
      if (!existsSync(inboxDir)) continue;

      let inboxFiles: string[];
      try {
        inboxFiles = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const f of inboxFiles) {
        const filePath = join(inboxDir, f);
        const memberName = f.replace('.json', '');
        const cacheKey = `${teamName}/${memberName}`;

        // Check mtime
        try {
          const mtime = statSync(filePath).mtimeMs;
          if (this.inboxMtimes.get(cacheKey) === mtime) continue;
          this.inboxMtimes.set(cacheKey, mtime);
        } catch {
          continue;
        }

        // Skip if locked
        if (this.isLocked(filePath)) continue;

        const messages = this.readJson<InboxMessage[]>(filePath);
        if (!Array.isArray(messages)) continue;

        const previous = this.inboxCache.get(cacheKey);
        this.inboxCache.set(cacheKey, messages);

        // Emit new messages (ones not in previous cache)
        const prevCount = previous?.length || 0;
        if (messages.length > prevCount) {
          for (let i = prevCount; i < messages.length; i++) {
            this.emit('inboxMessage', { teamName, member: memberName, message: messages[i] });
          }
        }
      }
    }
  }

  /** Check for directory-based lock (mkdir atomic locking) */
  private isLocked(path: string): boolean {
    const lockDir = `${path}.lock`;
    try {
      return existsSync(lockDir) && statSync(lockDir).isDirectory();
    } catch {
      return false;
    }
  }

  private readJson<T>(filePath: string): T | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
}
