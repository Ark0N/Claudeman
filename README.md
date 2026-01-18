# Claudeman

A Claude Code session manager with an autonomous Ralph Loop for task assignment and monitoring.

## Features

- **Session Management**: Spawn and manage multiple Claude CLI sessions as subprocesses
- **Task Queue**: Priority-based task queue with dependency support
- **Ralph Loop**: Autonomous control loop that assigns tasks to idle sessions and monitors completion
- **Time-Aware Loops**: Set minimum durations for extended autonomous work sessions
- **State Persistence**: All state persisted to `~/.claudeman/state.json`

## Installation

```bash
npm install
npm run build
npm link  # Optional: make 'claudeman' available globally
```

## Quick Start

```bash
# Start a Claude session
claudeman start --dir /path/to/project

# Add tasks to the queue
claudeman task add "Fix the bug in auth.ts"
claudeman task add "Add tests for the API" --priority 5

# Start the Ralph loop to process tasks
claudeman ralph start

# Check status
claudeman status
```

## Commands

### Session Management

```bash
# Start a new session
claudeman session start [--dir <path>]
claudeman start [--dir <path>]  # shorthand

# Stop a session
claudeman session stop <session-id>

# List sessions
claudeman session list
claudeman list  # shorthand

# View session output
claudeman session logs <session-id>
claudeman session logs <session-id> --errors  # stderr
```

### Task Management

```bash
# Add a task
claudeman task add "<prompt>" [options]
  --dir <path>           Working directory
  --priority <n>         Priority (higher = processed first)
  --completion <phrase>  Custom completion phrase to detect
  --timeout <ms>         Task timeout in milliseconds

# List tasks
claudeman task list
claudeman task list --status pending

# View task details
claudeman task status <task-id>

# Remove a task
claudeman task remove <task-id>

# Clear tasks
claudeman task clear              # completed tasks
claudeman task clear --failed     # failed tasks
claudeman task clear --all        # all tasks
```

### Ralph Loop

```bash
# Start the autonomous loop
claudeman ralph start
claudeman ralph start --min-hours 4      # run for at least 4 hours
claudeman ralph start --no-auto-generate # disable auto task generation

# Stop the loop
claudeman ralph stop

# Check loop status
claudeman ralph status
```

### Utility

```bash
# Overall status
claudeman status

# Reset all state (stops sessions, clears tasks)
claudeman reset --force
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claudeman CLI                        │
├─────────────────────────────────────────────────────────┤
│  Ralph Loop Controller                                  │
│  - Monitors all sessions                                │
│  - Assigns tasks from queue                             │
│  - Detects completion/failure                           │
│  - Self-generates follow-up tasks                       │
├─────────────────────────────────────────────────────────┤
│  Session Manager              │  Task Queue             │
│  - Spawn claude processes     │  - Priority queue       │
│  - Track stdin/stdout/stderr  │  - Task definitions     │
│  - Health monitoring          │  - Dependencies         │
│  - Graceful shutdown          │  - Status tracking      │
├─────────────────────────────────────────────────────────┤
│  State Store (JSON file persistence)                    │
│  - Sessions, tasks, logs                                │
└─────────────────────────────────────────────────────────┘
```

## Completion Detection

The Ralph Loop detects task completion by looking for:

1. **Promise tags**: `<promise>COMPLETE</promise>` or custom phrases
2. **Common indicators**: "Task completed successfully", "All tasks done", "✓ Complete"

When creating tasks, you can specify a custom completion phrase:

```bash
claudeman task add "Refactor the auth module" --completion "AUTH_REFACTOR_DONE"
```

The session output will be scanned for `<promise>AUTH_REFACTOR_DONE</promise>`.

## Time-Aware Loops

For extended autonomous work sessions:

```bash
claudeman ralph start --min-hours 8
```

When the minimum duration hasn't been reached and all tasks are complete, the Ralph Loop will auto-generate follow-up tasks like:

- Review and optimize recently changed code
- Add tests for uncovered code paths
- Update documentation
- Check for security vulnerabilities
- Run linting and fix issues

## State File

All state is persisted to `~/.claudeman/state.json`:

```json
{
  "sessions": { ... },
  "tasks": { ... },
  "ralphLoop": {
    "status": "running",
    "startedAt": 1234567890,
    "minDurationMs": 14400000,
    "tasksCompleted": 5,
    "tasksGenerated": 2
  },
  "config": {
    "pollIntervalMs": 1000,
    "defaultTimeoutMs": 300000,
    "maxConcurrentSessions": 5
  }
}
```

## Development

```bash
# Run in development mode
npm run dev -- start

# Build
npm run build

# Clean build artifacts
npm run clean
```

## Requirements

- Node.js 18+
- Claude CLI (`claude`) installed and available in PATH
