---
"aicodeman": patch
---

fix(mobile): give the Add Case modal a reachable submit button

`mobile.css` hides `#createCaseModal`'s `.set-foot` on phones, and unlike the Settings
modal that header carries no `set-head-save` — so the Create/Link button existed nowhere
on a phone and the modal could not be submitted at all. Adds the header button and drives
both together, so whichever one is pressed the other shows the same pending state and is
equally unclickable.

Add Case follows the Settings modal's header-save pattern, so it picks up the existing
`.set-head-actions:has(.set-head-save)` tray and `.set-head-save` sizing below 860px with no
new CSS; the `mobile.css` comment that still listed Add Case as a lone-× sheet is updated to
match.
