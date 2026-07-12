# Claude Code Build Brief: Add Scheduling to Codeman

## 0. Purpose of This Brief

You are Claude Code working inside the Codeman repository.

Your task is to add a **small, reliable scheduling layer** to Codeman while preserving Codeman's existing architecture and session-management behavior.

This is not a greenfield rewrite. This is not a full product rebuild. This is a focused extension.

The target user wants Codeman-like tmux/web/session management, but with first-class scheduled jobs for Claude, Codex, OpenCode, Terminal, or any other configurable coding-agent harness.

---

## 1. Non-Negotiable Goal

Add scheduling to Codeman so a user can define a scheduled coding-agent job that:

1. Has a name.
2. Uses an existing Codeman-supported agent/session type where possible.
3. Has a working directory.
4. Has a prompt or prompt file.
5. Has a schedule.
6. Can be enabled or disabled.
7. Can be manually run now.
8. When due, creates a Codeman/tmux session.
9. Sends the configured prompt into that session.
10. Records last run, next run, status, and run history.

The first working version should prioritize **scheduling correctness and reuse of Codeman's existing tmux/session system** over UI polish.

---

## 2. Core Architectural Rule

Do **not** rebuild Codeman's session layer.

Reuse existing Codeman functionality for:

- Creating sessions.
- Naming sessions.
- Launching Claude/Codex/OpenCode/Terminal sessions.
- Sending input into sessions.
- Displaying sessions in the web UI.
- Killing sessions.
- Tracking session status if already supported.

If an internal API/service/function already exists, reuse it.

If no reusable function exists, create a thin wrapper around the existing implementation rather than duplicating logic.

---

## 3. Product Boundary

This build is **Codeman + Scheduler**.

It is not yet:

- A full quota engine.
- A full lock manager.
- A replacement for Codeman's terminal UI.
- A new FastAPI application.
- A multi-tenant SaaS platform.
- A complex cron-management product.
- A full agent autonomy framework.

Keep the build small and shippable.

---

## 4. Required Working Scope for v0.1

Implement the following minimum features.

### 4.1 Scheduled Jobs List

Create a UI page showing all scheduled jobs.

Each row/card should show:

- Job name.
- Agent/session type.
- Working directory.
- Schedule type.
- Enabled/disabled state.
- Last run time.
- Next run time.
- Last run status.
- Actions:
  - Run Now.
  - Enable/Disable.
  - Edit.
  - Delete.

### 4.2 Create/Edit Scheduled Job

Create a form for scheduled jobs with these fields:

- `name`
- `agent_type`
  - Reuse Codeman's existing session/agent types where possible.
  - Include at least Terminal/custom command if supported.
- `working_directory`
- `launch_command` if needed by Codeman's model.
- `prompt_mode`
  - `inline_text`
  - `prompt_file_path`
- `prompt_text`
- `prompt_file_path`
- `input_mode`
  - `paste`
  - `typed`
- `schedule_type`
  - `once`
  - `interval_minutes`
  - `daily_time`
  - `weekly_time`
- `run_at` for one-time jobs.
- `interval_minutes` for interval jobs.
- `daily_time` for daily jobs.
- `weekly_days` and `weekly_time` for weekly jobs.
- `enabled`
- `notes` optional.

Do not build a complex visual cron editor in v0.1.

### 4.3 Run Now

Every scheduled job must support a `Run Now` action.

Run Now should:

1. Create a new session through Codeman's existing session creation logic.
2. Send the configured prompt into the session using Codeman's existing input mechanism.
3. Create a run-history record.
4. Update last-run fields.
5. Redirect or link the user to the created Codeman session.

### 4.4 Background Scheduler Loop

Add a small background scheduler loop that runs inside the Codeman backend process.

The loop should:

1. Wake every 15-60 seconds.
2. Load enabled schedules.
3. Find schedules where `next_run_at <= now`.
4. Create a scheduled run.
5. Launch the session using existing Codeman session logic.
6. Send the prompt.
7. Record run history.
8. Compute the next run time.
9. Avoid duplicate launches if the loop overlaps or restarts.

Keep this simple and robust.

### 4.5 Run History

Every scheduled execution should create a run-history record.

Track:

- `id`
- `scheduled_job_id`
- `session_id` or Codeman session reference.
- `session_name` if applicable.
- `started_at`
- `finished_at` optional.
- `status`
  - `created`
  - `session_started`
  - `prompt_sent`
  - `failed`
- `error_message` optional.
- `trigger_type`
  - `scheduled`
  - `manual_run_now`
- `created_session_url` or route reference if easy.

---

## 5. Scheduling Rules

### 5.1 Once

Run at a specific date/time.

After successful launch:

- Set `enabled = false`, or mark as completed.

### 5.2 Interval

Run every N minutes.

Example:

- Every 60 minutes.
- Every 240 minutes.

After launch:

- `next_run_at = now + interval_minutes`.

### 5.3 Daily

Run every day at HH:MM.

After launch:

- Compute the next occurrence of HH:MM after now.

### 5.4 Weekly

Run on selected weekdays at HH:MM.

After launch:

- Compute the next selected weekday/time after now.

### 5.5 Timezone

Use the server's local timezone for v0.1 unless Codeman already has timezone handling.

Add a visible note in the UI:

> Times use the server's local timezone.

Do not overbuild timezone support in v0.1.

---

## 6. Data Storage Decision

First inspect Codeman's existing persistence model.

If Codeman already has a database or persistence layer:

- Reuse it.
- Add scheduled job and scheduled run models/tables/records using the existing pattern.

If Codeman uses files or JSON state:

- Use the same style for v0.1.
- Prefer simple persistence over introducing a heavy new dependency.

If there is no appropriate persistence layer:

- Add SQLite only if it fits the codebase cleanly.
- Otherwise use a JSON file store for the first version.

Do not introduce Postgres, Redis, Celery, or a separate scheduler service.

---

## 7. Concurrency and Duplicate-Run Guard

Implement a basic duplicate-run guard.

A schedule should not launch twice for the same due time.

Minimum acceptable approach:

- Before launching, create/update a run record with a `created` or `launching` state.
- Use a schedule-level `last_triggered_at` or `last_due_key` to avoid double launching.
- If launch fails, record failure clearly.

Do not build distributed locks. Codeman is expected to be local/single-instance for v0.1.

---

## 8. Multi-Session Warning

When the user clicks `Run Now`, show a warning if there are already active sessions for the same agent type.

Minimum behavior:

- If active sessions exist, show a confirmation warning.
- User can continue anyway.

For scheduled automatic runs:

- Add a setting on the scheduled job:
  - `warn_only`
  - `skip_if_same_agent_running`

Default:

- `warn_only` for manual runs.
- `skip_if_same_agent_running = false` for automatic runs unless easy to implement.

Do not build a complete quota engine in v0.1.

---

## 9. Prompt Sending Rules

The scheduler must support sending the configured prompt into the created session.

Prompt source:

1. Inline prompt text.
2. Prompt file path.

Input mode:

1. Paste mode.
2. Typed mode.

If only one input mode is easy with Codeman's current internals, implement that first and structure the code so the other can be added later.

Important:

- Do not send prompts to a session if session creation failed.
- Record prompt-send success/failure in run history.
- Save enough metadata to understand what prompt was used.

---

## 10. UI Bifurcation

Keep UI changes cleanly separated.

Add scheduler UI under a clear navigation item:

- `Scheduled Jobs`

Do not clutter the existing session dashboard.

The existing session dashboard may show sessions created by scheduled jobs, but the scheduling controls should live in their own section.

Recommended pages/routes:

- `/schedules`
- `/schedules/new`
- `/schedules/:id`
- `/schedules/:id/edit`
- `/schedules/:id/run-now`
- `/schedules/:id/enable`
- `/schedules/:id/disable`
- `/schedules/:id/delete`

Use Codeman's existing frontend conventions and routing style.

---

## 11. Backend Bifurcation

Keep scheduler code separate from existing session code.

Recommended logical modules, adapted to Codeman's actual structure:

- `scheduler/model` or equivalent.
- `scheduler/store` or equivalent.
- `scheduler/service` for schedule calculations and launch logic.
- `scheduler/loop` for the background due-job checker.
- `scheduler/routes` for API/UI endpoints.
- `scheduler/time` for next-run calculations.

Do not mix scheduling logic directly into terminal rendering, xterm handling, or low-level tmux code.

The scheduler service should call session services; it should not own tmux directly unless Codeman has no session abstraction.

---

## 12. Required Discovery Phase Before Coding

Before implementing, inspect the Codeman repo and produce a short architecture note in the terminal or in a file called:

`docs/cron-discovery.md`

This note must identify:

1. Where session creation happens.
2. Where agent/session types are defined.
3. Where input is sent into a session.
4. Where active sessions are listed.
5. Where session kill/delete is handled.
6. How session state is stored.
7. Whether there is existing persistence.
8. Where backend routes live.
9. Where frontend pages/components live.
10. The smallest integration points for scheduling.

Do not start coding until this discovery is complete.

---

## 13. Implementation Phases

### Phase 1: Discovery

Deliverable:

- `docs/cron-discovery.md`

Must answer the 10 discovery questions above.

### Phase 2: Data Model / Persistence

Deliverable:

- Scheduled job persistence.
- Scheduled run history persistence.
- Basic create/read/update/delete operations.

### Phase 3: Scheduler Calculation Logic

Deliverable:

- Functions to compute `next_run_at` for:
  - once
  - interval
  - daily
  - weekly

Add tests if the repo has an existing test setup.

### Phase 4: Manual Run Now

Deliverable:

- Create scheduled job.
- Click Run Now.
- Codeman session is created.
- Prompt is sent.
- Run history is recorded.
- UI links to the session.

This is the most important milestone.

### Phase 5: Background Scheduler Loop

Deliverable:

- Enabled schedules launch automatically when due.
- Run history is recorded.
- `last_run_at` and `next_run_at` update.
- Duplicate launch guard exists.

### Phase 6: UI Polish Only After Functionality

Deliverable:

- Scheduled jobs list is readable.
- Create/edit form is usable.
- Status labels are clear.
- Errors are visible.

Do not polish before Phase 4 works.

---

## 14. Acceptance Criteria

The build is acceptable when all these pass.

### Manual Run

1. Create a schedule/job with inline prompt.
2. Click Run Now.
3. A new Codeman/tmux session starts.
4. Prompt is sent into that session.
5. The created session is visible in Codeman's normal session UI.
6. Run history shows success or failure.

### One-Time Schedule

1. Create a one-time schedule 2 minutes in the future.
2. Wait for it to become due.
3. Scheduler launches a session.
4. Prompt is sent.
5. Schedule does not repeatedly launch forever.

### Interval Schedule

1. Create interval schedule every 2 minutes.
2. It launches once when due.
3. It computes the next due time.
4. It does not launch duplicates for the same due time.

### Daily Schedule

1. Create daily schedule at a time a few minutes ahead.
2. It launches when due.
3. Next run becomes tomorrow at the same time.

### Disable Schedule

1. Disable a schedule.
2. It does not launch even when due.

### Error Handling

1. Invalid working directory produces visible error.
2. Invalid prompt file produces visible error.
3. Failed session launch creates failed run-history entry.

---

## 15. Explicitly Out of Scope for v0.1

Do not implement these unless all required scope is already working:

- Full quota engine.
- Advanced lock manager.
- Post-run git inspection reports.
- Complex recurring calendar UI.
- User accounts / RBAC.
- External distributed workers.
- Redis.
- Postgres.
- Celery.
- Kubernetes.
- A separate Python service.
- Full visual cron editor.
- AI-generated follow-up prompts.
- Automatic continuation after idle.
- Any attempt to bypass agent quotas or platform limits.

---

## 16. Quality Rules

Follow these rules while coding:

1. Reuse existing Codeman services and conventions.
2. Keep scheduler code isolated.
3. Prefer boring, readable code over clever abstractions.
4. Add error messages that a human can understand.
5. Do not break existing Codeman sessions.
6. Do not rename existing core concepts unnecessarily.
7. Do not introduce large dependencies without strong reason.
8. Keep v0.1 local-first and single-instance.
9. Commit in logical chunks if git is available.
10. After coding, provide a final implementation summary.

---

## 17. Final Response Required from Claude Code

At the end, report:

1. Files changed.
2. New routes/pages added.
3. New data structures added.
4. How the scheduler loop works.
5. How to run the app.
6. How to test manual Run Now.
7. How to test scheduled execution.
8. Known limitations.
9. Suggested v0.2 improvements.

---

## 18. v0.2 Ideas, Not for Current Build

Keep these in mind but do not build unless v0.1 is complete:

- Quota-aware scheduling.
- Manual takeover locks.
- Post-idle inspection.
- Git diff reports.
- Schedule groups.
- Prompt templates.
- Agent-specific concurrency rules.
- Better timezone support.
- Audit events.
- More advanced cron expressions.

---

## 19. Final Reminder

The goal is to add **scheduling** to Codeman quickly and cleanly.

Do not drift into building a new platform.

The highest-priority path is:

1. Discover existing Codeman integration points.
2. Add scheduled job persistence.
3. Add Run Now.
4. Add background due-job loop.
5. Add minimal UI.
6. Verify that scheduled jobs create real Codeman/tmux sessions and send prompts.

