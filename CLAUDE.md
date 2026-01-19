# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Tech Stack**: TypeScript (ES2022/NodeNext), Node.js, Fastify, Server-Sent Events, node-pty

**Requirements**: Node.js 18+, Claude CLI (`claude`) installed and available in PATH

## Commands

```bash
npm run build          # Compile TypeScript + copy static files to dist/web/
npm run clean          # Remove dist/

# Start web server (pick one):
npx tsx src/index.ts web           # Dev mode - no build needed (RECOMMENDED)
npx tsx src/index.ts web -p 8080   # Dev mode with custom port
node dist/index.js web             # After npm run build
claudeman web                      # After npm link

# IMPORTANT: `npm run dev` runs the CLI help, NOT the web server
# Always use `npx tsx src/index.ts web` for development

# Testing (vitest)
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern
```

## Architecture

```
src/
├── index.ts              # CLI entry point (commander)
├── cli.ts                # CLI command implementations
├── session.ts            # Core: PTY wrapper for Claude CLI + token tracking
├── session-manager.ts    # Manages multiple sessions
├── screen-manager.ts     # GNU screen session persistence + process stats
├── respawn-controller.ts # Auto-respawn state machine
├── task-tracker.ts       # Background task detection and tree display
├── ralph-loop.ts         # Autonomous task assignment
├── task.ts / task-queue.ts # Priority queue with dependencies
├── state-store.ts        # Persistence to ~/.claudeman/state.json
├── types.ts              # All TypeScript interfaces
├── web/
│   ├── server.ts         # Fastify REST API + SSE + session restoration
│   └── public/           # Static frontend files (vanilla JS, xterm.js)
└── templates/
    └── claude-md.ts      # CLAUDE.md generator for new cases
```

### Data Flow

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty`
2. PTY output is buffered, ANSI stripped, and parsed for JSON messages
3. **WebServer** broadcasts events to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via **StateStore**

### Key Components

- **Session** (`src/session.ts`): Wraps Claude CLI as PTY subprocess. Two modes: `runPrompt(prompt)` for one-shot, `startInteractive()` for persistent terminal. Emits `output`, `terminal`, `message`, `completion`, `exit`, `idle`, `working`, `autoClear`, `clearTerminal` events.

- **RespawnController** (`src/respawn-controller.ts`): State machine that keeps interactive sessions productive. Detects idle → sends update prompt → optionally `/clear` → optionally `/init` → repeats.

- **ScreenManager** (`src/screen-manager.ts`): Manages GNU screen sessions for persistent terminals. Screens survive server restarts.

- **WebServer** (`src/web/server.ts`): Fastify server with REST API + SSE. All endpoints under `/api/`. See file for full route list.

### Session Modes

- **One-Shot** (`runPrompt(prompt)`): Execute single prompt, receive completion event, session exits
- **Interactive** (`startInteractive()`): Persistent PTY terminal with resize support, buffer persistence
- **Shell** (`startShell()`): Plain bash/zsh terminal without Claude

## Code Patterns

### Claude Message Parsing

Claude CLI outputs newline-delimited JSON. Strip ANSI codes before parsing:

```typescript
const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');
const msg = JSON.parse(cleanLine) as ClaudeMessage;
// msg.type: 'system' | 'assistant' | 'user' | 'result'
// msg.message?.content: Array<{ type: 'text', text: string }>
// msg.total_cost_usd: number (on result messages)
```

### PTY Spawn Modes

```typescript
// One-shot mode (JSON output for token tracking)
pty.spawn('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', prompt], { ... })

// Interactive mode (tokens parsed from status line)
pty.spawn('claude', ['--dangerously-skip-permissions'], { ... })
```

### Idle Detection

Session detects idle by watching for prompt character (`❯` or `\u276f`) and waiting 2 seconds without activity. RespawnController uses the same patterns plus spinner characters to detect working state.

### Token Tracking

- **One-shot mode**: Uses `--output-format stream-json` for detailed token usage from JSON
- **Interactive mode**: Parses tokens from Claude's status line (e.g., "123.4k tokens"), estimates 60/40 input/output split

### Respawn Controller State Machine

```
WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → WATCHING
```

### Screen Session Initialization

GNU screen creates blank space at top when initializing. After attaching:
- **Claude sessions**: Clear buffer, emit `clearTerminal` event, client clears xterm
- **Shell sessions**: Clear buffer, send `clear\n` command

### Tab Switching Fix

When switching Claude session tabs, terminal may be rendered at wrong size. Fix sequence:
1. Clear and reset xterm
2. Write terminal buffer
3. Send resize to update PTY dimensions
4. Send Ctrl+L (`\x0c`) to trigger Claude CLI redraw

### SSE Events

All events broadcast to `/api/events` with format: `{ type: string, sessionId?: string, data: any }`.

Event prefixes: `session:`, `task:`, `respawn:`, `scheduled:`, `case:`, `init`. Key events: `session:idle`, `session:working`, `session:terminal`, `session:clearTerminal`, `session:completion`, `respawn:stateChanged`.

## Adding New Features

### New API Endpoint
1. Add types to `src/types.ts`
2. Add route in `src/web/server.ts` within `buildServer()`
3. Use `createErrorResponse()` for errors

### New SSE Event
1. Emit from component via `broadcast()` in server.ts
2. Handle in `src/web/public/app.js` `handleSSEEvent()` switch

### New Session Event
1. Add to `SessionEvents` interface in `src/session.ts`
2. Emit via `this.emit()`
3. Subscribe in `src/web/server.ts` when wiring session to SSE
4. Handle in frontend SSE listener

## Notes

- State persists to `~/.claudeman/state.json` and `~/.claudeman/screens.json`
- Cases created in `~/claudeman-cases/` by default
- Sessions wrapped in GNU screen for persistence across server restarts
- Tests use vitest with `vi.mock()` - no real Claude CLI spawned
- Long-running sessions (12-24+ hours) supported with automatic buffer trimming
- E2E testing available via agent-browser (see `.claude/skills/e2e-test.md`)
