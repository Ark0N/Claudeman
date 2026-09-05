# Custom Model Endpoint Profiles

Point any Codeman-supported harness — Claude, opencode, Codex, Gemini, Pi,
Grok, DeepSeek, or OMP — at a custom OpenAI-compatible endpoint instead of
its native cloud backend, for a given session. "Custom endpoint" covers both
**local** hardware (llama.cpp, Ollama, vLLM, a home GPU rig, or purpose-built
boxes like NVIDIA DGX Spark or AMD Strix Halo mini-PCs) and **cloud**
services (Azure AI Foundry's OpenAI-compatible endpoint, OpenRouter, a
company gateway) — anything answering `GET /v1/models` and
`POST /v1/chat/completions` in the standard shape. Design doc, per-CLI
recipe confidence table, and security reasoning:
[`deployment_plan.md`](../deployment_plan.md).

> **Status**: backend is implemented and tested (registry capability, the
> injection engine, the endpoint store + discovery route, the session
> restart route). The toolbar picker / settings UI described below as the
> intended surface is **not yet built** — until it lands, use the HTTP API
> directly (examples below). Antigravity has no known custom-endpoint
> mechanism and is not supported.

## Turning it on

App Settings → Agents & CLIs → **Custom Model Endpoints** (synced setting
`customModelEndpointsEnabled`, default **OFF**). The API equivalent:

```bash
curl -sk -X PUT https://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"customModelEndpointsEnabled": true}'
```

## Adding an endpoint

```bash
curl -sk -X POST https://localhost:3000/api/model-endpoints \
  -H 'Content-Type: application/json' \
  -d '{"id": "llama-box", "label": "Home llama.cpp", "baseUrl": "http://192.168.1.50:8080"}'
```

`apiKey` is optional (most local servers don't check it). `authStyle`
(`bearer` | `api-key` | `both`, default `both`) controls which auth header
convention discovery uses — `both` works whether the endpoint is llama.cpp
(ignores the header) or a cloud gateway like Azure (wants `api-key`).

Discover its available models:

```bash
curl -sk -X POST https://localhost:3000/api/model-endpoints/llama-box/discover-models
```

This calls the endpoint's own `GET /v1/models` and stores the returned list
on the endpoint record; `GET /api/model-endpoints` lists everything
configured, `PUT`/`DELETE /api/model-endpoints/:id` update or remove one.
Endpoint management is admin-only in multi-user mode, same as remote/docker
hosts — these are machine-level infra, not per-user settings.

## Applying a model to a session

```bash
curl -sk -X POST https://localhost:3000/api/sessions/<sessionId>/custom-model \
  -H 'Content-Type: application/json' \
  -d '{"endpointId": "llama-box", "modelId": "qwen3"}'
```

This computes the CLI-specific env vars / config for that session's mode
(see the recipe table in `deployment_plan.md`) and **restarts the session's
CLI process in place** — same pane, same tmux session, fresh env. That
restart is necessary, not incidental: every supported harness reads its
endpoint config at process start, not per-turn, so there is no live
hot-swap. Clear back to the harness's native cloud default with:

```bash
curl -sk -X POST https://localhost:3000/api/sessions/<sessionId>/custom-model \
  -H 'Content-Type: application/json' -d '{"clear": true}'
```

**New sessions always default back to the harness's native backend.** A
custom-endpoint selection is a per-session choice, never a sticky global
default — starting a fresh session doesn't inherit whatever the last one was
pointed at.

## Confidence per harness

Only Claude, opencode, and Codex have been verified against a real
llama.cpp server by hand. Gemini, Pi, Grok, DeepSeek, and OMP's recipes are
correct on their one-shot invocation flags (confirmed against real
installed binaries' own `--help` output) but their env-var/config
conventions for a _custom_ endpoint are still web-researched, not verified
end-to-end — see the confidence table in `deployment_plan.md` before relying
on one of those five in production. `scripts/test-local-llm-harnesses.mjs`
is the standalone script used to check a harness against a real endpoint
outside the web UI entirely; see its own `--help` for usage.

## Security note

Every env var this feature can set that redirects a session's traffic
(`ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `CODEX_HOME`, etc.) is
listed in that CLI's `privilegedEnvKeys` in the CLI registry, so a
non-granted multi-user owner cannot set one directly via the generic
`envOverrides` API field — only through this feature's own route, which
computes the value from an admin-configured, SSRF-guarded endpoint rather
than trusting arbitrary client input. See the "Multi-user security
hardening" section of `deployment_plan.md` for the full reasoning; several
of these were reachable via the generic `envOverrides` field even before
this feature existed, and building this surfaced and closed that gap.
