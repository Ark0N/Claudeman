# Mobile Navigation and Hook Audit

**Date:** 2026-07-25
**Checkout:** `master` at `86c6349` (`codeman@1.8.0`)
**Scope:** Keyboard-hidden mobile navigation between dispatched-agent menu
entries, an up+down Enter chord, physical volume-key feasibility, and stale
Claude hook registrations.

## Executive Summary

| Proposal                                | Verdict                | Reason                                                                                     |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| Keyboard-hidden terminal controls       | Implemented            | Esc, Up, Enter, Down, and Tab reuse Codeman's reliable raw PTY input path.                 |
| Press up+down together for Enter        | Implemented            | Pointer Events detect the chord without focusing an editable element.                      |
| Vertical swipe over the terminal        | Do not add globally    | One-finger vertical movement already drives xterm scrollback and would double-act.         |
| Vertical swipe in a dedicated edge zone | Implemented on the pad | The navigation band is a separate gesture surface from terminal scrollback.                |
| Physical phone volume buttons           | DOM fallback only      | Android Chrome filters the hardware keys before Blink; exposed standard events still work. |
| Active phone/desktop viewport handoff   | Implemented            | A trusted pointer interaction claims the shared PTY size without forcing keyboard focus.   |
| Remove nonexistent Codeman hooks        | No removals found      | All six generated registrations are current Claude Code events or notification matchers.   |
| Reduce hook noise                       | Implemented            | Lifecycle hooks remain, with quieter categorization and drawer defaults.                   |

The implementation is a compact touch navigation pad that is visible while the
software keyboard is hidden, paired with the existing full accessory bar while
the keyboard is open. Both surfaces use the same setting and raw PTY transport.
The keyboard-hidden surface never calls `terminal.focus()`.

## Implementation Outcome

`MobileNavigationPad` now supplies 48 px Esc, Up, Enter, Down, and Tab controls
above the mobile toolbar. Esc and Tab occupy the far edge zones, separated from
the centered Up, Enter, and Down cluster to reduce accidental activation. Arrow
actions fire on release, simultaneous Up+Down emits one Enter without leaking
arrows, and blank space in the same band accepts short vertical swipes. The
controls are enabled by default on touch devices and are controlled from
**App Settings → Input → Mobile Terminal Controls**.
When the reader leaves live output, a contextual jump-to-latest icon appears
above the centered three-button cluster without changing the band or terminal
height. It covers both xterm scrollback and Claude-owned transcript history.
The same setting enables the full keyboard-open accessory bar and Volume Up,
Volume Down, and two-key Enter handling when the browser dispatches standardized
volume-key events. Android Chrome does not.

The setting is device-local. With an active session, the keyboard-hidden pad
swaps to the full accessory bar when the software keyboard appears; Codeman's
footer toolbar stays hidden so exactly one 44 px control row is reserved.
Without an active session, neither surface reserves space. Touch tablets can
enable the same setting even when their wider layout does not show the
keyboard-hidden pad. Phone keyboard geometry follows stable handheld identity
rather than only a width breakpoint, because display scaling, landscape, and
foldable postures can expose a desktop-width viewport on a physical phone.
Android Chromium is asked to resize the layout viewport around the software
keyboard through `interactive-widget=resizes-content`; the existing
`visualViewport` handling remains the fallback for browsers that ignore that
viewport token. Accessory buttons are vertically contained by their fixed-height
row so the operating-system keyboard cannot cover half of a control.

Ordinary xterm and Claude transcript scroll gestures keep their existing
direction and momentum. While the phone keyboard is open, a drag over
non-input transcript content preserves input focus and pins the pending draft
above the keyboard; a tap remains a content activation and dismisses input.
CLI permission and selection prompts remain inside the terminal above the
reserved control band. Codeman HTML modals temporarily hide both control
surfaces and their layout reservation so they cannot cover modal actions,
including dynamically inserted, `.show`, and inline-display dialogs.

The PTY has one row/column size shared by every connected viewport. Resize
messages can now carry an explicit `takeControl` flag. Trusted primary pointer
interactions, page focus/visibility return, tab activation, keyboard transitions,
and ordinary input reassert that connection's last announced dimensions,
allowing the phone or desktop that is actually in use to claim the PTY
immediately. Accessory taps do not repeatedly refit the PTY while the software
keyboard is open; the existing one-shot keyboard transition resize remains
authoritative. Passive background desktop restores do not displace an active
phone. This prevents a desktop-width stream from being rendered in a narrow
mobile xterm, which caused the dot-fill, wrapped-line, and overdraw artifacts.

Hook processing also remains intact. Response-complete drawer entries now default
off, while legacy users with browser, audio, or push delivery explicitly enabled
retain it. Agent-team events use the existing opt-in subagent categories instead
of the general session idle/stop preferences.

## Current Mobile Input Paths

### Session swipes

[`SwipeHandler`](../../src/web/public/mobile-handlers.js) listens on `.main` for
a single fast horizontal gesture. Left and right call `nextSession()` and
`prevSession()` respectively.

Session selection already protects against unwanted keyboard activation.
[`_shouldFocusTerminalForTabSwitch()`](../../src/web/public/app.js) focuses xterm
on touch devices only when `KeyboardHandler.keyboardVisible` is already true.
Horizontal session swipes therefore do not summon a hidden keyboard.

### Terminal vertical touch

[`terminal-ui.js`](../../src/web/public/terminal-ui.js) owns one-finger vertical
movement because xterm's DOM renderer does not provide a native scrollable
viewport. After 8 px of movement it:

1. marks the interaction as a scroll;
2. calls `preventDefault()`;
3. translates pixels into `terminal.scrollLines()` calls; and
4. applies momentum after touch end.

Only a non-scrolling input tap calls `terminal.focus()`. When input already owns
an open keyboard, the handler delays its content-blur decision until the 8 px
threshold: a drag keeps the draft pinned and scrolls, while a tap still belongs
to the foreground TUI. Extending the global `SwipeHandler` with up/down actions
would make a fast scrollback gesture also navigate the terminal menu.

### Existing arrow transport

[`MobileTerminalControls`](../../src/web/public/keyboard-accessory.js) owns the
shared semantic mapping used by both responsive surfaces:

| Action     | PTY bytes |
| ---------- | --------- |
| Arrow up   | `\x1b[A`  |
| Arrow down | `\x1b[B`  |
| Enter      | `\r`      |
| Escape     | `\x1b`    |
| Tab        | `\t`      |

`sendKey()` routes these bytes through `app.sendTerminalKey()`, which uses
Codeman's existing reliable input queue. While the keyboard is hidden, it also
requests active viewport sizing without waiting on that network request. The
transport does not require terminal focus. The keyboard-open accessory still
refocuses xterm after applicable actions to keep the virtual keyboard open; the
keyboard-hidden pad deliberately does not.

## Implemented Interaction

`MobileNavigationPad` follows these constraints:

- Initialize only on touch devices.
- Show only when a session is active, the keyboard is hidden, and the user
  enables the control.
- Render fixed-size Esc, Up, Enter, Down, and Tab buttons outside the xterm
  touch surface.
- Show the centered jump-to-latest action only while the active session is
  known to be reading local or TUI-owned history.
- Use the existing reliable raw PTY input queue.
- Never call `terminal.focus()`, focus a hidden textarea, or synthesize a terminal
  click.
- Set `touch-action: none` on the controls and handle `pointercancel`.
- Keep button geometry stable and at least 44 by 44 CSS pixels.
- Include a visible Enter icon as an accessible fallback even if the two-button
  chord is supported.

The first version should target the agent dispatcher's terminal menu. If the
desired target is instead Codeman's own subagent panel,
[`selectSubagent()`](../../src/web/public/panels-ui.js) can use the same controls:
filter agents by `parentSessionId === activeSessionId`, apply the panel's existing
active-first/activity ordering, and select the adjacent entry. Parent associations
already persist in `subagentParentMap`.

### Up+down Enter chord

Arrow actions must fire on release, not press. Otherwise the first finger leaks an
arrow before the second finger completes the chord.

```text
pointerdown(direction, pointerId):
  remember pointerId and direction
  if the opposite direction is held:
    send "\r" once
    mark both pointers consumed

pointerup(pointerId):
  if pointerId was not consumed:
    send the remembered arrow sequence
  clear pointer state

pointercancel(pointerId):
  clear pointer state without sending
```

Use pointer capture and suppress the subsequent `click` event so one physical
gesture cannot dispatch twice. Do not add key repeat in the first release; repeat
timers complicate chord detection and can flood an interactive menu.

### Dedicated swipe mode

Vertical navigation is not bound to the whole `.main` or xterm container. The
implementation uses the pad itself: an upward gesture sends Arrow Up and a
downward gesture sends Arrow Down.

This preserves ordinary one-finger scrollback everywhere else. A two-finger
terminal swipe is technically distinguishable, but it is less discoverable and
competes with browser zoom gestures.

## Volume-Key Feasibility

The W3C defines `AudioVolumeUp` and `AudioVolumeDown` key values, but does not
require user agents to expose them. Android defines physical volume key codes for
native applications, while browser and operating-system routing can consume those
keys before a page receives an event. The Media Session action list also has no
volume up/down handler.

Codeman listens for the standardized DOM key values as a progressive enhancement
while Mobile Terminal Controls are visible. A single volume direction sends its
arrow on release; overlapping up and down presses send one Enter without leaking
either arrow. The handler prevents the event's default action when possible,
never focuses xterm, and disables itself with the same setting and modal
visibility rules as the on-screen pad. Pixel 8 testing confirmed that Android Chrome's
`ContentUiEventHandler` filters `KEYCODE_VOLUME_UP` and `KEYCODE_VOLUME_DOWN`
before Blink, so Chrome never creates the DOM events this handler needs.

Consequences:

- Keep the on-screen pad as the dependable control; volume keys are an additional
  input path.
- A browser may never dispatch the physical key event, and `preventDefault()` is
  not guaranteed to suppress the operating system's volume change.
- Reliable phone volume-button support requires a native Android wrapper that
  intercepts `KeyEvent` before its WebView. That adds a separate distribution and
  lifecycle surface.
- A physical up+down volume chord is even less dependable because the operating
  system can intercept or serialize the presses.
- Automated browser coverage verifies the DOM-event mapping, not whether a
  particular phone/browser combination exposes its physical buttons.

Primary references:

- [W3C UI Events key values](https://www.w3.org/TR/uievents-key/)
- [Android `KeyEvent`](https://developer.android.com/reference/android/view/KeyEvent.html)
- [Chromium Android input routing](https://chromium.googlesource.com/chromium/src/+/27c7fe6e7a57093e09bcdb675cc6cfedac716110/content/public/android/java/src/org/chromium/content/browser/ContentUiEventHandler.java)
- [Media Session actions](https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setActionHandler)

## Hook Audit

[`generateHooksConfig()`](../../src/hooks-config.ts) creates six Codeman
registrations:

| Registration                      | Current support | Codeman dependency                        |
| --------------------------------- | --------------- | ----------------------------------------- |
| Notification `idle_prompt`        | Supported       | idle state and user attention             |
| Notification `permission_prompt`  | Supported       | approval required                         |
| Notification `elicitation_dialog` | Supported       | question/elicitation blocking             |
| `Stop`                            | Supported       | definitive respawn-controller idle signal |
| `TeammateIdle`                    | Supported       | agent-team progress                       |
| `TaskCompleted`                   | Supported       | agent-team progress                       |

The installed hook targets were also checked:

- the generated Codeman hooks post directly with `curl`;
- the configured `codegraph prompt-hook` executable exists;
- the configured `pbcm-nudge.sh` script exists and is executable;
- the enabled session-driver plugin reports a valid installation; and
- Claude debug logs contain no matching missing-command, `ENOENT`, or invalid-hook
  errors.

No hook registration qualifies for removal. In particular, deleting `Stop` would
break the respawn controller, transcript/session ID adoption, SSE broadcasting,
push delivery, and run summaries handled by
[`hook-event-routes.ts`](../../src/web/routes/hook-event-routes.ts).

The repeated `hookify/.../hooks/stop.py` missing-file prompt was separate from
Codeman's generated hooks. It came from a stale cached Codex plugin bundle under
`~/.codex/plugins/cache/claude-code-plugins/hookify/`; that broken cache entry was
removed. No Codeman source hook was removed to silence an external plugin error.

### Actual source of hook noise

[`settings-ui.js`](../../src/web/public/settings-ui.js) emits a drawer notification
for every `Stop`, `TeammateIdle`, and `TaskCompleted` event.
[`notification-manager.js`](../../src/web/public/notification-manager.js) adds an
enabled event to the drawer even when browser and audio delivery are disabled.
It also aliases:

- `hook-teammate-idle` to the general `idle_prompt` preference; and
- `hook-task-completed` to the general `stop` preference.

Implemented cleanup:

1. Keep all backend hook registrations.
2. Preserve `Stop` processing while defaulting its drawer category off.
3. Route `teammate_idle` and `task_completed` through opt-in subagent activity
   preferences instead of unrelated idle/stop categories.

Future refinements could coalesce repeated teammate-idle entries by teammate
identity and label Claude-only preferences by run mode.

The local hook reference was stale and omitted the two agent-team events. It was
updated as part of this audit against the current
[Claude Code hook reference](https://code.claude.com/docs/en/hooks).

## Verification

Targeted JSDOM tests cover exact arrow/Enter bytes, touch and volume-key chord
suppression, `pointercancel`, short-swipe rejection, dialog visibility, and
notification migration. The mobile Playwright suite covers:

1. hidden-keyboard visibility with an active session;
2. a flush 48 px five-button row with protected Esc/Tab edge zones, a centered
   Up/Enter/Down cluster, matching terminal background, and non-overlap among CLI
   content, pad, and toolbar;
3. trusted Up input with viewport takeover but without xterm focus or
   viewport-height change;
4. exactly one Enter from simultaneous Up+Down;
5. navigation-band swipe input;
6. the App Settings disable/save/reopen/enable path; and
7. keyboard-open accessory input without a refit or keyboard dismissal;
8. swapping between the navigation pad and the keyboard-open full accessory bar;
9. no blank reservation when controls are disabled or during keyboard animation;
10. modal coexistence for both responsive surfaces; and
11. standardized volume-key DOM events, including the two-key Enter chord.

Server and transport tests additionally cover explicit mobile takeover while a
desktop claim is fresh, desktop reclaim on ordinary pointer interaction, and
HTTP/WebSocket flag forwarding. A scaled Android regression verifies stable
handheld keyboard geometry above the phone breakpoint, layout-viewport resizing,
and full accessory-button containment at the keyboard edge. WebKit-specific
execution and an explicit regression test proving terminal vertical swipes never
post arrows remain useful follow-up coverage.

## Repository Coherence Pass

The final pass kept the feature within existing ownership boundaries:

- `MobileTerminalControls` owns initialization, enablement, modal policy, and the
  shared semantic key mapping; `KeyboardAccessoryBar` and `MobileNavigationPad`
  own only their responsive interaction surfaces.
- `CodemanApp.sendTerminalKey()` is the single bridge into the existing reliable
  input queue and viewport takeover protocol.
- `CodemanApp.sendResize()` is the single owner of dimension tracking, viewport
  classification, and WebSocket-first transport with HTTP fallback. Debounced
  window resizes keep their existing reflow cleanup, then delegate transport to
  this method.
- One canonical device-local setting replaces the old simple/extended mode
  toggle. The preview `mobileNavigationPadEnabled` key and shipped
  `extendedKeyboardBar` key remain read-only fallbacks. Legacy `false` is not a
  disable signal because it previously selected compact mode; enabled controls
  now use the unified full bar.
- `KeyboardHandler` remains the only owner of virtual-keyboard transition sizing;
  accessory taps do not create competing resize loops.
- The standards-based Android layout-viewport opt-in complements that handler;
  unsupported browsers continue through the existing `visualViewport` path.
- Existing session resize arbitration handles both HTTP and WebSocket takeover,
  with focused route, arbitration, and cross-viewport browser coverage.
- Stable handheld CSS applies across scaled, landscape, and foldable widths, while
  the five-button navigation row remains limited to compact layouts.

## Original Estimated Scope

| Work                                                             | Estimate                          |
| ---------------------------------------------------------------- | --------------------------------- |
| Keyboard-hidden pad, chord state, preference, and targeted tests | 0.5-1 day                         |
| Dedicated edge swipe and conflict tests                          | additional 0.5 day                |
| Notification categorization/noise cleanup and tests              | 0.5 day                           |
| Native Android volume-key wrapper                                | 2-5 days plus release maintenance |
