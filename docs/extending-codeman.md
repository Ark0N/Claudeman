# Extending Codeman

Codeman has no plugin runtime, and that is a deliberate choice rather than a
missing feature. A plugin runtime means running third-party code inside a process
that spawns agents with your credentials, on a server people routinely expose
over a tunnel or Tailscale. Codeman's security model is one of its reasons to
exist, so it does not hand that away for an extension mechanism.

Instead there are four seams that already work, from any language, with nothing
installed:

| You want to | Use | Runs where |
| --- | --- | --- |
| Show your own UI inside Codeman | [Web tabs](#seam-1-web-tabs) | Your own process, rendered as a tab |
| React when an agent needs you | [SSE events](#seam-2-sse-events) | Anywhere that can hold an HTTP connection |
| Drive Codeman from a script | [HTTP API](#seam-3-http-api-and-cli) or the `codeman` CLI | Anywhere |
| React inside a Claude session | [Hooks](#seam-4-hooks) | The agent's own machine |

Everything below is covered by the stability promise in
[`versioning-policy.md`](versioning-policy.md): endpoint paths, the response
envelope, `errorCode` values, and SSE event names are stable. Additive changes
(new endpoints, new optional fields, new events) are non-breaking. Breaking
changes ship under a new prefix (`/api/v2`).

## Before you start

**Base URL.** `http://127.0.0.1:3000` by default. Prefer the versioned prefix
`/api/v1/...` for anything you publish; the unversioned `/api/...` is an alias.

**Auth.** If `CODEMAN_PASSWORD` is set, send HTTP Basic on every request, or
authenticate once and keep the `codeman_session` cookie. With no password set,
Codeman is loopback-only and unauthenticated.

```bash
curl -u admin:$CODEMAN_PASSWORD http://127.0.0.1:3000/api/v1/sessions
```

**Envelope.** Every response is `{"success": true, "data": ...}` or
`{"success": false, "error": "...", "errorCode": "..."}`. Check the HTTP status
or `body.success`, then read `body.data`. The full `errorCode` to status mapping
is in [`api-reference.md`](api-reference.md).

⚠️ A few legacy GETs (`/api/away-digest` among them) return a bare-ish body with
the payload at the top level rather than under `data`. Read defensively with
`body.data ?? body`.

**Already driving Codeman from an agent?** The README's
[Programmatic Guide](../README.md#driving-codeman-from-an-agent--programmatic-guide)
covers the in-session case: the `CODEMAN_MUX`, `CODEMAN_API_URL`,
`CODEMAN_SESSION_ID` and `CODEMAN_HOOK_SECRET_FILE` variables that let a CLI
running inside Codeman find the API and avoid acting on itself. This page is for
code running *outside* a session.

## Seam 1: Web tabs

The highest-leverage seam. Any web app you can serve locally becomes a tab beside
your agent sessions. You write a normal web page; Codeman handles embedding it.

```bash
curl -u admin:$PASS -X POST http://127.0.0.1:3000/api/v1/webviews \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Dashboard","url":"http://127.0.0.1:8787","icon":"📊"}'
```

Fields: `name` (1 to 60 chars), `url`, and optionally `icon` (a single glyph, max
8 code units), `embedMode` (`proxy` by default, or `direct`), and `trusted`.

Related endpoints: `GET /api/v1/webviews`, `PATCH /api/v1/webviews/:id`,
`DELETE /api/v1/webviews/:id`, `POST /api/v1/webviews/probe` (reachability and
framing check), `POST /api/v1/webviews/:id/open`.

### Why it is proxied

By default your page is served through Codeman's own origin at `/webview/:cap/*`
rather than framed directly. A direct iframe fails three ways at once: production
is HTTPS so `http://` targets are blocked as mixed content, many dashboards send
`X-Frame-Options: DENY`, and Codeman's own `default-src 'self'` CSP blocks
cross-origin frames. Proxying solves all three without weakening the CSP.

### The two things that will confuse you

A proxied frame is sandboxed and therefore **opaque-origin** unless you set
`trusted: true`. Two consequences look like bugs in your own app:

1. **Root-absolute URLs built at runtime** (`/assets/x.png` assembled in JS)
   escape the injected `<base>` tag. Codeman injects a `runtimeUrlShim()` that
   patches the common DOM sinks, but if you construct URLs in an unusual way,
   prefer relative paths.
2. **Same-host `fetch` and `XHR` are CORS-checked with `Origin: null`.** Codeman
   handles this with `buildProxyCorsHeaders()`, and the proxy is exempt from the
   global `OPTIONS` short-circuit. If you see "Failed to fetch" while the page
   itself renders fine, this is the area to look at.

⚠️ `trusted: true` opts out of the sandbox. A proxied page is served from
Codeman's origin, so `allow-same-origin` lets it read the Codeman page and call
the API that spawns agents. Only mark your own trusted code.

## Seam 2: SSE events

`GET /api/v1/events` is a Server-Sent Events stream. Each message is
`event: <name>` plus `data: <json>`. There are 149 event names following a
`domain:action` convention, registered in `src/web/sse-events.ts`.

The ones most integrations want:

| Event | Meaning |
| --- | --- |
| `session:created`, `session:deleted` | A session appeared or went away |
| `session:idle` | The agent stopped working |
| `session:completion` | A completion message was detected |
| `session:exit`, `session:error` | The session ended or failed |
| `hook:permission_prompt` | The agent is asking for permission |
| `hook:idle_prompt`, `hook:stop` | The agent is waiting on you, or stopped |
| `hook:task_completed`, `task:completed` | Work finished |
| `subagent:discovered`, `subagent:completed` | Background agent lifecycle |
| `mux:died` | A multiplexer session died unexpectedly |
| `cron:runCreated`, `cron:runUpdated` | Scheduled job activity |

### Filtering

`?sessions=id1,id2` suppresses only the high-volume `session:terminal` stream for
sessions you did not list. Lifecycle and metadata events are always delivered, so
you cannot accidentally filter away the thing you are listening for.

Pass `?clientId=<uuid>` to enable live filter updates through
`POST /api/v1/events/subscribe` without reconnecting the stream.

### Example: notify when any agent needs you

```js
const res = await fetch('http://127.0.0.1:3000/api/v1/events', {
  headers: { Authorization: 'Basic ' + btoa(`admin:${process.env.CODEMAN_PASSWORD}`) },
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const WANTED = new Set(['hook:permission_prompt', 'hook:idle_prompt', 'session:idle']);

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const frames = buf.split('\n\n');
  buf = frames.pop() ?? '';
  for (const frame of frames) {
    const name = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    if (name && WANTED.has(name)) notify(name, JSON.parse(data ?? '{}'));
  }
}
```

## Seam 3: HTTP API and CLI

Around 199 handlers across 21 route files cover sessions, cases, files, cron,
respawn, Ralph, the orchestrator, search, and admin. Each route module carries an
`@fileoverview` describing its endpoints.

The common ones:

```bash
# List sessions (live + persisted + transcript history, deduped)
curl -u admin:$PASS http://127.0.0.1:3000/api/v1/sessions/unified

# Create a session
curl -u admin:$PASS -X POST http://127.0.0.1:3000/api/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"workingDir":"/home/me/project","mode":"claude"}'

# Send a prompt (single-line only)
curl -u admin:$PASS -X POST http://127.0.0.1:3000/api/v1/sessions/$ID/input \
  -H 'Content-Type: application/json' \
  -d '{"input":"run the tests","useMux":true}'
```

`POST .../input` also accepts `clientId` (stable per client, max 128 chars) and
`seq` (monotonic per session). Send both and the server applies each pair
at-most-once, so retrying after a dropped connection cannot type the prompt
twice. Omit them entirely rather than sending `null`.

For shell scripting, the `codeman` CLI is the same surface without the HTTP
plumbing:

```
codeman session start|stop|list|logs     codeman task add|list|status|remove|clear
codeman ralph start|stop|status|reset    codeman users add|passwd|list
codeman status | list | attach <path>    codeman doctor
```

## Seam 4: Hooks

Claude Code hooks post to `POST /api/v1/hook-event` from inside an agent session.
Codeman installs its own hooks automatically, but the endpoint is open to yours.

```json
{ "event": "task_completed", "sessionId": "abc123", "data": { "any": "json" } }
```

`event` must be one of `permission_prompt`, `elicitation_dialog`, `idle_prompt`,
`stop`, `teammate_idle`, `task_completed`. Each becomes the matching `hook:*` SSE
event.

⚠️ This endpoint skips Basic auth so hooks keep working, but when auth is active
the loopback bypass requires the `X-Codeman-Hook-Secret` header
(`~/.codeman/hook-secret`) unconditionally.

## Gotchas

Every one of these has cost somebody real time.

- **CORS is localhost-only.** `Access-Control-Allow-Origin` is echoed only for
  `localhost`, `127.0.0.1`, and `::1`. A browser app on any other origin cannot
  call the API. Integrate server-side.
- **A missing `Origin` header is allowed**, which is why curl, CLIs, and hooks
  work. Cross-site origins are blocked by the CSRF guard.
- **Reverse-proxy domains are rejected** by the anti-DNS-rebinding Host allowlist
  unless added via `CODEMAN_ALLOWED_HOSTS=host,.suffix`.
- **`null` is not `undefined`.** Request schemas use Zod `.optional()`, which
  accepts `undefined` only. `JSON.stringify({ field: null })` keeps the null on
  the wire and fails with `INVALID_INPUT`. Omit the key instead. This has caused
  shipped bugs more than once.
- **`text/plain` bodies stay raw.** Auto-parsing them as JSON enabled
  simple-request CSRF, so it is deliberate. Send `application/json`.
- **Prompts are single-line.** With `useMux: true` the server delivers your text
  and then Enter as two separate writes, so you do not append `\r` yourself. A
  multi-line string breaks the agent's Ink-based input handling: send one line,
  or split it across calls.
- **Unwrap the envelope** before reading fields. `data` is not the response body.

## Publishing your integration

There is no registry and no review queue. Add the GitHub topic
**`codeman-integration`** to your public repository so others can find it, and
link back to Codeman in your README.

If a real ecosystem of these appears, a manifest format and an install command
become worth building. Until then, these four seams are the contract, and they
require nothing of you but HTTP.

## What Codeman deliberately does not have

- **No in-process plugin runtime.** See the reasoning at the top of this page.
- **No build or startup hooks** for third-party code. Run your own process.
- **No per-plugin config or state directories.** Manage your own files.
- **No sandbox for integration code**, because Codeman never launches it. Your
  integration is your own process, started by you, with your permissions,
  talking HTTP.

That last point is about integration code specifically, not about Codeman.
Sandboxing lives on a different axis here: the thing worth isolating is the
**agent**, and you isolate it per case with
[Docker cases](docker-cases.md), which run the agent in a hardened container with
a bind-mounted workspace and seeded (not shared) credentials. An integration that
creates or drives a Docker-backed session inherits that isolation for free, since
it is a property of the session rather than of the caller.
