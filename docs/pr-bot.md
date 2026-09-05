# PR bot: automatic pull-request reviews, reported over Telegram

The PR bot is maintainer tooling that lives in `scripts/pr-bot/`. It watches the
repository's open pull requests, reviews each one in a Codeman claude session running in
a private clone of the repository, and sends the verdict to a Telegram chat with the ranked
findings, a recommendation and action buttons. The maintainer decides what happens next
from the phone: merge, post the drafted review comment, close, approve a waiting CI run,
or ask the reviewer session a follow-up question.

It reviews on its own. It never writes to GitHub on its own.

## How a review runs

1. Every poll (default 10 minutes) the bot lists open PRs with `gh`. A PR is queued
   when its head commit differs from the one last reviewed, so a push re-reviews and an
   untouched PR is never reviewed twice. Draft PRs and bot PRs are skipped. The backlog
   is ordered mergeable-and-small first, conflicting-and-huge last.
2. The PR head is fetched into a private ref (`refs/pr-bot/<n>`) of the main repository
   and checked out (detached) in a private clone under
   `~/.codeman/pr-bot/worktrees/pr-<n>`, made with `git clone --shared` so the object
   store stays shared and nothing is duplicated. The maintainer's own checkout is never
   checked out or reset by the bot. A clone rather than a linked worktree because Claude
   Code reads a linked worktree's project settings from the MAIN checkout, whose model
   pin would silently override the bot's. `node_modules` is a symlink to the main
   checkout's tree when the PR itself leaves the dependency files untouched (judged
   against the PR's merge base, not against current master), and a real `npm ci`
   otherwise (the symlink is unlinked first, so npm can never write through it; an
   install interrupted by a restart is discarded, never reused).
3. A review brief is written to `~/.codeman/pr-bot/jobs/pr-<n>/brief.md`: the PR
   metadata, CI state, mergeability, the file list, the body verbatim, the ground rules
   (nothing reaches GitHub, no installs, no builds, no services, never port 3000), the
   review protocol (CLAUDE.md and CONTRIBUTING first, then correctness, security,
   invariants, tests, contract, scope), the checks to run, the verdict vocabulary and
   the exact JSON to produce.
4. A Codeman session named `prbot-<n>` is created in the clone over the HTTP API,
   the composer is awaited (the folder-trust dialog is read off the screen and answered
   one key at a time), and one prompt points the session at the brief. The bot waits on
   the `stop`/`blocked`/`exit` hook signals, never on the heuristic `idle`, with a hard
   timeout (default 40 minutes).
5. The session writes `report.json` and `report.md` next to the brief and replies
   `REVIEW COMPLETE`. The bot parses the JSON leniently, records the Claude session id
   for follow-ups, deletes the Codeman session, keeps the clone, and sends the
   summary to Telegram. Reviews run one at a time.

Verdicts: `merge`, `merge-with-fixes`, `request-changes`, `close`, `needs-discussion`.
Findings are ranked `blocker` / `major` / `minor` / `nit`, each with file and line.

## The Telegram side

Each review arrives as one message: PR number and title, author, size, CI state,
mergeability, the verdict with confidence, the summary, the top findings, the checks
that were run, the recommendation, and buttons:

| Button / command | What it does |
| --- | --- |
| 📄 Full report · `/report N` | Sends `report.md` (as a file when long). |
| 💬 Draft comment · `/draft N` | Shows the comment drafted for the contributor. Nothing is posted. |
| 📮 Post comment · `/post N` | Shows the draft again and asks for confirmation, then posts it under your GitHub account. |
| ✅ Merge · `/merge N` | Re-checks mergeability and CI, lists warnings (red CI, new commits since the review, a non-merge verdict), asks for confirmation, then merges with a merge commit. Refuses a conflicting PR. |
| 🗑 Close · `/close N reason` | Asks for the closing comment if none was given, asks for confirmation, then closes with that comment. |
| ▶️ Approve CI run · `/approve N` | Approves a workflow run that GitHub holds for a first-time contributor. Shown only when one is waiting. |
| 🔁 Re-review · `/review N` | Queues a fresh review at the front of the queue. |
| `/ask N question`, or reply to any review message | Resumes the reviewer's Claude conversation in the same clone and relays the answer. It can inspect, run checks, or make uncommitted changes there; it still never pushes. |
| `/status` · `/scan` · `/pause` · `/resume` · `/help` | Housekeeping. |

Merge, close and post always take a second tap. Confirmations expire after 15 minutes.
Only messages from the configured chat are acted on; anyone else gets silence.

When a PR is merged or closed, the bot announces it, removes the clone and the
private ref, and keeps the record.

## Setup

Requirements on the machine that runs the bot: a running Codeman (the sessions are
spawned there), `gh` logged in as the account that should merge and comment, `git`,
Node 22, and the repository checkout with its `node_modules`.

Config is `~/.codeman/pr-bot.env` (`KEY=VALUE`, keep it mode 0600). The Telegram token
and chat id are read from the existing notifier bot's env file
(`~/codeman-cases/telegram/.env`) when present, so on the maintainer's machine no key
has to be copied; set them here to use a different bot.

| Key | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | from the shared env file | BotFather token. |
| `TELEGRAM_CHAT_ID` | from the shared env file | The one chat that receives reports and may issue commands. |
| `GITHUB_REPO` | `Ark0N/Codeman` | `owner/name`. |
| `CODEMAN_API_URL` | `https://127.0.0.1:3000` | The Codeman that spawns the review sessions. A self-signed certificate is accepted. |
| `CODEMAN_USERNAME` / `CODEMAN_PASSWORD` | unset | Only when that Codeman has a password. |
| `PR_BOT_POLL_INTERVAL` | `600` | Seconds between GitHub polls (minimum 60). |
| `PR_BOT_MAIN_CHECKOUT` | the repo this script is in | The repository the clones share objects with and fetch from. |
| `PR_BOT_DATA_DIR` | `~/.codeman/pr-bot` | State, briefs, reports, clones. |
| `PR_BOT_MODEL` | unset (the session default) | Codeman `modelOverride` for the review sessions, e.g. `claude-fable-5-1`. |
| `PR_BOT_EFFORT` | unset | Codeman `effort` for the review sessions. |
| `PR_BOT_REVIEW_TIMEOUT` | `40` | Minutes before a review is abandoned. |
| `PR_BOT_FOLLOWUP_TIMEOUT` | `20` | Minutes before a follow-up is abandoned. |
| `PR_BOT_AUTO_REVIEW` | `1` | `0` reviews only on `/review N`. |
| `PR_BOT_REVIEW_DRAFTS` | `0` | `1` reviews draft PRs too. |
| `PR_BOT_TELEGRAM_ENV_FILE` | `~/codeman-cases/telegram/.env` | Where the shared token and chat id are read from. |

```bash
npm run pr-bot -- check              # config, gh, git, Codeman, Telegram, open PR count
npm run pr-bot -- scan               # the open PRs in review order, with what is new
npm run pr-bot -- review 383 --no-telegram   # one review now, printed instead of sent
npm run pr-bot -- run                # the daemon
npm run pr-bot -- install-service    # systemd user unit codeman-pr-bot, enabled and started
npm run pr-bot -- status             # what the state file knows
tail -f ~/.codeman/pr-bot/bot.log    # the service logs to a file, not the journal
```

## Safety properties worth knowing before changing it

- **GitHub writes happen in exactly one place** (`runConfirmed` in `bot.ts`) and only
  after a confirmation tap on a nonce that expires. The review session's brief forbids
  `gh` writes, pushes and merges, and the session has no reason to have the token
  anyway: it runs as the same user as the maintainer's own sessions, so the prompt rule
  is the guard, and the clone's checkout is detached so an accidental push has no
  branch to land on.
- **The maintainer's checkout is shared with other agent sessions**, so the bot never
  runs `git checkout`, `reset`, `stash` or `clean` there. It only fetches into
  `refs/pr-bot/*` there; everything else happens inside the per-PR clone.
- **The clones are `git clone --shared`.** Their objects live in the main checkout, so
  the `refs/pr-bot/<n>` ref there is what keeps a PR's commits safe from `git gc`; it
  is deleted together with the clone when the PR closes.
- **`node_modules` may be a symlink into the live checkout.** The brief forbids
  installs, and `worktree.ts` unlinks the symlink before any `npm ci`. `src/web/public/vendor`
  is copied per file, never linked, because postinstall regenerates it in place.
- **Sessions are named `prbot-<n>`** and tracked by id; the bot deletes only those, on
  completion, on shutdown, and (by name) as a sweep at startup after a crash. It never
  touches the maintainer's `w<n>-*` sessions.
- **Readiness and end-of-turn follow the codeman skill's rules**: composer first
  (`shift+tab` in the pane), trust dialog read from the screen, `stop,blocked,exit`
  signals rather than `idle`. A session that asks a question is reported as a failed
  review with the pane's last lines, not left hanging.
- **Telegram input is data.** Command parsing is a fixed grammar; free text is only ever
  relayed to a reviewer session as the maintainer's own follow-up, or used as a closing
  comment after confirmation.

Tests: `test/pr-bot-report.test.ts` (parsing, formatting, CI classification, command
grammar, trust-dialog reader, config), `test/pr-bot-state.test.ts`, and
`test/pr-bot-commands.test.ts` (the command and confirmation flows against a stubbed
`gh` and Telegram: a GitHub write happens once, after the tap, never for a foreign chat
or a reused nonce). Type-checked by
`npm run typecheck` through `config/tsconfig.pr-bot.json`, linted and formatted with
the main sources.
