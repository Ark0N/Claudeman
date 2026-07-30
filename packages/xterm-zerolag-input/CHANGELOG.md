# xterm-zerolag-input

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
