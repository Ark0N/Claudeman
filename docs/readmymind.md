# Read My Mind

Codeman's per-case memory of what you are trying to accomplish, and the 🧠 button that turns it into a predicted next prompt. Each case gets an **intent profile**: a freeform `goals` text (written by you or your agent) plus the prompts you actually submitted, captured automatically while the feature is on. Pressing 🧠 feeds that profile and the live session signals to a one-shot model call and shows the predicted prompt for you to send, edit, or rethink. Nothing is ever sent to a session automatically. Design doc: [`readmymind-plan.md`](readmymind-plan.md).

## What it does

- Captures the prompts you submit in Claude sessions into a per-case history (50 most recent, bounded).
- Lets you (or your agent) record explicit goals per case.
- Predicts your next prompt on demand (the 🧠 header button, or `POST .../readmymind` for agents): the suggestion arrives in a modal with Send / Insert / Rethink / Dismiss.
- Exposes the profile over the HTTP API, and to agents through the `codeman` skill, so an agent can ground its work in what you actually want instead of guessing from the last screenful.

## Turning it on

App Settings → Header & Panels → Cross-session features → **Read My Mind** (synced setting `readMyMindEnabled`, default **OFF**). It gates everything: capture, the header button, and nothing shows anywhere while it is off. The API equivalent:

```bash
curl -sk -X PUT https://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"readMyMindEnabled": true}'
```

Add `-u user:password` if your install has `CODEMAN_PASSWORD` set, and drop `-k`/use `http://` for a plain-HTTP dev server. Turning it OFF stops capture immediately; existing profiles stay until you delete them (below).

## The 🧠 button

On a Claude session, press the brain button in the header (desktop) or the 🧠 key on the keyboard accessory bar (phones and tablets; it appears when the setting is on). Codeman assembles everything it already knows: your goals, your recent prompts (with your voice: length, tone, shorthand), the tail of the last assistant reply, recent tool activity, git state (branch, dirty files, pending changesets), how long you have been away and what happened meanwhile, sibling sessions in the same case, and any dialog the session is currently waiting on. A one-shot model call (opus by default, `readMyMindModel` to override) turns that into 1-3 suggestions; the top one lands in an editable field with its rationale, and the others render as tappable alternate rows: tap one to swap it into the field (edits you already made are kept on the row you leave).

- **Send** submits it to the session (with Enter).
- **Insert** drops it on the CLI composer *without* Enter, so you can edit it in the terminal before sending.
- **Rethink** re-runs with everything shown (the field and the alternates) recorded as rejected. An optional steer note below the suggestions ("no, I meant the mobile bug") rides along as your own words, the highest-authority signal the predictor gets; it stays in the field across re-runs until you clear it or reopen the modal.
- **Dismiss** closes; nothing happens.

A prediction takes 5-90 seconds and costs real tokens; one runs per session at a time. If the session is sitting on a permission/question dialog, the suggestion is usually an answer to that dialog: that is intentional.

**Security note**: the prediction reads observable content (assistant output, tool logs, git output) which a hostile repo could try to steer. The predictor is told user-stated intent outranks anything observed, and, more importantly, a suggestion is only ever *proposed*: your click is the boundary. No auto-send path exists, including for agents.

## What gets captured, exactly

Capture reads the Claude session transcript, not your keystrokes: when a user turn lands in the transcript, its text is folded into the case's profile. Filters applied on the way in:

- **Claude-mode sessions only.** Shell, OpenCode, Codex, Gemini, Antigravity, and Pi sessions are never captured (they have no transcript watcher).
- Tool results, local slash-command echo (`/model` and friends), system wrappers, and interrupt markers are skipped.
- Entries shorter than 3 characters are skipped (menu digits, Esc artifacts).
- Consecutive duplicates collapse (auto-resume's "continue" spam counts once per run).
- Each prompt is stored as one line, truncated to 500 characters; the history caps at 50 prompts FIFO.

Because the transcript path arrives via Claude Code hooks, capture needs hooks to reach the server, the same condition as hook-based idle detection. Docker cases against a loopback-only server need `CODEMAN_DOCKER_BRIDGE_HOOKS=1`; remote-SSH cases do not capture.

## What is never captured

- Anything while `readMyMindEnabled` is OFF (capture is not retroactive).
- Terminal output, keystrokes, passwords typed into shells: only submitted Claude prompts are read.
- Nothing leaves the machine beyond the model call you explicitly trigger, and profiles are never fed into `/api/search`.

## Where it lives, and how to wipe it

Profiles live in `~/.codeman/intents.json`, written atomically at mode 0600 (captured prompts can contain secrets). The file is per Codeman instance. Keys derive from owner + the case's resolved working directory, so profiles survive `/clear`, respawn cycles, and session churn, and in multi-user mode two owners of the same directory get separate profiles.

Forget one case: `DELETE /api/sessions/:id/intent` (below). Forget everything: stop the server and delete `~/.codeman/intents.json`.

## The API

Four endpoints, session-scoped so ownership is enforced by the session itself (`/api/v1/` aliases work too; full spec in [`api-reference.md`](api-reference.md)):

```bash
# Read the profile for a session's case
curl -sk https://localhost:3000/api/sessions/$SID/intent | jq '.data.intent'

# Record goals (REPLACES the text: read + merge if you want to append)
curl -sk -X PUT https://localhost:3000/api/sessions/$SID/intent \
  -H 'Content-Type: application/json' \
  -d '{"goals":"ship 1.17; then mobile polish"}'

# Forget the case
curl -sk -X DELETE https://localhost:3000/api/sessions/$SID/intent

# Predict the next prompt (claude-mode only; takes 5-90 s)
curl -sk -X POST https://localhost:3000/api/sessions/$SID/readmymind \
  -H 'Content-Type: application/json' -d '{}' | jq '.data.suggestions'
```

A case with nothing recorded answers an empty profile with `updatedAt: 0`; reads never persist anything. Goals cap at 8192 characters and the schema is strict, so unknown fields or over-long goals answer `400 INVALID_INPUT`. A session you do not own answers `404 NOT_FOUND`, indistinguishable from a nonexistent one. Predict answers `{ suggestions: [{ prompt, why, kind }], durationMs }` (`kind`: `continue` / `verify` / `redirect`), `409 CONFLICT` while one is already running, `400 INVALID_INPUT` on non-claude sessions, and `502 OPERATION_FAILED` when the model produced no usable JSON. The rethink flow passes `{"steer":"…","rejected":["…"]}`.

## For agents (the skill)

The `codeman` agent skill documents the same verbs (SKILL.md §3 plus `reference/endpoints.md`), with the ground rules: read the profile to understand what the user wants, record goals the user actually stated, merge instead of blind-writing (PUT replaces), never delete a profile unprompted, and never send a predicted suggestion into a session unless the user asked. It is the user's memory, not the agent's.

## What comes next

Explicitly later: proactive predict-on-idle, auto-compaction of the prompt history into goals, non-Claude capture. See the phases section of [`readmymind-plan.md`](readmymind-plan.md).

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| No 🧠 button in the header | `readMyMindEnabled` is OFF (App Settings → Header & Panels → Cross-session features), you are on a phone (there it is a key on the keyboard accessory bar instead, visible while typing), or the active session is not claude-mode |
| Prediction feels generic | The profile is thin: record goals (PUT or ask your agent to), and let capture accumulate a few real prompts first |
| "A prediction is already running" (409) | One per session at a time; wait for the current one (up to 90 s) |
| Prediction fails (502) | The model returned no usable JSON, or the CLI could not start; retry. Check `readMyMindModel` if you overrode it |
| Profile stays empty although I am prompting | `readMyMindEnabled` was OFF at the time (capture is not retroactive), the session is not claude-mode, or hooks are not reaching the server (Docker case on a loopback bind without `CODEMAN_DOCKER_BRIDGE_HOOKS=1`, or a remote-SSH case) |
| Short answers I typed are missing | Entries under 3 characters are filtered by design (menu digits, Esc artifacts) |
| My goals text vanished after an agent wrote to it | PUT replaces the whole text; the skill tells agents to read + merge, but a blind write wins. Re-state the goals; consider phrasing them in the session so capture keeps the evidence |
| Two profiles for what I think is one case | Different owners in multi-user mode, or genuinely different directories; paths are realpath-resolved, so symlink spellings converge but distinct checkouts do not |
| `400 INVALID_INPUT` on PUT | Goals over 8192 chars, or an extra field in the body (strict schema) |

## Where the code lives

`src/intent-store.ts` (store + pure helpers, singleton), the `transcript:user_prompt` event in `src/transcript-watcher.ts`, capture wiring in `src/web/server.ts` (`captureIntentPrompt`), context assembly in `src/readmymind-context.ts` (pure) + `src/readmymind-collectors.ts` (transcript tail + git IO), the predictor in `src/readmymind-predictor.ts`, routes in `src/web/routes/readmymind-routes.ts`, schemas in `src/web/schemas.ts`, frontend in `src/web/public/readmymind-ui.js`. Tests: `test/intent-store.test.ts`, `test/readmymind-context.test.ts`, `test/readmymind-collectors.test.ts`, `test/readmymind-predictor.test.ts`, `test/routes/readmymind-routes.test.ts`, and the capture cases in `test/transcript-watcher.test.ts`.
