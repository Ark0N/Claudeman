# Worked orchestration flows

Loaded on demand from the `codeman` skill. Every flow assumes the guard preamble from
SKILL.md ran (`$API`, `$SELF`, `"${CURL[@]}"`, `is_self`). Track every session id you
create; delete them (and only them) when done. Remember the two silent killers:
**every input ends with `\r`**, and **markers must be split** so the typed-line echo
does not match them.

## Flow 1: claude worker, end to end

Start a worker, get it truly ready (trust dialog included), give it a task, wait for
the turn to finish, read the answer, clean up. Verified live: the stop hook resolves
the send-and-wait within seconds of the turn ending.

```bash
# 1. start (returns before the CLI inside is ready)
SID=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
  -d '{"caseName":"worker-tests","mode":"claude"}' | jq -r '.data.sessionId')
CREATED+=("$SID")   # the cleanup list
CID="agent-$$"; SEQ=1

# 2. readiness. "wait for idle" or "wait for ❯" is NOT readiness: a fresh session
#    reports idle before anything spawned, and the first-run trust dialog contains ❯.
#    Codeman CAN auto-accept that dialog, but the accept misses on some runs (both
#    outcomes seen live), so: composer marker first, dialog only as the bounded
#    fallback (a blind Enter up front would land in an already-ready composer).
#    Stage 1 is SHORT on purpose: an already-trusted case matches in <1 s, while a
#    virgin case can never pass it (the dialog is up) and always pays it in full —
#    the long budget belongs to stage 3, after the dialog is answered.
#    Single-token matches only: TUI text is space-less in the stream.
for _ in $(seq 1 30); do
  [ "$("${CURL[@]}" "$API/api/v1/sessions/$SID" | jq '.data.pid')" != null ] && break; sleep 1
done
# (pid != null proves startup only — a worker that later dies inside its pane keeps
#  status "idle" and a pid. The death check is wait?until=exit.)
R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
    --data-urlencode 'match=bypass' --data-urlencode 'from=buffer' --data-urlencode 'timeout=5000')
if ! jq -e '.data.wait.matched' <<<"$R" >/dev/null; then
  T=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
      --data-urlencode 'match=trust' --data-urlencode 'from=buffer' --data-urlencode 'timeout=2000')
  if jq -e '.data.wait.matched' <<<"$T" >/dev/null; then
    "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
      -d '{"input":"\r","useMux":true,"clientId":"'"$CID"'","seq":'$SEQ'}' >/dev/null
    SEQ=$((SEQ+1))
  fi
  R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
      --data-urlencode 'match=bypass' --data-urlencode 'from=buffer' --data-urlencode 'timeout=45000')
  jq -e '.data.wait.matched' <<<"$R" >/dev/null || echo "worker $SID not ready; inspect terminal?tail="
fi

# 3. send-and-wait, looping on the IDENTICAL request (tagged duplicate: no retype).
#    BOUNDED (a \r-less send would otherwise loop forever), body built with jq -n so
#    quotes/backslashes/$ in a real prompt survive; note the appended \r.
PROMPT='run the unit tests and summarize failures in one line'
BODY=$(jq -n --arg p "$PROMPT" --arg c "$CID" --argjson s "$SEQ" \
  '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s,wait:true,waitTimeout:60000}')
for TRY in $(seq 1 10); do
  R=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" \
      -H 'Content-Type: application/json' --data-binary "$BODY")
  if jq -e '.data.wait.timedOut' <<<"$R" >/dev/null; then
    jq -e '.data.limitPaused' <<<"$R" >/dev/null && sleep 60   # usage-limit pause: silence is expected
    [ "$TRY" = 2 ] && "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" \
      | jq -r '.data.terminalBuffer' | tail -5   # is the prompt sitting unsubmitted?
    continue
  fi
  # Resolved — but duplicate + immediate is only "the session is idle NOW", which a
  # never-submitted (\r-less) prompt also produces. Check before believing it:
  if jq -e '.data.duplicate and .data.wait.immediate' <<<"$R" >/dev/null; then
    "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" \
      | jq -r '.data.terminalBuffer' | tail -5
    # prompt still on the ❯ composer line = never submitted; {"input":"\r"} is the
    # only recovery, then loop again
  fi
  break
done
SEQ=$((SEQ+1))

# 4. interpret
case "$(jq -r '.data.wait.signal' <<<"$R")" in
  stop) : ;;                          # definitive end of turn
  idle) : ;;                          # heuristic — and if it rode a duplicate with
                                      # immediate:true, it proves nothing ran (step 3)
  exit) echo "worker died" ;;
  null) jq -e '.data.wait.ended' <<<"$R" >/dev/null && echo "worker deleted mid-wait" ;;
esac

# 5. read the answer: terminal tail (BYTES), ANSI-stripped. textOutput stays empty
#    for interactive sessions; terminal?full=1 is a context bomb.
"${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=4000" | jq -r '.data.terminalBuffer' \
  | sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' -e 's/\x1b([B0]//g' | grep -v '^[[:space:]]*$' | tail -30

# 6. clean up — exact id, own list only, self-check
is_self "$SID" || "${CURL[@]}" -X DELETE "$API/api/v1/sessions/$SID"
```

Increment `SEQ` for every *new* input to the same worker. Reuse the same `SEQ` only to
re-ask about the same delivery (the duplicate-wait loop above).

## Flow 2: shell worker running a build, marker-synchronized

`shell` sessions have no hooks (`stop`/`blocked` are a 400 there), and their lifecycle
signals are coarse — a short command may emit no `idle` transition at all (verified
live), so send-and-wait can burn its whole timeout. The reliable pattern is a split,
unique marker plus `wait-output from=buffer`:

```bash
SID=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
  -d '{"caseName":"builder","mode":"shell"}' | jq -r '.data.sessionId')
CREATED+=("$SID")
for _ in $(seq 1 30); do
  [ "$("${CURL[@]}" "$API/api/v1/sessions/$SID" | jq '.data.pid')" != null ] && break; sleep 1
done

# Split marker: the typed line carries ${M}_N, only the OUTPUT carries DONE_N.
# An unsplit marker matches the echo of your own keystrokes before the build runs.
N="${RANDOM}_$$"; MARK="DONE_$N"
"${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
  -d '{"input":"M=DONE; npm run build; echo ${M}_'"$N"' rc=$?\r","useMux":true,"clientId":"build-'$$'","seq":1}'

for TRY in $(seq 1 30); do   # BOUNDED (30 min): a \r-less send makes an uncapped loop infinite
  R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
      --data-urlencode "match=$MARK" --data-urlencode 'from=buffer' --data-urlencode 'timeout=60000')
  jq -e '.data.wait.matched' <<<"$R" >/dev/null && break
  jq -e '.data.wait.ended'   <<<"$R" >/dev/null && { echo "worker gone"; break; }
  [ "$TRY" = 2 ] && "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" \
    | jq -r '.data.terminalBuffer' | tail -5   # command still sitting unsubmitted?
done
jq -r '.data.wait.snippet' <<<"$R"    # e.g. "DONE_123_456 rc=0" — the exit code rides the marker line
```

## Flow 3: fan out N workers, gather as each finishes

Start everything first, then gather. One in-flight wait per worker — the per-session
waiter cap is 16 and abandoned concurrent waits pile up against it.

```bash
declare -A WORKER MARKS
for task in lint typecheck unit; do
  SID=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
    -d '{"caseName":"fan-'"$task"'","mode":"shell"}' | jq -r '.data.sessionId')
  WORKER[$task]=$SID; CREATED+=("$SID")
done
for task in "${!WORKER[@]}"; do
  SID=${WORKER[$task]}
  for _ in $(seq 1 30); do
    [ "$("${CURL[@]}" "$API/api/v1/sessions/$SID" | jq '.data.pid')" != null ] && break; sleep 1
  done
  N="${task}_${RANDOM}"; MARKS[$task]="DONE_$N"
  "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
    -d '{"input":"M=DONE; npm run '"$task"'; echo ${M}_'"$N"' rc=$?\r","useMux":true,"clientId":"fan-'$$'","seq":1}'
done
for task in "${!WORKER[@]}"; do        # sequential gather; each wait blocks until that worker is done
  for TRY in $(seq 1 30); do           # BOUNDED per worker, same reasoning as Flow 2
    R=$("${CURL[@]}" -G "$API/api/v1/sessions/${WORKER[$task]}/wait-output" \
        --data-urlencode "match=${MARKS[$task]}" --data-urlencode 'from=buffer' --data-urlencode 'timeout=60000')
    jq -e '.data.wait.matched or .data.wait.ended' <<<"$R" >/dev/null && break
  done
  echo "$task: $(jq -r '.data.wait.snippet // "worker gone"' <<<"$R" | tail -1)"
done
```

## Flow 3b: fan out N CLAUDE workers

Send-and-wait is synchronous, so the shell-flow shape ("send everything, then
gather") does not translate directly: the send *is* the wait, and worker 2's prompt
would not go out until worker 1's turn ended. Two working patterns, both verified
live (and one anti-pattern, measured failing, replaced by B):

**A. Background the send-and-waits** (simplest; each resolved on `stop` while the
other was still running):

```bash
sendwait() {  # $1=sid $2=prompt $3=seq — assumes the worker passed Flow 1's readiness
  local body; body=$(jq -n --arg p "$2" --argjson s "$3" \
    '{input:($p+"\r"),useMux:true,clientId:"fan-'$$'",seq:$s,wait:true,waitTimeout:600000}')
  "${CURL[@]}" -X POST "$API/api/v1/sessions/$1/input" \
    -H 'Content-Type: application/json' --data-binary "$body" > "/tmp/fan-$1.json"
}
( sendwait "$SID1" 'refactor module A and reply DONE' 2 & \
  sendwait "$SID2" 'write tests for module B and reply DONE' 2 & wait )
jq -c '.data.wait | {signal, waitedMs}' /tmp/fan-"$SID1".json /tmp/fan-"$SID2".json
```

One in-flight wait per worker keeps you far from the 16-per-session waiter cap.

**B. Fire-and-forget, then gather with output markers.** If you must send every
prompt before waiting on anything, do **not** gather with signal waits: signals
are edge-triggered with no history, so a `stop` that fires before the gather
reaches that worker is gone and unobservable afterwards — `fresh=1` cannot help,
and neither can omitting it (measured: worker 2's turn ended at +2 s, its
sequential `until=stop,exit&fresh=1` gather burned its full bounded 300 s and
reported nothing). Gather instead on a marker each worker prints itself, which
`from=buffer` re-finds no matter when it appeared:

```bash
# SIDS[1], SIDS[2] = worker ids that already passed Flow 1's readiness.
# The typed prompt must NOT contain the finished marker verbatim (your keystrokes
# echo into the output stream and would match instantly), so ask for it in halves:
declare -A TOK
for i in 1 2; do
  TOK[$i]="${RANDOM}_$i"
  BODY=$(jq -n --arg p "do task $i; when completely done print the word WORKDONE immediately followed by _${TOK[$i]}" \
    --arg c "fan-$$" --argjson s 2 '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s}')
  "${CURL[@]}" -X POST "$API/api/v1/sessions/${SIDS[$i]}/input" \
    -H 'Content-Type: application/json' --data-binary "$BODY"
done
for i in 1 2; do        # order no longer matters: the marker is latched in the buffer
  "${CURL[@]}" -G "$API/api/v1/sessions/${SIDS[$i]}/wait-output" \
    --data-urlencode "match=WORKDONE_${TOK[$i]}" --data-urlencode 'from=buffer' \
    --data-urlencode 'timeout=600000' | jq -c '.data.wait | {matched, snippet}'
done
```

Use A unless you genuinely need to send everything before waiting on anything: A
needs no marker discipline, and resolves on the definitive `stop` instead of on
the worker remembering to print a token.

## Flow 4: watch for a worker stuck on a permission prompt

Claude workers can block on a permission dialog. `blocked` is a wait signal
(claude-mode only), so watch for it and surface the question to the user instead of
guessing an answer:

```bash
R=$("${CURL[@]}" "$API/api/v1/sessions/$SID/wait?until=stop,blocked,exit&timeout=60000")
if [ "$(jq -r '.data.wait.signal' <<<"$R")" = blocked ]; then
  "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" | jq -r '.data.terminalBuffer' \
    | sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | grep -v '^[[:space:]]*$' | tail -15
  # show this to the user and ask how to answer; do NOT auto-confirm another
  # session's permission prompt
fi
```

## Cleanup discipline

At the end of the conversation (or on abort), delete exactly what you created:

```bash
for id in "${CREATED[@]}"; do
  is_self "$id" || "${CURL[@]}" -X DELETE "$API/api/v1/sessions/$id"
done
```

- Only ids from your own `CREATED` list. Never enumerate `/api/v1/sessions` and
  delete by pattern; other sessions belong to the user.
- If you created a *case* purely as scratch and the user confirmed it is disposable,
  `DELETE /api/v1/cases/:name` removes it — but that recursively deletes the
  directory from disk, so never do it without the user's explicit go-ahead for that
  exact name.
