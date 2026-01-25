#!/usr/bin/env npx tsx
/**
 * Real-time subagent transcript watcher
 *
 * Usage:
 *   npx tsx scripts/watch-subagents.ts                    # Watch all recent
 *   npx tsx scripts/watch-subagents.ts --session <id>     # Watch specific session
 *   npx tsx scripts/watch-subagents.ts --agent <id>       # Watch specific agent
 *   npx tsx scripts/watch-subagents.ts --list             # List active subagents
 */

import { watch, statSync, readdirSync, existsSync, readFileSync } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

const c = colors;

interface TranscriptEntry {
  type: 'user' | 'assistant' | 'progress';
  timestamp: string;
  agentId: string;
  sessionId: string;
  message?: {
    role: string;
    content: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      content?: string;
    }>;
  };
  data?: {
    type: string;
    query?: string;
    resultCount?: number;
  };
}

class SubagentWatcher {
  private claudeDir = join(homedir(), '.claude/projects');
  private filePositions = new Map<string, number>();
  private seenAgents = new Set<string>();
  private watchedFiles = new Set<string>();

  // Find all subagent directories
  findSubagentDirs(): string[] {
    const dirs: string[] = [];

    if (!existsSync(this.claudeDir)) {
      console.error(`${c.red}Claude projects directory not found: ${this.claudeDir}${c.reset}`);
      return dirs;
    }

    const projects = readdirSync(this.claudeDir);
    for (const project of projects) {
      const projectPath = join(this.claudeDir, project);
      try {
        const sessions = readdirSync(projectPath);
        for (const session of sessions) {
          const subagentDir = join(projectPath, session, 'subagents');
          if (existsSync(subagentDir)) {
            dirs.push(subagentDir);
          }
        }
      } catch {
        // Not a directory or no access
      }
    }

    return dirs;
  }

  // Find recently modified agent transcripts
  findRecentAgents(minutes: number = 60): Array<{ path: string; agentId: string; mtime: Date }> {
    const agents: Array<{ path: string; agentId: string; mtime: Date }> = [];
    const cutoff = Date.now() - minutes * 60 * 1000;

    for (const dir of this.findSubagentDirs()) {
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.jsonl')) {
            const filePath = join(dir, file);
            const stat = statSync(filePath);
            if (stat.mtimeMs > cutoff) {
              const agentId = file.replace('agent-', '').replace('.jsonl', '');
              agents.push({ path: filePath, agentId, mtime: stat.mtime });
            }
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    return agents.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  // Format a tool call nicely
  formatToolCall(name: string, input: Record<string, unknown>): string {
    const icons: Record<string, string> = {
      WebSearch: '🔍',
      WebFetch: '🌐',
      Read: '📖',
      Write: '📝',
      Edit: '✏️',
      Bash: '💻',
      Glob: '📁',
      Grep: '🔎',
      Task: '🤖',
    };

    const icon = icons[name] || '🔧';
    let details = '';

    if (name === 'WebSearch' && input.query) {
      details = `"${input.query}"`;
    } else if (name === 'WebFetch' && input.url) {
      details = input.url as string;
    } else if (name === 'Read' && input.file_path) {
      details = input.file_path as string;
    } else if (name === 'Write' && input.file_path) {
      details = input.file_path as string;
    } else if (name === 'Edit' && input.file_path) {
      details = input.file_path as string;
    } else if (name === 'Bash' && input.command) {
      const cmd = input.command as string;
      details = cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
    } else if (name === 'Glob' && input.pattern) {
      details = input.pattern as string;
    } else if (name === 'Grep' && input.pattern) {
      details = input.pattern as string;
    } else if (name === 'Task' && input.description) {
      details = input.description as string;
    } else {
      // Show first key-value pair
      const keys = Object.keys(input);
      if (keys.length > 0) {
        const val = input[keys[0]];
        details = typeof val === 'string' ? val.substring(0, 50) : JSON.stringify(val).substring(0, 50);
      }
    }

    return `${icon} ${c.cyan}${name}${c.reset}: ${c.dim}${details}${c.reset}`;
  }

  // Format a progress event
  formatProgress(data: { type: string; query?: string; resultCount?: number }): string {
    if (data.type === 'query_update') {
      return `${c.yellow}⟳${c.reset} Searching: ${c.dim}"${data.query}"${c.reset}`;
    } else if (data.type === 'search_results_received') {
      return `${c.green}✓${c.reset} Got ${data.resultCount} results for: ${c.dim}"${data.query}"${c.reset}`;
    }
    return `${c.dim}Progress: ${data.type}${c.reset}`;
  }

  // Format timestamp
  formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return `${c.dim}${date.toLocaleTimeString()}${c.reset}`;
  }

  // Process a single transcript entry
  processEntry(entry: TranscriptEntry, agentId: string): void {
    const time = this.formatTime(entry.timestamp);
    const prefix = `${c.magenta}[${agentId.substring(0, 7)}]${c.reset}`;

    if (entry.type === 'progress' && entry.data) {
      console.log(`${time} ${prefix} ${this.formatProgress(entry.data)}`);
    } else if (entry.type === 'assistant' && entry.message?.content) {
      for (const content of entry.message.content) {
        if (content.type === 'tool_use' && content.name) {
          console.log(`${time} ${prefix} ${this.formatToolCall(content.name, content.input || {})}`);
        } else if (content.type === 'text' && content.text) {
          // Show first 200 chars of text responses
          const text = content.text.trim();
          if (text.length > 0) {
            const preview = text.length > 200 ? text.substring(0, 200) + '...' : text;
            console.log(`${time} ${prefix} ${c.white}💬 ${preview.replace(/\n/g, ' ')}${c.reset}`);
          }
        }
      }
    } else if (entry.type === 'user' && entry.message?.content) {
      // User messages are usually tool results or initial prompt
      const firstContent = entry.message.content[0];
      if (firstContent?.type === 'text' && firstContent.text) {
        const text = firstContent.text.trim();
        if (text.length < 100 && !text.includes('{')) {
          console.log(`${time} ${prefix} ${c.blue}📥 User: ${text.substring(0, 80)}${c.reset}`);
        }
      }
    }
  }

  // Tail a single file from a position
  async tailFile(filePath: string, fromPosition: number = 0): Promise<number> {
    return new Promise((resolve) => {
      const agentId = basename(filePath).replace('agent-', '').replace('.jsonl', '');
      let position = fromPosition;
      let lineCount = 0;

      const stream = createReadStream(filePath, { start: fromPosition });
      const rl = createInterface({ input: stream });

      rl.on('line', (line) => {
        position += Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
        lineCount++;

        try {
          const entry = JSON.parse(line) as TranscriptEntry;
          this.processEntry(entry, agentId);
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        resolve(position);
      });
    });
  }

  // Watch a file for changes
  watchFile(filePath: string): void {
    if (this.watchedFiles.has(filePath)) return;
    this.watchedFiles.add(filePath);

    const agentId = basename(filePath).replace('agent-', '').replace('.jsonl', '');

    // Initial read
    this.tailFile(filePath, 0).then((position) => {
      this.filePositions.set(filePath, position);
    });

    // Watch for changes
    watch(filePath, async (eventType) => {
      if (eventType === 'change') {
        const currentPos = this.filePositions.get(filePath) || 0;
        const newPos = await this.tailFile(filePath, currentPos);
        this.filePositions.set(filePath, newPos);
      }
    });

    if (!this.seenAgents.has(agentId)) {
      this.seenAgents.add(agentId);
      console.log(`\n${c.bgMagenta}${c.white} NEW AGENT ${c.reset} ${c.bold}${agentId}${c.reset} - ${filePath}\n`);
    }
  }

  // Watch a directory for new agent files
  watchDirectory(dir: string): void {
    // Watch existing files
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          this.watchFile(join(dir, file));
        }
      }
    } catch {
      return;
    }

    // Watch for new files
    watch(dir, (eventType, filename) => {
      if (filename?.endsWith('.jsonl')) {
        const filePath = join(dir, filename);
        if (existsSync(filePath)) {
          this.watchFile(filePath);
        }
      }
    });
  }

  // Watch all subagent directories
  watchAll(): void {
    console.log(`${c.bold}${c.cyan}🔭 Watching for subagent activity...${c.reset}\n`);

    const dirs = this.findSubagentDirs();
    console.log(`${c.dim}Found ${dirs.length} subagent directories${c.reset}\n`);

    // Watch for recent activity first
    const recent = this.findRecentAgents(30); // Last 30 minutes
    if (recent.length > 0) {
      console.log(`${c.yellow}Recent agents (last 30 min):${c.reset}`);
      for (const agent of recent.slice(0, 5)) {
        console.log(`  ${c.magenta}${agent.agentId}${c.reset} - ${c.dim}${agent.mtime.toLocaleTimeString()}${c.reset}`);
      }
      console.log('');
    }

    // Watch all directories
    for (const dir of dirs) {
      this.watchDirectory(dir);
    }

    // Also watch for new session directories
    const projects = readdirSync(this.claudeDir);
    for (const project of projects) {
      const projectPath = join(this.claudeDir, project);
      try {
        watch(projectPath, (eventType, filename) => {
          if (filename) {
            const subagentDir = join(projectPath, filename, 'subagents');
            if (existsSync(subagentDir)) {
              this.watchDirectory(subagentDir);
            }
          }
        });
      } catch {
        // Skip
      }
    }

    console.log(`${c.green}✓ Watching... Press Ctrl+C to stop${c.reset}\n`);
    console.log(`${c.dim}${'─'.repeat(60)}${c.reset}\n`);
  }

  // List recent agents
  listAgents(): void {
    const agents = this.findRecentAgents(120); // Last 2 hours

    if (agents.length === 0) {
      console.log(`${c.yellow}No recent subagent activity found${c.reset}`);
      return;
    }

    console.log(`${c.bold}Recent Subagents (last 2 hours):${c.reset}\n`);

    for (const agent of agents) {
      const stat = statSync(agent.path);
      const lines = this.countLines(agent.path);
      const sessionId = basename(dirname(dirname(agent.path)));

      console.log(`${c.magenta}${agent.agentId}${c.reset}`);
      console.log(`  Session: ${c.dim}${sessionId.substring(0, 8)}...${c.reset}`);
      console.log(`  Modified: ${c.dim}${agent.mtime.toLocaleString()}${c.reset}`);
      console.log(`  Size: ${c.dim}${(stat.size / 1024).toFixed(1)}KB${c.reset} (${lines} entries)`);
      console.log(`  Path: ${c.dim}${agent.path}${c.reset}`);
      console.log('');
    }
  }

  private countLines(filePath: string): number {
    try {
      const content = readFileSync(filePath, 'utf8');
      return content.split('\n').filter((l: string) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  // Watch a specific agent
  watchAgent(agentId: string): void {
    const agents = this.findRecentAgents(1440); // Last 24 hours
    const agent = agents.find(a => a.agentId.startsWith(agentId));

    if (!agent) {
      console.log(`${c.red}Agent not found: ${agentId}${c.reset}`);
      console.log(`${c.dim}Try: npx tsx scripts/watch-subagents.ts --list${c.reset}`);
      return;
    }

    console.log(`${c.bold}${c.cyan}🔭 Watching agent ${agent.agentId}${c.reset}\n`);
    this.watchFile(agent.path);
  }
}

// Main
const args = process.argv.slice(2);

const watcher = new SubagentWatcher();

if (args.includes('--list') || args.includes('-l')) {
  watcher.listAgents();
} else if (args.includes('--agent') || args.includes('-a')) {
  const idx = args.indexOf('--agent') !== -1 ? args.indexOf('--agent') : args.indexOf('-a');
  const agentId = args[idx + 1];
  if (!agentId) {
    console.log(`${c.red}Please provide an agent ID${c.reset}`);
    process.exit(1);
  }
  watcher.watchAgent(agentId);
} else {
  watcher.watchAll();
}

// Keep process running
process.on('SIGINT', () => {
  console.log(`\n${c.yellow}Stopped watching${c.reset}`);
  process.exit(0);
});
