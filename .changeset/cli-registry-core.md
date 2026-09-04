---
'aicodeman': minor
---

CLI backends are now a data-driven registry instead of a hardcoded set of run modes. Every
CLI (Claude Code, Terminal/Shell, OpenCode, Codex, Gemini, Antigravity, Pi, Grok, DeepSeek
Harness and OMP) is a `CliEntry` in `src/config/cli-registry/`, and the code that used to
branch on a CLI's name now reads capability flags off that entry instead.

This is an **internal refactor with no behaviour change**: no new endpoints, no new settings,
no change to any request or response shape, and the spawn command every CLI receives is
byte-identical to what the hand-written builders produced. `test/cli-registry-spawn-golden.test.ts`
pins those command lines as literal strings, captured from the previous builders before they
were removed, and `test/location-overlay-commands.test.ts` does the same for every remote and
in-container pane command.

What the registry owns: binary discovery (search paths, version and identity probes), the
launch argv template, environment handling (exports, `tmux setenv` keys, the env-override
allowlist), the multi-user privileged-parameter and privileged-env-key clamps, the
remote/docker location overlays, and the behavioural capabilities the rest of the app reads
(`isExternalCliMode`, `isAltScreenStripMode`, `hooksAvailableForMode`, alt-screen strip class,
echo policy, transcript format, and friends). `codeman doctor`'s per-CLI rows are generated
from the same entries, so its version rules and the run modes' resolvers can no longer
disagree about whether a given binary counts as installed.

Registry data is resolved **at call time**, never frozen at module import: session-mode and
env-prefix validation, the doctor's tool list, and each resolver's search directories all
re-read the catalog, so a CLI enabled while the server is running moves every surface at once
rather than only the run menu.

Four user-visible changes, all small and all deliberate:

- `probeDockerCliVersion()` derives the in-container binary name from the registry rather
  than assuming it equals the mode name. Only Claude reaches that path today, so nothing was
  broken in practice, but `antigravity` runs `agy` and the assumption would not have survived
  the next CLI that needs a version.
- The remote CLI version probe now covers **Grok and DeepSeek**, which the hardcoded map it
  replaces simply omitted — its own comment said the rule was "every mode except shell", so
  the two were an oversight from when those CLIs were added, and a remote session in either
  mode reported no version at all.
- OMP now requires tmux like its seven siblings. `session.ts` carried a hand-written list of
  modes with no direct-PTY fallback and omp was missing from it, even though CLAUDE.md's own
  text says "all eight require tmux" — so an omp session whose mux creation failed silently
  fell back to a direct PTY. `requiresMux` comes off the entry now, so the list cannot drift
  from the rule again.
- `codeman doctor`'s CLI rows come from the registry, so Claude's install hint is now the
  documented install command rather than a docs URL, five CLIs gain install hints they never
  had, and the row order follows the catalog (Claude now sorts below tmux).

A user-editable `~/.codeman/clis.json` can override any stock entry or add a custom CLI. It
is READ-ONLY in this release — nothing writes it, so importing the registry has no filesystem
side effects. Config never contains shell text: an entry declares typed argv tokens, every
literal is validated against a safe-word pattern at load, and values resolve through named
patterns that live in code, so a `clis.json` cannot widen its own validation.
`test/cli-registry-no-id-branching.test.ts` fails the build if per-CLI-id branching reappears
outside the stock catalog, in any of its four shapes (`===`, `!==`, `switch`/`case`, and
`includes`).
