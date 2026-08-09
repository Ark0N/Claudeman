# Read My Mind

Codeman's per-case memory of what you are trying to accomplish. Each case gets an **intent profile**: a freeform `goals` text (written by you or your agent) plus the prompts you actually submitted, captured automatically while the feature is on. Phase 1 (this document) ships the profile itself, its API, and the agent-skill verbs. Phase 2 adds the 🧠 button that turns the profile into a predicted next prompt you can accept, edit, or rethink; the design for that lives in [`readmymind-plan.md`](readmymind-plan.md). Nothing is ever sent to a session automatically, in any phase.

## What it does today (phase 1)

- Captures the prompts you submit in Claude sessions into a per-case history (50 most recent, bounded).
- Lets you (or your agent) record explicit goals per case.
- Exposes the profile over the HTTP API, and to agents through the `codeman` skill, so an agent can ground its work in what you actually want instead of guessing from the last screenful.

## Turning it on

The synced setting `readMyMindEnabled` (default **OFF**) gates capture. There is no App Settings checkbox yet (that arrives with the phase-2 UI), so flip it over the API:

```bash
curl -sk -X PUT https://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"readMyMindEnabled": true}'
```

Add `-u user:password` if your install has `CODEMAN_PASSWORD` set, and drop `-k`/use `http://` for a plain-HTTP dev server. Turning it OFF stops capture immediately; existing profiles stay until you delete them (below).

## What gets captured, exactly

Capture reads the Claude session transcript, not your keystrokes: when a user turn lands in the transcript, its text is folded into the case's profile. Filters applied on the way in:

- **Claude-mode sessions only.** Shell, OpenCode, Codex, Gemini, and Antigravity sessions are never captured (they have no transcript watcher).
- Tool results, local slash-command echo (`/model` and friends), system wrappers, and interrupt markers are skipped.
- Entries shorter than 3 characters are skipped (menu digits, Esc artifacts).
- Consecutive duplicates collapse (auto-resume's "continue" spam counts once per run).
- Each prompt is stored as one line, truncated to 500 characters; the history caps at 50 prompts FIFO.

Because the transcript path arrives via Claude Code hooks, capture needs hooks to reach the server, the same condition as hook-based idle detection. Docker cases against a loopback-only server need `CODEMAN_DOCKER_BRIDGE_HOOKS=1`; remote-SSH cases do not capture.

## What is never captured

- Anything while `readMyMindEnabled` is OFF (capture is not retroactive).
- Terminal output, keystrokes, passwords typed into shells: only submitted Claude prompts are read.
- Nothing leaves the machine, and profiles are never fed into `/api/search`.

## Where it lives, and how to wipe it

Profiles live in `~/.codeman/intents.json`, written atomically at mode 0600 (captured prompts can contain secrets). The file is per Codeman instance. Keys derive from owner + the case's resolved working directory, so profiles survive `/clear`, respawn cycles, and session churn, and in multi-user mode two owners of the same directory get separate profiles.

Forget one case: `DELETE /api/sessions/:id/intent` (below). Forget everything: stop the server and delete `~/.codeman/intents.json`.

## The API

Three endpoints, session-scoped so ownership is enforced by the session itself (`/api/v1/` aliases work too; full spec in [`api-reference.md`](api-reference.md)):

```bash
# Read the profile for a session's case
curl -sk https://localhost:3000/api/sessions/$SID/intent | jq '.data.intent'

# Record goals (REPLACES the text: read + merge if you want to append)
curl -sk -X PUT https://localhost:3000/api/sessions/$SID/intent \
  -H 'Content-Type: application/json' \
  -d '{"goals":"ship 1.17; then mobile polish"}'

# Forget the case
curl -sk -X DELETE https://localhost:3000/api/sessions/$SID/intent
```

A case with nothing recorded answers an empty profile with `updatedAt: 0`; reads never persist anything. Goals cap at 8192 characters and the schema is strict, so unknown fields or over-long goals answer `400 INVALID_INPUT`. A session you do not own answers `404 NOT_FOUND`, indistinguishable from a nonexistent one.

## For agents (the skill)

The `codeman` agent skill documents the same three verbs (SKILL.md §3 plus `reference/endpoints.md`), with the ground rules: read the profile to understand what the user wants, record goals the user actually stated, merge instead of blind-writing (PUT replaces), and never delete a profile unprompted. It is the user's memory, not the agent's.

## What phase 2 adds

The 🧠 button and the predictor: a context assembler feeds the profile, the last assistant turn, tool activity, git state, away context, and any pending approval dialog to a one-shot opus call, and the suggested next prompt appears in an approval dialog (Send / Insert to edit / Rethink with a steer note / Dismiss). See [`readmymind-plan.md`](readmymind-plan.md) for the full design, including the trust-tier rules that keep terminal output from steering suggestions.

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| Profile stays empty although I am prompting | `readMyMindEnabled` was OFF at the time (capture is not retroactive), the session is not claude-mode, or hooks are not reaching the server (Docker case on a loopback bind without `CODEMAN_DOCKER_BRIDGE_HOOKS=1`, or a remote-SSH case) |
| Short answers I typed are missing | Entries under 3 characters are filtered by design (menu digits, Esc artifacts) |
| My goals text vanished after an agent wrote to it | PUT replaces the whole text; the skill tells agents to read + merge, but a blind write wins. Re-state the goals; consider phrasing them in the session so capture keeps the evidence |
| Two profiles for what I think is one case | Different owners in multi-user mode, or genuinely different directories; paths are realpath-resolved, so symlink spellings converge but distinct checkouts do not |
| `400 INVALID_INPUT` on PUT | Goals over 8192 chars, or an extra field in the body (strict schema) |

## Where the code lives

`src/intent-store.ts` (store + pure helpers, singleton), the `transcript:user_prompt` event in `src/transcript-watcher.ts`, capture wiring in `src/web/server.ts` (`captureIntentPrompt`), routes in `src/web/routes/readmymind-routes.ts`, schema in `src/web/schemas.ts`. Tests: `test/intent-store.test.ts`, `test/routes/readmymind-routes.test.ts`, and the capture cases in `test/transcript-watcher.test.ts`.
