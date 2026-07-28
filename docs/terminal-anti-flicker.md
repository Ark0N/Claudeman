# Terminal Anti-Flicker System

Claude Code uses [Ink](https://github.com/vadimdemedes/ink) (React for terminals), which redraws the entire screen on every state change. Without special handling, users see constant flickering. Codeman implements a 6-layer anti-flicker pipeline.

## Pipeline Overview

```
PTY Output → Server Batching → DEC 2026 Wrap → WS/SSE → Client rAF → Sync Parser → xterm.js
```

| Layer                    | Location                                            | Technique                                           | Latency  |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------- | -------- |
| **1. Server Batching**   | `sse-stream-manager.ts:batchTerminalData()`         | Adaptive 16-50ms collection window                  | 16-50ms  |
| **2. DEC Mode 2026**     | `sse-stream-manager.ts:flushSessionTerminalBatch()` | Wraps with `\x1b[?2026h`...`\x1b[?2026l`            | 0ms      |
| **3. SSE Broadcast**     | `server.ts:broadcast()`                             | JSON serialize once, send to all clients            | 0ms      |
| **4. Client pacing**     | `terminal-ui.js:flushPendingWrites()`               | One in-flight xterm parse followed by a paint yield | 0-16ms   |
| **5. Sync Block Parser** | xterm.js                                            | Native DEC 2026 synchronized-update parsing         | variable |
| **6. Chunked Loading**   | `terminal-ui.js:chunkedTerminalWrite()`             | 32KB per parsed-and-painted replay chunk            | variable |

## Server-Side Implementation (`sse-stream-manager.ts`)

### Constants

```typescript
const TERMINAL_BATCH_INTERVAL = 16; // Base: 60fps
const BATCH_FLUSH_THRESHOLD = 32 * 1024; // Flush immediately if >32KB
const DEC_SYNC_START = '\x1b[?2026h'; // Begin synchronized update
const DEC_SYNC_END = '\x1b[?2026l'; // End synchronized update
```

### Adaptive Batching (`batchTerminalData()`)

- Tracks event frequency per session via `lastTerminalEventTime` Map
- Event gap <10ms → 50ms batch window (rapid-fire Ink redraws)
- Event gap <20ms → 32ms batch window
- Otherwise → 16ms (60fps)
- Flushes immediately if batch exceeds 32KB for responsiveness

### Flush Logic (`flushTerminalBatches()`)

```typescript
const syncData = DEC_SYNC_START + data + DEC_SYNC_END;
this.broadcast('session:terminal', { id: sessionId, data: syncData });
```

## Client-Side Implementation (`terminal-ui.js`)

### `batchTerminalWrite(data)`

1. Checks if flicker filter is enabled (optional, per-session)
2. If flicker filter active: buffers screen-clear patterns (`ESC[2J`, `ESC[H ESC[J`, `ESC[nA`)
3. Accumulates data in `pendingWrites`
4. Calls `_scheduleTerminalWriteFlush()` if no flush is pending
5. The yielded callback clears its scheduled flag before calling `flushPendingWrites()`
6. One xterm write remains in flight until its parse callback runs
7. Large batches schedule their next chunk only after that callback and a paint yield

### `flushPendingWrites()`

- Joins the queued terminal data and passes DEC 2026 markers through to xterm.js 6, which handles synchronized output natively.
- Writes at most 16KB per yield on mobile, 32KB for desktop Codex, or 64KB for other desktop modes.
- Prefers the last complete DEC-2026 block inside that budget, publishing one coherent state per display frame.
- Requeues the remainder, waits for xterm's write callback, then gives visible pages a compositor frame before scheduling the next slice.
- Hidden pages use a timer/Worker fallback so output continues to drain when animation frames are throttled.
- Records parse callbacks above 100ms as `XTERM_PARSE` diagnostics.

### `chunkedTerminalWrite(buffer, chunkSize=32KB)`

- For large buffer restoration (session switch, reconnect)
- Waits for each xterm parse callback before yielding and writing the next 32KB
- Strips any embedded DEC 2026 markers from historical data
- In history-follow mode, pins the viewport to `baseY` after every parsed chunk

### `selectSession()` Optimizations

- Pauses client writes and crosses an xterm parser fence before snapshotting or
  resetting the shared terminal, so bytes queued by the outgoing session cannot
  render into the destination session.
- Restores a bounded in-memory xterm snapshot plus its warm live delta without refetching.
- Keeps a valid cached frame visible while a fresh stream is downloaded and compared.
- Starts bounded `latest=1` and newest tmux history-page requests concurrently.
- Requests 400 physical history rows at a time and starts edge loads three screenfuls early.
- Paints and captures the latest pane first, limited to `.xterm-screen` so the scrollbar stays live.
- Assembles the compressed page off-screen, then performs one bounded replay under the stable frame.
- Loads adjacent history pages only near a reading-window edge and retains at most six pages plus the latest pane.
- Reconciles live SSE batches against the snapshot cursor, including partial overlap.
- Removes the stable frame only after replay and queued live output cross an xterm paint fence.
- An unexpected terminal transport loss freezes the last composited Codex frame
  until an authoritative init identifies the reconnect as same-process or
  replacement-process. Reconnect bytes may parse underneath but cannot become
  visible before that decision.
- A replacement-process reload carries a one-shot recovery marker in
  `sessionStorage`. The new page uses a wider quiet window and bounded cover
  hold for the restored pane's post-attach redraw bursts, then clears the marker
  after revealing a settled frame.
- Terminal output arriving after cover removal was armed invalidates that paint
  fence generation. An older xterm callback therefore cannot reveal a frame
  after newer output extended the quiet deadline.

The snapshot transport and cursor contract are documented in
[terminal-streaming.md](terminal-streaming.md).

### Mobile Keyboard Transitions

- `KeyboardHandler` records whether terminal input or a regular form field opened the soft keyboard.
- Terminal focus adds a short-lived `keyboard-opening` state before the first `visualViewport` resize, pinning the handheld app before the browser can auto-scroll the layout viewport.
- A terminal-owned keyboard immediately unlocks local history, scrolls to the live prompt, and retains focus on the xterm/CJK input surface.
- `visualViewport` animation frames are coalesced into one settled layout pass. The generic terminal `ResizeObserver` returns while the keyboard is visible so it cannot trigger a delayed second reflow.
- Keyboard resize claims never use the force-redraw flag. The server therefore suppresses a same-size resize instead of sending an unnecessary `SIGWINCH`.
- Before a terminal-owned keyboard transition changes the viewport, Codeman clones the already-painted xterm DOM rows into an inert frame cover. Its frame translates toward the new bottom as the viewport shrinks instead of snapping with a bottom anchor. Local xterm resize renders cannot release the cover; parsed terminal output or completed session selection marks the destination frame ready. After two stable compositor frames, Codeman swaps the fully opaque cover out atomically, with a bounded timeout if the TUI does not repaint.
- Keyboard opening and closing use separate cover generations. Closing is recognized from meaningful growth above the keyboard-open minimum viewport height, so the cover starts during the first animation steps; the final hide threshold restarts it and invalidates any queued release before the full-height fit and `SIGWINCH` redraw can become visible. Smaller address-bar movement stays below that early-close threshold.
- Touch tab switches initially reuse the keyboard cover, then hand off to the destination's screen-only latest-frame cover while history loads. The completed selection restores focus, prompt anchoring, and local echo without scheduling a redundant second keyboard fit.
- Codex keyboard resizes and WebSocket attachment keep the prior frame covered while
  live output is gated. After a bounded TUI redraw interval, the browser captures
  the rendered tmux pane and its terminal cursor, replaces only xterm's visible rows,
  and reconciles queued live events against that boundary. Existing scrollback stays
  intact, and timing no longer chooses which intermediate redraw becomes visible.
- Touch Enter or terminal mouse selection on a visible decision prompt uses the same
  reconciliation transaction. Hook events improve prompt detection when available,
  but numbered-option detection keeps the behavior working when a provider exposes
  no corresponding hook.
- Provider mode is part of that rendering contract. New tmux sessions persist it
  in the `@codeman-mode` session option so a server restart cannot restore Codex
  as Claude and skip the quiet window. Legacy panes without the option are
  identified once from their live process and immediately upgraded in place.
- A keyboard-open drag that begins over transcript content keeps terminal focus and pins the local draft overlay to the visible viewport. A plain content tap still activates the touched TUI element and dismisses the keyboard.
- A form-owned keyboard may resize the local layout, but it does not steal focus, scroll terminal history, or resize the PTY behind the form.

## Optional Flicker Filter

Per-session toggle via Session Settings. Adds ~50ms latency but eliminates remaining flicker on problematic terminals.

## Codex Status Animation

Codex CLI's decorative working animation can emit about 30 small cursor-update
frames per second while changing terminal state much less often. On remote and
mobile clients this consumes render budget without adding useful information.
App Settings → Codex CLI → **Animated Status Effects** controls Codex's native
`tui.animations` setting for new local sessions and defaults off. This is a
source-level motion control: Codeman does not discard or rewrite terminal output.

### Detection Patterns

- `ESC[2J` — Clear entire screen
- `ESC[H ESC[J` — Cursor home + clear to end
- `ESC[?25l ESC[H` — Hide cursor + home (Ink pattern)
- `ESC[nA` (n≥1) — Cursor up (Ink line redraw)

When detected, buffers 50ms of subsequent output before flushing atomically.

## Latency Analysis

| Source                | Best Case      | Worst Case          | Notes                               |
| --------------------- | -------------- | ------------------- | ----------------------------------- |
| Active WebSocket      | 0ms (flush)    | 50ms                | Desktop 8ms/8KB; mobile 50ms/16KB   |
| Inactive/fallback SSE | 0ms (flush)    | 50ms (rapid events) | Immediate flush if >32KB            |
| Sync block wait       | 0ms            | 50ms                | Only if marker split across packets |
| Flicker filter        | 0ms (disabled) | 50ms (enabled)      | Optional per-session                |
| rAF scheduling        | 0ms            | 16ms                | Display refresh sync                |
| **Total**             | **0ms**        | **~115ms**          | Worst case rare in practice         |

**Typical latency:** 16-32ms (server batch + rAF)

## Edge Cases

- **Incomplete sync blocks**: xterm.js retains synchronized output until its closing marker
- **Fragmented WebSocket transactions**: size-bounded messages share one DEC-2026 pair, so transport fragmentation cannot publish partial redraws; authoritative pane replacement closes a partially parsed prior transaction before opening its own atomic repaint
- **Large histories**: Demand-paged tmux rows prevent full-history transfer and parsing; serial chunk budgets remain as a bounded fallback
- **Hidden tabs**: Worker wake-ups keep replay moving without racing the compositor while visible
- **Server shutdown**: Skips batching via `_isStopping` flag
- **Session switch**: Drains xterm's shared parser first, then clears flicker
  filter state, pending writes, and sync timeout. A replay epoch also suppresses
  stale viewport and local-echo callbacks.
- **Same-process SSE reconnect**: Reconciles session metadata without clearing the
  active terminal, scrollback, input draft, snapshots, or warm buffers
- **Server restart/deploy**: A changed `serverStartedAt` epoch persists input and
  reloads the page once so an open tab cannot continue running stale frontend
  code. The old page remains frame-frozen through epoch detection; the new page
  retains its stable frame through restored-session redraw settling.

## DEC Mode 2026 Compatibility

Terminals that natively support DEC 2026 buffer and render atomically. Codeman uses xterm.js 6, so the client passes the markers through instead of parsing or discarding partial blocks.

**Supporting terminals:** WezTerm, Kitty, Ghostty, iTerm2 3.5+, Windows Terminal, VSCode terminal

## Files Involved

| File                               | Key Functions                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/web/sse-stream-manager.ts`    | `batchTerminalData()`, `flushSessionTerminalBatch()`                                                        |
| `src/web/routes/session-routes.ts` | Streamed terminal snapshot endpoint                                                                         |
| `src/web/public/terminal-ui.js`    | `batchTerminalWrite()`, `flushPendingWrites()`, `chunkedTerminalWrite()`, `_readTerminalSnapshotResponse()` |
| `src/tmux-manager.ts`              | Durable provider-mode metadata and legacy pane recovery                                                     |
