# Workflow Run Watcher Clock-Independent Test Design

## Problem

`getRecentRunSummaries omits agents[] (lightweight snapshot)` uses a workflow fixture whose activity timestamps
are fixed in June 2026. The test requests a 100,000-minute recent window, so it began failing once wall-clock time
moved beyond that window even though the implementation had not changed.

## Design

Keep production code unchanged. Build the synthetic run from one captured `Date.now()` value and express its
timestamp, start time, queue times, progress times, and completion times as offsets from that value. Preserve the
existing ordering and duration relationships between workflow events, so the fixture remains representative while
its completed run always falls within the test's recent window.

Do not widen the window or replace `getRecentRunSummaries()` with an unfiltered API: either choice would weaken or
eventually reintroduce the regression. Do not install fake timers, because the watcher uses asynchronous discovery
and timer behavior that this assertion does not need to control.

## Verification

- Confirm the existing fixed fixture fails because the run falls outside the recent window.
- Run `test/workflow-run-watcher.test.ts` after converting the fixture to relative timestamps.
- Run formatting and the CI unit/integration gate before pushing the updated PR.
