---
'aicodeman': patch
---

`npm test` is now the CI gate and is safe to run bare; the suites it cannot run each got their own command.

`npm test` ran the everything-config, which fails ~87 tests on a clean master on any machine without chromium, a free port and per-machine PNG baselines. That made the repo's most obvious command useless as a pass/fail signal, and the docs had accumulated "never run bare `npm test`" warnings in four files to work around it. It now runs `config/vitest.ci.config.ts` — exactly what CI runs — so local green means CI green.

- New: `test:browser` (5 Playwright files), `test:perf` (2 wall-clock benchmarks), `test:all` (the old everything-behaviour, kept reachable). `test:ci` and `test:mobile` are unchanged; `test:watch` and `test:coverage` follow `test` onto the gate's config.
- The exclusion list moved to `config/test-suites.ts`, with the reason each suite cannot run in CI. Every config derives from it, so the gate's excludes and the runners' includes cannot drift.
- That drift was a silent hole, not a tidiness problem: a file excluded from CI and added to no runner is tested by NOTHING, and every command stays green, because vitest counts "no files matched" as success. `test/test-suite-partition.test.ts` now fails if any test file is reachable by no runner or by two.
- ⚠️ A file filter must match its runner: `npm test -- test/mobile/keyboard.test.ts` matches nothing and exits green having run zero tests, because the gate excludes that path. Use `npm run test:mobile -- <file>`. Documented in CLAUDE.md, and the one place that recommended the old form was corrected.
- Docs synced: CLAUDE.md, AGENTS.md, .github/CONTRIBUTING.md, both READMEs, and two ci.yml comments that claimed only `test/mobile/**` was excluded (it is three suites, and 5 Playwright files rather than 3).
