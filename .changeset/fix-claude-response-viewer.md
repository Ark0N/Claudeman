---
'aicodeman': patch
---

Normalize Claude conversations in the response viewer. A Claude transcript is an append-only event log, so one logical exchange spans many JSONL rows: tool-result rows, meta/image/skill rows, compact summaries, task and team notifications, sidechains, replayed assistant snapshots, and multi-block assistant output. The viewer rendered a card per row, which produced duplicate and truncated cards that read as lost responses. Cards are now built at real human-turn boundaries, replayed assistant snapshots are deduplicated, and sidechain rows (which belong to subagents, not the main conversation) no longer leak in. An identical prompt that legitimately recurs after an assistant reply is still kept as its own turn.

Measured over 40 real transcripts: 3108 cards became 621, duplicate cards dropped from 74 to 8 (all of them genuinely repeated turns), no assistant text was lost, and the non-`context=full` last-response text was byte-identical on every file.

Also rebinds recovered sessions to their transcript. `reconcileSessions()` can recover a lost mux session as a `restored-<uuid8>` placeholder with a stale working directory, which made transcript lookup by cwd find nothing. The placeholder still carries the first eight characters of the conversation UUID, so the viewer now rebinds to the matching top-level transcript when exactly one candidate matches.
