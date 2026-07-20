---
"aicodeman": patch
---

fix(web): normalize Claude response viewer conversations

Reconnect recovered tmux placeholders to their Claude transcript, filter synthetic
Claude rows, merge multi-block assistant turns, and remove replayed snapshots so
the response viewer shows one clean card per real conversation turn.
