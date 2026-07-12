# SPEEDRUN.md — Fast-execution protocol for Claude

Read this when the goal is **throughput**: get correct, verified work done with
minimum ceremony. This does **not** relax correctness or the safety rules in
`CLAUDE.md` — those still win. It removes _waste_, not _rigor_.

> Precedence: `CLAUDE.md` > explicit user instructions > this file. If anything
> here conflicts with `CLAUDE.md`, `CLAUDE.md` wins.

---

## The mindset

- **Act, don't announce.** No "I'm going to now…" preamble. Do the thing, report
  the result.
- **Cheapest proof that the change works.** Pick the smallest check that actually
  demonstrates correctness — not the biggest.
- **Batch aggressively.** Independent reads, greps, and edits go in **one**
  message with parallel tool calls. Never serialize work that has no dependency.
- **Momentum over perfection.** Land a correct increment, verify it, move on.
  Don't gold-plate untouched code.

---

## Loop (repeat until done)

1. **Orient once** — one parallel burst of reads/greps to load the context you
   need. Don't re-read files the harness says are already current.
2. **Change** — make the edit(s). Batch independent edits.
3. **Verify cheaply** — the smallest check that proves _this_ change (see below).
4. **Advance** — next item. Only re-verify what you touched.
5. **Stop** at: list empty, a hard blocker, or a decision that's genuinely the
   user's to make.

---

## Verification ladder — climb only as high as the change needs

| Change kind | Cheapest sufficient check |
|-------------|---------------------------|
| Types / signatures / imports | `tsc --noEmit` (or `--watch` already running) |
| One module's logic | `npm test -- test/<file>.test.ts` (the **one** relevant file) |
| A named behavior | `npm test -- -t "pattern"` |
| Route/handler | `app.inject()` route test, or one `curl` against the running dev server |
| Frontend render | Playwright load + assert (`waitUntil: 'domcontentloaded'`, wait 3–4s) |
| Broad / pre-merge | `npm run test:ci` (the CI-equivalent sweep) |

**Hard rules (never skip, even in a rush):**
- ⚠️ **Never run bare `npm test`** — it pulls in browser/visual suites that hang
  or fail locally. Always pass a file or `-t`, or use `test:ci`.
- ⚠️ **Never COM without verifying the change actually works** first (curl the
  endpoint / Playwright the UI). "Compiles" ≠ "works".
- ⚠️ **Session safety** — check `$CODEMAN_MUX`; never `tmux kill-session` /
  `pkill claude` in a managed session.
- ⚠️ **Single-line prompts** for any programmatic session input.

---

## Speed tactics that pay off here

- **Parallel exploration**: dispatch `Explore` subagents (or one parallel grep
  burst) instead of serial file-by-file reading when scope is uncertain.
- **`tsc --noEmit --watch`** in the background — instant type feedback, no repeat
  cold starts.
- **Target one test file** — `fileParallelism: false` means the suite is serial;
  running one file is dramatically faster than the sweep.
- **`curl localhost:3000/api/...`** beats spinning up a browser for backend
  checks. Reserve Playwright for actual UI rendering.
- **Trust the harness** — if it says a file you just edited is current, don't
  re-Read it to "confirm". The Edit already succeeded or it would have errored.

---

## Anti-patterns (these masquerade as speed, but cost time)

- Running the full test suite to check a one-file change.
- Re-reading files you already have in context.
- Narrating a plan you're about to execute anyway.
- Serial tool calls that have no dependency between them.
- Claiming "done / fixed / passing" **before** running the check that proves it.
- Deploying (COM) on green typecheck alone, without exercising the real flow.

---

## Stop-conditions (don't rush past these)

Stop and surface, don't guess, when you hit:
- A **destructive / hard-to-reverse** action (delete, overwrite, force-push).
- An **outward-facing** action (publishing, sending, deploying) not already
  authorized.
- A **genuine product decision** the code can't answer.
- A **failing verification you can't explain** — debug it (see
  `superpowers:systematic-debugging`), don't paper over it.

---

## Definition of done

A task is done when **all** hold:
- The change is made.
- The cheapest sufficient check **ran** and **passed** — evidence, not assertion.
- No new type errors / lint errors introduced (`tsc --noEmit`, `npm run lint`).
- You state plainly what was done and what proved it. If a step was skipped or a
  test failed, say so — don't hedge, don't overclaim.
