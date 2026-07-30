# aicodeman

## 1.9.2

### Patch Changes

- Rewrite the `xterm-zerolag-input` package README as a value-first document and correct the drift that had accumulated against the source.
  - Added the side-by-side phone demo GIF (`docs/images/zerolag-demo-20260728.gif`) as the hero image, referenced by absolute raw URL so it renders on npmjs.com as well as GitHub. The two-phone comparison shows 0ms local echo next to a 600ms-2.7s server echo on the same session.
  - New "Why this one" comparison table, an explicit list of target use cases (SSH web clients, cloud IDEs, mobile terminals, container consoles), and a bundle-size badge (6.1 kB gzipped, measured from the ESM build).
  - Corrected the test-count badge from 78 to the actual 175 tests across 5 files, in both the package README and the Published Packages section of the root README.
  - Removed the stale "Unicode/emoji rendered at single-cell width" limitation. CJK, fullwidth forms and emoji have had double-width rendering and visual-column positioning since the wide-character fix; the honest remaining caveat (per-code-point width summing over-counts ZWJ grapheme clusters) replaces it.
  - Documented the previously undocumented public `setPrompt()` method for switching prompt strategies at runtime, and the new "Wide characters (CJK, emoji)" integration section covering the optional `Unicode11Addon` path and the built-in range-table fallback.
  - Documented `backgroundColor: 'transparent'`, corrected the `foregroundColor` default, and updated the grid-alignment math to reflect visual-column positioning rather than character index.

  No source changes, docs only.

## 1.9.1

### Patch Changes

- Narrow the Run dropdown, and close the last two gaps in web-tab asset rewriting.

  **The Run dropdown was pinned at its full width.** It capped at 300px, and the recent-session rows wanted 326px, so it always rendered at the cap and reached further across the terminal than it needed to. Now 250px, chosen as the width at which a `~/<dir>/<repo>` + timestamp row still fits whole, since identifying a session to resume is what that list is for. Three fixes were needed to make the narrower menu degrade instead of clip: the saved-URL label now has its own element, because `text-overflow` on the row button did nothing (a bare text node inside a flex container becomes an anonymous flex item that ellipsis cannot reach); `.hist-dir` got `min-width: 0`, without which a flex item refuses to shrink below its own text and pushes the date out of the box; and history rows are held to the container width, because the list's `overflow-y: auto` implicitly makes `overflow-x: auto` and let each row size to its own content and scroll sideways. Phone and tablet widths are unchanged, being set separately in `mobile.css`.

  **A dashboard's own `/api/...` assets are relayed again.** The `Referer`-keyed 404 fallback, which rescues a root-absolute asset that no rewrite layer could reach, refused everything under `/api` outright. Dashboards commonly serve their assets from exactly that namespace, so those requests had no rescue at all. The refusal is now precise: the relay runs before the API-shaped 404, and the auth exemption refuses only paths that resolve to a REAL Codeman route, with `/ws/` and `/q/` still refused by prefix.

  Two findings shaped that fence, both from probing Fastify rather than reading it. `hasRoute()` matches the registered PATTERN literally, so `/api/sessions/abc` reports no match against a registered `/api/sessions/:id` and would have granted an unauthenticated exemption on a live session-scoped route; `findRoute()` performs the real lookup and is what the fence uses. And `@fastify/static` is mounted at `/`, so it registers a root catch-all matching every path, which has to count as "no real route" or the fence would refuse every referer-form request and break the rescue that already worked. A root catch-all is distinguishable because it is the only route whose wildcard param comes back equal to the whole request path. The fence fails closed, and both edges are pinned in `test/webview-auth-exemption.test.ts`.

  **`url()` inside runtime CSS is rewritten.** Measuring the fallback against a purpose-built dashboard showed one sink no relay can reach: a `<style>` element built by page script has no URL of its own, so the browser sends an EMPTY `Referer` with the image request it triggers. The injected URL shim now rewrites root-absolute `url()` in `<style>` blocks, both as markup and when a `<style>` node is inserted. Verified in Chromium: a stylesheet-only `/api/hero.png` and a runtime `<style>` `/api/late.png` both load, where both previously failed. The remaining known gap is self-navigation via `location.href`, which cannot be patched because `Location.href` is unforgeable.

## 1.9.0

### Minor Changes

- 2667150: feat(mobile): browse and insert local file and folder paths

  Add a root-confined filesystem picker to Link Existing and the extended mobile
  keyboard bar. Selected paths remain editable at the active prompt, supported
  images/documents/text files open in a safe inline preview, and a new one-tap
  action clears only the current unsent input without invoking `/clear`.

### Patch Changes

- 3cff98f: Fix two multi-user scoping holes in the new filesystem path picker. `GET /api/filesystem/browse` and `GET /api/filesystem/preview` accept an optional `sessionId` that contributes the session's working directory as a browse root, but they resolved it straight off the session map without an ownership check, unlike the nine other session-scoped handlers in the same route file. A non-admin could therefore pin another user's working directory as a root simply by passing their session id, then list and preview files under it. Both endpoints now run `canAccessOwned` and report 404, which also avoids confirming that a session id exists.

  Separately, `Home` and `CASES_DIR` were unconditional browse roots for every caller. Per-user spaces live at `<USER_SPACES_DIR>/<username>`, which is inside `homedir()`, so the `Home` root alone exposed every other user's workspace to any authenticated user. In multi-user mode a non-admin now gets only their own space plus anything explicitly listed in `CODEMAN_FILE_PICKER_ROOTS`; `/mnt/d` is no longer offered by default, since a broad host mount should be an explicit operator decision in a multi-user deployment. Admins keep the host-wide roots, and single-user mode is unchanged.

  Both holes are regression-guarded in `test/routes/file-routes.test.ts`, verified to fail against the previous code. Multi-user mode is opt-in and off by default, so single-user installs were never affected.

- Web tabs: delete saved URLs from the Run dropdown, and fix images in proxied dashboards.

  **Saved URLs are now manageable from the dropdown.** Each row under "Web / URL" gains a gear and an `x`, so a URL can be edited or deleted without first opening it as a tab. Previously the only delete path ran through the gear on an open tab, which was a dead end for a URL you no longer wanted open at all. Both controls stay permanently visible rather than hover-revealed, because the same menu is used on touch, and they get a larger hit box there. Deleting leaves the dropdown open on the remaining rows, and deleting the dashboard that is currently open also closes its tab and unmounts its frame.

  **Runtime-injected images no longer 404.** A dashboard that renders its own markup from script (`card.innerHTML = '<img src="/api/hero?slug=x">'`, `img.src = '/api/slide'`) escaped every rewrite layer at once: `<base href>` never applies to a root-absolute URL, the server-side attribute rewrite only ever sees the initial document, and `runtimeUrlShim()` patched only `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource`. Those requests landed on Codeman's own root and 404'd, with a symptom that reads as an upstream fault: the dashboard's data loaded while every image stayed broken.

  The shim now also covers the DOM URL sinks, so the request is never emitted in the first place and neither the `/api` fence in the 404 fallback nor the one in the auth middleware had to move. It wraps `innerHTML`, `outerHTML`, `insertAdjacentHTML` (including on `ShadowRoot`), `setAttribute`/`setAttributeNS`, and the `src`/`srcset`/`href`/`poster`/`data`/`action` property setters on img, source, media, video poster, script, iframe, embed, track, link, anchor, area, object and form, with a `MutationObserver` as a last net for sinks not patched above. Every rewrite routes through the same idempotent helper, which matters because unlike the server-side rewrite this one sees markup that may already be proxied, and a page re-injecting its own `outerHTML` would otherwise double-prefix. Everything is defensively guarded and marked so a double injection cannot wrap an already-wrapped setter.

  Measured against a real dashboard: 693 image elements, 0 of them under the proxy prefix and 0 of 23 in-viewport images decoded before, 693 and 23 of 23 after. Covered by a new jsdom suite over the shim's DOM half and a new frontend suite over the dropdown rows. Known remaining gaps are documented in `docs/web-tabs.md`: a root-absolute `url()` inside a stylesheet injected at runtime, and self-navigation via `location.href`, which cannot be patched because `Location.href` is unforgeable.

  Also in this release: a value-first README overhaul pointing at getcodeman.com, and the QR-auth distribution test now uses a chi-square check instead of a max-deviation threshold that failed on random variance.

- bca56b4: Normalize Claude conversations in the response viewer. A Claude transcript is an append-only event log, so one logical exchange spans many JSONL rows: tool-result rows, meta/image/skill rows, compact summaries, task and team notifications, sidechains, replayed assistant snapshots, and multi-block assistant output. The viewer rendered a card per row, which produced duplicate and truncated cards that read as lost responses. Cards are now built at real human-turn boundaries, replayed assistant snapshots are deduplicated, and sidechain rows (which belong to subagents, not the main conversation) no longer leak in. An identical prompt that legitimately recurs after an assistant reply is still kept as its own turn.

  Measured over 40 real transcripts: 3108 cards became 621, duplicate cards dropped from 74 to 8 (all of them genuinely repeated turns), no assistant text was lost, and the non-`context=full` last-response text was byte-identical on every file.

  Also rebinds recovered sessions to their transcript. `reconcileSessions()` can recover a lost mux session as a `restored-<uuid8>` placeholder with a stale working directory, which made transcript lookup by cwd find nothing. The placeholder still carries the first eight characters of the conversation UUID, so the viewer now rebinds to the matching top-level transcript when exactly one candidate matches.

## 1.8.3

### Patch Changes

- 8c089a4: Add four light UI and terminal skins: Paper Gray, Solarized Light, Catppuccin Latte, and Rosé Pine Dawn. The Skin picker now groups Light and Dark options, and each light skin ships a matching xterm ANSI palette plus `color-scheme: light` so native selects, date pickers and scrollbars stop rendering as dark OS widgets on a light page. Terminals set `minimumContrastRatio: 4.5` under a light skin (main terminal and teammate terminals both), which keeps CLI output that assumes a dark background readable, and `applyTerminalSkin()` now refreshes the zero-lag input overlay so typed-but-unflushed text does not keep the previous theme's colors.

  Elevated surfaces (modals, command palette, dropdowns, subagent and ultracode windows, file preview, attachment tray, mobile sheets) now resolve through shared `--floating-bg` / `--control-*` / `--banner-bg-*` / `--modal-backdrop` / `--elevated-shadow` tokens instead of hardcoded near-black rgba, so they follow whichever skin is active. On the Daylight skins this lifts modals slightly off the page background; OG Codeman pins its own near-black value to keep that palette neutral.

  Also defines twelve CSS compatibility aliases (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--border-color`, `--accent-color`, `--success`, `--error`, `--danger`, `--font-mono`, `--shadow-lg`) that panels and overlays already referenced in about 79 places but which were never actually declared, so those rules silently resolved to nothing. Status badges and accent-tinted pills (search filter chips and result badges, session tab mode pills, respawn state, Ralph priority and circuit-breaker badges, tunnel and voice status, mobile case picker) no longer keep their pale light-on-dark ink under a light skin, where it measured 1.0 to 1.9:1 and made the search filter chips invisible.

  New static regression `test/skin-themes.test.ts` guards the four-way parity between the CSS token block, the xterm palette, the pre-paint allowlist and the Settings picker.

## 1.8.2

### Patch Changes

- Web tabs: open dashboard URLs as tabs beside agent sessions, plus terminal link fixes.

  **Web tabs.** The Run dropdown gains a "Web / URL" section. A saved URL renders as a tab in the same strip as Claude/Codex/Gemini sessions, with the same Alt+1-9 numbering, an icon picker, and per-device tab order. Frames stay mounted while hidden (LRU-bounded), so switching tabs never reloads a dashboard.

  Dashboards are proxied through Codeman's own origin, because a direct iframe fails three ways at once: an HTTPS Codeman cannot embed a plain-HTTP target (mixed content, with no override at all on iOS Safari), many dashboards send `X-Frame-Options: DENY`, and Codeman's own `default-src 'self'` CSP blocks cross-origin frames. Proxying dissolves all three and leaves the production CSP unchanged. The fetch happens server-side, so a tailnet-only or localhost-only dashboard is reachable from any device that can reach Codeman.

  The proxy is not an API surface: it authenticates on a 192-bit capability in the path (memory-only, rolling TTL, bound to the minting user, revoked on edit or delete) and is exempt from the cookie and Origin checks, because a sandboxed iframe is opaque-origin and sends neither. The Host allowlist is never bypassed. Iframes omit `allow-same-origin` unless a URL is explicitly marked trusted, and `Authorization` plus the session cookie are stripped upstream in both modes so `CODEMAN_PASSWORD` cannot leak into a dashboard. Includes an HTTP and WebSocket proxy, redirect/cookie/`<base>` rewriting, a runtime URL shim for requests built by dashboard JavaScript, and CORS handling for the opaque-origin frame. New endpoints under `/api/webviews`, storage in `~/.codeman/webviews.json`, user guide in `docs/web-tabs.md`.

  **Terminal links no longer truncate.** Three separate cuts, each producing a link that opened the wrong target or none at all:
  - A single `&` ended the match, so every query string was cut. A WordPress edit link resolved to `?post=1479` and Claude Code's own `/login` URL was unusable. `&` is now part of a URL while `&&` remains a boundary.
  - Links wider than the terminal were cut at the row boundary. The link provider now stitches continuation rows into one logical line and maps offsets back across rows. Handles both soft wraps (emulator, `isWrapped`) and hard wraps (a program wrapping its own output and emitting a newline, as Ink does), the latter being why the `/login` URL grew longer as the window was widened.
  - Image and PDF paths were not matched at all, so pasted-screenshot paths rendered as plain text. They now link and open the file preview, which renders images inline.

  **Also fixes** a pre-existing bug where `.toolbar`'s `backdrop-filter` created a stacking context that trapped the Run menu's z-index, letting the welcome overlay cover it: with no session open, every item in that menu (Claude Code included) was unclickable.

## 1.8.1

### Patch Changes

- Mobile toolbar: a dedicated Enter button, and Shell moves into the Run dropdown.

  Submitting is a constant need on a touch keyboard, so on phones (≤430px) the toolbar slot that held "Shell" now holds a dark blue **Enter** button. Starting a shell, the far rarer action, moves into the expandable Run dropdown as `Terminal / Shell` (the Run button then reads "Run SH"). Desktop and tablet are unchanged: the green Run Shell button stays exactly where it was.

  Enter is replayed through the terminal's own input path rather than posted to the input API. This matters because local echo is on by default on touch devices: the characters you type are buffered client-side and have not yet reached the PTY, so sending a bare carriage return would submit an empty line and leave your text stranded on screen. Replaying the keypress flushes the buffered text first, then submits.

  Installer: re-runs and updates now preserve the existing network binding instead of silently reverting it, so upgrading no longer changes how the dashboard is reachable.

  Default desktop header is cleaner: the file viewer is shown by default and the plan-usage chip is unchanged, while the token-count chip and lifecycle-log button now default off. Stored preferences are still honored.

  Docs and repo housekeeping: fresh phone screenshots and a new hero GIF in both READMEs, contributor and total-commit badges, and a much shorter repo root. `SECURITY.md` moved to `.github/` (GitHub resolves it there, so the Security policy tab is unaffected), `SPEEDRUN.md` to `docs/`, the knip config to `config/`, and Prettier's config into the `"prettier"` key of `package.json`. `CLAUDE.md` was split so the always-loaded guidance is roughly half its former size, with the deep implementation detail preserved verbatim in `docs/architecture-invariants.md`.

## 1.8.0

### Minor Changes

- Installer: choose your network binding, with LAN access as the new guided default.

  The install script now asks at the end of setup how the dashboard should be reachable:
  1. Any device on your network (0.0.0.0), the default. The installer prompts for a dashboard password (hidden input, confirmed twice); declining a password requires an explicit confirmation and the install ends with a prominent warning explaining the exposure.
  2. This machine only (127.0.0.1), the safer option for tunnel/Tailscale setups.

  The choice is wired into the generated systemd unit and launchd plist (values escaped for each format), the run-now launch path, and the printed URLs, which now include the detected LAN IP for instant phone access. Non-interactive installs keep the safe loopback default unless CODEMAN_HOST is preset, and the server binary's own default binding (127.0.0.1) is unchanged, so npm and manual installs behave exactly as before. New installer env presets: CODEMAN_HOST and CODEMAN_PASSWORD skip the prompts for automation.

## 1.7.1

### Patch Changes

- Mobile and UI polish plus docs refresh.
  - Mobile: the header brand collapses to a single "C" home button on phones (<430px), freeing header space for session tabs while keeping the same tap target. The compact letter lives in its own span so i18n custom branding keeps rewriting only the full wordmark.
  - UI fix: the absolutely-centered toolbar voice button no longer overlaps the case picker's chevron and "+" button. Below ~1500px (or with long case names widening the left toolbar group) it now falls back into normal flex flow where overlap is impossible; wide viewports keep the centered layout.
  - Docs: README gains a hero pitch block with deep links, npm version + GitHub stars badges, and a star CTA; CLAUDE.md core-files table synced (Infra docker modules, app.js line count); blog article images added under docs/images/blog/.

## 1.7.0

### Minor Changes

- Community release (thanks @shenlvkang-collab for all four PRs) plus documentation fixes.
  - fix(mobile): per-device settings now key off a stable handheld classification (`MobileDetection.isHandheldDevice()`: touch plus UA form-factor tokens, with User-Agent Client Hints fallback) instead of the instantaneous viewport width, so an Android foldable that unfolds past the desktop breakpoint keeps `codeman-app-settings-mobile` and opt-ins such as the Response Viewer and Extended Keyboard Bar. Responsive layout stays width-driven. Adds an OPPO Find N5 (unfolded) device profile and a fold/unfold/reload Playwright regression test (mobile suite now 136 devices). (#162)
  - fix(paths): `SAFE_PATH_PATTERN` now accepts Unicode letters and numbers (`\p{L}\p{N}` with the `u` flag), so working directories like `/mnt/d/AI/中文项目` validate in Create Session, Quick Run, and Scheduled Run. All shell-metacharacter, traversal, and absolute-path protections are unchanged. (#163)
  - fix(ui): newly created run sessions render their tab immediately instead of waiting for the `session:created` SSE event (idempotent upsert from the POST response, with a `GET /api/sessions/:id` fallback for quick-start modes), and the Run button holds an in-flight lock (min 500 ms) so a double click cannot create duplicate sessions. (#164)
  - feat(ui): the synced custom display name and per-device English/Simplified Chinese UI language are described in their own entry (#165); on top of that PR, `renderIndexHtml` no longer recomputes `windowTitle` on solo-session renders, so a detached window cannot reset the push-notification `hostTitle` prefix to the default name.
  - docs: corrected the `sse-events.ts` fileoverview breakdown (148 event constants, was stale at 120; per-category counts refreshed, including Cron, Docker, Remote auto-reconnect, and Multi-user) and the CLAUDE.md SSE registry count; READMEs synced with the 1.6.2 installer behavior.

### Patch Changes

- 8d9fc41: Add a synced custom display name and a per-device English/Simplified Chinese browser UI language picker under App Settings → Display.

## 1.6.2

### Patch Changes

- Installer (install.sh) reliability and safety overhaul, prompted by a review of the Linux flow:
  - Install-completion marker (`.install-complete`): a bare re-run only takes the quiet update path when a previous install actually finished. Previously, a first install that failed during npm install/build (or was interrupted) left `.git` behind, so the retry silently became an "update" and the user never got the launch menu, the `codeman`/`tmux-chooser` symlinks, the PATH entry, or the `sc` alias. The marker is refreshed by updates and cleared by uninstall when the app dir is kept; added to .gitignore for end-user clones.
  - `update` no longer runs an unconditional `git reset --hard` over local changes: interactive runs are asked to stash (declining keeps everything and skips the update), headless runs auto-stash with a dated message (same policy as scripts/self-update.sh).
  - Service setup is verified instead of asserted: after starting codeman-web, the installer polls `systemctl --user is-active` (up to 6s) and only then prints "Codeman is running now!"; failures print an honest warning plus status/journalctl hints. Uses `restart` instead of `start` so re-running the installer over an already-running service actually loads the new build. A missing user D-Bus session (e.g. bare `ssh host 'curl | bash'`) is detected up front with copy-paste recovery commands instead of dying mid-setup via `set -e`. macOS gets the equivalent `launchctl list` verification, and the update path verifies its service restart too. The Cloudflare tunnel-service offer is skipped when service setup failed.
  - Headless consent guard: with no interactive terminal AND no explicit `CODEMAN_NONINTERACTIVE=1`, the installer now refuses (with instructions) to run sudo package installs (git/node/tmux) or third-party `curl | bash` AI CLI installers, instead of silently taking the default-yes prompts. Explicit `CODEMAN_NONINTERACTIVE=1` keeps the previous full-auto behavior for CI/automation.
  - AI CLI gate now recognizes Codex and Gemini (search paths mirrored from the CLI resolvers), so a box with only Codex or Gemini installed is no longer forced to install Claude Code/OpenCode. The install menu gains a "Skip" option (with npm install hints for Codex/Gemini), and the final reminder lists all four CLIs.

  Docs: CLAUDE.md documents `src/remote-reconnect.ts` (pure COD-108 auto-reconnect backoff/eligibility logic) in the Infra table and the remote-sessions pattern.

## 1.6.1

### Patch Changes

- **Admin Panel for multi-user mode.** Admins in multi-user mode now get a prominent Admin Panel button at the top of the page (header, admin-only; the template ships it hidden and `admin-ui.js` reveals it after identity boot; hidden on phones per the mobile header policy, where user management stays reachable via App Settings > Users). It opens a full Admin Panel modal: a users table with role, enabled/disabled status, bypass-permissions grant, live sessions, active logins, case count, and last login; per-user actions for Promote/Demote, Enable/Disable, Grant/Revoke bypass, Reset password (copyable one-time password), Force logout, and Delete (with an optional "also delete their files" step); and a proper add-user form (role, optional password, bypass checkbox) replacing the old prompt() flow. Each user's cases open in a drawer listing their case folders (modified date, live-session badge) with per-folder delete. Two new admin endpoints back this: `GET /api/admin/users/:username/cases` and `DELETE /api/admin/users/:username/cases/:caseName`, guarded like `deleteUserSpace` (symlinks refused, realpath confined to the user's space, folders in use by a live session refused with 409, audit-logged). The panel and the App Settings Users tab live-refresh on the SSE `admin:usersChanged` event (now wired in app.js). New coverage in `test/admin-routes.test.ts` (list/delete, traversal + symlink refusal, non-admin 403) and `test/admin-ui.test.ts` (button reveal gating, panel render, case drawer); verified end to end against a live multi-user instance with curl and Playwright.

  **Also in this release:** README/docs synced with 1.6.0 (remote SSH cases, session manager, permissions) and fixed installer prompts when run via `curl | bash`.

  **Recap of the recent feature line, for readers catching up:**
  - **Multi-user mode (shipped 1.5.0, opt-in `--multiuser` / `CODEMAN_MULTIUSER=1`).** Named users with scrypt-hashed passwords, per-user case spaces under `~/codeman-users/<name>/cases`, and full ownership scoping of sessions, cases, cron jobs, scheduled runs, search, file previews, and SSE/WS streams. Non-admin users default to Claude's classifier-guarded `--permission-mode auto`; shell mode, cron `launchCommand`, and skip-permissions bypass switches require the per-user `canBypassPermissions` grant (now toggleable from the Admin Panel). Admin API with one-time passwords, last-admin invariants, and an append-only audit log; self-service `/api/me` password change; `codeman users add|passwd|list|rm` CLI. Off by default is byte-identical to single-user. Note: multi-user separates workspaces for a trusted team; it is not a security boundary (all sessions share the host OS account), so pair it with Docker cases for real isolation.
  - **Docker cases (shipped 1.4.0/1.4.1).** A case can run inside an isolated per-case container (any of the five CLI backends), with one-click "Run in Docker" quick-create, durable in-container tmux that survives Codeman restarts and resumes conversations after container stops, hardened container creation (cap-drop ALL, no-new-privileges, non-root, memory/pid limits, never privileged, never the docker socket), commit-safe seeded credentials, config-drift detection, GPU passthrough, and portable export/import bundles to move a whole case between machines.
  - **1.6.0 highlights.** Remote SSH cases with durable remote tmux (survives SSH drops, auto-reconnect, shared multi-client attach, discover + attach with detach-not-kill); the Cmd+K session palette and unified Session Manager with pinning, cross-device tab order, and first/last prompt search; full-scrollback replay; and the multi-user permission downgrade now threading through to remote launch/attach.

## 1.6.0

### Minor Changes

- Remote tmux durability, Session Manager polish, and an opt-in Cron button.

  **Remote sessions: durability, discovery, and auto-reconnect** (PR #156 by @aakhter, COD-104 to COD-109)
  - Durable remote launches survive an SSH drop: the agent runs inside `tmux -L codeman-remote new-session -A` on the remote host, and reconnecting lands back in the same session.
  - Discover + attach: a "Discover existing sessions" action per remote host lists `codeman-*` tmux sessions on the host's canonical socket (started by the remote's own Codeman or another instance) and attaches to one. Attached (non-owned) sessions detach on tab close, never kill; a structural early-return in `killSession()` guarantees no remote `kill-session` can ever be issued for a session Codeman doesn't own (COD-105).
  - Shared/collaborative sessions: per-session `window-size latest` so concurrent clients at different viewports don't clamp each other, plus a "shared - N clients" badge in discovery results (COD-106).
  - Auto-reconnect watcher: a bounded-backoff (5s to 5m, ~6 attempts) watcher detects a dead remote pane and reattaches the still-running remote tmux session; intentional kills/detaches are guarded and never revived. Kill-switch setting `remoteAutoReconnect` (default on). SSE `remote:sessionDropped`/`sessionReconnected`/`reconnectExhausted`, with a manual Reconnect toast after exhaustion (COD-108).
  - Owned durable sessions propagate `kill-session` to the remote on close (COD-109); the remote tmux prereq probe is skipped under the test runner (COD-104).
  - All ssh command lines continue to flow through the single shell-safe `buildSshConnectionArgs()` (COD-107). New design doc: `docs/remote-sessions.md`.
  - Maintainer additions: the discovery endpoint is admin-gated in multi-user mode, and the remote launch/attach chooser threads the multi-user permission downgrade (`claudeMode`/`allowedTools`) through to the remote agent.

  **Session Manager: pinning, cross-device ordering, name/prompt retention** (PR #157 by @aakhter, COD-131/139/140/142/143/145)
  - Session pinning: pin a session to the top of the Session Manager list (`POST /api/sessions/:id/pin`, `session:pinned` SSE, amber highlight + pin glyph). Pinned group orders most-recently-pinned first (COD-139).
  - Pinned sessions survive kill: killing a pinned session demotes its record to a lightweight stopped entry instead of removing it, so it stays visible and resumable; cleanup skips pinned records (COD-142). The pin route also works on these persisted-only records, so a pinned-then-killed session can always be unpinned.
  - Cross-device tab order: tab order syncs via server state (`PUT /api/session-order`, `session:orderChanged` SSE, persisted in `state.json`); the pushing device wins and server-only ids fall to the end, never dropped (COD-131).
  - Resuming from the Session Manager keeps the session's original name instead of always synthesizing a fresh `w<N>-<dir>` one (COD-143).
  - firstPrompt backfill for sessions whose Codeman id is not the transcript UUID (claudeSessionId join, then newest transcript in the same workingDir), and the most recent prompt is shown alongside the first and included in search (COD-140/145).

  **Cron button now opt-in** (hidden by default)
  - The Cron footer-toolbar button follows the same opt-in pattern as the Session Manager / Away Digest / File Viewer buttons: hidden by default, enable per device under App Settings -> Display -> Header Displays. Cron jobs themselves are unchanged.

  Also: `docs/remote-sessions.md` synced with the shipped `-L codeman-remote` / `codeman-ssh-<id8>` naming.

## 1.5.1

### Patch Changes

- Docker session-mode deep-review fixes — the work intended for the skipped **1.4.2**, now merged onto the 1.5.x line — plus a recap of the multi-user mode shipped in 1.5.0.

  **Docker resume actually works now.** `DockerCase.lastClaudeSessionId` was read at quick-start but never written, so the documented resume-after-container-stop never fired. Claude-mode docker panes now pin a deterministic conversation id (`claudeDockerPaneCommand()`): a fresh launch runs `claude --session-id <id> || claude --resume <id>` (a duplicate `--session-id` exits 1 "already in use", so the fallback resumes after a container stop/reboot — verified CLI behavior), an explicit resume runs `--resume <rid> || --session-id <sid>` so a stale id never dead-panes. The id is persisted at launch and again on hook / last-response conversation-id adoption. Verified end-to-end across a `docker stop` + relaunch and a full container recreate.

  **Config-drift detection + recreate (was documented but entirely missing).** The `codeman.confighash` label was stamped but never read, so docker-host config edits silently never applied. Quick-start now compares via `checkDockerConfigDrift()` and refuses a drifted launch with `CONFLICT`; the UI confirms and calls the new `POST /api/docker-cases/:name/recreate` (refused while the case has live sessions), then relaunches with the new config. New SSE event `docker:containerRecreated`.

  **Model picker now applies to docker sessions.** `modelOverride` was absent from `QuickStartSchema`, so the App Settings Claude Model choice was silently inert for docker runs. It is now accepted and applied via `updateCaseModel` for local and docker quick-starts (still rejected for remote, where the settings file would land on the wrong machine).

  **Import hardening.** `importDockerBundle` validates the untrusted cross-machine manifest before trusting any field (`validateImportManifest`: engine/image/containerWorkdir/network/caseName/schemaVersion — a hostile `engine` could previously select the probe binary); the outer bundle tar gets the same member-traversal guard as the inner workspace tar; the quarantine image tag derives from the schema-validated case name.

  **Remote-daemon correctness.** All docker probes and the base-image auto-build now honor a host's `context`/`daemonHost` (`dockerEngineArgv`) instead of always probing the local daemon.

  **Smaller fixes:** commas are rejected in docker workspace/workdir/destination paths (a comma corrupts the `--mount type=bind,src=…` CSV spec, which shell escaping cannot protect); a dead `this.escapeHtml` reference in the exports refresh is fixed; `docker:importComplete` / `docker:containerRecreated` get frontend SSE listeners so other open tabs refresh; the File Viewer header button is hidden on phone headers like its siblings.

  **Docs.** CLAUDE.md + READMEs synced with the current feature set, including a full zh-CN README re-translation.

  **Multi-user mode (recap — shipped in 1.5.0).** Opt-in named users (`--multiuser` / `CODEMAN_MULTIUSER=1`, off by default) with per-user case spaces and full ownership scoping of sessions, cases, cron jobs, scheduled runs, search, file previews, and real-time SSE/WS streams. Non-admin users default to Claude's classifier-guarded `--permission-mode auto`; raw shell mode, cron `launchCommand`, skip-permissions, and the Codex/Gemini bypass switches require an explicit per-user `canBypassPermissions` grant. Machine-level resources are admin-only. Admin API (`/api/admin/users*`) with one-time passwords, last-admin invariants, and an append-only audit log; self-service `/api/me` + password change; and a `codeman users add|passwd|list|rm` CLI. Off by default is byte-identical to single-user. Note: multi-user separates workspaces for a trusted team; it is not a security boundary between mutually-distrusting users (all sessions share the host OS account) — pair with Docker cases for real isolation.

## 1.5.0

### Minor Changes

- 0ab2416: Opt-in multi-user mode (`--multiuser` / `CODEMAN_MULTIUSER=1`, off by default).

  Named users with individually scrypt-hashed passwords in `~/.codeman/users.json`, per-user case spaces under `~/codeman-users/<name>/cases`, and ownership scoping of sessions (create/list/delete/mutate, incl. bulk delete), cases, cron jobs + run history, scheduled runs, search, file previews, session history, away digest, subagent/workflow monitors, and real-time SSE/WS streams (including the debounced session/task update path, clipboard, and push notifications). A non-admin's `workingDir` is realpath-confined to their own space at every spawn/link path (session create, quick-start, cron create/fire, scheduled runs, case link/docker-link, docker import). Non-admin users default to Claude's classifier-guarded `--permission-mode auto`; raw shell mode, cron `launchCommand`, skip-permissions, and the Codex/Gemini bypass switches require an explicit per-user `canBypassPermissions` grant (enforced at every spawn site incl. one-shots, plan generation, scheduled runs, and remote launches). Machine-level resources (remote/Docker hosts + host reads, mux sessions, orchestrator, tunnel, self-update, settings) are admin-only. Admin API (`/api/admin/users*`) with one-time passwords, last-admin invariants (validated before any teardown), and an append-only audit log; self-service `/api/me` + password change; a frontend admin Users tab + change-password modal; and `codeman users add|passwd|list|rm` CLI. Also adds a global `auto` Claude startup permission mode. When off, behavior is byte-identical to single-user.

  Auth hardening: the login throttle verifies the password before consulting the per-account failure bucket (a correct password can never be locked out); the `mustChangePassword` lockbox covers the WebSocket terminal; the cookie fast-path re-validates identity against the store each request (so a CLI/admin delete/disable/demote takes effect promptly); a role/grant change revokes the target's sessions. (Known limitation: a bare CLI `codeman users passwd` reset — no delete — does not by itself revoke an already-active cookie until it expires; use `codeman users rm`, the admin API, or a restart to force-revoke.) Data-integrity hardening: the store distinguishes a missing users file from a corrupt/unreadable one (so a transient read error can't overwrite all accounts) and writes via a unique per-process temp file; the earlier fire-and-forget `touchLastLogin` corruption race is serialized.

  Note: multi-user mode separates workspaces for a trusted team; it is not a security boundary between users (all sessions share the host OS account). Pair with Docker cases for real isolation.

## 1.4.1

### Patch Changes

- **Docker session mode** hardening + fixes, plus a File Viewer header button.

  **What Docker session mode is** (recap): a case can run inside an isolated, hardened Docker container instead of on the host, and any of the CLI backends (Claude, Codex, Gemini, OpenCode, or a plain shell) runs inside it. It is a location overlay on cases — not a new session mode — and the container analog of remote-SSH cases: a local tmux pane `docker exec`s into a durable in-container tmux, with exactly one long-lived container per case that multiple sessions share. The workspace, credentials, and conversation transcripts are bind-mounted so the agent is authenticated and resumable; containers are hardened by default (`--cap-drop ALL`, `--security-opt no-new-privileges`, non-root, pids/memory caps, `--init`, never `--privileged` or the docker socket) and export-safe. Start one with the one-click "Run in Docker" checkbox on Create Case, or the Docker tab for full control.

  This release fixes the rough edges found running it for real:

  Docker cases:
  - **Seamless Claude auth in containers**: `~/.claude.json` is no longer bind-mounted as a single file (a mount point that broke Claude's atomic-rename config writes — forcing re-auth and, via failed in-place writes, corrupting the host `~/.claude.json`). It is now seeded as a writable, onboarding-complete copy, so a docker session boots straight to the prompt (no theme picker, login, or folder-trust prompt).
  - **Claude-state isolation**: containers no longer bind-mount the whole `~/.claude` directory (which wrote backups/tasks/teams/settings back into the host). Only `~/.claude/projects` transcripts are shared (host watchers + `--resume`); credentials, settings, and stats-cache are seeded as writable copies; everything else stays container-local.
  - **Codex/Gemini/gcloud/opencode isolation**: same treatment — codex shares `sessions/` + `history.jsonl` (response-viewer + resume) and seeds `auth.json`/`config.toml`; gemini/gcloud/opencode are whole seed-copies. Containers never write their credential state back into the host dirs.
  - **Base image auto-builds on first use**: a missing `codeman/agent:base` no longer blocks case creation or launch; it builds locally on first use (concurrency-safe, with SSE progress toasts).
  - **UTF-8 locale**: containers set `LANG`/`LC_ALL=C.UTF-8` so tmux renders Claude's box-drawing correctly (fixes `qqqq` line artifacts).
  - **Create Case UI**: larger, collapsed-by-default "Run in Docker" settings with a shorter hint; dockerized cases show a short `(docker)` tag (or the custom host id) in the case menus.
  - **Tab naming**: docker/remote (and codex/gemini/opencode) sessions now follow the `w<n>-<case>` convention instead of `codeman-<id>`.

  Other:
  - **File Viewer header button** (opt-in via App Settings, Header Displays): toggle the file browser panel from the header.
  - Fixed a timezone-boundary flaky test in the away-digest route suite.

## 1.4.0

### Minor Changes

- Add **Docker session mode**: a case can now run inside an isolated Docker container instead of on the host, with configurable network / resource / credential settings, multiple sessions sharing one per-case container, and one-click export to move a container (toolchain + workspace) to another machine.
  - Docker is a location overlay on cases (not a new session mode), mirroring the remote-SSH feature: a local tmux pane runs `docker exec -it` into a durable in-container tmux server. The container is scoped to the case (`codeman-case-<name>`), so multiple sessions share it; killing one session never stops the shared container.
  - New `/api/docker-hosts` CRUD, `/api/cases/docker-link`, and a `/api/quick-start` docker branch. Create Case gains a **Docker** tab. Base image is built locally via `scripts/build-agent-image.mjs` (node + claude/codex/gemini/opencode + tmux, secret-free, arbitrary-uid-writable HOME).
  - Hardened by default: `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root, `--pids-limit`, `--memory`==`--memory-swap`, `--init`; never `--privileged` or the docker socket. Convenient credential default bind-mounts host `~/.claude` etc. read-write (never captured by `docker commit`); a sealed profile is opt-in.
  - Two-layer durability: reconnect after a Codeman restart reattaches the same live agent; a container stop/reboot resumes the conversation from the bind-mounted transcript via `--resume`.
  - Export / import: full-image (`docker commit` + `save` + workspace tar + manifest) or workspace-only, to one portable `.codeman-container.tgz`; import validates checksums, guards path traversal, and re-tags the loaded image into a quarantined namespace. Instance-scoped boot reaper cleans orphaned containers. New `docker:*` SSE events. Docs in `docs/docker-cases.md`.
  - Robustness: sets `CLAUDE_CODE_TMPDIR` in the container so claude launches regardless of workspace path. In-container hooks require the server to be reachable from the container (documented); on a loopback-only bind, idle detection falls back to output-based.

  Also wire session, away-digest, and cron header-button visibility toggles in App Settings.

## 1.3.5

### Patch Changes

- a842f2d: fix(auth): slide the session cookie so active users aren't logged out

  Re-issue the `codeman_session` cookie on every authenticated request so the
  browser cookie lifetime tracks the server-side sliding TTL (the session store
  already uses `refreshOnGet`). Previously the cookie was only set on the Basic
  Auth path with a fixed 24h lifetime from login, so the browser dropped it
  mid-use; the next request arrived cookie-less, fell through to Basic Auth and
  popped the native username/password dialog, perceived as a random logout while
  actively working.

## 1.3.4

### Patch Changes

- Fix "Run Shell" not switching the terminal to the newly created shell session. Clicking Run Shell created the shell tab but left the previous session's terminal on screen, so you had to manually click the new tab to actually enter it. Root cause: `runShell()` pre-set `activeSessionId` to the new session's id right before calling `selectSession()`, and `selectSession()` early-returns when the requested id already matches the active one, so it skipped the terminal buffer load, tab activation, and focus. Removed the premature assignment in both the local and remote-SSH shell branches so `selectSession()` runs to completion (matching `runClaude`/`runCodex`/`runGemini`/`runOpenCode`, which already avoid this). Verified end-to-end in a real browser with a negative/positive control.

## 1.3.3

### Patch Changes

- Fix terminal scroll-back in Claude sessions, especially on macOS trackpads (#154).
  - **Deterministic CLI version detection.** `cliVersion` was often `undefined` because it was scraped from the `Claude Code vX.Y.Z` startup banner, which newer Claude Code builds (2.1.187+) don't reliably print and resumed sessions never show. With the version unknown, wheel-forwarding to Claude's transcript was silently disabled — and since repaint-mode Claude keeps no local terminal scrollback, scrolling up reached nothing. A new `getClaudeCliVersion()` probe (`claude --version`, cached, local-only) seeds the version at session start so forwarding engages. Restored sessions pick it up on restart.
  - **Trackpad Shift+scroll.** The wheel handler now reads the dominant axis, so a macOS trackpad's Shift+two-finger scroll — which the browser reports as horizontal `deltaX` — reaches xterm's local scrollback instead of collapsing to a fixed one line per tick.
  - **Opt-out setting.** New per-device App Settings → Input → "Wheel Scrolls Local History" (default off) pins the plain wheel to local scrollback (the pre-#144 behavior) for shell and other non-repaint sessions.
  - **No more "queued bytes" flicker on scroll.** Wheel-scroll reports now use a fire-and-forget send path (seq-less input frame) instead of the durable exactly-once input queue, so they no longer appear in the pending-bytes connection indicator or churn localStorage. Keystrokes, taps, and clicks still use the durable queue.

## 1.3.2

### Patch Changes

- Make the Cron Jobs modal fully skin-aware and consistent with App Settings' design language.
  - **Fix white dropdowns:** `.form-select` had no `appearance` reset and the app set no `color-scheme`, so native `<select>` fields rendered as white OS widgets that ignored the active skin. Selects now use `appearance: none` with an opaque `var(--bg-input)` fill, a `var(--border)` outline, and a custom chevron, so they follow the skin (daylight `#202833`, OG `#1a1a1f`). This is on the shared `.form-select` class, so App Settings, Cron, and every other select match and are fixed together.
  - Set `color-scheme: dark` on `:root` so native select option popups, date/time pickers, and scrollbars render dark across all three (dark) skins instead of flashing white.
  - Themed the Cron date/time inputs with `var(--bg-input)` / `var(--border)` instead of hardcoded values.
  - Fixed the Cron toolbar: "+ New Job" / "Refresh" and the footer Save / Cancel now use the full `btn-toolbar` size (matching the App Settings footer), with a wider gap and a divider under the toolbar for better spacing.

## 1.3.1

### Patch Changes

- Redesign the Cron Jobs modal to match the App Settings styling, and fix a bug that left its create form fully expanded.
  - **Fix:** the cron modal's "New Cron Job" form and all of its conditional rows (Launch Command, Prompt File Path, and the once/interval/daily/weekly schedule fields) never actually collapsed — there is no global `.hidden` utility in the stylesheet and the cron modal never scoped its own, so the form opened fully expanded with every field visible at once. Added a scoped `#cronModal .hidden` rule; the form now stays collapsed until "+ New Job" and only shows the fields relevant to the selected agent type, prompt source, and schedule type.
  - Sectioned the create/edit form into Basics / Prompt / Schedule / Options with the same section-header dividers used in App Settings, and increased row spacing.
  - Styled the agent-type / prompt-source / input-mode / schedule-type dropdowns and the datetime-local / time inputs to share the bordered, rounded, focus-ringed field look.
  - Converted the "Auto-close previous run's session" and "Enabled" toggles into App-Settings-style cards (label + description on the left, compact switch on the right).
  - Replaced the raw weekday checkboxes with pill toggles that fill with the accent color when selected.
  - Restyled the job list rows as hover-highlighted cards with pill badges (agent type, schedule, disabled) and right-aligned actions, and gave the modal a divider-topped Cancel / Save footer.

## 1.3.0

### Minor Changes

- Community release: 16 contributor PRs reviewed (multi-agent adversarial review), fixed, and merged. Thanks to @aakhter, @TeigenZhang, @chatgptkrylor, @kvncrw, and @pirronewantlux529-coder!

  **New features**
  - **Cron jobs** (#141, @chatgptkrylor): recurring scheduled jobs (once/interval/daily/weekly) that spawn a session and send a prompt when due — CRUD + run history (`/api/cron/*`), ⏰ modal UI, per-job concurrency policy and `autoClosePreviousSession` lifecycle, pure unit-tested next-run math. Distinct from the legacy `ScheduledRun`.
  - **Remote host SSH cases** (#145, @aakhter): link cases on remote hosts (`remote-hosts.json`/`remote-cases.json`), launch sessions over ssh into a durable remote tmux (dedicated `-L codeman-remote` socket; adoption-safe naming), per-host command overrides, injection-guarded schemas, remote tmux probe + ConnectTimeout, remote kill on delete, recovery-safe persistence.
  - **Command-K session palette + searchable case picker + shortcut registry** (#146, @aakhter): Ctrl/Cmd/Alt+K fuzzy session palette with "Browse all sessions" Session Manager; searchable quick-start case picker (remote-aware labels); rebindable shortcut registry with App Settings → Shortcuts tab and Ctrl+? overlay.
  - **Unified session list** (#139, @aakhter): `GET /api/sessions/unified` merges live/persisted/lifecycle/transcript sessions into one deduped list (resumed sessions fold via claudeSessionId alias map).
  - **Unified Session Manager UX** (#153, @aakhter): unified welcome list with mode/LIVE badges + per-row kebab menu, `projectKey` plumbing for "View all in this folder", SSE-driven live list refresh, desktop Session Manager header button.
  - **Full-scrollback replay** (#148, @aakhter): page reload replays the entire tmux scrollback (`?full=1`, bounded capture with proper maxBuffer) with CRLF normalization for shell panes.
  - **WebSocket resilience** (#149, @aakhter): reconnect with preserved exponential backoff, per-tab connection identity (multi-tab safe), ACK re-drive, and a truthful connection chip (WS/HTTP/reconnecting states).
  - **PTY-exit circuit breaker + TMUX scrub** (#147, @aakhter): rapid PTY crash-loops trip a breaker (SSE + critical push notification; explicit-restart-only reset); inherited TMUX vars are scrubbed so Codeman-in-tmux doesn't nest.
  - **Codex generated-artifact attachments** (#150, @aakhter): codex sessions surface `Saved to: file://…` outputs as attachment cards (realpath-anchored trust, codex-mode-gated, jpg/gif/webp thumbnails).
  - **Codex response viewer** (#152, @pirronewantlux529-coder): the eye button now works for Codex sessions via 4-layer rollout resolution (history pin → originator → resume-UUID → cwd) with dedup + injected-context filtering.
  - **HEIC paste conversion** (#151, @aakhter): iPhone HEIC pastes convert to JPEG server-side in a worker thread (concurrency-capped, 64MP decompression-bomb guard, magic-byte detection for mislabeled Android HEIFs). Deps: heic-decode + jpeg-js.
  - **WebGL renderer toggle** (#140, @kvncrw): per-device setting to switch xterm between WebGL and DOM renderers, cooperating with the GPU-stall auto-fallback marker.
  - **Raised terminal history defaults** (#138, @aakhter): tmux history-limit 50k→100k lines, PTY buffer 2MB/1.5MB→32MB/24MB (env-clamped so trim always stays below max).

  **Mobile & input fixes**
  - CJK input loss fixes: IME state machine, focus routing, Android InputConnection recovery — with content-free diagnostics (#143, @TeigenZhang).
  - Tap/click/wheel restored when the server strips mouse DECSETs — version-gated wheel passthrough (claude ≥ 2.1.187), link-click double-fire fix, Shift+wheel documented (#144, @TeigenZhang).
  - Response-viewer readability on phones + iOS dvh viewport fix (#142, @TeigenZhang).

  **Docs**: CLAUDE.md accuracy audit (18 verified fixes: security hook-bypass description, env-prefix allowlist, state-file inventory, watcher/function names, counts) + documentation for all new subsystems. README gains a user walkthrough (#141).

  All PRs went through adversarial multi-agent review; ~60 verified findings (including 12 blockers) were fixed on the contributors' branches before merge. Full test suite green: 3,400+ tests.

### Patch Changes

- bf36eb0: Add a **WebGL Renderer** toggle to Settings → Appearance (desktop). WebGL stays on by default; turning it off forces the DOM renderer for users who hit GPU glitches, without needing the `?nowebgl` URL param. Turning it back on (or `?webgl=force`) clears any stale auto-fallback marker. The existing mobile skip and long-task auto-fallback safety net are unchanged. The skip decision is factored into a pure, unit-tested `shouldSkipWebGL()` helper.

## 1.2.2

### Patch Changes

- Centralize terminal history/scrollback/buffer retention limits into config (PR #137, COD-80).

  New `src/config/terminal-history.ts` is now the single source of truth for the terminal scrollback lines, tmux `history-limit`, and server PTY buffer byte caps that were previously scattered as hardcoded literals across `buffer-limits.ts`, `tmux-manager.ts`, and `session.ts`. Each value is overridable (env var or the settings object) and bounds-clamped via a pure `resolveTerminalHistoryConfig()`.

  This change is behavior-neutral: the defaults intentionally match the prior hardcoded values (tmux history-limit 50,000; terminal scrollback 50,000; PTY buffer max 2 MB; trim 1.5 MB) and the existing `CODEMAN_MAX_TERMINAL_BUFFER` / `CODEMAN_TRIM_TERMINAL_TO` env overrides are preserved, so runtime behavior is unchanged on its own. It is the mechanism half of a stacked change; a follow-up raises the defaults.
  - `buffer-limits.ts` sources `MAX_TERMINAL_BUFFER_SIZE` / `TRIM_TERMINAL_TO` from the resolver.
  - `tmux-manager.ts` uses `DEFAULT_TMUX_HISTORY_LIMIT` in place of the hardcoded `history-limit 50000`, gains `setHistoryLimit()` (mux-interface + impl) so a settings change applies to live sessions, and re-applies the limit on `respawnPane` so it survives a respawn.
  - `session.ts` threads a per-session `tmuxHistoryLimit` into the tmux spawn calls; `server.ts` exposes `getTerminalHistoryConfig()` on the route ctx and `system-routes.ts` applies a changed `tmuxHistoryLimit` to live sessions immediately.
  - `schemas.ts` adds four optional, bounds-clamped settings keys (`terminalScrollbackLines`, `tmuxHistoryLimit`, `terminalBufferMaxBytes`, `terminalBufferTrimBytes`) with a `trim <= max` cross-field check.
  - New tests: `test/terminal-history.test.ts` (resolver defaults / clamping / trim<=max / non-number fallback) and `test/terminal-history-schema.test.ts` (settings-schema validation).

## 1.2.1

### Patch Changes

- Fix local echo on iOS Safari when switching into a tab whose session already has output. The on-screen-keyboard "heal" (refit + scroll-to-bottom + overlay re-render + one-shot resize) only ran on a keyboard visibility transition, so switching into a tab while the keyboard was already up never triggered it — leaving the local-echo overlay rendering against stale, off-bottom terminal state. Typed characters were invisible (or mispositioned at the cursor row, far below the actual `❯` prompt) until the user manually hid and re-showed the keyboard. `selectSession` now replicates that heal when the keyboard is already visible, so local echo paints correctly on the first keystroke after a keyboard-up tab switch.

## 1.2.0

### Minor Changes

- Merge four feature PRs and harden them for release.

  **Gemini run mode (PR #134, COD-36)** — a third external-CLI backend alongside Codex and OpenCode (`SessionMode` adds `'gemini'`). New `gemini-cli-resolver.ts`, `buildGeminiCommand()` (`--skip-trust`, `--approval-mode {default|auto_edit|yolo|plan}` defaulting to `yolo`, `--model`, `--resume`), `setGeminiEnvVars()` (socket-scoped `tmux setenv` of `GEMINI_*`/`GOOGLE_*` auth incl. Vertex AI), `GET /api/gemini/status` with an install hint (`npm install -g @google/gemini-cli`), run-mode dropdown + welcome "Run Gemini" button + "Run GM" label, `GeminiConfigSchema`, and `GEMINI_*`/`GOOGLE_*` added to the env-override allowlist. Requires tmux (no PTY fallback), like Codex.

  **Cross-session search (PR #133, COD-113)** — `GET /api/search?q=&types=&limit=` federates an in-memory search across session metadata, run-summary events, and attachment-history file entries (substring match, hard caps, no FS reads); history-panel search box in the frontend.

  **Away digest (PR #136, COD-41)** — `GET /api/away-digest` aggregates "what happened while you were away" (lifecycle log, run summaries, live sessions, daily token stats, recent subagents) into categorized sections behind a header-button modal (hidden on phones).

  **Ralph todo-config (PR #135, COD-79)** — per-session `maxTodos` and `todoExpirationMinutes` via `POST /api/sessions/:id/ralph-config`; now persisted in `RalphTrackerState` and read back into the Session Options modal (mirrors `maxIterations` round-trip).

  **Review fixes applied on merge:**
  - Gemini: fixed two `{success,data}` envelope bugs in `runGemini()` (status check and new-session selection) that made the Run-Gemini button non-functional; fixed `setGeminiEnvVars()` to use the socket-scoped tmux command so Google-auth env injection actually reaches the session.
  - Gemini parity: tab-mode badge, kill-dialog label, `codeman doctor` registry entry, `isGeminiAvailable` barrel export, `COLORTERM=truecolor`, and alt-screen/scrollback stripping (Ink TUI, like Codex/Claude).
  - Restored four envelope-shape test assertions weakened during the Gemini PR; added a `runGemini()` regression test covering the envelope path.
  - Ralph todo-config values now persist across restart and read back correctly instead of always reverting to defaults.

## 1.1.17

### Patch Changes

- Fix the connection indicator flashing "Sending 1B…" on every keystroke. The reliable input-delivery layer (1.1.16) marks each keystroke as briefly pending until its ACK arrives a few milliseconds later, which made the indicator flash on every character while typing on a healthy connection. The indicator is now hidden whenever the connection is healthy and only appears for an actual problem (reconnecting/offline), where it still shows the queued byte count so you know buffered input will be sent.

## 1.1.16

### Patch Changes

- Mobile image uploads, reliable input delivery, and gesture window dragging.

  **Mobile image uploads (camera-roll picker / drag-drop / paste).** The "🖼 Image" button now handles real photo batches: up to 20 images per batch uploaded with bounded concurrency and a live "Uploading N/M…" progress toast (with a summary of successes, failures, and whether the 20-cap trimmed the selection). The per-file limit is raised from 10MB to 50MB (`MAX_PASTE_IMAGE_BYTES`, env-overridable via `CODEMAN_MAX_PASTE_IMAGE_BYTES`) so full-resolution phone photos and large screenshots are accepted. Very large images are downscaled to ≤4096px on the longest edge before upload, fixing iOS Safari's ~16.7M-px `<canvas>` limit that previously made huge photos fail to re-encode. Also fixes a latent concurrency bug the batch path exposed where the first parallel uploads to a session raced on creating `.claude-images/` and failed with EEXIST.

  **Reliable, exactly-once input delivery.** A "sent" prompt could be silently lost on a flaky connection (e.g. a train): a half-open WebSocket accepts `ws.send()` without error while discarding the frame, and nothing was queued or resent. Input is now recorded durably (localStorage) with a stable clientId + monotonic per-session sequence before delivery, and only dropped once the server ACKs it — delivered over the WebSocket (acked via `{t:'ia',seq}`) or, when the socket is down, over POST in order. A 2s sweep force-reconnects a half-open socket; pending input survives reconnects and page reloads. The server applies each `(clientId, seq)` at most once (`Session.shouldApplyInput`), so an at-least-once resend can never type the prompt twice. Untagged input (curl/legacy) is unchanged. See `docs/reliable-input-delivery.md`.

  **Gesture beta: drag agent windows.** With the camera hand-tracking overlay, you can now pinch and move the floating subagent and ultracode run/transcript windows. They keep their glowing connector line to the session tab while moving and can travel across a multi-monitor seam.

## 1.1.15

### Patch Changes

- Security: harden all frontend inline `onclick`/`ondblclick` handlers against a stored-XSS double-context bug.

  Many inline handlers interpolated values as `'${escapeHtml(value)}'` — a JavaScript string literal sitting inside an HTML attribute. The browser HTML-decodes the attribute value _before_ parsing the handler source, so `escapeHtml`'s `&#39;` reverts to a literal `'` and a quote-bearing id/name/path/URL breaks out of the JS string into executable code. `escapeHtml` alone is insufficient for this JS-string-within-HTML-attribute context.

  All affected handlers now use `escapeHtml(JSON.stringify(value))`: `JSON.stringify` JS-encodes and quote-wraps the value, then `escapeHtml` handles the HTML-attribute layer, so the value round-trips as a single inert string argument.
  - ultracode run/agent cards and minimized-tab badges (`ultracode-panel.js`, `ultracode-windows.js`) — PR #132.
  - Session tabs (click/rename/gear/detach/close), notifications, subagent windows + dropdowns, the agents/tools/log-viewer/image-popup panels, mux-session monitor rows, and case-management buttons (`app.js`, `notification-manager.js`, `subagent-windows.js`, `panels-ui.js`, `session-ui.js`).
  - Two non-`escapeHtml` variants of the same class: a pre-escaped mux-session id in `panels-ui.js` (`selectSession`/`killMuxSession`) and a fully raw, unescaped `phase.id` in `orchestrator-panel.js` (`orchestratorSkipPhase`/`orchestratorRetryPhase`).

  The most realistic exploitation vector was file paths in the project-insights log-viewer link, since filenames can legally contain a single quote. Purely numeric interpolations and developer-literal handler strings were left unchanged.

## 1.1.14

### Patch Changes

- Ultracode (Workflow-tool) floating windows — agent transcripts in-page, and minimize-to-tab.
  - **Agent transcripts open in-page, connected, instead of a detached browser popup.** Clicking an agent card (in a run window or the dock panel) now opens the agent's live transcript as its own draggable floating window, tied by a connector line to its parent run window (falling back to the run's session tab if that window has since closed) — the same line idiom the run windows use. Re-clicking a card focuses the existing window; closing it removes the window and its line. (Previously this spawned a separate `window.open` browser popup.)
  - **The window "−" button now minimizes into the originating session tab**, mirroring the subagent-window idiom. The window genie-animates into its tab and is tracked there; the tab shows an `ULTRA` badge whose hover/click dropdown lists each minimized item (🧬 run windows, 📄 agent transcripts). Click an item to restore its floating window, or dismiss it with ×. A run minimized while still active keeps tracking in the background and its badge auto-clears shortly after the run finishes. Both run windows and agent-transcript windows minimize into the same merged badge.
  - Removed the old collapse-to-header behavior that the "−" button previously triggered (now superseded by minimize-to-tab).

## 1.1.13

### Patch Changes

- Keep the `/compact` button in the extended (full) mobile keyboard accessory bar; only the simple bar drops it. (1.1.12 had removed it from both.)

## 1.1.12

### Patch Changes

- Remove the `/compact` button from the mobile keyboard accessory bar. It had been reintroduced in 1.1.10; this removes the button from both the simple and full accessory-bar layouts (the underlying command handler is left in place as inert plumbing).

## 1.1.11

### Patch Changes

- Ultracode (Workflow-tool) run visualization — much better live tracking.

  While a run is in flight, the watcher previously showed empty agent slots ("agent N", 0 tokens, raw `wf_…` id as the title) because the detailed completion JSON only lands when the run finishes. The live path now enriches in-flight runs directly from the on-disk transcript tree:
  - **Real per-agent stats mid-run** — tokens and tool-call counts are parsed from each `agent-<id>.jsonl` transcript (tool counts match the final accounting exactly; token totals land within ~1% of the completion value), with model and a prompt preview. All mtime-cached (transcripts, journal, and script meta) so idle polls do no extra reads.
  - **Readable window/run title** — workflow name, summary, and phases are derived from the persisted `workflows/scripts/<name>-<runId>.js` instead of showing the raw run id.
  - **Agent status colors** — done agents show green, working agents show yellow (this also fixes the run/agent status badges, which referenced undefined `--success`/`--warning` CSS variables and were rendering with no color).
  - **Connector line** — the floating-window → session-tab line now uses the session-tab accent blue (was purple).
  - **Click a run to open its floating window** — clicking a workflow in the dock panel opens (or focuses) its floating window with the connector line, in addition to the auto-popped windows.
  - Agents are ordered by journal launch order; concurrent run-detail fetches are de-duplicated.

## 1.1.10

### Patch Changes

- Mobile CJK input, iPad keyboard accessory bar, and terminal touch interaction fixes (PRs #130, #131).

  Mobile / CJK (#130):
  - Restore reliable real-time CJK (e.g. Pinyin) composition in the always-visible textarea, and refocus input when the terminal is tapped.
  - Stop clearing the textarea during `compositionstart` — some IMEs include existing text in the composition region, and clearing it mid-composition corrupted input.
  - iPad-specific fixes: `#cjkInput` positioning, paste-dialog placement, and duplicated voice-dictation output.
  - Split CJK keyboard positioning by device size (phones vs iPad use different keyboard offsets).
  - iPad accessory-bar styling/positioning: moved the accessory-bar and paste-overlay base styles out of the `max-width:1023px`-gated mobile stylesheet so iPad landscape (≥1024px) renders them correctly.
  - Raise the toolbar stacking context while the case-settings popover is open so the popover is no longer hidden behind the toolbar.
  - Restore the `/compact` button to the keyboard accessory bar (with double-tap confirmation, like `/clear`); the paste dialog now submits pasted text on "Send".

  Terminal touch + forced redraw (#131):
  - Enable terminal touch interaction on all touch devices and show the stop button on touch devices.
  - Add an 8px tap threshold so micro-drift is treated as a tap, not a scroll, fixing cases where a tap failed to register.
  - Tap-to-position the cursor via a synthesized mouse report, gated on the live mouse-tracking mode so it never triggers local text selection when tracking is off; let SGR mouse reports through to the PTY even while the CJK input field owns focus.
  - Suppress the cursor/momentum side effects of a sub-threshold tap so a jittery tap no longer both positions the cursor and starts a momentum fling.
  - New opt-in, per-device "Redraw Terminal" header button (`showRedrawButton`, default off) that forces an xterm redraw via a resize jitter to clear occasional rendering glitches; the resize path now accepts a `force` flag (threaded through the session, HTTP, and WebSocket resize routes) that guarantees a SIGWINCH/redraw at the current device's size without bypassing multi-client resize arbitration.

## 1.1.9

### Patch Changes

- Two welcome-screen tunnel changes:
  - **UI (Daylight Blue skin):** the **Cloudflare Tunnel** button is now purple (was orange/yellow), keeping the three welcome buttons visually distinct — Claude blue, Tunnel purple, OpenCode green.
  - **Enable a tunnel without `CODEMAN_PASSWORD`, with a warning.** Previously enabling the Cloudflare tunnel with no password set was hard-refused unless you set `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1`. Now you can opt in straight from the browser: clicking the tunnel toggle without a password pops a **security confirm dialog** ("publishes this machine to a public URL with no login — effectively remote code execution; set CODEMAN_PASSWORD instead"), and only on confirm does it enable, sending an explicit per-request `acknowledgeUnauthTunnel:true`. The server logs a loud warning whenever a passwordless public tunnel starts. curl/API/CLI callers are unchanged — still refused unless they set a password, set the env var, or pass `acknowledgeUnauthTunnel:true` — so nothing gets exposed accidentally. The acknowledgment is an action field and is never persisted to settings.json.

## 1.1.8

### Patch Changes

- UI (Daylight Blue skin): give the welcome-screen action buttons distinct colors instead of all reading blue. **Run Claude Code** keeps the blue accent, **Cloudflare Tunnel** now uses Cloudflare's brand orange, and **Run OpenCode** uses an emerald green — so the three are visually distinguishable at a glance. Scoped to the default `daylight-blue` skin only (daylight-green and OG are unchanged), with matching hover/active states and dark ink for contrast. Verified in a real browser: the three buttons compute to blue / orange / green gradients on the welcome overlay.

## 1.1.7

### Patch Changes

- Fix: terminal scroll-up (scrollback) intermittently breaking for **Claude** sessions — most visible on iPhone, where you suddenly "can't scroll up the Claude console."

  Root cause: Claude Code periodically emits alternate-screen switches (`\x1b[?1049h`/`\x1b[?47h`/`\x1b[?1047h`), scrollback-erase (`\x1b[3J`), and mouse-tracking enables — typically when it draws a full-screen UI (pickers/dialogs, the boot welcome). xterm.js obeys these by moving to the scrollback-less alternate buffer (or wiping saved lines / hijacking the wheel), so the conversation history becomes unreachable until Claude returns to its normal view. Codeman already stripped these sequences so history stays scrollable, but the strip was gated to **Codex mode only** — Claude (and the equivalent buffer-replay path) let them through.

  The strip is now shared via a single `isAltScreenStripMode(mode)` predicate (`codex || claude`) applied at BOTH sites that were Codex-only: the live PTY stream (`Session._handleTerminalOutput`, including the split-across-chunks carry reassembly) and the `/terminal` buffer replay used on tab-switch/reconnect. `shell` is deliberately excluded so full-screen TUIs run from a shell (vim/less/htop) keep their alternate screen; `opencode` is also unchanged.

  Verified end-to-end on an isolated instance against a real Claude session: the replayed buffer and live stream now carry zero alt-screen/scrollback-erase/mouse sequences, the terminal stays in the normal buffer with scrollback intact, and touch swipe-up scrolls correctly. Covered by new unit tests (`test/claude-scrollback-strip.test.ts`); the existing Codex strip tests are unchanged.

## 1.1.6

### Patch Changes

- Fix: ultracode floating run windows now pop on a fresh device/browser that loads while a run is already active.

  `ultracodeFloatingWindows` syncs from the server (it's a non-display setting), but on a first-time device the SSE `getLightState` run snapshot can seed the run list BEFORE the async settings load resolves — so the floating-window gate read `false` at that instant and skipped any already-active run, leaving the window un-popped until the next ~10s watcher tick. The app now re-runs `syncAllUltracodeFloatingWindows()` once server settings finish loading (in the `loadAppSettingsFromServer().then()` callback), so an in-flight run pops its window immediately. Idempotent: open windows are left as-is, and if the setting is off any premature windows are torn down. Verified end-to-end against a real in-flight run on an isolated instance — a pristine browser (empty localStorage) seeds the setting from the server and pops the active run's window ~0.4s after first paint.

  Also corrected a stale `@fileoverview` comment in `ultracode-windows.js` that claimed the floating windows are gated on `showUltracodeAgents`; they are gated on the dedicated `ultracodeFloatingWindows` toggle (only the docked "Ultracode Agents" panel uses `showUltracodeAgents`).

## 1.1.5

### Patch Changes

- Fix: the Ultracode Agents panel's (×) Close button now fully hides the panel.

  `closeUltracodeAgentsPanel()` only removed the `open` class, which drops the bottom-docked drawer to its collapsed _peek_ state (the 36px header strip stays visible) rather than closing it — so clicking (×) looked like it did nothing. It now also adds the `hidden` class (`display:none`), mirroring `closeSubagentsPanel()`. It deliberately does NOT flip the `showUltracodeAgents` setting (that also gates the run watcher and floating windows); the header launcher button reopens the panel. Verified in a real browser: after (×) the panel computes `display:none`.

## 1.1.4

### Patch Changes

- Fix: ultracode floating run windows (and the live dock panel) now appear DURING an in-flight Workflow/ultracode run, not only after it finishes.

  The Workflow runtime writes the run-state file `…/workflows/wf_<id>.json` only at completion (always a terminal status); while a run is live, its only on-disk state is the sibling `…/subagents/workflows/wf_<id>/` transcript tree. `workflow-run-watcher` previously scanned only the completion file, so it never observed a run until it was already terminal — and the floating-window auto-pop is gated on an ACTIVE run, so it never fired for a live run (the feature was effectively dead for in-flight runs).

  The watcher now ALSO scans the `subagents/workflows/wf_<id>/` transcript tree and synthesizes a minimal ACTIVE run (status `running`, agent slots keyed by their `agentId` so the agent-card → live-transcript click still works, `lastActivityAt` from the newest agent/journal mtime, per-agent done/running derived from the run journal's `result` events) when no completion file exists yet. When the run finishes, the real `wf_<id>.json` supersedes the synthesized record (same runId), restoring full phase/token detail and the normal finish → 8s-grace auto-close flow. The watcher stays standalone (it never imports subagent-watcher). Verified end-to-end against a real in-flight run; adds unit coverage for live synthesis, agentId preservation, journal-derived state, empty-dir skipping, and completion-file precedence.

## 1.1.3

### Patch Changes

- Ultracode floating run windows + a dedicated toggle to control them.
  - **New: floating ultracode run windows.** When enabled, each active ultracode / Workflow run pops a small draggable window (like the file browser) connected by a glowing line to its originating session tab — the same connector-line idiom as subagent windows. The tab is resolved by matching the run's `sessionUuid` to a session's `claudeSessionId`. The window mirrors the live agent grid (phases, per-agent model / tokens burned / tool calls / state), auto-closes a few seconds after its run finishes, and remembers windows you explicitly dismiss so they don't re-pop. These windows are **additional to** the existing docked "Ultracode Agents" master-detail panel, which is unchanged.
  - **New setting "Ultracode Floating Windows"** (App Settings → Display), **default OFF**, independent of the "Ultracode Agents" panel toggle. Either toggle now starts the server-side workflow-run watcher (at boot and on live settings change), so the floating windows work even with the docked panel off.
  - Internals: new frontend module `ultracode-windows.js` (load order 15.5); ultracode connector lines are appended into the shared `#connectionLines` SVG within the existing batched read/write reflow pass in `subagent-windows.js`; new `ultracodeFloatingWindows` app-settings key in `schemas.ts`; watcher gating in `server.ts` + `system-routes.ts` now ORs both ultracode toggles.
  - Docs: `CLAUDE.md` brought up to date for the 1.1.2 ultracode/workflow-run subsystem (Agents / Frontend / Types / Config inventories, JS load order, a Key Patterns entry) and the new floating-windows feature.

## 1.1.2

### Patch Changes

- Ultracode/Workflow run visualization + subagent discovery fixes.
  - **Ultracode / Workflow run visualization** (new, opt-in): App Settings → Display → "Ultracode Agents" (`showUltracodeAgents`, default OFF) adds a master-detail tab that shows ultracode / Workflow-tool runs like Claude Code's "working agents" view — the LEFT pane lists runs and their phases (selectable tasks), the RIGHT pane shows each run's agents with model, live state, tokens burned, and tool calls. Clicking an agent opens its live transcript. Backed by a new standalone workflow-run watcher that reads the per-run state JSON (stripping the heavy embedded script/result/logs so payloads stay small), exposes `GET /api/workflows` and `GET /api/workflows/:runId`, and broadcasts `workflow:run_discovered/updated/removed` SSE events. The header launcher and panel stay hidden until the setting is enabled (the setting is synced across devices, not per-device).
  - **Subagent tracking discovery fix**: restored subagent tracking after Claude Code changed the on-disk format from `agent-*.jsonl` to `agent-*.meta.json` (background agents were showing 0). Also discovers workflow-nested subagents under `subagents/workflows/<wf>/` and hardens the meta→transcript upgrade path so an agent re-points to its `.jsonl` transcript once it appears.
  - **File viewer**: opens audio, SVG, and other binary files the same way the attachments viewer does.
  - **Tooling**: hardened the real-overview screenshot capture script and documented the `deviceScaleFactor` / static-cache gotchas.

## 1.1.1

### Patch Changes

- Six reviewed contributor PRs (all adversarially reviewed and fixed before merge):
  - **Markdown sanitizer hardened against mutation-XSS (#126).** The denylist `_sanitizeHtml` is replaced with vendored DOMPurify 3.4.8 (authentic, byte-matched to the official dist) wired via a new `sanitize-html.js` allowlist, with a fail-closed escape fallback. The curated allowlist is genuinely enforced (no `USE_PROFILES` override) so non-markdown tags and svg/math/style/script/event-handler/`javascript:` vectors are stripped while legitimate markdown survives.
  - **Hook-event secret now required unconditionally (#127).** The `/api/hook-event` + `/api/status-telemetry` localhost bypass requires the per-instance hook secret whether or not a managed tunnel is running, closing the own-loopback-reverse-proxy gap. A self-heal refreshes pre-secret hook configs in existing cases on spawn so password-protected installs don't silently 401 their hooks. No-password loopback installs are unaffected.
  - **`codeman doctor` dependency checker (#125).** New `doctor`/`check-deps` command probes Node, the agent CLIs, tmux, and document converters per environment (linux/darwin/win32/wsl), with grouped or `--json` output and a non-zero exit when a required tool is missing. Requires Node 22+, reports `pdftoppm` (used for PDF/Office thumbnails), and validates `--category`.
  - **macOS Option / physical-key session shortcuts (#129).** Tab switching matches physical key codes (`e.code`) so Option+1–9 works on macOS layouts that remap Option, plus Option/Alt+`[`/`]` for previous/next session — without leaking escape sequences into the focused terminal.
  - **Desktop session tabs auto-wrap to a second row on overflow (#128)** instead of horizontal scrolling (off when the manual two-row layout is pinned; mobile/tablet unchanged), re-evaluated on window resize.
  - **CJK input textarea hidden on the welcome screen (#123)** so it no longer floats over the welcome overlay, and re-shown on session entry; vertical centering fixed.

## 1.1.0

### Minor Changes

- **Plan Usage Limits chip (new).** A header chip now shows your live Claude plan usage — the 5-hour and weekly windows as a percentage — parsed from Claude Code's statusLine telemetry (CLI v2.1.80+). It's opt-in via **App Settings → Display → "Plan Usage Limits"** (default OFF). The toggle is **per-device**: turn it on at your desk without it appearing on your phone. Telemetry collection is decoupled from display, so one device's preference never affects another's, and the last-known value replays instantly on reconnect. Distinct from auto-resume (which reacts to the limit _message_) — this proactively shows the live %.

  **Attachments.** New attachment history drawer to browse files referenced by a session (COD-39), plus document previews and thumbnails on attachment cards (COD-38). The header **Attachments button is now opt-in** (default OFF) via **App Settings → Display → "Attachments Button"**, per-device like the Response Viewer button.

  **Settings & models.** Added Opus 4.6 options to the Claude Model picker. Removed the legacy Token Count / Show Cost header toggles and moved Plan Usage Limits to the top of the Display settings. Slimmed the Skin picker control to match its row.

  **Mobile & header polish.** Restored the response-viewer (eye) button on phones; kept the phone header minimal (settings gear + lifecycle log stay in the toolbar). Added two regression guards so header controls can't silently leak onto the mobile header again — a CI-runnable static policy check plus a real-browser E2E test.

## 1.0.0

### Major Changes

- # Codeman 1.0.0 🎉

  The first stable release of Codeman — and it comes with a fresh new look.

  **New: theme skins.** Codeman now ships a built-in skin switcher (App Settings → Display → Appearance):
  - **OG Codeman** — the original look, preserved exactly.
  - **Daylight Green** — a fresh emerald-on-slate theme.
  - **Daylight Blue** — bright sky-blue on lifted slate (the new default).

  Skins apply instantly, persist per device (with a pre-paint script so there's no flash on load), and re-theme any open terminals live. The system is built on `html[data-skin]` design tokens and self-hosted Manrope (UI) + JetBrains Mono (terminal) fonts — no external CDN, CSP-safe.

  **1.0.0 milestone.** This marks the start of the stable 1.x line: the CLI, documented environment variables, and the `{ success, data }` HTTP/SSE API envelope follow semantic versioning (see `docs/versioning-policy.md`).

  **Thank you to everyone who helped build Codeman.** This release is dedicated to all of our contributors for their work on the project: Ark0N, Aamer Akhter (@aakhter), Tenggan Zhang (@TeigenZhang), zhouyuan / @sunnyzhouy, jaypark, Marco Migozzi, Skúli Arnlaugsson, Aaron Fields, Loïc Sculier, and Noah Waldner (@noahwaldner). 💙

## 0.9.14

### Patch Changes

- Security hardening for the tunnel exposure path, Codex terminal rendering fixes, and a mobile modal fix.

  **Security (PR #115, COD-54/COD-55):**
  - `/api/hook-event` localhost bypass is now gated while the managed Cloudflare tunnel is running: tunneled traffic arrives with a loopback source IP, so the bypass additionally requires a per-instance shared secret (`X-Codeman-Hook-Secret`, 256-bit, `~/.codeman/hook-secret`, mode 0600). Locally generated hook commands read the secret file at execution time via `$CODEMAN_HOOK_SECRET_FILE` (exported into every managed session's environment), so the value never lands on command lines or in case configs, and running sessions pick up a new secret without respawn. Failed presentations rate-limit in a dedicated per-IP bucket so misfiring legacy hooks can never lock out the Basic-Auth login path. With no tunnel running, behavior is unchanged.
  - Enabling the Cloudflare tunnel now **refuses with 403** when no `CODEMAN_PASSWORD` is set (a public tunnel URL with no auth is effectively public RCE), unless `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` explicitly acknowledges the exposure. The settings UI surfaces the refusal as an error toast and reverts the toggle.

  **Codex rendering (PRs #116, #117):**
  - Alt-screen toggles (`?47/?1047/?1049`), scrollback-erase (`CSI 3 J`), and mouse-tracking enables (`?1000`–`?1007`) are stripped from the Codex byte stream (live + replay), so conversation history survives tab switches and the scroll wheel scrolls the viewport instead of being hijacked. Sequences split across PTY chunk boundaries are reassembled via a small carry before stripping, so a split `?1049h` can no longer trap xterm in the scrollback-less alt buffer.
  - Smaller 32KB first-frame write budget for Codex sessions keeps dense synchronized redraws from stalling the renderer; a 1.5s grace window after a manual scroll-up suppresses sticky-scroll so high-frequency `• Working (Ns)` status ticks no longer snap the viewport back to the bottom while reading earlier output.

  **Mobile:** session-options modal raised above the fixed mobile/tablet header (z-index 1300 vs 1200) so the close button is reachable on phones; Respawn tab controls regrouped.

  **Docs:** security-architecture.md updated for the secret-gated hook bypass (including the external-proxy caveat) and the tunnel password guard; README documents auto-resume on usage limit.

## 0.9.13

### Patch Changes

- Auto-resume on usage limit ("token pause" control) plus a set of mobile-view fixes for regressions introduced in 0.9.8.

  **Auto-resume on usage limit** — new opt-in checkbox at the top of the session Respawn tab (off by default). When Claude stops because a usage limit was reached, Codeman parses the reset time from the limit message, waits until the limit lifts (plus a 2-minute safety buffer), then dismisses the rate-limit dialog (Esc) and sends "continue" so the session picks its work back up automatically. All Claude Code message formats from 1.0.x through 2.1.x are recognized ("5-hour limit reached ∙ resets 8pm", "Limit reached · resets 1pm (America/Chicago) · /upgrade…", "You've hit your weekly limit · resets Mon 12:00am", weekly date forms, and the raw API `usage limit reached|<epoch>` form). Still-limited responses re-arm the scheduler (5-minute retry loop); a pending schedule persists across Codeman restarts and re-arms on boot; respawn cycles are blocked while a limit pause is active so the cycle's `/clear` cannot wipe the paused conversation. New endpoint `POST /api/sessions/:id/auto-resume`; new SSE events `session:limitPauseScheduled`, `session:limitResume`, `session:limitResumeCancelled`; toast/notification on pause and resume, plus a live "resumes at HH:MM" status line in the modal. The Respawn tab layout was also tidied: compact single-row Update/Kickstart prompt fields and a merged options row.

  **Mobile fixes (0.9.8 regressions)**:
  - **Activity-based resize arbitration** — a desktop sizing claim now only blocks a phone's resize while that desktop has actually typed within the last 90 seconds. Previously any connected desktop tab (even one abandoned hours ago) silently discarded the phone's resize with no fallback, leaving the phone rendering a desktop-width stream in a narrow terminal: mid-word wraps, tmux dot-fill rows, overdrawn garbled text, and misplaced keyboard echo. Now an idle desktop yields the pane to the phone, and the next desktop keystroke automatically restores the desktop layout ("whoever is actively using the session wins"). Phones also re-send their dimensions every 30 seconds (visible tab only, skipped while the virtual keyboard is open) so attaching under a momentarily-active desktop self-corrects.
  - **Keyboard accessory bar and toolbar restored on iOS** — the lift offset is measured against the layout viewport (`window.innerHeight`) again instead of the keyboard-shrunken app element; on iOS the offset computed to 0, leaving both bars hidden behind the OS keyboard with a dead black gap above it.
  - **Removed the mobile header utility ("three dots") toggle** — the header-utilities tray stays collapsed on small viewports.

## 0.9.12

### Patch Changes

- Documentation refresh — README catches up with the Codex run mode, plus a CLAUDE.md correction.

  **README (en + zh-CN)**: Codex is now listed as a third supported AI coding CLI everywhere the docs previously said "Claude Code or OpenCode": the install requirement in Quick Start (now "any combination works", linking to the official Codex CLI docs), the Windows/WSL setup note, the renamed **Multi-CLI** feature bullet (env-prefix gating now reads `CLAUDE_CODE_*` vs `OPENCODE_*` vs `CODEX_*`), the Zod schema-validation security bullet, and the architecture mermaid diagram. The header tagline was also finalized to "Claude Code • OpenCode • Codex — One Dashboard • Any Device" in both languages.

  **CLAUDE.md**: fixed a stale "Local packages" line that claimed the xterm-zerolag-input local-echo overlay had a copy embedded in `app.js` — it is single-source in `packages/xterm-zerolag-input/`, bundled to the gitignored vendor file, and only consumed by `app.js`, matching the existing single-source gotcha.

## 0.9.11

### Patch Changes

- Fix a terminal freeze on hover (catastrophic regex backtracking) and a CSP violation that disabled the terminal's anti-throttling worker.

  **Tab-freezing hover bug**: the terminal link provider's `cmdPattern` (which turns `tail -f /path`-style text into clickable links) used an empty-matchable, unbounded arg group — `(?:[^\s\/]*\s+)*` — that backtracks exponentially on real Claude output, e.g. wrapped `git commit -m "$(cat <<'EOF'` heredoc lines or aligned table rows. Hovering the mouse over such a line hung the page's main thread for minutes ("page unresponsive"). The pattern now uses non-empty tokens with bounded repetition (linear time); all intended command+path link forms still match. New `test/link-provider-regex.test.ts` extracts the shipped patterns from source and pins linear-time behavior on the killer line shapes.

  **Blob worker CSP fix**: `worker-src 'self' blob:` is now always present in the CSP (previously only with `CODEMAN_GESTURE=1`). The terminal's `_safeYield` anti-throttling tick worker is created from a Blob URL and was silently blocked on every install, logging a CSP violation on each page load and disabling the worker leg of the render-yield fallback chain.

## 0.9.10

### Patch Changes

- Self-update now restarts automatically on headless Macs supervised by a system LaunchDaemon.

  New `launchd-daemon` supervisor kind: when Codeman runs under a bootstrapped, KeepAlive system-level LaunchDaemon (`/Library/LaunchDaemons/com.codeman.web.plist` — the right setup for headless Macs, where LaunchAgents never start because there is no GUI login), the updater no longer ends with "Update staged — restart Codeman to apply". It restarts rootlessly: the update script kills the server PID (passed via `--server-pid`) and launchd respawns it on the freshly built `dist/`. Detection is conservative — the daemon must be bootstrapped in the system domain AND have `KeepAlive` enabled.

  Also fixed: a lingering "restart Codeman to apply" status. After a manual restart of a staged update, boot reconciliation now flips `completed-needs-manual-restart` to `completed` once the running version matches the staged target, so the Updates tab stops showing the stale instruction.

## 0.9.9

### Patch Changes

- Codex (OpenAI CLI) run mode, Claude Model picker, and response-viewer button now opt-in.

  **Codex (OpenAI CLI) run mode** (#114): new `codex` session mode alongside Claude Code and OpenCode. Sessions launch the Codex CLI via tmux with secrets injected through `tmux setenv` (`OPENAI_API_KEY`/`CODEX_API_KEY`/`CODEX_HOME` — never on the command line). Supports `--model`, `resume <id>`, and `--dangerously-bypass-approvals-and-sandbox` via the `codexConfig` payload or the new App Settings → Codex CLI tab (`codexDangerouslyBypassApprovals`). Availability surfaced at `GET /api/codex/status` with an install hint when the binary is missing. Frontend gets a "Run CX" run-mode option; Respawn/Ralph options stay Claude-only (session options open on the Summary tab for external-CLI sessions). `CODEX_*` env prefix added to the env-override allowlist.

  **Claude Model picker**: App Settings → Claude CLI gains a "Claude Model" select (`claudeModel` setting) that pins the model for new Claude sessions via the case's `.claude/settings.local.json` — e.g. Fable 5 (1M context), Fable 5, Opus (1M), Opus, Sonnet, Haiku. It takes precedence over the legacy 1M Opus Context toggle. Fable 5 also added to the orchestrator default/phase model dropdowns.

  **Response-viewer (eye) header button is now hidden by default** — existing users who relied on it can re-enable it under App Settings → Display → Response Viewer (`showResponseViewer`, per-device setting). A new Display toggle controls its visibility.

  Also: tests made immune to a set `CODEMAN_GESTURE` env var; CLAUDE.md documents the Codex run mode and the eye-button toggle.

## 0.9.8

### Patch Changes

- Stable HTTP contract, terminal pane-buffer rework, mobile/touch fixes, and fresh-install default cleanups.

  **API / v1 readiness (PR #113)**
  - Stable HTTP contract: uniform `{success, data}` / `{success: false, error, errorCode}` response envelope across all ~134 handlers, correct HTTP status codes, and a versioned `/api/v1/*` alias of `/api/*`
  - Post-merge adversarial audit closed 9 contract gaps (envelope/status-code stragglers), incl. `loadQuickStartCases` double-unwrap
  - Node.js floor raised to >=22; `codeman` bin alias installed alongside `aicodeman`
  - Security hardening: SSRF guard on the push endpoint, tmux session-name validation, documented tail-file roots
  - Governance: SECURITY.md and a SemVer versioning policy (docs/versioning-policy.md)
  - CI now runs the full unit/integration suite (vitest.ci.config.ts) plus a frontend JS syntax gate

  **Terminal (PR #112)**
  - tmux pane-buffer primitives and session/render reliability fixes for the terminal pipeline, with re-review findings addressed

  **Mobile / touch (PR #111)**
  - Terminal and layout fixes for touch devices: desktop focus handling, WS resize-claim wiring, CJK setting, ESC passthrough
  - New: Esc button in the simple (default) keyboard accessory bar, next to paste — sends a real ESC to the session

  **Defaults & UI**
  - Monitor panel is now disabled by default on fresh installs (desktop previously slid it open at startup; mobile was already off). Opt in via App Settings -> Show Monitor
  - Fixed the session-tab task badge silently failing to open the Monitor panel when it was hidden by the setting (long-broken on mobile)
  - Local echo defaults audited and confirmed per-device: off on desktop, on for touch devices, never server-synced

## 0.9.7

### Patch Changes

- Fix installer failure on corrupt puppeteer cache + add Simplified Chinese README.
  - **Installer / self-update reliability**: The universal installer (`install.sh`) and the in-app self-updater (`scripts/self-update.sh`) now set `PUPPETEER_SKIP_DOWNLOAD=1` before `npm install`. `puppeteer` is a devDependency used only by `scripts/browser-comparison.mjs`; its ~150MB `chrome-headless-shell` download is never needed to build or run Codeman. Previously, a partially-downloaded browser cache (folder present, executable missing) made puppeteer refuse to re-download and abort `npm install`, which failed the entire install/update — most visibly on macOS (`mac_arm`). The download is now skipped on both paths; callers can still opt back in with `PUPPETEER_SKIP_DOWNLOAD=0`.
  - **Docs**: Added a Simplified Chinese translation of the README (`README.zh-CN.md`) with an English/中文 language switcher in `README.md`. Refreshed the README and documented the v0.9.5 security hardening (Host-header/DNS-rebinding guard, cross-site Origin/CSRF guard, anti-CSWSH WebSocket validation).

## 0.9.6

### Patch Changes

- Self-updater: show live progress during the slow steps so an update no longer looks frozen.
  - The detached update runner (`scripts/self-update.sh`) now emits a heartbeat every few seconds during `npm install` and `npm run build`, refreshing the update status with the latest output line (full output is still written to the update log).
  - App Settings → Updates now shows the live status message plus a ticking elapsed-time counter during non-terminal phases, instead of only a static phase label.

  This takes effect when updating _from_ a build that includes it — the detached runner script and the polling UI are both the from-version's copies.

## 0.9.5

### Patch Changes

- Security hardening from the 2026-06-09 adversarial review — close the remote-exploit paths that affected the default (loopback + no-password) configuration. Full report: `docs/reports/security-review-2026-06-09.md`.
  - **Anti-DNS-rebinding Host allowlist (always on).** A new request guard rejects requests whose `Host` is a custom domain rebound to a loopback/LAN address — previously a website the operator merely visited could DNS-rebind to `127.0.0.1` and drive the entire API (arbitrary command execution, since sessions run `--dangerously-skip-permissions`). The allowlist accepts `localhost`, any bare IP literal, the bind host, `*.ts.net` / `*.trycloudflare.com` / `*.cfargotunnel.com`, the active managed tunnel, and anything in the new `CODEMAN_ALLOWED_HOSTS` env var (comma-separated; `host` or leading-dot `.suffix`).
  - **Cross-site (CSRF) Origin guard on all state-changing requests.** Forged cross-site requests are rejected; a missing `Origin` is allowed so `curl`/CLI automation and Claude Code hooks keep working. This closes the previously CSRF-triggerable self-update, session create/input, and settings/tunnel-toggle endpoints.
  - **`text/plain` body parser no longer JSON-parses every request body** (which let a cross-site "simple request" submit JSON with no CORS preflight). The crash-diagnostics beacon now parses its own body.
  - **WebSocket terminal upgrade now validates `Origin`/`Host`** (blocks cross-site WebSocket hijacking that could inject keystrokes into a running agent).
  - **Stored-XSS fix:** AI-/transcript-derived fields (tool name, tool detail, tool id, hook text) in the subagent activity panel are now HTML-escaped.

  Operational note: if you front Codeman with a custom reverse-proxy domain, allow it via `CODEMAN_ALLOWED_HOSTS=host,.suffix`. Setting `CODEMAN_PASSWORD` also fully mitigates these via the existing auth hook.

## 0.9.4

### Patch Changes

- In-app self-updater, plus the SSE-registry and security-doc changes since 0.9.3.

  **New: update Codeman from the web UI (App Settings → Updates).** A "Check for updates" button asks the server to query GitHub for the latest tagged release (falling back to `git ls-remote`) and shows its release notes; "Update now" then runs the full `git checkout <tag>` → `npm install` → `npm run build` → restart cycle and streams live progress that survives the service restart (the browser polls a status file across the connection drop).
  - **Channel:** latest tagged release (e.g. `codeman@0.9.4`), not bleeding-edge master.
  - **Dirty working trees are auto-stashed** (`git stash`, left for you to `git stash pop`) instead of discarded.
  - **Cross-platform restart**, detected from the running process: systemd (`systemctl --user restart codeman-web`) on Linux, launchd (`launchctl kickstart`) on macOS, or a printed manual command otherwise.
  - **Survives its own restart:** the updater runs detached in a transient `systemd-run --user --scope` (Linux) or `setsid` session (macOS), so the restart it triggers cannot kill the build mid-flight.
  - **Safety:** build failure rolls back to the pre-update commit (never restarts into a half-built `dist/`); the pre-restart status marker is reconciled on boot with an update-id + freshness guard so a normal reboot is not misreported as a completed update; concurrent updates are rejected (409); the runner script is staged outside the repo so `git checkout` cannot corrupt it mid-run; release tags are strictly validated before reaching the shell; `CODEMAN_DISABLE_SELF_UPDATE=1` disables the feature; non-git (npm-global) installs are detected and pointed at `npm i -g aicodeman@latest`.
  - New endpoints: `GET /api/system/update/check`, `POST /api/system/update`, `GET /api/system/update/status`.

  **Also in this release:**
  - Sync the frontend `SSE_EVENTS` registry (`constants.js`) with the backend `sse-events.ts` so every broadcast event has a matching frontend entry.
  - Expand `docs/security-architecture.md` with the trust model, CSP detail, and a source-file map.

## 0.9.3

### Patch Changes

- Installer security notice + clarify gesture control stays opt-in and default-off.
  - **Installer:** `install.sh` now prints the network-security notice as the final block of both the fresh install (one-line `curl … | bash`) and the update flow, so it stays visible to the user: Codeman binds `127.0.0.1` by default (no password needed), and the safe ways to reach it remotely (`tailscale serve` / tunnel, or `--host 0.0.0.0` + `CODEMAN_PASSWORD`), noting a non-loopback bind without a password still starts but warns loudly.
  - **Gesture control** is **disabled by default** and is enabled only by the per-user toggle at App Settings → Display → Input → Gesture Control (`gestureControlEnabled`, default `false`). Setting `CODEMAN_GESTURE=1` on the server only makes the feature _available_ (CSP widening + same-origin `/gesture/` assets); it does **not** turn the overlay on. There is no default-on path — the bundle is injected only when a user explicitly enables the setting.

## 0.9.2

### Patch Changes

- Vendor the gesture-control source into the repo for in-tree development.

  The hand-tracking overlay's source (previously the standalone `Ark0N/codeman-gesture-control` repo) now lives at `packages/gesture-control/` as the `codeman-gesture-control` workspace package: the transport-agnostic gesture core (`src/gesture/*` — MediaPipe GestureRecognizer → One-Euro-filtered cursor → pinch state machine), the Codeman consumer entry (`src/codeman/entry.ts`, maps grab/drag/drop onto real session tabs + toolbar buttons), and a standalone vite playground for iterating on gesture feel.
  - New `npm run build:gesture` (`scripts/build-gesture-bundle.mjs`) esbuild-bundles `entry.ts` into the served `src/web/public/gesture/gesture-codeman.js`; `scripts/build.mjs` now reruns it on every production build so the served bundle always reflects current source. The MediaPipe wasm + model stay runtime-loaded from same-origin `/gesture/` (unchanged).
  - Added `@mediapipe/tasks-vision@0.10.21` as the package dependency (kept in sync with `fetch-gesture-assets.mjs`). The playground uses vite 7 (no known advisories).

  No change to the shipped app behavior — gesture control remains opt-in (`CODEMAN_GESTURE=1` + the App Settings → Input toggle). This release just makes the overlay developable inside the Codeman repo.

## 0.9.1

### Patch Changes

- Multi-monitor & settings UX fixes.
  - **Multi-monitor button (remote servers):** the "span displays" button spawns `scripts/span-codeman.sh` server-side, so on a non-macOS Codeman server it can't open a window on your machine. The non-macOS API error now explains this and points to running the script locally on your Mac with the remote server URL; the script header documents the same remote-client workflow.
  - **App Settings modal:** stop the modal overflowing horizontally on narrow viewports.
  - **systemd:** sync the `codeman-web.service` template with the deployed unit.

## 0.9.0

### Minor Changes

- Security hardening release: network-bind policy, auth lockout recovery, download/SVG hardening, dependency & supply-chain fixes, tmux launch reliability, and a full security-architecture doc.

  **Network binding (COD-29, #107):**
  - The web server now defaults to binding `127.0.0.1` (loopback) instead of `0.0.0.0`, so a fresh install is reachable only from the same machine and needs no password. New `--host` / `-H` / `CODEMAN_HOST` flag to choose the bind host.
  - Binding a non-loopback host **without** `CODEMAN_PASSWORD` no longer refuses to start — it **starts and prints a loud warning** with the three ways to secure it (set `CODEMAN_PASSWORD`, bind loopback + an authenticated tunnel / `tailscale serve`, or acknowledge with `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1`). This keeps Codeman "just working" for new users while making remote exposure a guided, explicit choice. Host classification lives in the new `src/web/network-auth-policy.ts` (handles `127.0.0.0/8`, `::1`, `::ffff:127.*`, bracketed IPv6).
  - A post-install security note now explains the loopback default and how to expose safely.

  **Authentication (COD-29, #107):**
  - Auth lockout now recovers gracefully: the per-IP rate-limit (`429`) check runs **after** the cookie/credential checks, so a valid session cookie or correct password is never locked out by a prior attacker's failures from the same IP (important behind a shared-IP tunnel). Wrong credentials are still counted and still hit the limit, and a `Retry-After` header is returned.

  **Downloads & content-type hardening (COD-29, #107):**
  - New session-scoped `POST /api/download` route: realpath-bounded to the session working dir, a sensitive-path blocklist (`/etc/shadow`, `~/.ssh/`, `.env`, `*credentials*`, …), `isFile()` + 50 MB cap, forced `attachment`.
  - Workspace `.svg` files are served as `application/octet-stream` + `attachment` + `nosniff` (closes a stored-XSS-via-SVG vector); `nosniff` now applies to all `file-raw` responses.

  **Dependencies & supply chain (COD-28, #106):**
  - Bumped security-sensitive deps to patched versions (`@fastify/static` 9, `fastify` 5.8, `uuid` 14, `vitest` 4.1, …) and added `overrides` for patched transitives (`picomatch`, `basic-ftp`, `fast-uri`, `flatted`); `npm audit` goes from 7 advisories to 0.
  - New `npm run check:public-assets` (`scripts/check-public-assets.mjs`): scans `src/web/public/**` for literal NUL bytes and runs `node --check` on every `.js` file, plus a Prettier pass on maintained files. Removed literal NUL placeholders from `app.js`. Added `test/dependency-security.test.ts` and `test/frontend-public-tooling.test.ts`.

  **tmux launch reliability (COD-31, #110):**
  - New tmux sessions and respawns launch from a stable `/tmp` and `cd` into the workspace inside the pane, avoiding `new-session` crashes when a FUSE/rclone-mounted workspace has a transient mount blip at launch. The `cd "<dir>" && <cmd>` form is fail-safe (the CLI never runs in `/tmp`) and the path is validated + double-quoted.

  **Test stability (COD-30, #108):**
  - Cleared leaked auth env in the Vitest setup, corrected stale route status-code / SSE-lifecycle expectations to match shipped behavior, updated the mobile keyboard accessory expectations, and measured DOMContentLoaded via browser navigation timing. Also fixed the `WebServer` title tests for the new `host` constructor arg + async `renderIndexHtml`.

  **Docs:**
  - New `docs/security-architecture.md` documenting the full model (network binding, auth pipeline, the tunnel `req.ip` caveat, file-serving hardening, supply-chain, multi-instance isolation, security headers, and recommended secure setups). CLAUDE.md updated accordingly.

## 0.8.2

### Patch Changes

- Session detach/undock, opt-in gesture-control overlay, multi-monitor spanning, new App-Settings toggles, and asset cache-busting.
  - **Session detach/undock + instance isolation (#103):** Detach a session into its own solo (popup) window from the tab strip. Adds multi-instance isolation primitives in `src/config/instance.ts` (`getDataDir()`/`dataPath()`/`DEFAULT_TMUX_SOCKET`) keyed off `CODEMAN_INSTANCE`, so a beta can run side-by-side with prod without discovering/attaching to prod's live tmux sessions or clobbering its `state.json`. `CODEMAN_INSTANCE` defaults to the production layout (`~/.codeman`, `-L codeman`, port 3000), so master installs are unaffected. Adds `scripts/run-beta.sh` (`CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`). The legacy `~/.claudeman` migration is now scoped to the default instance only. Hardened detach edge cases. Tests: `test/config/instance.test.ts`.
  - **Gesture-control overlay (Phase 5, opt-in via `CODEMAN_GESTURE=1`):** Camera hand-tracking overlay (self-hosted MediaPipe — wasm + model fetched at install/build via `scripts/fetch-gesture-assets.mjs` rather than committed). `CODEMAN_GESTURE=1` makes the feature _available_ (CSP widening + `/gesture/` assets + `window.__codemanGestureAvailable`); the per-user **Gesture Control (beta)** toggle (App Settings → Display → Input, default OFF) is the actual on/off and reloads the page to inject/remove the bundle. Dashboard-only (not solo popups). Labeled "(beta)" (#109).
  - **Multi-monitor button:** Header button (opt-in via App Settings → Display → Header Displays) that POSTs `/api/system/span-displays` to spawn `scripts/span-codeman.sh` — a maximized browser `--app` window sized to the union of all displays, so the gesture layer's floating panels can drag across the physical monitor seam. Tests: `test/routes/system-span-displays.test.ts`.
  - **New App-Settings toggles (#105):** Gesture control and the multi-monitor button are both opt-in (default OFF), with live show/hide on save.
  - **Asset cache-busting:** `renderIndexHtml` appends `?v=<mtime>` to every same-origin `.js`/`.css` reference; `index.html` is served `no-cache`, so a normal reload picks up edited modules/styles without a hard refresh. Tests: `test/render-index-html.test.ts`.
  - **Gesture Control toggle placement:** the toggle now lives inside the existing **Input** settings section (alongside Local Echo / CJK Input / Extended Keyboard Bar) instead of a duplicate "Input" section; only the toggle itself is hidden when `CODEMAN_GESTURE=1` is unset, leaving the rest of the section intact.
  - **Service env:** `scripts/codeman-web.service` now sets `CODEMAN_GESTURE=1` so the gesture feature is available on the local install (still gated behind the default-OFF per-user toggle).
  - **Docs:** CLAUDE.md updated for the orchestrator loop, multi-monitor/span-displays, cache-busting, gesture/multi-monitor toggles, and structural-count fixes.

## 0.8.1

### Patch Changes

- Thinking Effort now flows as a soft default the user can override in-session (PR #104, by @TeigenZhang).

  Previously Codeman carried the effort setting as the `CLAUDE_CODE_EFFORT_LEVEL` env var, which Claude Code treats as a hard override — it locked effort for the whole session and rejected in-session `/effort` switching (including switching to `ultracode`). Effort is now injected at spawn time as a CLI soft default that `/effort` can still change freely in either direction:
  - Regular levels (`low`/`medium`/`high`/`xhigh`/`max`) are passed via `claude --effort <level>` (the settings `effortLevel` key silently drops `max`, so the flag is used instead).
  - `ultracode` (xhigh effort + standing dynamic-workflow orchestration) is passed via `claude --settings '{"ultracode":true}'`, since the `--effort` flag rejects it.

  Details:
  - New `effort` field on the create-session, quick-start, and Ralph-loop request schemas; threaded through `Session._effort` to both spawn paths (tmux `buildSpawnCommand` and direct-PTY `buildInteractiveArgs`), persisted in `SessionState.effort`, and restored on reboot recovery.
  - `buildEffortCliArgs()` is the single, allowlist-validated source for both carriers (injection-safe).
  - Settings UI adds an "Ultracode (multi-agent workflows)" option to the Thinking Effort dropdown; the frontend no longer emits `CLAUDE_CODE_EFFORT_LEVEL`.
  - Legacy migration: sessions persisted with the old env var are auto-migrated into the new `effort` field, and the stale tmux env var is unset so respawned panes are no longer locked.
  - Adds `test/effort-injection.test.ts` (13 cases) covering carrier mapping, injection guards, args building, and constructor migration.

## 0.8.0

### Minor Changes

- Event-loop responsiveness fix, mobile image upload, response-viewer polish, and a mobile-UI trim.
  - **fix: avoid event-loop stalls from synchronous tmux/ps calls (#100):** The session manager ran `execSync` for tmux mouse-mode toggles, `list-panes`, and `ps`/`pgrep` resource-stat queries on the main thread. Under multi-session / many-pane load these blocking spawns froze Node's single event loop, stalling SSE broadcasts and PTY I/O (the ":3000 briefly unreachable, process never restarts" class of incident). Converted those calls to async `execAsync` and updated all callers to `await`. Added a lightweight `utils/event-loop-monitor.ts` that samples loop-delay and logs when a stall threshold is exceeded, started on web-server boot and stopped on shutdown — so future regressions leave a timestamped, quantified log line instead of vanishing silently.
  - **feat(web): mobile image upload to active session via paste dialog (#101):** The mobile keyboard-accessory paste dialog now attaches images, not just text — via a native picker (`accept=image/*` → camera / photo library / files) plus best-effort capture of images pasted into the textarea. Both paths reuse the existing `_uploadAndInsertImages()` → `POST /api/sessions/:id/paste-image` pipeline. Images are re-encoded client-side before upload (PNG→PNG to preserve transparency, everything else→JPEG, animated GIFs passed through untouched) so the bytes always match their declared extension — fixing the Android/MIUI case where a WebP/HEIF mislabeled as `image/jpeg` passed the extension allowlist but failed the server's magic-byte check. The server logs a precise diagnostic on any remaining magic-byte mismatch.
  - **feat(web): response-viewer transcript fallback + code-block rendering (#102):** A substantial response-viewer styling overhaul — proportional prose font (monospace kept for code), refined heading/code/blockquote/list styling, readable max content width, and a smoother slide-in animation; the `.rv-text` rules now also apply to `.response-viewer-body` so transcript-missing fallback content gets the same typography. Plus a `_renderMarkdown` null-safety fix (`text` → `src = text || ''`).
  - **feat(web): remove /compact button from the mobile keyboard accessory bar:** Dropped `/compact` from both the simple and extended accessory-bar layouts and the associated action handling. `/clear` retains its double-tap confirmation. Verified on a touch-emulated viewport that neither layout renders a compact action.

## 0.7.1

### Patch Changes

- **fix(respawn): auto-accept now fires on plan approvals after `Worked for X` line, and on AskUserQuestion menus**

  Two related blockers in the respawn controller's auto-accept path:
  - Modern Claude Code emits `✻ Worked for Xm Ys` immediately before a plan-approval menu. `_detectCompletionMessage()` cancelled the auto-accept timer and `canAutoAccept()` then rejected on `completionMessageTime !== null`, so plan approvals **never** auto-accepted — the 10 s completion-confirm timer instead started a respawn cycle while the menu sat unanswered.
  - The same logic in `signalElicitation()` set a hard flag that blocked auto-accept whenever Claude Code fired the `elicitation_dialog` hook, contradicting the in-UI hint ("Auto-accept presses Enter for plan approvals **and default question options**"). AskUserQuestion menus were therefore never auto-accepted either.

  Fix:
  - `_detectCompletionMessage()` no longer cancels the auto-accept timer; the auto-accept pre-filter is now the authoritative "is there a numbered selection menu?" gate.
  - `canAutoAccept()` and the AI-plan-check callback both accept `'watching'` AND `'confirming_idle'` states (covers the single-PTY-burst case where `Worked for` and the menu arrive together — `_detectCompletionMessage` returns early before the substantial-output check can demote state back to watching). `sendAutoAcceptEnter()` self-transitions back to `'watching'` before sending Enter.
  - `signalElicitation()` is now an affirmative hint that primes the auto-accept timer instead of blocking. Still gated on `config.autoAcceptPrompts` AND state ∈ {`watching`, `confirming_idle`} — never fires Enter when respawn is off or auto-accept is disabled.
  - AI plan-check prompt broadened to recognize AskUserQuestion / elicitation menus as valid for auto-accept (the verdict name `PLAN_MODE` is preserved for compatibility but now means "auto-accept this selection menu").
  - Removed the now-unused `elicitationDetected` field and its assignments.

  Two new regression tests cover both the separate-PTY-chunk and single-PTY-chunk cases; the previously misleading "should NOT send Enter when completion message was detected" test was renamed and re-scoped to clarify it tests the **no-menu** path (which still correctly rejects via the pre-filter).

  **docs(web): correct `sendPendingCtrlL` comment** — removed the stale "called by foo/bar" note from the dead-call-graph helper after #99.

## 0.7.0

### Minor Changes

- Response viewer & terminal-stability improvements, plus test/error-handling hardening.
  - **Copy button on code blocks (#98):** Every fenced code block in the response viewer now has a one-click copy button pinned to its top-right, outside the `<pre>` scroll container so it stays put during horizontal scroll. ASCII diagrams keep their line-wrap toggle alongside it. Copy prefers the async Clipboard API and falls back to a hidden-textarea + `execCommand` path, so it works over plain HTTP (tunnel) too, with a brief ✓/✕ feedback state.
  - **Fix: stop auto-sending Ctrl+L from session-selection paths (#99):** A fast page refresh or SSE reconnect could fire two programmatic Ctrl+L (`\x0c`) sends within Claude Code 2.x's "clear conversation" confirmation window, silently wiping the active conversation. Removed the automatic Ctrl+L sends from `selectSession()`, `restoreTerminalSize()`, and the dead `sendPendingCtrlL()` path; redraws now rely on resize/SIGWINCH. User-initiated Ctrl+L still works. Trade-off: an occasional transient stale Ink frame right after refresh that self-heals on the next keypress — far preferable to silent data loss.
  - **Test & error-handling hardening (#97):** Repaired route-test harness error rendering via a dedicated `route-error-handler.ts`, and stopped the AI idle/plan checkers from spawning real processes during tests.

## 0.6.12

### Patch Changes

- Fix new-session crash after a tmux upgrade and isolate Codeman sessions on a dedicated tmux socket.
  - **Pane file-descriptor limit**: raise `ulimit -Sn` before launching the CLI (in both the spawn and respawn paths) so the newer tmux + macOS launchd combination — which hands panes a low soft `nofile` limit (256) that recent Claude Code refuses to start under — no longer kills every freshly spawned session on startup.
  - **Single-socket isolation**: all Codeman-owned tmux sessions now live on a dedicated socket (`tmux -L codeman`, overridable via `CODEMAN_TMUX_SOCKET`), fully separated from the user's default tmux server. The socket name is validated and shell-escaped at every call site.
  - **Drop the drift-prone per-session `tmuxSocket` field**: session reconciliation collapses to a single `list-panes` query against the one socket, eliminating live sessions being wrongly marked dead ("session not found") and duplicate "Restored:" tabs. Stale per-session socket tags and duplicate records are cleaned from disk on load (dedup by `muxName`, keeping the real entry over `restored-` placeholders).
  - **Route remaining bare-`tmux` call sites through the socket**: the window-size query on re-attach (previously fell back to 120×40 and lost scrollback) and the send-key route (Shift+Enter / Ctrl+Enter newline).
  - **SSH chooser scripts** (`tmux-manager.sh`, `tmux-chooser.sh`) route every tmux call through the dedicated socket.

## 0.6.11

### Patch Changes

- Resume Conversation: fixes and folder drill-down.
  - **fix(history)**: `decodeProjectKey()` now uses longest-join-first backtracking with on-disk validation, so sibling directories sharing a prefix (e.g. `diary/` vs `diary-app/`) resolve to the correct path. Previously the greedy shortest-match decoder picked the shorter name and bailed, surfacing `$HOME` in the Resume Conversation list and resuming into the wrong folder. Greedy decode is kept as a fallback so history for deleted projects still resolves. (#92)
  - **fix(tabs)**: Drop the client-side resurrection of ended-session tabs. The old code cached open tabs in `localStorage` and rebuilt them as grayed-out stubs whenever the server no longer knew them, which left phantom tabs after closing a session on another device. The server is now the single source of truth; legacy `localStorage` keys are purged on init. Net -44 / +6 lines. (#93)
  - **feat(history)**: New "View all in this folder" drill-down on Resume Conversation. `GET /api/history/sessions` accepts `projectKey` (validated against `^[A-Za-z0-9_-]+$` before any filesystem access), `offset`, and `limit`; single-folder mode bypasses the 50-cap and returns `{ sessions, total }`. Frontend adds a modal listing 20 sessions per page with a "Show more" pagination button. Modal items omit their own "View all" button to prevent recursive entry points. (#94)

## 0.6.10

### Patch Changes

- ## Security: paste-image endpoint hardening (#90)

  Addresses seven findings from the dismissed review of #84. Most exposed in tunneled deployments where `CODEMAN_PASSWORD` is set but the server is reachable beyond localhost.
  - **CSRF protection** on `POST /api/sessions/:id/paste-image`. Requires `Origin`/`Referer` to match `req.host`; non-browser clients (no `Origin` and no `Referer`) must send `X-Codeman-CSRF`. Defeats cross-origin `<form enctype="multipart/form-data">` submits that would otherwise plant arbitrary bytes into the victim's `.claude-images/` while their session cookie is live.
  - **Magic-byte validation** on uploaded images. Sniffs the first 12 bytes against PNG/JPEG/GIF/WebP/BMP signatures and rejects 415 on mismatch. Polyglot HTML-or-SVG-with-image-MIME no longer round-trips through the endpoint.
  - **Symlink-safe writes** on `.claude-images/`. `lstat` before the write, non-recursive `mkdir`, `O_EXCL|O_NOFOLLOW` on file open. A `node_modules` postinstall (or the agent itself) planting `.claude-images -> ~/.ssh/` no longer redirects pastes outside `workingDir`.
  - **Multipart parser swap** to `@fastify/multipart` with `limits: { fileSize: 10MB, files: 1, fields: 4 }`. Replaces a hand-rolled boundary scanner that matched the literal boundary anywhere in the body, hard-coded `\r\n` (silently corrupting LF-only clients), and had no part-count cap.
  - **Rate limit + GC**: token-bucket (30/min per IP+session) and hourly GC of `paste-*` files older than 7 days from each live session's `.claude-images/`. New `paste-image-gc.ts` started/stopped from `WebServer.start/stop`.
  - **Collision-free filenames**: `paste-${Date.now()}-${randomBytes(4)}${ext}`. Two tabs pasting in the same millisecond no longer silently last-write-wins.
  - **Bracketed-paste preservation**: text-only paste in `image-input.js` now goes through `terminal.paste(text)` instead of `sendInput(text)`, so xterm preserves `CSI 200~ ... CSI 201~` markers — Claude Code uses them as part of its prompt-injection defenses.

  ## Fix: duplicate multipart parser conflict

  Removed a duplicate multipart content-type parser left behind after the swap above. The duplicate registration conflicted with `@fastify/multipart`'s own parser; uploads now flow through the plugin exclusively.

  ## WebGL renderer auto-fallback hardening (#91)

  Follow-ups on the longtask auto-fallback shipped in #83.
  - `PerformanceObserver` is now disconnected on `onContextLoss` as well as on the trip path. Previously the observer outlived its disposed addon after a context loss, holding a closure reference over every longtask the page emitted.
  - Thresholds (`200ms / 3 longtasks / 30s window / 5s grace / 7d sticky-disable`) are hoisted to `WEBGL_FALLBACK` in `constants.js`. No more inline literals.
  - New `evaluateWebGLLongTaskTrip()` pure helper splits the rolling-window arithmetic from the `PerformanceObserver` callback so the trip math is unit-testable. New `test/webgl-fallback.test.ts` (9 tests, port 3166): trip inside window, no-trip when spread, sub-threshold filtering, stale-entry pruning, cumulative counting across batches, observer-dispose idempotency.

  ## CI: server boot smoke test

  GitHub Actions now boots the server as a final step after typecheck/lint/format. Catches production-only ESM/CJS regressions that `tsx` masks in dev.

  ## Docs

  `CLAUDE.md` frontend-module table updated to include `image-input.js` (overlooked when #84 landed).

## 0.6.9

### Patch Changes

- Terminal renderer hardening, SSE bandwidth cut, image paste, and a security tightening on the new live filter:
  - **Multi-primitive yield for write pacing** (#85): replaces six raw `requestAnimationFrame` callsites in the xterm.js write pipeline with a yielding helper that races `requestAnimationFrame`, `setTimeout(50)`, and a tick Worker. Keeps the terminal responsive when the tab is backgrounded or occluded — Chrome's intensive-throttling no longer stalls long writes.
  - **WebGL longtask auto-fallback** (#83): a `PerformanceObserver` watches for ≥200ms WebGL frames; three within a 30s window disposes the WebGL addon and falls back to the canvas renderer. Decision is persisted in localStorage for 7 days, and `?webgl=force` clears it.
  - **Per-client live SSE subscription filter** (#86): each connected client gets a stable UUID and can narrow its terminal stream to one session via `POST /api/events/subscribe` — no EventSource reconnect on tab switches. Cuts SSE bandwidth roughly N× when N sessions are open. Lifecycle/metadata events (`session:*`, `case:*`, `ralph:*`, `hook:*`) now broadcast to every client so sidebars stay in sync.
  - **Image paste and drag-and-drop into the terminal** (#84): `Ctrl+V` and dropped images upload to `POST /api/sessions/:id/paste-image`, save under `${workingDir}/.claude-images/paste-${ts}.${ext}` and type the path into the terminal. Hard 10MB cap, server-generated filename (no traversal), `.svg` deliberately excluded from the allowlist to avoid a same-origin XSS path through `file-raw`.
  - **SSE clientId validation**: the per-client identifier introduced in #86 is now constrained to `[A-Za-z0-9_-]{8,64}` at both ingress points. Without this, an authenticated attacker could send another tab's clientId to silently evict it from broadcasts, mutate any clientId's session filter to blackhole the victim's terminal stream, or grow `sseClientsById` unboundedly via long IDs. The subscribe payload is also capped at 64 session entries of ≤128 chars each.

## 0.6.8

### Patch Changes

- Finish the hostname-aware notification plumbing started in 0.6.7 and lock down the recent UI/runtime fixes with regression tests.
  - Browser Notification API (OS-level desktop pop-ups, layer 3 of the 5-layer notification system) now uses `${originalTitle}: ${title}` instead of the hardcoded `Codeman:` literal — so multi-host users running Codeman on laptop / dev box / NAS see `codeman:<host>: <event>` consistently across tab title, tab-flash, Web Push, and OS notifications.
  - Inline session rename hardened against three corner cases: IME composition commits (Chinese pinyin Enter no longer ships half-composed text as the session name), mid-rename SSE deletion (orphaned `<input>` no longer 404s on blur), and double-fire on stuck settle-once flag (closure-local `settled` boolean replaces the boolean instance flag).
  - Test coverage backfilled for two prior shipped fixes:
    - `<title>codeman:<host></title>` server-side templating (#82): 8 tests covering default `os.hostname()`, `--title-hostname` override, HTML-escape against `<script>`-style breakout, ampersand non-double-encoding, and template-tail byte-identical invariance.
    - tmux size-query helper (#80): 15 tests covering the browser-resize-between-attaches happy path, the query-then-die race, zero/negative/empty/non-numeric output fallbacks, and argv-form/timeout assertions that lock down the no-shell-interpolation guarantee. Inline 14-line query block extracted into a named `queryTmuxWindowSize()` export in `session.ts` so the test surface is a pure function.
  - Regression coverage added for `stripInkRedrawBloat` route helper.
  - CLAUDE.md and README.md updated to document dual-CLI env-prefix discipline (`CLAUDE_CODE_*` vs `OPENCODE_*`), the `xterm-zerolag-input` published-package side-effect of overlay edits, and the unified hostname prefix across tab title / tab-flash / OS notifications.

## 0.6.7

### Patch Changes

- - **fix(client): preserve inline rename input across tab re-renders** (#81) — Right-click → rename on a session tab no longer loses keystrokes when SSE traffic from sibling sessions triggers a tab re-render. Adds an `_inlineRenameActive` guard at the top of `renderSessionTabs()` and `_fullRenameSessionTabs()` so the in-progress input isn't destroyed mid-typing. Also fixes a latent double-fire of `finishRename` (blur + Enter could both invoke it). Drive-by: safer DOM child clearing in place of `innerHTML = ''`.
  - **feat: hostname-aware window title** (#82) — The browser tab title is now `codeman:<hostname>` instead of the bare `Codeman` literal, so users running Codeman on multiple hosts (laptop, dev box, NAS) can tell at a glance which tab points at which backend. New `--title-hostname <name>` CLI flag overrides the detected `os.hostname()` when it's noisy or you want a cosmetic name. The title is templated into the served HTML on first byte (with narrow HTML escaping), so it's correct from the first paint and works without JavaScript. Title-flash logic now respects the per-host title.
  - **perf: larger terminal tail on tab switch** — `TERMINAL_TAIL_SIZE` raised from 128KB to 1MB. When switching back to a busy session tab you now get ~8× more scrollback restored immediately.
  - **fix: preserve response text in Ink redraw stripping** — `stripInkRedrawBloat()` rewritten from a first-VPA approach to cluster-based detection. The previous algorithm assumed all VPA escapes after the first one belonged to a single redraw region and discarded everything in between, which silently lost 100KB+ of legitimate Claude response text once a render had occurred. The new approach groups VPAs into clusters separated by ≥8KB gaps and only collapses clusters spanning ≥32KB, so streamed response content between redraw bursts is preserved.
  - **docs**: `CLAUDE.md` Additional Commands gains the `--title-hostname` row; `README.md` gets a "Hostname-Aware Window Title" subsection under Multi-Session Dashboard.

## 0.6.6

### Patch Changes

- **Terminal scrollback significantly increased** — both the xterm.js viewport and the tmux backing buffer were bottlenecking how far back you could scroll. Three changes:
  - `DEFAULT_SCROLLBACK` raised from 20000 → 50000 lines (xterm.js, main terminal). The previous bump from 5000 only helped users with empty localStorage; existing users were stuck on whatever value they first picked up. The loader now treats `DEFAULT_SCROLLBACK` as a floor — if your stored value is below the new minimum, you're raised to it automatically.
  - Subagent / teammate terminals (`panels-ui.js`) were stuck at 5000; now use the same `DEFAULT_SCROLLBACK` constant (50000).
  - New tmux sessions now run with `history-limit 50000` (tmux defaults to 2000). This matters for hard-reload / re-attach — without it, only the last ~2000 lines survive the round-trip back into a fresh xterm.

  **Tmux flicker on session re-attach fixed (PR #80 by @aakhter)**: the PTY now queries the existing tmux window size via `tmux display -p` before spawning, instead of hardcoding 120x40. Previously, every re-attach forced tmux to resize down to 120x40, causing a visible flicker and one frame of scrollback loss. The `-x 120 -y 40` flag was also dropped from `tmux new-session` so the initial size matches the first attaching client. Uses `execFileSync` (not shell) for safety and falls back to 120x40 on any error.

  **Docs**: CLAUDE.md now documents two recurring foot-guns — the `xterm-zerolag-input` overlay code is duplicated between `packages/xterm-zerolag-input/src/` and inline inside `src/web/public/app.js`, so any overlay change must touch both; and the COM workflow explicitly includes a post-push `gh run watch` step to confirm CI before considering the release done.

## 0.6.5

### Patch Changes

- **Mobile fix**
  - Android virtual keyboard: space character was silently dropped on touch devices using GBoard / SwiftKey / similar IMEs. Root cause: the input-event handler in `terminal-ui.js` treated any whitespace-only textarea value as proof that xterm had already processed the input. A lone space (`' '.trim() === ''`) tripped this guard, so the space was consumed but never forwarded. Now skips only when the textarea is truly empty (or whitespace from a non-space key). Reported and diagnosed by @coolk8 in #79.

  **Docs**
  - `CLAUDE.md`: added Zod `.optional()`-vs-`null` gotcha (recurring trap from 0.6.3 / 0.6.4 incidents) and a more visible warning against running bare `npm test` (kills the host tmux session).
  - `docs/local-echo-overlay-plan.md`: marked SHIPPED, corrected xterm version reference (v5.3.0 → `@xterm/xterm` ^6.0.0).

## 0.6.4

### Patch Changes

- Fix "Failed to enable respawn: Invalid request body" error when selecting infinity duration (∞) in the respawn modal. Frontend was sending `durationMinutes: null`, which Zod's `.optional()` schema rejected (it accepts `undefined` only). The body now omits the field when no duration is selected.

## 0.6.3

### Patch Changes

- **Fix**
  - Allowlist `opusContext1mEnabled` in `SettingsUpdateSchema`. Without this entry, the strict schema rejected `PUT /api/settings {"opusContext1mEnabled":...}` with `INVALID_INPUT`, so the toggle's value never persisted across reloads. The frontend was already reading and writing this key (`settings-ui.js:336/1137`, `session-ui.js:340`), so saves were silently failing — users never noticed because the load path falls back to `false` on missing keys, hiding the bug. (#78)

## 0.6.2

### Patch Changes

- **Mobile UX**
  - Resume Conversation list (welcome page) reworked for narrow screens: 2-line title clamp so more of the first prompt is visible; case-aware subtitle that renders `#caseName` (or `#caseName/sub`) when `workingDir` matches a known case, otherwise falls back to the directory basename; inline `⋯` toggle that expands a detail panel with full prompt, full path, timestamp, size, and short session id; `/Users/<user>/` now collapses to `~/` alongside `/home/<user>/`. (#77)
  - Response viewer: ASCII diagram wrap toggle, dedicated mobile code-block layout, and chrome-stripping fallback when the model wraps its reply in extra markup. (#75)
  - Mobile keyboard accessory bar no longer triggers vertical scroll. (#72)

  **Sessions & settings**
  - New `thinkingEffort` setting on session creation, with `xhigh` option and `/effort max` mobile shortcut. (#73)
  - `thinkingEffort` is now allowlisted in `SettingsUpdateSchema` so it round-trips through PATCH /api/settings.
  - `envOverrides` (`CLAUDE_CODE_*` / `OPENCODE_*`) are now passed to Claude via tmux env exports at spawn time instead of being written to `<case>/.claude/settings.local.json`. Eliminates UI/disk drift; the value lives on `Session._envOverrides`, is exported by `tmux-manager.buildEnvExports()`, and is persisted in `SessionState.envOverrides`. (#74)

  **Fixes**
  - Eye icon (active-session indicator) now follows `/clear` to the new Claude conversation instead of getting stuck on the previous transcript. (#76)
  - `tmux-manager.reconcileSessions` now uses `|` as the field separator, fixing parsing when session names contain other delimiters. (#71)

  **Docs**
  - CLAUDE.md: added `npm run knip` to the dead-code sweep table and a `Common Gotchas` entry documenting the `envOverrides` → tmux export flow.

## 0.6.1

### Patch Changes

- Internal cleanup and release hygiene:
  - **Dead-code sweep via knip**: added `knip.json` for dead-code detection and ran a full sweep — removed unused test files, unused scripts, and narrowed internal module exports to the minimum surface area actually consumed.
  - **Lockfile drift prevention**: `version-packages` now runs `npm install --package-lock-only` and verifies the lockfile is in sync via `scripts/check-lockfile-sync.mjs`; CI runs the same check on every push/PR so version drift fails the build instead of reaching production. Resolves the `package-lock.json` / `package.json` version mismatch that shipped in 0.6.0.
  - **Docs tightening**: archived 22 completed plan docs from `docs/`, corrected file/handler counts in `CLAUDE.md`, documented the lockfile step in the COM workflow, and removed footer redundancy.

## 0.6.0

### Minor Changes

- Community contributions from @aakhter:
  - **feat (#66): Tab reorder shortcuts** — `Ctrl+Shift+{` and `Ctrl+Shift+}` move the active session tab left/right, matching WezTerm convention. Order persists across reloads via `saveSessionOrder()`.
  - **feat (#67): Active tab visibility + Alt+N badges** — active tab now has a bright green border with color-matched glow, and the first 9 tabs display number badges hinting at the `Alt+N` switch shortcut. Badges update on reorder/rerender.
  - **feat (#68): Clipboard API** — new `POST /api/clipboard` accepting `{text}` broadcasts a `clipboard:write` SSE event; connected browsers attempt `navigator.clipboard.writeText()` with a manual-copy modal fallback when the page isn't focused. Auth-protected via the standard middleware. Useful for pushing snippets from remote sessions to the user's local clipboard.
  - **fix (#65): Android Shift+key double character** — pressing `Shift+A` on attached Android keyboards no longer produces "AA". Tracks xterm-handled keydown timestamps and skips the orphaned-input listener for 50ms after a real keydown, while still catching Gboard symbol-keyboard inputs (keyCode 229).

## 0.5.13

### Patch Changes

- Fix "Case path not found" error in Quick Start when `~/codeman-cases/` does not exist (issue #64). Two bugs in `session-ui.js`:
  - `runClaude()` auto-create read `createCaseData.case`, but `POST /api/cases` returns `{ success, data: { case } }` — corrected to `createCaseData.data.case`.
  - `runShell()` had no auto-create logic and would immediately throw on a missing case directory — now mirrors `runClaude()`'s create-on-demand flow.

## 0.5.12

### Patch Changes

- Fix quick-start to resolve linked cases before codeman-cases fallback. `/api/quick-start` was always resolving `caseName` against `CASES_DIR`, ignoring entries in `~/.codeman/linked-cases.json`. Sessions started via quick-start now correctly honour linked external project directories, consistent with regular case routes.

## 0.5.11

### Patch Changes

- Community contributions and security hardening:
  - Mobile response viewer: native-scroll panel for reading full Claude responses with markdown rendering via marked.js (PR #62)
  - PWA support: service worker caching, web app manifest, and Android home screen install (PR #59)
  - Named Cloudflare tunnel support (PR #58)
  - Markdown rendering for response viewer with HTML sanitization (XSS prevention) — strips dangerous elements, event handlers, and javascript: URIs
  - Service worker switched from stale-while-revalidate to network-first caching so deploys take effect immediately
  - Content-Disposition filename sanitization to prevent header injection in file downloads
  - Expose session.muxName public getter, replace unsafe `as any` cast in session-routes
  - Static import for execFile in session-routes
  - Keyboard shortcut updates: Alt+1-9 tab switching, Shift+Enter newline
  - Repo restructure for cleaner GitHub landing page
  - Mobile logo, expandable history, session resume fixes

## 0.5.10

### Patch Changes

- fix: allow bracket characters in model validation regex so models like opus[1m] (1M context window) are accepted instead of silently dropped. Quote the model flag value in tmux spawn commands to prevent bash glob expansion of bracket patterns.

  docs: update macOS launchd instructions to use `launchctl bootstrap` instead of deprecated `load`. Clean up README install and service sections.

## 0.5.9

### Patch Changes

- Mobile keyboard accessory bar: add configurable "Extended Keyboard Bar" setting (Settings > Display > Input) that toggles between simple mode (up/down arrows, /init, /clear, /compact, paste, dismiss) and extended mode (adds left/right arrows, Tab, Shift+Tab, Ctrl+O, Alt+Enter, Esc). Default is simple mode. Setting is device-specific (not synced to server).

  Restyle dismiss button: muted steel-blue tone, fills remaining bar space via flex, larger tap target. Arrow buttons now blue.

  Fix paste overlay visibility on mobile: dialog repositioned to top of screen (15vh from top) so the virtual keyboard doesn't cover it. Textarea enlarged for better usability.

  (Also includes all v0.5.8 changes: case reorder/delete, XSS sanitization, auto-attach PTY on restart, mobile keyboard buttons, macOS installer fixes, terminal flicker fix, state store collision fix.)

## 0.5.8

### Patch Changes

- Case management: add Manage tab with reorder (up/down arrows) and delete for cases; linked cases are unlinked (folder preserved), CASES_DIR cases are permanently deleted. New endpoints: DELETE /api/cases/:name, PUT /api/cases/order. SSE events: case:deleted, case:order-changed.

  Security: sanitize case names from filesystem with /^[a-zA-Z0-9_-]+$/ regex before returning from GET /api/cases to prevent XSS via maliciously-named directories reaching frontend inline onclick handlers.

  Auto-attach PTY: server now calls startInteractive() for recovered tmux sessions during startup so all sessions resume capturing output immediately after deploy, instead of waiting for client selection. Frontend auto-attach condition relaxed from (pid===null && status==='idle') to (pid===null && !\_ended).

  Mobile keyboard accessory: add Shift+Tab, Tab, Esc, Alt+Enter, Left/Right arrow, and Ctrl+O buttons.

  Terminal: fix flicker regression by moving viewport clear inside dimension guard.

  State store: fix temp file collisions on concurrent writes.

  macOS: fix installer failures when piped via curl | bash, add HTML cache support, launchd service template, and trust dialog handling.

  Housekeeping: remove accidentally committed dist/state-store.js build artifact.

## 0.5.7

### Patch Changes

- feat: support "Default (CLI default)" option for model selection. Adds a new empty-value option to the model dropdown that defers to the CLI's own default model instead of forcing a specific model. Ensures empty defaultModel values are treated as undefined when passed to session creation and Ralph loop start, preventing empty strings from being sent as model flags.

## 0.5.6

### Patch Changes

- fix: default new sessions to opus[1m] (1M context window) instead of plain opus (200k context)

## 0.5.5

### Patch Changes

- Add 1M Opus context quick setting — per-case and global toggle that writes `model: "opus[1m]"` to `.claude/settings.local.json` when creating new sessions. Fix mobile layout: banners (respawn, timer, orchestrator) between header and main content now visible by switching from margin-top on `.main` to padding-top on `.app`. Add tablet-optimized respawn banner styles and mobile phone banner refinements.

## 0.5.4

### Patch Changes

- Fix terminal flicker regression — re-add server-side DEC 2026 synchronized output wrapping around batched terminal data. Ink spinner frames (cursor-up + redraw cycles) do not emit their own DEC 2026 markers, so without the server wrapper each partial cursor update rendered individually causing visible flicker. Also: extract SSE stream management, session listener wiring, and respawn event wiring from server.ts into dedicated modules; deduplicate error message extraction across 7 files with shared getErrorMessage() helper; update SSE event count in CLAUDE.md (106 → 117).

## 0.5.3

### Patch Changes

- Readability refactor across 12 core files, extracting ~35 helper methods to reduce duplication:
  - state-store: extract serializeState(), split assembleStateJson() into focused sub-methods
  - session: extract \_resetBuffers() (3x dedup), \_clearAllTimers() (10 timer cleanups), \_handleJsonMessage()
  - ralph-tracker: extract completeAllTodos() (4x dedup), emitValidationWarning(), named similarity constants
  - subagent-watcher: extract markSubagentAsCompleted(), extractFirstTextContent(), emitToolResult(), findOldestInactiveAgent()
  - respawn-controller: extract recoveryResetToWatching(), canAutoAccept(), formatRemainingSeconds(), validatePositiveTimeout()
  - tmux-manager: replace 15 path.includes() with UNSAFE_PATH_CHARS regex, extract buildEnvExports/buildPathExport/\_configureOpenCode helpers
  - session-auto-ops: extract executeWhenIdle() shared retry helper, convert to options object, add validateThreshold()
  - app.js: add \_clearTimer() (11 call sites), \_isStaleSelect(), keyboard shortcut lookup table, \_cleanupPreviousSession(), \_resetAllAppState()
  - route-helpers: add readJsonConfig() (5 inline patterns replaced), validateSessionFilePath() (2 duplicated blocks replaced)

## 0.5.2

### Patch Changes

- Make buffer size limits configurable via CODEMAN\_\* environment variables (MAX_TERMINAL_BUFFER, TRIM_TERMINAL_TO, MAX_TEXT_OUTPUT, TRIM_TEXT_TO, MAX_MESSAGES), falling back to existing defaults. Allows users with fewer sessions or more RAM to tune buffer sizes without patching source.

  Fix duplicate terminal output on tab switch to busy sessions by clearing the terminal before writing the new buffer.

  Fix stale Ink CUP frames after tab switch by sending Ctrl+L to force a clean redraw.

  Fix mobile CJK input handling: resolve textarea positioning, terminal flicker during composition, and layout overflow on small screens. Improve CJK composition lifecycle with better event handling and fallback flush timers.

## 0.5.1

### Patch Changes

- refactor: codebase cleanup — extract route helpers, eliminate boilerplate, optimize hot paths
  - Add `parseBody()` helper to route-helpers.ts: validates request body against Zod schema with structured 400 error on failure, replacing 37 identical safeParse + error-check blocks across 10 route files
  - Add `persistAndBroadcastSession()` helper: combines persist + SessionUpdated broadcast into one call, replacing 5 repeated 2-line pairs
  - Migrate session-routes.ts to use `findSessionOrFail()` consistently (17 inline session lookups replaced) and `parseBody()` (12 patterns)
  - Migrate ralph-routes.ts to use `findSessionOrFail()` (9 lookups) and `parseBody()` (4 patterns)
  - Migrate 8 remaining route files to use `parseBody()` (21 patterns total)
  - Fix O(n log n) eviction in bash-tool-parser.ts: replace `Array.from().sort()[0]` with O(n) min-scan for oldest active tool
  - Extract `_debouncedCall()` utility in frontend: replaces 4 manual debounce patterns (7 lines each → 1 line) in app.js, panels-ui.js, ralph-panel.js
  - Net reduction: 208 lines removed across 16 files

## 0.5.0

### Minor Changes

- Visual redesign with glass morphism, refined colors, and polished UI. Optimize history endpoint with buffer reuse and line iterator. Fix Ink frame search window (4KB→64KB) to prevent partial frames. Fix stale terminal data on tab switch via chunkedTerminalWrite cancellation. Improve history prompt extraction with expanded command filtering and tail scan fallback. Align case select group height to match dropdown. Fix no-control-regex lint error for ANSI strip pattern. Add browser-testing-guide to CLAUDE.md references.

## 0.4.7

### Patch Changes

- feat: improve session navigability in history and monitor panel (closes #45)
  - History items now show the first user prompt as the title with the project path as a subtitle, making it much easier to distinguish sessions from the same project
  - The `/api/history/sessions` endpoint extracts the first user message from each transcript JSONL, stripping system-injected XML tags and command artifacts, truncating to 120 chars
  - Monitor panel session rows are now clickable — clicking navigates directly to that session's tab via `selectSession()`; Kill button retains independent behavior via `stopPropagation()`
  - Updated CLAUDE.md architecture tables to reflect Orchestrator Loop additions (14 route modules, 15 type files, orchestrator domain files, orchestrator-panel.js frontend module)
  - fix: stop subagent monitor windows from auto-opening on discovery
  - feat: add Orchestrator Loop with phased plan execution, live progress during plan generation, and toolbar button (hidden until fully tested)
  - fix: patch 3 production bugs found during deep audit
  - fix: restore mobile terminal scrollback using JS scrollLines() instead of broken native scroll

## 0.4.6

### Patch Changes

- Fix mobile keyboard scroll and layout issues:
  - Prevent iOS Safari from scrolling the page when typing with the keyboard open (position:fixed on .app + window.scroll reset)
  - Eliminate dead space between terminal and keyboard accessory bar by removing redundant CSS padding, tightening JS padding constant, and adding row quantization gap compensation
  - Fix toolbar overlapping terminal content when keyboard is hidden by adding proper padding-bottom to .main, including iOS Safari bottom bar offset
  - Strip Ink spinner bloat from terminal buffer before tailing
  - Fix resolveCasePath priority order and suppress JSON parse warnings

## 0.4.5

### Patch Changes

- Fix mobile keyboard toolbar positioning on iOS Safari: toolbar (Run/Stop/Run Shell) was hidden behind the accessory bar when virtual keyboard was active due to overlapping CSS positions. Remove the aggressive safety check in `updateLayoutForKeyboard()` that incorrectly dismissed keyboard state when iOS scrolled the visual viewport during typing. Add Safari-bar CSS offset to accessory bar so it properly stacks above the toolbar. Remove the double-counted Safari-bar offset when keyboard is visible since the JS transform already covers the full distance.

## 0.4.4

### Patch Changes

- fix: mobile keyboard hides terminal content on iPhone

  Fixed a bug where opening the virtual keyboard on iPhone left zero visible terminal space. Two independent mechanisms were both accounting for the keyboard height: `MobileDetection.updateAppHeight()` shrunk `--app-height` to the visual viewport height, while `KeyboardHandler.updateLayoutForKeyboard()` added a large `paddingBottom`. These double-counted, leaving negative space for the terminal (user saw accessory bar + toolbar but no terminal content).

  Fix: `updateAppHeight()` now skips when the keyboard is visible, and `handleViewportResize()` restores `--app-height` to the pre-keyboard value on first detection (since MobileDetection's listener fires before KeyboardHandler's). On keyboard close, `--app-height` is re-synced to the current visual viewport.

## 0.4.3

### Patch Changes

- Refactor case routes: extract readLinkedCases() and resolveCasePath() helpers to eliminate 6x duplicated linked-cases.json path construction and 5x duplicated file read/parse logic. Replace O(n) .some() duplicate check with O(1) Set.has() in case listing. Un-export unused isError() type guard. Standardize reply.status() to reply.code() in system routes. Update CLAUDE.md frontend module listing and SSE event count.

## 0.4.2

### Patch Changes

- Extract monolithic app.js (~12.5K lines) into 6 focused domain modules that extend CodemanApp.prototype via Object.assign: terminal-ui.js (terminal setup, rendering pipeline, controls), respawn-ui.js (respawn banner, countdown, presets, run summary), ralph-panel.js (Ralph state panel, fix_plan, plan versioning), settings-ui.js (app settings, visibility, web push, tunnel/QR, help), panels-ui.js (subagent panel, teams, insights, file browser, log viewer), session-ui.js (quick start, session options, case settings). Fix critical deferred script init ordering bug: wrap CodemanApp instantiation in DOMContentLoaded so all defer'd mixin modules execute their Object.assign before the constructor runs. Guard missing cleanupWizardDragging() call in subagent-windows.js. Update build.mjs to minify/hash all new modules.

## 0.4.1

### Patch Changes

- Performance optimizations: V8 compile cache for 10-20% faster cold starts, lazy-load WebGL addon (244KB saved on mobile), preload hints for critical scripts, batch tmux reconciliation (N subprocess calls → 1). Also: WebSocket session lifecycle fixes, CJK IME input support, CI upgrade to Node 24/actions v6, install.sh fork support, and CLAUDE.md/README documentation refresh.

## 0.4.0

### Minor Changes

- Add CJK IME input textarea for xterm.js terminal (env toggle INPUT_CJK_FORM=ON). Always-visible textarea below terminal handles native browser IME composition, forwarding completed text to PTY on Enter. Supports arrow keys, Ctrl combos, backspace passthrough, and Escape to clear.

  Add fork installation support to install.sh with CODEMAN_REPO_URL and CODEMAN_BRANCH env vars, allowing custom repository and branch for git clone/update operations. README updated with fork installation instructions.

  Fix WebSocket session lifecycle: close WS connections when session exits (prevents orphaned listeners and stale writes to dead PTY), add readyState guard in onTerminal to stop buffering after socket closes, simplify heartbeat by removing redundant alive flag.

  Add WebSocket reconnection with exponential backoff (1s-10s) on unexpected close, skipping server rejection codes (4004/4008/4009). Falls back gracefully to SSE+POST during reconnection.

  Clear CJK textarea on session switch to prevent sending stale text to wrong session.

## 0.3.12

### Patch Changes

- Add WebSocket terminal I/O with server-side DEC 2026 synchronized update markers. Replaces per-keystroke HTTP POST + SSE terminal output with a single bidirectional WebSocket connection for dramatically lower input latency. Server-side 8ms micro-batching with 16KB flush threshold groups rapid PTY events into single WS frames wrapped in DEC 2026 markers for flicker-free atomic rendering. Includes 30s ping/pong heartbeat with 10s timeout for stale connection detection through tunnels. Existing SSE + HTTP POST paths remain fully functional as transparent fallback. Resize messages validated to match HTTP route bounds (cols 1-500, rows 1-200, integers only). 16 automated route tests added for WS endpoint. Also patches 5 dependency vulnerabilities (basic-ftp, fastify, minimatch, serialize-javascript).

## 0.3.11

### Patch Changes

- ### Session Resume & History
  - Add `resumeSessionId` support for conversation resume after reboot
  - Add history session resume UI and API with route shell sessions routing fix
  - Improve session resume reliability and persist user settings across refresh
  - Correct `claudeSessionId` for resumed sessions

  ### Terminal & Frontend
  - Upgrade xterm.js 5.3 → 6.0 with native DEC 2026 synchronized output
  - Increase terminal scrollback from 5,000 to 20,000 lines
  - Reduce default font size and persist tab state across refresh
  - Resolve terminal resize scrollback ghost renders
  - Hide subagent monitor panel by default

  ### Installer
  - Auto-detect existing install and run update instead of fresh install
  - Auto-restart codeman-web service after update if running
  - Show restart command when codeman-web is not a systemd service
  - Fix one-liner restart command for background processes

  ### Codebase Quality
  - Remove dead code, consolidate imports, extract constants
  - Repair 15 pre-existing subagent-watcher test failures
  - Clean up DEC sync dead code

## 0.3.10

### Patch Changes

- - feat: upgrade xterm.js from 5.3 to 6.0 with native DEC 2026 synchronized output support
  - feat: add history session resume UI and API — resume Claude conversations after reboot
  - feat: add resumeSessionId support for conversation resume across session restarts
  - feat: persist active tabs across page refresh
  - feat: improve session resume reliability and persist user settings
  - perf: increase terminal scrollback from 5,000 to 20,000 lines
  - fix: resolve terminal resize scrollback ghost renders
  - fix: route shell sessions to correct endpoint on tab click
  - fix: correct claudeSessionId for resumed sessions (use original Claude conversation ID)
  - fix: increase default desktop font size from 12 to 14
  - refactor: extract shared \_fetchHistorySessions() method to eliminate duplication
  - refactor: remove dead DEC 2026 sync code (extractSyncSegments, DEC_SYNC_START/END constants)

## 0.3.9

### Patch Changes

- Add content-hash cache busting for static assets — build step now renames JS/CSS files with MD5 content hashes (e.g. app.js → app.94b71235.js) and rewrites index.html references. HTML served with Cache-Control: no-cache so browsers always revalidate and pick up new hashed filenames after deploys. Hashed assets keep immutable 1-year cache. Eliminates the need for manual hard refresh (Ctrl+Shift+R) after deployments.

  Refactor path traversal validation into shared validatePathWithinBase() helper in route-helpers.ts, replacing 6 duplicate inline checks across case-routes, plan-routes, and session-routes.

  Deduplicate stripAnsi in bash-tool-parser.ts — use shared utility from utils/index.ts instead of private method.

## 0.3.8

### Patch Changes

- Add tunnel status indicator with control panel — green pulsing dot in header when Cloudflare tunnel is active, dropdown with URL, remote clients, auth sessions, and start/stop/QR/revoke controls

## 0.3.7

### Patch Changes

- Operation Lightspeed: 5 parallel performance optimizations — multi-layer backpressure to prevent terminal write freezes, TERMINAL_TAIL_SIZE constant with client-drop recovery, tab switching SSE gating, and local echo improvements
- Codebase cleanup: remove dead code (unused token validation exports, PlanPhase alias), add execPattern() regex helper to eliminate repetitive .lastIndex resets, centralize 11 magic number constants into config files, fix CLAUDE.md inaccuracies, and add 316 new tests for utilities, respawn helpers, and system-routes

## 0.3.6

### Patch Changes

- Re-enable WebGL renderer with 48KB/frame flush cap protection against GPU stalls

## 0.3.5

### Patch Changes

- Fix Chrome "page unresponsive" crashes caused by xterm.js WebGL renderer GPU stalls during heavy terminal output. Disable WebGL by default (canvas renderer used instead), gate SSE terminal writes during tab switches, and add crash diagnostics with server-side breadcrumb collection.

## 0.3.4

### Patch Changes

- Fix Chrome tab freeze from flicker filter buffer accumulation during active sessions, and fix shell mode feedback delay by excluding shell sessions from cursor-up filter

## 0.3.3

### Patch Changes

- fix: eliminate WebGL re-render flicker during tab switch by keeping renderer active instead of toggling it off/on around large buffer writes

## 0.3.2

### Patch Changes

- Make file browser panel draggable by its header

## 0.3.1

### Patch Changes

- LLM context optimization and performance improvements: compress CLAUDE.md 21%, MEMORY.md 61%; SSE broadcast early return, cached tunnel state, cache invalidation fix, ralph todo cleanup timer; frontend SSE listener leak fix, short ID caching, subagent window handle cleanup; 100% @fileoverview coverage

## 0.3.0

### Minor Changes

- QR code authentication for tunnel access, 7-phase codebase refactor (route extraction, type domain modules, frontend module split, config consolidation, managed timers, test infrastructure), overlay rendering fixes, and security hardening

## 0.2.9

### Patch Changes

- System-level performance optimizations (Phase 4): stream parent transcripts instead of full reads, consolidate subagent file watchers from 500 to ~50 using directory-level inotify, incremental state persistence with per-session JSON caching, and replace team watcher polling with chokidar fs events

## 0.2.8

### Patch Changes

- Remove 159 lines of dead code: unused interfaces, functions, config constants, legacy no-op timer, and stale barrel re-exports

## 0.2.7

### Patch Changes

- Fix race condition in StateStore where dirty flag was overwritten after async write, silently discarding mutations
- Fix PlanOrchestrator session leak by adding session.stop() in finally blocks and centralizing cleanup
- Fix symlink path traversal in file-content and file-raw endpoints by adding realpathSync validation
- Fix PTY exit handler to clean up sessionListenerRefs, transcriptWatchers, runSummaryTrackers, and terminal batching state
- Fix sendInput() fire-and-forget by propagating runPrompt errors to task queue via taskError event
- Fix Ralph Loop tick() race condition by running checkTimeouts/assignTasks sequentially with per-iteration error handling
- Fix shell injection in hook scripts by piping HOOK_DATA via printf to curl stdin instead of inline embedding
- Narrow tail-file allowlist to remove ~/.cache and ~/.local/share paths that exposed credentials
- Fix stored XSS in quick-start dropdown by escaping case names with escapeHtml()

## 0.2.6

### Patch Changes

- Disable tunnel auto-start on boot; tunnel now only starts when user clicks the UI toggle

## 0.2.5

### Patch Changes

- Fix 3 minor memory leaks: clear respawn timers in stop(), clean up persistDebounceTimers on session cleanup, reset \_parentNameCache on SSE reconnect

## 0.2.4

### Patch Changes

- Fix tunnel button not working: settings PUT was rejected by strict Zod validation when sending full settings blob; now sends only `{tunnelEnabled}`. Added polling fallback for tunnel status in case SSE events are missed.

## 0.2.3

### Patch Changes

- Fix tunnel button stuck on "Connecting..." when tunnel is already running on the server

## 0.2.2

### Patch Changes

- Update CLAUDE.md app.js line count references

## 0.2.1

### Patch Changes

- Integrate @changesets/cli for automated releases with changelogs, GitHub Releases, and npm publishing

## 0.2.0

### Minor Changes

- Initial public release with changesets-based versioning
