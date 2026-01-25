# Respawn Controller Idle Detection Improvement Plan

## Executive Summary

The current respawn controller relies primarily on **parsing terminal output** to detect idle states. This approach is fragile and leads to false positives/negatives (e.g., the w3-reddit-analyse session).

**Key insight**: Claude Code provides **direct, authoritative signals** via hooks and files that definitively indicate session state. We're receiving some of these signals but not using them for idle detection!

---

## Current Detection Layers (What We Have)

| Layer | Signal | Source | Reliability |
|-------|--------|--------|-------------|
| 1 | Completion message ("Worked for Xm Xs") | Terminal parsing | Medium - can miss edge cases |
| 2 | Output silence (configurable duration) | Terminal activity | Low - Claude can be processing silently |
| 3 | Token stability | Terminal parsing | Low - tokens don't change during I/O waits |
| 4 | Working pattern absence | Terminal parsing | Medium - patterns can be missed |
| 5 | AI idle check | Spawned Claude CLI | High but slow (90s timeout) |

**Problem**: All layers depend on **parsing terminal output**, which is inherently unreliable.

---

## Available Claude Code Signals (Not Fully Utilized)

### 1. `Stop` Hook ⭐ CRITICAL - DEFINITIVE SIGNAL

**What it is**: Fires when the main Claude Code agent **finishes responding**.

**From docs**: "Runs when the main Claude Code agent has finished responding. Does not run if the stoppage occurred due to a user interrupt."

**Current status**: We receive it via `/api/hook-event` but **don't use it for idle detection**!

**Input received**:
```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf.jsonl",
  "hook_event_name": "Stop",
  "stop_hook_active": true  // Important for preventing loops
}
```

**Action needed**: The `Stop` hook should be the **PRIMARY** idle detection signal. When Claude fires Stop, the agent has definitively finished its response cycle.

### 2. `idle_prompt` Notification ⭐ HIGH VALUE

**What it is**: Fires after **60+ seconds of idle time** when Claude is waiting for user input.

**From docs**: "When Claude is waiting for user input (after 60+ seconds of idle time)"

**Current status**: We receive it but only forward it to the UI for notification display.

**Action needed**: Use `idle_prompt` as a **definitive confirmation** that Claude is idle. If we receive this, there's no need for AI idle checks or output silence timers.

### 3. Transcript JSONL File ⭐ HIGH VALUE

**What it is**: Complete conversation history at `~/.claude/projects/{project-hash}/{session-id}.jsonl`

**Current status**: We already watch subagent transcripts but **not the main session transcript**.

**Data available**:
- Every message (user, assistant, system)
- Every tool call with inputs/outputs
- Progress events
- Structured, parseable JSON

**Action needed**:
- Monitor the main transcript file (path provided in every hook input)
- Parse the last few entries to detect:
  - Tool completion
  - Assistant message completion
  - Error states
  - Plan mode prompts

### 4. `PostToolUse` Hook - Tool Completion Tracking

**What it is**: Fires immediately after any tool completes successfully.

**Use case**: Track exactly when tools finish to understand execution flow.

**Current status**: Not implemented.

**Action needed**: Add PostToolUse hooks to track tool completion events.

### 5. `SubagentStop` Hook - Background Agent Completion

**What it is**: Fires when a subagent (Task tool) finishes responding.

**Current status**: Not implemented in hooks config (we watch JSONL files separately).

**Action needed**: Add to hooks config for redundant detection.

### 6. `permission_prompt` and `elicitation_dialog` - Blocking State Detection

**What it is**: Fires when Claude needs user input (permission or question).

**Current status**: We receive and use for auto-accept blocking.

**Enhancement**: Use as definitive "Claude is NOT idle - it's waiting for user action".

---

## Proposed Architecture: Multi-Signal Idle Detection

### New Detection Hierarchy

```
Priority 1 (Definitive):
  └── Stop hook received → CONFIRMED IDLE
  └── idle_prompt received → CONFIRMED IDLE (60s+ idle)

Priority 2 (Blocking):
  └── permission_prompt received → NOT IDLE (waiting for permission)
  └── elicitation_dialog received → NOT IDLE (waiting for answer)
  └── Working patterns in terminal → NOT IDLE

Priority 3 (Supporting):
  └── Transcript analysis → Check last entries for completion
  └── Output silence + token stability → Weak idle signal

Priority 4 (Fallback):
  └── AI idle check → Only if no definitive signals after timeout
```

### State Machine Changes

```
                     ┌─────────────────────────────────────┐
                     │                                     │
                     ▼                                     │
    ┌─────────────────────┐                               │
    │      WATCHING       │◄──────────────────────────────┤
    └─────────────────────┘                               │
           │      │                                       │
           │      │ Stop hook or idle_prompt              │
           │      └────────────────────────┐              │
           │                               ▼              │
           │ Output silence          ┌────────────┐       │
           │ (no definitive signals) │ HOOK_IDLE  │───────┤
           │                         └────────────┘       │
           ▼                         (skip AI check)      │
    ┌────────────────────┐                               │
    │  CONFIRMING_IDLE   │                               │
    └────────────────────┘                               │
           │                                             │
           │ Silence confirmed                           │
           ▼                                             │
    ┌────────────────────┐                               │
    │   AI_CHECKING      │──── IDLE verdict ─────────────┤
    └────────────────────┘                               │
           │                                             │
           │ WORKING verdict                             │
           └─────────────────────────────────────────────┘
```

### New State: `hook_idle`

When a definitive hook signal is received:
1. Skip AI idle check entirely (saves time and API calls)
2. Short confirmation period (2-3s) to handle race conditions
3. Proceed directly to respawn sequence

---

## Implementation Plan

### Phase 1: Use Stop Hook for Idle Detection ✅ COMPLETED

**Files modified**:
- `src/respawn-controller.ts`
- `src/web/server.ts`
- `test/respawn-controller.test.ts`

**Changes implemented**:
1. Added `stopHookReceived`, `stopHookTime`, `idlePromptReceived`, `idlePromptTime` fields to `DetectionStatus`
2. Added `hookConfirmTimer` for short confirmation after hook signal (3s)
3. Added `signalStopHook()` method:
   - Sets `stopHookReceived = true` and timestamp
   - Cancels any running AI check (hook is definitive)
   - Starts 3s confirmation timer
   - If no new output during confirmation → triggers respawn cycle
4. Added `signalIdlePrompt()` method:
   - Sets `idlePromptReceived = true` and timestamp
   - Immediately confirms idle (skips confirmation timer - 60s+ already proven)
5. Added `resetHookState()` to clear hook flags on:
   - Controller start
   - Working patterns detected
   - Cycle completion
6. Updated server.ts `/api/hook-event` endpoint to call:
   - `controller.signalStopHook()` for `stop` events
   - `controller.signalIdlePrompt()` for `idle_prompt` events
7. Updated `getDetectionStatus()`:
   - Returns hook signal states
   - Sets confidence to 100% when hook received
   - Updates statusText to show hook status

**Tests added** (9 new tests in `RespawnController Hook-Based Idle Detection` describe block):
- `should expose signalStopHook method`
- `should expose signalIdlePrompt method`
- `should set stopHookReceived in detection status when Stop hook signaled`
- `should include hook status in statusText when Stop hook received`
- `should trigger respawn cycle after Stop hook confirmation`
- `should immediately confirm idle when idle_prompt signaled (skip confirmation)`
- `should cancel Stop hook confirmation if working patterns detected`
- `should ignore Stop hook when not in watching state`
- `should have 100% confidence when hook signal is received`

**Detection status update** (implemented):
```typescript
interface DetectionStatus {
  /** Layer 0: Stop hook received (highest priority - definitive signal) */
  stopHookReceived: boolean;
  stopHookTime: number | null;
  /** Layer 0: idle_prompt notification received (definitive signal) */
  idlePromptReceived: boolean;
  idlePromptTime: number | null;

  // Existing fields...
}
```

### Phase 2: Use idle_prompt for Definitive Idle ✅ COMPLETED (in Phase 1)

**Already implemented in Phase 1**:
1. `signalIdlePrompt()` method sets `idlePromptReceived = true`
2. Immediately calls `onIdleConfirmed()` - skips all other detection
3. Server.ts calls `controller.signalIdlePrompt()` when `idle_prompt` event received
4. 60s+ of Claude waiting = definitive idle signal

### Phase 3: Transcript File Monitoring ✅ COMPLETED

**New file**: `src/transcript-watcher.ts`

**Functionality implemented**:
1. Watch the session's transcript JSONL file using `fs.watch()`
2. Parse new entries as they're appended (incremental reading from last position)
3. Detect:
   - `result` entry → `transcript:complete` event (isComplete = true)
   - `tool_use` content block → `transcript:tool_start` event
   - `tool_result` content block → `transcript:tool_end` event
   - `AskUserQuestion` or `ExitPlanMode` tools → `transcript:plan_mode` event
   - Error conditions in result entries
4. Emit structured events consumed by respawn controller

**Integration implemented**:
- `transcript_path` added to allowed hook data fields in `sanitizeHookData()`
- `transcriptWatchers` Map added to WebServer for per-session watchers
- `startTranscriptWatcher()` creates watcher and wires up events:
  - `transcript:complete` → `controller.signalTranscriptComplete()`
  - `transcript:plan_mode` → `controller.signalTranscriptPlanMode()`
- `stopTranscriptWatcher()` cleans up on session cleanup
- Hook events with `transcript_path` automatically start watching

**RespawnController methods added**:
- `signalTranscriptComplete()` - Supporting signal that can accelerate idle detection
- `signalTranscriptPlanMode()` - Cancels auto-accept timer (like elicitation)

**Tests added** (13 tests in `test/transcript-watcher.test.ts`):
- Initialization tests
- File watching tests (existing file, non-existent file, stop, updatePath)
- Entry processing tests (user entry, result entry, tool execution, plan mode, errors)
- State management tests

### Phase 4: Enhanced Hook Configuration

**Update `src/hooks-config.ts`**:

```typescript
export function generateHooksConfig(): { hooks: Record<string, unknown[]> } {
  return {
    hooks: {
      Notification: [
        { matcher: 'idle_prompt', hooks: [...] },
        { matcher: 'permission_prompt', hooks: [...] },
        { matcher: 'elicitation_dialog', hooks: [...] },
      ],
      Stop: [{ hooks: [...] }],
      // NEW: Add these
      PostToolUse: [
        { matcher: '*', hooks: [...] }  // Track all tool completions
      ],
      SubagentStop: [{ hooks: [...] }],
      PreCompact: [
        { matcher: '*', hooks: [...] }  // Track compaction
      ],
    },
  };
}
```

### Phase 5: Confidence Scoring Overhaul

Replace current confidence calculation with weighted signals:

```typescript
function calculateConfidence(): number {
  let confidence = 0;

  // Definitive signals (100% confidence)
  if (this.stopHookReceived) confidence = 100;
  if (this.idlePromptReceived) confidence = 100;

  // Blocking signals (0% confidence)
  if (this.permissionPromptReceived) return 0;
  if (this.elicitationReceived) return 0;
  if (this.workingPatternRecent) return 0;

  // Supporting signals (build up to ~80%)
  if (confidence < 100) {
    if (this.outputSilent) confidence += 30;
    if (this.tokensStable) confidence += 20;
    if (this.transcriptShowsCompletion) confidence += 30;
  }

  return Math.min(100, confidence);
}
```

---

## Expected Benefits

| Metric | Current | After Implementation |
|--------|---------|---------------------|
| False positive rate | ~15-20% | <5% |
| Detection latency | 10-90s (AI check) | 3-5s (hook-based) |
| API calls for AI check | Every idle detection | Only when hooks unavailable |
| Reliability | Medium | High (definitive signals) |

---

## Testing Strategy

### Unit Tests
1. `Stop` hook triggers immediate idle confirmation
2. `idle_prompt` skips all other detection
3. `permission_prompt` blocks idle detection
4. Transcript parsing correctly identifies completion
5. Fallback to AI check when no hooks received

### Integration Tests
1. End-to-end with real Claude session
2. Hook event delivery and handling
3. Transcript file monitoring
4. Race condition handling

### Scenarios to Test
1. Normal completion → Stop hook → respawn
2. Long-running task → idle_prompt → respawn
3. Permission needed → wait for user action
4. AskUserQuestion → wait for user answer
5. Plan mode → auto-accept → continue
6. Hooks disabled/unavailable → fallback to AI check

---

## Migration Path

1. **Implement Phase 1** - Stop hook detection (low risk, high value)
2. **Deploy and monitor** - Verify Stop hooks are reliable
3. **Implement Phase 2** - idle_prompt (simple addition)
4. **Implement Phase 3** - Transcript monitoring (more complex)
5. **Implement Phase 4** - Enhanced hooks (optional, for completeness)
6. **Implement Phase 5** - Refactor confidence scoring

---

## Open Questions

1. **Stop hook reliability**: Does it fire 100% of the time? Edge cases?
2. **Transcript file location**: Always at the path in hook input?
3. **Hook delivery latency**: How quickly do hooks fire after state change?
4. **Race conditions**: What if Stop hook and new work happen simultaneously?

---

## References

- [Claude Code Hooks Documentation](https://code.claude.com/docs/en/hooks)
- [Agent SDK Documentation](https://platform.claude.com/docs/en/agent-sdk/overview)
- Current implementation: `src/respawn-controller.ts`
- Hooks config: `src/hooks-config.ts`
- Subagent watcher: `src/subagent-watcher.ts`
