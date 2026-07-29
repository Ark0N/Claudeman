# Web Tabs (dashboards as Codeman tabs)

Open any dashboard you run, Grafana, Uptime Kuma, Portainer, a status page on port
4000, as a tab beside your Claude/Codex/Gemini sessions. Codeman becomes one mission
control instead of Codeman plus a pile of browser tabs.

## Using it

1. Click the chevron next to **Run** to expand the dropdown.
2. Under **Web / URL**, pick **Add dashboard...**
3. Give it a name and a URL, optionally hit **Test**, then **Save**.

The dashboard opens as a tab immediately, and appears in the Run dropdown from then
on. Web tabs sit in the same strip as session tabs, continue the same `Alt+1..9`
numbering, and carry a globe icon so they never read as a running agent.

Closing a tab (the `x`) only closes it. The saved dashboard stays in the dropdown.
To delete it for good, use the `x` on its **dropdown row** (the tab's own `x` is
close, not delete). Each dropdown row also has a gear for editing, so a saved URL
can be changed or removed without opening it first.

Switching tabs does **not** reload a dashboard. Frames stay alive in the background,
so a dashboard that took a while to authenticate is still there when you come back.
Past six live frames the least-recently-viewed one is dropped to bound memory
(`CODEMAN_MAX_LIVE_WEBVIEW_FRAMES`).

## Why dashboards are proxied

A plain `<iframe src="http://your-box:4000">` does not work in the setup Codeman
actually ships in, for three separate reasons:

| Blocker             | What happens                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **Mixed content**   | Production serves HTTPS (behind `tailscale serve`). Browsers hard-block `http://` iframes on an HTTPS page, with no override, and none at all on iOS Safari. |
| **Framing refusal** | Grafana, Portainer, Home Assistant and many others send `X-Frame-Options: DENY` or `frame-ancestors 'none'`. |
| **Codeman's CSP**   | `default-src 'self'` means `frame-src` falls back to `'self'`, so a cross-origin iframe is blocked before it starts. |

Serving the dashboard **through Codeman's own origin** dissolves all three. So by
default a web tab loads `/webview/<capability>/` on Codeman, and Codeman relays to
the dashboard: stripping the framing refusal, rewriting redirects, cookies and
root-absolute URLs, and relaying WebSockets so live panels actually update.

A useful consequence: the dashboard is fetched **from the Codeman server**, so a
tailnet-only or `localhost`-only dashboard works from any device that can reach
Codeman, including a phone that is not on the tailnet.

`direct` mode (a plain cross-origin iframe) still exists and is cheaper, but it only
works for an HTTPS dashboard that permits framing. The **Test** button probes from
the server and tells you which mode applies.

## The sandbox, and when to turn it off

Because a proxied dashboard is served from Codeman's own address, it is
*same-origin with Codeman* as far as the browser is concerned. Left unchecked, its
JavaScript could read the Codeman page and call the API that spawns agents.

So the iframe is sandboxed **without** `allow-same-origin` by default. The page runs
in an opaque origin: it cannot touch Codeman, and it gets no cookies or
`localStorage` of its own.

Unchecking **Open sandboxed** grants `allow-same-origin`. Do that only for a
dashboard you fully trust, and only if you need it, which in practice means a
dashboard with its own login that stores a session in a cookie or `localStorage`.

Even in trusted mode, Codeman never forwards its own credentials upstream: the
`Authorization` header and the `codeman_session` cookie are stripped on the way out,
so `CODEMAN_PASSWORD` cannot leak into a dashboard.

## How the proxy authenticates

A sandboxed iframe is opaque-origin, so every request it makes is cross-site: the
`SameSite=lax` session cookie is not sent, and writes and WebSocket upgrades arrive
with `Origin: null`. Cookie auth cannot work.

Instead, opening a dashboard mints a **capability**: 192 bits of entropy in the URL
path, held in memory only, with a rolling 12-hour TTL, bound to the user who minted
it, and granting exactly one thing, relaying bytes to that one saved URL. Editing or
deleting a dashboard revokes it, and a server restart invalidates every outstanding
capability (tabs re-mint transparently on next click).

## Limits and env vars

| Variable                             | Default | Meaning                                    |
| ------------------------------------ | ------- | ------------------------------------------ |
| `CODEMAN_MAX_WEBVIEWS`               | 50      | Saved dashboards per owner                 |
| `CODEMAN_MAX_LIVE_WEBVIEW_FRAMES`    | 6       | Iframes kept mounted at once               |
| `CODEMAN_WEBVIEW_CAPABILITY_TTL_MS`  | 12h     | Rolling capability lifetime                |
| `CODEMAN_WEBVIEW_TIMEOUT_MS`         | 30000   | Upstream request timeout                   |
| `CODEMAN_WEBVIEW_PROBE_TIMEOUT_MS`   | 8000    | Timeout for the Test button                |
| `CODEMAN_MAX_WEBVIEW_HTML_BYTES`     | 8MB     | Largest HTML document rewritten            |
| `CODEMAN_MAX_WEBVIEW_SOCKETS`        | 8       | Concurrent proxied WebSockets per dashboard |

Saved dashboards live in `~/.codeman/webviews.json`. Which tabs you have open is
per-device (`localStorage`), since that is workspace layout rather than config.

## How a dashboard's own API calls keep working

Worth knowing, because it is where this feature does its least obvious work. Three
layers cooperate so a dashboard talking to its own backend just works:

1. `<base href>` handles relative URLs in the markup.
2. Attribute rewriting handles root-absolute `src`/`href`/`action` in the page the
   proxy serves.
3. A small injected script rebases URLs built at **runtime**, which the first two
   cannot see: `fetch('/api/data')` and `new WebSocket('/live')`, but equally
   `card.innerHTML = '<img src="/api/hero">'` and `img.src = '/api/slide'`. That
   second group is why images are covered too. A dashboard that renders its
   thumbnails from script would otherwise show all its data and none of its
   pictures, because `<base>` does not apply to root-absolute URLs and the
   attribute rewriting only ever saw the initial document.

On top of that, the proxy answers those requests with CORS headers. That sounds
wrong for same-host requests, but a sandboxed iframe has an *opaque* origin, so the
browser treats every one of its `fetch`/XHR calls as cross-origin even though the
URL is on Codeman itself. Without those headers, a dashboard renders perfectly and
then every API call fails, which looks like the dashboard being broken.

## Known limits

- **Exotic loaders.** The three layers above cover normal `fetch`/XHR/WebSocket/
  EventSource, normal markup, and the DOM sinks a page uses to build markup at
  runtime. Something that constructs requests by an unusual route can still slip
  through. Symptom: the page renders but a panel stays empty. The known remaining
  gap is a root-absolute `url(/img.png)` inside a stylesheet the page injects at
  runtime; one under `/api` has no fallback and will 404.
- **Root-absolute `location` navigation.** A dashboard that navigates itself with
  `location.href = '/login'` escapes the prefix, because `Location.href` is
  unforgeable and cannot be patched the way the other sinks are. A relative
  `location.href = 'login'` is fine (`<base>` covers it).
- **Cross-origin redirects are not followed.** If a dashboard bounces to a different
  host (an external SSO provider, say), the proxy hands the redirect back unchanged
  rather than relaying it, because relaying would make this an open proxy. Use
  **Open in new tab** for those.
- **Login-protected dashboards need trusted mode**, since a sandboxed frame has no
  cookie jar. A server-side per-dashboard cookie jar would lift this and is the
  natural next step if it becomes annoying.
- **Not a security boundary.** The proxy reaches whatever the Codeman server can
  reach. That is not an escalation for someone who already commands
  `--dangerously-skip-permissions` agents, but in multi-user mode it does mean a
  non-admin user's dashboard is fetched from the server's network position.

## Where the code lives

| Concern                  | File                                    |
| ------------------------ | --------------------------------------- |
| Pure rewrite helpers     | `src/web/webview-proxy.ts`              |
| Routes + proxy + sockets | `src/web/routes/webview-routes.ts`      |
| Capability tokens        | `src/webview-capabilities.ts`           |
| Persistence              | `src/webview-store.ts`                  |
| Limits                   | `src/config/webview-limits.ts`          |
| Frontend                 | `src/web/public/webview-tabs.js`        |
| Auth exemption           | `src/web/middleware/auth.ts`             |
