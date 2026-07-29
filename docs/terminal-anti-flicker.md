# Terminal Anti-Flicker System

Claude Code uses [Ink](https://github.com/vadimdemedes/ink) (React for terminals), which redraws the entire screen on every state change. Without special handling, users see constant flickering. Codeman implements a 6-layer anti-flicker pipeline.

## Pipeline Overview

```
PTY Output → Server Batching → DEC 2026 Wrap → SSE → Client rAF → Sync Parser → xterm.js
```

| Layer | Location | Technique | Latency |
|-------|----------|-----------|---------|
| **1. Server Batching** | `server.ts:batchTerminalData()` | Adaptive 16-50ms collection window | 16-50ms |
| **2. DEC Mode 2026** | `server.ts:flushTerminalBatches()` | Wraps with `\x1b[?2026h`...`\x1b[?2026l` | 0ms |
| **3. SSE Broadcast** | `server.ts:broadcast()` | JSON serialize once, send to all clients | 0ms |
| **4. Client rAF** | `app.js:batchTerminalWrite()` | `requestAnimationFrame` batching | 0-16ms |
| **5. Sync Block Parser** | `app.js:extractSyncSegments()` | Strips DEC 2026 markers, waits for complete blocks | 0-50ms |
| **6. Chunked Loading** | `terminal-ui.js:chunkedTerminalWrite()` | 32KB/frame for large buffers | variable |

## Server-Side Implementation (`server.ts`)

### Constants

```typescript
const TERMINAL_BATCH_INTERVAL = 16;      // Base: 60fps
const BATCH_FLUSH_THRESHOLD = 32 * 1024; // Flush immediately if >32KB
const DEC_SYNC_START = '\x1b[?2026h';    // Begin synchronized update
const DEC_SYNC_END = '\x1b[?2026l';      // End synchronized update
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
6. Large batches schedule their own next chunk until the queue is empty

### `flushPendingWrites()`

- Joins the queued terminal data and passes DEC 2026 markers through to xterm.js 6, which handles synchronized output natively.
- Writes at most 32KB per yield for Codex and 64KB for other modes.
- Requeues the remainder and immediately schedules another safe yield. A final large response therefore drains without waiting for another SSE event.

### `chunkedTerminalWrite(buffer, chunkSize=32KB)`

- For large buffer restoration (session switch, reconnect)
- Writes 32KB per safe yield to avoid UI jank
- Strips any embedded DEC 2026 markers from historical data

### `selectSession()` Optimizations

- Starts buffer fetch immediately before other setup
- Shows "Loading session..." indicator while fetching
- Parallelizes session attach with buffer fetch
- Fire-and-forget resize (doesn't block tab switch)

## Mobile Keyboard Resize Cover

Phone keyboard animation changes xterm's row count before the foreground TUI
finishes its `SIGWINCH` redraw. During that interval the DOM renderer can expose
blank or partially reflowed rows even though terminal state is valid.

`KeyboardHandler` keeps the last painted `.xterm-rows` in an inert
`.terminal-resize-frame-cover` while the viewport settles. The clone is only a
visual cover: xterm remains the authoritative buffer, pointer events pass
through it, and shell sessions do not use it. The cover is armed immediately
before the resize and removed after xterm's parser callback, a short Codex
redraw quiet window, and two animation frames. A bounded expiry removes it when
no replacement output arrives; an active terminal buffer load keeps it in place
until that load finishes.

## Authoritative Mobile Frame Reconciliation

The cover hides transition frames, but it cannot determine whether xterm's
underlying pane is current. Touch-device Codex sessions therefore reconcile
after keyboard resizes, WebSocket attachment, and foreground dialogue
submission:

1. Coalesce overlapping requests so only the newest session/viewport transition
   can publish a frame. A newer request aborts the older settle or fetch.
2. Hold live SSE/WS writes behind the existing buffer-load ownership gate.
3. Fetch the bounded 128KB current pane from
   `/api/sessions/:id/terminal?latest=1&format=stream`.
4. Require a `mux-visible` source and terminal stream cursor, then cross xterm's
   parser fence.
5. Clear only the viewport, preserving xterm scrollback, and paint the pane
   inside one DEC 2026 synchronized update.
6. Replay only queued output after the snapshot cursor. Covered bytes are
   discarded and a cursor-crossing event contributes only its uncovered suffix.
7. Release the visual cover after the authoritative pane and any pending local
   input overlay have painted.

The stream endpoint and cursor metadata are the server contract; the client
keeps the JSON response as a compatibility fallback. Fetches have a bounded
timeout so a stalled capture cannot block later transitions indefinitely.

## Optional Flicker Filter

Per-session toggle via Session Settings. Adds ~50ms latency but eliminates remaining flicker on problematic terminals.

### Detection Patterns

- `ESC[2J` — Clear entire screen
- `ESC[H ESC[J` — Cursor home + clear to end
- `ESC[?25l ESC[H` — Hide cursor + home (Ink pattern)
- `ESC[nA` (n≥1) — Cursor up (Ink line redraw)

When detected, buffers 50ms of subsequent output before flushing atomically.

## Latency Analysis

| Source | Best Case | Worst Case | Notes |
|--------|-----------|------------|-------|
| Server batching | 0ms (flush) | 50ms (rapid events) | Immediate flush if >32KB |
| Sync block wait | 0ms | 50ms | Only if marker split across packets |
| Flicker filter | 0ms (disabled) | 50ms (enabled) | Optional per-session |
| rAF scheduling | 0ms | 16ms | Display refresh sync |
| **Total** | **0ms** | **~115ms** | Worst case rare in practice |

**Typical latency:** 16-32ms (server batch + rAF)

## Edge Cases

- **Incomplete sync blocks**: xterm.js retains synchronized output until its closing marker
- **Large buffers**: Chunked writing prevents UI freeze
- **Server shutdown**: Skips batching via `_isStopping` flag
- **Session switch**: Clears flicker filter state, pending writes, and sync timeout (prevents cross-session data bleed)
- **SSE reconnect**: `handleInit()` clears all pending write state
- **Superseded frame capture**: Aborts its settle/fetch and releases its buffer-load gate

## DEC Mode 2026 Compatibility

Terminals that natively support DEC 2026 buffer and render atomically. Codeman uses xterm.js 6, so the client passes the markers through instead of parsing or discarding partial blocks.

**Supporting terminals:** WezTerm, Kitty, Ghostty, iTerm2 3.5+, Windows Terminal, VSCode terminal

## Files Involved

| File | Key Functions |
|------|---------------|
| `src/web/server.ts` | `batchTerminalData()`, `flushTerminalBatches()`, `broadcast()` |
| `src/web/public/terminal-ui.js` | `batchTerminalWrite()`, `flushPendingWrites()`, `chunkedTerminalWrite()`, `_requestTerminalFrameReconcile()` |
| `src/web/public/mobile-handlers.js` | `_beginTerminalFrameCover()`, `_armTerminalFrameCover()`, `onTerminalFrameAuthoritative()` |
