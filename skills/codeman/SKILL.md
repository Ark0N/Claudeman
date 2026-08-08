---
name: codeman
description: >-
  Drive Codeman, the session manager this agent is running inside, over its HTTP API:
  list sessions, start worker sessions, send them prompts, block until they finish
  (wait / wait-output / send-and-wait), read their output, and clean up. Use when asked
  to orchestrate or parallelize work across Codeman sessions, watch another session, or
  start and manage workers. Only usable inside a Codeman-managed session
  (CODEMAN_MUX=1); refuse to act otherwise.
---

# Driving Codeman from inside a session

You are an agent running inside a Codeman-managed terminal session. Codeman is the
server that spawned you; its HTTP API can start, prompt, watch, and delete other
sessions. Every recipe below was verified live. Full endpoint tables and
troubleshooting: [reference/endpoints.md](reference/endpoints.md). Worked multi-worker
flows: [reference/recipes.md](reference/recipes.md).

## 0. Guard — run this before anything else

```bash
test "${CODEMAN_MUX:-}" = 1 || { echo "Not inside a Codeman-managed session; refusing to act."; exit 1; }
API="${CODEMAN_API_URL:?CODEMAN_API_URL not set; refusing to guess}"
SELF="${CODEMAN_SESSION_ID:?CODEMAN_SESSION_ID not set}"
# Codeman does NOT hand a session the server password. If one is set, the two
# in-reach copies are the data dir's .env (the same fallback `codeman attach`
# uses — hand-authored; nothing ever writes it) and the supervisor definition
# that install.sh wrote the password into, which is where a stock
# password-protected install actually keeps it. The data dir is wherever the
# hook-secret file lives. Values may be quoted or `export`-prefixed.
ENV_FILE="${CODEMAN_HOOK_SECRET_FILE:+${CODEMAN_HOOK_SECRET_FILE%hook-secret}.env}"
envval() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/'; }
if [ -z "${CODEMAN_PASSWORD:-}" ] && [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  CODEMAN_USERNAME=$(envval CODEMAN_USERNAME)
  CODEMAN_PASSWORD=$(envval CODEMAN_PASSWORD)
fi
if [ -z "${CODEMAN_PASSWORD:-}" ]; then    # stock installs: install.sh puts it in the service definition
  UNIT="$HOME/.config/systemd/user/codeman-web.service"
  PLIST="$HOME/Library/LaunchAgents/com.codeman.web.plist"
  if [ -f "$UNIT" ]; then
    CODEMAN_PASSWORD=$(sed -n 's/^Environment="CODEMAN_PASSWORD=\(.*\)"$/\1/p' "$UNIT" | head -1)
  elif [ -f "$PLIST" ]; then
    CODEMAN_PASSWORD=$(awk '/<key>CODEMAN_PASSWORD<\/key>/{getline; print}' "$PLIST" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p')
  fi
fi
AUTH=(); [ -n "${CODEMAN_PASSWORD:-}" ] && AUTH=(-u "${CODEMAN_USERNAME:-admin}:$CODEMAN_PASSWORD")
CURL=(curl -sk "${AUTH[@]}")   # -k: harmless on http, required on https (self-signed cert)
```

- If `CODEMAN_MUX` is not `1`, **stop and say so**. Do not guess an API URL; a server
  you are not part of is not yours to drive.
- **A 401 is plain text, not the JSON envelope**, so on a password-protected server
  every `jq` in these recipes dies with `jq: parse error` instead of showing
  `UNAUTHORIZED`. If that happens, check the status with `-w '%{http_code}'`; if it
  is 401 and neither fallback above found a credential, **stop and tell the user
  you need credentials**. The hook-secret bypass covers only `/api/hook-event` and
  `/api/status-telemetry`, never session control.
- These endpoints first ship in Codeman **1.13.0**, but do not gate on the version
  number: a dev build can serve them while reporting an older version. Probe
  instead: `GET .../wait` on a real session id answering 404 with an `.error`
  starting `Route ` means the server predates the wait endpoints (fall back to
  polling `GET .../terminal?tail=` and say so); `Session ... not found` means your
  session id is wrong, not the server.

## 1. Safety rules — read before any mutating call

You are yourself a session on this server, and the API has **no undo**.

- **Never act on your own session — and know that this check is the ONLY guard.**
  The server has no self-protection: a session that DELETEs its own id succeeds and
  dies silently (verified live). Session ids appear in both full and 8-character
  forms (Docker cases export a truncated `$SELF`; mux names and UI surfaces carry
  8-char ids), so compare by prefix **in both directions**, never by equality:

  ```bash
  is_self() { case "$1" in "$SELF"*) return 0 ;; esac; case "$SELF" in "$1"*) return 0 ;; esac; return 1; }
  ```

  One-directional or equality checks each miss a real combination (full `$SELF` vs
  a target you transcribed in 8-char form, or truncated `$SELF` vs a full target)
  and the miss deletes you. Check `is_self` before every `DELETE`, kill, respawn,
  or input call.
- **Mutating calls you may make unprompted** (this is an allowlist):
  `POST /api/v1/quick-start`, `POST /api/v1/sessions/:id/input`, and
  `DELETE /api/v1/sessions/:id` **only** for a session you created in this
  conversation, by exact id. Keep a list of the ids you create. Everything else
  mutating needs the user to have asked for it.
- **Never call these** unless the user explicitly asked, naming the target:
  - `DELETE /api/cases/:name` — recursively **deletes a real directory of the user's
    code** from disk. One wrong case name destroys work that was never yours.
  - `DELETE /api/sessions` (no id) and `DELETE /api/subagents` (no id) — bulk kills.
  - respawn / ralph / orchestrator / cron mutations — respawn runs `/clear` (wipes a
    conversation), orchestrator state is a single global slot, cron jobs outlive you.
  - `PUT /api/settings`, `POST /api/system/update` — global UI settings; server restart.
- Never `tmux kill-session`, `pkill tmux`, `pkill claude`. The API is the only interface.
- Sessions count against a 50-session cap and case creation is uncapped: clean up every
  session you start, and don't retry `quick-start` in a loop.

## 2. Rules of the road

- **End every input with `\r`** — literally the two characters `\r` inside the JSON
  string. Codeman types the text and sends Enter **only when the input contains a
  carriage return**; without it your command sits unsubmitted on the worker's prompt
  and everything downstream times out. `{"input":"run the tests\r",...}`. No response
  field catches this: `delivered:true` means "written to the pane", **not**
  "submitted" — a `\r`-less send still reports `delivered:true` and then every wait
  times out, which is why the loops below are bounded and check the terminal.
- **Single-line input only.** Newlines are stripped; one line per call.
- **Build request bodies with `jq -n` for any prompt you did not author as a
  literal.** The inline `-d '{"input":"'"$P"'\r"}'` pattern breaks on the first
  double quote, backslash, or `$` in a real prompt:

  ```bash
  BODY=$(jq -n --arg p "$PROMPT" '{input:($p+"\r"),useMux:true,clientId:"agent-1",seq:1,wait:true,waitTimeout:60000}')
  "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' --data-binary "$BODY"
  ```
- **Exactly-once delivery**: always send a stable `clientId` and a monotonic
  per-session `seq` on `POST .../input`. A retry after a dropped connection then
  cannot double-type the prompt. Increment `seq` for each NEW input; reuse the same
  pair only to re-ask about the same delivery.
- **Envelope**: success is `{"success":true,"data":…}`, errors are
  `{"success":false,"error","errorCode"}`. Read `.data`. Use `/api/v1/*` paths.
- **A wait timeout is HTTP 200**, `{wait:{timedOut:true,signal:null}}` — not an error.
  Loop over short waits (60 s); proxies cut long-idle connections. Timeouts are
  **clamped** (ceiling 600 s): read back `wait.timeoutMs` for what was applied.
- **`stop` and `blocked` fire for `claude` sessions only** (Claude Code hooks). On
  `shell`/`opencode`/`codex`/`gemini`/`antigravity`, requesting them explicitly is a
  400 — and lifecycle transitions there are coarse (a short shell command may emit
  **no** `idle` transition at all, verified live), so synchronize those modes with
  output markers, not signals.
- **Your typed command echoes into the output stream**, so a marker that appears
  verbatim in the input line matches **before the command runs**. Always split the
  marker (recipe below), keep it unique per call, and use `from=buffer` so a marker
  that printed before your wait landed is still found. Matching is literal — no regex.
- **Match single space-free tokens against TUI output.** A full-screen TUI (claude,
  codex, …) positions text with cursor movements, not literal spaces, so the stripped
  stream can read `Yes,Itrustthisfolder` and a multi-word match is unreliable there —
  whether a phrase keeps its spaces depends on how the TUI happened to draw it
  (observed live: some match, some never fire). Plain command output (shell workers,
  `echo` lines) keeps real spaces.

## 3. Recipes (each verified live)

**List sessions / find yourself** — metadata only, safe to poll:

```bash
"${CURL[@]}" "$API/api/v1/sessions" | jq '.data[] | {id, name, mode, status}'
"${CURL[@]}" "$API/api/v1/sessions" | jq --arg s "$SELF" '.data[] | select(.id | startswith($s))'
```

**Start a claude worker and wait until it is actually ready.** A new session reports
`idle` before its CLI has spawned, and a brand-new case shows a **trust dialog**
first, so neither "wait for idle" nor "wait for ❯" means ready (the trust dialog
contains `❯` too — observed live). Codeman *can* auto-accept that dialog itself, but
the accept rides a stream match that misses on some runs (both outcomes seen live),
so wait for the composer first and handle the dialog only as the bounded fallback —
never send a blind Enter up front (if auto-accept already fired, it lands in the
composer). Stage 1 is short on purpose: an already-trusted case matches `bypass` in
under a second, while a **virgin case can never pass stage 1** (the dialog is up, so
the composer is not) and always pays it in full before the fallback runs — the long
budget belongs to stage 3, after the dialog is answered:

```bash
SID=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
  -d '{"caseName":"worker-1","mode":"claude"}' | jq -r '.data.sessionId')
for _ in $(seq 1 30); do   # bounded: a bad SID would otherwise poll forever
  [ "$("${CURL[@]}" "$API/api/v1/sessions/$SID" | jq '.data.pid')" != null ] && break; sleep 1
done
# ⚠️ pid != null proves STARTUP only, never life: a worker that later dies inside
# its pane keeps status "idle" and a pid (the local tmux attach client, not the
# worker). The death check is wait?until=exit, below.
CID="agent-$$"; SEQ=1
# the composer's status bar ("bypass permissions on") is the ready marker — Codeman
# spawns claude in bypass mode. Single-token matches only: TUI text is space-less.
R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
    --data-urlencode 'match=bypass' --data-urlencode 'from=buffer' --data-urlencode 'timeout=5000')
if ! jq -e '.data.wait.matched' <<<"$R" >/dev/null; then
  # composer never appeared → the trust dialog is probably still up; accept it once
  T=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
      --data-urlencode 'match=trust' --data-urlencode 'from=buffer' --data-urlencode 'timeout=2000')
  if jq -e '.data.wait.matched' <<<"$T" >/dev/null; then
    "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
      -d '{"input":"\r","useMux":true,"clientId":"'"$CID"'","seq":'$SEQ'}' >/dev/null
    SEQ=$((SEQ+1))
  fi
  R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
      --data-urlencode 'match=bypass' --data-urlencode 'from=buffer' --data-urlencode 'timeout=45000')
  jq -e '.data.wait.matched' <<<"$R" >/dev/null || \
    { echo "worker $SID never became ready; inspect terminal?tail="; }
fi
```

**Send a prompt and wait for the turn to finish** (claude workers — the call to
prefer). It registers the waiter *before* typing, closing the race where a separate
wait sees the previous turn's idle state. Loop by resending the **identical** request:
the repeat is a tagged duplicate (same `clientId`+`seq`) that does not retype but
answers from the session's current state. Verified: the stop hook resolves this in
seconds; a duplicate resend answers in ~20 ms without retyping.

```bash
for TRY in $(seq 1 10); do   # BOUNDED: a \r-less send never produces a signal and resends are no-op duplicates
  R=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
    -d '{"input":"run the tests, then summarize in one line\r","useMux":true,"clientId":"'"$CID"'","seq":'$SEQ',"wait":true,"waitTimeout":60000}')
  if jq -e '.data.wait.timedOut' <<<"$R" >/dev/null; then
    [ "$TRY" = 2 ] && "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" \
      | jq -r '.data.terminalBuffer' | tail -5   # two straight timeouts: prompt sitting unsubmitted?
    continue
  fi
  # Resolved — but a duplicate answering immediately reports the session's CURRENT
  # state ("it is idle now"), NOT that a new turn ran. A \r-less send lands exactly
  # here on try 2 (verified live), so check the terminal before believing it:
  if jq -e '.data.duplicate and .data.wait.immediate' <<<"$R" >/dev/null; then
    "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" | jq -r '.data.terminalBuffer' | tail -5
    # your prompt still on the ❯ composer line = never submitted (missing \r);
    # submit it with {"input":"\r"} (the only recovery), then loop again
  fi
  break
done
SEQ=$((SEQ+1)); jq '.data.wait.signal, .data.status' <<<"$R"
```

Read the outcome in this order: `wait.signal != null` → done (`stop` is definitive;
`idle` is heuristic) — **unless** it arrived as `duplicate:true` + `immediate:true`,
which only says the session is idle *now* and must be confirmed from the terminal
(above); `wait.timedOut` → loop again (bounded); `wait.ended` → session gone, stop.
If the loop exhausts its cap, do not keep looping: read the terminal, report what
you see, and remember that a still-typed-but-unsubmitted prompt (missing `\r`) can
only be recovered by submitting it with `{"input":"\r"}`.

**Shell worker + completion marker** — the pattern for `shell` mode (no hooks there).
The typed line must not contain the marker verbatim (the input echo would match
instantly — observed live), so build it with a variable the worker's shell expands:

```bash
N="${RANDOM}_$$"; MARK="DONE_$N"     # unique per call: tmux repaints replay old text
"${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
  -d '{"input":"M=DONE; npm run build; echo ${M}_'"$N"' rc=$?\r","useMux":true,"clientId":"'"$CID"'","seq":'$SEQ'}'
SEQ=$((SEQ+1))
"${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
  --data-urlencode "match=$MARK" --data-urlencode 'from=buffer' --data-urlencode 'timeout=120000' \
  | jq -r '.data.wait | {matched, snippet}'
```

The typed line shows `${M}_…`, the real output shows `DONE_… rc=<exit code>`, and the
snippet carries the exit code back to you.

**Read a worker's output** — the terminal buffer, tail in **bytes** (`textOutput` in
`GET .../output` stays empty for interactive sessions; don't use it):

```bash
"${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=3000" | jq -r '.data.terminalBuffer' \
  | sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' -e 's/\x1b([B0]//g' | grep -v '^[[:space:]]*$' | tail -30
```

Avoid `?full=1` (entire tmux scrollback, a context bomb) unless doing a post-mortem.

**Detect a dead worker cheaply**: `GET .../wait?until=exit&timeout=60000` answers
immediately (`signal:"exit"`, `immediate:true`) if the PTY is gone — including a
worker that exited *inside* its pane, which `GET .../sessions/:id` keeps reporting
as `status:"idle"` with a pid (that pid is the local tmux attach client, not the
worker). The wait routes are the only liveness check; a worker dying while a wait
is parked resolves it within ~3 s. A session deleted mid-wait resolves in ~1 s.

**Clean up** — only ids you created, `is_self`-checked, one at a time:

```bash
is_self "$SID" || "${CURL[@]}" -X DELETE "$API/api/v1/sessions/$SID"
```

Everything else (endpoint tables, per-mode signal table, error codes, capacity
limits, Docker/remote caveats): [reference/endpoints.md](reference/endpoints.md).
Fan-out orchestration and blocked-worker handling:
[reference/recipes.md](reference/recipes.md).
