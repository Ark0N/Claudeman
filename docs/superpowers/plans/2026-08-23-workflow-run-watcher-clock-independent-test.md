# Workflow Run Watcher Clock-Independent Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `workflow-run-watcher.test.ts` from expiring as wall-clock time advances.

**Architecture:** Keep production code unchanged. Anchor every synthetic workflow timestamp to one captured current
time while preserving the fixture's existing event offsets, then verify the recent-summary assertion against the
real watcher.

**Tech Stack:** TypeScript, Vitest, Node.js

---

### Task 1: Make the completed-run fixture relative to test time

**Files:**

- Modify: `test/workflow-run-watcher.test.ts:17-100`

- [x] **Step 1: Confirm the fixed fixture fails after its recent window expires**

Run:

```bash
npm test -- test/workflow-run-watcher.test.ts
```

Expected: FAIL in `getRecentRunSummaries omits agents[] (lightweight snapshot)` because `summaries` is empty.

- [x] **Step 2: Anchor the fixture to the current test time**

At the start of `sampleRunJson()`, capture a start time fifteen minutes before the call:

```typescript
const startTime = Date.now() - 15 * 60_000;
```

Replace the fixed ISO timestamp with `new Date(startTime).toISOString()`, replace the fixed `startTime` property
with the variable, and express each workflow agent's `startedAt`, `queuedAt`, and `lastProgressAt` as its existing
millisecond offset from `startTime`.

- [x] **Step 3: Verify the focused test passes**

Run:

```bash
npm test -- test/workflow-run-watcher.test.ts
```

Expected: 19 tests pass with no failures.

- [x] **Step 4: Verify formatting and the CI gate**

Run:

```bash
npx prettier --check test/workflow-run-watcher.test.ts
npm run test:ci
```

Expected: formatting passes and the CI unit/integration suite has no failures.

- [x] **Step 5: Commit the correction**

```bash
git add test/workflow-run-watcher.test.ts docs/superpowers/plans/2026-08-23-workflow-run-watcher-clock-independent-test.md
git commit -m "test(workflows): keep recent-run fixture clock-independent"
```
