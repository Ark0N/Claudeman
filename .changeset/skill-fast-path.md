---
'aicodeman': patch
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
  already blocks on the composer) and the hooks check for cases `quick-start` creates,
  which always carry hooks. That check is still required for linked cases and raw paths,
  where its absence silently breaks send-and-wait.
- The bootstrap's write condition now greps the version stamp, so a stale or truncated
  preamble file self-heals instead of failing and asking you to `rm` it by hand.
- §5 moved to `reference/verbs.md`, leaving an index. SKILL.md is the only part paid on
  every load and drops from ~16.4k to ~7.6k tokens; section numbers and anchors are
  unchanged, so existing `§5.x` references still resolve.
