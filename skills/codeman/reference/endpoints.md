# Codeman API reference for agents

Loaded on demand from the `codeman` skill. Assumes the guard variables from SKILL.md
(`$API`, `$SELF`, `"${CURL[@]}"`). Canonical contract: `docs/api-reference.md` in the
Codeman repo; this file is the agent-relevant subset, verified live.

## Envelope and errors

Every JSON response: `{"success":true,"data":…}` or
`{"success":false,"error":"…","errorCode":"…"}`. Branch on `errorCode`:

| `errorCode` | HTTP | Meaning |
|-------------|------|---------|
| `INVALID_INPUT` | 400 | malformed request; the message names the bad field |
| `UNAUTHORIZED` | 401 | auth required or failed (send `-u user:password`). ⚠️ The 401 body is plain text, NOT this envelope — `jq` dies with a parse error, see the guard in SKILL.md |
| `FORBIDDEN` | 403 | authenticated but not permitted: an admin-only route in multi-user mode, a `workingDir`/case path outside your own workspace, or a shell session without the can-bypass-permissions grant. ⚠️ **Not** what an ownership miss on a session returns: a session you do not own answers 404 `NOT_FOUND`, identically to one that does not exist (deliberate, it leaks no existence) |
| `NOT_FOUND` | 404 | no such session, or one this caller does not own |
| `SESSION_BUSY` | 409 | on a **wait**: this session's waiter cap (16, combined signal+output) is full. On **quick-start**: the 50-session cap is full, so clean up before starting more |
| `CONFLICT` / `ALREADY_EXISTS` | 409 | conflicts with current state |
| `OPERATION_FAILED` | 422 | well-formed but could not be completed |
| `RATE_LIMITED` | 429 | per-owner or process-wide waiter pool is full — back off; switching sessions will not help |
| `INTERNAL_ERROR` | 500 | server bug |

`SESSION_BUSY` vs `RATE_LIMITED` on the wait endpoints is deliberate: the first means
"too many waiters on *this* session", the second means the *pool* is full.

⚠️ **The guards that run before any handler answer in PLAIN TEXT, not this envelope**,
so `jq` reports a parse error and `.errorCode` is simply absent. All of them:
`401 Unauthorized` (Basic auth, carries `WWW-Authenticate`), `401 Unauthorized: hook
secret required`, `403 Forbidden: host not allowed` (Host allowlist), `403 Forbidden:
cross-site request blocked` (Origin/CSRF guard), and the auth rate limiter's
`429 Too Many Requests` (with `Retry-After`; distinct from the JSON `RATE_LIMITED`
above, which is the waiter pool). When a call returns something `jq` cannot parse,
read the status with `-w '%{http_code}'` and the raw body before assuming a bug.

## Sessions

| Task | Call |
|------|------|
| list sessions (metadata only, ~1.5 KB each, safe to poll) | `GET /api/v1/sessions` |
| one session (has `.data.pid`, `null` until the PTY spawns) | `GET /api/v1/sessions/:id` — ⚠️ **neither a liveness nor a busy check**, see below |
| unified list incl. history | `GET /api/v1/sessions/unified` → `.data.sessions[]` (NOT `.data[]`), and it folds in transcript history from the whole machine — never use it to verify cleanup; `GET /api/v1/sessions` is the cleanup check |
| start case + session in one call | `POST /api/v1/quick-start` |
| send input | `POST /api/v1/sessions/:id/input` |
| **read a worker's answer** (claude/codex) | `GET /api/v1/sessions/:id/last-response` → `.data.{text,timestamp}` — clean transcript text, no TUI noise. ⚠️ **Poll it**: the transcript flush lags the `stop` signal, so a read taken the instant send-and-wait returns is `""` (verified live). Also `""` before the first completed turn, and always `""` for `shell`/`opencode`/`gemini`/`antigravity` (no transcript) |
| read terminal (tail is in **BYTES**, raw ANSI) | `GET /api/v1/sessions/:id/terminal?tail=3000` → `.data.terminalBuffer` — for *diagnosis* (unsubmitted prompt?), not for reading answers |
| full tmux scrollback (context bomb; post-mortems only) | `GET /api/v1/sessions/:id/terminal?full=1` |
| background agents, one session | `GET /api/v1/sessions/:id/subagents` |
| background agents, global list | `GET /api/v1/subagents` (admin-only in multi-user mode) |
| server status / version | `GET /api/v1/status` → `.data.version` |
| delete one session (yours only, via `delete_session`) | `DELETE /api/v1/sessions/:id` — never call it bare; the fail-closed helper in SKILL.md §0 is the only self-protection that exists. Answers `{"success":true,"data":{}}`: an **empty** body is the success signal, there is nothing to read back |

`DELETE /api/v1/sessions/:id` takes one undocumented query parameter, `killMux`, and
it defaults to `true` (anything other than the exact string `false` means kill). With
`?killMux=false` the call **detaches instead of killing**: the tmux session and the
agent inside it keep running, the session drops out of `GET /api/v1/sessions` so it
looks deleted, and it is deliberately left in persisted state for recovery (the
lifecycle log records `detached`, not `deleted`). That is the wrong tool for agent
cleanup: your worker keeps burning tokens where neither you nor the user can see it,
and the list you would check to confirm cleanup shows it gone. Delete plainly, and let
`killMux` default.

⚠️ **`.data.status` is a heuristic and is often simply wrong. Never branch on it.**
Measured on a live claude worker: `status` read `idle` while the worker was mid-turn
and actively producing output, with `lastActivityAt` equal to the moment of the call.
It is wrong in both directions, so neither value tells you anything you can act on:

- **`idle` does not mean finished.** Use `stop` (the definitive end-of-turn hook) via
  send-and-wait, or an output marker. If you must judge from outside, sample
  `terminal?tail=` twice a few seconds apart and compare: a changing buffer is the
  only cheap positive proof that a worker is still working.
- **`idle` does not mean alive.** A worker that dies inside its pane keeps
  `status:"idle"` and a pid (that pid is the local tmux attach client, not the
  worker). `wait?until=exit` is the death check.

Treat `status` as a UI hint. Every synchronization decision in these recipes is built
on signals and markers for exactly this reason.

⚠️ `GET /api/v1/sessions/:id/output` → `.data.textOutput` looks like the obvious read
but stays **empty for interactive tmux-backed sessions** (it is fed only by the legacy
JSON-stream path). Verified empty on live claude and shell sessions. Use
`last-response` for claude/codex answers; only fall back to `terminal?tail=` for
hook-less modes, or to diagnose a prompt that was never submitted, and strip ANSI:

```bash
# `\x1b` is a GNU-sed extension. BSD sed (macOS, the default there) reads it as a
# literal "x1b", matches nothing, and hands back raw ANSI, silently. Feed sed a real
# ESC byte instead; that form works on GNU and BSD alike.
ESC=$(printf '\033')
… | jq -r '.data.terminalBuffer' | sed -e "s/${ESC}\[[0-9;?]*[a-zA-Z]//g" -e "s/${ESC}([B0]//g"
```

`POST /api/v1/quick-start` body (all optional):
`{"caseName":"worker-1","mode":"claude","sessionName":"w9-worker","effort":"high"}`
— `mode` ∈ `claude|shell|opencode|codex|gemini|antigravity`; response is
`.data.{sessionId, caseName, casePath}`. Creates the case directory (a real directory
on the user's disk) if missing — do not retry it in a loop, and remember the name.

⚠️ **Branch on `.success` before reading `.data.sessionId`.** On any failure the field
is absent, `jq -r` prints the literal string `null`, and every later call then targets
`/api/v1/sessions/null`, burning the full readiness budget and reporting jq noise
instead of the real cause. Failure modes here are `SESSION_BUSY` (the **50-session
cap**, not the waiter cap), `FORBIDDEN`, `CONFLICT`, `OPERATION_FAILED` and
`INVALID_INPUT`; none of them are retryable in a loop.

⚠️ `caseName` resolves through the linked-cases registry first, so a name that happens
to match a case the user linked in lands in that **real repo**, not a fresh scratch
directory. Pick distinctive scratch names, and use a linked name deliberately when you
do want a worker in an existing checkout.

`POST /api/v1/sessions/:id/input` body:
`{"input":"one line\r","useMux":true,"clientId":"agent-1","seq":1}` plus optionally
`"wait"` / `"waitTimeout"` (below).

- ⚠️ **The input must contain `\r`** (the JSON escape, i.e. a real carriage return)
  **or Enter is never sent**: the text is typed onto the worker's prompt and sits
  there unsubmitted. Verified live — this is the number-one silent failure, and no
  response field catches it: `delivered:true` means "written to the pane", not
  "submitted". A `\r`-less send with `wait` reports `delivered:true` and then every
  wait on that turn times out. Without `wait`, fire-and-forget returns an **empty**
  `{"success":true,"data":{}}` — no `delivered`, no `duplicate`; those fields exist
  only on the `wait` variant, so a fire-and-forget flow gets no delivery
  confirmation at all.
- `input` must be single-line (newlines are stripped). To send a bare Enter (confirm
  a dialog), send `{"input":"\r"}`.
- `input` is capped at **100 000 characters**; one character over is a 400
  `INVALID_INPUT` and **nothing is typed** (the schema rejects the whole body, so it
  is not a truncation). Since the value is one line anyway, a prompt that big means
  you are pasting a file into the composer: write it to disk in the worker's case
  directory and send a path instead. `clientId` is capped at 128 characters on the
  same terms.
- `clientId`+`seq` give exactly-once delivery: the server applies each pair at most
  once. Increment `seq` per new input.

## The wait primitives

Three bounded long-polls. Shared semantics:

- **Timeout = HTTP 200** with `wait.timedOut:true`. Loop over short waits (60 s);
  `tailscale serve` / cloudflared cut idle connections.
- Timeouts are **clamped** to `[1000, 600000]` ms (operator-tunable); the applied
  value is echoed as `wait.timeoutMs` — read it back, never assume.
- ⚠️ Clamping only covers **positive integers**. `timeout=0`, a negative value, a
  fraction (`timeout=1500.5`) and anything non-numeric (`timeout=30s`) are rejected by
  the schema as a 400 `INVALID_INPUT` naming the field, not silently clamped up to
  the floor. Omit the parameter to take the 60 000 ms default; never send a computed
  remainder without rounding it and checking it is still above zero. Same rule for
  `waitTimeout` in the input body, where the value must additionally be a JSON number
  (a quoted `"60000"` is a 400).
- All three nest the result under `.data.wait`, same shape, so one helper parses all.
- `.data.status` (post-wait `SessionStatus`) and `.data.limitPaused` ride along.
  `limitPaused:true` means the session is paused on a usage limit and will emit
  nothing until reset — a timeout is then *expected*; do not retry hard, and do not
  kill the worker.

### Signals by mode

| Signal | Meaning | Available for |
|--------|---------|---------------|
| `idle` | output stabilized + prompt detected — heuristic, can flap mid-turn | every mode |
| `working` | session started producing output | every mode |
| `stop` | Claude Code `stop` hook — the definitive end-of-turn | `claude` only |
| `blocked` | `permission_prompt` / `elicitation_dialog` hook — the worker needs an answer | `claude` only |
| `exit` | PTY exited or session deleted | every mode |

Default `until` set: `stop,idle,exit`. On non-claude modes the server silently drops
`stop`/`blocked` from the *default* set (echoed back as `wait.until`, e.g.
`["idle","exit"]` on shell); requesting them *explicitly* there is a 400 naming the
mode. ⚠️ On hook-less modes the lifecycle signals are also **coarse in practice**: a
short shell command produced **no** `idle` transition within 60 s (verified live), so
a `fresh=1` / fresh-delivery wait can burn its whole timeout while the work finished
long ago. Synchronize hook-less modes with `wait-output` markers instead.

Two more places hooks go missing even in claude mode: **Docker cases** need
`CODEMAN_DOCKER_BRIDGE_HOOKS=1` on the server (without it only `idle`/`working`/
`exit` arrive), and **remote-SSH cases** run the agent on another host whose hooks may
never reach this server. When unsure, ask for `stop,idle,exit`.

⚠️ **Signals are edge-triggered with no history.** A signal that fires while no
waiter is registered is gone; no later wait can observe it (`until=stop` on a worker
whose turn already ended just times out, with or without `fresh` — verified live).
Register the waiter before the event can happen: send-and-wait does exactly that,
and `wait-output` markers with `from=buffer` are latched by construction. Never
fire-and-forget N prompts and then gather signal-waits worker by worker; every
worker that finishes before its gather is unobservable (see recipes.md Flow 3b).

### `GET /api/v1/sessions/:id/wait`

| Param | Default | Notes |
|-------|---------|-------|
| `until` | `stop,idle,exit` | comma list; unknown token → 400 naming it |
| `timeout` | 60000 | ms, positive integer only (0/negative/fractional = 400); clamped, applied value echoed as `wait.timeoutMs` |
| `fresh` | `0` | `1` requires an actual *transition*, ignoring the state at call time |

⚠️ A session whose PTY has not spawned (`pid:null`) or has exited counts as `exit`
**right now**: with the default set the call answers immediately
(`signal:"exit", immediate:true`). That is how you detect a dead worker cheaply — but
it also means "wait for my just-created session" needs the readiness recipe in
SKILL.md, not this endpoint.

### `GET /api/v1/sessions/:id/wait-output`

| Param | Default | Notes |
|-------|---------|-------|
| `match` | required | literal substring, 1–200 chars, ANSI-stripped; chunk-straddling matches found; **no regex** — a `regex=` param is a 400 |
| `nocase` | `0` | case-insensitive compare; snippet keeps original casing |
| `from` | `now` | `buffer` scans the tail (~256 KB) of existing output first |
| `timeout` | 60000 | same clamp, same positive-integer rule |

Four traps, all observed live:

1. **The echo of your own typed command is output.** A marker appearing verbatim in
   the input line matches the moment the text is typed, before the command runs.
   Split the marker with a shell variable: send `M=DONE; …; echo ${M}_1234\r`, wait
   on `DONE_1234`.
2. **`from=now` misses text printed before the wait landed** — a marker echoed just
   before the request registered timed out at full length. After sending a command,
   always wait with `from=buffer`.
3. **`from=now` can also match too much**: tmux repaints old screen content as
   ordinary output on attach/resize/redraw, so a *generic* marker (`BUILD OK`)
   matches stale text. Unique-per-call markers (`DONE_$RANDOM`) make both `from`
   modes safe.
4. **TUI output can be space-less in the stream.** Full-screen TUIs (claude, codex,
   …) position words with cursor-movement escapes rather than literal spaces, so
   the stripped stream can read `Yes,Itrustthisfolder` while the pane shows the
   spaced phrase. Whether a given phrase keeps its spaces depends on how the TUI
   drew it (observed live: some multi-word matches fire, some never do), so treat
   multi-word matches against TUI screens as unreliable and match a **single
   space-free token** (`trust`, `shift+tab`). Plain command output (shell workers,
   `echo` lines) keeps real spaces and multi-word matches work there.

Build the query with `-G --data-urlencode` (a `+` in a hand-built query decodes to a
space). Result extras: `wait.matched`, `wait.match`, `wait.snippet` (bounded window
around the match, blank runs collapsed — the snippet is often all you need to read).

### `POST /api/v1/sessions/:id/input` with `wait`

| Field | Notes |
|-------|-------|
| `wait` | `true` (default signal set) or the same comma grammar as `until`; absent = historical fire-and-forget |
| `waitTimeout` | ms, same clamp; a JSON number, positive integer (`"60000"` is a 400) |

Registers the waiter **before** typing, which closes the race where send-then-wait
sees the previous turn's idle state and returns instantly. Response adds `delivered`
and `duplicate` beside the standard `wait` object.

A **tagged duplicate** (same `clientId`+`seq` already applied) does not retype but
still honors `wait`, answering from the session's *current* state instead of
requiring a new transition (`delivered:false, duplicate:true` — verified: ~20 ms,
command ran exactly once). That is what makes the resend-identical-request loop in
SKILL.md correct: iteration 1 delivers and needs a transition; later iterations
resolve immediately if the turn ended in between. ⚠️ The flip side: a duplicate's
`immediate:true` answer is the current state and nothing more — an idle worker
whose prompt was never submitted (missing `\r`) produces the same
`signal:"idle", immediate:true` as one that finished the turn. Confirm from
`terminal?tail=` before reporting success; SKILL.md's loop shows where.

### Outcome parsing, in order

1. `wait.signal != null` (or `wait.matched == true`) — the thing happened.
   `wait.immediate:true` rides along and means the condition already held at call
   time; if that is not what you meant, you wanted `fresh=1` or send-and-wait.
2. `wait.timedOut` — poll boundary; loop again.
3. `wait.ended` — session deleted/torn down mid-wait; stop looping.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| every curl fails with a certificate error | you dropped `-k`; `CODEMAN_API_URL` is HTTPS with a self-signed cert |
| `jq: parse error` on every call | plain-text 401s: the server has a password. Check with `-w '%{http_code}'`, use the guard's `.env` fallback, and if no `.env` exists, stop and ask the user for credentials |
| input arrives but nothing happens; later waits all time out | the input had no `\r`, so Enter was never sent; the text is sitting on the worker's prompt. **Submitting it with `{"input":"\r"}` is the ONLY recovery** — Ctrl+U (0x15) and Esc do NOT clear the composer (verified live) — and the flush costs one turn in which the worker reasons about the junk; open the next real prompt with "ignore the garbled line above:" |
| `GET .../sessions/$CODEMAN_SESSION_ID` 404s | Docker case: the env id is truncated to 8 chars; find yourself with `startswith($SELF)`, and always self-compare by prefix, in both directions |
| `CODEMAN_MUX` unset but you seem to be in a session | remote-SSH case: the env vars are not exported there. Fail closed — refuse to act |
| connection refused from inside a container | a loopback-bound server is unreachable from a container, and `CODEMAN_DOCKER_BRIDGE_HOOKS=1` does **not** fix that: it opens a hooks-only listener, so hook events start flowing but `/api/v1/*` stays refused. Driving the API from inside a Docker case needs a reachable bind (an operator decision); report it, don't retry |
| wait routes 404 on a valid session id | read the `.error` text: a `Route ...` prefix means the server predates the wait endpoints (< 1.13.0; a dev build can serve them while reporting an older version, so probe, never version-compare) — poll `terminal?tail=` and say so. `Session ... not found` means your id is wrong, not the server |
| wait on `stop` never resolves | non-claude mode, or hooks not reaching the server (Docker/remote), or a case created by Codeman < 1.13.0 against an `--https` install (its hook curls lacked `-k` and TLS-failed silently; a 1.13.0+ server rewrites them the next time a session starts in that case). Use markers or `idle,exit` |
| new claude worker ignores its first prompt | it was showing the first-run trust dialog and Codeman's auto-accept missed; use the readiness recipe in SKILL.md (wait for `shift+tab` first, accept the dialog only as the bounded fallback) |
| readiness burns its whole budget, then the worker answers fine anyway | you matched `bypass`, which is the statusline of ONE permission mode. Codeman spawns `--dangerously-skip-permissions` by default, but the server's `claudeMode` setting also has `auto` (`auto mode on`), `allowedTools` and `normal` (both `don't ask on`), and the mode is not exposed on `GET /api/v1/sessions/:id`. Match **`shift+tab`** instead: every mode's status bar ends `(shift+tab to cycle)` (measured per mode against claude-cli 2.1.226). ⚠️ It must go through `--data-urlencode`, or the `+` decodes to a space and you silently search for `shift tab`. Expect `blocked` signals mid-turn on the non-default modes |
| ANSI escapes survive the strip pipeline | `sed -e 's/\x1b…'` on macOS: `\x1b` is GNU-only, BSD sed matches nothing and strips nothing. Use the `ESC=$(printf '\033')` form above |
| `wait-output` times out although the pane shows the text | multi-word match against a TUI screen; the stream has no spaces there — match one token |
| `wait-output` matched instantly with stale text | generic marker + tmux repaint; use `DONE_$RANDOM` |
| 409 `SESSION_BUSY` on a wait | too many concurrent waiters on that session (cap 16 combined); reuse one wait per worker |
| 429 `RATE_LIMITED` on a wait | global/owner waiter pool full; back off, do not switch sessions |
| ready claude worker missing from `ListAgents` | cross-session messaging is off for that end: CLI < 2.1.224, the feature flag not (yet) on (observed: two 2.1.226 sessions on one box, only one with an inbox socket), a telemetry-disabling env var, a Docker/remote case, or a non-claude mode. Not an error: drive it over the HTTP recipes. See `reference/messaging.md` |
| `SendMessage` says "not an agent in this conversation" | first contact with a peer needs the ref: re-send with the exact `name [ref]` string from the `ListAgents` row, or from that error's own suggestion |
| message sent, worker never acts, no reply, no `stop` | the message was held (permission-class mismatch: a non-default `claudeMode` spawns prompting-class workers, and the approval dialog expires unattended after ~5 min) or refused (`crossSessionInbound`). Run the bounded backstop, then deliver once over HTTP input. See `reference/messaging.md` |
