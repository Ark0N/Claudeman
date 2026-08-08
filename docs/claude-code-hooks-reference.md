# Claude Code Hooks Reference

> Official documentation for Claude Code hooks system, extracted from [code.claude.com](https://code.claude.com/docs/en/hooks).

**Last Updated**: 2026-07-25
**Source**: [Claude Code Hooks Documentation](https://code.claude.com/docs/en/hooks)

> This is a maintained summary, not an exhaustive copy of the upstream reference.
> Check the source link for event-specific schemas before adding a new hook.

---

## Overview

Hooks are automated scripts that execute at specific events during your Claude Code session. They allow you to:

- Validate, modify, or block tool usage
- Add context to prompts
- Implement custom workflows
- Control agent behavior

---

## Configuration

Hooks are configured in settings files:

| File                          | Scope                      |
| ----------------------------- | -------------------------- |
| `~/.claude/settings.json`     | User (global)              |
| `.claude/settings.json`       | Project                    |
| `.claude/settings.local.json` | Local project (gitignored) |
| Plugin hook files             | Plugin-specific            |

### Basic Structure

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here"
          }
        ]
      }
    ]
  }
}
```

**Key Fields**:

- `matcher`: Pattern to match tool names (case-sensitive, supports regex like `Edit|Write` or `*` for all)
- `type`: `"command"`, `"http"`, `"mcp_tool"`, `"prompt"`, or `"agent"` where the event supports it
- `command`: Bash command to execute
- `prompt`: LLM prompt for evaluation (prompt-based hooks only)
- `timeout`: Optional timeout in seconds (default: 60)

---

## Hook Events

Claude Code's current event surface is broader than the detailed subset below. In
particular, `TeammateIdle` and `TaskCompleted` are supported lifecycle events used
by Codeman; they are not stale or plugin-defined event names.

### PreToolUse

**When**: After Claude creates tool parameters, before processing the tool call.

**Use Cases**: Approval, denial, or modification of tool calls.

**Common Matchers**:

- `Bash` - Shell commands
- `Write` - File writing
- `Edit` - File editing
- `Read` - File reading
- `Agent` - Subagent tasks
- `WebFetch`, `WebSearch` - Web operations
- `mcp__<server>__<tool>` - MCP tools

**Output Control**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "string",
    "updatedInput": {
      "field_to_modify": "new value"
    },
    "additionalContext": "Context for Claude"
  }
}
```

### PermissionRequest

**When**: When the user is shown a permission dialog.

**Use Cases**: Auto-approve or deny permissions.

**Output Control**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow|deny",
      "updatedInput": {},
      "message": "deny reason",
      "interrupt": false
    }
  }
}
```

### PostToolUse

**When**: Immediately after a tool completes successfully.

**Use Cases**: Provide feedback, run formatters/linters, log operations.

**Output Control**:

```json
{
  "decision": "block",
  "reason": "Explanation",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Additional information"
  }
}
```

#### Asynchronous Rewake

Command hooks can set `"asyncRewake": true` to run asynchronously and wake an
idle Claude turn when the hook exits with code 2. The hook's stderr is delivered
to Claude as a system reminder. This implies `"async": true`; ordinary async
hooks do not wake an idle turn, and their output waits for the next interaction.

Codeman uses this on `PostToolUse(Bash)`: a self-contained Node helper extracts
the background task ID from the Bash result, watches the originating transcript
and, for subagents, the top-level parent transcript for the matching completion
notification, and exits 2. Claude records a subagent's Bash result in its
`subagents/agent-*.jsonl` file but queues completion in the lead session JSONL.
The task ID keeps each wake targeted. The helper does not send terminal input,
so it cannot submit a user's partially written prompt.

For script-dispatched Codex work, `codex-run.sh` writes the final response
between `CODEMAN_RESULT_BEGIN/END` markers in the background task output. The
rewake helper includes a maximum of 64 KiB of that report in its feedback. UI
subagent discovery and dispatcher result delivery are separate contracts.

### Notification

**When**: When Claude Code sends notifications.

**Matchers**:

- `permission_prompt`
- `idle_prompt`
- `auth_success`
- `elicitation_dialog`
- `elicitation_complete`
- `elicitation_response`

### UserPromptSubmit

**When**: When the user submits a prompt, before Claude processes it.

**Use Cases**: Add context, validate, or block prompts.

**Output Control**:

```json
{
  "decision": "block",
  "reason": "Explanation",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "My additional context"
  }
}
```

### Stop

**When**: When the main Claude Code agent finishes responding.

**Important**: Does NOT run on user interrupt.

**Use Cases**: **Ralph Wiggum loops** - block exit and refeed prompt.

**Output Control**:

```json
{
  "decision": "block",
  "reason": "Must provide when blocking"
}
```

Or to allow exit:

```json
{
  "continue": true,
  "stopReason": "optional message"
}
```

**Note**: For Stop events, `"continue": false` takes precedence over `"decision": "block"`.

### SubagentStop

**When**: When a subagent (Agent tool call) finishes responding.

**Use Cases**: Control nested loops, verify subagent output.

The hook input includes `agent_id`, `agent_transcript_path`, and
`last_assistant_message`. Like `Stop`, a command hook can return
`{"decision":"block","reason":"..."}` to keep the subagent running and feed
the reason back to it.

Codeman uses this to prevent premature reports from workers that still own live
Monitor or background-Bash processes. It derives candidate task IDs from the
subagent transcript, but requires a matching live Linux process descriptor for
`tasks/<id>.output`; historical task text by itself is not treated as active.

### TeammateIdle

**When**: When an agent-team teammate is about to go idle.

**Use Cases**: Reassign work, continue a teammate loop, or notify an orchestrator.

**Matcher Support**: None. The hook fires for every occurrence.

### TaskCompleted

**When**: When a task is about to be marked completed.

**Use Cases**: Validate completion or forward team progress to an external UI.

**Matcher Support**: None. The hook fires for every occurrence.

### PreCompact

**When**: Before a compact operation.

**Matchers**:

- `manual` - Invoked from `/compact`
- `auto` - Invoked from auto-compact

### SessionStart

**When**: When Claude Code starts or resumes a session.

**Matchers**:

- `startup` - Fresh start
- `resume` - From `--resume`, `--continue`, or `/resume`
- `clear` - From `/clear`
- `compact` - From auto or manual compact

**Use Cases**: Load development context, set environment variables.

**Persisting Environment Variables**:

```bash
#!/bin/bash
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export NODE_ENV=production' >> "$CLAUDE_ENV_FILE"
  echo 'export API_KEY=your-api-key' >> "$CLAUDE_ENV_FILE"
fi
exit 0
```

**Output Control**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Context to load"
  }
}
```

### SessionEnd

**When**: When a session ends.

**Reason Values**:

- `clear`
- `logout`
- `prompt_input_exit`
- `other`

**Use Cases**: Cleanup tasks, logging.

---

## Hook Input

Hooks receive JSON via stdin with common fields:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/directory",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {},
  "tool_use_id": "toolu_01ABC123..."
}
```

### Tool-Specific Input

**Bash**:

```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "psql -c 'SELECT * FROM users'",
    "description": "Query the users table",
    "timeout": 120000
  }
}
```

**Write**:

```json
{
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  }
}
```

**Edit**:

```json
{
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "old_string": "original text",
    "new_string": "replacement text"
  }
}
```

---

## Hook Output

### Exit Codes

| Code  | Behavior                                                              |
| ----- | --------------------------------------------------------------------- |
| 0     | Success. `stdout` processed (shown in verbose or added as context)    |
| 2     | Blocking error. Only `stderr` used. Blocks tool/prompt based on event |
| Other | Non-blocking error. `stderr` shown in verbose, execution continues    |

### JSON Output (Exit Code 0)

```json
{
  "continue": true,
  "stopReason": "optional message",
  "suppressOutput": true,
  "systemMessage": "optional warning"
}
```

---

## Prompt-Based Hooks

Prompt and agent handlers are supported by decision-oriented events including
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`,
`PostToolBatch`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `TaskCreated`, and
`TaskCompleted`. Check the upstream reference before choosing a handler type.

For example, a Stop event can use LLM-based evaluation:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Should Claude stop? Context: $ARGUMENTS\n\nCheck if all tasks are complete.",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

**LLM Response Format**:

```json
{
  "ok": true,
  "reason": "Explanation when ok is false"
}
```

---

## Component-Scoped Hooks

Hooks can be defined in Skills, Agents, and Slash Commands using frontmatter:

```markdown
---
name: secure-operations
hooks:
  PreToolUse:
    - matcher: 'Bash'
      hooks:
        - type: command
          command: './scripts/security-check.sh'
---
```

These hooks:

- Are scoped to the component's lifecycle
- Only run when that component is active
- Support all hook events; a subagent-scoped `Stop` is converted to `SubagentStop`

---

## MCP Tools

MCP tools follow the pattern `mcp__<server>__<tool>`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__memory__.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Memory operation' >> ~/mcp.log"
          }
        ]
      },
      {
        "matcher": "mcp__.*__write.*",
        "hooks": [
          {
            "type": "command",
            "command": "/home/user/scripts/validate-mcp-write.py"
          }
        ]
      }
    ]
  }
}
```

---

## Examples

### Bash Command Validation

```python
#!/usr/bin/env python3
import json
import re
import sys

VALIDATION_RULES = [
    (r"\bgrep\b(?!.*\|)", "Use 'rg' instead of 'grep'"),
    (r"\bfind\s+\S+\s+-name\b", "Use 'rg --files' instead of 'find -name'"),
]

try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)

tool_name = input_data.get("tool_name", "")
tool_input = input_data.get("tool_input", {})
command = tool_input.get("command", "")

if tool_name != "Bash" or not command:
    sys.exit(1)

issues = []
for pattern, message in VALIDATION_RULES:
    if re.search(pattern, command):
        issues.append(message)

if issues:
    for message in issues:
        print(f"- {message}", file=sys.stderr)
    sys.exit(2)
```

### Auto-Approve Documentation Reads

```python
#!/usr/bin/env python3
import json
import sys

try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)

tool_name = input_data.get("tool_name", "")
tool_input = input_data.get("tool_input", {})

if tool_name == "Read":
    file_path = tool_input.get("file_path", "")
    if file_path.endswith((".md", ".mdx", ".txt", ".json")):
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Documentation file auto-approved"
            },
            "suppressOutput": True
        }
        print(json.dumps(output))
        sys.exit(0)

sys.exit(0)
```

### Post-Write Formatter

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$TOOL_INPUT_FILE_PATH\" 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

### Ralph Wiggum Stop Hook

```bash
#!/bin/bash
# ralph-stop-hook.sh

STATE_FILE=".claude/ralph-loop.local.md"

# Check if state file exists
if [ ! -f "$STATE_FILE" ]; then
    exit 0  # No active loop, allow exit
fi

# Read state from YAML frontmatter
ENABLED=$(grep -m1 "^enabled:" "$STATE_FILE" | cut -d' ' -f2)
ITERATION=$(grep -m1 "^iteration:" "$STATE_FILE" | cut -d' ' -f2)
MAX_ITER=$(grep -m1 "^max-iterations:" "$STATE_FILE" | cut -d' ' -f2)
PROMISE=$(grep -m1 "^completion-promise:" "$STATE_FILE" | cut -d' ' -f2-)

# Check if disabled
if [ "$ENABLED" = "false" ]; then
    exit 0
fi

# Check max iterations
if [ -n "$MAX_ITER" ] && [ "$ITERATION" -ge "$MAX_ITER" ]; then
    exit 0
fi

# Check for completion promise in output
if [ -n "$PROMISE" ]; then
    if echo "$CLAUDE_OUTPUT" | grep -q "<promise>$PROMISE</promise>"; then
        exit 0
    fi
fi

# Block exit, increment iteration
NEW_ITER=$((ITERATION + 1))
sed -i "s/^iteration:.*/iteration: $NEW_ITER/" "$STATE_FILE"

# Output block decision
echo '{"decision": "block", "reason": "Completion promise not found. Iteration '"$NEW_ITER"'."}'
exit 0
```

---

## Environment Variables

| Variable             | Description                                      |
| -------------------- | ------------------------------------------------ |
| `CLAUDE_PROJECT_DIR` | Project root directory                           |
| `CLAUDE_CODE_REMOTE` | `"true"` for web, empty for CLI                  |
| `CLAUDE_ENV_FILE`    | Path to write persistent env vars (SessionStart) |

---

## Debugging

Use `claude --debug` to see detailed hook execution:

```
[DEBUG] Executing hooks for PostToolUse:Write
[DEBUG] Found 1 hook matchers in settings
[DEBUG] Matched 1 hooks for query "Write"
[DEBUG] Executing hook command: <command> with timeout 60000ms
[DEBUG] Hook command completed with status 0: <stdout>
```

Use `/hooks` command to view registered hooks and make changes.

---

## Execution Details

- **Timeout**: 60-second default per hook, configurable
- **Parallelization**: All matching hooks run in parallel
- **Deduplication**: Identical commands deduplicated automatically
- **Matchers**: Only apply to tool-based hooks (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest)

---

## Security Best Practices

1. **Validate and sanitize inputs** - Never trust input data blindly
2. **Always quote shell variables** - Use `"$VAR"` not `$VAR`
3. **Block path traversal** - Check for `..` in file paths
4. **Use absolute paths** - Specify full paths for scripts (use `$CLAUDE_PROJECT_DIR`)
5. **Skip sensitive files** - Avoid `.env`, `.git/`, keys, etc.

---

_Source: [Claude Code Hooks Documentation](https://code.claude.com/docs/en/hooks)_
