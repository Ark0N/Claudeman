---
"aicodeman": patch
---

Vertical tab rail: detailed rows, and a rename cancel that no longer wipes the name.

The vertical rail (Tab Orientation → Vertical) now draws the same per-session
line the home screen and the rich sidebar draw — when the session was created,
how long it has been in the state it is in, the folder it runs in, and a status
pill — instead of just the name. New per-device setting **Vertical Rail Rows**
(`tabRailDetail`, App Settings → Appearance → Tabs) with `Detailed` as the
default and `Simple (name only)` as the opt-out. A rail that has never been
sized now opens at 320px (the existing Wide preset) so the line fits; a narrower
rail sheds the created stamp below 288px and falls back to simple rows below
240px.

Also fixes a data-loss bug in the inline tab rename that predates the rail:
pressing Escape cleared the input and blurred it, and the blur handler commits —
so cancelling a rename stored an EMPTY session name and the tab fell back to its
folder label. Escape now cancels without a request, in every layout.
