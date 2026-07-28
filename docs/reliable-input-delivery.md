# Reliable input delivery (exactly-once, durable)

## The bug this fixes

With local echo on, pressing Enter cleared the overlay and then sent the prompt
over the WebSocket **fire-and-forget** (`ws.send({t:'i',d})`). On a flaky link
(e.g. a moving train) the socket is frequently *half-open*: `readyState === OPEN`
so `ws.send()` does **not** throw, but the underlying TCP is dead, so the frame is
silently discarded. Nothing was enqueued (the send "succeeded"), the on-screen
prompt was already wiped, and `navigator.onLine` stays `true` — so a long typed
prompt vanished with no trace and no resend.

## The guarantee

Every byte of user input is **recorded durably before delivery** and **only
dropped once the server ACKs it** — so a half-open socket, a reconnect, or a page
reload can never lose input. Redelivery is **exactly-once**: the server applies
each `(clientId, seq)` at most once, so a resend can't type the prompt twice.

Editable text that has not been submitted yet has a separate guarantee. A
per-session draft record in `localStorage['codeman:sessionDrafts']` preserves
local-echo text across session switches, Home navigation, browser
minimization/tab discard, phone sleep, and page reload. Restoring a draft never
submits it.

## How it works

### Client (`app.js`)

- A stable **`clientId`** (`localStorage['codeman:clientId']`) identifies this
  browser to the server's dedup across reconnects and reloads.
- Each input frame gets a **monotonic per-session `seq`**. Frame records
  (`{seq,data,useMux,ts,tries,sentAt}`) live in `_pendingDeliveries`
  (`Map<sessionId, record[]>`), persisted (debounced, + flushed on `pagehide`/
  `visibilitychange`) to `localStorage['codeman:pendingInput']`. The seq counters
  persist too, so seqs stay monotonic across reloads (never reset — a reset would
  let the server treat fresh input as an already-applied duplicate).
- **Delivery** (`_drainSession`):
  - **WS path** — when the socket is `OPEN` for the session, send each not-yet-sent
    record (`sentAt === 0`) in seq order over the single ordered stream. Records
    stay pending until the server's `{t:'ia',seq}` ACK removes them.
  - **POST path** — when no WS, POST records in order, awaiting each (the HTTP 2xx
    *is* the ACK). A 404/410 (session gone) drops the record rather than retry
    forever.
- **Half-open recovery** (`_redeliverSweep`, every 2s): if the active WS session's
  oldest record is unacked past `_reliableAckTimeoutMs` (4s), the socket is assumed
  dead — `ws.close()` forces a fast reconnect; `onopen` (`_onWsReady`) resets
  `sentAt = 0` and re-sends everything pending. Also re-drains background sessions
  over POST, and fires on SSE-reconnect / `online`.
- The connection indicator shows pending count/bytes (`_pendingBytes`).

### Editable drafts

- `TerminalInputStateStore` (`src/web/public/terminal-input-state.js`) is the
  single owner of `{pendingText, flushedText, cjkText, updatedAt}` per session.
  Its input API is `capture()`/`set()`/`handoff()`/`clear()`; its output API is
  `get()` plus the explicit `flushText` returned by `handoff()`. Storage, clock,
  and timers are injectable, so the state machine is self-contained in tests.
- Writes are debounced during typing and forced synchronously on `pagehide` and
  hidden `visibilitychange`.
- `pendingText` has not reached the PTY. `flushedText` has reached the PTY
  during a session/Home handoff but remains explicitly tracked so mobile
  Backspace still maps one character to one PTY Backspace after reload.
- An unfinished xterm IME candidate is persisted as ordinary pending text
  because the operating system cannot resume a composition session after page
  discard. The optional CJK textarea persists its committed field value
  separately.
- Session restore calls `restoreDraft(..., false)` before asynchronous terminal
  replay, then renders only after the target frame is ready. This keeps the
  draft editable without anchoring it to a stale session frame.
- Enter, Escape, Ctrl+C, voice submit, and session deletion remove the draft.
  Draft bytes then follow the normal exactly-once delivery path if submitted.
- Draft strings are not truncated. On `QuotaExceededError`, reproducible
  `codeman-xs-*` terminal snapshots are evicted before draft persistence is
  abandoned.

### Server

- **`Session.shouldApplyInput(clientId, seq)`** — returns `true` exactly once per
  `(clientId, seq)`: the first time a seq strictly greater than that client's
  last-applied is seen. A replayed/lower seq returns `false`. Bounded MRU map
  (`MAX_INPUT_DEDUP_CLIENTS = 256`).
- **WS route** (`ws-routes.ts`) — parses optional `cid`/`seq` on `{t:'i'}`; applies
  via `shouldApplyInput` (skips a duplicate, still ACKs with `{t:'ia',seq}` so the
  client drops it). Untagged frames apply unconditionally (no behavior change).
- **POST route** (`/api/sessions/:id/input`) — optional `seq`/`clientId` in
  `SessionInputWithLimitSchema`; a deduped duplicate returns 200 without writing
  (the 200 is the client's ACK). `curl`/legacy callers omit the fields and always
  apply.

## Known limitation

Dedup state is in-memory on the server. A **server restart** between a write and
the client's redelivery of that same seq could re-apply it (a rare duplicate).
This is a deliberate trade-off: favor *never losing input* over a rare duplicate
across the narrow restart window.

## Tests

- `test/reliable-input-dedup.test.ts` — `Session.shouldApplyInput` exactly-once
  semantics (monotonic, per-client, gap-tolerant, eviction-safe).
- `test/routes/session-routes.test.ts` — POST `/input` applies a tagged
  `(clientId, seq)` once on redelivery; untagged input always applies.
- `test/mobile/keyboard.test.ts` — background/reload rehydration, switched
  session editability, and submit cleanup for per-session drafts.
- `test/terminal-input-state.test.ts` — pure capture, handoff, persistence,
  clearing, and quota-recovery semantics without a server or browser manager.
- `packages/xterm-zerolag-input/test/zerolag-input-addon.test.ts` — atomic
  no-render draft restoration against a stale terminal frame.
