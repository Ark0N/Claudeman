# ---- Codeman agent preamble 1.20.0 (seeded by Codeman at session spawn; the SKILL.md §0 bootstrap rewrites it when missing or stale) ----
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
_dsh_up() {        # <sid> <timeoutMs> -> "true"/"false". The DeepSeek Harness TUI's
  # composer glyph. Override with DSH_READY_MARK for a profile that draws another one.
  "${CURL[@]}" -G "$API/api/v1/sessions/$1/wait-output" \
    --data-urlencode "match=${DSH_READY_MARK:-❯}" --data-urlencode 'from=buffer' \
    --data-urlencode "timeout=$2" | jq -r '.data.wait.matched // false'
}
# spawn_worker <caseName> [mode] -> session id on stdout, diagnostics on stderr.
# quick-start AND readiness in one call, with a strict contract: NON-EMPTY stdout means
# a READY worker whose end-of-turn signal can be trusted -- a claude worker in a
# hook-carrying case, or a `deepseek` worker whose harness TUI drew its composer.
# Anything less is rc 1 with EMPTY stdout, and the half-spawned session is deleted here
# rather than handed back, because a worker that never drew its composer would eat the
# task prompt with its trust dialog. There is deliberately no pid poll: wait-output
# already blocks until the composer draws, and pid!=null proved startup, never readiness.
spawn_worker() {
  local name="${1:?spawn_worker needs a case name}" mode="${2:-claude}" q sid cp r
  # parentSessionId doubles the CURL header, so a spawn_worker copied off the shared
  # curl (or a body someone rebuilt from this recipe) still carries its lineage.
  # deepseek: ask for the same permission posture the Run button sends, because the
  # harness's own default (`workspace-write`) still ASKS, and a worker that stops on
  # an approval row is a worker no fan-out can finish. It is not an escalation --
  # claude workers already spawn with permissions skipped, and in multi-user mode the
  # server clamps this back to `workspace-write` for an owner without the grant.
  # Spawn by hand (§5.1) when you want a worker that asks.
  q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg n "$name" --arg m "$mode" --arg p "$SELF" \
        '{caseName:$n,mode:$m,parentSessionId:$p}
         + (if $m == "deepseek" then {deepSeekConfig:{permissionMode:"danger-full-access"}} else {} end)')")
  sid=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$q")
  # NOT retryable in a loop: every quick-start failure code is terminal (§5.1).
  [ -n "$sid" ] || { jq -c '{error,errorCode}' <<<"$q" >&2; return 1; }
  if [ "$mode" = deepseek ]; then
    # The one non-claude mode with REAL end-of-turn signals: its TUI reports
    # idle/working/blocked to Codeman, so sendwait, until=stop and the Approvals
    # Inbox all work here exactly as they do for claude. No hook file to vet
    # (the bridge is env-injected, not a workspace file) and no trust dialog.
    # ⚠️ Readiness is still not optional, and NOT interchangeable with the stop
    # signal: the harness's boot report lands ~300ms BEFORE the composer paints
    # (measured 2.26s vs 2.56s after spawn), so a sendwait fired straight after
    # quick-start returns on that BOOT signal, reports a turn that never ran, and
    # strands the prompt in a pane that was not yet taking input.
    r=$(_dsh_up "$sid" 45000)
    [ "$r" = true ] || { echo "dsh worker $sid never drew a composer: no pane-capable profile, a profile whose composer is not '${DSH_READY_MARK:-❯}' (set DSH_READY_MARK), or a harness that failed to boot -- check GET /api/v1/deepseek/status. Deleted it" >&2
      delete_session "$sid" >/dev/null; return 1; }
    printf '%s\n' "$sid"; return 0
  fi
  [ "$mode" = claude ] || { printf '%s\n' "$sid"; return 0; }   # no other mode draws a composer to wait on
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
# spawn_workers <caseName[:mode]>... -> one "<caseName> <sessionId>" line per worker, in
# order; the sessionId column is EMPTY for a spawn that failed (stderr has why).
# CONCURRENT: N workers cost about what one costs. Spawning them one Bash call at a time
# is the single biggest avoidable delay in this skill. A bare name is a claude worker;
# `beta:deepseek` makes that one a DeepSeek Harness worker, and a mixed fleet is one
# call. Case names must be UNIQUE: two workers in one case directory co-edit the same
# tree (§4), so a repeat is an error here, not a race (the mode never disambiguates two
# workers, since they would still share the directory).
spawn_workers() {
  local d spec n m i=0
  [ "$#" -gt 0 ] || { echo "spawn_workers: no case names given" >&2; return 1; }
  [ -z "$(printf '%s\n' "$@" | sed 's/:.*//' | sort | uniq -d)" ] || { echo "spawn_workers: duplicate case names" >&2; return 1; }
  d=$(mktemp -d "${TMPDIR:-/tmp}/codeman-spawn.XXXXXX") || return 1
  for spec in "$@"; do
    n=${spec%%:*}; m=${spec#*:}; [ "$m" = "$spec" ] && m=claude
    ( spawn_worker "$n" "$m" > "$d/$i" ) & i=$((i+1))
  done
  wait
  i=0; for spec in "$@"; do printf '%s %s\n' "${spec%%:*}" "$(cat "$d/$i" 2>/dev/null)"; i=$((i+1)); done
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
# tagged duplicate: it re-waits without retyping (§5.3). Trustworthy for a worker
# spawn_worker handed back -- claude (hooks vetted) or deepseek (status bridge) --
# and for those only. Hook-less workspaces and the other modes resolve on flapping
# idle: markers instead (§5.5). ⚠️ A dsh worker running a profile that does not
# implement the status contract is the one case that LOOKS like claude but is not:
# it accepts the send and then burns both waits. One timeout on a dsh worker whose
# pane clearly finished means that profile, so switch that worker to markers.
sendwait() {
  local sid="${1:?}" p="${2:?}" seq="${3:-$(date +%s)}" body r
  # `wait:"stop,exit"`, never the `wait:true` default set: that set also carries
  # `idle`, which is INFERRED from output stabilization and flaps mid-turn. On a
  # dsh worker whose TUI repaints rarely the session reads `idle` while the model
  # is still answering, and the re-wait below then resolved in 0 ms with
  # `signal:"idle"` on a turn that had another three minutes to run (measured).
  # A wait named after the end of a turn should only end with the turn, or with
  # the worker. ⚠️ This is also what makes a wrong mode LOUD: the modes that
  # cannot deliver `stop` answer 400 (before writing anything) instead of
  # resolving on a flap, which is the answer that sends you to markers (§5.5).
  body=$(jq -nc --arg p "$p" --arg c "$CID-$sid" --argjson s "$seq" \
    '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s,wait:"stop,exit",waitTimeout:20000}')
  r=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" \
        -H 'Content-Type: application/json' --data-binary "$body")
  if jq -e '.data.delivered and .data.wait.timedOut' <<<"$r" >/dev/null 2>&1; then
    "${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg c "$CID-$sid" --argjson s "$(date +%s)" \
        '{input:"\r",useMux:true,clientId:$c,seq:$s}')" >/dev/null
    # The resend is a tagged DUPLICATE, so the server skips the write and reports
    # `delivered:false` for it -- truthfully, but about the wrong send. The first
    # one delivered, so carry that forward, or §1's cleanup reads a completed turn
    # as an undelivered one and keeps a finished worker forever.
    r=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" \
          -H 'Content-Type: application/json' --data-binary "$(jq -c '.waitTimeout=580000' <<<"$body")" \
        | jq -c 'if .success and (.data.wait.ended | not) then .data.delivered = true else . end')
  fi
  printf '%s\n' "$r"
}
# last_text <sid> [prev] -> that worker's last assistant message (claude, codex and
# deepseek write a real transcript; the other modes have none, so read the terminal
# instead -- §5.4). Polled, because the transcript write LAGS the stop signal, and
# "some text exists" is not "THIS turn's text exists": right after a SECOND turn on the same worker the endpoint still serves
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
CODEMAN_PREAMBLE=1.20.0
