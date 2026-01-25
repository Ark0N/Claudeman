# Respawn Controller Test Scenarios

This document identifies edge cases and scenarios not currently covered by the existing test suite in `test/respawn-controller.test.ts`. These scenarios are designed to find gaps in test coverage and ensure robust behavior.

---

## Table of Contents

1. [State Transition Scenarios](#state-transition-scenarios)
2. [AI Idle Checker Integration Scenarios](#ai-idle-checker-integration-scenarios)
3. [AI Plan Checker Integration Scenarios](#ai-plan-checker-integration-scenarios)
4. [Timeout and Cooldown Scenarios](#timeout-and-cooldown-scenarios)
5. [Error Recovery Scenarios](#error-recovery-scenarios)
6. [Concurrent Operation Scenarios](#concurrent-operation-scenarios)
7. [Configuration Change Scenarios](#configuration-change-scenarios)
8. [Buffer and Memory Scenarios](#buffer-and-memory-scenarios)
9. [Edge Cases in Pattern Detection](#edge-cases-in-pattern-detection)
10. [Event Emission and Listener Scenarios](#event-emission-and-listener-scenarios)

---

## State Transition Scenarios

### STS-001: Full Cycle with All Steps Enabled

**Description**: Complete respawn cycle traversing all states when sendClear, sendInit, and kickstartPrompt are all enabled.

**Initial State**: `watching` with all config options enabled

**Actions**:
1. Start controller with `sendClear: true`, `sendInit: true`, `kickstartPrompt: 'continue'`
2. Simulate completion message
3. Wait for confirmation
4. Simulate completion for each step without triggering work after /init

**Expected Behavior**:
- States visited in order: watching -> confirming_idle -> ai_checking -> sending_update -> waiting_update -> sending_clear -> waiting_clear -> sending_init -> waiting_init -> monitoring_init -> sending_kickstart -> waiting_kickstart -> watching
- All stepSent/stepCompleted events emitted
- Cycle count increments

**Priority**: HIGH

---

### STS-002: Cycle Skipping Clear Step

**Description**: Respawn cycle when sendClear is disabled.

**Initial State**: `watching` with `sendClear: false`, `sendInit: true`

**Actions**:
1. Trigger idle detection
2. Complete update step

**Expected Behavior**:
- Should skip directly from waiting_update to sending_init
- No 'clear' step events emitted

**Priority**: MEDIUM

---

### STS-003: Cycle Skipping Init Step

**Description**: Respawn cycle when sendInit is disabled.

**Initial State**: `watching` with `sendClear: true`, `sendInit: false`

**Actions**:
1. Trigger idle detection
2. Complete update step
3. Complete clear step

**Expected Behavior**:
- Should complete cycle after clear
- No 'init' step events emitted
- Should not enter monitoring_init state

**Priority**: MEDIUM

---

### STS-004: Cycle with Neither Clear nor Init

**Description**: Respawn cycle when both sendClear and sendInit are disabled.

**Initial State**: `watching` with `sendClear: false`, `sendInit: false`

**Actions**:
1. Trigger idle detection
2. Complete update step

**Expected Behavior**:
- Cycle completes immediately after update
- Only update step events emitted

**Priority**: MEDIUM

---

### STS-005: Work Triggered During monitoring_init

**Description**: When /init actually triggers Claude to start working.

**Initial State**: `monitoring_init` with kickstartPrompt configured

**Actions**:
1. Reach monitoring_init state
2. Simulate working patterns (e.g., "Thinking...")

**Expected Behavior**:
- Should emit stepCompleted for 'init'
- Should NOT enter sending_kickstart
- Should complete cycle and return to watching
- Log message: "/init triggered work, skipping kickstart"

**Priority**: HIGH

---

### STS-006: State Transition During Step Timer

**Description**: Stopping controller while step delay timer is pending.

**Initial State**: `sending_update` (during interStepDelayMs wait)

**Actions**:
1. Start controller and trigger idle
2. While in sending_update (during delay), call stop()

**Expected Behavior**:
- Step timer should be cleared
- No stepSent event emitted
- State transitions to stopped cleanly

**Priority**: MEDIUM

---

### STS-007: Clear Fallback Timer Trigger

**Description**: /clear step completes via fallback timer when no prompt detected.

**Initial State**: `waiting_clear`

**Actions**:
1. Send /clear command
2. Do NOT simulate prompt detection
3. Wait for CLEAR_FALLBACK_TIMEOUT_MS (10s)

**Expected Behavior**:
- Fallback timer fires
- Logs "clear fallback: proceeding to /init"
- Proceeds to sendInit (or completeCycle if sendInit false)
- stepCompleted event emitted for 'clear'

**Priority**: MEDIUM

---

### STS-008: Clear Fallback Timer Cancelled by Prompt

**Description**: Clear fallback timer is cancelled when prompt is detected.

**Initial State**: `waiting_clear`

**Actions**:
1. Send /clear command
2. Simulate prompt detection before fallback timeout

**Expected Behavior**:
- Fallback timer cancelled with reason "prompt detected"
- timerCancelled event emitted for 'clear-fallback'
- Normal flow continues

**Priority**: MEDIUM

---

### STS-009: Multiple Rapid State Transitions

**Description**: Rapid cycling through multiple states without settling.

**Initial State**: `watching`

**Actions**:
1. Simulate completion message
2. Before confirmation completes, simulate working
3. Immediately after, simulate completion again
4. Repeat several times rapidly

**Expected Behavior**:
- Controller handles transitions gracefully
- No duplicate state entries
- Timers properly cleaned up
- No memory leaks from orphaned timers

**Priority**: HIGH

---

### STS-010: Resume from Non-Watching State

**Description**: Calling resume() when in a state other than watching.

**Initial State**: `sending_update` or any non-watching state

**Actions**:
1. Pause controller
2. Call resume()

**Expected Behavior**:
- Should remain in current state
- Should not call checkIdleAndMaybeStart
- Only watching state triggers idle check on resume

**Priority**: LOW

---

## AI Idle Checker Integration Scenarios

### AIC-001: AI Checker Returns IDLE Verdict

**Description**: AI idle check completes successfully with IDLE verdict.

**Initial State**: `ai_checking`

**Actions**:
1. Trigger AI check via completion message + silence
2. Mock AI checker to return IDLE

**Expected Behavior**:
- aiCheckCompleted event emitted with IDLE verdict
- onIdleConfirmed called
- Respawn cycle begins
- No cooldown started

**Priority**: HIGH

---

### AIC-002: AI Checker Returns WORKING Verdict

**Description**: AI idle check completes with WORKING verdict.

**Initial State**: `ai_checking`

**Actions**:
1. Trigger AI check
2. Mock AI checker to return WORKING

**Expected Behavior**:
- aiCheckCompleted event emitted
- State returns to watching
- Cooldown started (aiIdleCheckCooldownMs)
- aiCheckCooldown event emitted
- No respawn cycle started

**Priority**: HIGH

---

### AIC-003: AI Checker Returns ERROR Verdict

**Description**: AI idle check fails with ERROR verdict.

**Initial State**: `ai_checking`

**Actions**:
1. Trigger AI check
2. Mock AI checker to return ERROR

**Expected Behavior**:
- aiCheckFailed event emitted
- State returns to watching
- consecutiveErrors incremented
- Pre-filter and no-output timers restarted

**Priority**: HIGH

---

### AIC-004: AI Checker Throws Exception

**Description**: AI idle check throws an exception during execution.

**Initial State**: `ai_checking`

**Actions**:
1. Trigger AI check
2. Mock AI checker to throw Error

**Expected Behavior**:
- Exception caught
- aiCheckFailed event emitted
- State returns to watching
- Controller remains stable

**Priority**: HIGH

---

### AIC-005: AI Checker Cancelled Mid-Check

**Description**: AI check cancelled by new working patterns.

**Initial State**: `ai_checking`

**Actions**:
1. Start AI check
2. Before completion, simulate working pattern

**Expected Behavior**:
- AI check cancelled
- Log: "Working patterns detected during AI check, cancelling"
- State returns to watching
- AI check result ignored when it arrives

**Priority**: HIGH

---

### AIC-006: AI Checker Cancelled by Substantial Output

**Description**: AI check cancelled when substantial (>2 chars) output arrives.

**Initial State**: `ai_checking`

**Actions**:
1. Start AI check
2. Simulate output longer than 2 characters (after ANSI stripping)

**Expected Behavior**:
- AI check cancelled
- Log includes "Substantial output during AI check"
- State returns to watching

**Priority**: MEDIUM

---

### AIC-007: AI Checker on Cooldown - Check Skipped

**Description**: AI check attempt while on cooldown from previous WORKING verdict.

**Initial State**: `watching` with AI checker on cooldown

**Actions**:
1. Get WORKING verdict (starts cooldown)
2. Immediately trigger another pre-filter pass

**Expected Behavior**:
- AI check not started
- Log: "AI check on cooldown (Xs remaining), waiting..."
- Controller stays in watching state

**Priority**: HIGH

---

### AIC-008: AI Checker Cooldown Expires

**Description**: Controller behavior when AI checker cooldown expires.

**Initial State**: `watching` with AI checker on cooldown

**Actions**:
1. Wait for cooldown to expire
2. Check that pre-filter timer is restarted

**Expected Behavior**:
- aiCheckCooldown event emitted (false, null)
- Pre-filter timer restarted
- Next idle signal can trigger AI check

**Priority**: MEDIUM

---

### AIC-009: AI Checker Disabled After Max Consecutive Errors

**Description**: AI checker auto-disables after too many errors.

**Initial State**: `watching` with AI check enabled

**Actions**:
1. Cause maxConsecutiveErrors (3) failures
2. Attempt another idle detection

**Expected Behavior**:
- AI checker status becomes 'disabled'
- disabled event emitted with reason
- Falls back to noOutputTimeoutMs for detection
- Log: "AI check unavailable (disabled)"

**Priority**: HIGH

---

### AIC-010: AI Checker Re-enabled via Config Update

**Description**: Re-enabling AI checker after it was disabled.

**Initial State**: AI checker disabled

**Actions**:
1. Call updateConfig({ aiIdleCheckEnabled: true })

**Expected Behavior**:
- AI checker status becomes 'ready'
- disabledReason cleared
- Next idle detection can use AI check

**Priority**: MEDIUM

---

### AIC-011: AI Check Triggered via No-Output Fallback

**Description**: AI check triggered by noOutputTimeoutMs when no output at all.

**Initial State**: `watching` with no output received

**Actions**:
1. Start controller
2. Wait for noOutputTimeoutMs without any terminal output

**Expected Behavior**:
- AI check triggered via no-output fallback path
- aiCheckStarted event emitted
- Log: "No-output fallback: Xs silence"

**Priority**: MEDIUM

---

### AIC-012: AI Check via Pre-Filter Path (No Completion Message)

**Description**: AI check triggered by pre-filter timer without completion message.

**Initial State**: `watching` with output received but no completion message

**Actions**:
1. Receive some output (sets lastOutputTime)
2. Wait for completionConfirmMs of silence
3. Wait for working patterns to be absent for 3s
4. Wait for tokens to be stable

**Expected Behavior**:
- Pre-filter passes
- AI check started
- Works even without completion message detection

**Priority**: MEDIUM

---

### AIC-013: State Change During AI Check - Result Ignored

**Description**: AI check result arrives after state has changed.

**Initial State**: `ai_checking`

**Actions**:
1. Start AI check
2. Stop controller before result arrives
3. AI check completes

**Expected Behavior**:
- Result ignored
- Log: "AI check result ignored (state is now stopped)"
- No state transition attempted

**Priority**: MEDIUM

---

## AI Plan Checker Integration Scenarios

### APC-001: Plan Check Returns PLAN_MODE

**Description**: AI plan check confirms plan mode, triggers auto-accept.

**Initial State**: `watching` with plan mode UI in buffer

**Actions**:
1. Simulate plan mode output (numbered list + selector)
2. Wait for autoAcceptDelayMs
3. Mock plan checker to return PLAN_MODE

**Expected Behavior**:
- planCheckCompleted event emitted
- Enter sent via writeViaScreen
- autoAcceptSent event emitted
- hasReceivedOutput reset to false

**Priority**: HIGH

---

### APC-002: Plan Check Returns NOT_PLAN_MODE

**Description**: AI plan check determines not plan mode.

**Initial State**: `watching` with ambiguous output

**Actions**:
1. Simulate output that passes pre-filter
2. Mock plan checker to return NOT_PLAN_MODE

**Expected Behavior**:
- planCheckCompleted event emitted
- No Enter sent
- Cooldown started (aiPlanCheckCooldownMs)

**Priority**: HIGH

---

### APC-003: Plan Check Already Checking

**Description**: Plan check attempt while already checking.

**Initial State**: Plan checker status = 'checking'

**Actions**:
1. Start a plan check
2. Trigger another auto-accept attempt before first completes

**Expected Behavior**:
- Second check skipped
- Log: "plan check already in progress"
- Only one check runs

**Priority**: MEDIUM

---

### APC-004: Plan Check Cancelled by New Output

**Description**: New output during plan check cancels it.

**Initial State**: Plan check running

**Actions**:
1. Start plan check
2. Simulate new terminal output

**Expected Behavior**:
- Plan check cancelled
- Log: "New output during plan check, cancelling (stale)"
- Result discarded

**Priority**: HIGH

---

### APC-005: Plan Check Result Stale (Output During Check)

**Description**: Plan check completes but output arrived during check.

**Initial State**: Plan check running

**Actions**:
1. Start plan check
2. Record planCheckStartTime
3. Simulate output (updates lastOutputTime)
4. Plan check returns PLAN_MODE

**Expected Behavior**:
- Result discarded (lastOutputTime > planCheckStartTime)
- Log: "Result discarded (output arrived during check)"
- No Enter sent

**Priority**: HIGH

---

### APC-006: Plan Check Result When State Changed

**Description**: Plan check returns PLAN_MODE but state is no longer watching.

**Initial State**: Plan check running

**Actions**:
1. Start plan check
2. Trigger respawn cycle (state changes to sending_update)
3. Plan check returns PLAN_MODE

**Expected Behavior**:
- Result not acted upon
- Log includes "state is X, not sending Enter"
- No auto-accept

**Priority**: MEDIUM

---

### APC-007: Pre-Filter Blocks - No Numbered Options

**Description**: Pre-filter rejects output without numbered options.

**Initial State**: `watching`

**Actions**:
1. Simulate output without numbered list pattern
2. Wait for autoAcceptDelayMs

**Expected Behavior**:
- Pre-filter fails (PLAN_MODE_OPTION_PATTERN not matched)
- Log: "pre-filter did not match plan mode patterns"
- No plan check started

**Priority**: MEDIUM

---

### APC-008: Pre-Filter Blocks - No Selector Arrow

**Description**: Pre-filter rejects output without selector indicator.

**Initial State**: `watching`

**Actions**:
1. Simulate numbered list without selector (no ">" or arrow)
2. Wait for autoAcceptDelayMs

**Expected Behavior**:
- Pre-filter fails (PLAN_MODE_SELECTOR_PATTERN not matched)
- No plan check started

**Priority**: MEDIUM

---

### APC-009: Pre-Filter Blocks - Working Pattern After Selector

**Description**: Pre-filter rejects when working pattern appears after selector.

**Initial State**: `watching`

**Actions**:
1. Simulate: "1. Yes\n> 1.\nThinking..."
2. Wait for autoAcceptDelayMs

**Expected Behavior**:
- Pre-filter fails (working pattern after selector)
- No plan check started

**Priority**: MEDIUM

---

### APC-010: Pre-Filter Passes - Working Pattern Before Selector

**Description**: Pre-filter allows working patterns if they appear before the selector.

**Initial State**: `watching` with AI plan check disabled

**Actions**:
1. Simulate: "Thinking...\nDone.\n> 1. Yes\n  2. No"
2. Wait for autoAcceptDelayMs

**Expected Behavior**:
- Pre-filter passes (working pattern is before selector)
- Auto-accept triggered (since AI plan check disabled)

**Priority**: MEDIUM

---

### APC-011: Plan Check on Cooldown

**Description**: Plan check skipped when on cooldown.

**Initial State**: Plan checker on cooldown

**Actions**:
1. Get NOT_PLAN_MODE verdict (starts cooldown)
2. Simulate plan mode output
3. Wait for autoAcceptDelayMs

**Expected Behavior**:
- Plan check skipped
- Log: "plan checker on cooldown (Xs remaining)"
- No auto-accept

**Priority**: MEDIUM

---

## Timeout and Cooldown Scenarios

### TC-001: Step Confirmation Timer Interrupted by Working

**Description**: Step confirmation timer cancelled by working patterns.

**Initial State**: `waiting_update` with step confirm timer running

**Actions**:
1. Simulate completion message in waiting_update
2. Before confirmation timer fires, simulate working pattern

**Expected Behavior**:
- Step confirm timer cancelled
- Log: "Step confirmation cancelled (working detected)"
- Remains in waiting_update, waiting for real completion

**Priority**: HIGH

---

### TC-002: Completion Confirm Timer Interrupted by Output

**Description**: Confirmation timer restart when output arrives during confirmation.

**Initial State**: `confirming_idle` with timer running

**Actions**:
1. Detect completion message
2. Timer fires but lastOutputTime changed

**Expected Behavior**:
- Timer restarts instead of confirming
- Log: "Output during confirmation, resetting"
- State remains confirming_idle

**Priority**: MEDIUM

---

### TC-003: Multiple Cooldowns Active Simultaneously

**Description**: Both AI idle checker and plan checker on cooldown.

**Initial State**: Both checkers on cooldown

**Actions**:
1. Trigger WORKING verdict on idle checker
2. Trigger NOT_PLAN_MODE on plan checker
3. Try to trigger both checks

**Expected Behavior**:
- Both checks skipped
- Controller falls back appropriately
- Cooldowns expire independently

**Priority**: MEDIUM

---

### TC-004: Zero-Duration Timers

**Description**: Configuration with zero-duration timeouts.

**Initial State**: `watching` with `completionConfirmMs: 0`, `interStepDelayMs: 0`

**Actions**:
1. Trigger completion message
2. Complete full cycle

**Expected Behavior**:
- Timers fire immediately (or within next event loop)
- Cycle completes without hanging
- No errors from zero-duration setTimeout

**Priority**: LOW

---

### TC-005: Very Long Timeout Values

**Description**: Configuration with extremely long timeouts.

**Initial State**: `watching` with `noOutputTimeoutMs: 3600000` (1 hour)

**Actions**:
1. Start controller
2. Stop before timeout

**Expected Behavior**:
- Timer properly cleared on stop
- No dangling timers
- Memory not leaked

**Priority**: LOW

---

### TC-006: Timer Tracking Accuracy

**Description**: Active timer info reflects actual remaining time.

**Initial State**: Timer running

**Actions**:
1. Start a tracked timer (e.g., completion-confirm)
2. Call getActiveTimers() at various intervals
3. Check remainingMs decreases appropriately

**Expected Behavior**:
- remainingMs decreases over time
- Never negative
- Removed from list after firing

**Priority**: LOW

---

## Error Recovery Scenarios

### ER-001: Session Event Handler Throws

**Description**: Exception thrown in terminal data handler.

**Initial State**: `watching`

**Actions**:
1. Cause handleTerminalData to throw (via malformed input)
2. Continue sending normal output

**Expected Behavior**:
- Controller should not crash
- Should handle exception gracefully
- Should continue processing subsequent events

**Priority**: HIGH

---

### ER-002: writeViaScreen Fails

**Description**: Writing to session fails during step send.

**Initial State**: `sending_update`

**Actions**:
1. Mock writeViaScreen to return false or throw
2. Let step delay timer fire

**Expected Behavior**:
- Error should be caught
- Controller should emit error event
- Should not hang in sending state indefinitely

**Priority**: MEDIUM

---

### ER-003: Recovery After Partial Cycle Failure

**Description**: Controller recovers after failing mid-cycle.

**Initial State**: `waiting_clear` when error occurs

**Actions**:
1. Simulate error during waiting_clear
2. Controller returns to watching or stopped
3. Try to start new cycle

**Expected Behavior**:
- Clean state for new cycle
- No leftover timers or state
- New cycle works normally

**Priority**: MEDIUM

---

### ER-004: AI Checker Process Spawn Failure

**Description**: Screen process fails to spawn for AI check.

**Initial State**: `ai_checking`

**Actions**:
1. Trigger AI check
2. Mock screen spawn to fail

**Expected Behavior**:
- Error caught
- aiCheckFailed event emitted
- consecutiveErrors incremented
- Falls back gracefully

**Priority**: MEDIUM

---

### ER-005: Temp File Cleanup Failure

**Description**: Temp file deletion fails in AI checker cleanup.

**Initial State**: AI check completing

**Actions**:
1. Complete AI check
2. Mock unlink to throw

**Expected Behavior**:
- Exception caught (best effort cleanup)
- Check still completes
- No crash

**Priority**: LOW

---

## Concurrent Operation Scenarios

### CO-001: Start Called While Stopping

**Description**: Calling start() immediately after stop().

**Initial State**: Transitioning from running to stopped

**Actions**:
1. Call stop()
2. Immediately call start()

**Expected Behavior**:
- Clean restart
- No duplicate listeners
- Single watching state

**Priority**: MEDIUM

---

### CO-002: Multiple Terminal Events in Same Tick

**Description**: Multiple terminal events processed synchronously.

**Initial State**: `watching`

**Actions**:
1. Emit multiple 'terminal' events without yielding
2. Check state consistency

**Expected Behavior**:
- All events processed in order
- State remains consistent
- No race conditions in timer management

**Priority**: HIGH

---

### CO-003: Config Update During AI Check

**Description**: Updating AI config while check is in progress.

**Initial State**: `ai_checking`

**Actions**:
1. Start AI check
2. Call updateConfig({ aiIdleCheckEnabled: false })
3. AI check completes

**Expected Behavior**:
- Pending check completes
- Future checks use new config
- No crash

**Priority**: LOW

---

### CO-004: Pause During AI Check

**Description**: Pausing controller while AI check is running.

**Initial State**: `ai_checking`

**Actions**:
1. Start AI check
2. Call pause()
3. AI check completes

**Expected Behavior**:
- Timers cleared by pause
- AI check result may arrive but timers won't fire
- Resume can restart monitoring

**Priority**: LOW

---

### CO-005: Buffer Append During Trim

**Description**: New data arrives while buffer is being trimmed.

**Initial State**: Buffer near MAX_RESPAWN_BUFFER_SIZE

**Actions**:
1. Fill buffer to trigger trim
2. Simultaneously append more data

**Expected Behavior**:
- Buffer stays within limits
- No data corruption
- Append operation completes

**Priority**: LOW

---

## Configuration Change Scenarios

### CC-001: Disable Respawn While Running

**Description**: Setting enabled to false while controller is running.

**Initial State**: `watching` with cycle in progress

**Actions**:
1. Call updateConfig({ enabled: false })
2. Check controller behavior

**Expected Behavior**:
- Config updated (for reference)
- Controller continues current operation
- On restart, start() will be no-op

**Priority**: LOW

---

### CC-002: Change updatePrompt During Cycle

**Description**: Changing update prompt while cycle is in progress.

**Initial State**: `waiting_update`

**Actions**:
1. Call updateConfig({ updatePrompt: 'new prompt' })
2. Start next cycle

**Expected Behavior**:
- Current cycle uses old prompt (already sent)
- Next cycle uses new prompt

**Priority**: LOW

---

### CC-003: Toggle sendClear Mid-Cycle

**Description**: Changing sendClear while in waiting_update.

**Initial State**: `waiting_update` with sendClear: true

**Actions**:
1. Call updateConfig({ sendClear: false })
2. Update step completes

**Expected Behavior**:
- Should use updated config value
- Skip clear and proceed appropriately

**Priority**: MEDIUM

---

### CC-004: Change Timeout Values During Wait

**Description**: Modifying timeout values while timer is running.

**Initial State**: Timer running with completionConfirmMs: 10000

**Actions**:
1. Call updateConfig({ completionConfirmMs: 1000 })
2. Check when timer fires

**Expected Behavior**:
- Current timer uses old value
- Next timer uses new value
- No crash or undefined behavior

**Priority**: LOW

---

### CC-005: Update kickstartPrompt to Undefined

**Description**: Removing kickstart prompt during monitoring_init.

**Initial State**: `monitoring_init` with kickstartPrompt set

**Actions**:
1. Call updateConfig({ kickstartPrompt: undefined })
2. /init doesn't trigger work

**Expected Behavior**:
- Should check config at decision time
- May skip kickstart or use stale value
- (Behavior should be defined)

**Priority**: LOW

---

## Buffer and Memory Scenarios

### BM-001: Buffer Trim at Exact Boundary

**Description**: Buffer exactly at MAX_RESPAWN_BUFFER_SIZE.

**Initial State**: Buffer at exactly 1MB

**Actions**:
1. Fill buffer to exactly 1MB
2. Append 1 more character

**Expected Behavior**:
- Trim triggered
- Buffer reduced to RESPAWN_BUFFER_TRIM_SIZE (512KB)
- Most recent data preserved

**Priority**: LOW

---

### BM-002: Continuous High-Volume Output

**Description**: Sustained high-volume terminal output.

**Initial State**: `watching`

**Actions**:
1. Send 1MB of data per second for 10 seconds
2. Check memory usage and behavior

**Expected Behavior**:
- Buffer stays bounded
- No memory growth over time
- Detection still functions

**Priority**: MEDIUM

---

### BM-003: Buffer Clear During Pattern Match

**Description**: Buffer cleared while pattern detection is occurring.

**Initial State**: Processing terminal data

**Actions**:
1. Process data that triggers completeCycle
2. completeCycle clears buffer
3. More data arrives in same handler

**Expected Behavior**:
- New data appended to fresh buffer
- No stale data patterns matched

**Priority**: LOW

---

### BM-004: Action Log Growth

**Description**: Action log entries accumulating over time.

**Initial State**: Many cycles completed

**Actions**:
1. Run many cycles (>20)
2. Check recentActions length

**Expected Behavior**:
- Limited to 20 entries max
- Oldest entries discarded
- Memory stable

**Priority**: LOW

---

## Edge Cases in Pattern Detection

### PD-001: Completion Message Without "Worked"

**Description**: Time duration pattern without "Worked" prefix.

**Initial State**: `watching`

**Actions**:
1. Simulate: "Waiting for 5s before retry"
2. Check if completion detected

**Expected Behavior**:
- NOT detected as completion (requires "Worked" prefix)
- No false positive

**Priority**: HIGH

---

### PD-002: Nested Working Patterns in Text

**Description**: Working pattern words in non-working context.

**Initial State**: `watching`

**Actions**:
1. Simulate: "The 'Thinking' file was created"
2. Check workingDetected status

**Expected Behavior**:
- Currently: Would detect as working (false positive)
- Expected: Should not detect (pattern in quotes)
- (This is a known limitation)

**Priority**: LOW (known limitation)

---

### PD-003: Unicode Prompt Variants

**Description**: Various Unicode prompt characters.

**Initial State**: `watching`

**Actions**:
1. Test: Regular '>' vs Unicode '>' vs fullwidth '>'
2. Check promptDetected

**Expected Behavior**:
- Standard patterns detected
- Variant characters may not be detected
- (Document which are supported)

**Priority**: LOW

---

### PD-004: ANSI Codes Splitting Patterns

**Description**: ANSI escape codes inserted within patterns.

**Initial State**: `watching`

**Actions**:
1. Simulate: "Wor\x1b[32mked\x1b[0m for 2m 46s"
2. Check completion detection

**Expected Behavior**:
- Pattern may not match (ANSI in middle of "Worked")
- (This is edge case behavior)

**Priority**: LOW

---

### PD-005: Token Count at Boundary Values

**Description**: Token counts with k/M suffixes.

**Initial State**: `watching`

**Actions**:
1. Simulate: "999.9k tokens" -> "1.0M tokens"
2. Check lastTokenCount value

**Expected Behavior**:
- 999.9k = 999900
- 1.0M = 1000000
- Token change detected

**Priority**: LOW

---

### PD-006: Empty String Token Pattern

**Description**: Token pattern with malformed numbers.

**Initial State**: `watching`

**Actions**:
1. Simulate: "tokens", " tokens", ".k tokens"
2. Check extractTokenCount returns

**Expected Behavior**:
- Returns null for invalid patterns
- No crash

**Priority**: LOW

---

### PD-007: Multiple Completion Messages Same Data

**Description**: Multiple "Worked for Xm Xs" in single terminal chunk.

**Initial State**: `watching`

**Actions**:
1. Simulate: "Worked for 1s... Worked for 2m 30s"
2. Check behavior

**Expected Behavior**:
- First match triggers detection
- completionMessageTime set
- Single confirmation timer started

**Priority**: LOW

---

### PD-008: Spinner Character in Normal Text

**Description**: Spinner Unicode character in regular output.

**Initial State**: `watching`

**Actions**:
1. Simulate: "The sequence is: ⠋ ⠙ ⠹"
2. Check workingDetected

**Expected Behavior**:
- Currently: Detects as working
- This is expected behavior (conservative)

**Priority**: LOW (expected behavior)

---

## Event Emission and Listener Scenarios

### EE-001: No Listeners Registered

**Description**: Events emitted with no listeners.

**Initial State**: Controller with no event listeners

**Actions**:
1. Start controller
2. Run through cycle

**Expected Behavior**:
- No errors
- Events still emitted (just not handled)
- Controller functions normally

**Priority**: LOW

---

### EE-002: Listener Throws Exception

**Description**: Event listener throws during event handling.

**Initial State**: Listener registered that throws

**Actions**:
1. Register listener: on('stateChanged', () => { throw Error })
2. Cause state change

**Expected Behavior**:
- Exception propagates (EventEmitter default)
- (May want to catch in production)

**Priority**: MEDIUM

---

### EE-003: Listener Removes Itself

**Description**: Listener that removes itself during event handling.

**Initial State**: Self-removing listener registered

**Actions**:
1. Register one-time listener
2. Cause event

**Expected Behavior**:
- Listener called once
- Properly removed
- No memory leak

**Priority**: LOW

---

### EE-004: DetectionUpdate Interval Cleanup

**Description**: Detection update interval properly cleaned up.

**Initial State**: Controller running with detection updates

**Actions**:
1. Start controller (starts 500ms interval)
2. Stop controller
3. Check interval cleared

**Expected Behavior**:
- detectionUpdateTimer cleared on stop
- No interval continuing after stop
- No memory leak

**Priority**: MEDIUM

---

### EE-005: Timer Events During Stop

**Description**: Timer fires during stop() execution.

**Initial State**: Multiple timers running

**Actions**:
1. Call stop()
2. Timer fires during cleanup

**Expected Behavior**:
- Timer callback checks state
- No action taken if stopped
- Clean shutdown

**Priority**: LOW

---

## Summary

### Priority Distribution

| Priority | Count | Description |
|----------|-------|-------------|
| HIGH | 18 | Critical functionality and common paths |
| MEDIUM | 24 | Important edge cases and integrations |
| LOW | 22 | Rare edge cases and nice-to-have coverage |

### Coverage Gaps Identified

1. **Full cycle with all steps enabled** - No test covers the complete path through all states
2. **Clear fallback timer** - Not tested (10s timeout when no prompt detected)
3. **AI checker consecutive errors leading to disable** - Not integration tested
4. **Plan checker result discarding** - Stale result handling not fully tested
5. **Step confirmation timer** - The completionConfirmMs wait after each step not tested
6. **Working pattern detection during waiting states** - Limited coverage
7. **Buffer edge cases** - Trim behavior not tested
8. **Timer tracking for UI** - getActiveTimers() accuracy not verified
9. **Event listener error handling** - Not tested
10. **Elicitation flag lifecycle** - Partial coverage

### Recommended Test Implementation Order

1. STS-001 (Full cycle) - Establishes complete flow understanding
2. AIC-001, AIC-002, AIC-003 - Core AI checker verdicts
3. APC-001, APC-004, APC-005 - Core plan checker scenarios
4. STS-005 (Work during monitoring_init) - Important flow branch
5. TC-001 (Step confirm interrupted) - Timer reliability
6. ER-001 (Handler throws) - Robustness
7. CO-002 (Multiple events same tick) - Concurrency safety
