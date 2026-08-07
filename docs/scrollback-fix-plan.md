# Scrollback fix plan (issue #205)

Status: IMPLEMENTED on `fix/scrollback-shell-alt-screen` (2026-08-07), with one deliberate
divergence from the recommendation below. Kept for the diagnosis record; the measured evidence
behind it is `docs/scrollback-issues-analysis.md`, and the mechanisms as shipped are documented
in `docs/architecture-invariants.md` (§ Full-scrollback replay, § Terminal scrollback: strip
flavors and wheel/touch forwarding).

What shipped vs. what this doc proposed:

- **Bug A (deltaMode)**: implemented as specified (`_wheelScrollLines()` normalizes
  line/page/pixel units, Shift-axis trap kept).
- **Bug B (shell scrollback)**: implemented via the NARROW alt-screen strip for tmux-backed
  shell/opencode/antigravity plus the scroll-to-top `full=1` re-pull, NOT the recommended
  approach (a) `tmux mouse on`. The measurements in the analysis doc showed the alt buffer
  comes from tmux's own client-side `smcup` at attach (tmux never forwards a pane program's
  alt-screen toggles), so stripping that one sequence fixes both symptoms with no selection
  tradeoff, keeps vim/less/htop untouched, and the re-pull also covers the repaint-burst
  history loss that `mouse on` would not have addressed.
- **Invariant change**: the "viewport-at-bottom gate stays" invariant below was deliberately
  DROPPED for forwarding modes: a repaint-mode CLI keeps no real terminal scrollback, so the
  gate pinned users to a buffer of stale frames whenever the viewport parked off-bottom.
  Forwarding now snaps to bottom first; Shift+wheel and the opt-out setting keep local
  scrollback reachable. Touch forwards through the same gate (the mobile half of the fix).
- **Finding 5 (remote probe)**: implemented (`probeRemoteCliVersion` over ssh, deferred at
  session start, same login-shell wrapper as the launch).

Original plan follows.

## Reports

- **Issue #205** (https://github.com/Ark0N/Codeman/issues/205), OPEN:
  - **jonocodes** (author, 2026-08-03): SHELL session. Host Mac M4, brew tmux. On Android, touch-scrolling the terminal does nothing. On desktop, the mouse wheel cycles shell command history (acts like Up/Down arrows) instead of scrolling the screen.
  - **mtiller** (comment, 2026-08-06): "similar issue just with scrolling backward to see agent output. This is with Firefox on MacOS." (Claude session implied.)
- **Reddit r/selfhosted** comment `p21x6ts` by mmtiller (= mtiller on GitHub): scrolling broken enough across phone/iPad/laptop that they fall back to Claude's own remote-control feature. Churn-risk user who otherwise loves the product; fixing this has promo value beyond the bug itself.

## How scrolling works today (read this before touching anything)

Three independent paths, all in `src/web/public/terminal-ui.js` unless noted:

1. **Desktop wheel** (container `wheel` listener, ~line 421): ALWAYS `preventDefault()`s, then either
   - forwards synthetic SGR wheel reports to the app (`_sendSyntheticSgrWheel`, coalesced every 40ms, fire-and-forget) when `_shouldForwardWheelToApp(ev)` (~line 2823) passes: no Shift held, opt-out setting `terminalWheelLocalScrollback` off, xterm `mouseTrackingMode === 'none'`, session mode is `claude` with `cliVersion >= 2.1.187` or `codex`, and viewport is at bottom;
   - otherwise scrolls xterm's LOCAL scrollback via `terminal.scrollLines(lines)`.
   - `lines` comes from `_wheelScrollLines(ev)` (~line 2818): `delta / 25`, i.e. it assumes PIXEL deltas.
   - NOTE: xterm.js's own internal wheel handler sits on an element INSIDE the container, so it runs FIRST (bubble order) and is not suppressed by the container's `preventDefault`.
2. **Touch** (touchstart/move/end, ~lines 441-585): converts touch deltas to `terminal.scrollLines()` with momentum. Touch is ALWAYS local-scrollback, never forwarded to the app. Tap-to-position (touchend, ~line 533) is separate and already handles both mouse-tracking-on and server-strip cases.
3. **Server-side strip** (`_handleTerminalOutput`, `src/session.ts:1384`): for modes in `isAltScreenStripMode()` (`src/session.ts:179` = `codex | claude | gemini`), strips alt-screen switches (`?47/?1047/?1049`), scrollback erase (`3J`), and mouse-tracking DECSETs (`?1000-?1007` except `?1004` focus) so content stays in xterm's normal buffer with scrollback intact. Includes a chunk-boundary carry so split sequences can't leak. `shell` and `opencode` (and `antigravity`) are deliberately EXCLUDED: arbitrary shell programs (vim/less/htop) legitimately need the alt screen. There is a parity copy of this strip on the replay path (`src/web/routes/session-routes.ts`, ~line 1697) and a frontend parity check `_sessionUsesServerMouseStrip()` (terminal-ui.js ~line 2751). All three must stay in sync.
4. Related: full-scrollback replay (`GET .../terminal?full=1` on first buffer load) fills xterm local scrollback; client scrollback is hardcoded 50k (`DEFAULT_SCROLLBACK`, constants.js) vs tmux 100k.

## Diagnosis

### Bug A: Firefox wheel deltas (mtiller's desktop case)

`_wheelScrollLines()` divides by 25 assuming `WheelEvent.deltaY` is pixels (`deltaMode === 0`, Chrome/Safari behavior). Firefox commonly fires `deltaMode === 1` (LINE units, deltaY around 1-3 per notch), so `Math.round(3/25) = 0` and the `|| ±1` fallback yields 1 line per event. With a discrete mouse wheel that is 1 line per notch: scrolling feels dead/broken. This hits BOTH the local-scroll path and the forwarded path, since both use the same function.

**Fix**: normalize by `ev.deltaMode` in `_wheelScrollLines()`:
- `deltaMode 0` (pixels): current behavior, `delta / 25`.
- `deltaMode 1` (lines): use the delta directly (round, keep sign fallback).
- `deltaMode 2` (pages): `delta * terminal.rows` (or a sane page size).
Keep the existing Shift-axis trap intact: on macOS trackpads Shift+two-finger scroll arrives as a HORIZONTAL wheel (deltaX carries the magnitude, deltaY ~0); that's why the function reads deltaX when Shift is held (issue #154). Don't lose it.

**Verify**: don't trust this diagnosis blindly. First reproduce in real Firefox on macOS and log `deltaMode`/`deltaY` (Firefox trackpad input can arrive as pixels; external mouse as lines). Also confirm the session's `cliVersion` probe succeeded (a failed probe disables forwarding entirely, which would point elsewhere). Unit-test by dispatching synthetic `WheelEvent`s with explicit `deltaMode` values; a Playwright `firefox` project pass is the end-to-end check.

### Bug B: shell mode has NO working scrollback at all (jonocodes)

Chain: shell mode is excluded from the alt-screen strip (correctly) → tmux attaches on the alternate screen → xterm's alt buffer has zero scrollback. Consequences:
- **Wheel**: xterm's own internal wheel handler runs first and, in the alt buffer, converts wheel ticks into Up/Down arrow keys (alternateScroll behavior). The shell receives arrows → command history cycles. That is jonocodes' exact desktop symptom. The container handler's `scrollLines()` afterwards is a no-op (no scrollback in alt buffer).
- **Touch**: the touch handler's `scrollLines()` is equally a no-op → "scrolling does nothing" on Android. Exact symptom two.
- The real history exists the whole time in tmux's 100k-line buffer; nothing exposes it.

**Fix, recommended approach (a): enable tmux `mouse on` for shell sessions.**
- Server-side, set `mouse on` scoped to shell sessions' tmux sessions (`tmux set-option -t <session> mouse on` at create + on attach of recovered sessions). Do NOT set it globally on the socket: claude/codex/gemini sessions rely on the DECSET strip and must not change.
- What this buys, all natively: tmux enables mouse tracking on the outer terminal → xterm `mouseTrackingMode` goes non-none → the container handler stands down (line ~2830 check) and xterm's own encoder forwards wheel as SGR reports → tmux scrolls its OWN copy-mode history on wheel-up, auto-exits at bottom. The alt-scroll arrow conversion disappears too (tracking mode takes precedence). Desktop is fully fixed with no new endpoints.
- **Touch**: still needs one small client change: in the touchmove path, when the active session is `shell` AND `mouseTrackingMode !== 'none'`, convert accumulated lines to `_sendSyntheticSgrWheel(x, y, lines)` instead of `scrollLines()`. The 40ms coalescing already prevents the tmux process storm (each send is a tmux send-keys server-side; unbatched flicks would spawn dozens of processes: this constraint is documented at `_sendSyntheticSgrWheel`, do not bypass it).
- **Selection tradeoff to verify**: with tracking on, xterm hands drag events to tmux instead of doing local browser selection. Shift+drag still does local selection (xterm shift-override). Verify this UX on desktop before shipping; if it's unacceptable, fall back to approach (b).
- **Also verify**: vim/less/htop inside the shell still behave (they'll now receive real mouse events via tmux, generally an improvement); remote shell sessions run tmux on the REMOTE host (`tmux -L codeman-remote`) and need the same option set there if remote shells are in scope (fine to defer, note it in the changeset if skipped).

**Fallback approach (b), only if (a)'s selection tradeoff fails testing**: keep mouse off; when a shell session is in the alt buffer, have the client send scroll intents to a small server endpoint that drives `tmux copy-mode -e -t <pane>` + `send-keys -X -N <n> scroll-up/down`. Preserves selection semantics exactly, but needs a new endpoint, server-side batching, AND suppression of xterm's native alt-scroll arrow conversion (capture-phase wheel listener with `stopPropagation`, or `attachCustomWheelEventHandler` if the vendored xterm version has it). More moving parts; (a) should be tried first.

**Not acceptable**: adding `shell` to `isAltScreenStripMode()`. vim/less/htop need the alt screen; that exclusion is deliberate and documented.

### Bug C: mtiller's phone/iPad case — UNREPRODUCED, do not guess

Touch is always-local by design, and Claude sessions keep content in the normal buffer (strip), so touch scrollback "should" work there. Before coding anything: build a repro matrix (iPhone Safari / iPad Safari / Android Chrome × claude / shell) on the current release. Plausible candidates if it does reproduce: auto-scroll-to-bottom fighting user scrolls (`_noteTerminalUserScroll`, ~line 2004), or they were in shell sessions on mobile too (then Bug B covers it). Ask mtiller on #205 for session mode + Codeman version if the matrix comes up clean.

## Invariants the implementation MUST respect

- Shift+wheel always scrolls local scrollback; the trackpad Shift-axis handling from #154 stays.
- The `terminalWheelLocalScrollback` opt-out setting keeps working (pins plain wheel to local).
- The viewport-at-bottom gate stays: once the user scrolled up locally, wheel stays local until they return to bottom.
- 40ms SGR coalescing: never send per-event writes to the server.
- Strip parity triangle: `session.ts` live strip ↔ `session-routes.ts` replay strip ↔ `_sessionUsesServerMouseStrip()` in the frontend. If you touch mode lists, update all three.
- Don't add `opencode`/`antigravity` to any strip/forward list; their TUI wheel behavior is unverified (documented at `_shouldForwardWheelToApp`).
- The chunk-boundary sequence carry in `_handleTerminalOutput` must not be weakened.

## Testing (per repo rules)

- `npm test -- test/<file>.test.ts` only; never bare `npm test`. New test ports 3150+, never 3000.
- Browser-test traps (documented in CLAUDE.md Testing): drive input/scroll through real events (`page.mouse.wheel`, real touch), not app internals; headless Chromium reports `isTouchDevice()` false even with `hasTouch: true`; assert on real state (xterm viewport position, `tmux -L codeman capture-pane`), not HTTP 200.
- Shell-mode E2E: create a throwaway shell session, `seq 1 500`, then (1) wheel up on desktop shows earlier lines, not history cycling; (2) touch-scroll on a phone shows earlier lines; (3) `vim` + `less` still enter/leave the alt screen cleanly; (4) Shift+drag still selects text.
- Firefox E2E: Playwright `firefox` project, wheel over a Claude session's finished output, assert viewport moved more than 1 line per notch.
- End-to-end against the REAL environment before claiming done (standing user rule). w1/w2/w3 tmux sessions are the user's live sessions: never send input to them; create your own throwaway session and DELETE it by exact id when done.

## Related observation (not a reported bug, worth a look while in there)

The `claude --version` probe that feeds the forwarding gate runs only for local and docker sessions (`src/session.ts:1490` gates `!this._remote`; docker handled at :1507). Remote Claude sessions therefore never get `cliVersion` and silently keep local-only wheel. Harmless (local scrollback works) but inconsistent; cheap to fix by probing over ssh, or document as intended.

## Rollout

1. Bug A (deltaMode) is small and independent: can ship alone as a patch.
2. Bug B (shell scrollback) is the headline fix for #205: patch or minor per COM flow.
3. After deploy + verification: comment on #205 (what was fixed, what needs their retest), then reply to the Reddit comment `p21x6ts` with the release version. Both reporters gave environment details; address them specifically.
