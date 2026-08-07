# Scrollback issues: analysis and test evidence

Covers GitHub issue **#205** ("Scrollback in terminal not working", jonocodes, shell mode,
Android + macOS desktop) and the follow-up comment on it from **mtiller** (Firefox on macOS,
"scrolling backward to see agent output"). Related closed issue: **#154** (fixed in 1.3.3).

Status: **analysis only, nothing implemented.** Measured against the live 1.11.2 instance on
2026-08-06 with throwaway `zz-*` shell sessions (all deleted afterwards; the user's `w*`
sessions were never touched).

---

## TL;DR

Five distinct problems, not one. #205 is fully explained by finding 1; findings 2 and 3 are
independent and hit **every** mode including Claude, and are the likely substance of the
"similar issue" follow-up.

| # | Problem | Modes affected | Severity | Confirmed |
| - | ------- | -------------- | -------- | --------- |
| 1 | xterm parked in the **alternate buffer** for the whole session, so there is no scrollback at all and the wheel is translated into Up/Down arrow keys | `shell`, `opencode`, `antigravity` | High | Reproduced end to end |
| 2 | **Bursty output silently destroys a screenful** of the browser's scrollback and adds ~1 row | all | High | Measured |
| 3 | **Tab switch collapses scrollback** to roughly one screen (`full=1` fires once per page load) | all | Medium | Measured |
| 4 | `deltaMode` is never read, so Firefox scrolls ~4x slower per notch | all, Firefox | Low | Static, needs reporter data |
| 5 | **Remote SSH Claude cases get no `claude --version` probe**, so wheel forwarding silently stays off (residual #154) | `claude` + remote | Medium | Static |

---

## Finding 1: shell / opencode / antigravity are stuck in xterm's alternate buffer

### Root cause

The local tmux **client** (the `tmux attach` that node-pty spawns) emits `smcup` as its very
first bytes on attach. Captured from a real PTY:

```
b'\x1b[?1049h\x1b[22;0;0t\x1b[?1h\x1b=\x1b[H\x1b[2J\x1b[?12l\x1b[?25h\x1b[?1000l...'
 ^^^^^^^^^^ enter alternate screen              ^^^^^ application cursor keys ON
```

`Session._handleTerminalOutput()` strips `\x1b[?1049h` from the live stream, but only when
`isAltScreenStripMode(mode)` is true, and that is `claude | codex | gemini` only
(`src/session.ts:179`). For `shell`, `opencode` and `antigravity` the sequence reaches the
browser verbatim and xterm switches to the alternate buffer, where:

1. `buffer.active.type === 'alternate'` and `baseY` is pinned at 0, so there is **no
   scrollback to reach**. `terminal.scrollLines()` is a no-op, which is why touch scrolling
   on Android "does nothing".
2. xterm's own wheel listener takes over. From the vendored bundle
   (`src/web/public/vendor/xterm.min.js`):

   ```js
   if (!this.buffer.hasScrollback) {
     if (ev.deltaY === 0) return false;
     if (coreMouseService.consumeWheelEvent(...) === 0) return this.cancel(ev, true);
     const seq = ESC + (decPrivateModes.applicationCursorKeys ? 'O' : '[') + (ev.deltaY < 0 ? 'A' : 'B');
     coreService.triggerDataEvent(seq, true);
     return this.cancel(ev, true);
   }
   ```

   tmux also set `\x1b[?1h`, so the emitted sequence is `\x1bOA`, i.e. **Up arrow**, straight
   into the shell's readline. That is exactly the reported "the mouse wheel scrolls back
   through previous commands, like pressing up".

3. `cancel(ev, true)` calls `preventDefault()` **and `stopPropagation()`**, and xterm's
   listener sits on `terminal.element` (a child of Codeman's container). So Codeman's own
   container wheel handler, `_shouldForwardWheelToApp` and `_wheelScrollLines` included, is
   **never reached** for these modes. That whole path is dead code for shell.

### Reproduction (live instance, real browser)

Create a shell session with the page already open, print 150 lines, then dispatch 8 wheel-up
events over `.xterm-screen`:

```
t+1500 after shell start       {"type":"alternate","length":35,"baseY":0}
t+3000 after shell start       {"type":"alternate","length":35,"baseY":0}
after 150 live lines           {"type":"alternate","length":35,"baseY":0}
WHEEL on live shell: {"ptyBytes":["OA","OA","OA","OA",
                                  "OA","OA","OA","OA"],
                     "before":0,"after":0,"type":"alternate"}
```

Both reported symptoms, one root cause.

### Why it looks intermittent

The alternate-screen sequence only ever reaches the browser through the **live stream at
attach**. Neither replay path carries it:

- `?full=1` returns `capture-pane` output (`source: mux-full-history`), verified 0 hits for
  `\x1b[?1049h`.
- `?tail=` returns the visible pane frame (`source: mux-visible`), also 0 hits; the shell byte
  buffer was empty in every probe.
- `_resetTerminalForReplay()` calls `terminal.reset()`, which returns xterm to the normal
  buffer.

So: watching a shell from creation leaves you in the alternate buffer until you reload or
switch tabs, at which point it silently starts working again. Then the next PTY attach (a
restart, or the auto-reattach in `selectSession()`) puts you back.

### Is stripping safe for shell? Probably yes when tmux-backed, and the current code comment is wrong about why

`src/session.ts:1404` says *"shell must keep the alt screen for vim/less/htop"*. For a
**tmux-backed** shell that reasoning does not hold: tmux is a full terminal emulator and never
forwards a pane's alternate-screen toggles to its client, it repaints instead. Measured per
phase on a real attach:

| phase | bytes | `?1049h` | `?1049l` | `?47/1047` |
| ----- | ----: | -------: | -------: | ---------: |
| attach | 772 | **1** | 0 | 0 |
| `seq 1 60` echo | 1402 | 0 | 0 | 0 |
| `less` open / end / quit | 284 / 230 / 321 | 0 | 0 | 0 |
| `vim` open / quit | 2200 / 646 | 0 | 0 | 0 |

`vim` and `less` inside tmux emit **zero** alternate-screen sequences to the client.

The caveat that does matter: `startShell()` falls back to a **direct PTY with no tmux** when
mux creation fails (`src/session.ts:1961`, `this._useMux = false`). In that path the inner
app's own `?1049h` does reach xterm, and a blanket strip would break vim/less/htop for real.
Any fix has to be conditional on `_useMux`, which is known server-side.

Second caveat: stripping alone buys less than it looks like, because of finding 2. It fixes
the wheel (no more phantom Up arrows) and it makes the `full=1` replay reachable, but live
output still will not accumulate.

---

## Finding 2: bursty output silently overwrites a screenful of browser scrollback

Independent of the alternate buffer, and it hits Claude sessions too.

tmux decides per flush whether to emit real linefeeds (which push rows into the outer
terminal's scrollback) or to repaint the pane rectangle with cursor addressing (which
overwrites the visible rows in place). When output outpaces its flush interval it coalesces
into a repaint, and one screenful of the browser's history is **destroyed**.

Measured on one session, same page, `rows = 36`:

| step | `baseY` | rows containing SEED | BURST | SLOW |
| ---- | ------: | -------------------: | ----: | ---: |
| after `?full=1` replay (120 seeded lines) | 86 | 120 | 0 | 0 |
| after 60 lines emitted as fast as possible | **87** (+1) | **86** (-34) | 35 | 0 |
| after 60 lines at ~16/s (`sleep 0.06`) | **148** (+61) | 86 | 35 | 60 |

The burst added **one** row of scrollback and ate **34** rows of existing history. The slow
run behaved correctly. So "I printed a bunch of lines and now I cannot scroll back" reproduces
without the alternate buffer being involved at all, and it is rate dependent, which is exactly
the kind of thing that reads as random flakiness.

Consequence: the browser's scrollback is effectively frozen at whatever the last `?full=1`
replay produced, minus a screen per burst. tmux's own history is fine throughout
(`history_size` kept growing, `history-limit` 2000), so the data is never actually lost
server-side, it just never reaches the browser again until a reload.

---

## Finding 3: switching tabs collapses a session's scrollback

`_initialFullBufferLoad` is true for the **first buffer load after a page load only**
(`app.js:4374`). Everything after that uses `?tail=`, which returns byte history plus the
visible pane frame. Worse, the snapshot restore path deliberately throws away the restored
xterm snapshot (which does carry scrollback) and replaces it with that frame
(`app.js:4316-4328` plus `needsRewrite`).

Measured, switching away from session A and back:

```
A: initial full=1 load           {"len":152,"baseY":116,"AAA":150}
A: after switch away and back    {"len": 87,"baseY": 51,"AAA": 59}
```

150 lines of history down to 59. Note also that the page's single `full=1` is consumed by
whichever session auto-selects at load, so **every other tab starts life with one frame of
history**.

---

## Finding 4: `deltaMode` is never read (Firefox)

`grep -rn "deltaMode" src/web/public packages` returns nothing. `_wheelScrollLines()`
(`terminal-ui.js:2818`) treats `deltaY` as pixels unconditionally:

```js
return Math.round(delta / 25) || (delta > 0 ? 1 : -1);
```

Chrome/WebKit report `deltaMode: 0` with `deltaY` around 100 to 120 px per notch, so about 4
to 5 lines. Firefox reports `deltaMode: 1` (`DOM_DELTA_LINE`) with `deltaY` around 3, so
`Math.round(3/25) === 0` and the `|| ±1` fallback yields **1 line per notch**, roughly 4x
slower. In Claude mode the same value caps the forwarded SGR report at 1 tick per event
instead of 4, so the transcript crawls too.

This is sluggishness, not breakage, so it is a plausible but unproven contributor to the
mtiller report. No Firefox build is installed under `~/.cache/ms-playwright` (chromium and
webkit only), so this was not measured. Worth asking the reporter for `deltaMode` / `deltaY`
from a live wheel event before acting on it.

---

## Finding 5: remote SSH Claude cases still have no version probe

`src/session.ts:1490` deliberately skips the deterministic `claude --version` probe for
remote sessions and defers to the startup-banner scrape, which the same comment block
describes as unreliable ("newer Claude Code builds don't print the banner and resumed sessions
never show it"). That is precisely the condition #154 was filed for: `cliVersion` empty means
`_shouldForwardWheelToApp()` returns false, wheel forwarding is off, and the user is left with
local scrollback that (per finding 2) does not accumulate.

Local and Docker Claude sessions are fine; verified all 7 live sessions report
`cliVersion=2.1.223`, so the 1.3.3 fix is still working there.

---

## Candidate directions (not decided)

Roughly in order of value per unit of risk.

1. **Extend the alternate-screen strip to tmux-backed `shell` / `opencode` / `antigravity`.**
   Gate on `_useMux` so the direct-PTY fallback keeps vim/less/htop working. Kills the phantom
   Up arrows and makes replayed history reachable. `isAltScreenStripMode()` currently takes
   only `mode`, so it would need the mux flag threaded in, and
   `test/claude-scrollback-strip.test.ts:16-17` plus `test/antigravity-mode.test.ts:116` pin
   the current answers and would need updating.

2. **Re-pull `?full=1` when the user scrolls to the top of the buffer.** Directly addresses
   findings 2 and 3 with machinery that already exists and is already proven to return
   complete history (200/200 lines in the probe). Needs a guard against refetch storms.

3. **Stop discarding the xterm snapshot on tab switch**, or request `full=1` on the first load
   per session rather than per page. Cheaper partial fix for finding 3 alone.

4. **Read `ev.deltaMode`** in `_wheelScrollLines()` and normalise line/page deltas to lines.
   Small, self-contained, worth doing regardless of whether it is mtiller's actual bug.

5. **Probe the CLI version over SSH for remote Claude cases**, mirroring the deferred
   in-container probe that Docker cases already use.

Option 1 alone does not fix #205's "print a bunch of lines then scroll" complaint; that needs
2 as well.

## Reproduction assets

Scripts used, in the session scratchpad
(`/tmp/claude-1000/-home-arkon-default-claudeman/597ffc9f-.../scratchpad/`):

- `ptycap.py` / `ptycap2.py`: PTY-level capture of the tmux client stream, per phase counts of
  alternate-screen and mouse-tracking sequences.
- `sim.mjs`: replays a captured stream through `@xterm/headless` with and without the strip.
- `browser-test*.mjs`: Playwright against the live instance, reports `buffer.active.type`,
  `baseY`, row content and the exact bytes xterm sends to the PTY on a wheel event.

`@xterm/headless` was installed with `npm i --no-save`, so `package.json` and the lockfile are
untouched.
