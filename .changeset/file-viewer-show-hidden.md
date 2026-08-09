---
'aicodeman': patch
---

The File Viewer can show hidden files and folders.

`GET /api/sessions/:id/files` has always accepted `showHidden=true`, but the panel
hardcoded `showHidden=false`, so dot-prefixed entries were unreachable from the
tree: no `.gitignore`, no `.github/`, no `.env.example`, and nothing under them.
Opening one meant guessing its path.

The panel header gains a `.*` toggle. It re-fetches rather than re-rendering the
cached tree, because the filtering happens server-side, and it keeps the expanded
directories so toggling does not collapse the tree you just navigated. The state
is per-device (its own `codeman:fileBrowserShowHidden` key rather than the
app-settings object, which is rebuilt from the settings-modal DOM on save and
would drop a key toggled from outside it), defaults to OFF, and survives a reload.

Generated and version-control directories (`.git`, `node_modules`, `.next`,
`.venv`, ...) stay excluded either way: that list is about tree size, not about
hiding dotfiles.

Closes #221.
