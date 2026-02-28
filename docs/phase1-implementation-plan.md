# Phase 1 Implementation Plan: Quick Wins

**Source**: `docs/code-structure-findings.md` (Phase 1 - Quick Wins section)
**Estimated effort**: 1-2 days
**Tasks**: 5 independent tasks (can be done in parallel unless noted)

---

## Safety Constraints

Before starting ANY work, read and follow these rules:

1. **Never run `npx vitest run`** (full suite) -- it kills tmux sessions. You are running inside a Codeman-managed tmux session.
2. **Run individual tests only**: `npx vitest run test/<file>.test.ts`
3. **Never test on port 3000** -- the live dev server runs there. Tests use ports 3150+.
4. **After TypeScript changes**: Run `tsc --noEmit` to verify type checking passes.
5. **Before considering done**: Run `npm run lint` and `npm run format:check` to ensure CI passes.
6. **Never kill tmux sessions** -- check `echo $CODEMAN_MUX` first.

---

## Task Dependencies

All 5 tasks are independent and can be done in parallel. However:
- Task 1 (barrel exports) is a prerequisite if you want to update import sites to use the barrel after Task 3 (consolidate EXEC_TIMEOUT_MS). The EXEC_TIMEOUT_MS consolidation creates a new export that should be added to the barrel.
- Task 2 (delete dead functions) removes functions that Task 1 would otherwise need to add to the barrel. Do Task 2 first or simultaneously with Task 1 to avoid adding exports for dead code.

**Recommended order**: Task 2 -> Task 1 -> Task 3 -> Task 4 -> Task 5

---

## Task 1: Export Missing Functions from Utils Barrel

**File**: `src/utils/index.ts`
**Time**: ~30 minutes

### Problem

The barrel file (`src/utils/index.ts`) is missing exports for several functions that are defined in util modules, forcing consumers to use deep imports or preventing usage entirely.

### Missing Exports

From `src/utils/regex-patterns.ts`:
- `createAnsiPatternFull()` -- factory for fresh ANSI regex (documented in CLAUDE.md)
- `createAnsiPatternSimple()` -- factory for fresh ANSI regex (documented in CLAUDE.md)
- `stripAnsi()` -- ANSI stripping utility
- `SAFE_PATH_PATTERN` -- regex for safe file paths (currently deep-imported by `schemas.ts` and `tmux-manager.ts`)

From `src/utils/token-validation.ts`:
- `validateTokenCounts()` -- token count validation (documented in CLAUDE.md)
- `validateTokensAndCost()` -- token + cost validation (documented in CLAUDE.md)

**Note**: Do NOT export `isSimilar`, `isSimilarByDistance`, `levenshteinDistance`, or `normalizePhrase` from `string-similarity.ts` -- these are dead code (see Task 2).

### Edit 1: Add missing regex-patterns exports

**File**: `src/utils/index.ts`

**Old code** (lines 13-18):
```typescript
export {
  ANSI_ESCAPE_PATTERN_FULL,
  ANSI_ESCAPE_PATTERN_SIMPLE,
  TOKEN_PATTERN,
  SPINNER_PATTERN,
} from './regex-patterns.js';
```

**New code**:
```typescript
export {
  ANSI_ESCAPE_PATTERN_FULL,
  ANSI_ESCAPE_PATTERN_SIMPLE,
  TOKEN_PATTERN,
  SPINNER_PATTERN,
  createAnsiPatternFull,
  createAnsiPatternSimple,
  stripAnsi,
  SAFE_PATH_PATTERN,
} from './regex-patterns.js';
```

### Edit 2: Add missing token-validation exports

**File**: `src/utils/index.ts`

**Old code** (line 19):
```typescript
export { MAX_SESSION_TOKENS } from './token-validation.js';
```

**New code**:
```typescript
export { MAX_SESSION_TOKENS, validateTokenCounts, validateTokensAndCost } from './token-validation.js';
```

### Optional follow-up: Update deep imports to use barrel

These files currently deep-import `SAFE_PATH_PATTERN` and could be updated to use the barrel instead:

- `src/web/schemas.ts` line 11: `import { SAFE_PATH_PATTERN } from '../utils/regex-patterns.js';` could become `import { SAFE_PATH_PATTERN } from '../utils/index.js';`
- `src/tmux-manager.ts` line 44: `import { SAFE_PATH_PATTERN } from './utils/regex-patterns.js';` could become part of existing barrel import

This is a low-priority cosmetic change. The barrel export itself is the important fix.

### Verification

```bash
tsc --noEmit
npm run lint
```

---

## Task 2: Delete Dead Utility Functions

**File**: `src/utils/string-similarity.ts`
**Time**: ~15 minutes

### Problem

Four exported functions in `string-similarity.ts` are never imported anywhere in the codebase:
- `levenshteinDistance()` (lines 27-69)
- `isSimilar()` (lines 106-108)
- `isSimilarByDistance()` (lines 123-125)
- `normalizePhrase()` (lines 139-144)

Only three functions are actually used (all by `ralph-tracker.ts` via the barrel):
- `stringSimilarity()` -- uses `levenshteinDistance()` internally
- `fuzzyPhraseMatch()` -- uses `normalizePhrase()` and `isSimilarByDistance()` internally
- `todoContentHash()`

### Strategy

`levenshteinDistance()` is called by `stringSimilarity()`, and `normalizePhrase()` and `isSimilarByDistance()` are called by `fuzzyPhraseMatch()`. So they cannot be deleted -- they just need to be un-exported (made private to the module).

`isSimilar()` is truly dead -- not called by anything. Delete it entirely.

### Edit 1: Remove `export` from `levenshteinDistance`

**File**: `src/utils/string-similarity.ts`

**Old code** (line 27):
```typescript
export function levenshteinDistance(a: string, b: string): number {
```

**New code**:
```typescript
function levenshteinDistance(a: string, b: string): number {
```

### Edit 2: Delete `isSimilar` function entirely

**File**: `src/utils/string-similarity.ts`

**Old code** (lines 94-108):
```typescript
/**
 * Check if two strings are similar within a given threshold.
 *
 * @param a - First string
 * @param b - Second string
 * @param threshold - Minimum similarity ratio (default: 0.85 = 85% similar)
 * @returns True if similarity >= threshold
 *
 * @example
 * isSimilar('COMPLETE', 'COMPLET', 0.85)  // true (87.5% similar)
 * isSimilar('COMPLETE', 'DONE', 0.85)     // false (0% similar)
 */
export function isSimilar(a: string, b: string, threshold = 0.85): boolean {
  return stringSimilarity(a, b) >= threshold;
}
```

**New code**: (delete entirely -- replace with empty string)

### Edit 3: Remove `export` from `isSimilarByDistance`

**File**: `src/utils/string-similarity.ts`

**Old code** (line 123):
```typescript
export function isSimilarByDistance(a: string, b: string, maxDistance = 2): boolean {
```

**New code**:
```typescript
function isSimilarByDistance(a: string, b: string, maxDistance = 2): boolean {
```

### Edit 4: Remove `export` from `normalizePhrase`

**File**: `src/utils/string-similarity.ts`

**Old code** (line 139):
```typescript
export function normalizePhrase(phrase: string): string {
```

**New code**:
```typescript
function normalizePhrase(phrase: string): string {
```

### Verification

```bash
tsc --noEmit
npx vitest run test/string-utilities.test.ts
npm run lint
```

Note: If `test/string-utilities.test.ts` imports any of the now-unexported functions, those test imports will fail. Check the test file and remove tests for `isSimilar` (deleted) and update any direct tests for `levenshteinDistance`, `isSimilarByDistance`, `normalizePhrase` to test them indirectly through the public API (`stringSimilarity`, `fuzzyPhraseMatch`), or remove those tests.

---

## Task 3: Consolidate Duplicated `EXEC_TIMEOUT_MS` Constant

**Files**:
- `src/utils/claude-cli-resolver.ts` (line 17)
- `src/utils/opencode-cli-resolver.ts` (line 16)
- `src/tmux-manager.ts` (line 63) -- also has its own copy

**Time**: ~15 minutes

### Problem

`EXEC_TIMEOUT_MS = 5000` is defined identically in three files. Changes need to happen in all three places.

### Strategy

Create a shared constant and export it. The natural home is a new config file since the existing config files (`buffer-limits.ts`, `map-limits.ts`) follow this pattern. However, to keep it minimal, we can add it to an existing config file or create a small one.

**Recommended approach**: Add to `src/config/timing-config.ts` (new file) as a single constant. This file can grow later in Phase 6 to hold other timing constants.

Alternatively, the simplest approach: export from one of the existing utils and import in the others. Since both CLI resolvers are in `src/utils/`, the cleanest approach is to put it in a shared location.

### Option A: Add to existing config (simpler)

Create `src/config/exec-timeout.ts`:

**New file**: `src/config/exec-timeout.ts`
```typescript
/**
 * Timeout for child process exec commands (e.g., `which claude`, `which opencode`, tmux commands).
 * Used across CLI resolvers and tmux manager.
 */
export const EXEC_TIMEOUT_MS = 5000;
```

### Edit 1: Update `claude-cli-resolver.ts`

**File**: `src/utils/claude-cli-resolver.ts`

**Old code** (lines 11-17):
```typescript
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Timeout for exec commands (5 seconds) */
const EXEC_TIMEOUT_MS = 5000;
```

**New code**:
```typescript
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
```

### Edit 2: Update `opencode-cli-resolver.ts`

**File**: `src/utils/opencode-cli-resolver.ts`

**Old code** (lines 10-16):
```typescript
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Timeout for exec commands (5 seconds) */
const EXEC_TIMEOUT_MS = 5000;
```

**New code**:
```typescript
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
```

### Edit 3: Update `tmux-manager.ts`

**File**: `src/tmux-manager.ts`

**Old code** (line 63):
```typescript
const EXEC_TIMEOUT_MS = 5000;
```

**New code**:
```typescript
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
```

Note: `tmux-manager.ts` already has many imports at the top of the file. Add this import near the other local imports (around lines 43-56). The `const EXEC_TIMEOUT_MS = 5000;` on line 63 should be deleted entirely (replaced with the import).

### Verification

```bash
tsc --noEmit
npm run lint
```

---

## Task 4: Add `z.infer` to Zod Schemas

**Files**:
- `src/web/schemas.ts` (add type exports)
- `src/types.ts` (replace manual interfaces with `z.infer` re-exports where applicable)

**Time**: ~2 hours

### Problem

All 30+ Zod schemas in `schemas.ts` define validation rules, but zero use `z.infer` to derive TypeScript types. Instead, `types.ts` manually duplicates interfaces that match the schemas. When a schema changes, the type must be manually updated too.

### Strategy

Add `z.infer` type exports to `schemas.ts` for each exported schema. This creates derived types as the single source of truth. For schemas that have corresponding manual interfaces in `types.ts`, the manual interface can be replaced with a re-export of the inferred type.

**Important**: Not all schemas have matching interfaces in `types.ts`. The `RespawnConfig` interface in `types.ts` (line 395) has all required fields, while `RespawnConfigSchema` has all optional fields (it's for partial updates). These are NOT the same type and should NOT be unified.

### Edit 1: Add inferred type exports to `schemas.ts`

**File**: `src/web/schemas.ts`

After each schema definition, add a corresponding type export. Add the following lines at the **end of the file** (after line 509):

**Old code** (end of file, lines 506-509):
```typescript
    .optional(),
});
```

Wait -- the end of file is actually at line 509 after the `RalphLoopStartSchema`. Add the type exports after the last schema:

**Append to end of file** `src/web/schemas.ts`:

```typescript

// ========== Inferred Types ==========
// Derive TypeScript types from Zod schemas (single source of truth)

export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;
export type RunPromptInput = z.infer<typeof RunPromptSchema>;
export type ResizeInput = z.infer<typeof ResizeSchema>;
export type CreateCaseInput = z.infer<typeof CreateCaseSchema>;
export type QuickStartInput = z.infer<typeof QuickStartSchema>;
export type HookEventInput = z.infer<typeof HookEventSchema>;
export type RespawnConfigInput = z.infer<typeof RespawnConfigSchema>;
export type ConfigUpdateInput = z.infer<typeof ConfigUpdateSchema>;
export type SettingsUpdateInput = z.infer<typeof SettingsUpdateSchema>;
export type SessionInputWithLimitInput = z.infer<typeof SessionInputWithLimitSchema>;
export type SessionNameInput = z.infer<typeof SessionNameSchema>;
export type SessionColorInput = z.infer<typeof SessionColorSchema>;
export type RalphConfigInput = z.infer<typeof RalphConfigSchema>;
export type FixPlanImportInput = z.infer<typeof FixPlanImportSchema>;
export type RalphPromptWriteInput = z.infer<typeof RalphPromptWriteSchema>;
export type AutoClearInput = z.infer<typeof AutoClearSchema>;
export type AutoCompactInput = z.infer<typeof AutoCompactSchema>;
export type ImageWatcherInput = z.infer<typeof ImageWatcherSchema>;
export type FlickerFilterInput = z.infer<typeof FlickerFilterSchema>;
export type QuickRunInput = z.infer<typeof QuickRunSchema>;
export type ScheduledRunInput = z.infer<typeof ScheduledRunSchema>;
export type LinkCaseInput = z.infer<typeof LinkCaseSchema>;
export type GeneratePlanInput = z.infer<typeof GeneratePlanSchema>;
export type GeneratePlanDetailedInput = z.infer<typeof GeneratePlanDetailedSchema>;
export type CancelPlanInput = z.infer<typeof CancelPlanSchema>;
export type PlanTaskUpdateInput = z.infer<typeof PlanTaskUpdateSchema>;
export type PlanTaskAddInput = z.infer<typeof PlanTaskAddSchema>;
export type CpuLimitInput = z.infer<typeof CpuLimitSchema>;
export type SubagentWindowStatesInput = z.infer<typeof SubagentWindowStatesSchema>;
export type SubagentParentMapInput = z.infer<typeof SubagentParentMapSchema>;
export type InteractiveRespawnInput = z.infer<typeof InteractiveRespawnSchema>;
export type RespawnEnableInput = z.infer<typeof RespawnEnableSchema>;
export type PushSubscribeInput = z.infer<typeof PushSubscribeSchema>;
export type PushPreferencesUpdateInput = z.infer<typeof PushPreferencesUpdateSchema>;
export type RalphLoopStartInput = z.infer<typeof RalphLoopStartSchema>;
```

### What NOT to do

Do NOT replace the `RespawnConfig` interface in `types.ts` with `z.infer<typeof RespawnConfigSchema>`. The schema has all optional fields (for partial config updates), but the interface has required fields (for the full config object). These are intentionally different shapes.

Similarly, do NOT try to unify every interface in `types.ts` with a schema -- most interfaces in `types.ts` represent internal domain objects (SessionState, TaskState, etc.) that have no corresponding Zod schema. The schemas only exist for API request validation.

### Future opportunity

In a future phase, route handlers in `server.ts` can use these inferred types for request body typing:
```typescript
const body = CreateSessionSchema.parse(request.body) as CreateSessionInput;
```
This task only adds the type exports. Migrating route handlers to use them is out of scope.

### Verification

```bash
tsc --noEmit
npm run lint
npm run format:check
```

---

## Task 5: Fix Weak `not.toThrow()` Tests with Behavioral Assertions

**Files**:
- `test/task-tracker.test.ts` -- 6 instances
- `test/image-watcher.test.ts` -- 1 instance
- `test/task-queue.test.ts` -- 1 instance
- `test/hooks-config.test.ts` -- 1 instance
- `test/session-manager.test.ts` -- 1 instance

**Time**: ~1 hour

### Problem

10 tests only assert `not.toThrow()` without verifying the actual defensive behavior. These tests prove the code doesn't crash but don't verify it does the right thing.

### Fix Strategy

After each `not.toThrow()`, add a behavioral assertion that verifies the state is correct (e.g., no tasks were created, no side effects occurred).

### Edit 1: `task-tracker.test.ts` -- null message (line 566)

**File**: `test/task-tracker.test.ts`

**Old code**:
```typescript
    it('should handle null message', () => {
      expect(() => tracker.processMessage(null)).not.toThrow();
    });
```

**New code**:
```typescript
    it('should handle null message', () => {
      expect(() => tracker.processMessage(null)).not.toThrow();
      expect(tracker.getAllTasks().size).toBe(0);
      expect(tracker.getRunningCount()).toBe(0);
    });
```

### Edit 2: `task-tracker.test.ts` -- message without content (line 569-571)

**File**: `test/task-tracker.test.ts`

**Old code**:
```typescript
    it('should handle message without content', () => {
      expect(() => tracker.processMessage({ message: {} })).not.toThrow();
    });
```

**New code**:
```typescript
    it('should handle message without content', () => {
      expect(() => tracker.processMessage({ message: {} })).not.toThrow();
      expect(tracker.getAllTasks().size).toBe(0);
    });
```

### Edit 3: `task-tracker.test.ts` -- empty content array (line 573-575)

**File**: `test/task-tracker.test.ts`

**Old code**:
```typescript
    it('should handle empty content array', () => {
      expect(() => tracker.processMessage({ message: { content: [] } })).not.toThrow();
    });
```

**New code**:
```typescript
    it('should handle empty content array', () => {
      expect(() => tracker.processMessage({ message: { content: [] } })).not.toThrow();
      expect(tracker.getAllTasks().size).toBe(0);
    });
```

### Edit 4: `task-tracker.test.ts` -- tool_result for unknown task (lines 577-590)

**File**: `test/task-tracker.test.ts`

**Old code**:
```typescript
    it('should handle tool_result for unknown task', () => {
      expect(() => {
        tracker.processMessage({
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'unknown-task',
              is_error: false,
              content: 'Done',
            }],
          },
        });
      }).not.toThrow();
    });
```

**New code**:
```typescript
    it('should handle tool_result for unknown task', () => {
      expect(() => {
        tracker.processMessage({
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'unknown-task',
              is_error: false,
              content: 'Done',
            }],
          },
        });
      }).not.toThrow();
      expect(tracker.getTask('unknown-task')).toBeUndefined();
      expect(tracker.getAllTasks().size).toBe(0);
    });
```

### Edit 5: `task-tracker.test.ts` -- empty terminal output (lines 592-595)

**File**: `test/task-tracker.test.ts`

**Old code**:
```typescript
    it('should handle empty terminal output', () => {
      expect(() => tracker.processTerminalOutput('')).not.toThrow();
      expect(() => tracker.processTerminalOutput('   ')).not.toThrow();
    });
```

**New code**:
```typescript
    it('should handle empty terminal output', () => {
      expect(() => tracker.processTerminalOutput('')).not.toThrow();
      expect(() => tracker.processTerminalOutput('   ')).not.toThrow();
      expect(tracker.getAllTasks().size).toBe(0);
      expect(tracker.getRunningCount()).toBe(0);
    });
```

### Edit 6: `image-watcher.test.ts` -- unwatchSession for non-watched session (line 123)

**File**: `test/image-watcher.test.ts`

**Old code**:
```typescript
    it('should be safe to call for non-watched session', () => {
      expect(() => watcher.unwatchSession('nonexistent')).not.toThrow();
    });
```

**New code**:
```typescript
    it('should be safe to call for non-watched session', () => {
      expect(() => watcher.unwatchSession('nonexistent')).not.toThrow();
      expect(watcher.getWatchedSessions()).toHaveLength(0);
    });
```

### Edit 7: `task-queue.test.ts` -- dependencies on non-existent tasks (lines 538-542)

**File**: `test/task-queue.test.ts`

**Old code**:
```typescript
  it('should allow dependencies on non-existent tasks (just unsatisfied, not a cycle)', () => {
    // Dependencies on non-existent tasks are valid - they just won't be satisfied
    expect(() => {
      queue.addTask({ prompt: 'Task D', dependencies: ['non-existent-id'] });
    }).not.toThrow();
  });
```

**New code**:
```typescript
  it('should allow dependencies on non-existent tasks (just unsatisfied, not a cycle)', () => {
    // Dependencies on non-existent tasks are valid - they just won't be satisfied
    let task: ReturnType<typeof queue.addTask> | undefined;
    expect(() => {
      task = queue.addTask({ prompt: 'Task D', dependencies: ['non-existent-id'] });
    }).not.toThrow();
    expect(task).toBeDefined();
    expect(task!.dependencies).toEqual(['non-existent-id']);
    // Task should be pending but blocked (dependency unsatisfied)
    expect(queue.next()?.prompt).toBeUndefined();
  });
```

Wait -- `queue.next()` returns `null` when no next task is available (all blocked). Let me adjust:

**New code** (corrected):
```typescript
  it('should allow dependencies on non-existent tasks (just unsatisfied, not a cycle)', () => {
    // Dependencies on non-existent tasks are valid - they just won't be satisfied
    let task: ReturnType<typeof queue.addTask> | undefined;
    expect(() => {
      task = queue.addTask({ prompt: 'Task D', dependencies: ['non-existent-id'] });
    }).not.toThrow();
    expect(task).toBeDefined();
    expect(task!.dependencies).toEqual(['non-existent-id']);
    // Task exists but is blocked (dependency unsatisfied), so next() skips it
    expect(queue.getAllTasks()).toHaveLength(1);
    expect(queue.next()).toBeNull();
  });
```

### Edit 8: `hooks-config.test.ts` -- valid JSON check (line 129)

**File**: `test/hooks-config.test.ts`

**Old code**:
```typescript
  it('should write valid JSON', () => {
    writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    const content = readFileSync(settingsPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });
```

**New code**:
```typescript
  it('should write valid JSON', () => {
    writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    const content = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
    expect(parsed.hooks).toBeDefined();
  });
```

### Edit 9: `session-manager.test.ts` -- stopSession for non-existent (line 216)

**File**: `test/session-manager.test.ts`

**Old code**:
```typescript
    it('should handle non-existent session gracefully', async () => {
      await expect(manager.stopSession('non-existent')).resolves.not.toThrow();
    });
```

**New code**:
```typescript
    it('should handle non-existent session gracefully', async () => {
      await expect(manager.stopSession('non-existent')).resolves.not.toThrow();
      expect(manager.getSessionCount()).toBe(0);
    });
```

### Verification

Run each test file individually:

```bash
npx vitest run test/task-tracker.test.ts
npx vitest run test/image-watcher.test.ts
npx vitest run test/task-queue.test.ts
npx vitest run test/hooks-config.test.ts
npx vitest run test/session-manager.test.ts
```

**Important**: `hooks-config.test.ts` and `session-manager.test.ts` spawn real servers on ports 3130-3131. Only run them if you are NOT running other tests that use those ports.

---

## Final Verification Checklist

After all 5 tasks are complete, run the following in order:

```bash
# 1. TypeScript type checking
tsc --noEmit

# 2. Linting
npm run lint

# 3. Formatting
npm run format:check

# 4. Run affected test files individually (NOT the full suite)
npx vitest run test/string-utilities.test.ts
npx vitest run test/task-tracker.test.ts
npx vitest run test/image-watcher.test.ts
npx vitest run test/task-queue.test.ts
npx vitest run test/session-manager.test.ts
npx vitest run test/hooks-config.test.ts
```

If any formatting issues arise, fix with:
```bash
npm run format
```

If any lint issues arise, fix with:
```bash
npm run lint:fix
```

### Summary of Changes

| Task | Files Modified | Files Created |
|------|---------------|---------------|
| 1. Barrel exports | `src/utils/index.ts` | -- |
| 2. Dead functions | `src/utils/string-similarity.ts` | -- |
| 3. EXEC_TIMEOUT_MS | `src/utils/claude-cli-resolver.ts`, `src/utils/opencode-cli-resolver.ts`, `src/tmux-manager.ts` | `src/config/exec-timeout.ts` |
| 4. z.infer types | `src/web/schemas.ts` | -- |
| 5. Weak tests | `test/task-tracker.test.ts`, `test/image-watcher.test.ts`, `test/task-queue.test.ts`, `test/hooks-config.test.ts`, `test/session-manager.test.ts` | -- |

**Total files modified**: 10
**Total files created**: 1
