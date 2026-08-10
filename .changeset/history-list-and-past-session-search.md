---
'aicodeman': patch
---

Home screen: make the past-conversation list usable, and let search find past sessions.

- **#260**: "Resume Conversation" showed 4 rows and then dumped every remaining
  one into a fixed 240px box, with no ordering or filtering. The list now opens
  with 10 rows, "Show more"/"Show less" grows and shrinks the box itself (the
  height cap is class-driven instead of fixed), and the header carries a filter
  box (matches name, folder, `#case` label and the conversation's prompts), a
  sort control (recent / name A–Z / folder A–Z, pinned rows still first) and a
  shown-of-total count. Filtering implies expansion, so every match is visible.
- **#261**: the search box could not match a past project by folder name: its
  session corpus was the live in-memory map, while past sessions come from
  `/api/sessions/unified`. Search now also harvests a bounded snapshot of that
  unified list, refreshed OUTSIDE the request path (published by
  `/api/sessions/unified`, plus a fire-and-forget rebuild when stale), so the
  search path keeps its no-filesystem-reads property. Results for a closed
  session resume the conversation instead of trying to select a tab that no
  longer exists, and are badged `RESUME`. In multi-user mode the snapshot is
  re-scoped per row on read, matching what `/api/sessions/unified` exposes.

Reported by @jordan8037310.
