# Spawn1337 Protocol (Autonomous Agents)

Spawned agents are full-power Claude sessions running in their own screen sessions. They communicate via a filesystem-based message bus and signal completion via RalphTracker's `<promise>` mechanism.

## Primary Interface: MCP Server

The `claudeman-mcp` binary exposes spawn tools to Claude Code via MCP protocol, replacing the legacy terminal-tag-parsing approach (SpawnDetector).

### MCP Tools

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a new autonomous agent (builds task spec from parameters) |
| `list_agents` | List all agents (active + completed + queued) |
| `get_agent_status` | Get detailed agent status + progress |
| `get_agent_result` | Read a completed agent's result |
| `send_agent_message` | Send a message to a running agent |
| `cancel_agent` | Cancel a running agent |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDEMAN_API_URL` | Base URL for the Claudeman API (default: `http://localhost:3000`) |
| `CLAUDEMAN_SESSION_ID` | Session ID of the calling Claude session |

## Protocol Flow

```
Claude calls spawn_agent MCP tool
  → MCP server builds task spec YAML
  → POST /api/spawn/trigger with task spec
  → SpawnOrchestrator creates agent directory: ~/claudeman-cases/spawn-<agentId>/
  → Spawns interactive Claude session in screen
  → Injects initial prompt via writeViaScreen()
  → Agent works autonomously, writes progress to spawn-comms/
  → RalphTracker detects <promise>PHRASE</promise> on child
  → Orchestrator reads result.md, notifies parent via SSE
```

## Agent Directory Structure

Each agent gets: `~/claudeman-cases/spawn-<agentId>/`

```
spawn-<agentId>/
├── CLAUDE.md              # Generated from spawn-claude-md.ts
├── spawn-comms/
│   ├── task.md            # Task specification
│   ├── progress.json      # Current progress state
│   ├── result.md          # Final result (on completion)
│   └── messages/          # Inter-agent messaging
└── workspace/             # Symlinked context files
```

## Resource Governance

| Limit | Value |
|-------|-------|
| Max concurrent agents | 5 |
| Max depth | 3 |
| Default timeout | 30min |
| Max timeout | 120min |
| Budget warning | 80% |
| Graceful shutdown | 100% |
| Force kill | 110% |

## Agent Tree

Agents can spawn children. Sessions track `parentAgentId` and `childAgentIds`. Cancelling a parent cascades to all children.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/mcp-server.ts` | MCP server binary exposing spawn tools |
| `src/spawn-orchestrator.ts` | Full agent lifecycle: spawn, monitor, budget, queue, cleanup |
| `src/spawn-claude-md.ts` | Generates CLAUDE.md for spawned agent sessions |
| `src/spawn-types.ts` | Types, YAML parser, factory functions |
| `src/spawn-detector.ts` | Legacy: detects `<spawn1337>` tags in terminal output |
