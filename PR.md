# feat: Custom Model Endpoint Profiles (local or cloud, all harnesses)

> **⭐ Shout-out up front:** this feature was partly inspired by — and is a
> great fit for — **[Ark0N/Qwen5090](https://github.com/Ark0N/Qwen5090)**,
> the maintainer's other project: a one-click Windows / one-command Linux
> installer that stands up Qwen3.8-27B locally on an RTX 5090 behind an
> OpenAI-compatible API (vLLM / NInfer / llama.cpp). Once this feature lands,
> pointing Codeman at a Qwen5090 box is just adding one endpoint entry — no
> extra code, no special-casing. Qwen5090 already wires up DeepSeek Harness
> and Claude Code as local coding agents itself, which is basically this
> feature's idea in miniature. 🙂

**Status: draft / work-in-progress.** This PR is not ready to merge — see
[Status](#status) below for exactly what's done and what's still open.

---

## What

Adds a settings-gated (default **OFF**) way to point any Codeman-supported
harness — Claude, opencode, Codex, Gemini, Pi, Grok, DeepSeek, OMP, or
Antigravity — at a **custom OpenAI-compatible endpoint** instead of its
native cloud backend, for a given session. "Custom endpoint" covers both:

- **Local hardware**: llama.cpp, Ollama, vLLM, a home GPU rig, or
  purpose-built on-prem boxes like NVIDIA DGX Spark, AMD Strix Halo
  (Ryzen AI Max) mini-PCs, or the [Qwen5090](https://github.com/Ark0N/Qwen5090)
  setup above.
- **Cloud**: Azure AI Foundry's OpenAI-compatible endpoint, OpenRouter, a
  company's self-hosted gateway.

The user adds an endpoint by base URL (+ optional API key), Codeman
discovers its available models via `GET /v1/models`, and a new toolbar
picker lets them apply one of those models to a session — which then
restarts that session's CLI process pointed at the endpoint.

**Why discovery instead of asking the user to type a model name:** it turns
"go read your inference server's docs to find the exact model identifier it
expects" into "pick from a list Codeman already fetched" — one less place
for a user to get a name/casing wrong and have a harness fail with an
opaque "model not found." It also means this feature works unmodified
against **multi-model hosting setups**, not just a single-model server: a
gateway like **[llama-swap](https://github.com/mostlygeek/llama-swap)**
(or vLLM/LiteLLM/Ollama serving several loaded/loadable models behind one
`/v1/models` list) already advertises every model it can hot-swap to, so
the toolbar picker becomes a live menu of everything that endpoint can
serve — no per-model endpoint entries, no separate configuration step,
just "add the gateway once, everything behind it shows up."

## Why

The maintainer pays for a Claude Code subscription but also runs a capable
local model. Every harness Codeman drives already *has* its own mechanism
for pointing at a custom endpoint (env vars for Claude, a JSON config blob
for opencode, a TOML file for Codex, etc.) — Codeman just never exposed a
UI for it. Full motivation, the per-CLI recipe table, and the on-prem
hardware use cases are written up in **[`deployment_plan.md`](deployment_plan.md)**.

## How

- **`src/config/cli-registry/{types,schema,stock}.ts`** — new
  `capabilities.customModelInjection` field per CLI entry, one of four
  kinds: `env` (Claude, Gemini, Grok, DeepSeek), `configContentEnv`
  (opencode, reusing its existing `OPENCODE_CONFIG_CONTENT` mechanism),
  `configDir` (Codex/Pi/OMP — writes an isolated config file, never touches
  the user's real one), or `unsupported` (Antigravity — no known mechanism,
  toolbar entry stays disabled). Declared data-driven per the repo's
  existing "never branch on CLI id" rule.
- **`src/custom-model-injection.ts`** — pure function turning
  `(CliEntry, endpoint, modelId)` into the real env vars / config content.
  No IO; a caller writes `configDir` files to disk.
- **`src/custom-model-hosts.ts`** + **`src/web/routes/custom-model-routes.ts`** —
  read/write-array endpoint store (`~/.codeman/custom-model-hosts.json`,
  same shape as `remote-hosts.ts`) and `GET/POST/PUT/DELETE
/api/model-endpoints` + `POST /:id/discover-models`, admin-gated in
  multi-user mode, SSRF-guarded via the same `isBlockedWebviewUrl()` check
  web tabs use.
- **`src/web/schemas.ts`** — `customModelEndpointsEnabled` (synced, default
  OFF) + the endpoint payload schema.
- **`scripts/test-local-llm-harnesses.mjs`** — standalone smoke-test script
  that spawns each real CLI binary one-shot against a real endpoint and
  checks it can answer "hello world," independent of the web UI. Reads
  defaults from a gitignored `scripts/local-llm-test.config.json` (see the
  committed `.example.json`) so real IPs/keys never land in git.

### A finding along the way: multi-user privilege hardening

Building this surfaced that several env vars (`GOOGLE_GEMINI_BASE_URL`,
`GROK_BASE_URL`, `CODEX_HOME`, `PI_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`,
etc.) were **already** reachable via the generic `envOverrides` API today,
pre-existing this PR, because Codeman's env allowlist is prefix-based and
global. A non-granted multi-user owner could already redirect a session's
endpoint/credentials via a plain `envOverrides` field. This PR adds all of
them to their CLI's `privilegedEnvKeys` (the existing clamp mechanism
`DEEPSEEK_BASE_URL` already used), closing that gap rather than widening it.
`CODEX_HOME` and `PI_CONFIG_DIR` are flagged as extra-sensitive: a
redirected config dir can restate approval/sandbox policy or, for Pi,
redirect to a dir Pi will execute `.pi/extensions` TypeScript from.

Claude is the deliberate exception: `ANTHROPIC_*` is **not** added to
Claude's allowed env prefixes at all, so it stays reachable only through
the dedicated, admin-configured, SSRF-guarded custom-model route — never
through a plain client-supplied `envOverrides`.

## Status

Built in reviewable chunks; ✅ = done and verified (typecheck + lint +
format + tests green), ⬜ = not started.

- ✅ **1. Registry types** — `customModelInjection` capability shape
- ✅ **2. Pure injection builder** — `custom-model-injection.ts` + 15 unit tests
- ✅ **3. Endpoint store + CRUD routes** — `custom-model-hosts.ts`,
  `custom-model-routes.ts`, discovery + SSRF guard, 7 route tests
- ✅ **4. Settings + security hardening** — `customModelEndpointsEnabled`
  flag, `privilegedEnvKeys` additions across 7 CLI entries
- ✅ **5. Session integration** — `session.customModel` state field,
  `session.setCustomModel()`/`session.restartCli()` (a generalized,
  de-restricted `reattachRemote()` reusing the existing `respawn-pane -k`
  primitive), `POST /api/sessions/:id/custom-model` restart route. 5 new
  route tests; the existing `session.test.ts`/`session-cleanup.test.ts`
  suites can't run at all on this Windows dev box (no local `tmux` —
  confirmed identical on unmodified `master`, not a regression), which is
  exactly why the container test below matters.
- ⬜ **6. Frontend** — settings group, toolbar picker, tab badge
- ✅ **7. Mock-server contract tests** — `test/fixtures/mock-openai-server.ts`
  and `test/custom-model-injection-contract.test.ts`, 10 tests replaying
  every CLI's real injected values through an HTTP call shaped the way that
  CLI sends it, against an in-process fake server
- ✅ **8. Docs** — `docs/custom-model-endpoints.md` (user guide, HTTP-API-only
  until chunk 6 lands) + a CLAUDE.md pointer bullet

Also done outside the chunk list: the standalone
`scripts/test-local-llm-harnesses.mjs` smoke-test script + its gitignored
config file, the on-prem-hardware use-case writeup in `deployment_plan.md`
(DGX Spark, Strix Halo, Qwen5090), and a `codeman/agent:llm-test` Docker
image (all 9 CLI binaries, built from `docker/agent.Dockerfile`) for the
real end-to-end test against a live llama-swap server.

## Testing performed so far

- `npm run typecheck` — clean after every chunk
- `npm run lint` / `npx prettier --check` — clean
- `npm test -- test/cli-registry test/custom-model-injection.test.ts
test/custom-model-injection-contract.test.ts test/routes/custom-model-routes.test.ts
test/routes/session-custom-model.test.ts test/routes/external-cli-bypass-clamp.test.ts` —
  245+ tests passing, including the existing multi-user clamp suite (no
  regressions from the `privilegedEnvKeys` additions)
- `node --check scripts/test-local-llm-harnesses.mjs` + manual `--help` run
- **Real end-to-end run against the maintainer's live llama-swap server**
  (`http://10.10.11.241:8080`), inside `codeman/agent:llm-test` (all 9 CLI
  binaries, built via `docker/agent.Dockerfile`), against the smallest
  available model (`qwen3.5-0.8b-ud-q8_k_xl`, 1.1GB — picked by parsing the
  server's own reported model sizes). Real findings, not simulated:
  - **opencode: PASS.** Genuinely round-tripped a "hello world" reply
    through the real endpoint.
  - **codex: real bug found and fixed.** The recipe's TOML shape
    (`[model].default`) was rejected by a real codex binary ("invalid
    type: map, expected a string") — codex wants a top-level `model`
    string plus `[model_providers.custom]`, and the API key rides as an
    `env_key`-named env var, never a literal TOML field. Fixed in
    `custom-model-injection.ts`, the standalone script, and both test
    suites. **Then a second, deeper finding**: codex only speaks the
    Responses API now (`wire_api = "responses"`, the only value it accepts
    since dropping `"chat"` support in Feb 2026) — a real run against the
    now-correctly-shaped config still failed (`Reconnecting...` × 5, then
    "high demand" errors) because llama-swap doesn't implement
    `/v1/responses`. This is a genuine, currently-unresolved protocol
    incompatibility, not a bug in this PR's code — documented prominently
    in `deployment_plan.md`'s confidence table.
  - **claude: PASS, after two real bugs found and fixed.** (1) Claude
    Code's async session-title-generation call also uses
    `ANTHROPIC_DEFAULT_HAIKU_MODEL` and validates it against Claude's own
    internal recognized-model list, printing `[claude-code:unrecognized_model]`
    and, in `-p` mode, hanging the whole invocation rather than just
    warning. `--settings '{"autoTitle":false}'` does NOT
    stop it (confirmed); `--bare` does — the warning still prints, but the
    real prompt now runs and returns the real answer. ⚠️ `--bare` is only
    safe for this standalone one-shot test script — it also disables hooks,
    LSP, plugin sync, and CLAUDE.md auto-discovery, so it must NEVER be
    applied to a real interactive Codeman session (which depends on hooks
    for idle detection, trust-dialog auto-accept, etc.). Whether an
    INTERACTIVE session with a custom model hits the same hang (vs. just a
    background warning, which would be harmless) is untested — flagged as
    an open item for chunk 5/6, not assumed either way. (2) A separate,
    genuinely nasty bug in the test script itself: a `POST` issued right
    after a `GET` in the same Node process reliably HUNG indefinitely
    against this real server (reproduced repeatedly: GET alone ~30ms, POST
    alone ~1-2s, GET-then-immediate-POST times out completely; a 2s pause
    between them fixed it every time) — looks like Node's fetch/undici
    reusing a pooled keep-alive connection the server doesn't handle
    cleanly for a second request right behind a first. Fixed with a 2s
    pause between the script's discovery GET and its baseline POST. This
    is a tooling-correctness fix (affects the script's own baseline check),
    not a claim about how any CLI's own HTTP client behaves.
  - **Also found and fixed**: an earlier design sent BOTH `Authorization:
    Bearer` and `api-key` auth header conventions on every discovery/
    baseline request, on the theory that an unused header is harmless.
    Live-tested against the real server, sending both reliably HUNG the
    request (reproduced 3×: either header alone ~500-600ms, both together
    no response inside 15s). Removed the `'both'` option entirely from
    `CustomModelAuthStyle` (was `'bearer' | 'api-key' | 'both'`, now just
    the first two, default `'bearer'`) — in the schema, the store type, the
    discovery route, and the standalone script (`--auth-style` flag added).
    This was a real, currently-shipped-in-this-PR bug fixed before it ever
    reached anyone, not a pre-existing one.

## Not yet done / open questions for review

- Six of nine per-CLI recipes (Gemini, Pi, Grok, DeepSeek, OMP) are
  **web-researched, not verified** against real binaries — see the
  confidence table in `deployment_plan.md`. Antigravity has no known
  mechanism at all and stays unsupported.
- Chunk 5's session-restart design needs a careful look before
  implementation: switching a session's endpoint restarts its CLI process
  in place (confirmed acceptable with the maintainer — these harnesses
  read endpoint config at process start, not per-turn).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
