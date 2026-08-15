# Warm worker pool: sub-second claude worker spawns

Design sketch. Status: **proposed**, not started. Opt-in (`workerPoolSize`, default 0 = off); a user who touches nothing sees no change at all.

---

## 1. Problem and numbers

Measured against prod 1.18.3 on 2026-08-15, AFTER the SKILL.md fast-path hardening
(no recon turns), on the identical "spawn two codeman workers" prompt:

- **Cold orchestrator** (fresh session, skill loaded from disk): **20.2 s** prompt to
  final report. Breakdown: 3.9 s Skill-load turn, 6.4 s generating the one fused Bash
  call, **4.4 s spawn call**, 5.5 s summary. Tabs appeared at 10.5 s.
- **Warm orchestrator** (skill already in context, no Skill turn): **12.8 s**, spawn
  call 6.0 s.
- Inside the spawn call, session + tmux + case creation is cheap: the workers (and
  their tabs) appeared 0.2-1.7 s in, both siblings within ~350 ms of each other. The
  remaining **~4-5 s is claude CLI boot plus the composer-readiness wait**, paid again
  on every cold spawn. That slice is the pool's entire target.

The honest framing after the hardening: model turns dominate the skill flow (~16 of
20 cold seconds) and no server feature can shrink those. The pool attacks the
tool-side floor, and it has two distinct beneficiaries:

- **Skill/API orchestration**: the spawn call drops from ~4.4-6 s to ~1 s. Cold runs
  land ~16-17 s, warm ~8 s. Tab appearance barely moves for this consumer (it is
  model-turn-bound at ~10 s cold / ~4 s warm).
- **The UI Run button and direct quick-start callers**: a click today waits the full
  boot + readiness before the worker can take a prompt; a pooled claim makes the tab
  appear and the worker READY sub-second. This is the most visible win, and it
  involves no skill at all.

Target: hand out an already-ready worker in **under 1 s**.

## 2. Shape

A new `src/worker-pool.ts` singleton service, following the `CronService` pattern: it **reuses the existing session layer** (`SessionManager` create + the normal spawn path) and never rebuilds tmux logic.

A pool member is a real claude `Session`, pre-spawned in a reserved scratch case (`~/codeman-cases/.pool-<n>`, created with the standard scaffold + hooks), already past readiness: composer drawn, hooks installed, preamble file seeded. It sits idle at the composer costing no tokens.

The claim happens **transparently inside `POST /api/quick-start`**: when a request is pool-eligible (§3) and a healthy member is available, quick-start returns that member instead of cold-spawning. The agent skill, the UI Run button, and every existing caller change **nothing**. Ineligible or pool-empty requests cold-spawn exactly as today, so the pool is only ever a fast path, never a behavior change.

## 3. Eligibility gate

Claim only when ALL of these hold; otherwise fall through to a cold spawn:

- `mode === 'claude'` (external CLIs have different readiness semantics and inject secrets via `tmux setenv` at spawn; out of scope).
- No `envOverrides`, no `CLAUDE_CONFIG_DIR`, and `modelOverride`/`effort` unset or equal to what the pool member was spawned with. Env vars flow at spawn time and cannot be applied to a running CLI.
- The requested case is **fresh** (does not exist yet). A linked case, an existing directory, a remote-SSH case, or a Docker case means the caller wants a specific workspace; pool members cannot provide one.
- Single-user mode, or the requester owns the pool (v1 ships single-user only; §11).

## 4. What a claim does (~300 ms)

1. Pop a ready member (in-memory check-and-remove; Node's single thread makes this atomic, so two concurrent quick-starts cannot claim the same member).
2. Health-probe it: `isPaneDead` (the existing ~750 ms-cached mux probe) plus one `capturePaneText` asserting a clean composer. A dead, limit-paused, or dirty member is recycled, and the claim tries the next member or falls through to cold spawn.
3. Rename the session to the normal `w<n>-<case>` name, set `parentSessionId` via the existing `resolveParentSessionId()`, clear the pool flag, persist state.
4. Emit `session_created` **now** (it was suppressed at warm-spawn time, §5). The tab appears here, sub-second after the request.
5. Return the **pool case** as `casePath`/`workingDir` and do NOT create a directory under the requested name: an empty dir the worker's CLI does not run in is a trap (files written there are invisible to the worker at cwd), and the agent skill greps the RETURNED `casePath` for Codeman hooks before trusting the worker, so the response must point at the directory that really carries them.
6. Kick a background refill (§6).

**The identity wrinkle, stated honestly:** the session id, `CODEMAN_SESSION_ID` inside the pane, the seeded preamble file, and the CLI's cwd are all fixed at warm-spawn and survive the claim unchanged. So a claimed worker's `workingDir` is the pool dir, not `~/codeman-cases/<requested-name>`; the requested name is a **label**. The API must report the truthful `workingDir`. Transcript projHash, response viewer, subagent windows, and Read My Mind all key off the real path and keep working precisely because we do not lie about it. This is acceptable for the dominant use (ephemeral skill workers that are deleted after answering) and is documented in the skill; a caller that needs the real case as cwd is by definition not pool-eligible.

**Verified skill compatibility (zero preamble changes).** Checked against the shipped 1.18.3 preamble: `spawn_worker`'s readiness probe (`_composer_up`) is a `wait-output` call with `from=buffer`, which scans output that already scrolled past before blocking, so a pooled member's long-since-drawn composer matches instantly instead of stranding a fresh-stream wait. The trust-dialog fallback never fires (members passed the dialog at warm time), and the hooks grep passes because the pool case carries the standard scaffold. Pooled and cold spawns are indistinguishable to the skill except in speed and the additive `pooled: true`.

## 5. Hiding pre-claim members

Pool members must be invisible until claimed or they read as ghost tabs. `Session.isPoolWorker` gates, at minimum:

- `GET /api/sessions` and `GET /api/sessions/unified` (and therefore the Cmd+K palette and the session-history-index snapshot that feeds `/api/search`).
- `session_created` SSE at warm-spawn (deferred to claim time). All other per-session SSE for a hidden member is suppressed at the broadcast call sites it would reach.
- Push notifications and the Approvals Inbox (a warm member showing a trust dialog must recycle, not notify).
- The phone overview / home rail (both render from the session list, so the list filter covers them).
- The lifecycle log records `pool_warm` / `pool_claim` events rather than user-visible session history.

`maxSessions` (50) **counts** pool members, and the pool refuses to warm within `poolSize + 2` of the cap so it can never starve real session creation.

## 6. Refill, TTL, drain

- **Refill** after each claim, debounced, at most one warm spawn in flight (a claim burst falls back to cold spawns rather than forking N CLIs at once; same reasoning as the document-conversion limiter).
- **TTL ~30 min**: recycle members older than that so they cannot drift from settings, hooks config, or a self-updated CLI on disk.
- **Drain and respawn** on: `claudeModel` change, hooks-config regeneration, self-update, and `workerPoolSize` changes. On server shutdown, kill pool sessions (they are stateless and ours). On boot, kill any leftover `.pool-*` tmux sessions found via `mux-sessions.json` rather than adopting them; adoption buys nothing for stateless members.

## 7. Failure modes

| Failure | Handling |
| --- | --- |
| Member died idle (PTY exit, crash) | Health probe at claim catches it; recycle + try next; PTY-exit breaker applies unchanged |
| Member hit a usage limit while idle | `isLimitPaused` members are never handed out; recycle |
| Composer dirty (stray keystrokes, dialog) | `capturePaneText` probe refuses it; recycle |
| Claim race | Impossible by construction (synchronous in-memory pop) |
| Warm spawn itself fails | Log, back off, retry on next refill tick; pool empty just means cold spawns |

## 8. Cost

Each warm member is one tmux session + one idle claude process (order 150-300 MB RSS; **measure before defaulting the size above 0**, including whether an idle CLI makes any background requests via its statusline refresh). Zero token cost while idle. Suggested starting size for users who opt in: 2.

## 9. Settings and API surface

- `workerPoolSize` (int, 0-4, default 0): **synced** setting in `SettingsUpdateSchema`. The watcher that resizes the pool on `PUT /api/settings` must resolve from `merged`, never the raw body (the partial-PUT gotcha in CLAUDE.md).
- One internal status endpoint, `GET /api/worker-pool` (size, members' ages, claims served, fall-through count), for debugging. No new SSE events: the claim emits the existing `session_created`.
- No new public API semantics: `/api/quick-start`'s contract is unchanged apart from a `pooled: true` field in the response data, which is additive.

## 10. Considered and rejected

- **Renaming the pool case dir to the requested name at claim.** Linux keeps the process cwd working across the rename (inode-based), but claude computed its transcript projHash from the old path string at boot, so transcripts, subagent windows, and the response viewer go blind, the exact failure mode the `CLAUDE_CONFIG_DIR` docs warn about. Truthful label semantics (§4) beat a clever rename.
- **A new explicit claim endpoint.** Transparency inside quick-start means the skill, the UI, and every existing script get the speedup with zero changes; a new endpoint means new docs, new drift, and callers that must know the pool exists.
- **Pooling external CLI modes.** Readiness there is output stabilization, secrets ride `tmux setenv` at spawn, and codex/pi composer semantics differ per CLI. Claude-only until someone measures a need.
- **Returning quick-start at creation instead of readiness (no pool).** Would move tabs earlier on cold spawns too, but `sendwait` immediately after would then race the composer; readiness is what makes immediate tasking safe, and the pool makes the whole question moot for eligible spawns.

## 11. Phasing

1. **v1**: single-user, claude-only, fixed-size pool, transparent claim, status endpoint. Everything above.
2. **v2**: per-owner pools for multi-user mode (pool members must carry an owner because ownership scoping is structural); possibly model-matched pools (one warm set per configured `claudeModel`).
3. **Explicitly out**: warming linked/repo cases (spawning where the work is has no hooks and is the skill's documented costliest mistake; a warm pool must not make it faster to reach).

## 12. Testing

- Unit: pool manager logic pure and mock-driven (eligibility gate, TTL, refill debounce, drain triggers), `MockSession` from `test/mocks/`.
- Route: `app.inject` on quick-start asserting claim vs cold-spawn per eligibility row in §3, plus the double-claim race (two concurrent injects, one pool member: exactly one `pooled: true`).
- Live: re-run the pinned baselines against a warmed beta instance. Before (2026-08-15, prod 1.18.3, post-hardening): cold orchestrator **20.2 s** / warm **12.8 s** end to end, spawn call 4.4-6.0 s. Acceptance: spawn call under 1 s, cold ~16-17 s, warm ~8-9 s, and a UI Run click to a READY worker in under 1 s.
