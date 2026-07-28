# File Viewer

The File Viewer is a session-scoped repository browser for files, current Git
changes, and commit history. Its browser UI lives in
`src/web/public/panels-ui.js`; file and repository HTTP routes live in
`src/web/routes/file-routes.ts`; Git command/parsing logic lives in
`src/git-repository-browser.ts`.

## Views

- **Files** lists the selected scope's directory tree and opens the existing
  file preview for text, images, audio/video, PDF, SVG, and Office documents.
- **Changes** lists the selected worktree's current staged, unstaged, and
  untracked paths. It refreshes every five seconds only while the panel and
  Changes tab are visible.
- **History** lists the latest 30 commits. Expanding a commit lazily loads its
  changed paths; selecting a path lazily loads that file's patch and snapshots.
- **Compact diff** renders unified-diff hunks. **Full diff** renders the whole
  after-file, highlights additions, and inserts deleted hunk rows at their
  corresponding anchors. Deleted files use the before-file.

## Session And Worktree Scope

The selected session remains the ownership boundary. For a Git-backed session:

1. `git rev-parse --show-toplevel` maps a nested `session.workingDir` to the
   current worktree root.
2. `git worktree list --porcelain -z` discovers the main repository worktree
   and its linked worktrees.
3. The File Viewer defaults to the selected session's current worktree root.
   The selector exposes the main/root worktree and every linked worktree.
4. The browser sends only a short scope ID. On every scoped request, the server
   rediscovers the repository and accepts the ID only when it exactly matches a
   current worktree entry.

For a non-Git session, `scope=current` falls back to `session.workingDir` and
Changes/History report that Git is unavailable.

On startup, tmux recovery reads `#{pane_current_path}` with the pane PID. Newly
discovered local sessions use that path instead of the Codeman server's process
directory. Local metadata written by the older process-directory fallback is
self-healed when the saved path still equals `process.cwd()`. Tracked remote and
Docker sessions retain their persisted execution metadata.

The pencil action in the File Viewer header lets the user synchronize an
already-running local session with a different host work path. Applying it
updates `Session.workingDir`, mux recovery metadata, Bash path resolution,
Ralph's plan watcher, image watching, and persisted/SSE session state. It does
not change the cwd of the running child process. Remote and Docker sessions are
excluded because a host-only metadata edit cannot coherently change their
execution roots.

Unscoped file URLs retain the original `session.workingDir` confinement. This
is load-bearing for attachments and existing API consumers: repository
discovery must not silently broaden every session file route.

## HTTP API

All routes require access to the owning session through `findSessionOrFail`.

| Route                                                                   | Purpose                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| `PUT /api/sessions/:id/working-directory`                               | Synchronize a local session's host work path   |
| `GET /api/sessions/:id/repository?scope=`                               | Worktrees, current changes, recent commits     |
| `GET /api/sessions/:id/repository/commit?scope=&commit=`                | One commit and its changed paths               |
| `GET /api/sessions/:id/repository/diff?scope=&path=&commit=`            | Lazy patch plus bounded before/after snapshots |
| `GET /api/sessions/:id/files?...&scope=`                                | Directory tree rooted at a validated worktree  |
| `GET /api/sessions/:id/file-{content,raw,preview,thumbnail}?...&scope=` | Existing preview routes in that same scope     |

Git is executed with `spawn()` argument arrays, no shell, optional locks
disabled, a ten-second timeout, and bounded stdout/stderr. Patches are capped at
2 MiB and marked truncated. Before/after text snapshots are capped at 1 MiB;
binary files are detected before decoding. File paths are normalized, confined
to the selected worktree, and realpath-checked before working-tree reads.

Git status uses porcelain v2 with NUL delimiters and explicit rename detection.
Git still models an unstaged delete plus an untracked destination as separate
changes; it can report a rename once the move exists in the index. Do not add
client-side filename/similarity guessing.

## Client Lifecycle

`loadFileBrowser()` owns an `AbortController` and monotonically increasing
generation. A response may paint only when its generation, session ID, and
active tab still match. This prevents a slower previous session from replacing
the selected session's tree or repository state.

Switching sessions synchronously changes File Viewer ownership and resets scope
to `current` before terminal resize/history loading begins. An open viewer
starts loading the new repository immediately; a closed viewer invalidates its
old repository state without issuing a request. Reopening then loads the active
session. The selected Files/Changes/History view is preserved. Manual refresh
preserves filters and expanded folders. Closing the panel aborts its request
and stops repository polling.

A successful work-path edit and a work-path change received through
`session:updated` use the same forced invalidation. The selected scope resets to
`current`, in-flight requests are aborted, and an open viewer reloads once.

On phones, the opt-in File Viewer header button remains available and opens a
safe-area-aware bottom sheet. Diff preview uses the full visual viewport.

## Focused Tests

- `test/git-repository-browser.test.ts`: real temporary repository and linked
  worktree, nested discovery, status/history/diffs, rename parsing, and scope
  traversal rejection.
- `test/routes/file-routes-repository.test.ts`: session route ownership and
  scoped-vs-legacy file access.
- `test/mobile/file-viewer.test.ts`: stale tab-switch response rejection,
  worktree selector defaults, Changes and History interactions, compact/full
  diff rendering, and phone viewport bounds.
