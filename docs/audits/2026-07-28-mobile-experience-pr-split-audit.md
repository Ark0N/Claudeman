# Mobile Experience Change-Set Audit

**Date:** 2026-07-28  
**Scope:** `origin/master..agent/mobile-terminal-experience` plus the pending terminal input controller extraction  
**Mode:** Full, with architecture, code-quality, and test specialists  
**Size:** 112 tracked and pending files, 43 existing commits, approximately 21,000 added lines before audit commits

## Assessment

The combined branch is not reviewable as one pull request. It mixes terminal
transport, mobile controls, destructive instance management, Git-backed file
browsing, hook configuration, case management, and unrelated settings. The
features should be rebuilt from `origin/master` and published as independent
draft pull requests.

| Severity | Count | Status |
| --- | ---: | --- |
| Critical | 4 | Fixed in the audited working tree |
| High | 5 | Four fixed; CI coverage split remains follow-up work |
| Medium | 6 | Three fixed; remaining gaps are documented per PR |

## Blocking Findings

### Passwordless remote shutdown

`src/web/routes/system-routes.ts:144` relied on `requireAdmin`, while
`src/web/route-helpers.ts:185` treats passwordless single-user mode as admin.
Any network client reaching Codeman could therefore schedule a persistent
service shutdown.

**Resolution:** passwordless single-user shutdown now returns `403`; authenticated
single-user installs and multi-user admins retain access. Route tests cover
passwordless and non-admin denial.

### Self-deleting quick-start fixture

`test/quick-start.test.ts` used the real `~/codeman-cases` directory and removed
the default `testcase` recursively during cleanup. Running CI from a checkout at
`~/codeman-cases/testcase/Codeman` therefore deleted the repository, its Git
metadata, and `node_modules` while Vitest was still running.

**Resolution:** the test now assigns a unique temporary home before dynamically
importing `WebServer`, so its module-level `CASES_DIR` resolves inside the
fixture. The test restores the environment and removes only that temporary home.

### Cross-user repository worktrees

`src/web/routes/file-routes.ts:462` accepted a linked-worktree root returned by
Git without reapplying `isWorkingDirAllowed`. A regular multi-user session in
one allowed worktree could select and read a sibling worktree outside its user
space.

**Resolution:** every repository scope transition is authorized, overview
metadata filters disallowed worktrees, and commit, diff, tree, content, raw,
preview, and thumbnail routes share the same check. Tests cover a linked
worktree outside the user's case space.

### Mixed hook configuration loss

`src/hooks-config.ts:354` identified the entire hooks object as Codeman-owned
when any command referenced `/api/hook-event`, then replaced the full object.
Mixed Codeman and user hooks lost user handlers during self-healing.

**Resolution:** ownership is now determined per command handler. Installation
and refresh replace only Codeman handlers and preserve user events, matchers,
and handlers sharing a matcher.

### Mobile terminal could become unfocusable

`src/web/public/terminal-ui.js:3602` recognized only a narrow set of prompt
glyphs and otherwise classified live Claude rows as content. Touch handling
prevented the browser compatibility focus event, leaving no way to open the
keyboard on promptless redraws.

**Resolution:** known menus, working indicators, and transcript rows remain TUI
content; the live cursor and a lower-screen fallback band remain focusable.
The Playwright regression asserts the helper textarea becomes
`document.activeElement` and no mouse report is sent.

### Input ownership invariant was false

Voice input, image paths, accessory commands, and fallback Enter called
`sendInput` directly despite the documented controller-only boundary.
The pending controller extraction also left three path-picker tests bound to
the deleted implementation.

**Resolution:** all interactive producers now enter semantic
`TerminalInputController` methods. A static producer boundary test rejects
future direct transport calls, DOM-adapter tests dispatch real composition,
delete, and paste events, and the path-picker harness asserts delegation.

### Controls were not opt-in

`src/web/public/settings-ui.js:2006` and the corresponding HTML controls enabled
mobile controls and haptics by default despite the feature description calling
them optional.

**Resolution:** canonical defaults are off. Explicit canonical and legacy true
values still migrate to enabled; device detection alone no longer enables the
feature.

### Phone header policy was weakened

`test/mobile-header-buttons-policy.test.ts:32` allowlisted File Viewer and
instance shutdown on the phone header.

**Resolution:** the allowlist is empty again and CSS explicitly hides both
buttons on phone widths.

## Remaining Test Gaps

- The main CI config excludes the Playwright mobile suites. Each frontend PR
  must report its focused Playwright command until a stable browser smoke job
  is added.
- The broad mobile browser run still carries unrelated baseline debt: 24 visual
  snapshots need an intentional refresh, while 23 structural assertions already
  disagree with `origin/master` behavior such as disabled pinch zoom and the
  legacy 430px phone breakpoint. These should be repaired separately instead of
  weakening feature-specific gates.
- Terminal history paging and warm-cache tests still lean heavily on source
  assertions. The streaming PR should add executable state-machine coverage.
- `Session.setWorkingDir` needs a focused collaborator synchronization test.
- Instance shutdown orchestration needs injected timer/process ports before its
  idempotency and supervisor rollback paths can be unit tested safely.
- Volume-key support is progressive enhancement only. Browser tests can verify
  DOM key mapping, not whether Android or iOS exposes physical volume keys.

## Pull Request Slices

1. Self-contained quick-start test fixture.
2. Mobile terminal controls and opt-in settings.
3. Mobile terminal tap routing.
4. Persistent terminal draft state and the centralized input controller.
5. PTY viewport sizing ownership.
6. Terminal history streaming, cache, and frame reconciliation.
7. Background-command reawake hooks.
8. Transcript tool-result completion.
9. Lifecycle notification noise reduction.
10. Repository/worktree browser and file diff UI.
11. Response viewer.
12. Secure instance shutdown.
13. Inline case edit/delete actions.
14. Active-session launch preservation.
15. Codex animation preference.

Backend terminal protocol changes should precede frontend replay/cache changes.
The draft store should precede the controller adapter if those input changes are
published as stacked PRs. All other slices can target `master` independently.

## Validation Recorded During Audit

- Controller/input focused unit tests: passed.
- Shutdown and header policy tests: passed.
- Hook configuration and self-heal tests: passed.
- Repository scope, symlink, binary, and size-limit tests: passed.
- Promptless mobile focus Playwright regression: passed.
- Focused keyboard, controls, header, tabs, settings, and repository Playwright
  suites: 160 passed.
- Full CI: 200 files passed, 3,977 tests passed, 12 skipped.
- Self-contained quick-start regression: 15 passed and the checkout remained
  intact.
- TypeScript typecheck: passed.
- Frontend syntax and public asset checks: passed.
- `git diff --check`: passed.
