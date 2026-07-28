# Terminal Snapshot Streaming

Codeman restores a terminal from three coordinated sources:

1. a bounded rendered tmux history page;
2. a current-pane HTTP snapshot; and
3. live `session:terminal` events arriving over SSE, followed by WebSocket output.

HTTP content encoding remains lossless: Fastify negotiates Brotli or gzip, and the browser
decompresses each response incrementally. History download and terminal parsing are
decoupled: the bounded page assembles off-screen, then xterm parses it in one replay
transaction behind the current-frame cover.

## Cursor Contract

Every Session owns a terminal stream id and a lexicographically monotonic cursor:

```ts
interface TerminalCursor {
  stream: string;
  generation: number;
  start: number;
  end: number;
}
```

- `stream` changes when the in-memory Session is recreated.
- `generation` increases when the retained terminal buffer is replaced or cleared.
- `start` and `end` are UTF-16 string offsets within that generation.
- A live event covers `[start, end)`.
- A snapshot cursor identifies the live-output boundary represented by the snapshot.

The browser queues live events while a snapshot is loading. Once the snapshot finishes:

- events ending at or before the snapshot boundary are discarded;
- events starting at or after the boundary are replayed;
- a batch crossing the boundary replays only its uncovered suffix;
- events from older generations or a replaced stream are discarded;
- events from a newer generation are replayed in full.

This replaces the previous empty-buffer heuristic, which could either duplicate an Ink
redraw or discard a prompt emitted during the fetch.

## History Page Contract

`GET /api/sessions/:id/terminal?historyPage=1&lines=400&format=stream` returns
one bounded physical-row slice of retained tmux history. It never includes the visible pane.

Page headers:

- `X-Codeman-History-Start` / `End`: half-open absolute row range from the
  oldest retained tmux history row.
- `X-Codeman-History-Total`: retained history rows at capture time.
- `X-Codeman-History-More-Before` / `More-After`: navigable directions.
- `X-Codeman-History-Origin`: opaque pane/history-origin fingerprint.

Omitting `before`/`after` returns the newest page. `before=<row>` walks toward
older output; `after=<row>` walks toward newer output. The browser requests 400
rows per page; the server accepts and clamps explicit sizes from 100–2,000
physical rows. Page capture deliberately does not use tmux `-J`, so each page
coordinate remains one physical tmux row.

The browser retains at most six pages around the current reading position plus
the separately refreshed latest pane. When the reading window shifts far
enough to omit intermediate rows, a dim gap row separates it from the current
pane. Approaching either edge loads the adjacent page and rebuilds behind the
frame cover while preserving the reader's viewport row. It begins the adjacent
request three screenfuls before an edge so the smaller page normally arrives
before the reader reaches it.

If tmux page capture fails, the endpoint falls back to the newest 1 MB of the
PTY buffer without page metadata. The client then disables row paging for that
load because byte offsets cannot safely substitute for tmux row coordinates.

`X-Codeman-History-Origin` changes when the pane or oldest retained rows change.
The client rejects a page with a different origin instead of stitching rows
across tmux eviction or pane replacement.

## HTTP Snapshot Contract

`GET /api/sessions/:id/terminal?format=stream` returns raw terminal text rather than the
JSON API envelope. Snapshot metadata is carried in `X-Codeman-Terminal-*` headers. The
existing JSON response remains available for old clients and as a frontend fallback.

`latest=1` projects the same endpoint down to the current rendered tmux pane. Session
selection starts this request together with the newest history page and uses it for first
paint. The latest response supplies the authoritative PTY cursor for live-event
reconciliation after the composed page replay.

`full=1` remains available for legacy callers that explicitly require one complete tmux
capture, but the browser no longer uses it during startup or session switching.

The stream response is `no-store`. It may still be reconstructed from tmux history or a
visible pane capture, so cursor offsets order live events; they are not byte offsets into
the normalized response body.

## Live Transport Handoff

SSE and WebSocket use the same per-tab transport id (`clientId:tabNonce`). When a
WebSocket opens, the server flushes that session's pending SSE batch before suppressing
SSE terminal events for the tab. The WebSocket then becomes the only live terminal
transport for that session.

Active WebSocket output uses a viewport-aware, lossless micro-batch. Desktop and
tablet connections retain the 8 ms / 8 KB low-latency path. A connection that
announces a mobile viewport groups raw PTY output for at most 50 ms and emits
approximately 16 KB frames. The wider phone window combines adjacent decorative
redraws before adding one DEC-2026 synchronized-update pair, reducing full xterm
paints without discarding terminal data.

Bulk data is split on UTF-8- and ANSI-safe boundaries before each payload is
wrapped. A single control sequence, OSC/DCS string, or application-owned
synchronized update remains indivisible even when it exceeds the viewport target;
terminal correctness takes priority over a hard packet limit. If a PTY event ends
inside a control sequence, the connection emits its safe prefix and carries the
incomplete suffix into the next event rather than inserting a synchronization
marker inside the command.

For an intentional disconnect, the browser sends a handoff frame and waits briefly for
an acknowledgement. The server flushes pending WebSocket output, detaches its Session
listeners, discards any overlapping SSE batch while the tab is still suppressed, then
resumes SSE and acknowledges the handoff. An unexpected close resumes SSE with a
targeted `session:needsRefresh` event so the client reloads an authoritative snapshot
rather than risking a missing transport interval.

## Rendering

The client paints the bounded latest-pane response first and captures only xterm's screen
rows in an inert cover. The newest history page assembles in the background. The client
then composes the page, one screen of scroll-only padding, and the absolute-positioned
latest pane into a bounded replay. The padding moves every history row into xterm
scrollback before the current pane is painted.

Lazy page loads use the same buffer-load transaction. Live output is queued, the bounded
reading window is rebuilt, the prior viewport anchor is restored, and queued output is
reconciled against the latest-pane PTY cursor. Once replay and queued output settle, an
xterm write fence plus two paint yields removes the cover atomically.
