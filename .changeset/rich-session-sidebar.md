---
'aicodeman': patch
---

Session List Layout gains a third option, "Left sidebar", whose rows carry the same per-session detail the home screen shows.

The sidebar previously had one row style: a name and a folder. That is the whole story a tab can tell, but a docked column is not a tab strip — it has width to spare and a row per session either way, and the information that was missing is exactly the information the desktop home rail and the phone overview already put on screen. So the new option lifts it onto the rows: when the session was first created, how long it has been in the state it is in, and a status pill naming that state.

- The old "Left sidebar" is now **"Left sidebar simple"** and is unchanged, down to the byte — the stored value stays `sidebar`, so anyone already using it keeps exactly the layout they chose. The new option is `sidebar-rich`.
- Both sidebar values are the SAME layout and both set `data-session-list="sidebar"`; row detail rides on a separate `data-sidebar-detail` attribute. That is deliberate: every `isSessionSidebarActive()` call site and every `html[data-session-list="sidebar"]` rule in styles.css and mobile.css keeps matching both, untouched.
- Which state a session is in, and which stamp measures it, come from `_mobileOverviewState()` / `_mobileOverviewSince()` rather than being re-derived — the sidebar, the home rail and the phone overview cannot disagree about what "working" means. A working row is measured from the turn's last Enter, not from its last repaint, so a running turn reads `working 12m` instead of `0m`.
- The stamps refresh in place on a 20s clock instead of re-rendering: a rebuild would restart every load spinner and alert animation in the list, twice a minute. The clock only runs while rich rows are on screen.
- The column widens to 300px for the extra line, and the collapsed 44px rail and the handheld drawer are explicitly held back from that width.
