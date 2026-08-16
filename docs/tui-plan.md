# Codeman TUI Rework Plan

Status: PROPOSED (research done, nothing implemented). Owner review needed on the open questions at the bottom.

The goal: replace Codeman's scattered terminal surfaces with one first-class TUI, `codeman tui`, that gives SSH/terminal users the same at-a-glance awareness the web UI gives browsers. The reference point is herdr (herdr.dev), the trending Rust "agent multiplexer" whose defining feature is a live agent-state sidebar. Codeman can match and beat that sidebar in the terminal because the states herdr infers from screen-scraping heuristics are states our server already computes from hooks, pane probing, and the approvals inbox.

---

## 1. What we have today (inventory)

Three disconnected surfaces, three visual idioms, two data sources:

| Surface | What it is | Data source | Idiom |
| --- | --- | --- | --- |
| `codeman` CLI (`src/cli.ts`, 1214 lines) | commander + chalk, ~20 commands | HTTP API + state files | `✓`/`✗` line-per-fact, no interactivity |
| `sc` (`scripts/tmux-chooser.sh`, 663 lines) | bash number-menu chooser, mobile-tuned (44 cols) | `tmux -L codeman` + `state.json` via jq | 256-color, numbered, full repaint per key |
| `scripts/tmux-manager.sh` (529 lines) | bash cursor TUI with kill/info | `mux-sessions.json` (and writes it back) | 8-color, box-drawn, arrow keys |

Weaknesses found in the audit (file:line refs verified 2026-08-16):

1. **No interactive picker in the Node CLI at all.** Every `session stop`, `task status`, `session logs` requires a pasted UUID prefix. There is no `codeman attach <session>`; `codeman attach` is actually the attachment-card command (and `README.md:895` describes it wrongly).
2. **`sc` cannot reach sessions 10+ interactively**: entries are numbered globally (`tmux-chooser.sh:343`) but input accepts a single `[1-9]` keypress (`:487-493`). Page 2 shows items 8-14 that mostly cannot be selected.
3. **No cursor/selection concept in `sc`** (`BG_SEL` at `:90` is dead code); arrows only page.
4. The two bash tools can disagree about which sessions exist (different data files), and only `sc` is on PATH.
5. **Zero live feedback anywhere**: `codeman web -d` and `service install` block silently up to 30s (`daemon-control.ts:395-412`); no spinner exists in the codebase.
6. Styling drift: `doctor` is the only table and is deliberately monochrome with a colorize hook nobody wired up (`dependency-report.ts:5-7`); `codeman web` prints its "running at" line twice (colored `cli.ts:934`, plain `server.ts:2366`); the server's security warning is colorless `console.warn` while the CLI's version of the same warning is yellow; `tmux-manager.sh`'s header box is visibly misaligned; `padEnd(14)` overflows on "Antigravity CLI".
7. Bash TUIs emit raw escapes unconditionally (no TTY/NO_COLOR gate); `install.sh` and `postinstall.js` do it right.
8. Detach hint inconsistency: chooser says Ctrl+B D, `README.md:671` says Ctrl+A D.
9. Inside an attached session there is **no chrome at all**: Codeman turns the tmux status bar off (`tmux-manager.ts:1978`), so an SSH user in a pane has no session identity, no state, no way back to a picker except detach.
10. `test/cli-commands.test.ts` asserts against a hand-written fixture, not the real `program`, and that fixture already lists a `tui` command that does not exist (`:57-61`). The name is pre-approved by our own test file.

## 2. Research: how herdr does it

herdr (github.com/herdrdev/herdr, ~30k stars, single Rust binary, pre-1.0) is a background terminal multiplexer "your coding agents live on". What matters for us:

- **The agent-state sidebar is the product.** Every pane is classified live as `working` / `blocked` / `done` / `idle` and grouped in a sidebar, so you see who needs you without switching tabs. Reviews unanimously call this "the killer feature tmux can't match".
- **Detection is heuristic-first**: process-name matching + screen-manifest TOML rules parsing the visible frame; optional per-agent "integration install" adds lifecycle hooks over JSON-RPC on a unix socket for accurate states. Claude Code there is on the heuristic path and reviewers note blocked-state lag.
- **Model**: workspaces → tabs → panes, tmux-style prefix keys (Ctrl+B V split, arrows navigate, D detach), mouse-first (click select, drag resize, right-click menus, touch over SSH), adapts to narrow widths.
- **Agent-shaped API**: socket API with `pane read` (visible/recent/detection), `send-text`/`send-keys`/`run`, `agent start|prompt|wait|explain`, `pane wait-output` with regex, plugins placed as overlay/split/tab/popup.
- **Persistence**: sessions survive disconnects, reattach from any terminal / SSH.
- Weaknesses reviewers cite: pre-1.0 churn, bus factor 1, no session resurrection, rendering lag with many panes.

What is striking is how much of herdr Codeman already has, server-side: our hooks give exact `permission_prompt`/`stop`/`idle_prompt` events (herdr's "integration" path, but installed by default), `_confirmIdle()` does the screen-probe fallback, the approvals inbox parses the actual dialog options, and the agent skill + wait primitives are our socket API. What we lack is purely the presentation layer in the terminal.

Prior art for the architecture we want: **agent-deck** (Bubble Tea + tmux) proves the "TUI list + attach into tmux" model works great: session list with live glyphs (● ◐ ○ ✕), Enter attaches into a tmux pane, status polling, groups, fuzzy search. We take the shape, not the code.

Licensing note: herdr is reported variously as Apache-2.0/AGPL-3.0. Irrelevant either way: we copy concepts, never code.

### What we take / what we skip

Take: the four-state sidebar as the organizing principle; grouping by "needs you first"; narrow-width adaptation; mouse support; tmux-familiar keys; the "attention at a glance" framing.

Skip: being a multiplexer. tmux already backs every Codeman session and is a hard dependency; herdr had to build pane management because it owns terminals, we do not. Also skip (for now): plugin marketplace, split layouts, pane drag. Our TUI is a **dashboard + switchboard over tmux**, not a tmux replacement.

## 3. Design: `codeman tui`

One command, one full-screen client of the existing HTTP/SSE API.

**Positioning (owner decision, 2026-08-16): the web UI remains THE primary surface.** The TUI is strictly additive, for users who want a terminal workflow (SSH, Termius, tmux die-hards). Bare `codeman` keeps printing help; nothing existing changes behavior. The `sc` bash chooser also stays untouched for now; flipping its alias to `codeman tui` is deferred to a follow-up release once the TUI has mileage.

### Layout (≥100 cols)

```
 codeman  tnode · v1.19.0 · 6 sessions · 5h ▂▂▅ 32% wk 61%                    ? help  q quit
 ────────────────────────────────────────────────────────────────────────────────────────────
  NEEDS YOU ──────────────────────────┐ ┌ w4-api-refactor ── claude · ~/dev/api ────────────
  ▶ 1 w4-api-refactor  ⚠ approval  2m │ │ ✻ Actualizing… (2m 14s · ↓ 12.3k tokens)
    2 w6-docs          ✋ waiting  11m │ │
                                      │ │ ⚠ Claude requests: Bash(git push origin main)
  WORKING ────────────────────────────┤ │   1. Yes  2. Yes, don't ask again  3. No
    3 w1-codeman       ✻ 17m    45.2k │ │
    4 w2-gallery       ✻ 3m      8.1k │ │ [y] approve   [n] deny   [Enter] attach
  IDLE ───────────────────────────────┤ │
    5 w3-promo         ○ 2h           │ │  …live tail of the selected session's
  RECENT ─────────────────────────────┤ │   terminal (ANSI colors preserved),
    · api-hotfix       ✔ done Fri     │ │   updating while you browse the list…
 ────────────────────────────────────────────────────────────────────────────────────────────
  ↑↓ select · ⏎ attach · 1-9 jump · y/n answer · p prompt · n new · x kill · / search · g digest
```

- **Header**: hostname/instance, server version, session count, plan-usage chip (same telemetry that feeds the web chip, when available). Degrades gracefully when the server is down (see §3.6).
- **Sidebar**: sessions grouped `NEEDS YOU` → `WORKING` → `IDLE` → `RECENT` (past sessions from the unified list, resumable). Within groups, reuse the activity ordering already built for the home screens in PR #303 (blocked first, running longest, quiet newest); that logic is pure and shared.
- **Preview pane**: live tail of the selected session, SGR colors preserved, cursor-movement stripped. When the selected session has a pending approval, the parsed dialog is rendered as a card above the tail with one-key answer bindings.
- **Footer**: contextual keymap (changes when a dialog/confirm is active).

### States and vocabulary

Exactly the web's language so the two surfaces read the same:

| Group | Glyph | Color | Source |
| --- | --- | --- | --- |
| NEEDS YOU (question/permission) | `⚠` | red, blinking row | approvals inbox / `permission_prompt` |
| NEEDS YOU (waiting for input) | `✋` | yellow | `idle_prompt` / waiting classification |
| WORKING | `✻` animating through `· ✢ ✳ ∗ ✻ ✽` at 2Hz | green | working classification (the same glyph family Claude itself draws, a deliberate nod) |
| IDLE | `○` | muted | idle |
| RECENT / done | `✔` | muted green | unified list history rows |

Nerd-font/glyph fallback exactly like `sc` does today (`[!] [w] [*] [-] [ok]` when the terminal is not known-capable), plus full NO_COLOR / `tput colors` degradation (8-color and mono renderings are designed, not accidental).

### Keymap

- `↑/↓` or `j/k` select · `Enter` attach · `1-9` jump-attach (parity with `sc`, but now the cursor covers 10+)
- `y`/`n` (or the digit keys) answer the selected session's pending approval right from the dashboard, via `POST /api/approvals/:id/answer`. The server already re-captures the pane and 409s if the dialog is gone, so this is safe by construction.
- `p` send a one-line prompt to the selected session without attaching (`POST /input` with `\r`, the composer opens in the footer)
- `n` new session (case picker → mode picker, drives `POST /api/quick-start`) · `x` kill with typed confirm (never bulk; refuses the session hosting the TUI itself, like tmux-manager.sh does)
- `/` fuzzy search across sessions/history/attachments (`GET /api/search`) · `g` away digest (`GET /api/away-digest`) rendered as a panel
- `r` resume selected RECENT row (unified list `resume-session` flow) · `?` help overlay · `q` quit
- Mouse (phase 3): SGR mouse reporting, click selects, wheel scrolls list/preview, click on footer keys triggers them. Works over SSH, same as herdr's touch story.

### Responsive behavior

The `sc` design constraint survives: below ~72 cols (Termius, iPhone portrait) the preview pane drops and the TUI is a single-column list with two-line rows, nearly identical to today's `sc` but with a cursor, live states, and the answer/prompt/new/kill verbs. The layout switch is width-driven at draw time, no mode flag.

### Attach model

Enter suspends the TUI (restore main screen + cooked mode), then hands the terminal to `tmux -L <socket> attach-session -t <name>` with `stdio: inherit`. On tmux exit/detach, the TUI resumes and refreshes. Full fidelity (mouse, paste, colors) is tmux's, we never proxy bytes.

- Inside tmux already: same socket → `switch-client -t`; different socket → warn about nesting and offer detach-first. `$TMUX` + `CODEMAN_MUX` detection.
- **Return path**: a tmux binding installed for codeman sessions (opt-in) runs `codeman tui --pick` inside `tmux display-popup -E`, a minimal picker-only mode (list + jump, no preview) so switching sessions from inside a pane is one keystroke, fzf-style.
- Optional per-attach chrome (opt-in setting, default off since `status off` at `tmux-manager.ts:1978` is deliberate): a minimal codeman-styled tmux status line showing `name · state · alert`, set on attach, restored on detach.

### Notifications

While the TUI is open and a session flips to NEEDS YOU: flash the row, ring BEL, and optionally emit OSC 9 (desktop notification in kitty/WezTerm/iTerm2, and it traverses SSH). This is the herdr sidebar promise delivered even when the terminal is backgrounded.

### Degraded mode (server down)

`sc` works without the server today and the TUI must too: when no server answers, enumerate `tmux -L codeman list-sessions` + read `state.json` (read-only), show a "server not running" header line, and offer attach only (no states, no approvals). This keeps the "web server crashed, get me to my sessions" path alive.

## 4. Architecture

### A client of the server, not a second brain

Everything live comes from the API the web UI already uses:

| Need | Endpoint |
| --- | --- |
| Session list + history | `GET /api/sessions/unified` |
| Live updates | SSE `GET /api/events` (heartbeat `sse:heartbeat` already exists; fall back to 2s polling) |
| Pending approvals + parsed options | `GET /api/approvals`, answer via `POST /api/approvals/:id/answer` |
| Preview tail | `GET /api/sessions/:id/terminal?tail=N` (throttled to the selected session only) |
| Prompt send | `POST /api/sessions/:id/input` (single line + `\r`, per the composer contract) |
| New session | `POST /api/quick-start` (routes remote/docker cases correctly) |
| Search | `GET /api/search` |
| Away digest | `GET /api/away-digest` |
| Plan usage chip | latest status-telemetry snapshot (`plan-usage-latest`) |

Server discovery and auth reuse what exists: instance config from `src/config/instance.ts` (`CODEMAN_INSTANCE`, `CODEMAN_PORT`), the probe logic from `daemon-control.ts`, credentials from `~/.codeman/.env` (the established `codeman attach` pattern), self-signed HTTPS accepted for loopback probes (the hooks-on-HTTPS lesson). Multi-user scoping comes free: the API only returns what the authenticated user owns.

### Renderer: hand-rolled, zero new dependencies (decision)

Options considered:

- **Ink (React for CLIs)**: what Claude Code uses. Pros: layout engine, ecosystem. Cons: pulls React into a CLI that today ships only commander+chalk; rerender model fights the two things we care most about (a raw-ANSI preview region and 2Hz glyph animation without flicker); version-pins React for every `npm i -g aicodeman`.
- **blessed/neo-blessed**: unmaintained, skip.
- **Hand-rolled screen core** (recommended): this repo hand-rolls ANSI everywhere already and has the expertise (regex-patterns, stripAnsi, the xterm work). The core is small and boring: alt screen + raw mode + cursor-home full-frame repaint from an off-screen string buffer, throttled to state changes and the 2Hz animation tick, wrapped in DECSET 2026 (synchronized output) where supported so repaints are atomic in modern terminals (tmux, kitty, WezTerm, iTerm2). No diffing needed at these frame rates.

The one genuinely tricky pure function: SGR-aware line clipping for the preview (keep colors, strip cursor movement/OSC/DECSET, clip to width while carrying SGR state, reset at EOL). That is a pure module with exhaustive unit tests, and it is exactly the kind of function Ink would not have given us anyway.

### Module layout

```
src/tui/
  tui-app.ts        entry + main loop + attach handoff (IO)
  tui-client.ts     API + SSE client, degraded-mode enumeration (IO)
  tui-model.ts      pure: state store, grouping, ordering (reuses PR #303 helpers)
  tui-layout.ts     pure: responsive layout math, row building
  tui-render.ts     pure: model+layout -> frame string (palette, glyphs, fallbacks)
  tui-keys.ts       pure: byte stream -> key/mouse events (incl. SGR mouse decode)
  tui-ansi.ts       pure: SGR-aware clip/filter for the preview
```

Pure modules unit-test with no TTY. `cli.ts` gains one thin `tui` command registration (and `--list`/`<n>` fast paths for `sc -l` / `sc 2` parity, which must stay fast: they short-circuit before any screen setup).

## 5. CLI-wide polish (the rest of "make it much nicer")

A shared style kit, `src/cli-style.ts`: one palette (mirroring the web's status colors), one glyph set with fallback, `heading()`, `kv()`, `table()` (width-aware, fixes the Antigravity overflow), `spinner()` (finally: the 30s silent daemon/service waits get a live line), `confirm()` (used by `reset --force`'s missing prompt and `x` in the TUI). Then the mechanical fixes from §1: colorize `doctor` through the hook that already exists for it, dedupe the `codeman web` startup line, colorize the server's security warning, fix the README `codeman attach` description and the Ctrl+B/Ctrl+A detach drift, TTY/NO_COLOR gates everywhere.

## 6. Phasing

| Phase | Contents | Size |
| --- | --- | --- |
| 0 | `cli-style.ts` + mechanical fixes (§5), real CLI tests (retire the fixture parser in `test/cli-commands.test.ts`) | S |
| 1 | `codeman tui` core: list + states via SSE, cursor + 1-9, attach/return loop, kill w/ confirm, new session, narrow mode, degraded mode, `sc` alias flip + `--list`/`<n>` parity | M/L |
| 2 | Preview pane (SGR clip), approvals answering, prompt composer, search, digest, resume, plan-usage header | M |
| 3 | Mouse support, `--pick` popup switcher + tmux binding, opt-in attach status line, BEL/OSC 9 notifications | M |
| 4 | Retire `tmux-chooser.sh`/fold `tmux-manager.sh` (keep as thin wrappers for one release), docs/README/wiki, screenshots for promo | S |

Phases 0-1 are the useful minimum; 2 is where it beats herdr's sidebar (answering approvals from the dashboard); 3 is delight.

## 7. Testing

- Pure modules (`tui-model/layout/render/keys/ansi`): plain vitest, frame snapshots as stripped strings plus targeted ANSI assertions.
- Interactive E2E: spawn the built TUI under `node-pty` (already a dependency), feed keys, assert on captured frames; the vitest tmux mock (`IS_TEST_MODE`) keeps attach paths inert. Port rules per CLAUDE.md (3150+, `app.inject()` where possible by testing `tui-client` against injected routes).
- Manual: Termius/iPhone portrait (the 44-col case), tmux nesting, server-down mode, NO_COLOR, non-nerd-font terminal.

## 8. Invariants this plan respects

- tmux socket and data dir always via instance config (`dataPath()`, `-L codeman`); a beta instance TUI sees only its own world.
- Never bulk kill, always confirm, never touch another session implicitly, refuse killing the session the TUI runs in (w1/w2/w3 are sacred).
- Input is single-line with `\r`, via the server (never raw tmux send-keys from the TUI while the server owns the session).
- Approvals answering goes through the server's re-capture + 409 path, never blind keystrokes.
- `status off` on panes stays the default; any chrome is opt-in.
- No new runtime dependencies; the npm package stays light.

## 9. Decisions (resolved 2026-08-16)

1. **Bare `codeman` does NOT open the TUI** (owner decision): the web UI is the main thing, the TUI is additional. `codeman tui` only.
2. **`sc` stays the bash chooser for now**; the alias flip is a follow-up once the TUI has mileage. `codeman tui --list` / `codeman tui <n>` provide the same fast paths for people who want to switch.
3. Opt-in tmux status line: deferred to phase 3 along with the `--pick` popup switcher.
4. Preview tail goes over the API (auth/multi-user/remote-consistent); previews are simply unavailable in degraded server-down mode.
5. Name is `codeman tui` (the test fixture historically expected it).

Initial PR scope: phases 0-2. Phase 3 (mouse, popup switcher, status line, OSC 9) and phase 4 (bash chooser retirement) are follow-ups.
