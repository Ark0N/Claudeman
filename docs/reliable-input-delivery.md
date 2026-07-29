# Reliable input delivery (exactly-once, durable)

## The bug this fixes

With local echo on, pressing Enter cleared the overlay and then sent the prompt
over the WebSocket **fire-and-forget** (`ws.send({t:'i',d})`). On a flaky link
(e.g. a moving train) the socket is frequently _half-open_: `readyState === OPEN`
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
record under `localStorage['codeman:sessionDrafts:draft:<encoded-session-id>']`
preserves each session's local-echo text across session switches, Home
navigation, browser minimization/tab discard, phone sleep, and page reload.
The legacy aggregate `codeman:sessionDrafts` record is migrated on load.
Restoring a draft never submits it.

## How it works

### Input arbitration (`terminal-input-controller.js`)

- `TerminalInputController` is the single pre-delivery owner for interactive
  browser input. Native xterm data, Android helper-textarea mutations, IME
  composition, CJK/voice text, clipboard paste, accessory controls, and
  modified Enter all enter its public API before anything reaches a draft or
  delivery record.
- The controller owns transient composition epochs, helper-textarea mutation
  snapshots, alternate-path deduplication, local-echo edits, paste segmentation,
  normal-mode batching, and control-key ordering. `terminal-ui.js` remains a
  thin adapter for terminal focus/query filtering and Tab-completion rendering.
- A finalized composition atomically commits one value and then clears xterm's
  hidden helper textarea. This is load-bearing on Android: retaining old helper
  context lets a later Gboard commit include earlier words, producing delayed
  `cdcd`/`homecd` duplication even when transport delivers each event once.
- xterm's delayed composition callback and Android's follow-up `insertText` can
  expose the same finalized word twice. The controller accepts the first path
  and consumes one matching alternate replay, whether it arrives whole or in
  fragments. The marker survives Space and punctuation for 120 ms, but is
  invalidated by a matching replay, a new composition, different substantive
  input, a session reset, or expiry.
- Mobile keydown/input dedup uses an explicit ownership token rather than a
  timing guess. A capture-phase keydown creates a candidate, matching xterm
  `onData` marks it delivered, and only the corresponding later DOM `input`
  echo is consumed. A delayed event cannot duplicate the key, and an unrelated
  virtual-keyboard event cannot be swallowed.
- An unresolved Tab completion makes the PTY authoritative for the current
  line. The next non-Tab action hands editing to the PTY without resending the
  prefix already flushed before Tab. PTY ownership survives Escape and ends
  only at a definitive line boundary (Enter, Ctrl+C, or Ctrl+U).
- While a `permission_prompt` or `elicitation_dialog` hook is active, menu
  controls bypass local-draft submission. Navigation and the selected control
  reach the PTY while the draft remains editable; Enter/Escape/Ctrl+C then
  resolve the action hook so a later Enter can submit the preserved draft.
- Draft storage and submitted delivery are injected ports, not controller
  state. `TerminalInputStateStore` remains the sole durable draft owner and
  `_sendInputAsync` remains the exactly-once transport owner.

### Client (`app.js`)

- A stable **`clientId`** (`localStorage['codeman:clientId']`) identifies this
  browser to the server's dedup across reconnects and reloads.
- Each input frame gets a **monotonic per-session `seq`**. Frame records
  (`{seq,data,useMux,ts,tries,sentAt}`) live in `_pendingDeliveries`
  (`Map<sessionId, record[]>`), persisted (debounced, + flushed on `pagehide`/
  `visibilitychange`) to `localStorage['codeman:pendingInput']`. The seq counters
  persist too, so seqs stay monotonic across reloads (never reset — a reset would
  let the server treat fresh input as an already-applied duplicate).
- Payloads are split into ordered frames of at most 60 KiB without separating
  UTF-16 surrogate pairs. This stays below the server's 64 KiB per-frame limit.
  The reload-durable pending backlog uses the same 2 MiB aggregate budget as
  editable drafts, so a supported large paste retains every frame and both
  bracketed-paste delimiters until ACKed.
- **Delivery** (`_drainSession`):
  - **WS path** — when the socket is `OPEN` for the session, send each not-yet-sent
    record (`sentAt === 0`) in seq order over the single ordered stream. Records
    stay pending until the server's `{t:'ia',seq}` ACK removes them.
  - **POST path** — when no WS, POST records in order, awaiting each (the HTTP
    2xx _is_ the ACK). A 409 while a restored session is still attaching leaves
    the record queued for retry. A 404/410 (session gone) drops the record
    rather than retry forever.
- **Half-open recovery** (`_redeliverSweep`, every 2s): if the active WS session's
  oldest record is unacked past `_reliableAckTimeoutMs` (4s), the socket is assumed
  dead — `ws.close()` forces a fast reconnect; `onopen` (`_onWsReady`) resets
  `sentAt = 0` and re-sends everything pending. Also re-drains background sessions
  over POST, and fires on SSE-reconnect / `online`.
- The connection indicator shows pending count/bytes (`_pendingBytes`).

### Editable drafts

- `TerminalInputStateStore` (`src/web/public/terminal-input-state.js`) is the
  single owner of `{pendingText, flushedText, cjkText, ptyOwned?, updatedAt}` per session.
  Its input API is `capture()`/`set()`/`handoff()`/`clear()`; its output API is
  `get()` plus the explicit `flushText` returned by `handoff()`. Storage, clock,
  and timers are injectable, so the state machine is self-contained in tests.
- Dirty sessions are written independently during browser idle time (with a
  bounded timer fallback) and forced synchronously on `pagehide` and hidden
  `visibilitychange`.
- `pendingText` has not reached the PTY. `flushedText` has reached the PTY
  during a session/Home handoff but remains explicitly tracked so mobile
  Backspace still maps one character to one PTY Backspace after reload.
- `ptyOwned` records that cursor/history navigation moved editing into the PTY.
  It can remain true without overlay text, preventing a reload or tab discard
  from re-enabling append-only local echo over a cursor-positioned line.
- An unfinished xterm IME candidate is persisted as ordinary pending text
  because the operating system cannot resume a composition session after page
  discard. The optional CJK textarea persists its committed field value
  separately.
- Session restore calls `restoreDraft(..., false)` before asynchronous terminal
  replay, then renders only after the target frame is ready. This keeps the
  draft editable without anchoring it to a stale session frame.
- Enter, Ctrl+C, Ctrl+U, voice submit, and session deletion remove the draft.
  A standalone Escape preserves a locally owned unsent draft. Once cursor or
  history navigation hands editing to the PTY, Escape keeps that ownership
  because it does not reliably reset the remote line.
- Live draft strings are never truncated. Durable storage is bounded to 50
  sessions, 30 days, 512 KiB of text per draft, and 2 MiB total; an oversized
  live draft remains editable but is marked non-durable instead of persisting a
  misleading prefix. On `QuotaExceededError`, reproducible `codeman-xs-*`
  terminal snapshots and then the oldest clean draft records are reclaimed
  before persistence is abandoned.

### Server

- **`Session.hasAppliedInput(clientId, seq)` /
  `markInputApplied(clientId, seq)`** — live routes check for a duplicate before
  writing and record a new sequence only after `write()`/`writeViaMux()` returns
  true. The compatibility helper `shouldApplyInput()` performs both steps for
  pure callers. The bounded MRU map keeps 256 clients.
- **WS route** (`ws-routes.ts`) — parses optional `cid`/`seq` on `{t:'i'}`;
  duplicates are ACKed without another write. A new frame receives
  `{t:'ia',seq}` only after the PTY accepts it; while restored-session attach is
  incomplete, no ACK is sent and the client's durable sweep retries it.
  Untagged frames remain best effort.
- **POST route** (`/api/sessions/:id/input`) — optional `seq`/`clientId` in
  `SessionInputWithLimitSchema`; a deduped duplicate returns 200 without writing
  (the 200 is the client's ACK). A mux write is awaited before 2xx; an
  unavailable PTY returns 409 without advancing dedup state. `curl`/legacy
  callers omit the fields.

## Known limitation

Dedup state is in-memory on the server. A **server restart** between a write and
the client's redelivery of that same seq could re-apply it (a rare duplicate).
This is a deliberate trade-off: favor _never losing input_ over a rare duplicate
across the narrow restart window.

## Tests

- `test/reliable-input-dedup.test.ts` — `Session.shouldApplyInput` exactly-once
  semantics (monotonic, per-client, gap-tolerant, eviction-safe).
- `test/routes/session-routes.test.ts` — POST `/input` applies a tagged
  `(clientId, seq)` once on redelivery, waits for mux acceptance, and retains an
  attach-raced frame for retry.
- `test/routes/ws-routes.test.ts` — a tagged frame is ACKed only after PTY
  acceptance and remains applicable after an unavailable first attempt.
- `test/mobile/keyboard.test.ts` — background/reload rehydration, switched
  session editability, submit cleanup for per-session drafts, and single-delivery
  Android composition in immediate-echo shells.
- `test/terminal-input-state.test.ts` — pure capture, handoff, persistence,
  clearing, and quota-recovery semantics without a server or browser manager.
- `test/terminal-input-controller.test.ts` — pure composition reconciliation,
  helper reset, replay deduplication, delete/control ordering, paste framing,
  external input, and session-reset semantics.
- `packages/xterm-zerolag-input/test/zerolag-input-addon.test.ts` — atomic
  no-render draft restoration against a stale terminal frame.
