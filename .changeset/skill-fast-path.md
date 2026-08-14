---
'aicodeman': minor
---

Make the `codeman` agent skill spawn workers fast instead of deliberating first.

Measured against a live server, the API does the whole job (spawn two claude workers,
task them, read both answers) in about 10 seconds, so the delay users saw was
agent-side: the skill taught serial spawning, made the happy path something to
reassemble from five sections on every run, and cost ~16k tokens of mostly failure
modes before the first call.

- The §0 preamble now defines the verbs instead of describing them: `spawn_worker`,
  `spawn_workers` (concurrent), `sendwait` and `last_text`. §1 composes them into the
  whole job in one Bash call, and says to stop reading there.
- Dropped two ceremonies the measurements retired: the pid-poll loop (`wait-output`
  already blocks on the composer) and the agent-driven hooks check, which is now folded
  into `spawn_worker` itself as a single local grep of the resolved `casePath`, so a
  name that resolves to a linked case or a hook-less pre-existing directory is refused
  instead of silently running the job there. Linked cases and raw paths still require
  the by-hand check, where its absence silently breaks send-and-wait.
- The bootstrap's write condition now greps the version stamp, so a stale or truncated
  preamble file self-heals instead of failing and asking you to `rm` it by hand.
- `sendwait` picks a fresh `seq` per call (a fixed default made every second prompt to
  the same worker a silently-swallowed duplicate) and self-heals stranded delivery: an
  Ink repaint occasionally eats the Enter, leaving the prompt typed but unsubmitted
  (observed live), so a timed-out first wait sends one bare `\r` and re-waits by
  resending the identical frame as a tagged duplicate.
- §5 moved to `reference/verbs.md`, leaving an index. SKILL.md is the only part paid on
  every load and drops from ~16.4k to roughly 9k tokens (~35KB); section numbers and
  anchors are unchanged, so existing `§5.x` references still resolve.
