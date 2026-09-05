# Custom Model Endpoint Profiles (all harnesses, local or cloud)

## Context

Devvyn pays for Claude Code but also runs a capable local model behind an
OpenAI-compatible server (llama.cpp) — and wants the same mechanism to work
against a **cloud** OpenAI-compatible endpoint too (e.g. Azure AI Foundry's
OpenAI-compatible inference endpoint, OpenRouter, a self-hosted gateway).
Right now every Codeman session mode defaults to its native cloud backend
with no way to redirect a session at any other endpoint from the UI — the
closest existing precedent is DeepSeek's server-env-sourced
`DEEPSEEK_BASE_URL`, which isn't user-facing.

**Scope note**: this plan originally said "local LLM." It now covers any
OpenAI-compatible endpoint the user configures — local (llama.cpp, Ollama,
vLLM) or cloud (Azure AI Foundry, OpenRouter, a company gateway). The
mechanism is identical (a base URL Codeman probes via `GET /v1/models`); the
only real differences are auth-header convention (cloud endpoints often want
an `api-key` header, e.g. Azure, rather than `Authorization: Bearer`) and
that a cloud "model" may actually be a deployment name distinct from the
underlying model family (Azure AI Foundry deployments) — both are called out
where they matter below. Naming throughout this plan is **"custom model
endpoint,"** not "local model," to keep that scope explicit.

### Additional use case: on-premises AI hardware

"Local" isn't limited to a desktop running llama.cpp — a growing category of
purpose-built, on-premises AI hardware exists specifically to run a serious
model on-site with an OpenAI-compatible server, and this feature is exactly
the on-ramp for pointing Codeman at one:

- **NVIDIA DGX Spark** (and the DGX Spark-class "Spark" mini-supercomputer
  line) — a compact on-prem inference/training box aimed at running large
  local models with an OpenAI-compatible API surface.
- **AMD "Strix Halo" (Ryzen AI Max)** on-prem AI mini-PCs — unified-memory
  APU hardware marketed for local LLM inference, typically fronted by
  llama.cpp/Ollama/vLLM the same way a home server would be.

Neither needs anything new from this design: both present a standard
`/v1/models` + `/v1/chat/completions` OpenAI-compatible surface once the
inference server is running, so they're just another `baseUrl` entry in the
custom-model-hosts store, same as llama.cpp or a cloud endpoint. The
justification for building this generically (rather than hardcoding "point
Claude at my llama.cpp box") is precisely this: **the same endpoint registry
and per-CLI injection mechanism should work unmodified for any current or
future OpenAI-compatible box or service** — a home GPU rig today, a Spark or
Strix Halo appliance tomorrow, a company's on-prem inference cluster after
that — without Codeman needing to know or care what's actually serving the
model on the other end of that URL.

A concrete example worth naming: **[Ark0N/Qwen5090](https://github.com/Ark0N/Qwen5090)**
(from the same GitHub account as this project's owner) is a one-click
Windows / one-command Linux installer that stands up Qwen3.8-27B locally on
an RTX 5090 (or another RTX 50-series card with ≥24GB) behind an
OpenAI-compatible API, served by any of vLLM, NInfer, or llama.cpp — MIT-
licensed tooling over Apache-2.0 Qwen weights. It's a direct, ready-made
target for this feature: point a custom-model-hosts entry at whichever
backend it's running, and it needs nothing further from Codeman's side. It's
also notable for already wiring up DeepSeek Harness and Claude Code as
coding agents against that local server itself, which is effectively the
same "point a Codeman-supported harness at a local endpoint" idea this
feature is generalizing — worth using as a real-world reference/test target
once chunk 5 (session integration) exists, alongside Devvyn's own llama.cpp
box.

Each harness has its own (different-shaped) mechanism for pointing at a
custom OpenAI-compatible base URL + model — env vars for Claude, a JSON
config blob for opencode, a TOML file for Codex, etc. Devvyn gave the
starting recipes for those three; the rest (Gemini, Pi, Grok, DeepSeek, OMP,
Antigravity) were researched for this plan and are flagged by confidence
below. A real end-to-end pass against Devvyn's own llama-swap server
(`scripts/test-local-llm-harnesses.mjs`, inside a `codeman/agent:llm-test`
Docker image with all 9 CLIs installed) then confirmed **claude and
opencode work end-to-end**, corrected a real Codex config.toml schema bug
the given recipe had (see the Codex row below), and surfaced that Codex's
*protocol* — not just its config shape — does not work against a plain
OpenAI-Chat-Completions server like llama.cpp/llama-swap at all. Confidence
below reflects what was actually observed, not just what was planned.

The feature must be:

- **Off by default**, one settings toggle turns it on.
- Endpoint entry: user gives a base URL — a LAN address or a cloud URL —
  plus an optional API key, and Codeman calls `GET <baseUrl>/v1/models` to
  discover and store the available model (or deployment) list.
- A **new toolbar selector** (separate from the existing Run-mode menu, since
  it's a modifier on top of whichever harness is already selected/running)
  lets the user pick "Cloud (default)" — the harness's own native backend —
  or a model discovered from one of the configured custom endpoints.
- Picking a custom-endpoint model for an **already-running session restarts
  that session's CLI process** with the injected env/config pointed at that
  endpoint (confirmed with Devvyn — these harnesses read endpoint config at
  process start, not per-turn, so a live hot-swap isn't possible).
- **New sessions always default back to the harness's native cloud backend.**
  A custom-endpoint selection is a per-session override, not a sticky global
  default — starting a fresh CLI (any mode) always launches against its
  native backend unless the user explicitly picks a custom endpoint for that
  new session too. The toolbar selector is scoped to "this session," never
  carried forward as the default for future sessions.

This follows the repo's existing data-driven CLI-registry philosophy
(`test/cli-registry-no-id-branching.test.ts`): per-CLI behavior is a
declared capability, never an `if (mode === 'claude')` branch.

## Per-CLI injection recipes (confidence-ranked)

| CLI | Mechanism | Confidence |
|---|---|---|
| `claude` | Env vars: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_DEFAULT_SONNET_MODEL`/`_HAIKU_MODEL`/`_OPUS_MODEL` (all set to the chosen model/deployment name) | **Verified end-to-end** against a real llama-swap server — a real "hello world" reply came back. ⚠️ Non-interactive (`-p`) invocations also fire an async session-title-generation call that reuses `ANTHROPIC_DEFAULT_HAIKU_MODEL` and validates it against Claude Code's OWN internal recognized-model list, printing `[claude-code:unrecognized_model]` and, in `-p` mode, hanging the whole invocation rather than just warning. `--settings '{"autoTitle":false}'` does NOT stop this (confirmed); `--bare` does (the warning still prints, but the real prompt runs) — but `--bare` ALSO disables hooks, LSP, plugin sync, and CLAUDE.md auto-discovery, so it is only safe for the standalone one-shot test script, NEVER for a real interactive Codeman session (which depends on hooks for idle detection, trust-dialog auto-accept, etc. — see the External CLI modes section of CLAUDE.md). Whether an INTERACTIVE claude session with a custom model hits the same hang (vs. just a background warning) is untested and should be checked before calling chunk 5/6 done for claude |
| `opencode` | `OPENCODE_CONFIG_CONTENT` env var (already a registry mechanism, `stock.ts:342`) holding a JSON blob: `{"provider":{"custom":{"options":{"baseURL":...,"apiKey":...},"models":{"<name>":{}}}},"model":"custom/<name>"}` | **Verified by user** |
| `codex` | TOML `config.toml`: top-level `model = "<id>"` + `[model_providers.custom]` (`base_url`, `env_key` naming an env var the real API key rides in — never a literal TOML field, since codex's schema has no such field). Written to an isolated dir via `CODEX_HOME` (`stock.ts:405-415`) so the user's own `~/.codex/config.toml` is never touched | **Config STRUCTURE verified** against a real codex binary (an earlier `[model].default` table shape was rejected: "invalid type: map, expected a string" — caught live). **Protocol CONFIRMED BROKEN against llama.cpp/llama-swap**: codex only speaks the Responses API (`wire_api = "responses"`, the only value it accepts since it dropped `"chat"` support in Feb 2026), and a real llama-swap server does not implement `/v1/responses` — a live run against it failed with repeated `Reconnecting...` then `high demand` errors. Codex support therefore needs a Responses-API-compatible endpoint (most local llama.cpp/Ollama/vLLM setups do not qualify); do not present this as working against a generic OpenAI-Chat-Completions box |
| `gemini` | Env vars `GOOGLE_GEMINI_BASE_URL` (or `GOOGLE_VERTEX_BASE_URL`) + `GEMINI_API_KEY`; CLI needs a restart to pick them up (matches our restart-on-switch design). Model selection via `--model`/`GEMINI_MODEL`-style override — verify exact var name against the installed `gemini-cli` version before shipping | Web-researched, unverified |
| `pi` | Config file `~/.pi/agent/models.json` (hot-reloadable) with a custom provider block: `baseUrl`, `apiKey`, `api:"openai-completions"`. Redirect via `PI_CONFIG_DIR` (already allowlisted per CLAUDE.md) pointed at an isolated dir containing just this file, rather than overwriting the user's real one | Web-researched, unverified |
| `grok` | Env vars `GROK_BASE_URL`, `XAI_API_KEY` (dummy ok for local; a real key for most cloud endpoints), `GROK_MODEL`. All three already fit inside the existing `XAI_*`/CLI-specific allowlist shape | Web-researched, unverified |
| `deepseek` | Reuse the **existing** `DEEPSEEK_BASE_URL` + `DEEPSEEK_API_KEY` keys (already declared in `stock.ts:879-913`, already in `privilegedEnvKeys`). Model selection is murkier — CLAUDE.md notes dsh model is "a profile composition entry," not a flag/env var, so redirecting the endpoint is solid but forcing a specific model name may not fully work; document as best-effort and verify against a real profile | Web-researched, unverified, partial |
| `omp` | Config file `~/.omp/agent/models.yml`-equivalent with a custom provider `baseUrl`. CLAUDE.md notes omp's config tree is itself relocatable via `PI_CONFIG_DIR` — reuse the same isolated-dir-redirect approach as `pi` | Web-researched, unverified |
| `antigravity` | No CLI/env/config mechanism found — Antigravity's docs describe only a GUI settings panel, and explicitly say a custom endpoint "cannot currently" become the core reasoning model. **Not implemented**; toolbar entry stays disabled for this mode with an explanatory tooltip | No known mechanism |

Everything web-researched-but-unverified gets implemented but must be
smoke-tested against real installs of those CLIs before being called done —
call this out explicitly when implementing, don't just ship on faith.

**Cloud-endpoint specifics** to keep in mind per recipe above: an Azure AI
Foundry-style endpoint typically wants the API key in an `api-key` header
rather than (or in addition to) `Authorization: Bearer`, and its "model" is
often a deployment name rather than the underlying model family name — the
discovery step (`GET /v1/models`) still works the same way against Azure AI
Foundry's OpenAI-compatible endpoint shape, but a user may need to type the
deployment name manually if it isn't returned as expected.

## Architecture

### 1. Registry: new `capabilities.customModelInjection` field

Extend `src/config/cli-registry/types.ts` / `schema.ts` with a discriminated
union on each `CliEntry.capabilities`:

```ts
type CustomModelInjection =
  | { kind: 'env'; baseUrlVar: string; apiKeyVar: string; modelVars: string[] }
  | { kind: 'configContentEnv'; envVar: string; template: 'opencode-json' }
  | { kind: 'configDir'; dirEnvVar: string; fileName: string; template: 'codex-toml' | 'pi-models-json' | 'omp-models-yml' }
  | { kind: 'unsupported' }
```

Declared per stock.ts entry per the table above. A pure function in a new
`src/custom-model-injection.ts` (`buildCustomModelInjection(entry, endpoint, modelId)`)
turns `(CliEntry, endpoint, modelId)` into either an `envOverrides` object
(kind `env`/`configContentEnv`) or a `{ dirEnvVar, files: [{path, content}] }`
descriptor (kind `configDir`) — unit-testable with no IO, mirroring how
`session-cli-builder.ts` is pure. The `configDir` kind additionally needs an
IO wrapper that writes those files under
`dataPath('custom-model-configs/<sessionId>/')` (new dir, cleaned up on
session delete — same lifecycle as other per-session generated state).

### 2. Endpoint registry: `src/custom-model-hosts.ts`

Same read-array/write-array shape as `src/remote-hosts.ts` /
`src/webview-store.ts`: `~/.codeman/custom-model-hosts.json` holding
`CustomModelEndpoint[] = { id, label, baseUrl, apiKey?, authStyle?: 'bearer'|'api-key'|'both', models?: string[], lastDiscoveredAt? }`.
`authStyle` defaults to `'both'` (send both header conventions on the
discovery probe, same approach the smoke-test script below uses) so one
endpoint entry works whether it's llama.cpp or Azure without the user having
to know which header their box wants in advance.

New route file `src/web/routes/custom-model-routes.ts` (registered in the
routes barrel), mirroring `case-routes.ts`'s remote/docker-host CRUD
(`GET/POST/PUT/DELETE /api/model-endpoints`, admin-gated in multi-user mode
the same way) plus:

- `POST /api/model-endpoints/:id/discover-models` — fetches
  `${baseUrl}/v1/models`, stores the `data[].id` list, returns it. Bounded
  timeout, and run the target through the **same SSRF egress guard already
  used for web tabs** (`webview-egress-policy.ts` — reject link-local/cloud
  metadata addresses) — this still matters for a cloud URL too, since the
  guard is about preventing a redirect to internal infra, not about
  local-vs-cloud.

**Why discovery rather than a free-text model field**: it removes the one
piece of configuration most likely to trip a user up — hand-typing the
exact model identifier a given inference server expects, which varies by
server and is an easy source of a silent "model not found" failure with no
useful error surfaced back through a CLI's own startup. Discovery also
means this design is not limited to a single-model box: a **multi-model
gateway** such as **[llama-swap](https://github.com/mostlygeek/llama-swap)**
(hot-swaps between several loaded llama.cpp model configs behind one
OpenAI-compatible endpoint) or a vLLM/LiteLLM/Ollama instance serving
several models advertises ALL of them through the same `/v1/models` call —
so one endpoint entry surfaces every model that gateway can serve, with no
extra per-model configuration on Codeman's side at all.

### 3. Settings

- New synced boolean `customModelEndpointsEnabled` in `SettingsUpdateSchema`
  (`src/web/schemas.ts`), default `false`, documented inline like
  `readMyMindEnabled`/`workspaceHooksEnabled`.
- New `.set-group` "Custom Model Endpoints" inside the **Agents & CLIs**
  section (`settings-clis`, `index.html:2150+`) with the enable toggle plus
  a list-editor (add/refresh-models/delete rows) for endpoints — closest
  existing precedent is the respawn-presets array editor
  (`schemas.ts:1285-1305`, `index.html:1243-1244`) for add/apply/delete-by-id
  semantics, backed by the new CRUD routes above.

### 4. Toolbar UI

- New header/toolbar button (e.g. `#customModelBtn`, `btn-toolbar
btn-custom-model`), marker-hidden by default (`btn-custom-model--hidden`)
  and revealed by `applyHeaderVisibilitySettings()` only when
  `customModelEndpointsEnabled` is on — same pattern as the File
  Viewer/Cron buttons.
- Clicking opens a dropdown (`#customModelMenu`, same `.run-mode-menu`-style
  markup as the existing Run-mode gear menu) listing "Cloud (default)" plus
  every discovered model, grouped by endpoint. An entry is disabled with a
  tooltip when the active session's CLI has `customModelInjection.kind ===
'unsupported'` (Antigravity) or none declared.
- Selecting an entry calls a new route:
  `POST /api/sessions/:id/custom-model { endpointId, modelId } | { clear: true }`.
  Server: resolve the CLI entry for `session.mode`, build the injection via
  §1, persist it as a new `session.customModel` state field (surfaced in
  `toState()`/SSE so the tab can show a small badge, e.g. "🖥 qwen3 (local)"
  or "☁ gpt-4o-mini (azure)", and the choice survives reload), merge into
  the session's `envOverrides`, and **respawn the pane's CLI process**
  through the same respawn/interactive-restart path
  `session.ts`/`tmux-manager.ts` already use for effort/model changes
  (`_configureCliEnv()` + `applyEnvOverrides()` at spawn time) — reuse,
  don't reinvent, the existing kill-and-relaunch-in-pane machinery.
- New-session creation deliberately does **not** inherit a prior custom-
  endpoint choice: `buildEnvOverrides()` (session-ui.js) never carries the
  toolbar selection forward to the next `run()` call. Every new session
  starts on its native backend; picking a custom endpoint in the toolbar for
  a session applies only to that session (and, if done before Run is
  clicked, to the one session about to be created — not to sessions created
  afterward).

### 5. Multi-user security clamp

Every new env var this feature introduces that can redirect a session's
traffic (and thus wherever its credentials go) — `ANTHROPIC_BASE_URL`,
`GOOGLE_GEMINI_BASE_URL`, `GROK_BASE_URL`, the `CODEX_HOME`/`PI_CONFIG_DIR`
dir-redirects, plus the already-privileged `DEEPSEEK_BASE_URL` — must be
added to each CLI's `capabilities.privilegedEnvKeys` so
`clampEnvOverridesForOwner()` strips them for a non-granted multi-user
owner, exactly the precedent already documented for `DEEPSEEK_BASE_URL`/
`OMP_AUTH_BROKER_URL`. This matters *more*, not less, now that endpoints can
be cloud URLs: redirecting a non-granted user's session to an attacker's
cloud endpoint is a credential-exfiltration path, not just a mischief
redirect to a LAN box. Endpoint CRUD itself stays admin-only in multi-user
mode, same as remote/docker hosts.

## Files touched (representative, not exhaustive)

- `src/config/cli-registry/types.ts`, `schema.ts`, `stock.ts` — new capability + per-entry declarations
- `src/custom-model-injection.ts` (new) — pure per-CLI descriptor builder + unit tests
- `src/custom-model-hosts.ts` (new) — endpoint store
- `src/web/routes/custom-model-routes.ts` (new) — CRUD + discovery route
- `src/web/routes/session-routes.ts` — `POST /api/sessions/:id/custom-model`, clamp wiring
- `src/web/schemas.ts` — `customModelEndpointsEnabled`, endpoint/discover payload schemas, privileged-key updates
- `src/session.ts` — `customModel` state field, `toState()` surface
- `src/web/public/index.html`, `settings-ui.js`, `session-ui.js`, `styles.css` — settings group, toolbar button/menu, badge, accent CSS
- `src/web/sse-events.ts` + `constants.js` — if a dedicated SSE event is warranted for the badge (or just ride existing session-update broadcasts)
- `test/fixtures/mock-openai-server.ts` (new) + `test/custom-model-injection-contract.test.ts` (new) — see Mock-server validation below
- `scripts/test-local-llm-harnesses.mjs` (already added, this branch) — the standalone real-CLI-and-real-endpoint smoke test; despite the filename (kept for continuity with when it was written) it already supports any `--base-url`, local or cloud
- `docs/custom-model-endpoints.md` (new) + a CLAUDE.md pointer bullet under External CLI modes / envOverrides

## Mock-server validation strategy (CI-runnable, no real CLI binaries needed)

Spawning nine real CLI binaries in CI isn't realistic, and neither Devvyn's
llama.cpp box nor a real cloud subscription can be a CI dependency. So the
injection *logic* gets a tier of automated coverage that sits between the
pure unit tests and the live manual checks in Verification:

1. **`test/fixtures/mock-openai-server.ts`** — a small in-process HTTP
   server (plain `http.createServer`, no external deps, port picked per the
   existing `const PORT = 3150+` convention) that:
   - Serves `GET /v1/models` → a fixed fake model list (`{data:[{id:'qwen3'},...]}`),
     for testing the discovery route.
   - Serves `POST /v1/chat/completions` (OpenAI shape) **and**
     `POST /v1/messages` (Anthropic Messages-API shape, since that's what
     `ANTHROPIC_BASE_URL` traffic looks like) and records every request it
     receives (headers, body, path) into an array the test can assert on —
     including which auth header style it saw, so the `authStyle: 'both'`
     default and Azure's `api-key` convention both get real coverage.
   - Returns a minimal valid completion so a client library doesn't choke
     on the response shape.

2. **`test/custom-model-injection-contract.test.ts`** — for every CLI with a
   `customModelInjection` capability (i.e. every row in the table above
   except `antigravity`):
   - Point a fixture `CustomModelEndpoint` at the mock server's URL.
   - Call `buildCustomModelInjection(entry, endpoint, modelId)` (the pure
     function from §1) to get the real env vars / config-file content that
     would be injected into that CLI's session.
   - Replay those exact values through a minimal HTTP request shaped the
     way that CLI is documented to send it (Anthropic Messages shape for
     claude; OpenAI chat-completions shape for opencode/codex/pi/grok/omp;
     `GOOGLE_GEMINI_BASE_URL`'s OpenAI-compat shape for gemini; dsh's
     provider call for deepseek) against the mock server.
   - Assert the mock server received the request **at the injected
     `baseUrl`**, with **the injected API key** in the expected header, and
     **the injected model id** in the body/path — i.e. prove the values
     Codeman computes are internally consistent and would reach the right
     place with the right identifiers, end to end, in CI, on every push.
   - Also cover the `configDir` kind (codex/pi/omp): assert the written
     `config.toml`/`models.json`/`models.yml` file parses and contains the
     same base URL/key/model, and that it's written under the isolated
     per-session dir rather than the user's real config path.

3. **Explicit, stated limitation** (goes in the test file's `@fileoverview`
   and in this doc, not left implicit): this proves *"if the CLI honors its
   documented env/config contract, it will hit the right endpoint with the
   right model."* It does **not** prove the real CLI binary actually reads
   that env var / config file the way its docs say — that's still the job
   of the live manual checks in Verification step 4-5 below, and is exactly
   why the confidence table above stays "unverified" for six of the nine
   CLIs until someone runs those binaries for real. The mock-server suite
   catches regressions in Codeman's own logic; it cannot catch a CLI
   changing its env-var name in a future release, or a real cloud endpoint
   behaving differently from the mock.

## Verification

1. `npm run typecheck && npm test` after each slice — this now includes the
   mock-server contract suite from above, so injection-logic regressions
   are caught automatically without touching real infrastructure.
2. Unit tests for `buildCustomModelInjection()` per CLI kind (pure, no IO).
3. Route tests (`app.inject`) for the new CRUD + discover-models endpoint
   (mock `fetch` for `/v1/models`), and for the multi-user clamp on the new
   privileged keys (mirror `test/routes/external-cli-bypass-clamp.test.ts`).
4. **Standalone real-binary smoke test**: `scripts/test-local-llm-harnesses.mjs`
   (already written on this branch) exercises every harness against a real
   `--base-url` — local or cloud — outside of Codeman's UI entirely. Run it
   against Devvyn's llama.cpp server first (`claude`/`opencode`/`codex`
   should PASS, since those recipes are verified; the rest report
   UNCONFIRMED/SKIP until their guessed flags are corrected via
   `--probe-help`), then again against a real cloud endpoint (e.g. an Azure
   AI Foundry deployment) once one is available, to prove the `authStyle`/
   deployment-name handling holds up outside llama.cpp.
5. Once the full feature (not just the standalone script) is built: add an
   endpoint via the real UI, hit discover-models, confirm the returned model
   list, pick Claude + the model on a real session, confirm via
   `tmux -L codeman capture-pane`/`tmux showenv -t <pane>` that
   `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_DEFAULT_*_MODEL` are
   set post-restart, and confirm the endpoint's own logs show the next
   prompt actually landing there. Repeat for opencode and Codex at minimum
   before considering this shippable; spot-check the web-researched CLIs
   and correct the plan's confidence table with what's actually observed.
6. `npm run lint && npm run format:check`.
7. Update `CHANGELOG.md`/changeset per the COM workflow when shipping.
