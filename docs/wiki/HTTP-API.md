# HTTP API

Codeman's HTTP and SSE API is a **stable contract**. Everything the dashboard does goes
through it, so anything the dashboard can do, a script can do.

This page is the orientation. The complete specification, including every wait semantic and
the SSE catalogue, is
[`docs/api-reference.md`](https://github.com/Ark0N/Codeman/blob/master/docs/api-reference.md).

## What is stable

Covered by semantic versioning: endpoint paths under `/api/v1`, the response envelope,
`errorCode` values, and SSE event names.

Not covered, and free to change in a patch release: on-disk state files, internal modules,
and anything marked experimental. The full statement is in
[Versioning](Versioning).

`/api/v1/*` is a versioned alias of `/api/*`. Prefer the versioned form in anything you
intend to keep.

## The envelope

```json
{ "success": true, "data": { } }
```

```json
{ "success": false, "error": "human readable", "errorCode": "NOT_FOUND" }
```

A few legacy GET handlers return bare bodies rather than the envelope, so a robust client
reads `body.data ?? body`.

Branch on `errorCode`, which is stable. The HTTP status is reliable too:

| `errorCode`        | HTTP | Meaning                                          |
| ------------------ | ---- | ------------------------------------------------ |
| `INVALID_INPUT`    | 400  | Malformed request or failed validation.           |
| `UNAUTHORIZED`     | 401  | Authentication required or failed.                |
| `NOT_FOUND`        | 404  | No such resource.                                 |
| `SESSION_BUSY`     | 409  | The session is busy.                              |
| `CONFLICT`         | 409  | Conflicts with current state.                     |
| `ALREADY_EXISTS`   | 409  | Resource already exists.                          |
| `OPERATION_FAILED` | 422  | Well formed, could not be completed.              |
| `RATE_LIMITED`     | 429  | Too many requests.                                |
| `INTERNAL_ERROR`   | 500  | Unexpected server error.                          |

New error codes are non-breaking. Removing or renaming one is a major change.

**A `401` is the bare string `Unauthorized`, not the envelope.** Piping it into `jq` throws
a parse error rather than showing the failure, so check the status first.

## Authentication

With no password set, and the default loopback bind, there is none. With `CODEMAN_PASSWORD`
set, use HTTP Basic or the session cookie:

```bash
curl -s -u admin:"$CODEMAN_PASSWORD" "$API/api/sessions"
```

A **missing** `Origin` header is allowed, so curl and CLI tools work unchanged. A
present-but-foreign origin is rejected by the CSRF guard. On an HTTPS install with the
self-signed certificate, add `-k`.

## Endpoint map

Roughly 200 handlers across 24 route modules. By domain:

| Domain              | Handlers | Covers                                              |
| ------------------- | -------- | --------------------------------------------------- |
| System              | 45       | Status, settings, search, digest, updates.           |
| Sessions            | 34       | Create, input, terminal, wait, kill.                 |
| Cases               | 29       | Create, link, clone, remote and docker cases.        |
| Files               | 16       | Preview, edit, raw, attachments, path picker.        |
| Orchestrator        | 10       | Plans and phases.                                     |
| Ralph               | 9        | Loop control and configuration.                       |
| Cron                | 9        | Jobs and run history.                                 |
| Admin               | 8        | Multi-user administration.                            |
| Plan                | 8        | Plan orchestration.                                   |
| Respawn             | 7        | Respawn configuration and presets.                    |
| Webviews            | 6        | Saved dashboards, plus the proxy.                     |
| Mux                 | 5        | tmux operations.                                      |
| Push                | 4        | Web push subscriptions.                               |
| Read My Mind        | 4        | Intent profiles and prediction.                       |
| Scheduled           | 4        | The legacy scheduled-run concept.                     |
| Approvals           | 3        | The inbox and answering.                              |
| Teams, me, search, hooks, clipboard, telemetry, voice, ws | 1-2 each | |

Each route module documents its own endpoints in its file header.

## Long-polling instead of polling

Three calls block until something happens, so an agent driving Codeman from a shell can wait
rather than spin:

| Call                                      | Blocks until                                             |
| ----------------------------------------- | -------------------------------------------------------- |
| `GET /api/v1/sessions/:id/wait`           | One of a set of lifecycle signals fires.                  |
| `GET /api/v1/sessions/:id/wait-output`    | A literal string appears in the session's output.         |
| `POST /api/v1/sessions/:id/input` + `wait`| The input is delivered **and then** a signal fires.       |

Three semantics that break callers who assume otherwise:

1. **A timeout is `200`, not an error.** It answers with `wait.timedOut: true`. Loop over
   short waits; a single long call gets cut by tunnels and proxies.
2. **Send-and-wait is not a POST followed by a wait.** It registers the waiter *before*
   writing, which closes the window where a separate wait sees the session still idle from
   the previous turn and answers instantly about the wrong turn.
3. **Signals are edge triggered with no history.** One that fires with no waiter registered
   is unobservable afterwards. Fan-outs must register their waits as they dispatch.

`wait-output` matches a **literal substring, never a regex.** That is deliberate: no regex
means no catastrophic backtracking on attacker-influenced output.

Only `claude` sessions emit `stop` and `blocked`, because those come from Claude Code hooks.
Shell and external CLI sessions accept `idle`, `working`, and `exit`.

## SSE

`GET /api/events` is the live event stream. 155 event names, kept in sync between server and
client with a test that fails on drift.

The heartbeat is a **named** `sse:heartbeat` event rather than an SSE comment, because
comments are invisible to `EventSource` by specification and a client could not observe
them. That is what lets the browser detect a stream that has silently stopped delivering.

```js
const es = new EventSource('/api/events');
es.addEventListener('session:created', (e) => console.log(JSON.parse(e.data)));
```

## Quick examples

```bash
API="${CODEMAN_API_URL:-http://localhost:3000}"

curl -s "$API/api/status" | jq                     # whole-system snapshot
curl -s "$API/api/sessions" | jq '.data[].name'    # live sessions
curl -s "$API/api/sessions/unified" | jq           # live + historical, deduped
curl -s "$API/api/subagents" | jq                  # background agents
curl -s "$API/api/search?q=deploy" | jq            # cross-session search
```

## Limits

| Limit                 | Default                                    |
| --------------------- | ------------------------------------------ |
| Max sessions          | 50                                          |
| Max agent windows     | 500                                         |
| Max SSE clients       | 100                                         |
| Terminal buffer       | 32 MB per session                           |
| Text payload          | 1 MB                                        |
| Wait timeout ceiling  | 600 s, and the response tells you what was applied |

Most are environment-overridable. See `src/config/`.

## Read next

- [Driving Codeman From An Agent](Driving-Codeman-From-An-Agent) - the practical version, with recipes.
- [Hooks And Integrations](Hooks-And-Integrations) - events flowing back into Codeman.
- [Versioning](Versioning) - what the version number promises.
- [`docs/api-reference.md`](https://github.com/Ark0N/Codeman/blob/master/docs/api-reference.md) - the full specification.
