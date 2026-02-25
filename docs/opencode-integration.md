# OpenCode Integration Plan for Claudeman

> **Author**: Claude Opus 4.6 | **Date**: 2026-02-26
> **Status**: Draft — NOT pushed to GitHub
> **Saved at**: `docs/opencode-integration.md`
> **Related**: `plan.json` (48-task TDD breakdown, also not pushed)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What is OpenCode?](#2-what-is-opencode)
3. [Architecture Comparison: Claude Code vs OpenCode](#3-architecture-comparison-claude-code-vs-opencode)
4. [Integration Strategy Overview](#4-integration-strategy-overview)
5. [Phase 0: Prerequisites & Manual Validation](#5-phase-0-prerequisites--manual-validation)
6. [Phase 1: Type System & Backend Abstraction](#6-phase-1-type-system--backend-abstraction)
7. [Phase 2: OpenCode CLI Resolution](#7-phase-2-opencode-cli-resolution)
8. [Phase 3: Tmux Spawn Integration](#8-phase-3-tmux-spawn-integration)
9. [Phase 4: Output Parsing & Idle Detection](#9-phase-4-output-parsing--idle-detection)
10. [Phase 5: API Routes & Frontend UI](#10-phase-5-api-routes--frontend-ui)
11. [Phase 6: Respawn & Ralph Loop Adaptation](#11-phase-6-respawn--ralph-loop-adaptation)
12. [Phase 7: Hooks & Plugin Bridge](#12-phase-7-hooks--plugin-bridge)
13. [Phase 8: OpenCode Server API Integration (Advanced)](#13-phase-8-opencode-server-api-integration-advanced)
14. [Files to Modify](#14-files-to-modify)
15. [Files to Create](#15-files-to-create)
16. [Existing plan.json Task Breakdown](#16-existing-planjson-task-breakdown)
17. [Risk Assessment](#17-risk-assessment)
18. [Testing Strategy](#18-testing-strategy)
19. [Open Questions & Decisions](#19-open-questions--decisions)
20. [Implementation Order](#20-implementation-order)
21. [Appendix A: OpenCode CLI Reference](#appendix-a-opencode-cli-reference)
22. [Appendix B: OpenCode Plugin Events](#appendix-b-opencode-plugin-events)
23. [Appendix C: OpenCode Permission Config](#appendix-c-opencode-permission-config)
24. [Appendix D: Current Claudeman Session Spawn Flow (Annotated)](#appendix-d-current-claudeman-session-spawn-flow-annotated)

---

## 1. Executive Summary

This plan details how to integrate [OpenCode](https://opencode.ai) — the popular open-source AI coding CLI (111k+ GitHub stars, 75+ model providers) — into Claudeman as a first-class session type alongside Claude Code and shell sessions.

### Core Approach

Extend the existing `SessionMode` type from `'claude' | 'shell'` to `'claude' | 'shell' | 'opencode'`, and propagate this new mode through the tmux manager, session class, API routes, and frontend UI. OpenCode will be spawned inside tmux exactly like Claude Code, with its TUI rendered in xterm.js.

### Two Integration Strategies (Incremental)

| Strategy | Approach | Complexity | Value |
|----------|----------|------------|-------|
| **A: TUI-in-tmux** | Spawn `opencode` CLI in tmux, render in xterm.js | Medium | Full visual parity with Claude Code |
| **B: Server API bridge** | Run `opencode serve` + proxy its API through Claudeman | High | Structured data, session control, token tracking |

**Recommended path**: Start with Strategy A (TUI-in-tmux) since it mirrors the existing Claude Code pattern exactly. Then layer Strategy B on top for advanced features like structured token tracking and model switching.

### Why OpenCode?

- **Multi-model**: Access Claude, GPT, Gemini, Ollama (local), and 75+ other models through one tool
- **Privacy-first**: Can run fully local via Ollama — no code ever leaves the machine
- **Open source**: MIT licensed, active community (700+ contributors)
- **Client/server**: Built-in `opencode serve` mode enables richer programmatic integration
- **Plugin system**: JS/TS plugins with rich event hooks (including `session.idle` — perfect for Claudeman)

---

## 2. What is OpenCode?

- **GitHub**: https://github.com/opencode-ai/opencode (originally `sst/opencode`, now `anomalyco/opencode`)
- **Website**: https://opencode.ai
- **License**: MIT
- **Language**: Go (binary), with TypeScript plugin/config system
- **TUI Framework**: Bubble Tea (Go) — *not* `@opentui/solid` as earlier versions used
- **Install**: `curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash` or `brew install opencode-ai/tap/opencode` or `go install github.com/opencode-ai/opencode@latest`

### Key Differences from Claude Code

| Feature | Claude Code | OpenCode |
|---------|-------------|----------|
| **Models** | Anthropic only | 75+ providers (Anthropic, OpenAI, Google, Ollama, etc.) |
| **Architecture** | Single CLI process | Client/server (TUI + optional API server) |
| **TUI framework** | Ink (React for terminals) | Bubble Tea (Go) |
| **Headless mode** | `claude -p` | `opencode run` (JSON output) + `opencode serve` (HTTP API) |
| **Permissions** | `--dangerously-skip-permissions` CLI flag | Config-based `"permission": {"*": "allow"}` in `opencode.json` |
| **Hooks system** | `.claude/settings.local.json` with shell command hooks | JS/TS plugin system with 25+ event types |
| **Session ID** | `--session-id <id>` | `--session <id>` or `-s <id>` |
| **Continue** | `/resume` command | `--continue` or `-c` flag |
| **Config format** | CLAUDE.md (markdown) + settings.json | `opencode.json` (JSON/JSONC) |
| **Data storage** | File-based (transcripts, state) | SQLite database |
| **Leader key** | None (direct shortcuts) | `Ctrl+X` as leader key for TUI |
| **Token display** | Status bar: `123.4k tokens` | TUI status area: `~27s · 275.9k tokens` |

### OpenCode CLI Flags (Relevant for Spawning)

```bash
# Interactive TUI (default)
opencode [project-path]

# With specific model
opencode --model anthropic/claude-sonnet-4-5
opencode --model openai/gpt-5.2
opencode --model ollama/codellama

# Continue existing session
opencode --continue                  # Continue last session
opencode --session <id>              # Resume specific session
opencode --fork                      # Branch when continuing

# Non-interactive (pipe mode)
opencode run "prompt here"
opencode run --format json "prompt"  # Structured JSON output
opencode run --continue              # Continue last session in pipe mode
opencode run --file path.ts "prompt" # Attach file context
opencode run --attach http://host:4096 "prompt"  # Run against remote server

# Headless server
opencode serve --port 4096
opencode serve --cors "http://localhost:3000"
opencode serve --mdns                # Enable mDNS discovery

# Attach TUI to remote server
opencode attach http://host:4096

# Session management
opencode session list                # List all sessions
opencode export [sessionID]          # Export as JSON
opencode import <file>               # Import from file/URL

# Model management
opencode models [provider]           # List available models
opencode models --refresh            # Update model cache

# Global flags
--help, --version, --debug, --cwd <dir>, --log-level, --print-logs
```

### OpenCode Config File (`opencode.json`)

Located in project root (or `~/.config/opencode/opencode.json` for global), configures model, tools, agents:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5",

  // Auto-approve all tool executions (like --dangerously-skip-permissions)
  "permission": {
    "*": "allow"
  },

  // Or granular permissions
  "permission": {
    "*": "ask",
    "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
    "edit": "allow"
  },

  "tools": { "bash": { "mode": "allow" } },

  "agents": {
    "build": { "model": "anthropic/claude-sonnet-4-5" }
  },

  "mcp": { "servers": {} },

  "server": {
    "port": 4096,
    "hostname": "0.0.0.0",
    "cors": ["http://localhost:3000"]
  },

  "compaction": { "auto": true },
  "autoupdate": false
}
```

### Config File Precedence

1. Remote config (`.well-known/opencode` endpoint)
2. Global config (`~/.config/opencode/opencode.json`)
3. Custom config (`OPENCODE_CONFIG` env var)
4. Project config (`opencode.json` in project root)
5. `.opencode/` directory (agents, commands, plugins)
6. Inline config (`OPENCODE_CONFIG_CONTENT` env var)

### OpenCode Environment Variables

```bash
ANTHROPIC_API_KEY=...          # For Anthropic models
OPENAI_API_KEY=...             # For OpenAI models
GOOGLE_API_KEY=...             # For Google AI models
OPENCODE_MODEL=...             # Default model override
OPENCODE_CONFIG=...            # Custom config file path
OPENCODE_CONFIG_DIR=...        # Custom config directory
OPENCODE_CONFIG_CONTENT=...    # Inline JSON config (highest priority)
OPENCODE_SERVER_PASSWORD=...   # Auth for serve mode (username: "opencode")
OPENCODE_PERMISSION=...        # Inline JSON permission config
OPENCODE_CLIENT=...            # Client identifier (default: "cli")
```

---

## 3. Architecture Comparison: Claude Code vs OpenCode

### Current Claudeman Session Flow (Claude Code)

```
POST /api/sessions           →  new Session({mode: 'claude', mux: TmuxManager})
POST /api/sessions/:id/interactive  →  session.startInteractive()
                                              ↓
                                    TmuxManager.createSession()
                                              ↓
                                    tmux new-session -ds "claudeman-<id>"
                                    tmux respawn-pane -k -t ... "claude --dangerously-skip-permissions --session-id <id>"
                                              ↓
                                    pty.spawn('tmux', ['attach-session', '-t', 'claudeman-<id>'])
                                              ↓
                                    ptyProcess.onData() → emit('terminal') → SSE broadcast → xterm.js
```

### Proposed OpenCode Session Flow (Strategy A: TUI-in-tmux)

```
POST /api/sessions           →  new Session({mode: 'opencode', mux: TmuxManager})
POST /api/sessions/:id/interactive  →  session.startInteractive()
                                              ↓
                                    TmuxManager.createSession()
                                              ↓
                                    tmux new-session -ds "claudeman-<id>"
                                    tmux respawn-pane -k -t ... "opencode --model <model>"
                                              ↓
                                    pty.spawn('tmux', ['attach-session', '-t', 'claudeman-<id>'])
                                              ↓
                                    ptyProcess.onData() → emit('terminal') → SSE broadcast → xterm.js
```

**Identical pipeline!** The only differences are:
1. The command spawned inside tmux (`opencode` vs `claude`)
2. The CLI arguments (`--model` vs `--dangerously-skip-permissions --session-id`)
3. The environment variables passed to the process
4. Output parsing patterns (idle detection, prompt character, token tracking)
5. Permission handling (config file vs CLI flag)

### Proposed OpenCode Session Flow (Strategy B: Server API Bridge)

```
Strategy A (TUI-in-tmux) for terminal rendering
     +
opencode serve (background, port 4096+N)
     ↓
Claudeman proxy routes → GET /session/current, POST /session/message, SSE /events
     ↓
Structured data for: token tracking, session management, model switching
```

---

## 4. Integration Strategy Overview

### Phase Breakdown

| Phase | Scope | Effort | Dependencies |
|-------|-------|--------|-------------|
| **0** | Install OpenCode, manual tmux validation | 30 min | None |
| **1** | Type system extension + (optional) backend abstraction | Small | None |
| **2** | OpenCode CLI resolver | Small | Phase 1 |
| **3** | TmuxManager: spawn `opencode` in tmux | Medium | Phase 2 |
| **4** | Output parsing, idle detection, prompt detection | Medium | Phase 3 |
| **5** | API routes + frontend UI (mode selector, badges) | Medium | Phase 4 |
| **6** | Respawn controller + Ralph Loop adaptation | Medium | Phase 5 |
| **7** | Hooks & plugin bridge | Medium | Phase 5 |
| **8** | OpenCode server API bridge (optional, advanced) | Large | Phase 5 |

### What Stays Exactly the Same (Zero Changes)

These systems work identically for OpenCode sessions:
- tmux session creation/lifecycle mechanics
- PTY attachment via `tmux attach-session`
- Terminal data streaming via `ptyProcess.onData()`
- SSE event broadcasting via `broadcast()`
- xterm.js terminal rendering in the browser
- State persistence to `~/.claudeman/state.json`
- Session CRUD API routes (create, get, delete)
- Tab management in frontend
- Session kill/cleanup logic (`TmuxManager.killSession()`)
- Nice priority wrapping
- Terminal resize (SIGWINCH propagation through tmux)
- `writeViaMux()` — sending text input via tmux `send-keys`

### What Needs Adaptation

| System | Current (Claude-specific) | OpenCode Equivalent |
|--------|---------------------------|---------------------|
| CLI binary | `claude` | `opencode` |
| CLI args | `--dangerously-skip-permissions --session-id <id>` | `--model <m>` + `opencode.json` for permissions |
| Prompt marker | `❯` (U+276F) | Bubble Tea TUI prompt (different rendering) |
| Working indicator | Spinner + "Thinking...", "Writing..." keywords | Bubble Tea spinner (different characters) |
| Completion message | `"Worked for Xm Xs"` | Different format (needs empirical testing) |
| Token display | Status line: `123.4k tokens` | TUI status: `~27s · 275.9k tokens` |
| Slash commands | `/clear`, `/compact`, `/init`, `/update` | `/clear`, `/model`, `/sessions`, `/compact` |
| Hooks | `.claude/settings.local.json` shell commands | JS/TS plugin system in `.opencode/plugins/` |
| Subagent detection | `BashToolParser` + `SubagentWatcher` | Different tool output format |
| Ralph completion | `<promise>PHRASE</promise>` tags | Not applicable (needs alternative) |
| Hooks events | `permission_prompt`, `idle_prompt`, `stop` | `permission.asked`, `session.idle`, `session.status` |
| Auto-compact | Claudeman sends `/compact` at token threshold | OpenCode has built-in `compaction.auto: true` |

---

## 5. Phase 0: Prerequisites & Manual Validation

### Goal
Install OpenCode and validate it works inside tmux before writing any code.

### Steps

```bash
# 1. Install OpenCode
curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash

# 2. Verify installation
which opencode
opencode --version

# 3. Test interactive TUI
opencode

# 4. Test in tmux (simulating Claudeman's spawn pattern)
tmux new-session -ds "test-opencode" -c /tmp -x 120 -y 40
tmux set-option -t "test-opencode" remain-on-exit on
tmux respawn-pane -k -t "test-opencode" 'opencode --model anthropic/claude-sonnet-4-5'

# 5. Attach and verify rendering
tmux attach-session -t "test-opencode"
# → Verify: TUI renders, accepts input, produces output
# → Test: Ctrl+B D to detach, reattach — does TUI restore?
# → Test: Send keys via: tmux send-keys -t "test-opencode" -l "Hello" && tmux send-keys -t "test-opencode" Enter

# 6. Test with auto-allow permissions (via inline config)
tmux respawn-pane -k -t "test-opencode" 'OPENCODE_CONFIG_CONTENT='"'"'{"permission":{"*":"allow"}}'"'"' opencode --model anthropic/claude-sonnet-4-5'

# 7. Test non-interactive mode
opencode run -q --format json "What is 2+2?"

# 8. Cleanup
tmux kill-session -t "test-opencode"
```

### Validation Checklist

- [ ] OpenCode binary found and version verified
- [ ] TUI renders correctly inside tmux
- [ ] tmux `send-keys -l` sends text to OpenCode's TUI correctly
- [ ] Separate `send-keys Enter` triggers prompt submission
- [ ] TUI survives tmux detach/reattach
- [ ] `remain-on-exit` keeps session alive after OpenCode exits
- [ ] Terminal resize works (try different tmux dimensions)
- [ ] Permission auto-allow works via `OPENCODE_CONFIG_CONTENT`
- [ ] Non-interactive `opencode run` produces JSON output
- [ ] xterm.js renders the TUI (manually test by piping PTY output)

### Critical Finding: xterm.js Compatibility

OpenCode uses Bubble Tea (Go's charmbracelet framework), which renders using:
- Alternate screen buffer (`\x1b[?1049h`)
- Mouse events (`\x1b[?1000h`)
- Bracketed paste mode (`\x1b[?2004h`)
- True color (24-bit) sequences

These should all work with xterm.js, but **manual testing is essential** before coding.

---

## 6. Phase 1: Type System & Backend Abstraction

### Goal
Extend the type system to support `'opencode'` as a session mode.

### Approach Decision: Simple Extension vs. Backend Abstraction

There are two paths (both represented in the codebase):

**Option A: Simple mode extension** (recommended for Phase 1)
- Add `'opencode'` to existing `SessionMode` union type
- Use `if/else` branches in existing code
- Less refactoring, faster to ship

**Option B: Full backend abstraction** (from `plan.json`)
- Create `LLMBackend` interface + `ClaudeBackend` + `OpenCodeBackend` classes
- Dependency injection into Session class
- More elegant, but larger scope

**Recommendation**: Start with Option A, refactor to Option B later if a third backend is ever needed.

### Changes

#### `src/session.ts` (line 204)

```typescript
// BEFORE
export type SessionMode = 'claude' | 'shell';

// AFTER
export type SessionMode = 'claude' | 'shell' | 'opencode';
```

#### `src/types.ts` — Add `OpenCodeConfig` interface

```typescript
/** OpenCode session configuration */
export interface OpenCodeConfig {
  /** Model identifier (e.g., "anthropic/claude-sonnet-4-5", "openai/gpt-5.2", "ollama/codellama") */
  model?: string;
  /** Whether to auto-allow all tool executions (sets permission.* = allow) */
  autoAllowTools?: boolean;
  /** Session ID to continue from */
  continueSession?: string;
  /** Whether to fork when continuing (branch the conversation) */
  forkSession?: boolean;
  /** Port for OpenCode's built-in server (Strategy B, Phase 8) */
  serverPort?: number;
  /** Custom inline config JSON (passed via OPENCODE_CONFIG_CONTENT) */
  configContent?: string;
}
```

Add `openCodeConfig` to `SessionState`:

```typescript
// In SessionState interface:
/** OpenCode-specific configuration (only for mode === 'opencode') */
openCodeConfig?: OpenCodeConfig;
```

#### `src/mux-interface.ts` — Update mode types

```typescript
// All occurrences of 'claude' | 'shell' → 'claude' | 'shell' | 'opencode'
// In MuxSession type (line 27):
mode: 'claude' | 'shell' | 'opencode';

// In TerminalMultiplexer interface methods (lines 70, 168):
// Add openCodeConfig parameter to createSession() and respawnPane()
createSession(
  sessionId: string,
  workingDir: string,
  mode: 'claude' | 'shell' | 'opencode',
  name?: string,
  niceConfig?: NiceConfig,
  model?: string,
  claudeMode?: ClaudeMode,
  allowedTools?: string,
  openCodeConfig?: OpenCodeConfig,  // NEW
): Promise<MuxSession>;

respawnPane(
  sessionId: string,
  workingDir: string,
  mode: 'claude' | 'shell' | 'opencode',
  niceConfig?: NiceConfig,
  model?: string,
  claudeMode?: ClaudeMode,
  allowedTools?: string,
  openCodeConfig?: OpenCodeConfig,  // NEW
): Promise<number | null>;
```

#### `src/web/schemas.ts` — Update Zod schemas

```typescript
// Session mode enum
mode: z.enum(['claude', 'shell', 'opencode']).optional(),

// Add OpenCode config schema
const OpenCodeConfigSchema = z.object({
  model: z.string().max(100).regex(/^[a-zA-Z0-9._\-/]+$/).optional(),
  autoAllowTools: z.boolean().optional(),
  continueSession: z.string().max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  forkSession: z.boolean().optional(),
  serverPort: z.number().int().min(1024).max(65535).optional(),
  configContent: z.string().max(10000).optional(),
}).optional();

// Add to CreateSessionSchema:
openCodeConfig: OpenCodeConfigSchema,
```

---

## 7. Phase 2: OpenCode CLI Resolution

### Goal
Create a resolver for the `opencode` binary, mirroring `claude-cli-resolver.ts`.

### New File: `src/utils/opencode-cli-resolver.ts`

```typescript
/**
 * @fileoverview Resolve the OpenCode CLI binary across common install paths.
 * Mirrors claude-cli-resolver.ts pattern.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

let _openCodeDir: string | null = null;
let _resolved = false;

const COMMON_DIRS = [
  join(homedir(), '.local', 'bin'),       // Default install location
  '/usr/local/bin',                        // Homebrew / system
  join(homedir(), '.bun', 'bin'),          // Bun global
  join(homedir(), '.npm-global', 'bin'),   // npm global
  join(homedir(), 'go', 'bin'),            // Go install
  join(homedir(), 'bin'),                  // User bin
];

/**
 * Resolve the directory containing the `opencode` binary.
 * Result is cached after first call.
 */
export function resolveOpenCodeDir(): string | null {
  if (_resolved) return _openCodeDir;
  _resolved = true;

  // Try which first
  try {
    const path = execSync('which opencode', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (path) {
      _openCodeDir = path.replace(/\/opencode$/, '');
      return _openCodeDir;
    }
  } catch { /* not in PATH */ }

  // Check common directories
  for (const dir of COMMON_DIRS) {
    if (existsSync(join(dir, 'opencode'))) {
      _openCodeDir = dir;
      return _openCodeDir;
    }
  }

  return null;
}

/**
 * Check if OpenCode CLI is available on the system.
 */
export function isOpenCodeAvailable(): boolean {
  return resolveOpenCodeDir() !== null;
}

/**
 * Get augmented PATH with OpenCode directory prepended.
 */
export function getOpenCodeAugmentedPath(): string {
  const dir = resolveOpenCodeDir();
  if (!dir) return process.env.PATH || '';
  const current = process.env.PATH || '';
  if (current.includes(dir)) return current;
  return `${dir}:${current}`;
}

/**
 * Reset cached resolution (for testing).
 */
export function resetOpenCodeCache(): void {
  _openCodeDir = null;
  _resolved = false;
}
```

### Update: `src/utils/index.ts`

```typescript
export { resolveOpenCodeDir, isOpenCodeAvailable, getOpenCodeAugmentedPath } from './opencode-cli-resolver.js';
```

---

## 8. Phase 3: Tmux Spawn Integration

### Goal
Make `TmuxManager.createSession()` and `respawnPane()` support `mode: 'opencode'`.

This is the **critical integration point** — once OpenCode runs in tmux, everything downstream (PTY attachment, SSE streaming, xterm.js rendering) works automatically.

### Changes to `src/tmux-manager.ts`

#### New Helper: `buildOpenCodeCommand()`

```typescript
import { resolveOpenCodeDir } from './utils/opencode-cli-resolver.js';
import type { OpenCodeConfig } from './types.js';

/**
 * Build the opencode CLI command with appropriate flags.
 * Similar to buildClaudePermissionFlags() but for OpenCode.
 */
function buildOpenCodeCommand(config?: OpenCodeConfig): string {
  const parts = ['opencode'];

  // Model selection
  if (config?.model) {
    const safeModel = /^[a-zA-Z0-9._\-/]+$/.test(config.model) ? config.model : undefined;
    if (safeModel) parts.push('--model', safeModel);
  }

  // Continue existing session
  if (config?.continueSession) {
    const safeId = /^[a-zA-Z0-9_-]+$/.test(config.continueSession) ? config.continueSession : undefined;
    if (safeId) parts.push('--session', safeId);
    if (config.forkSession) parts.push('--fork');
  }

  return parts.join(' ');
}
```

#### `createSession()` — Extend command construction (around line 280)

```typescript
// CURRENT:
const modelFlag = (mode === 'claude' && safeModel) ? ` --model ${safeModel}` : '';
const baseCmd = mode === 'claude'
  ? `claude${buildClaudePermissionFlags(claudeMode, allowedTools)} --session-id "${sessionId}"${modelFlag}`
  : '$SHELL';

// PROPOSED:
let baseCmd: string;
if (mode === 'claude') {
  const modelFlag = safeModel ? ` --model ${safeModel}` : '';
  baseCmd = `claude${buildClaudePermissionFlags(claudeMode, allowedTools)} --session-id "${sessionId}"${modelFlag}`;
} else if (mode === 'opencode') {
  baseCmd = buildOpenCodeCommand(openCodeConfig);
} else {
  baseCmd = '$SHELL';
}
```

#### PATH Augmentation for OpenCode

```typescript
// In createSession(), where PATH is exported:
let pathExport: string;
if (mode === 'claude') {
  const claudeDir = findClaudeDir();
  if (!claudeDir) throw new Error('Claude CLI not found');
  pathExport = `export PATH="${claudeDir}:$PATH"`;
} else if (mode === 'opencode') {
  const openCodeDir = resolveOpenCodeDir();
  if (!openCodeDir) throw new Error('OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash');
  pathExport = `export PATH="${openCodeDir}:$PATH"`;
} else {
  pathExport = ''; // shell mode uses system PATH
}
```

#### Environment Variables for OpenCode

OpenCode needs different env vars than Claude Code:

```typescript
// Build environment exports based on mode
function buildEnvExports(mode: string, sessionId: string, muxName: string, openCodeConfig?: OpenCodeConfig): string {
  const common = [
    `export LANG=en_US.UTF-8`,
    `export LC_ALL=en_US.UTF-8`,
    `unset COLORTERM`,  // Prevent color issues in tmux
    `export CLAUDEMAN_MUX=1`,
    `export CLAUDEMAN_SESSION_ID=${sessionId}`,
    `export CLAUDEMAN_MUX_NAME=${muxName}`,
    `export CLAUDEMAN_API_URL=${process.env.CLAUDEMAN_API_URL || 'http://localhost:3000'}`,
  ];

  if (mode === 'opencode') {
    // Pass through API keys from Claudeman's environment
    const apiKeyExports = [];
    if (process.env.ANTHROPIC_API_KEY) apiKeyExports.push(`export ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY}"`);
    if (process.env.OPENAI_API_KEY) apiKeyExports.push(`export OPENAI_API_KEY="${process.env.OPENAI_API_KEY}"`);
    if (process.env.GOOGLE_API_KEY) apiKeyExports.push(`export GOOGLE_API_KEY="${process.env.GOOGLE_API_KEY}"`);

    // Inline config for permission auto-allow
    if (openCodeConfig?.autoAllowTools) {
      const permConfig = JSON.stringify({ permission: { '*': 'allow' } });
      // Merge with any existing configContent
      if (openCodeConfig.configContent) {
        try {
          const existing = JSON.parse(openCodeConfig.configContent);
          existing.permission = { '*': 'allow' };
          apiKeyExports.push(`export OPENCODE_CONFIG_CONTENT='${JSON.stringify(existing).replace(/'/g, "'\\''")}'`);
        } catch {
          apiKeyExports.push(`export OPENCODE_CONFIG_CONTENT='${permConfig.replace(/'/g, "'\\''")}'`);
        }
      } else {
        apiKeyExports.push(`export OPENCODE_CONFIG_CONTENT='${permConfig.replace(/'/g, "'\\''")}'`);
      }
    } else if (openCodeConfig?.configContent) {
      apiKeyExports.push(`export OPENCODE_CONFIG_CONTENT='${openCodeConfig.configContent.replace(/'/g, "'\\''")}'`);
    }

    return [...common, ...apiKeyExports].join(' && ');
  }

  if (mode === 'claude') {
    return [...common, `unset CLAUDECODE`].join(' && ');
  }

  return common.join(' && ');
}
```

#### `respawnPane()` — Same Changes (around line 426)

Apply identical command construction logic in `respawnPane()`.

#### Session Discovery — Handle OpenCode sessions

In `reconcileSessions()` (line 700+), discovered unknown sessions currently default to `mode: 'claude'`. Need to detect OpenCode sessions:

```typescript
// In reconcileSessions(), when examining running process in tmux pane:
// Check what command is running: tmux display-message -p '#{pane_current_command}'
// If it's 'opencode', set mode accordingly
const cmd = execSync(`tmux display-message -t "${muxName}" -p '#{pane_current_command}'`, ...).trim();
const mode = cmd.includes('opencode') ? 'opencode' : 'claude';
```

---

## 9. Phase 4: Output Parsing & Idle Detection

### Goal
Detect OpenCode's state from terminal output (idle, working, ready).

### Challenge: Bubble Tea TUI

Unlike Claude Code (Ink), OpenCode uses Bubble Tea (Go), which:
- Uses alternate screen buffer (`\x1b[?1049h`)
- Redraws the entire screen on each update (cursor movements + clear sequences)
- Has a different visual structure (sidebar, message area, input area)

**Key insight**: We don't need to parse the TUI visually. We just need to detect:
1. When the TUI is ready (initial render complete)
2. When OpenCode is working vs idle (for respawn)
3. When output has stopped changing (for completion detection)

### Prompt Detection — `waitForOpenCodeReady()`

OpenCode's TUI takes longer to initialize than Claude's prompt:

```typescript
// In session.ts, add OpenCode-specific ready detection
private async waitForOpenCodeReady(): Promise<void> {
  // OpenCode's Bubble Tea TUI renders asynchronously.
  // Wait for output to stabilize (no new data for 500ms after initial burst).
  const maxWait = 10000; // OpenCode TUI can take up to 10s
  const stabilityThreshold = 500; // ms of silence = ready
  const checkInterval = 50;
  let elapsed = 0;
  let lastOutputTime = Date.now();

  const onOutput = () => { lastOutputTime = Date.now(); };
  this.on('terminal', onOutput);

  try {
    while (elapsed < maxWait) {
      await new Promise(r => setTimeout(r, checkInterval));
      elapsed += checkInterval;

      const silentMs = Date.now() - lastOutputTime;
      if (silentMs >= stabilityThreshold && this._terminalBuffer.length > 200) {
        // TUI has rendered and stabilized
        break;
      }
    }
  } finally {
    this.off('terminal', onOutput);
  }

  // Clear the terminal buffer of initialization junk
  this.emit('clearTerminal');
}
```

### Idle Detection Strategy

**Multi-layer approach (matching Claude's pattern):**

1. **Output silence** (primary) — No terminal output for N seconds → likely idle
2. **OpenCode plugin** (advanced, Phase 7) — `session.idle` event fires → definitive signal
3. **AI checker** (fallback) — Same AI-powered idle check, but only if Claude CLI is also available

```typescript
// In session.ts, add mode-aware idle detection configuration
private getIdleDetectionConfig() {
  if (this.mode === 'opencode') {
    return {
      // OpenCode idle detection is primarily output-silence based
      silenceThresholdMs: 5000,     // 5s silence = likely idle
      promptPattern: null,           // No regex prompt detection for Bubble Tea TUI
      workingKeywords: null,         // Don't scan for Claude-specific keywords
      useAIChecker: false,           // AI checker requires Claude CLI (enable in Phase 7 if desired)
      completionPattern: null,       // OpenCode completion format TBD (needs empirical testing)
    };
  }
  // Existing Claude defaults
  return {
    silenceThresholdMs: 3000,
    promptPattern: /[❯\u276f]/,
    workingKeywords: ['Thinking', 'Writing', 'Reading', 'Searching'],
    useAIChecker: true,
    completionPattern: /Worked for \d+[ms]/,
  };
}
```

### Token Tracking

**Phase 1**: Skip token tracking for OpenCode sessions.
**Phase 8**: Use OpenCode's server API to poll session stats for structured token/cost data.

```typescript
// In session.ts, mode-aware token parsing
private parseTokens(data: string): void {
  if (this.mode === 'opencode') {
    // OpenCode displays tokens in format: "~27s · 275.9k tokens"
    // But this is inside the Bubble Tea TUI, making regex extraction unreliable
    // Skip for now — Phase 8 adds API-based tracking
    return;
  }
  // Existing Claude token parsing...
}
```

### Working/Idle State Tracking

For Claude, Claudeman uses spinner characters and keywords. For OpenCode:

```typescript
// In session.ts onData handler:
if (this.mode === 'opencode') {
  // Simple: track last output time for silence-based idle detection
  this._lastOutputTime = Date.now();

  // If we had no output for >silenceThreshold and now get output → mark working
  if (this._status === 'idle' && Date.now() - this._lastOutputTime > 100) {
    this._status = 'working';
    this.emit('working');
  }
} else {
  // Existing Claude spinner/keyword detection
}
```

---

## 10. Phase 5: API Routes & Frontend UI

### API Changes

#### `src/web/server.ts`

**Session creation route** (around line 810):

```typescript
// In POST /api/sessions handler, add OpenCode check:
if (body.mode === 'opencode') {
  if (!isOpenCodeAvailable()) {
    return reply.status(400).send(
      createErrorResponse('OpenCode CLI not found. Install: curl -fsSL https://opencode.ai/install | bash')
    );
  }
}

// Pass openCodeConfig to Session constructor:
const session = new Session({
  workingDir,
  mode: body.mode || 'claude',
  name: body.name || '',
  mux: this.mux,
  useMux: true,
  niceConfig: globalNice,
  model: body.mode === 'opencode' ? body.openCodeConfig?.model : model,
  openCodeConfig: body.mode === 'opencode' ? body.openCodeConfig : undefined,
  // ...existing params
});
```

**New route — OpenCode availability check:**

```typescript
// GET /api/opencode/status
server.get('/api/opencode/status', async () => ({
  available: isOpenCodeAvailable(),
  path: resolveOpenCodeDir(),
}));
```

**Extend interactive start for OpenCode mode:**

```typescript
// POST /api/sessions/:id/interactive — already the generic start route
// Just need to ensure it works for all modes:
await session.startInteractive(); // mode determines what command spawns
getLifecycleLog().log({ event: 'started', sessionId: id, name: session.name, mode: session.mode });
this.broadcast('session:interactive', { id, mode: session.mode });
```

**Quick-start for OpenCode:**

```typescript
// POST /api/quick-start — extend to handle opencode mode:
if (mode === 'opencode') {
  // Skip Claude-specific setup (hooks, CLAUDE.md generation)
  // But do set up opencode.json permission config if autoAllowTools
  await session.startInteractive();
} else if (mode === 'shell') {
  await session.startShell();
} else {
  await session.startInteractive();
}
```

#### `src/web/schemas.ts`

Update `CreateSessionSchema` and `QuickStartSchema`:

```typescript
export const CreateSessionSchema = z.object({
  prompt: z.string().optional(),
  workingDir: WorkingDirSchema.optional(),
  mode: z.enum(['claude', 'shell', 'opencode']).optional(),
  name: z.string().max(100).optional(),
  // ...existing fields...
  openCodeConfig: z.object({
    model: z.string().max(100).regex(/^[a-zA-Z0-9._\-/]+$/).optional(),
    autoAllowTools: z.boolean().optional(),
    continueSession: z.string().max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    forkSession: z.boolean().optional(),
    serverPort: z.number().int().min(1024).max(65535).optional(),
    configContent: z.string().max(10000).optional(),
  }).optional(),
});
```

### Frontend Changes

#### `src/web/public/app.js`

**Session creation UI** — Add OpenCode option:

```javascript
// In quick-start or new session dialog, add a mode selector:
// Three-way toggle: [Claude Code] [OpenCode] [Shell]

function createModeSelector(container, defaultMode) {
  const modes = [
    { value: 'claude', label: 'Claude Code', desc: 'Anthropic Claude AI' },
    { value: 'opencode', label: 'OpenCode', desc: 'Multi-model AI agent' },
    { value: 'shell', label: 'Shell', desc: 'Plain terminal' },
  ];

  // Check OpenCode availability
  fetch('/api/opencode/status').then(r => r.json()).then(status => {
    if (!status.available) {
      // Gray out OpenCode option, show install hint
      opencodeBtn.disabled = true;
      opencodeBtn.title = 'OpenCode not installed';
    }
  });

  // When OpenCode selected, show model input:
  // - Text input with datalist of common models
  // - Checkbox for "Auto-allow tools" (equivalent to --dangerously-skip-permissions)
}
```

**Model selector for OpenCode:**

```javascript
function createOpenCodeModelInput() {
  const commonModels = [
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-opus-4-5',
    'openai/gpt-5.2',
    'openai/gpt-5.2-mini',
    'google/gemini-3-pro',
    'ollama/codellama',
    'ollama/llama3',
    'ollama/deepseek-coder',
  ];

  // Render as <input> with <datalist> for autocomplete
  // Default to 'anthropic/claude-sonnet-4-5'
}
```

**Tab badge** — Show mode indicator:

```javascript
// In tab rendering (search for shell tab-mode class):
// CURRENT:
// ${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : ''}

// PROPOSED:
function getModeBadge(mode) {
  if (mode === 'opencode') return '<span class="tab-mode opencode" aria-hidden="true">oc</span>';
  if (mode === 'shell') return '<span class="tab-mode shell" aria-hidden="true">sh</span>';
  return ''; // Claude = no badge (default)
}
```

**CSS for OpenCode badge:**

```css
.tab-mode.opencode {
  background: #10b981; /* Green - OpenCode brand */
  color: white;
}
```

**Feature gating** — Disable Claude-specific features for OpenCode:

```javascript
// Functions to check session capabilities:
function isClaudeSession(session) { return session.mode === 'claude'; }
function isOpenCodeSession(session) { return session.mode === 'opencode'; }
function isAgentSession(session) { return session.mode === 'claude' || session.mode === 'opencode'; }

// UI sections to gate:
// - Hooks panel: hide for OpenCode (Phase 7 adds plugin bridge)
// - Auto-compact button: hide for OpenCode (has built-in compaction)
// - Ralph tracker settings: show for both (works via tmux input)
// - Subagent panel: hide for OpenCode initially
// - Token display: hide for OpenCode (Phase 8 adds API tracking)
// - Respawn: show for both (with adapted detection)
// - Input/resize/kill: show for all modes
```

**Respawn section visibility:**

```javascript
// CURRENT (line 10254):
if (session.mode === 'claude' && session.pid) {
  respawnSection.style.display = '';
}

// PROPOSED:
if ((session.mode === 'claude' || session.mode === 'opencode') && session.pid) {
  respawnSection.style.display = '';
}
```

---

## 11. Phase 6: Respawn & Ralph Loop Adaptation

### Respawn Controller

The respawn controller sends Claude CLI commands (`/clear`, `/compact`, `/init`, `/update`) which are Claude-specific. For OpenCode, we need alternative commands.

#### Command Mapping

| Claude Code | OpenCode Equivalent | Notes |
|-------------|---------------------|-------|
| `/clear` | `/clear` | Same command! Clears conversation |
| `/compact` | `Ctrl+X c` | Or opencode handles auto-compaction |
| `/init` | N/A | OpenCode doesn't have this |
| `/update prompt` | Just type the prompt | Direct text input |
| `/resume` | `--continue` flag on restart | Handled at spawn time |

#### Changes to `src/respawn-controller.ts`

```typescript
// In the respawn cycle method:
private async startRespawnCycle(): Promise<void> {
  if (this.session.mode === 'opencode') {
    // OpenCode respawn: simpler cycle
    // 1. Wait for idle (output silence)
    // 2. Optionally compact: skip (OpenCode manages this internally via compaction.auto)
    // 3. Send new prompt via writeViaMux()
    // 4. Wait for completion (output silence again)

    // Send prompt directly — OpenCode TUI accepts typed text
    await this.session.writeViaMux(this.config.prompt);
    return;
  }

  // Existing Claude respawn logic...
}

// Completion detection:
private isCompletionDetected(): boolean {
  if (this.session.mode === 'opencode') {
    // For OpenCode: rely on output silence
    return Date.now() - this.session.lastOutputTime > (this.config.completionSilenceMs || 8000);
  }
  // Existing Claude completion pattern matching
}
```

### Ralph Loop

The Ralph Loop mechanism (send prompt → detect completion → send next prompt) is fundamentally CLI-agnostic since it operates via `writeViaMux()`. The main adaptation needed:

```typescript
// In ralph-loop.ts:
// Completion detection for OpenCode:
if (session.mode === 'opencode') {
  // Use silence-based completion detection
  // OpenCode doesn't emit <promise>PHRASE</promise> tags
  // Ralph tracker's completion phrase detection is skipped
}
```

### Respawn Presets for OpenCode

```javascript
// In app.js, add OpenCode-specific presets:
const OPENCODE_RESPAWN_PRESETS = {
  'opencode-solo': {
    label: 'OpenCode Solo Work',
    idleTimeoutSec: 8,    // Longer than Claude (TUI rendering creates brief output bursts)
    maxDurationMin: 60,
    completionSilenceMs: 8000,
  },
  'opencode-autonomous': {
    label: 'OpenCode Autonomous',
    idleTimeoutSec: 15,
    maxDurationMin: 480,
    completionSilenceMs: 10000,
  },
};
```

---

## 12. Phase 7: Hooks & Plugin Bridge

### Goal
Bridge Claudeman's hook system with OpenCode's plugin system for rich event forwarding.

### Background: Two Different Approaches

| Feature | Claude Code Hooks | OpenCode Plugins |
|---------|-------------------|------------------|
| Format | Shell commands in `settings.local.json` | JS/TS modules in `.opencode/plugins/` |
| Trigger | Hook name matches event type | Event name subscription |
| Key events | `stop`, `idle_prompt`, `permission_prompt`, `elicitation_dialog` | `session.idle`, `permission.asked`, `session.status` |
| Communication | Exit codes + environment variables | Function context + return values |
| Install | Auto-generated by Claudeman | Must be placed in `.opencode/plugins/` |

### Claudeman Plugin for OpenCode

Create a Claudeman plugin that OpenCode loads, which communicates back to Claudeman's API:

**File: `.opencode/plugins/claudeman-bridge.js`** (generated per session)

```javascript
// This plugin bridges OpenCode events to Claudeman's API
export const claudemanBridge = async ({ project, $ }) => {
  const apiUrl = process.env.CLAUDEMAN_API_URL || 'http://localhost:3000';
  const sessionId = process.env.CLAUDEMAN_SESSION_ID;

  if (!sessionId) return {};

  async function notifyClademan(event, data = {}) {
    try {
      await fetch(`${apiUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, event, data }),
      });
    } catch { /* ignore errors */ }
  }

  return {
    'session.idle': async () => {
      await notifyClademan('idle_prompt', { timestamp: Date.now() });
    },
    'session.status': async (status) => {
      await notifyClademan('session_status', { status });
    },
    'permission.asked': async (permission) => {
      await notifyClademan('permission_prompt', { permission });
    },
    'permission.replied': async (reply) => {
      await notifyClademan('permission_reply', { reply });
    },
    'session.error': async (error) => {
      await notifyClademan('session_error', { error });
    },
    'tool.execute.before': async (tool) => {
      await notifyClademan('tool_start', { tool: tool.name });
    },
    'tool.execute.after': async (tool) => {
      await notifyClademan('tool_end', { tool: tool.name });
    },
    'todo.updated': async (todos) => {
      await notifyClademan('todo_update', { todos });
    },
  };
};
```

### Plugin Installation

When creating an OpenCode session, Claudeman generates this plugin in the project's `.opencode/plugins/` directory:

```typescript
// In session.ts or a new opencode-hooks.ts:
async function installOpenCodePlugin(workingDir: string, sessionId: string): Promise<void> {
  const pluginDir = join(workingDir, '.opencode', 'plugins');
  await mkdirp(pluginDir);

  const pluginContent = generateClaudemanBridgePlugin(sessionId);
  await writeFile(join(pluginDir, 'claudeman-bridge.js'), pluginContent);
}
```

### Benefits of the Plugin Bridge

Once installed, Claudeman receives structured events from OpenCode:
- **`session.idle`** → Definitive idle detection (replaces output-silence guessing)
- **`permission.asked`** → Show permission prompts in Claudeman UI
- **`tool.execute.*`** → Tool call tracking (similar to BashToolParser for Claude)
- **`todo.updated`** → OpenCode's built-in todo system → Claudeman can display it
- **`session.error`** → Error surfacing in Claudeman UI

---

## 13. Phase 8: OpenCode Server API Integration (Advanced)

### Goal
For each OpenCode session, optionally run `opencode serve` alongside the TUI for structured API access.

### Architecture

```
tmux session ─── opencode TUI (interactive, port N/A)
                     │
                     ├── xterm.js (terminal rendering, Strategy A)
                     │
Claudeman ──── opencode serve (port 4096+N, background process)
                     │
                     ├── GET  /session/*      → structured session data
                     ├── POST /session/message → send prompt programmatically
                     ├── GET  /session/messages → conversation history
                     ├── SSE  /global/event    → real-time events
                     └── GET  /config/*        → model/provider info
```

### Port Assignment

```typescript
// Each OpenCode session gets a unique port for its server
// Start at 4100, increment per session
private allocateOpenCodePort(): number {
  const basePort = 4100;
  const sessionIndex = Array.from(this.sessions.keys()).indexOf(this.id);
  return basePort + sessionIndex;
}
```

### Server Lifecycle

Start `opencode serve` when session starts, kill when session stops:

```typescript
// In session.startInteractive() for opencode mode:
if (this.mode === 'opencode' && this._openCodeConfig?.serverPort) {
  const { spawn } = require('child_process');
  this._openCodeServer = spawn('opencode', [
    'serve',
    '--port', String(this._openCodeConfig.serverPort),
    '--cors', `http://localhost:${process.env.PORT || 3000}`,
  ], {
    cwd: this.workingDir,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: generateSessionToken(),
    },
    stdio: 'ignore',
    detached: true,
  });

  // Clean up on session stop
  this.once('exit', () => {
    if (this._openCodeServer && !this._openCodeServer.killed) {
      this._openCodeServer.kill('SIGTERM');
    }
  });
}
```

### Proxy Routes in `server.ts`

```typescript
// GET /api/sessions/:id/opencode/session → proxies to opencode serve
// GET /api/sessions/:id/opencode/messages → conversation history
// POST /api/sessions/:id/opencode/message → send message
// GET /api/sessions/:id/opencode/models → available models
```

### Benefits

- **Structured token/cost data** without TUI parsing
- **Conversation history** as structured messages
- **Model switching** mid-session via API
- **Session forking** — create conversation branches
- **Tool call visibility** — see what tools OpenCode is executing
- **Definitive idle/completion state** via API polling

---

## 14. Files to Modify

| File | Changes | Phase |
|------|---------|-------|
| `src/types.ts` | Add `OpenCodeConfig` interface, extend `SessionState` | 1 |
| `src/session.ts` | Extend `SessionMode`, add OpenCode startup/idle/ready logic | 1, 3, 4 |
| `src/mux-interface.ts` | Update mode type to 3-way union, add `openCodeConfig` params | 1 |
| `src/mux-factory.ts` | Pass through `openCodeConfig` | 1 |
| `src/tmux-manager.ts` | Add `buildOpenCodeCommand()`, env var exports, PATH resolution | 3 |
| `src/web/schemas.ts` | Update mode enum, add `OpenCodeConfigSchema` | 1, 5 |
| `src/web/server.ts` | New routes, mode checks, OpenCode availability endpoint | 5 |
| `src/web/public/app.js` | Mode selector, tab badges, model picker, feature gating | 5 |
| `src/respawn-controller.ts` | Mode-aware idle/completion detection, command adaptation | 6 |
| `src/ralph-loop.ts` | Mode-aware completion detection | 6 |
| `src/ralph-tracker.ts` | Skip Claude-specific patterns for OpenCode sessions | 6 |
| `src/state-store.ts` | Persist `openCodeConfig` in session state | 1 |
| `src/hooks-config.ts` | Skip Claude hook generation for OpenCode sessions | 7 |
| `src/utils/index.ts` | Re-export OpenCode resolver | 2 |
| `src/session-lifecycle-log.ts` | Log OpenCode-specific events | 3 |

## 15. Files to Create

| File | Purpose | Phase |
|------|---------|-------|
| `src/utils/opencode-cli-resolver.ts` | Resolve `opencode` binary location | 2 |
| `src/opencode-plugin-generator.ts` | Generate `.opencode/plugins/claudeman-bridge.js` | 7 |
| `src/opencode-api-client.ts` | Client for OpenCode's REST API (Strategy B) | 8 |
| `test/opencode-resolver.test.ts` | Tests for binary resolution | 2 |
| `test/opencode-session.test.ts` | Tests for OpenCode session spawning (port 3155) | 3 |
| `test/opencode-respawn.test.ts` | Tests for OpenCode respawn cycle (port 3156) | 6 |

---

## 16. Existing plan.json Task Breakdown

The file `plan.json` at the project root contains a 48-task TDD breakdown for this integration, organized as:

- **P0** (14 tasks): Core backend abstraction — `LLMBackend` interface, `ClaudeBackend`, `OpenCodeBackend`, `BackendFactory`, Session refactoring
- **P1** (38 tasks): Full integration — CLI resolver, API routes, Zod schemas, config management, respawn adaptation, Ralph tracker, BashToolParser, hooks, frontend UI, subagent watcher, env vars, integration tests, documentation
- **P2** (8 tasks): Advanced — `opencode serve` integration, API client, Ollama model management, cost tracking, mixed-backend Ralph Loop

The `plan.json` approach is more heavyweight (full backend abstraction with DI), suitable if we plan to add more backends. This document recommends the simpler "mode extension" approach for initial implementation.

---

## 17. Risk Assessment

### Low Risk
- **Type system changes** (Phase 1) — Additive, no breaking changes, all defaults remain 'claude'
- **CLI resolver** (Phase 2) — Isolated utility, well-tested pattern from `claude-cli-resolver.ts`
- **Tab badges** (Phase 5) — Cosmetic only
- **Feature gating** (Phase 5) — Just `if` checks on `session.mode`

### Medium Risk
- **Tmux command construction** (Phase 3) — Must handle: missing binary, bad model string, env var escaping, shell metacharacter injection. Mitigated by following the exact Claude pattern and input validation.
- **Idle detection** (Phase 4) — Output silence is less precise than prompt detection. May trigger false positives (TUI redraws create brief output) or false negatives (slow model responses). Mitigated by conservative timeouts (5-8s).
- **Respawn loop** (Phase 6) — Without Claude-quality completion detection, respawn may be less reliable. Mitigated by longer idle timeouts and the plugin bridge (Phase 7) providing definitive `session.idle` events.

### High Risk
- **OpenCode TUI in xterm.js** — Bubble Tea uses alternate screen buffer, mouse events, and complex cursor manipulation. **Must validate manually in Phase 0** before any coding.
- **OpenCode server API** (Phase 8) — Running a second HTTP server per session increases complexity (port conflicts, zombie processes, resource usage). Mitigated by making it optional.
- **Plugin bridge reliability** (Phase 7) — The generated plugin depends on OpenCode loading it correctly and the fetch calls not failing silently. Need error handling and fallback.

### Unknowns (Resolved by Phase 0 Manual Testing)
- OpenCode's TUI escape sequences — Does xterm.js render them correctly?
- OpenCode's SIGWINCH handling — Does resize work through tmux?
- OpenCode's stdin behavior — Does `tmux send-keys -l` work for typing?
- Separate `send-keys Enter` — Does it trigger prompt submission in OpenCode's TUI?
- `remain-on-exit` behavior — Does the tmux session stay alive when OpenCode exits?
- `opencode.json` conflicts — If one exists in the project, do CLI flags override it?

---

## 18. Testing Strategy

### Unit Tests

```bash
# Test OpenCode CLI resolver
npx vitest run test/opencode-resolver.test.ts

# Test session with mocked OpenCode
npx vitest run test/opencode-session.test.ts

# Test respawn with OpenCode backend
npx vitest run test/opencode-respawn.test.ts
```

### Test Ports (Following Convention)

- `opencode-resolver.test.ts` — No port needed (pure unit test)
- `opencode-session.test.ts` — Port **3155**
- `opencode-respawn.test.ts` — Port **3156**
- `opencode-integration.test.ts` — Port **3157** (future)

### Integration Tests

1. **Manual smoke test**: Install OpenCode → create session via API → verify TUI renders in xterm.js
2. **Playwright test**: Automate session creation → verify terminal has content → send input → verify response
3. **Respawn test**: Start respawn → verify prompt sending → verify completion detection

### Safety Rules

- **Never run OpenCode tests that spawn real tmux sessions inside Claudeman** (same safety rule as Claude tests)
- **Use MockSession** from `test/respawn-test-utils.ts` for respawn testing
- **Mock the opencode binary** for unit tests (`jest.mock` or stub)
- **Use unique test ports** (3155+) — never port 3000

---

## 19. Open Questions & Decisions

### Resolved

| Question | Decision |
|----------|----------|
| Simple extension vs. backend abstraction? | Simple extension first (add `'opencode'` to `SessionMode`), refactor later if needed |
| Should OpenCode sessions share same tab UI? | Yes, same UI with "oc" mode badge |
| How to handle permissions? | `OPENCODE_CONFIG_CONTENT` env var with `"permission": {"*": "allow"}` |
| How to handle model selection? | Pass via `--model` CLI flag + store in `openCodeConfig` |

### Open

1. **Should we support `opencode run` (non-interactive pipe mode)?**
   - Could be useful for one-shot prompts and AI checker. Lower priority than TUI mode.
   - Recommendation: Defer to Phase 8.

2. **Should Ralph Loop work with OpenCode?**
   - Technically possible (send prompts via tmux, detect completion by silence + plugin events)
   - May be less reliable without completion phrase detection
   - Recommendation: Support it with longer timeouts and clear documentation

3. **What about OpenCode's built-in agent system?**
   - OpenCode has "build", "task", "title" agents plus custom agents
   - Recommendation: Ignore initially, add agent selection dropdown in Phase 8

4. **Should AI checkers use Claude or OpenCode for analysis?**
   - AI checkers currently always spawn `claude -p` for analysis
   - Recommendation: Always use Claude for AI checks (if available), since it's purpose-built for analysis

5. **Should we auto-generate `opencode.json` in the working directory?**
   - Option A: Let OpenCode use existing project config (respect user settings)
   - Option B: Generate a temporary one with Claudeman's settings
   - Recommendation: Option A (use `OPENCODE_CONFIG_CONTENT` env var for Claudeman-specific overrides, don't modify project files)

6. **How should OpenCode session IDs map to Claudeman session IDs?**
   - OpenCode manages its own sessions (SQLite DB)
   - We could pass `--session <claudeman-id>` but OpenCode IDs have different format
   - Recommendation: Let OpenCode manage its own sessions, store the mapping in SessionState

---

## 20. Implementation Order

### Recommended Sequence

```
Phase 0: Manual validation (30 min)
  ↓
Phase 1: Type system (1 hour)
  ↓
Phase 2: CLI resolver (30 min)
  ↓
Phase 3: Tmux spawn (2-3 hours) ← CRITICAL INTEGRATION POINT
  ↓
Phase 4: Idle detection (1-2 hours)
  ↓
Phase 5: API + frontend (2-3 hours) ← FIRST USER-VISIBLE RESULT
  ↓
Phase 6: Respawn adaptation (2-3 hours)
  ↓
Phase 7: Plugin bridge (2-3 hours) ← QUALITY IMPROVEMENT
  ↓
Phase 8: Server API (4-6 hours) ← OPTIONAL ADVANCED
```

### Milestones

| Milestone | Phase | What You Can Do |
|-----------|-------|-----------------|
| **M1: "It renders"** | 0-3 | OpenCode TUI visible in xterm.js via Claudeman |
| **M2: "It's usable"** | 4-5 | Create OpenCode sessions from web UI, type and interact |
| **M3: "It's autonomous"** | 6 | Respawn and Ralph Loop work with OpenCode |
| **M4: "It's smart"** | 7 | Plugin bridge provides definitive idle detection |
| **M5: "It's rich"** | 8 | Token tracking, conversation history, model switching via API |

### Total Effort Estimate

- **Phases 0-5** (MVP): ~8-10 hours
- **Phase 6** (Respawn): ~2-3 hours
- **Phase 7** (Plugins): ~2-3 hours
- **Phase 8** (Server API): ~4-6 hours
- **Total**: ~16-22 hours for full integration

---

## Appendix A: OpenCode CLI Reference

```
Usage: opencode [options] [path]

Commands:
  (default)          Start interactive TUI
  run <prompt>       Execute prompt non-interactively
  serve              Start headless API server
  web                Start server with web UI
  attach <url>       Connect TUI to remote server
  session list       List all sessions
  export [id]        Export session as JSON
  import <file>      Import session from file/URL
  models [provider]  List available models
  agent create       Create custom agent
  agent list         List agents

Global Flags:
  -m, --model <model>      Model (provider/model format)
  -c, --continue           Continue last session
  -s, --session <id>       Resume specific session
  --fork                   Branch when continuing
  --cwd <dir>              Working directory
  -d, --debug              Enable debug logging
  --log-level <level>      Set log level
  --print-logs             Print logs to stdout
  -v, --version            Show version
  -h, --help               Show help

Run Flags:
  --format <fmt>    Output format (default, json)
  --file <path>     Attach file(s) to prompt
  --title <name>    Custom session title
  --attach <url>    Use remote server
  --port <port>     Local server port
  --command <cmd>   Custom executable
  --share           Enable session sharing

Serve Flags:
  --port <port>        Listen port (default: auto)
  --hostname <host>    Bind hostname
  --mdns               Enable mDNS discovery
  --cors <origins>     CORS origins

Environment Variables:
  ANTHROPIC_API_KEY          Anthropic API key
  OPENAI_API_KEY             OpenAI API key
  GOOGLE_API_KEY             Google AI API key
  OPENCODE_MODEL             Default model
  OPENCODE_CONFIG            Custom config file path
  OPENCODE_CONFIG_DIR        Custom config directory
  OPENCODE_CONFIG_CONTENT    Inline JSON config
  OPENCODE_PERMISSION        Inline JSON permission config
  OPENCODE_SERVER_PASSWORD   Server auth password
  OPENCODE_CLIENT            Client identifier (default: "cli")
```

---

## Appendix B: OpenCode Plugin Events

Full list of subscribable events in OpenCode's plugin system:

| Category | Event | Description | Claudeman Relevance |
|----------|-------|-------------|---------------------|
| **Command** | `command.executed` | Slash command run | Low |
| **Files** | `file.edited` | File modified | Medium (track changes) |
| | `file.watcher.updated` | File watcher trigger | Low |
| **Installation** | `installation.updated` | Config/deps changed | Low |
| **LSP** | `lsp.client.diagnostics` | Lint/type errors | Medium (show in UI) |
| | `lsp.updated` | LSP state change | Low |
| **Messages** | `message.part.updated` | Streaming token | High (progress tracking) |
| | `message.updated` | Complete message | High (completion detection) |
| | `message.removed` | Message deleted | Low |
| | `message.part.removed` | Part deleted | Low |
| **Permissions** | `permission.asked` | Tool approval needed | **Critical** (show in Claudeman) |
| | `permission.replied` | User responded | High (track approvals) |
| **Server** | `server.connected` | Server started | Medium |
| **Sessions** | `session.idle` | Agent finished working | **Critical** (idle detection!) |
| | `session.status` | Status change | High (working/idle state) |
| | `session.created` | New session | Medium |
| | `session.updated` | Session modified | Medium |
| | `session.deleted` | Session removed | Medium |
| | `session.compacted` | Context compacted | Medium (track compactions) |
| | `session.diff` | Code changes | Medium |
| | `session.error` | Error occurred | **Critical** (error surfacing) |
| **Todo** | `todo.updated` | Todo list changed | High (Ralph integration) |
| **Shell** | `shell.env` | Env var injection | Low |
| **Tools** | `tool.execute.before` | Tool about to run | High (tool tracking) |
| | `tool.execute.after` | Tool completed | High (tool tracking) |
| **TUI** | `tui.prompt.append` | Text added to prompt | Low |
| | `tui.command.execute` | TUI command run | Low |
| | `tui.toast.show` | Notification shown | Low |
| **Experimental** | `experimental.session.compacting` | Custom compaction | Low |

---

## Appendix C: OpenCode Permission Config

### Auto-Allow Everything (Equivalent to `--dangerously-skip-permissions`)

```json
{
  "permission": {
    "*": "allow"
  }
}
```

### Granular Permissions

```json
{
  "permission": {
    "*": "ask",
    "bash": {
      "*": "ask",
      "git *": "allow",
      "npm *": "allow",
      "rm *": "deny",
      "sudo *": "deny"
    },
    "edit": "allow",
    "write": "allow",
    "read": "allow"
  }
}
```

### Permission Levels

- `"allow"` — Execute without approval
- `"ask"` — Prompt user for approval
- `"deny"` — Block the action

### Delivery Method for Claudeman

Use `OPENCODE_CONFIG_CONTENT` environment variable to inject permissions without modifying project files:

```bash
export OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow"}}'
opencode --model anthropic/claude-sonnet-4-5
```

---

## Appendix D: Current Claudeman Session Spawn Flow (Annotated)

### Exact Code Path (for reference during implementation)

```
1. POST /api/sessions (server.ts:810)
   → Validate body with Zod
   → new Session({mode, workingDir, mux: TmuxManager, ...})
   → sessions.set(id, session)
   → setupSessionListeners(session)
   → broadcast('session:created')

2. POST /api/sessions/:id/interactive (server.ts:1635)
   → session.startInteractive()

3. session.startInteractive() (session.ts:892)
   → Check for existing muxSession
   → If none: this._mux.createSession(id, workingDir, 'claude', ...)

4. TmuxManager.createSession() (tmux-manager.ts:225)
   → tmux new-session -ds "claudeman-<shortId>" -c <workingDir> -x 120 -y 40
   → tmux set-option -t "claudeman-<shortId>" remain-on-exit on
   → Build command: "export PATH=... && export LANG=... && claude --dangerously-skip-permissions --session-id <id>"
   → tmux respawn-pane -k -t "claudeman-<shortId>" '<command>'
   → Wait 100ms, configure tmux, get PID
   → Return MuxSession { muxName, pid, mode }

5. Back in startInteractive() (session.ts:~950)
   → pty.spawn('tmux', ['attach-session', '-t', 'claudeman-<shortId>'], {
       name: 'xterm-256color',
       cols: 120, rows: 40,
       env: { LANG, LC_ALL, TERM }
     })
   → ptyProcess.onData(rawData => {
       // Filter focus escape sequences
       // Append to terminal buffer
       // Emit 'terminal' event → SSE broadcast → xterm.js
       // Throttled: ANSI strip, Ralph tracker, bash parser, token parsing
     })
   → ptyProcess.onExit(...)
   → Wait for prompt (poll for ❯ character)

6. SSE Pipeline (server.ts)
   → setupSessionListeners.terminal handler
   → batchTerminalData(sessionId, data)
   → flushSessionTerminalBatch() (16-50ms timer)
   → DEC 2026 sync wrapping
   → broadcast('session:terminal', { id, data })
   → sendSSEPreformatted() to all clients

7. Frontend (app.js)
   → EventSource at /api/events
   → addListener('session:terminal', ...)
   → batchTerminalWrite() → requestAnimationFrame → terminal.write()
```

### What Changes for OpenCode

Only steps 3-5 change:
- **Step 3**: `session.startInteractive()` calls `createSession(..., 'opencode', ...)` instead of `'claude'`
- **Step 4**: `TmuxManager.createSession()` builds `opencode --model ...` instead of `claude --dangerously-skip-permissions ...`
- **Step 5**: `waitForOpenCodeReady()` instead of polling for `❯` prompt

Everything else (steps 1, 2, 6, 7) is **completely unchanged**.
