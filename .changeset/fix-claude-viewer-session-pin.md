---
'aicodeman': patch
---

fix(web): stop the Claude response viewer from following another session's conversation

The viewer re-derived a pane's live conversation by taking the newest
`~/.claude/history.jsonl` entry for the pane's cwd. A cwd is shared with every
other Codeman tab on it, with tabs long since closed, and with any plain
`claude` run in the user's own terminal, so the eye followed whichever of those
was typed into last — and the adoption was written back to the session, so the
mispin persisted. Entries are now credited to a pane only when they land within
10s of that pane's own Enter and no other pane on the cwd submitted closer, the
same last-submit correlation the Codex locator already uses.
