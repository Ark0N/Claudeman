# Contributing to Codeman

## Prerequisites

- **Node.js 22** (use `nvm use` — `.nvmrc` is included)
- **tmux** — required for session management
- **Claude CLI** — installed and accessible in `$PATH`

## First-Time Setup

```bash
# 1. Clone and enter the repo
git clone https://github.com/Ark0N/Codeman.git
cd Codeman

# 2. Pin Node version
nvm use

# 3. Install dependencies (also links packages/xterm-zerolag-input workspace)
npm install

# 4. Start the dev server
npm run dev
# Open http://localhost:3000
```

## Development Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server at localhost:3000 |
| `npm run typecheck` | TypeScript type check |
| `npm run lint` | ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Prettier format |
| `npm run format:check` | Check formatting (used in CI) |
| `npm run build` | Production build |
| `npm run clean` | Remove dist/ |

## Running Tests Safely

> **CRITICAL:** If you are running inside a Codeman-managed tmux session, **never** run the full test suite — it spawns and kills tmux sessions and will crash your own session.

```bash
# Safe: run a single test file
npx vitest run test/<file>.test.ts

# Safe: run tests matching a name pattern
npx vitest run -t "pattern"

# DANGEROUS — only run outside of Codeman:
# npx vitest run
```

Test files use unique ports starting at 3150. Search `const PORT =` before adding a new test file.

## Code Style

- **TypeScript strict mode** — all strict flags are enabled in `tsconfig.json`. Code must pass `npm run typecheck` with zero errors.
- **ESLint** — run `npm run lint` before submitting a PR. Use `npm run lint:fix` for auto-fixable issues.
- **Prettier** — run `npm run format` to format source files. CI enforces `format:check`.
- **Import conventions:**
  - Utilities: `import { LRUMap, stripAnsi } from './utils'`
  - Types: `import type { SessionState } from './types'`
  - Config: `import { MAX_TERMINAL_BUFFER_SIZE } from './config/buffer-limits'`

## Architecture Quick Reference

| Concern | File |
|---------|------|
| Session/PTY | `src/session.ts` |
| Web server (~105 routes) | `src/web/server.ts` |
| All TypeScript types | `src/types.ts` |
| Frontend (vanilla JS) | `src/web/public/app.js` |
| Respawn state machine | `src/respawn-controller.ts` |
| Task/Ralph loop | `src/ralph-loop.ts`, `src/ralph-tracker.ts` |

See `CLAUDE.md` for the full architecture reference.

## PR Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (or issues are documented)
- [ ] `npm run format:check` passes
- [ ] Relevant test file updated or added
- [ ] No full test suite run inside a Codeman session
- [ ] tmux safety respected (no blind `tmux kill-session`)

## Repository Layout

```
src/            TypeScript source
test/           Vitest tests (run individually)
scripts/        Build and utility scripts
packages/       Local npm workspaces (xterm-zerolag-input)
tools/          Dev utilities (Remotion video generation)
docs/           Architecture docs and planning documents
mobile-test/    Playwright mobile test suite
agent-teams/    Agent Teams feature docs
```
