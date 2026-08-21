# CLI Registry

Codeman's set of supported CLI backends is **data, not code**. Every CLI — Claude Code, a
plain shell, OpenCode, Codex, Gemini, Antigravity, Pi, or one you add yourself — is a
`CliEntry` in a central registry. Nothing downstream branches on a CLI's name; it reads
capability flags instead. Adding GitHub Copilot CLI, or any other agent CLI, is a config
entry, not a code change.

## Where it lives

| Layer | File | Role |
| --- | --- | --- |
| Stock catalog | `src/config/cli-registry/stock.ts` | Compiled into the app. The seven shipped entries, byte-identical (via the argv engine) to what earlier hand-written builders produced. |
| User overrides | `~/.codeman/clis.json` (`dataPath('clis.json')`) | **Overrides and custom entries only** — never the full catalog. Small and readable by design. |
| install.sh export | `config/clis.stock.json` | A generated, install-time-only subset (id/label/discovery) of the stock catalog, fetched by `install.sh` before the repo is even cloned. Regenerate with `npm run generate:cli-stock-json`; `test/cli-stock-json-sync.test.ts` pins it in sync with `stock.ts`. |

At load time (`src/config/cli-registry/registry.ts`), the stock catalog is deep-merged with
`~/.codeman/clis.json`: objects merge key-wise, **arrays replace wholesale** (a half-merged
`searchDirs` is not reasonable). A malformed **stock** override falls back to the pristine
stock definition rather than bricking a shipped CLI; a malformed **custom** entry is dropped
with a warning rather than failing the whole load.

### The seeding ratchet

`clis.json` tracks `seededStockIds` — the stock ids already introduced to this install. On
every load, any stock id not yet in that list is added, enabled, and appended to the list.
That is what lets a shipped update add a new stock CLI automatically while a CLI you
explicitly disabled stays disabled forever (its id is already seeded, so the ratchet never
touches it again). `shell` and `claude` can be disabled but never deleted.

## Editing it

- **Settings UI** (recommended): App Settings → Agents & CLIs → **Installed CLIs**. Enable,
  disable, reorder, or add a custom entry. The add form uses conservative defaults — the
  same profile as an unrecognized CLI: external agent, requires tmux, no hooks, no bypass
  flag, buffered echo.
- **API**: `GET /api/clis` (full merged registry, plus live `available`/`path`/`version`/
  `installHint`/`installStatus` per entry), `PUT /api/clis/:id/enabled`,
  `PUT /api/clis/order`, `POST /api/clis/:id` (add or replace a custom entry — refuses a
  stock id), `DELETE /api/clis/:id` (refuses a stock id). All admin-gated in multi-user
  mode.
- **Hand-editing `~/.codeman/clis.json`**: the loader validates on every read, so a syntax
  or schema error degrades to a warning and the pristine/omitted entry, never a broken
  server.

### Enabling a CLI auto-installs it

`~/.codeman/clis.json` deliberately does not care whether a **disabled** entry's binary is
even installed — that is the whole point of shipping GitHub Copilot CLI disabled by
default rather than leaving it out of the catalog entirely. The moment a CLI is switched
from disabled to enabled — via `PUT /api/clis/:id/enabled {"enabled":true}`, which is what
the settings UI's toggle calls — `src/config/cli-registry/cli-installer.ts`'s
`ensureCliInstalled` checks whether the binary is already resolvable and, if not, runs that
entry's `discovery.install.command` for the current platform in the background. Progress is
exposed as `installStatus` on both `GET /api/clis` and the `PUT .../enabled` response itself
(`{state: 'installing' | 'success' | 'error', command, message?}`); the settings UI polls
until it resolves and shows "Installing…" / "Install failed: …" inline.

This is a deliberate, narrow exception to `discovery.install.command` otherwise being pure
display text (its own doc comment in `types.ts` used to say "NEVER executed by the
server" — now updated to point here). The trust model:

- It only ever runs as the direct result of that one explicit API call — never on server
  boot, a background registry reload, or any other implicit trigger.
- The command that runs is **exactly** the string already shown as that entry's
  `installHint` — nothing is invented, combined with other input, or transformed.
- Enabling a CLI is already an admin-only action in multi-user mode, and in single-user
  mode there is one trust level, the same one that can already add or edit any entry
  (stock or custom) through this same settings surface. Running the install command that
  same operator already saw and could have run by hand adds no new privilege.

Under `VITEST` this is a silent no-op (same posture as `TmuxManager`'s `IS_TEST_MODE`) — the
test suite must never spawn a real, possibly network-dependent, possibly minutes-long
install command.

## The shape of an entry (`CliEntry`)

Full type definitions: `src/config/cli-registry/types.ts`. The top-level shape:

```ts
interface CliEntry {
  id: string; // e.g. "codex" — becomes the run-mode id everywhere
  label: string; // "Codex" — shown in menus
  shortBadge: string; // tab badge, e.g. "CX"
  accent: string; // single hex colour; CSS derives every per-CLI gradient from it
  enabled: boolean;
  stock: boolean; // set by the loader; a custom entry can never claim it
  order: number;
  kind: 'agent' | 'shell';
  discovery: CliDiscovery; // how to find/probe the binary, and how to install it
  launch: CliLaunch; // the structured argv template — see "Arg-template safety" below
  env: CliEnv; // env var export/unset/allowlist/tmux-setenv-secret rules
  capabilities: CliCapabilities; // the flags every call site reads instead of the id
  overlays: CliOverlays; // remote-SSH / Docker command overrides, credential store
}
```

`capabilities` is the important part for anyone extending Codeman: it is what
`isExternalCliMode()`, `isAltScreenStripMode()`, `hooksAvailableForMode()`, and every other
per-mode branch actually read. A brand-new CLI added through the settings UI gets the
conservative defaults — the same shape as Pi, the mode with the fewest assumptions baked in.

## Arg-template safety

`launch` never contains shell text. The composed command line is interpolated into
`bash -c "…"` inside tmux, which makes command construction a security boundary, so every
entry is a structured argv spec instead of a string:

- Every literal token is validated at load against a safe-word pattern (no space, quote,
  backtick, `$`, `;`, `&`, `|`, redirection, parens, braces, newline, or backslash). A
  literal that fails **rejects the whole entry** — a *flag* silently dropped would change
  security-relevant behaviour (e.g. losing `--no-approve`).
- A value placeholder picks a **named** `TokenPattern` (`model`, `uuid`, `slug`, `tool-list`,
  …) from `src/config/cli-registry/patterns.ts`; config can never supply its own regex for a
  value, so there is no ReDoS surface there. The one config-supplied regex,
  `discovery.version.regex`, is compiled through a nested-quantifier guard and run only
  against `--version` output truncated to 200 chars.
- Rendering (`src/config/cli-registry/argv.ts`) escapes unconditionally and independently of
  validation: a token is emitted verbatim only if it matches the safe-word pattern, and
  single-quote-wrapped otherwise. This is what keeps a hostile model name or session name
  from escaping into the shell even if a check upstream were ever bypassed.
- `test/cli-registry-argv-parity.test.ts` asserts the new engine's output is byte-identical
  to the original hand-written builders for the stock catalog, and
  `test/cli-registry-no-id-branching.test.ts` fails the build if a `mode === '<stock id>'`
  branch reappears anywhere outside `stock.ts`.

## install.sh and the Docker agent image

Both run **before** anything in this repo is necessarily built or even cloned, so neither
can import TypeScript:

- **`install.sh`** fetches `config/clis.stock.json` from `raw.githubusercontent.com`
  (derived from `$CODEMAN_REPO_URL`/`$CODEMAN_BRANCH`) and parses it with a plain `node -e`
  once Node.js is confirmed installed. A fetch or parse failure falls back to a small
  built-in JSON literal (Claude Code + OpenCode detection only) rather than aborting the
  install. This drives CLI detection (`check_cli`/`get_cli_path`) and the "install one
  later" hints generically — a CLI added to the stock catalog needs no `install.sh` change.
- **`docker/agent.Dockerfile`** takes the npm-installable CLIs' package names as build
  ARGs (`CLI_NPM_PACKAGES`, `CLI_PI_NPM_PACKAGE`). `scripts/build-agent-image.mjs` reads
  `config/clis.stock.json` and passes them via `--build-arg`, so a new stock entry with a
  plain `npm install -g <pkg>` install command is picked up with no Dockerfile edit. A CLI
  installed some other way (a standalone binary via curl, like Antigravity, or one needing
  extra flags, like Pi's `--ignore-scripts`) stays a documented Dockerfile special case —
  the sanctioned per-CLI exception, same as the prose notes in
  [Agent CLIs](wiki/Agent-CLIs.md).

## See also

- [Agent CLIs](wiki/Agent-CLIs.md) — the user-facing per-CLI guide (what each one is,
  its own quirks, choosing between them).
- `docs/extending-codeman.md` — third-party integration surfaces, including `/api/clis`.
- `docs/architecture-invariants.md` — implementation mechanics and the history behind the
  security-relevant rules above.
