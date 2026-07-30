# xterm-zerolag-input

## 0.1.6

### Patch Changes

- Plan-usage chip now defaults ON on desktop, plus the reworked `xterm-zerolag-input` README.
  - **Plan-usage chip defaults ON (desktop).** The `showPlanUsageLimits` chip (live 5-hour and weekly plan usage from the Claude statusline) used to be opt-in and default OFF, so most users never saw it. Desktop now defaults ON; handhelds still default OFF so the phone header stays minimal and the `mobile-header-buttons-policy` guard keeps passing. Devices with an explicitly stored preference keep whatever they chose, so nobody's OFF gets overridden.
  - **One resolver behind the chip.** Added `planUsageChipEnabled()` in settings-ui.js and routed all three call sites through it: the App Settings checkbox, the chip's visibility, and the create-time `statusLineTelemetry` flag in session-ui.js. Those three had independent `?? false` / `=== true` defaults, and a chip revealed without the telemetry flag renders `—` forever, so a default flip on one site alone would have shipped a permanently empty chip.
  - **Cron button comment corrected.** The App Settings comment claimed "Cron button defaults ON" while the code, the template (`btn-cron--hidden`) and the CSS all default it OFF. Verified against a fresh browser profile: the button is hidden and its checkbox unchecked out of the box. Comment now matches, and states why the two halves stay consistent.
  - **Docs.** CLAUDE.md, `docs/architecture-invariants.md` and `docs/usage-limits-display-plan.md` updated for the new default and the single-resolver rule; the stale `styles.css` comment claiming the server strips the chip's hidden class at render was corrected (display is per-device, so the client reveals it).
  - **`xterm-zerolag-input` README rework** (0.1.5 shipped the content; this republishes with the graphic and promo changes): replaced the misaligned 8-line keystroke-flow diagram with a two-line stock-vs-zerolag contrast, added a Codeman callout above the demo GIF with links to getcodeman.com and the repo, and rewrote the Origin section so it argues the extraction story instead of repeating the promo.

## 0.1.5

### Patch Changes

- Rewrite the `xterm-zerolag-input` package README as a value-first document and correct the drift that had accumulated against the source.
  - Added the side-by-side phone demo GIF (`docs/images/zerolag-demo-20260728.gif`) as the hero image, referenced by absolute raw URL so it renders on npmjs.com as well as GitHub. The two-phone comparison shows 0ms local echo next to a 600ms-2.7s server echo on the same session.
  - New "Why this one" comparison table, an explicit list of target use cases (SSH web clients, cloud IDEs, mobile terminals, container consoles), and a bundle-size badge (6.1 kB gzipped, measured from the ESM build).
  - Corrected the test-count badge from 78 to the actual 175 tests across 5 files, in both the package README and the Published Packages section of the root README.
  - Removed the stale "Unicode/emoji rendered at single-cell width" limitation. CJK, fullwidth forms and emoji have had double-width rendering and visual-column positioning since the wide-character fix; the honest remaining caveat (per-code-point width summing over-counts ZWJ grapheme clusters) replaces it.
  - Documented the previously undocumented public `setPrompt()` method for switching prompt strategies at runtime, and the new "Wide characters (CJK, emoji)" integration section covering the optional `Unicode11Addon` path and the built-in range-table fallback.
  - Documented `backgroundColor: 'transparent'`, corrected the `foregroundColor` default, and updated the grid-alignment math to reflect visual-column positioning rather than character index.

  No source changes, docs only.

## 0.1.4

### Patch Changes

- Initial changelog entry for changesets-based versioning
