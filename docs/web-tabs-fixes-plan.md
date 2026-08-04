# Web tabs: two fixes (planned + implemented 2026-07-28)

Both found against the saved dashboard
`https://<your-host>.<your-tailnet>.ts.net:4000` (Bio-Hacking-Dashboard).
Kept because the root-cause analysis of the second one is not obvious from the
resulting diff.

Status: **both implemented and verified end-to-end.** The one deliberate
non-change is recorded at the bottom.

---

## Bug 1: saved URLs could not be deleted from the Run dropdown

### What happened

The "Web / URL" section of the Run dropdown listed every saved dashboard as a
single clickable row whose only action was "open". Deleting required opening the
dashboard as a tab, clicking the tab's gear, then Delete in the modal, so a URL
you no longer wanted open at all could not be removed without first opening it.

### What shipped

- `renderWebviewMenuItems()` (`src/web/public/webview-tabs.js`) now renders each
  saved URL as a `.run-mode-row--web` flex row: the open button, a gear
  (`showWebviewModal`), and an `x` (`deleteWebviewById`). Nested buttons are
  invalid HTML, hence the wrapper rather than a button inside a button.
- `deleteWebview()` split into the modal entry point, the new row entry point
  `deleteWebviewById(id)`, and the shared `_confirmAndDeleteWebview(id)`.
- Both side buttons call `event.stopPropagation()` so the click does not also
  open the dashboard.
- The dropdown's outside-click handler (`session-ui.js`) closes when the click
  target is not inside `#runModeMenu`, and the row is gone by the time the delete
  resolves, so `deleteWebviewById` re-asserts `.active` on the menu. Verified in a
  browser: deleting one of several URLs leaves you looking at the rest of the list.
- CSS in `styles.css` (`.run-mode-row--web`, `.run-mode-row-btn`) plus a larger
  touch target in `mobile.css`. The side buttons are permanently visible rather
  than hover-revealed, because this menu is used on touch.

No server change: `DELETE /api/webviews/:id` already existed, owner-scoped, and
already revoked the capability and broadcast `WebviewChanged`.

---

## Bug 2: images did not load in a proxied dashboard

### Reproduction (before the fix)

```
CAP=<from POST /api/webviews/<id>/open>
# A) upstream direct                       -> 200 image/jpeg 118150
curl -sk "https://<your-host>.<your-tailnet>.ts.net:4000/api/hero?slug=120-minutes-in-nature"
# B) through the proxy prefix              -> 200 image/jpeg 118150
curl -sk "https://localhost:3000/webview/$CAP/api/hero?slug=120-minutes-in-nature"
# C) what the browser ACTUALLY requested   -> 404 {"errorCode":"NOT_FOUND"}
curl -sk -H "Referer: https://localhost:3000/webview/$CAP/" \
     "https://localhost:3000/api/hero?slug=120-minutes-in-nature"
# D) same shape but NOT under /api         -> 200 (referer fallback rescues it)
curl -sk -H "Referer: https://localhost:3000/webview/$CAP/" "https://localhost:3000/styles.css"
```

The proxy itself was fine (B). The failure was entirely about which URL the
browser ended up requesting (C).

### Root cause

The dashboard builds its image markup at runtime with root-absolute URLs:
`c.innerHTML = '<img class="thumb" src="/api/hero?slug=...">'`, `img.src =
slideSrc(...)` returning `/api/slide?owner=...`, `/api/story`, `/api/video`, and a
nested `<iframe src="/api/preview?slug=...">`.

All three rewrite layers missed that shape:

1. `<base href="/webview/<cap>/">` only affects **relative** URLs. A root-absolute
   `/api/hero` ignores the base path and resolves against Codeman's origin.
2. `rewriteHtml()` only runs over the **initial HTML document**. This markup is
   created later by page script. (The static header `<img src="/api/logo">` DID
   work, having been rewritten at proxy time, which is why only the
   runtime-injected images were broken.)
3. `runtimeUrlShim()` patched only `fetch`, `XMLHttpRequest.open`, `WebSocket` and
   `EventSource`, so the dashboard's **data** loaded while its **pictures** did
   not.

The safety net was fenced off from `/api` in two places, both deliberate:
`server.ts`'s not-found handler returns the API-envelope 404 before reaching
`tryWebviewRefererFallback`, and `middleware/auth.ts` refuses the Referer-form
auth exemption for `/api/`, `/ws/`, `/q/`.

### What shipped

`runtimeUrlShim()` in `src/web/webview-proxy.ts` now also covers the DOM sinks, so
a root-absolute `/api/...` request is never emitted in the first place and neither
security fence had to move:

- `innerHTML` / `outerHTML` / `insertAdjacentHTML` (and `ShadowRoot.innerHTML`),
- `setAttribute` / `setAttributeNS`,
- the `src`/`srcset`/`href`/`poster`/`data`/`action` property setters on img,
  source, media, video poster, script, iframe, embed, track, link, anchor, area,
  object and form,
- a `MutationObserver` as a last net for any sink not patched above (it costs one
  wasted 404 per node, since the browser starts fetching on insert, so it is a net
  and not the mechanism).

Two details that mattered:

- Every rewrite routes through the existing idempotent `rw()` rather than a blind
  prefix concat. The first draft used the server-side regex shape and
  double-prefixed markup that was already proxied (a page re-injecting its own
  `outerHTML`); the jsdom test caught it.
- Everything stays inside `try`/`catch` and is marked `__cmrw`, so a double
  injection cannot wrap an already-wrapped setter, and nothing can throw into a
  page we do not control.

### Verification

- `test/webview-proxy.test.ts` gained a jsdom `runtimeUrlShim DOM sinks` block:
  innerHTML, insertAdjacentHTML, property setters, setAttribute, srcset candidate
  lists, the MutationObserver net via an unpatched sink
  (`createContextualFragment`), idempotence, re-injected markup, empty `src`, and
  the pass-throughs (relative, cross-origin, `#hash`, `data:`). 73 tests pass.
- End-to-end in a real browser against an isolated instance
  (`CODEMAN_INSTANCE=wvtest`, port 3151), with prod's old build as the negative
  control:

  | | before (prod, old build) | after (fixed) |
  | --- | --- | --- |
  | images found | 693 | 693 |
  | src under the proxy prefix | 0 | 693 |
  | in-viewport images decoded | 0 / 23 | 23 / 23 |
  | sample src | `/api/hero?slug=...` | `/webview/<cap>/api/hero?slug=...` |

  (The dashboard marks thumbs `loading="lazy"`, so only in-viewport images are
  ever fetched. All 27 proxied image responses returned 200.)

---

## Follow-up (same day): the `/api` referer fallback, done safely

Originally deferred, then implemented on request. Both gates had to move, and the
auth one is the security-sensitive half: auth runs in `onRequest`, before routing,
so it cannot tell a real Codeman API route from a 404, and simply dropping the
`/api` fence would let a page holding a capability forge a `Referer` and reach
Codeman's **real** API unauthenticated.

What shipped:

- `server.ts`: `tryWebviewRefererFallback` is tried **before** the API-shaped 404.
  Reaching that handler already proves no route matched, and the relay declines
  unless the `Referer` carries a live capability, so unknown `/api` paths still
  get the envelope.
- `middleware/auth.ts`: the `/api/` prefix refusal is replaced by
  `matchesRegisteredRoute()`, which refuses the exemption for any path that
  resolves to a real route. `/ws/` and `/q/` stay refused by prefix.

Two findings that decided the implementation, both established by probing Fastify
rather than by reading its docs:

- **`hasRoute()` is the wrong tool and would have been a hole.** It matches the
  registered PATTERN literally, so `hasRoute({url: '/api/sessions/abc'})` returns
  false against a registered `/api/sessions/:id` and would have handed out an
  exemption on a live, session-scoped API route. `findRoute()` performs the real
  radix-tree lookup and is what the fence uses.
- **`@fastify/static` is mounted at `/`, so it registers a root catch-all that
  matches every path.** A match on it means "heading for the 404 handler", not
  "real route", and it is distinguishable because a root catch-all is the only
  route whose `*` param comes back equal to the whole request path. Without that
  carve-out the fence would have refused every referer-form request and broken the
  rescue that already worked.

The fence fails closed, and `test/webview-auth-exemption.test.ts` pins both edges
(a concrete URL onto a parametric API route stays 401; the dashboard's own
`/api/...` namespace is served).

### And the CSS gap, which the fallback could NOT close

Testing the fallback against a purpose-built upstream showed the runtime-injected
stylesheet case is unreachable by any relay: a `<style>` element has no URL of its
own, so Chromium sends an **empty `Referer`** with the image request it triggers
and there is nothing to key on. Measured directly:

| sink | Referer the browser sends | fixed by |
| --- | --- | --- |
| `url()` in a proxied `.css` | the stylesheet's proxied URL | the referer relay |
| `url()` in a runtime `<style>` | *empty* | `rwCss()` in the shim |

So the shim also rewrites `url()` inside `<style>` blocks, both when they arrive as
markup and when a `<style>` node is inserted (via the existing MutationObserver).

The only gap left is self-navigation via `location.href = '/x'`, which cannot be
patched because `Location.href` is unforgeable.
