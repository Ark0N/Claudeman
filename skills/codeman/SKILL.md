---
name: codeman
description: >-
  Drive Codeman, the session manager this agent is running inside, over its HTTP API:
  list sessions, start worker sessions, send them prompts, block until they finish
  (wait / wait-output / send-and-wait), read their output, and clean up; where
  available, message claude workers directly (Claude Code cross-session messaging).
  Use when asked to orchestrate or parallelize work across Codeman sessions, watch
  another session, or start and manage workers. Only usable inside a Codeman-managed
  session (CODEMAN_MUX=1); refuse to act otherwise.
---

# Driving Codeman from inside a session

You are an agent running inside a Codeman-managed terminal session. Codeman is the
server that spawned you; its HTTP API can start, prompt, watch, and delete other
sessions.

**Read as far as your job needs and no further.** §0 is the bootstrap, run once. §1 is
the whole fast path: spawn N workers, task them, collect answers. **If §1 covers your
job, run it and stop there.** The sections after it are for jobs it does not cover, and
reading them to be thorough is the main reason a ten-second run takes minutes. §2 is the
verb table when your job is a different one. §3 and §4 are the rules; §6 is setup and
credentials, which you only need when something 401s.

Everything else loads on demand, and is meant to be opened at one section, not read
through: the verbs in detail (the old §5) in [reference/verbs.md](reference/verbs.md),
worked multi-worker flows in [reference/recipes.md](reference/recipes.md), endpoint
tables and a symptom gallery in [reference/endpoints.md](reference/endpoints.md), and
direct messaging to claude workers in [reference/messaging.md](reference/messaging.md).

## 0. Guard and bootstrap

If `CODEMAN_MUX` is not `1`, **stop and say so**. Do not guess an API URL; a server
you are not part of is not yours to drive.

⚠️ **Your shell state does not survive between tool calls.** Each Bash call starts a
fresh shell, so `$API`, `$SELF`, the `CURL` array and `delete_session` are all gone by
the next call, and `$$` is a different pid. **The filesystem does survive**, so write
the preamble to a file once and source it afterwards, rather than re-pasting ~30 lines
at the top of every call (a half-re-pasted preamble used to be the single most likely
way to break a run).

Run this block once per Codeman session:

```bash
test "${CODEMAN_MUX:-}" = 1 || { echo "Not inside a Codeman-managed session; refusing to act."; exit 1; }
: "${CODEMAN_SESSION_ID:?CODEMAN_SESSION_ID not set}" "${HOME:?HOME not set}"
PRE="${XDG_CACHE_HOME:-$HOME/.cache}/codeman-agent-$CODEMAN_SESSION_ID.sh"
mkdir -p "$(dirname "$PRE")"
# Rewrite unless the file already ends with THIS version's stamp, so a stale or a
# half-written file self-heals here instead of costing you a round trip to rm it.
grep -qs '^CODEMAN_PREAMBLE=1.19.0$' "$PRE" || (umask 077; cat > "$PRE" <<'PREAMBLE'
# ---- Codeman agent preamble 1.19.0 (written by the SKILL.md §0 bootstrap) ----
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
# quick-start AND readiness in one call. There is deliberately no pid poll: wait-output
# already blocks until the composer draws, and pid!=null proved startup, never readiness.
spawn_worker() {
  local name="${1:?spawn_worker needs a case name}" mode="${2:-claude}" q sid r
  q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg n "$name" --arg m "$mode" '{caseName:$n,mode:$m}')")
  sid=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$q")
  # NOT retryable in a loop: every quick-start failure code is terminal (§5.1).
  [ -n "$sid" ] || { jq -c '{error,errorCode}' <<<"$q" >&2; return 1; }
  [ "$mode" = claude ] || { printf '%s\n' "$sid"; return 0; }   # only claude draws a composer
  r=$(_composer_up "$sid" 45000)
  if [ "$r" != true ] && "${CURL[@]}" -G "$API/api/v1/sessions/$sid/wait-output" \
       --data-urlencode 'match=trust' --data-urlencode 'from=buffer' --data-urlencode 'timeout=2000' \
     | jq -e '.data.wait.matched' >/dev/null; then
    # Codeman's own auto-accept gives up after 90 s / 3 tries; this is that bounded fallback.
    "${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg c "$CID-$sid" '{input:"\r",useMux:true,clientId:$c,seq:1}')" >/dev/null
    r=$(_composer_up "$sid" 45000)
  fi
  [ "$r" = true ] || echo "worker $sid never drew a composer; inspect terminal?tail=" >&2
  printf '%s\n' "$sid"
}
# spawn_workers <caseName>... -> one "<caseName> <sessionId>" line per worker, in order.
# CONCURRENT: N workers cost about what one costs. Spawning them one Bash call at a time
# is the single biggest avoidable delay in this skill.
spawn_workers() {
  local d n
  d=$(mktemp -d "${TMPDIR:-/tmp}/codeman-spawn.XXXXXX") || return 1
  for n in "$@"; do ( spawn_worker "$n" > "$d/$n" ) & done
  wait
  for n in "$@"; do printf '%s %s\n' "$n" "$(cat "$d/$n" 2>/dev/null)"; done
  rm -rf "$d"
}
# sendwait <sid> <prompt> [seq] -> blocks until that worker's turn ENDS. One billed turn.
# The \r and the per-worker clientId are applied here, which is why you never hand-build
# this body. Trustworthy wherever quick-start CREATED the case (those always have hooks).
sendwait() {
  local sid="${1:?}" p="${2:?}" seq="${3:-2}"
  "${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" -H 'Content-Type: application/json' \
    --data-binary "$(jq -nc --arg p "$p" --arg c "$CID-$sid" --argjson s "$seq" \
      '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s,wait:true,waitTimeout:600000}')"
}
# last_text <sid> -> that worker's last assistant message. Polled, because the transcript
# write LAGS the stop signal. Non-zero exit means it really never wrote one.
last_text() {
  local t
  for _ in $(seq 1 15); do
    t=$("${CURL[@]}" "$API/api/v1/sessions/$1/last-response" | jq -r '.data.text // empty')
    [ -n "$t" ] && { printf '%s\n' "$t"; return 0; }
    sleep 1
  done
  return 1
}

# The stamp is the LAST line on purpose (a truncated write leaves it unset) and is kept
# bare on purpose: the write condition above anchors on it with $, so an inline comment
# here would fail that match and rewrite this file on every single bootstrap.
CODEMAN_PREAMBLE=1.19.0
PREAMBLE
)
. "$PRE"; [ "${CODEMAN_PREAMBLE:-}" = 1.19.0 ] || { echo "preamble at $PRE is stale or truncated: rm it and re-run this block"; exit 1; }
```

Every later Bash call that touches the API starts with these two lines instead:

```bash
. "${XDG_CACHE_HOME:-$HOME/.cache}/codeman-agent-$CODEMAN_SESSION_ID.sh" 2>/dev/null
[ "${CODEMAN_PREAMBLE:-}" = 1.19.0 ] || { echo "preamble missing or stale; re-run the §0 bootstrap"; exit 1; }
```

Why it is built this way, all of it load-bearing:

- **It still fails closed.** A missing or truncated file means `delete_session` is
  undefined, and an undefined function is "command not found", which deletes nothing.
  ⚠️ This argument covers accidents, NOT a hostile file: a *complete* attacker-written
  preamble can define `delete_session` and set the stamp, and sourcing executes it. What
  defends against that is the path choice in the next bullet, not this one. Never
  hand-roll a `DELETE` of your own, which is the one thing that would route around this.
- **The version stamp is the LAST line, and the write condition greps for it.** That one
  choice covers staleness and truncation together: an old skill version's file and a
  half-written one both fail the grep and are rewritten in place, so neither costs you a
  round trip to diagnose and `rm`. The older `[ -s "$PRE" ]` condition could not tell a
  complete file from a half-written one and left both to the post-source guard, which can
  only refuse, not repair. That guard stays as the fail-closed backstop: if the rewrite
  itself is cut short, `CODEMAN_PREAMBLE` is unset and the call stops.
- **Not `/tmp`.** On a shared machine `/tmp` is world-writable, so another local user
  can pre-create the exact path you are about to `.` and have their code run as you.
  `$HOME`-derived paths are not world-writable, and the file is written 0600 anyway.
  The file holds the credential-*recovery code*, not a recovered password.
- **Never put `$$` in a `clientId`.** It changes per call, so the "resend the identical
  request" loop in §5.3 would stop being a duplicate and would **retype the prompt**,
  submitting the turn twice. Use the fixed literal `$CID`.
- Only real environment variables (`CODEMAN_*`, `HOME`) survive, which is why the
  preamble rebuilds `$API` and `$SELF` from them on every source rather than baking
  them in.

If a call comes back as unparseable text instead of JSON, that is almost always a
plain-text 401: see §6 and [the symptom gallery](reference/endpoints.md#symptom-gallery).

## 1. The fast path: N workers, one Bash call

**If the job is "spawn N claude workers, give them tasks, collect the answers", this
block is the whole thing. Run it, report, and stop reading. §2 onward is for jobs this
does not cover; you are not being careless by not reading them.**

Fill in the case names and the prompts. Everything below is `spawn_workers` /
`sendwait` / `last_text` / `delete_session` from the §0 preamble, so there is nothing
to assemble and no per-call body to hand-build.

```bash
. "${XDG_CACHE_HOME:-$HOME/.cache}/codeman-agent-$CODEMAN_SESSION_ID.sh"   # §0
declare -A W P
P[alpha]='reply with one line: the absolute path of your working directory'
P[beta]='reply with one line: your model name'

while read -r n s; do W[$n]=$s; done < <(spawn_workers "${!P[@]}")   # concurrent
for n in "${!W[@]}"; do [ -n "${W[$n]}" ] || { echo "spawn failed: $n (see §5.1)"; exit 1; }; done

D=$(mktemp -d); for n in "${!W[@]}"; do sendwait "${W[$n]}" "${P[$n]}" > "$D/$n" & done; wait
for n in "${!W[@]}"; do jq -c --arg n "$n" '{worker:$n, signal:.data.wait.signal}' "$D/$n"; done
for n in "${!W[@]}"; do echo "== $n"; last_text "${W[$n]}" || echo "(no response written)"; done
for n in "${!W[@]}"; do delete_session "${W[$n]}" >/dev/null; done; rm -rf "$D"
```

Measured against a live 1.18.0 server: two cold workers spawned and ready in **6.3 s**,
both turns dispatched and both answers read in **4.0 s** more. If your run takes minutes,
the time went into deliberation, not the API. The three things that actually cost time:

- **Spawning serially.** One worker per Bash call is one model turn per worker. `&` plus
  `wait`, as above, makes N workers cost about what one costs.
- **Re-deriving the happy path** from §5.1 + §5.2 + §5.3 + §5.10. That is what the
  preamble functions exist to end. Compose them; do not rebuild them.
- **Verifying what is already guaranteed.** Two checks specifically are not worth a call
  here: `quick-start` on a case name **it creates** always writes hooks, so `stop` fires
  and `sendwait` is trustworthy without reading `settings.local.json`; and the pid poll is
  dead weight, because `wait-output` already blocks on the composer.

Four things this block leans on, each one link away, no detour needed to run it:

- Those case names create **fresh scratch directories** under `~/codeman-cases/<name>`,
  not your repo. Spawning where the work actually is (a linked case, a git worktree) is
  a different call with **no hooks**, and it is the mistake with the highest cost: §5.1.
  That is also the one case where the hook check above is required rather than skippable.
- `sendwait` supplies the `\r`. A prompt without it is never submitted and everything
  downstream times out: §3.
- Each `sendwait` costs that worker one billed turn, as does every prompt you send it.
- Deleting the sessions does **not** remove the case directories: §5.14.
- The prompt ends with `\r`. Without it nothing is submitted and everything downstream
  times out: §3.
- The send-and-wait call costs the worker one billed turn, as does every prompt you
  send it.
- Deleting the session does **not** remove the case directory it created: §5.14.

## 2. What do you want to do?

One row per job. Acting on this table alone is correct; the §5 links are the detail.

| I want to | Call | Detail |
|-----------|------|--------|
| start a worker **where the work is** | `POST /api/v1/quick-start {"caseName":…}`, which **creates** `~/codeman-cases/<name>` unless the name is already a case: full signals there. Any other path (a git worktree): `POST /api/v1/sessions {"workingDir":…}` then `POST /api/v1/sessions/:id/interactive`, and expect **no hooks**. N workers means N worktrees | [§5.1](reference/verbs.md#51-where-to-spawn) |
| know a new worker can accept a prompt | `GET .../wait-output?match=shift+tab&from=buffer` (urlencode the `+`) | [§5.2](reference/verbs.md#52-readiness) |
| deliver a task **and** know when it finished | `POST .../input` with `"input":"…\r"`, `clientId`, `seq`, `"wait":true`. Resolves on `stop`, so it is only trustworthy in a **case Codeman created** (claude mode + hooks present). Costs the worker one billed turn | [§5.3](reference/verbs.md#53-send-a-task-and-wait) |
| know a hook-less worker finished | it has no `stop`, and `wait:true` there resolves on flapping `idle` **without erroring**: make it print a split, unique marker and `wait-output` on that instead | [§5.5](reference/verbs.md#55-markers-for-hook-less-workers) |
| read the answer | `GET .../last-response`, **polled** (claude/codex only; empty for the other modes) | [§5.4](reference/verbs.md#54-read-the-answer) |
| know if it is alive | `GET .../wait?until=exit&timeout=1000`: an immediate `signal:"exit"` means dead. `status` and `pid` both lie | [§5.6](reference/verbs.md#56-alive-and-stuck) |
| know if it is stuck | `GET .../active-tools` and `GET .../run-summary` are structured and free; two `terminal?tail=` samples are the crude fallback | [§5.6](reference/verbs.md#56-alive-and-stuck) |
| make a runaway worker stop | `POST .../input {"input":"\u001b"}` (ESC, **no** `\r`). Deleting the session would destroy the conversation instead | [§5.7](reference/verbs.md#57-interrupt-without-destroying) |
| resume a worker halted on a usage limit | `POST .../auto-resume {"enabled":true}`. Respawn and Ralph are **not** the remedy: respawn runs `/clear` | [§5.8](reference/verbs.md#58-usage-limits) |
| give a worker big input | write a file into its workspace with your own tools and send one short line pointing at it. The composer takes 65536 characters, single-line, newlines stripped | [§5.9](reference/verbs.md#59-big-input-via-the-workspace) |
| watch N workers at once | one in-flight wait per worker (per-session waiter cap 16); fan-out shapes differ for claude and shell | [§5.10](reference/verbs.md#510-fan-out) |
| find yourself, list what exists | `GET /api/v1/sessions`, match your `$SELF` by **prefix** | [§5.11](reference/verbs.md#511-list-and-find-yourself) |
| read or record what the user wants | `GET/PUT .../intent`, and `POST .../readmymind` to predict | [§5.12](reference/verbs.md#512-read-my-mind) |
| talk to a claude worker directly | `ListAgents` / `SendMessage`, when the feature is on at both ends | [§5.13](reference/verbs.md#513-messaging-claude-workers) |
| clean up | `delete_session "$SID"` per id you created. Case directories and git worktrees are **not** removed with it | [§5.14](reference/verbs.md#514-clean-up) |

## 3. Rules digest

Ten one-liners. Each breaks something concrete; the reason is one link away.

1. **End every input with `\r`** or Enter is never sent and the text sits unsubmitted
   ([§5.3](reference/verbs.md#53-send-a-task-and-wait)).
2. **Never branch on `.data.status`.** It reads `idle` mid-turn and `idle` on a dead
   worker ([§5.6](reference/verbs.md#56-alive-and-stuck)).
3. **Split your markers.** Your typed command echoes into the output stream, so an
   unsplit marker matches before the command runs
   ([§5.5](reference/verbs.md#55-markers-for-hook-less-workers)).
4. **Match single space-free tokens against TUI output.** A TUI positions words with
   cursor moves, so multi-word matches are unreliable there
   ([§5.2](reference/verbs.md#52-readiness)).
5. **A wait timeout is a 200, not an error.** Loop over short waits; the clamp and the
   applied `wait.timeoutMs` are in
   [endpoints.md](reference/endpoints.md#limits-and-caps).
6. **Signals are edge-triggered with no history.** Register the waiter before the
   event can happen; a `stop` that fires with no waiter is unobservable afterwards
   ([§5.10](reference/verbs.md#510-fan-out)).
7. **Never delete without `delete_session`.** The server lets a session delete itself
   ([§4](#4-safety-rules)).
8. **One in-flight wait per worker.** The per-session waiter cap is 16 and abandoned
   waits count against it ([§5.10](reference/verbs.md#510-fan-out)).
9. **Every message you send a worker costs it a billed turn**, including a readiness
   ping and an interrupted turn ([§5.7](reference/verbs.md#57-interrupt-without-destroying)).
10. **Never answer another session's dialog.** Approving a permission prompt you did
    not raise authorizes an action the user never saw ([§4](#4-safety-rules)).

## 4. Safety rules

You are yourself a session on this server, and the API has **no undo**.

- **Never act on your own session, and know that `delete_session` is the ONLY guard.**
  The server has no self-protection: a session that DELETEs its own id succeeds and
  dies silently (verified live). **Always delete through `delete_session "$SID"` from
  §0; never write a bare `curl -X DELETE` and never reintroduce the
  `is_self … || curl -X DELETE …` shape.** That older form failed open: with the
  function undefined (a missing or truncated preamble file, see §0) bash returns 127,
  the `||` branch fires, and the delete runs with no self-check at all. Wrapping the
  request inside the guard is what makes a lost preamble delete nothing instead of
  deleting you. Apply the same prefix-both-directions reasoning before any kill,
  respawn, or input call you write by hand.
- **Mutating calls you may make unprompted** (this is an allowlist):
  `POST /api/v1/quick-start`; `POST /api/v1/sessions` + `POST /api/v1/sessions/:id/interactive`
  (or `/shell`) for a directory the user's own task named; `POST /api/v1/sessions/:id/input`;
  and `DELETE /api/v1/sessions/:id` **only** for a session you created in this
  conversation, by exact id. Keep a list of the ids you create. Everything else
  mutating needs the user to have asked for it.
- **Never call these** unless the user explicitly asked, naming the target:
  - `DELETE /api/cases/:name` recursively **deletes a real directory of the user's
    code** from disk. One wrong case name destroys work that was never yours.
  - `DELETE /api/sessions` (no id) is a **bulk kill of every session**, the user's
    real work included. `DELETE /api/subagents/:agentId` kills one background agent;
    `DELETE /api/subagents` (no id) does *not* kill anything, it clears the watcher's
    map and timers, which blinds every subagent surface in the UI until they are
    rediscovered. Neither is yours to call.
  - respawn / ralph / orchestrator / cron mutations: respawn runs `/clear` (wipes a
    conversation), orchestrator state is a single global slot, cron jobs outlive you.
  - `PUT /api/settings`, `POST /api/system/update`: global UI settings; server restart.
  - `POST /api/approvals/:id/answer`. It types a digit, an Esc or free text into
    whichever session raised the prompt. Approving another session's permission
    dialog authorizes a tool call the user never saw, from a session that is not
    yours. Answer only a prompt raised by a worker you created, and only when the
    user asked you to.
- **Never spawn a worker into the directory you are editing**, and give N workers N
  git worktrees rather than one shared checkout. Two agents in one working tree
  interleave writes and each reads the other's half-finished files; a `git checkout`
  in one yanks the tree out from under the other. Creating worktrees changes the
  user's repository state, so say that you did; **removing** one discards any
  uncommitted work inside it, so ask first ([§5.1](reference/verbs.md#51-where-to-spawn)).
- Never `tmux kill-session`, `pkill tmux`, `pkill claude`. The API is the only interface.
- Sessions count against a **global cap of 50** (and, in multi-user mode, a per-user
  cap of 25 that fires the same 409). Case creation is uncapped and writes real
  directories. Clean up every session you start, and never retry `quick-start` in a
  loop.

## 5. Recipes → [reference/verbs.md](reference/verbs.md)

The per-verb detail lives in [reference/verbs.md](reference/verbs.md), loaded on demand
so it is not paid for on every skill load. Section numbers and anchors are unchanged, so
a `§5.4` reference still resolves. **§1 already covers the common job without any of
these**; open the one row you actually hit.

| Open | When |
|------|------|
| [5.1 Where to spawn](reference/verbs.md#51-where-to-spawn) | the work is **not** a fresh scratch case: a linked case, a git worktree, any path that already existed. Hooks are absent there, which silently breaks send-and-wait. The costliest mistake in this skill |
| [5.2 Readiness](reference/verbs.md#52-readiness) | a worker never drew its composer, or you need the trust-dialog ladder by hand |
| [5.3 Send a task and wait](reference/verbs.md#53-send-a-task-and-wait) | the `sendwait` body, its signals, and the duplicate-resend loop |
| [5.4 Read the answer](reference/verbs.md#54-read-the-answer) | `last_text` came back empty, or the mode is not claude/codex |
| [5.5 Markers for hook-less workers](reference/verbs.md#55-markers-for-hook-less-workers) | the worker has no `stop` hook: synchronize on a split, unique printed marker |
| [5.6 Alive and stuck](reference/verbs.md#56-alive-and-stuck) | is it dead or just slow? `status` and `pid` both lie |
| [5.7 Interrupt without destroying](reference/verbs.md#57-interrupt-without-destroying) | a runaway worker you want to stop but keep |
| [5.8 Usage limits](reference/verbs.md#58-usage-limits) | a worker halted on a subscription limit |
| [5.9 Big input via the workspace](reference/verbs.md#59-big-input-via-the-workspace) | the prompt is larger than one composer line |
| [5.10 Fan out](reference/verbs.md#510-fan-out) | many workers at once: waiter caps, and why signals are edge-triggered |
| [5.11 List and find yourself](reference/verbs.md#511-list-and-find-yourself) | enumerate sessions, or match `$SELF` by prefix |
| [5.12 Read My Mind](reference/verbs.md#512-read-my-mind) | read or record what the user wants for a case |
| [5.13 Messaging claude workers](reference/verbs.md#513-messaging-claude-workers) | `ListAgents` / `SendMessage` instead of the HTTP path |
| [5.14 Clean up](reference/verbs.md#514-clean-up) | what deleting a session does **not** remove |

## 6. Setup and auth

You need this section only when the API answers something `jq` cannot parse, or when
you are on a server old enough to lack the wait endpoints. Endpoint-level detail lives
in [endpoints.md](reference/endpoints.md#auth-and-credentials).

### Credentials

Auth is active only when the server has `CODEMAN_PASSWORD` (or is in multi-user mode).
**Your session has usually inherited that password already**, which is why the §0
preamble tries `$CODEMAN_PASSWORD` first: Codeman does not strip it. `buildClaudeEnv()`
(`src/session-cli-builder.ts`) spreads the server's entire `process.env` into the
session and deletes only `COLORTERM` and `CLAUDECODE`, and the tmux spawn path applies
no denylist either. On a stock password-protected install (`install.sh` writes the
password into the systemd unit or launchd plist, so the server process carries it) the
value is simply in your environment.

It is not guaranteed, though, which is what the fallbacks are for. A tmux pane
inherits the **tmux server's** environment, and that server can predate the password;
and the data dir's `.env` is only ever read by the `codeman` CLI itself, never loaded
into the web server's environment.

Fallback 1, in the §0 preamble already: the data dir's `.env`, the same file
`codeman attach` reads. It is hand-authored; nothing ever writes it.

Fallback 2, for a stock install where the supervisor definition is the only copy on
disk. Append this to the preamble file (before its version-stamp line) and re-source:

```bash
if [ -z "${CODEMAN_PASSWORD:-}" ]; then    # install.sh puts it in the service definition
  UNIT="$HOME/.config/systemd/user/codeman-web.service"
  PLIST="$HOME/Library/LaunchAgents/com.codeman.web.plist"
  if [ -f "$UNIT" ]; then
    # install.sh backslash-escapes " and \ in the unit value; undo it or a password
    # containing either recovers wrong and auth fails.
    CODEMAN_PASSWORD=$(sed -n 's/^Environment="CODEMAN_PASSWORD=\(.*\)"$/\1/p' "$UNIT" | head -1 | sed 's/\\\(["\\]\)/\1/g')
  elif [ -f "$PLIST" ]; then
    # install.sh XML-escapes the plist value; undo it (&amp; LAST, mirroring escape order).
    CODEMAN_PASSWORD=$(awk '/<key>CODEMAN_PASSWORD<\/key>/{getline; print}' "$PLIST" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p' \
      | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g')
  fi
fi
```

⚠️ **A 401 is plain text, not the JSON envelope**, so on a password-protected server
every `jq` in these recipes dies with `jq: parse error` instead of showing
`UNAUTHORIZED`. If that happens, check the status with `-w '%{http_code}'`; if it is
401 and no fallback found a credential, **stop and tell the user you need
credentials**. The same is true of the guards that run before any handler: the Host
allowlist (`403 Forbidden: host not allowed`), the Origin/CSRF guard, and the auth
rate limiter's 429 all answer in plain text. The hook-secret bypass covers only
`/api/hook-event` and `/api/status-telemetry`, never session control.

In multi-user mode accounts live in `users.json` and the credential is a real user's
name and password. A recovered `CODEMAN_PASSWORD` still often works: `bootstrapInitialAdmin()`
(`user-store.ts:417-427`) creates the FIRST admin from `CODEMAN_USERNAME`/`CODEMAN_PASSWORD`
on first boot when no users exist, so on a stock multi-user install that pair usually IS
a valid admin login until someone changes it. Try it once; if it fails, ask the user
rather than retrying (ten failures rate-limit the address).

### Server version

The wait endpoints first ship in Codeman **1.13.0**, but do not gate on the version
number: a dev build can serve them while reporting an older version. Probe instead.
`GET .../wait` on a real session id answering 404 with an `.error` starting `Route `
means the server predates them (fall back to polling `GET .../terminal?tail=` and say
so). `Session ... not found` means your session id is wrong, not the server.

### Where the API is unreachable

- **Remote-SSH cases** do not export `CODEMAN_MUX`/`CODEMAN_API_URL` into the session,
  so the §0 guard fails closed and you refuse to act. That is correct behavior, not a
  bug to work around.
- **Inside a Docker case**, a loopback-bound server is unreachable from the container,
  and `CODEMAN_DOCKER_BRIDGE_HOOKS=1` does not fix it: that opens a hooks-only
  listener, so hook events flow but `/api/v1/*` stays refused. Report it rather than
  retrying; making it reachable is an operator decision.

Everything else (endpoint tables, per-mode signal table, error codes, capacity limits,
Docker/remote caveats): [reference/endpoints.md](reference/endpoints.md). Fan-out
orchestration and blocked-worker handling: [reference/recipes.md](reference/recipes.md).
