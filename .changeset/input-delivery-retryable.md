---
'aicodeman': patch
---

An input whose delivery fails can be retried instead of being lost for good.

Both input paths recorded the `(clientId, seq)` pair as applied and acknowledged
the frame _before_ knowing whether the write had landed — the POST route because
its mux write is fire-and-forget, the WebSocket handler because it ACKed
unconditionally. When the write then failed, the client dropped the frame from its
durable queue and the server rejected the retry as a duplicate: the reliable
delivery layer was guaranteeing exactly-once delivery of something that had never
been delivered.

The bookkeeping is now rolled back on failure and the WebSocket ACK withheld, so
the client redelivers. `Session.write()` reports whether it reached a PTY at all
instead of silently swallowing the data, and the non-mux POST branch — whose
response has not gone out yet — answers `OPERATION_FAILED` rather than a cheerful 200.

Note this does not remove the root cause: the POST still answers 200 before the
mux write is attempted, so a client that treats any 2xx as final still cannot
learn about that failure. Closing that would mean awaiting the tmux child in the
request path.
