# Phase 2 Implementation Plan: CleanupManager Adoption & Debounce Consolidation

**Source**: `docs/code-structure-findings.md` (Phase 2 — CleanupManager & Debounce)
**Estimated effort**: 2-3 days
**Tasks**: 5 tasks with dependencies (see dependency graph below)

---

## Safety Constraints

Before starting ANY work, read and follow these rules:

1. **Never run `npx vitest run`** (full suite) — it kills tmux sessions. You are running inside a Codeman-managed tmux session.
2. **Run individual tests only**: `npx vitest run test/<file>.test.ts`
3. **Never test on port 3000** — the live dev server runs there. Tests use ports 3150+.
4. **After TypeScript changes**: Run `tsc --noEmit` to verify type checking passes.
5. **Before considering done**: Run `npm run lint` and `npm run format:check` to ensure CI passes.
6. **Never kill tmux sessions** — check `echo $CODEMAN_MUX` first.

---

## Task Dependencies

```
Task 1 (Debouncer utility)
  └──> Task 2 (Migrate 8 files to Debouncer)
       └──> Task 3 (Migrate respawn-controller to CleanupManager)
       └──> Task 4 (Migrate server.ts to CleanupManager)
       └──> Task 5 (Migrate remaining files to CleanupManager)
```

**Task 1** must complete first — the other tasks depend on the `Debouncer` class.
**Tasks 3, 4, 5** are independent of each other and can run in parallel after Task 2.

---

## Task 1: Create `Debouncer` Utility Class

**File to create**: `src/utils/debouncer.ts`
**File to edit**: `src/utils/index.ts` (add barrel export)
**Time**: ~1 hour

### Problem

8+ files implement debounce independently with an identical 3-step pattern:

```typescript
// Repeated everywhere:
private saveTimer: NodeJS.Timeout | null = null;
debouncedSave() {
  if (this.saveTimer) clearTimeout(this.saveTimer);
  this.saveTimer = setTimeout(() => this.save(), 500);
}
stop() {
  if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
}
```

Two variants exist:
1. **Single debouncer** — one timer field per operation (state-store, push-store, ralph-tracker)
2. **Keyed debouncer** — a `Map<string, Timeout>` for per-key debouncing (image-watcher, subagent-watcher, server.ts terminal batching, server.ts persist debounce)

### Implementation

Create two classes: `Debouncer` for single-key and `KeyedDebouncer` for per-key patterns.

**New file**: `src/utils/debouncer.ts`

```typescript
/**
 * @fileoverview Debounce utilities to replace manual timer management.
 *
 * Two variants:
 * - `Debouncer` — single debounced operation (replaces timer + clearTimeout pattern)
 * - `KeyedDebouncer` — per-key debouncing (replaces Map<string, Timeout> pattern)
 *
 * Both integrate with CleanupManager via dispose().
 *
 * @module utils/debouncer
 */

/**
 * Single-operation debouncer.
 *
 * Replaces the common pattern of:
 * ```
 * private timer: NodeJS.Timeout | null = null;
 * debounce(fn) { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(fn, delay); }
 * cancel() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
 * ```
 *
 * @example
 * ```typescript
 * private saveDeb = new Debouncer(500);
 *
 * onChange() {
 *   this.saveDeb.schedule(() => this.save());
 * }
 *
 * stop() {
 *   this.saveDeb.dispose();
 * }
 * ```
 */
export class Debouncer {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly delayMs: number) {}

  /**
   * Schedule a debounced callback. Resets the timer on each call.
   * If a previous call is pending, it is cancelled.
   */
  schedule(fn: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, this.delayMs);
  }

  /** Cancel any pending execution without invoking the callback. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Whether a callback is currently pending. */
  get isPending(): boolean {
    return this.timer !== null;
  }

  /**
   * Cancel pending callback and flush immediately.
   * Useful for shutdown: cancel the timer but run the action now.
   *
   * @param fn - The flush function to run (typically the same function passed to schedule)
   */
  flush(fn: () => void): void {
    this.cancel();
    fn();
  }

  /** Alias for cancel() — matches CleanupManager/Disposable convention. */
  dispose(): void {
    this.cancel();
  }
}

/**
 * Per-key debouncer for operations that need independent timers per resource.
 *
 * Replaces the common pattern of:
 * ```
 * private timers = new Map<string, NodeJS.Timeout>();
 * debounce(key, fn) {
 *   const existing = this.timers.get(key);
 *   if (existing) clearTimeout(existing);
 *   this.timers.set(key, setTimeout(() => { this.timers.delete(key); fn(); }, delay));
 * }
 * ```
 *
 * @example
 * ```typescript
 * private fileDebouncers = new KeyedDebouncer(100);
 *
 * onFileChange(path: string) {
 *   this.fileDebouncers.schedule(path, () => this.processFile(path));
 * }
 *
 * stop() {
 *   this.fileDebouncers.dispose();
 * }
 * ```
 */
export class KeyedDebouncer {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly delayMs: number) {}

  /**
   * Schedule a debounced callback for a specific key.
   * Each key has its own independent timer.
   */
  schedule(key: string, fn: () => void): void {
    this.cancelKey(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, this.delayMs)
    );
  }

  /** Cancel a pending callback for a specific key. */
  cancelKey(key: string): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  /** Whether a callback is pending for a specific key. */
  has(key: string): boolean {
    return this.timers.has(key);
  }

  /** Number of active timers. */
  get size(): number {
    return this.timers.size;
  }

  /** Get all currently active keys. */
  keys(): IterableIterator<string> {
    return this.timers.keys();
  }

  /** Cancel all pending callbacks. */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Cancel all pending callbacks and run a flush function for each active key.
   * Useful for shutdown: cancel timers but run the action for each pending key.
   *
   * @param fn - Called once per active key with the key as argument
   */
  flushAll(fn: (key: string) => void): void {
    const keys = Array.from(this.timers.keys());
    this.dispose();
    for (const key of keys) {
      fn(key);
    }
  }
}
```

### Edit: Add barrel export

**File**: `src/utils/index.ts`

Add after the `CleanupManager` export line:

```typescript
export { Debouncer, KeyedDebouncer } from './debouncer.js';
```

### Verification

```bash
tsc --noEmit
npm run lint
npm run format:check
```

---

## Task 2: Migrate 8 Files from Manual Debounce to Debouncer

**Time**: ~3 hours

Migrate all manual debounce patterns to use the new `Debouncer` and `KeyedDebouncer` classes. Each file migration is independent — verify with `tsc --noEmit` after each one.

### 2.1: `src/state-store.ts` — 2 Debouncers

**Current** (lines 63, 71, 151-160, 245-248):
```typescript
private saveTimeout: NodeJS.Timeout | null = null;
private ralphStateSaveTimeout: NodeJS.Timeout | null = null;

save(): void {
  this.dirty = true;
  if (this.saveTimeout) return;
  this.saveTimeout = setTimeout(() => { ... }, SAVE_DEBOUNCE_MS);
}

// In _doSaveAsync():
if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }
```

**New**:
```typescript
import { Debouncer } from './utils/index.js';

private saveDeb = new Debouncer(SAVE_DEBOUNCE_MS);
private ralphStateSaveDeb = new Debouncer(SAVE_DEBOUNCE_MS);
```

**Edits required**:

1. **Replace `saveTimeout` field** (line 63): Delete `private saveTimeout: NodeJS.Timeout | null = null;`, replace with `private saveDeb = new Debouncer(SAVE_DEBOUNCE_MS);`
2. **Replace `ralphStateSaveTimeout` field** (line 71): Delete `private ralphStateSaveTimeout: NodeJS.Timeout | null = null;`, replace with `private ralphStateSaveDeb = new Debouncer(SAVE_DEBOUNCE_MS);`
3. **Update `save()` method** (lines 151-161): Replace the manual timer logic:
   ```typescript
   save(): void {
     this.dirty = true;
     this.saveDeb.schedule(() => {
       this.saveNowAsync().catch((err) => {
         console.error('[StateStore] Async save failed:', err);
       });
     });
   }
   ```
   Note: The original pattern uses "if already scheduled, return" (leading-edge debounce). The Debouncer uses trailing-edge (reschedule). State-store's `save()` uses leading-edge: once scheduled, subsequent calls are no-ops until the timer fires. To preserve this behavior exactly, keep the `if (this.saveDeb.isPending) return;` guard:
   ```typescript
   save(): void {
     this.dirty = true;
     if (this.saveDeb.isPending) return;
     this.saveDeb.schedule(() => {
       this.saveNowAsync().catch((err) => {
         console.error('[StateStore] Async save failed:', err);
       });
     });
   }
   ```
4. **Update `_doSaveAsync()`** (line 245-248): Replace `if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }` with `this.saveDeb.cancel();`
5. **Update `saveNow()`** (lines 334-338): Replace `clearTimeout(this.saveTimeout)` logic with `this.saveDeb.cancel();`
6. **Update Ralph state save** methods similarly — find all `ralphStateSaveTimeout` references and replace with `this.ralphStateSaveDeb.schedule(...)` / `this.ralphStateSaveDeb.cancel()`
7. **Add import**: `import { Debouncer } from './utils/index.js';`

**Search for all references**: `grep -n 'saveTimeout\|ralphStateSaveTimeout' src/state-store.ts` — update every hit.

### 2.2: `src/push-store.ts` — 1 Debouncer

**Current** (lines 23, 150-156, 169-178):
```typescript
private saveTimer: NodeJS.Timeout | null = null;

private scheduleSave(): void {
  if (this._disposed) return;
  if (this.saveTimer) clearTimeout(this.saveTimer);
  this.saveTimer = setTimeout(() => { this.flushSave(); }, SAVE_DEBOUNCE_MS);
}

dispose(): void {
  if (this._disposed) return;
  this._disposed = true;
  if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  this.flushSave();
}
```

**New**:
```typescript
import { Debouncer } from './utils/index.js';

private saveDeb = new Debouncer(SAVE_DEBOUNCE_MS);
```

**Edits required**:

1. **Replace `saveTimer` field** (line 23): `private saveDeb = new Debouncer(SAVE_DEBOUNCE_MS);`
2. **Update `scheduleSave()`** (lines 150-156):
   ```typescript
   private scheduleSave(): void {
     if (this._disposed) return;
     this.saveDeb.schedule(() => this.flushSave());
   }
   ```
3. **Update `dispose()`** (lines 169-178):
   ```typescript
   dispose(): void {
     if (this._disposed) return;
     this._disposed = true;
     this.saveDeb.flush(() => this.flushSave());
   }
   ```
4. **Add import**: `import { Debouncer } from './utils/index.js';`

### 2.3: `src/ralph-tracker.ts` — 2 Debouncers + 2 standalone timers

The ralph-tracker has 4 timer fields. Two follow the debounce pattern (`_todoUpdateTimer`, `_loopUpdateTimer`) and two are standalone timers (`_fixPlanReloadTimer`, `_iterationStallTimer`).

**Current** (lines 562-566, 624-625, 668-669, 1025-1078):
```typescript
private _todoUpdateTimer: NodeJS.Timeout | null = null;
private _loopUpdateTimer: NodeJS.Timeout | null = null;
private _fixPlanReloadTimer: NodeJS.Timeout | null = null;
private _iterationStallTimer: NodeJS.Timeout | null = null;
```

**Edits required**:

1. **Replace debounce timer fields** (lines 562-572): Replace `_todoUpdateTimer`, `_loopUpdateTimer`, `_todoUpdatePending`, `_loopUpdatePending` with:
   ```typescript
   private _todoUpdateDeb = new Debouncer(EVENT_DEBOUNCE_MS);
   private _loopUpdateDeb = new Debouncer(EVENT_DEBOUNCE_MS);
   ```
   The `_*Pending` flags are no longer needed — `Debouncer.isPending` replaces them.

2. **Rewrite `emitTodoUpdateDebounced()`** (lines 1043-1057):
   ```typescript
   private emitTodoUpdateDebounced(): void {
     this._todoUpdateDeb.schedule(() => {
       this.emit('todoUpdate', this.todos);
     });
   }
   ```

3. **Rewrite `emitLoopUpdateDebounced()`** (lines 1064-1078):
   ```typescript
   private emitLoopUpdateDebounced(): void {
     this._loopUpdateDeb.schedule(() => {
       this.emit('loopUpdate', this.loopState);
     });
   }
   ```

4. **Rewrite `clearDebounceTimers()`** (lines 1025-1036):
   ```typescript
   private clearDebounceTimers(): void {
     this._todoUpdateDeb.cancel();
     this._loopUpdateDeb.cancel();
   }
   ```

5. **Leave `_fixPlanReloadTimer` and `_iterationStallTimer` as-is** for now — they are standalone timers, not debounce patterns. They will be migrated to `CleanupManager` in Task 5.

6. **Add import**: `import { Debouncer } from './utils/index.js';`

**Search for all references**: `grep -n '_todoUpdateTimer\|_loopUpdateTimer\|_todoUpdatePending\|_loopUpdatePending' src/ralph-tracker.ts` — update every hit.

### 2.4: `src/bash-tool-parser.ts` — 1 Debouncer

**Current** (lines 31, 156, 699-701):
```typescript
const EVENT_DEBOUNCE_MS = 50;
private _updateTimer: ReturnType<typeof setTimeout> | null = null;

// In destroy():
if (this._updateTimer) { clearTimeout(this._updateTimer); this._updateTimer = null; }
```

**Edits required**:

1. **Replace `_updateTimer` field** (line 156): `private _updateDeb = new Debouncer(EVENT_DEBOUNCE_MS);`
2. **Update all `_updateTimer` usage** — find with `grep -n '_updateTimer' src/bash-tool-parser.ts` and replace:
   - `if (this._updateTimer) clearTimeout(this._updateTimer);` + `this._updateTimer = setTimeout(...)` → `this._updateDeb.schedule(...)`
   - Cleanup in `destroy()`: → `this._updateDeb.dispose();`
3. **Leave `_autoRemoveTimers` Set as-is** — these are per-tool auto-remove timers with individual delays, not debounce. They'll be migrated to CleanupManager in Task 5.
4. **Add import**: `import { Debouncer } from './utils/index.js';`

### 2.5: `src/image-watcher.ts` — 1 KeyedDebouncer

**Current** (lines 36, 69, 72, 121-124, 202-228):
```typescript
const DEBOUNCE_DELAY_MS = 200;
private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
private timerToSession: Map<string, string> = new Map();  // tracks which session owns each timer

// In stop():
for (const timer of this.debounceTimers.values()) clearTimeout(timer);
this.debounceTimers.clear();
this.timerToSession.clear();
```

**Edits required**:

1. **Replace `debounceTimers` and `timerToSession` fields** (lines 69, 72): Replace both with:
   ```typescript
   private fileDeb = new KeyedDebouncer(DEBOUNCE_DELAY_MS);
   private fileToSession = new Map<string, string>(); // tracks which session owns each debounced file
   ```
   Note: We still need `fileToSession` to look up which session a file belongs to (used in `unwatchSession()` to selectively cancel timers). Rename from `timerToSession` to `fileToSession` for clarity since the key is the file path, not a timer ID.

2. **Update debounce call sites** — find with `grep -n 'debounceTimers' src/image-watcher.ts`:
   - Where a file change is detected and debounced, replace:
     ```typescript
     const existing = this.debounceTimers.get(filePath);
     if (existing) clearTimeout(existing);
     this.debounceTimers.set(filePath, setTimeout(() => { ... }, DEBOUNCE_DELAY_MS));
     ```
     with:
     ```typescript
     this.fileDeb.schedule(filePath, () => { ... });
     ```
   - Also update `timerToSession` references to `fileToSession`.

3. **Update `stop()`** (lines 121-124): Replace timer cleanup with `this.fileDeb.dispose();`

4. **Update `unwatchSession()`** (lines 202-228): This method selectively cancels timers for a specific session. Replace:
   ```typescript
   // Collect timers to cancel (avoid modifying map during iteration)
   const toCancel: string[] = [];
   for (const [file, sessionId] of this.timerToSession) {
     if (sessionId === id) toCancel.push(file);
   }
   for (const file of toCancel) {
     const timer = this.debounceTimers.get(file);
     if (timer) clearTimeout(timer);
     this.debounceTimers.delete(file);
     this.timerToSession.delete(file);
   }
   ```
   with:
   ```typescript
   const toCancel: string[] = [];
   for (const [file, sessionId] of this.fileToSession) {
     if (sessionId === id) toCancel.push(file);
   }
   for (const file of toCancel) {
     this.fileDeb.cancelKey(file);
     this.fileToSession.delete(file);
   }
   ```

5. **Add import**: `import { KeyedDebouncer } from './utils/index.js';`

### 2.6: `src/subagent-watcher.ts` — 1 KeyedDebouncer

The subagent-watcher has a `fileDebouncers` Map for per-file debouncing.

**Edits required**:

1. Find the `fileDebouncers` Map field and replace with `private fileDeb = new KeyedDebouncer(100);` (100ms delay — check the actual constant in the file)
2. Update all `fileDebouncers.get()`/`.set()`/`clearTimeout()` call sites to use `this.fileDeb.schedule(key, fn)` and `this.fileDeb.cancelKey(key)`
3. Update `stop()` to use `this.fileDeb.dispose()` instead of the manual map iteration
4. **Add import**: `import { KeyedDebouncer } from './utils/index.js';`

**Search**: `grep -n 'fileDebouncers' src/subagent-watcher.ts`

### 2.7: `src/web/server.ts` — 1 KeyedDebouncer for persist timers

Server.ts has `persistDebounceTimers: Map<string, ReturnType<typeof setTimeout>>` (line 449) — a per-session debounce map.

**Edits required**:

1. **Replace `persistDebounceTimers` field** (line 449): `private persistDeb = new KeyedDebouncer(500);`
   Check the actual debounce delay used when `persistDebounceTimers` is populated — search for where timers are added to this map.
2. **Update timer creation sites** — `grep -n 'persistDebounceTimers' src/web/server.ts`:
   - Replace `this.persistDebounceTimers.set(id, setTimeout(...))` with `this.persistDeb.schedule(id, () => ...)`
   - Replace `clearTimeout(this.persistDebounceTimers.get(id))` with `this.persistDeb.cancelKey(id)`
3. **Update `stop()` method** (lines 6590-6597): Replace the flush loop:
   ```typescript
   // Old:
   for (const [sessionId, timer] of this.persistDebounceTimers) {
     clearTimeout(timer);
     const session = this.sessions.get(sessionId);
     if (session) this._persistSessionStateNow(session);
   }
   this.persistDebounceTimers.clear();

   // New:
   this.persistDeb.flushAll((sessionId) => {
     const session = this.sessions.get(sessionId);
     if (session) this._persistSessionStateNow(session);
   });
   ```
4. **Add import**: `import { KeyedDebouncer } from '../../utils/index.js';` (or adjust path for server.ts location)

**Note**: Do NOT migrate `terminalBatchTimers` to `KeyedDebouncer` — terminal batching uses variable delays (16-50ms adaptive) and stores batch data in separate Maps. The `KeyedDebouncer` with a fixed delay isn't a good fit. Leave terminal batching as-is.

### 2.8: Verify `Debouncer` is not needed in `src/respawn-controller.ts`

The respawn-controller has 10 timer fields, but **none** follow the debounce pattern. They are all one-shot timers or intervals started/stopped at state transitions. The correct tool for these is `CleanupManager`, not `Debouncer`. This is handled in Task 3.

### Verification (after all 2.x edits)

```bash
tsc --noEmit
npm run lint
npm run format:check

# Run tests for affected modules (where tests exist):
npx vitest run test/image-watcher.test.ts
npx vitest run test/task-tracker.test.ts   # tests bash-tool-parser indirectly
```

---

## Task 3: Migrate `respawn-controller.ts` to CleanupManager

**File**: `src/respawn-controller.ts`
**Time**: ~3 hours

This is the biggest single migration (10 timer fields + 1 interval field + `activeTimers` tracking map).

### Current State (lines 644-745, 1773-1816)

```typescript
// 10 Timeout fields:
private stepTimer: NodeJS.Timeout | null = null;
private completionConfirmTimer: NodeJS.Timeout | null = null;
private noOutputTimer: NodeJS.Timeout | null = null;
private detectionUpdateTimer: NodeJS.Timeout | null = null;  // actually setInterval
private autoAcceptTimer: NodeJS.Timeout | null = null;
private preFilterTimer: NodeJS.Timeout | null = null;
private hookConfirmTimer: NodeJS.Timeout | null = null;
private clearFallbackTimer: NodeJS.Timeout | null = null;
private stepConfirmTimer: NodeJS.Timeout | null = null;
private stuckStateTimer: NodeJS.Timeout | null = null;  // actually setInterval

// UI tracking map:
private activeTimers: Map<string, { name: string; startedAt: number; durationMs: number; endsAt: number }>;
```

The `clearTimers()` method (lines 1773-1816) has 10 individual if-clearTimeout-null blocks plus a `clearInterval` for the two interval timers.

### Strategy

Replace all 10 timer fields with a single `CleanupManager` instance. Use the `description` option to give each timer a human-readable name. The `activeTimers` Map for UI countdown display must be preserved since it serves a different purpose (user-facing timer list).

**Key constraint**: Several methods cancel specific timers by name before rescheduling (e.g., `resetNoOutputTimer()` clears `noOutputTimer` then sets a new one). `CleanupManager.setTimeout()` returns a registration ID — store these IDs in named fields to support cancel-and-reschedule.

### Implementation

1. **Add field** at the class level:
   ```typescript
   private cleanup = new CleanupManager();
   ```

2. **Replace individual timer fields** with registration ID fields:
   ```typescript
   // Old:
   private stepTimer: NodeJS.Timeout | null = null;
   // New:
   private stepTimerId: string | null = null;
   ```

   Apply to all 10 timer fields. The naming convention is `*Id` suffix to indicate these hold CleanupManager registration IDs, not raw `NodeJS.Timeout` handles.

3. **Replace timer creation**: Everywhere a timer is started, replace:
   ```typescript
   // Old:
   if (this.stepTimer) clearTimeout(this.stepTimer);
   this.stepTimer = setTimeout(() => { ... }, delay);

   // New:
   if (this.stepTimerId) this.cleanup.unregister(this.stepTimerId);
   this.stepTimerId = this.cleanup.setTimeout(() => {
     if (this.cleanup.isStopped) return;
     ...
   }, delay, { description: 'step delay' });
   ```

   For intervals (`detectionUpdateTimer`, `stuckStateTimer`):
   ```typescript
   // Old:
   this.detectionUpdateTimer = setInterval(() => { ... }, 2000);
   // New:
   this.detectionUpdateTimerId = this.cleanup.setInterval(() => { ... }, 2000, { description: 'detection status updates' });
   ```

4. **Replace `clearTimers()`** (lines 1773-1816):
   ```typescript
   private clearTimers(): void {
     this.activeTimers.clear();
     this.cleanup.dispose();
     // Reinitialize for reuse (controller can be stopped and restarted)
     this.cleanup = new CleanupManager();
     // Null out IDs
     this.stepTimerId = null;
     this.completionConfirmTimerId = null;
     this.noOutputTimerId = null;
     this.detectionUpdateTimerId = null;
     this.autoAcceptTimerId = null;
     this.preFilterTimerId = null;
     this.hookConfirmTimerId = null;
     this.clearFallbackTimerId = null;
     this.stepConfirmTimerId = null;
     this.stuckStateTimerId = null;
   }
   ```

   **Important**: The respawn controller is reusable — `stop()` can be followed by `start()`. Since `CleanupManager.dispose()` sets `isDisposed = true` permanently, we must create a new instance after disposing. This is safe and cheap.

5. **Replace individual timer cancels** throughout the file — search for each timer name pattern:
   ```bash
   grep -n 'stepTimer\|completionConfirmTimer\|noOutputTimer\|detectionUpdateTimer\|autoAcceptTimer\|preFilterTimer\|hookConfirmTimer\|clearFallbackTimer\|stepConfirmTimer\|stuckStateTimer' src/respawn-controller.ts
   ```
   Each `if (this.xxxTimer) { clearTimeout(this.xxxTimer); this.xxxTimer = null; }` becomes `if (this.xxxTimerId) { this.cleanup.unregister(this.xxxTimerId); this.xxxTimerId = null; }`.

6. **Update `stop()` method** to ensure cleanup is called:
   ```typescript
   stop(): void {
     // ... existing stop logic ...
     this.clearTimers();
     // clearTimers() now handles all cleanup via CleanupManager.dispose()
   }
   ```

7. **Add import**: `import { CleanupManager } from './utils/index.js';`

### activeTimers Map (UI Display)

The `activeTimers` Map (line 733) tracks timers for UI countdown display. This is a **separate concern** from lifecycle cleanup and must be preserved alongside the CleanupManager migration. Continue updating it when timers are started/stopped as before.

### Methods to Update

Find each of these methods and update their timer management:

| Method | Timer(s) Used |
|--------|--------------|
| `step()` / internal step functions | `stepTimer` |
| `startCompletionConfirm()` | `completionConfirmTimer` |
| `resetNoOutputTimer()` | `noOutputTimer` |
| `startDetectionUpdates()` / `stopDetectionUpdates()` | `detectionUpdateTimer` (interval) |
| `resetAutoAcceptTimer()` | `autoAcceptTimer` |
| `resetPreFilterTimer()` | `preFilterTimer` |
| `startHookConfirmTimer()` | `hookConfirmTimer` |
| `startClearFallbackTimer()` | `clearFallbackTimer` |
| `startStepConfirmTimer()` | `stepConfirmTimer` |
| `startStuckStateTimer()` | `stuckStateTimer` (interval) |

### Verification

```bash
tsc --noEmit
npm run lint
npx vitest run test/respawn-controller.test.ts
```

---

## Task 4: Migrate `server.ts` Timer Cleanup to CleanupManager

**File**: `src/web/server.ts`
**Time**: ~2 hours

### Current State (lines 424-449, 6529-6660)

Server.ts has 6 standalone timers (not counting the Maps migrated in Task 2):

```typescript
private scheduledCleanupTimer: NodeJS.Timeout | null = null;    // setInterval
private taskUpdateBatchTimer: NodeJS.Timeout | null = null;      // setTimeout
private stateUpdateTimer: NodeJS.Timeout | null = null;          // setTimeout
private sseHealthCheckTimer: NodeJS.Timeout | null = null;       // setInterval
private tokenRecordingTimer: NodeJS.Timeout | null = null;       // setInterval
```

Plus one Map already migrated to `KeyedDebouncer` in Task 2:
```typescript
private persistDebounceTimers → persistDeb  // Done in Task 2
```

And Maps that should NOT be migrated (variable delay, complex batch logic):
```typescript
private terminalBatchTimers: Map<string, NodeJS.Timeout>     // Leave as-is
private pendingRespawnStarts: Map<string, NodeJS.Timeout>     // Leave as-is
```

### Strategy

Add a `CleanupManager` to handle the 5 standalone timers. Leave `terminalBatchTimers` and `pendingRespawnStarts` as manual Maps (they have complex lifecycle requirements that don't fit CleanupManager cleanly).

### Implementation

1. **Add field**:
   ```typescript
   private cleanup = new CleanupManager();
   ```

2. **Replace 5 standalone timer fields** with CleanupManager registration IDs. For timers that are set once during `start()` and never reset:
   ```typescript
   // Old (in startServer or setupRoutes):
   this.sseHealthCheckTimer = setInterval(() => { ... }, SSE_HEALTH_CHECK_INTERVAL);
   // New:
   this.cleanup.setInterval(() => { ... }, SSE_HEALTH_CHECK_INTERVAL, { description: 'SSE health check' });
   ```

   For these "start once" timers, we don't even need to store the registration ID since they're never individually cancelled. The timers in this category:
   - `sseHealthCheckTimer` — started once, cleared on stop
   - `scheduledCleanupTimer` — started once, cleared on stop
   - `tokenRecordingTimer` — started once, cleared on stop

   For timers that are reset during operation:
   - `taskUpdateBatchTimer` — reset on each task update batch
   - `stateUpdateTimer` — reset on each state change

   These need stored registration IDs:
   ```typescript
   private taskUpdateBatchTimerId: string | null = null;
   private stateUpdateTimerId: string | null = null;
   ```

3. **Update `stop()` method** (lines 6529-6660): Replace individual timer clears with:
   ```typescript
   // Replace lines 6535-6584 (5 individual timer clears) with:
   this.cleanup.dispose();
   ```

   Keep the remaining cleanup that isn't timer-related:
   - SSE client graceful close (lines 6541-6551) — keep
   - Terminal batch timer Map clear (lines 6554-6559) — keep (not migrated)
   - Pending respawn starts Map clear (lines 6604-6607) — keep (not migrated)
   - Persist debouncer flush (migrated in Task 2 to `this.persistDeb.flushAll(...)`) — keep
   - Everything else below (respawn controllers, sessions, listeners) — keep

4. **Add import**: Add `CleanupManager` to the imports from utils (likely already imported but unused).

### What NOT to Migrate

- **`terminalBatchTimers`**: Per-session batch timers with adaptive 16-50ms delays. Complex lifecycle, variable delays, performance-critical. Keep as manual Map.
- **`pendingRespawnStarts`**: Grace period timers for restored sessions. Set once per session on startup, cleared individually when sessions start. Keep as manual Map.
- **SSE client management**: Not timer-based. Keep as-is.
- **Session listener refs**: EventEmitter cleanup, not timers. Keep as-is.

### Verification

```bash
tsc --noEmit
npm run lint
npm run format:check
```

No dedicated server.ts tests exist, so verify manually:
```bash
# Start dev server and confirm it runs without errors
npx tsx src/index.ts web &
sleep 3
curl -s http://localhost:3000/api/status | jq '.status'
# Should output "ok"
# Then kill the background process
```

---

## Task 5: Migrate Remaining Files to CleanupManager

**Files**: `src/ralph-tracker.ts`, `src/bash-tool-parser.ts`, `src/image-watcher.ts`, `src/subagent-watcher.ts`
**Time**: ~2 hours

After Task 2 migrates debounce patterns to `Debouncer`/`KeyedDebouncer`, some files still have standalone timers, watchers, and interval resources that should use `CleanupManager`.

### 5.1: `src/ralph-tracker.ts` — Watcher + 2 standalone timers

After Task 2, the debounce timers (`_todoUpdateDeb`, `_loopUpdateDeb`) are handled. Remaining:

**Still manual**:
- `_fixPlanWatcher: FSWatcher | null` (line 620) — file system watcher
- `_fixPlanWatcherErrorHandler` (line 622) — stored error handler ref
- `_fixPlanReloadTimer: NodeJS.Timeout | null` (line 625) — debounce for file changes
- `_iterationStallTimer: NodeJS.Timeout | null` (line 669) — stall detection interval

**Edits required**:

1. **Add field**: `private cleanup = new CleanupManager();`
2. **Migrate `_fixPlanReloadTimer`** to a `Debouncer` (it IS a debounce pattern — file change events are debounced):
   ```typescript
   private _fixPlanReloadDeb = new Debouncer(500); // check actual delay
   ```
3. **Migrate `_fixPlanWatcher`**: When the watcher is created, register it:
   ```typescript
   this.cleanup.registerWatcher(watcher, 'fix plan file watcher');
   ```
   Remove the manual `_fixPlanWatcher` and `_fixPlanWatcherErrorHandler` fields.
4. **Migrate `_iterationStallTimer`**: When started, use:
   ```typescript
   this._iterationStallTimerId = this.cleanup.setInterval(() => { ... }, interval, { description: 'iteration stall detection' });
   ```
5. **Update `destroy()`**: Add `this.cleanup.dispose();` and `this._fixPlanReloadDeb.dispose();`. Remove manual timer/watcher cleanup that's now handled by CleanupManager.
6. **Update `stopWatchingFixPlan()`**: Use `this.cleanup.unregister(watcherId)` instead of manual `watcher.close()`.
7. **Update `stopIterationStallDetection()`**: Use `this.cleanup.unregister(this._iterationStallTimerId)` instead of manual `clearInterval()`.

### 5.2: `src/bash-tool-parser.ts` — Auto-remove timer Set

After Task 2, `_updateDeb` handles the event debounce. Remaining:

**Still manual**:
- `_autoRemoveTimers: Set<ReturnType<typeof setTimeout>>` (line 149) — Set of auto-remove timeouts per tool

**Edits required**:

1. **Add field**: `private cleanup = new CleanupManager();`
2. **Replace `_autoRemoveTimers` Set**: When a tool auto-remove timer is created:
   ```typescript
   // Old:
   const timer = setTimeout(() => { this.removeTool(id); }, AUTO_REMOVE_MS);
   this._autoRemoveTimers.add(timer);
   // New:
   this.cleanup.setTimeout(() => { this.removeTool(id); }, AUTO_REMOVE_MS, { description: `auto-remove tool ${id}` });
   ```
   Remove the `_autoRemoveTimers` Set field entirely.
3. **Update `destroy()`**: Replace `for (const t of this._autoRemoveTimers) clearTimeout(t); this._autoRemoveTimers.clear();` with `this.cleanup.dispose();`
4. **Add `if (this.cleanup.isStopped) return;` guard** in callbacks that fire after potential disposal.

### 5.3: `src/image-watcher.ts` — Chokidar watchers

After Task 2, `fileDeb` (KeyedDebouncer) handles per-file debouncing. Remaining:

**Still manual**:
- `watchers: Map<string, FSWatcher>` — chokidar file watchers per session

**Edits required**:

1. **Add field**: `private cleanup = new CleanupManager();`
2. **Register watchers on creation**: When a watcher is created for a session:
   ```typescript
   const watcherId = this.cleanup.registerWatcher(watcher, `image watcher for ${sessionId}`);
   // Store watcherId → sessionId mapping if needed for selective cleanup
   ```
3. **Update `stop()`**: Replace manual watcher close loop with `this.cleanup.dispose();`
4. **Update `unwatchSession()`**: Need to selectively unregister watchers for a specific session. This requires storing the registration ID alongside the session mapping. Add a `watcherIds: Map<string, string>` to map `sessionId → cleanupRegistrationId`, then:
   ```typescript
   const regId = this.watcherIds.get(sessionId);
   if (regId) this.cleanup.unregister(regId);
   ```

**Note**: If `unwatchSession()` selective cleanup makes CleanupManager usage awkward (needing a parallel tracking Map), it may be simpler to keep the watcher Map manual and only migrate the overall `stop()` cleanup. Use judgment — the goal is reducing boilerplate, not adding complexity.

### 5.4: `src/subagent-watcher.ts` — Intervals + watchers

After Task 2, `fileDeb` (KeyedDebouncer) handles file debouncing. Remaining:

**Still manual**:
- Poll interval
- Liveness check interval
- Idle timers Map
- Directory watchers
- Error handler references

**Edits required**:

1. **Add field**: `private cleanup = new CleanupManager();`
2. **Register poll interval**:
   ```typescript
   this.cleanup.setInterval(() => this.poll(), POLL_INTERVAL_MS, { description: 'subagent poll' });
   ```
3. **Register liveness interval**:
   ```typescript
   this.cleanup.setInterval(() => this.checkLiveness(), LIVENESS_INTERVAL_MS, { description: 'subagent liveness check' });
   ```
4. **Migrate idle timers Map**: Replace `idleTimers: Map<string, NodeJS.Timeout>` with `KeyedDebouncer` or individual `CleanupManager.setTimeout()` calls. If idle timers have the same delay, use `KeyedDebouncer`. If variable delay, use CleanupManager and store registration IDs.
5. **Register directory watchers**: When fs.watch watchers are created:
   ```typescript
   this.cleanup.registerWatcher(watcher, `subagent dir watcher for ${sessionId}`);
   ```
6. **Update `stop()`**: Replace the long manual cleanup with:
   ```typescript
   this.cleanup.dispose();
   this.fileDeb.dispose();  // From Task 2
   // Clear data Maps (not timer/resource related):
   this.filePositions.clear();
   this.agentInfo.clear();
   // ... etc
   ```

### Verification

```bash
tsc --noEmit
npm run lint
npm run format:check
npx vitest run test/image-watcher.test.ts
npx vitest run test/task-tracker.test.ts
```

---

## Final Verification Checklist

After all 5 tasks are complete, run the following:

```bash
# 1. TypeScript type checking
tsc --noEmit

# 2. Linting
npm run lint

# 3. Formatting
npm run format:check

# 4. Run affected test files individually (NOT the full suite)
npx vitest run test/respawn-controller.test.ts
npx vitest run test/image-watcher.test.ts
npx vitest run test/task-tracker.test.ts
npx vitest run test/task-queue.test.ts
npx vitest run test/session-manager.test.ts
```

If any formatting issues arise:
```bash
npm run format
```

If any lint issues arise:
```bash
npm run lint:fix
```

---

## Summary of Changes

| Task | Files Modified | Files Created | Key Change |
|------|---------------|---------------|------------|
| 1. Debouncer utility | `src/utils/index.ts` | `src/utils/debouncer.ts` | `Debouncer` + `KeyedDebouncer` classes |
| 2. Debounce migrations | 7 files (state-store, push-store, ralph-tracker, bash-tool-parser, image-watcher, subagent-watcher, server.ts) | — | Replace manual timer patterns with Debouncer/KeyedDebouncer |
| 3. Respawn CleanupManager | `src/respawn-controller.ts` | — | 10 timer fields → CleanupManager |
| 4. Server CleanupManager | `src/web/server.ts` | — | 5 standalone timers → CleanupManager |
| 5. Remaining CleanupManager | 4 files (ralph-tracker, bash-tool-parser, image-watcher, subagent-watcher) | — | Watchers, intervals, auto-remove timers → CleanupManager |

**Total files modified**: 10
**Total files created**: 1
**Timer fields eliminated**: ~30 manual timer fields → Debouncer/KeyedDebouncer/CleanupManager
**Lines of boilerplate removed**: ~200+ lines of if-clearTimeout-null patterns

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Timer behavior changes (leading vs trailing edge) | Medium | Preserve `isPending` guard for state-store's leading-edge pattern |
| Respawn controller restart after dispose | Low | Reinitialize CleanupManager in `clearTimers()` |
| Selective cleanup in image/subagent watchers | Low | Keep parallel tracking Maps where CleanupManager doesn't fit |
| TypeScript strict mode violations | Low | `tsc --noEmit` after each file migration |
| Test regressions | Low | Existing tests cover timer-dependent behavior |

### What NOT to Touch

- **Terminal batch timers** (`server.ts:terminalBatchTimers`) — performance-critical adaptive batching with variable delays
- **Pending respawn starts** (`server.ts:pendingRespawnStarts`) — one-shot timers with individual lifecycle
- **SSE client management** — not timer-based
- **Session listener refs** — EventEmitter cleanup, not timers
- **Frontend `app.js`** — separate concern (Phase 5 of the overall roadmap)
