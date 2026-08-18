# Mobile Guide

Codeman on a phone is not a shrunken desktop UI. It is the surface most of its design
attention has gone into, because checking on an agent from a bus is the thing this software
is for.

<p align="center">
  <img src="https://raw.githubusercontent.com/Ark0N/Codeman/master/docs/screenshots/mobile-session-keyboard-20260727.png" alt="Answering an agent prompt on a phone" width="300">
</p>

## Getting there

1. **Set up access.** Tailscale is the recommended route and gives you real HTTPS. See
   [Remote Access](Remote-Access).
2. **Log in by QR.** Open the dashboard on your desktop and scan the code. No password
   typing. Tokens are single use and rotate every 60 seconds.
3. **Install it to your home screen.** On iOS this is mandatory for push notifications;
   Safari does not deliver push to tabs. On Android it makes the app full screen.

HTTPS matters for more than security here: microphone access and push notifications both
require a secure context.

## The layout

| Element              | Where                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| Header               | Fixed at the top, deliberately minimal. Desktop-only controls never appear. |
| Tab strip            | Scrolls horizontally. The active tab is always scrolled into view.      |
| Terminal             | The rest of the screen.                                                |
| Toolbar              | Bottom: Run, Stop, **Enter**, case picker, voice, settings.             |
| Keyboard bar         | Above the on-screen keyboard when it is open.                           |

Layout respects notch and home-indicator safe areas, touch targets are 44px, and the case
picker is a bottom sheet rather than a dropdown.

**Swipe left and right** on the terminal to switch sessions.

## The home screen

Tapping the "C" logo gives a session overview rather than a welcome page:

1. **NEEDS YOU** first: sessions blocked on a question, with answer strips so you can
   resolve them without opening the session.
2. **CURRENT SESSIONS** with live status.
3. **PAST SESSIONS**, resumable.

Row status uses the same language as the tabs: green when fine, pulsing while working,
yellow when waiting for input, red when a question is pending.

The split Run button carries the same per-backend colours as the desktop toolbar, and its
picker mirrors the desktop run-mode menu.

On by default; it can be turned off in settings.

## The keyboard accessory bar

A row of keys above the virtual keyboard, and what it contains depends on the session.

**Agent sessions** get quick actions: `/init`, `/clear`, `/compact`, a clipboard key, `Esc`,
a path picker, an image key, and 🧠 when Read My Mind is on. Destructive commands need a
double press, so you cannot fire `/clear` with a stray thumb.

**Shell sessions** automatically swap it for terminal controls: `Ctrl`, `Esc`, `Tab`, four
arrows, paste, and dismiss. Your normal preference is remembered and restored when you
switch back to an agent session, so a settings change during a shell session cannot strip
the bar away permanently.

### One-shot Ctrl

`Ctrl` on the shell bar is a **one-shot modifier**: tap `Ctrl`, then tap `c`, and the
control byte is sent. It disarms on use, on a second tap, on any other accessory key, on a
session switch, and when the keyboard closes.

That list matters. A modifier left armed turns your next innocent keystroke into a control
byte, so it is deliberately eager to disarm. Keys with no control equivalent pass through
unchanged, exactly like a hardware keyboard.

## The Enter button

The toolbar's dedicated **Enter** button exists because of local echo. On a phone, the
characters you type are painted locally and have not reached the agent yet; Enter flushes
them and then submits.

It replays the keypress through the terminal rather than sending a bare carriage return.
Sending a bare `\r` would submit an empty line and strand your typed text on screen, which
looks exactly like a dead button.

On phones this button replaces the desktop's **Run Shell** control; starting a shell moved
into the Run dropdown.

## Scrolling and the keyboard

- The terminal and toolbar shift up when the keyboard opens, tracked through the browser's
  visual viewport rather than guessed.
- **Two ways to dismiss the keyboard**: tap outside the terminal on inert space, or tap twice
  on inert terminal content. Tapping a control never dismisses it, and tapping the prompt row
  keeps focus so you can place the caret.
- A scroll is never mistaken for a tap: travel is measured from the start of the gesture, and
  multi-touch never counts.

## Voice

The microphone button, or the keyboard bar. Providers and setup are covered in
[Input And Voice](Input-And-Voice). Dictating is often faster than typing a prompt on a
phone, and it is the main reason the feature exists.

## Notifications

Push notifications reach you with no tab open, and with the Approvals Inbox on they carry
**Approve** and **Deny** buttons handled by the service worker, so you can unblock an agent
from the lock screen.

Setup in [Notifications And Approvals](Notifications-And-Approvals).

## Reading long answers

The terminal viewport is small. **Last Response** (opt-in header button) renders the agent's
last answer as scrollable text instead, with a **More** button for additional context.

The [File Viewer](Working-With-Files) works on phones too, including edit mode, which is
enough to fix a typo an agent introduced while you are away from your desk.

## What is deliberately not on phones

- Extra header buttons. New header controls are kept off phones by policy, with a test that
  enforces it.
- The Approvals bell. Phones get the NEEDS YOU strips on the home screen instead.
- The desktop home tab rail, which needs a wide window.
- Lineage arcs, which are a desktop overlay.

## Gotchas

- **Typed text sitting on screen has not been sent.** Press Enter.
- **iOS needs the home screen install for push**, not just a bookmark.
- **iOS Safari can serve stale JavaScript after an update** until the tab is fully closed.
  Close it and reopen.
- **Plain HTTP over a LAN address disables voice and push.** Use HTTPS.
- **An armed `Ctrl` is visibly highlighted.** If it looks the same as a resting key, you are
  on an old version, on a light skin.

## Read next

- [Remote Access](Remote-Access) - getting the phone connected in the first place.
- [Notifications And Approvals](Notifications-And-Approvals) - being told when you are needed.
- [Input And Voice](Input-And-Voice) - local echo, dictation, and the input rules.
