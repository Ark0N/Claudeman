# ---- Codeman agent preamble 1.19.0 (seeded by Codeman at session spawn; the SKILL.md §0 bootstrap rewrites it when missing or stale) ----
API="${CODEMAN_API_URL:?CODEMAN_API_URL not set; refusing to guess}"
SELF="${CODEMAN_SESSION_ID:?CODEMAN_SESSION_ID not set}"
# Credentials, cheapest first. Your session has usually INHERITED the server's
# CODEMAN_PASSWORD already (§6 explains why, and what to do when it has not);
# the data dir's .env is the documented fallback, the same one `codeman attach`
# reads. The data dir is wherever the hook-secret file lives. Values may be
# quoted or `export`-prefixed.
ENV_FILE="${CODEMAN_HOOK_SECRET_FILE:+${CODEMAN_HOOK_SECRET_FILE%hook-secret}.env}"
envval() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/'; }
if [ -z "${CODEMAN_PASSWORD:-}" ] && [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  CODEMAN_USERNAME=$(envval CODEMAN_USERNAME)
  CODEMAN_PASSWORD=$(envval CODEMAN_PASSWORD)
fi
AUTH=(); [ -n "${CODEMAN_PASSWORD:-}" ] && AUTH=(-u "${CODEMAN_USERNAME:-admin}:$CODEMAN_PASSWORD")
# -k: harmless on http, required on https (self-signed cert).
# X-Codeman-Parent-Session: tags workers YOU spawn as your children, so the web UI can
# draw the lineage. Set once here and every present and future create call carries it;
# it is ignored on every other endpoint. Purely cosmetic (see §5.1) and it can never
# fail a spawn, so there is no case where you would want to leave it off.
CURL=(curl -sk "${AUTH[@]}" -H "X-Codeman-Parent-Session: $SELF")
CID=codeman-agent-1            # FIXED literal, never "agent-$$": see below

# Fail-CLOSED session delete. The DELETE lives INSIDE the guard on purpose: the older
# `is_self "$SID" || curl -X DELETE ...` shape failed OPEN, because an undefined
# is_self exits 127 and the `||` branch then ran the delete completely unguarded.
# Undefined delete_session is "command not found", which deletes nothing.
delete_session() {
  local id="${1:-}"
  [ -n "$id" ] || { echo "refusing: empty session id"; return 1; }
  [ "${#SELF}" -ge 8 ] || { echo "refusing: \$SELF unset or too short to prove this is not me"; return 1; }
  # ids appear in full AND 8-char form (Docker exports a truncated $SELF; mux names and
  # UI surfaces carry 8-char ids), so compare by prefix in BOTH directions. Equality or
  # a one-directional check each miss a real combination, and the miss deletes you.
  case "$id" in "$SELF"*) echo "refusing: $id is me"; return 1 ;; esac
  case "$SELF" in "$id"*) echo "refusing: $id is me"; return 1 ;; esac
  "${CURL[@]}" -X DELETE "$API/api/v1/sessions/$id"
}

# ---- fast path: the four verbs, already written. §1 composes them. ----
_composer_up() {   # <sid> <timeoutMs> -> "true"/"false". `shift+tab` is the one token
  "${CURL[@]}" -G "$API/api/v1/sessions/$1/wait-output" \
    --data-urlencode 'match=shift+tab' --data-urlencode 'from=buffer' \
    --data-urlencode "timeout=$2" | jq -r '.data.wait.matched // false'
}
# spawn_worker <caseName> [mode] -> session id on stdout, diagnostics on stderr.
# quick-start AND readiness in one call, with a strict contract: NON-EMPTY stdout means
# a READY claude worker in a hook-carrying case. Anything less is rc 1 with EMPTY
# stdout, and the half-spawned session is deleted here rather than handed back, because
# a worker that never drew its composer would eat the task prompt with its trust
# dialog. There is deliberately no pid poll: wait-output already blocks until the
# composer draws, and pid!=null proved startup, never readiness.
spawn_worker() {
  local name="${1:?spawn_worker needs a case name}" mode="${2:-claude}" q sid cp r
  # parentSessionId doubles the CURL header, so a spawn_worker copied off the shared
  # curl (or a body someone rebuilt from this recipe) still carries its lineage.
  q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg n "$name" --arg m "$mode" --arg p "$SELF" '{caseName:$n,mode:$m,parentSessionId:$p}')")
  sid=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$q")
  # NOT retryable in a loop: every quick-start failure code is terminal (§5.1).
  [ -n "$sid" ] || { jq -c '{error,errorCode}' <<<"$q" >&2; return 1; }
  [ "$mode" = claude ] || { printf '%s\n' "$sid"; return 0; }   # only claude draws a composer
  # The server installs hooks into every claude workspace now, so this grep normally
  # passes; it stays because the install is gated on a setting the operator can turn
  # off, remote sessions never get hooks, and a session created by an older server
  # still has none. No marker means sendwait would false-resolve on flapping idle,
  # possibly inside the user's REAL repo: refuse rather than run the job there.
  cp=$(jq -r '.data.casePath // empty' <<<"$q")
  grep -qs '/api/hook-event' "$cp/.claude/settings.local.json" || {
    echo "case '$name' resolved to '$cp', which has no Codeman hooks (workspaceHooksEnabled off, remote, or an older server?): turn the setting on, or work §5.1+§5.5 by hand with markers" >&2
    delete_session "$sid" >/dev/null; return 1; }
  # Short composer wait FIRST, then the trust-dialog probe: a case still showing the
  # dialog can never pass the composer wait, so probing early keeps a cold case from
  # paying the whole long wait before the fallback even runs (§5.2). A warm case
  # matches in under a second and never reaches the probe.
  r=$(_composer_up "$sid" 5000)
  if [ "$r" != true ]; then
    if "${CURL[@]}" -G "$API/api/v1/sessions/$sid/wait-output" \
         --data-urlencode 'match=trust' --data-urlencode 'from=buffer' --data-urlencode 'timeout=2000' \
       | jq -e '.data.wait.matched' >/dev/null; then
      # Codeman's own auto-accept gives up after 90 s / 3 tries; this is that bounded fallback.
      "${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" -H 'Content-Type: application/json' \
        -d "$(jq -nc --arg c "$CID-$sid" '{input:"\r",useMux:true,clientId:$c,seq:1}')" >/dev/null
    fi
    r=$(_composer_up "$sid" 45000)
  fi
  [ "$r" = true ] || { echo "worker $sid never drew a composer; deleted it. Retry by hand via the §5.2 ladder (its billed stage-4 probe included)" >&2
    delete_session "$sid" >/dev/null; return 1; }
  printf '%s\n' "$sid"
}
# spawn_workers <caseName>... -> one "<caseName> <sessionId>" line per worker, in order;
# the sessionId column is EMPTY for a spawn that failed (stderr has why). CONCURRENT:
# N workers cost about what one costs. Spawning them one Bash call at a time is the
# single biggest avoidable delay in this skill. Names must be UNIQUE: two workers in
# one case directory co-edit the same tree (§4), so a repeat is an error here, not a race.
spawn_workers() {
  local d n i=0
  [ "$#" -gt 0 ] || { echo "spawn_workers: no case names given" >&2; return 1; }
  [ -z "$(printf '%s\n' "$@" | sort | uniq -d)" ] || { echo "spawn_workers: duplicate case names" >&2; return 1; }
  d=$(mktemp -d "${TMPDIR:-/tmp}/codeman-spawn.XXXXXX") || return 1
  for n in "$@"; do ( spawn_worker "$n" > "$d/$i" ) & i=$((i+1)); done
  wait
  i=0; for n in "$@"; do printf '%s %s\n' "$n" "$(cat "$d/$i" 2>/dev/null)"; i=$((i+1)); done
  rm -rf "$d"
}
# sendwait <sid> <prompt> [seq] -> blocks until that worker's turn ENDS (~10 min ceiling
# across its two waits). One billed turn. The \r and the per-worker clientId are applied
# here, which is why you never hand-build this body. seq defaults to the CURRENT EPOCH
# SECOND so that every new prompt is a new frame: the server drops any (clientId,seq)
# pair it has already applied, so a fixed default would make every later prompt to that
# worker a silent no-op that still "succeeds" and reports the previous turn's state.
# Pass seq explicitly for exactly one reason: resending a possibly-delivered frame as a
# deliberate duplicate, at the SAME number (§5.3).
# Delivery is SELF-HEALING: an Ink repaint occasionally eats the Enter, leaving the
# typed prompt stranded on the composer while a long wait runs its whole timeout
# (observed live). So the first wait is short; on its timeout a bare \r goes out (the
# missing Enter when the prompt is stranded, a no-op when the turn is genuinely
# running), then the ORIGINAL frame is resent unchanged, which the server takes as a
# tagged duplicate: it re-waits without retyping (§5.3). Trustworthy only for a claude
# worker spawn_worker handed back (hooks vetted); hook-less workspaces and other modes
# resolve on flapping idle: markers instead (§5.5).
sendwait() {
  local sid="${1:?}" p="${2:?}" seq="${3:-$(date +%s)}" body r
  body=$(jq -nc --arg p "$p" --arg c "$CID-$sid" --argjson s "$seq" \
    '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s,wait:true,waitTimeout:20000}')
  r=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" \
        -H 'Content-Type: application/json' --data-binary "$body")
  if jq -e '.data.delivered and .data.wait.timedOut' <<<"$r" >/dev/null 2>&1; then
    "${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg c "$CID-$sid" --argjson s "$(date +%s)" \
        '{input:"\r",useMux:true,clientId:$c,seq:$s}')" >/dev/null
    r=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" \
          -H 'Content-Type: application/json' --data-binary "$(jq -c '.waitTimeout=580000' <<<"$body")")
  fi
  printf '%s\n' "$r"
}
# last_text <sid> [prev] -> that worker's last assistant message. Polled, because the
# transcript write LAGS the stop signal, and "some text exists" is not "THIS turn's
# text exists": right after a SECOND turn on the same worker the endpoint still serves
# the previous answer for a beat (observed live). When reading consecutive turns, pass
# the previous answer as [prev]: the poll then holds out for text that differs from it,
# falling back to whatever it last saw if the budget runs dry, so an honestly repeated
# answer still comes back. Non-zero exit means the worker really never wrote one.
last_text() {
  local t="" prev="${2:-}"
  for _ in $(seq 1 15); do
    t=$("${CURL[@]}" "$API/api/v1/sessions/$1/last-response" | jq -r '.data.text // empty')
    [ -n "$t" ] && [ "$t" != "$prev" ] && { printf '%s\n' "$t"; return 0; }
    sleep 1
  done
  [ -n "$t" ] && { printf '%s\n' "$t"; return 0; }
  return 1
}

# The stamp is the LAST line on purpose (a truncated write leaves it unset) and is kept
# bare on purpose: the write condition above anchors on it with $, so an inline comment
# here would fail that match and rewrite this file on every single bootstrap.
CODEMAN_PREAMBLE=1.19.0
