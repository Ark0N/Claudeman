---
"aicodeman": patch
---

fix(auth): slide the session cookie so active users aren't logged out

Re-issue the `codeman_session` cookie on every authenticated request so the
browser cookie lifetime tracks the server-side sliding TTL (the session store
already uses `refreshOnGet`). Previously the cookie was only set on the Basic
Auth path with a fixed 24h lifetime from login, so the browser dropped it
mid-use; the next request arrived cookie-less, fell through to Basic Auth and
popped the native username/password dialog — perceived as a random logout while
actively working.
