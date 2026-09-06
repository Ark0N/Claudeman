---
"aicodeman": patch
---

fix(session): learn the live Claude conversation from the CLI's own hook

Which conversation a pane is on was re-derived by correlating `~/.claude/history.jsonl`
against `Session.lastSubmitAt` — and `lastSubmitAt` is bumped only by input that flows
through Codeman's own write path. A user who attaches to the pane's tmux session directly
never set it, so the resolver returned at its first line for that pane's whole life and the
response viewer stayed pinned to the launch conversation, showing a pre-`/clear` transcript
indefinitely. A new `UserPromptSubmit` hook reports the live conversation id from inside the
CLI process, addressed by the pane's own `$CODEMAN_SESSION_ID`, so the id is a fact rather
than a correlation: it never consults the working directory and cannot be claimed by a
sibling pane on the same folder. A pane with such an id now skips the correlation entirely,
which strictly reduces the number of prompts eligible for cwd-based guessing. The hook also
stamps `lastSubmitAt`, so it finally means "a prompt was submitted" rather than "typed into
Codeman's web terminal". Conversations vouched for this way are persisted as a chain, whose
tail re-pins the conversation when a surviving tmux session is re-attached after a restart —
`start()` otherwise resets the id back to the launch conversation. Existing workspaces heal
on their next Claude spawn via the hooks staleness sweep. The hook's stdout is discarded with curl's own `-o /dev/null`:
Claude Code injects `UserPromptSubmit` output into the model's context, so an undiscarded
curl would paste the API envelope into the user's own prompt on every turn.
