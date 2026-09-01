---
"aicodeman": patch
---

fix(web): render one Claude response-viewer message per model message

The Claude reader concatenated every assistant row between two human prompts into one
card, fusing up to 74 distinct model messages into a single card, and it never read the
attachment rows that hold a prompt typed while the agent was working. Measured over 57
real transcripts on 2026-09-01, the viewer now shows 1,806 messages instead of 356 and
353 user cards instead of 178, recovering the user's own words from 162 absorbed
prompts, with the assistant text sequence unchanged row for row and the response without
`?context=full` byte-identical on all 57 files. A same-speaker run inside one turn
renders as continuation segments under one badge, and the header reports turns as well
as messages instead of claiming a 1,566-row session was "6 messages".
