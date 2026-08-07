---
'aicodeman': patch
---

Routes that answer with `reply.raw.writeHead()` no longer drop the headers the
security hook set.

`writeHead` writes straight to the Node response and bypasses Fastify's header
store, so everything the `onRequest` hook granted was silently lost — including the
`Access-Control-Allow-Origin` it emits for localhost origins, and the
`X-Content-Type-Options` / `X-Frame-Options` / CSP headers. A localhost page could
therefore call every other `/api` endpoint cross-origin while its EventSource
failed CORS.

Affects `GET /api/events` and the three raw-writing routes in `file-routes.ts`
(`file-raw`, `tail-file`, `download`).
