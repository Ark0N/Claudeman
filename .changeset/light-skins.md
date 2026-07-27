---
'aicodeman': patch
---

Add four light UI and terminal skins: Paper Gray, Solarized Light, Catppuccin Latte, and Rosé Pine Dawn. The Skin picker now groups Light and Dark options, and each light skin ships a matching xterm ANSI palette plus `color-scheme: light` so native selects, date pickers and scrollbars stop rendering as dark OS widgets on a light page. Terminals set `minimumContrastRatio: 4.5` under a light skin (main terminal and teammate terminals both), which keeps CLI output that assumes a dark background readable, and `applyTerminalSkin()` now refreshes the zero-lag input overlay so typed-but-unflushed text does not keep the previous theme's colors.

Elevated surfaces (modals, command palette, dropdowns, subagent and ultracode windows, file preview, attachment tray, mobile sheets) now resolve through shared `--floating-bg` / `--control-*` / `--banner-bg-*` / `--modal-backdrop` / `--elevated-shadow` tokens instead of hardcoded near-black rgba, so they follow whichever skin is active. On the Daylight skins this lifts modals slightly off the page background; OG Codeman pins its own near-black value to keep that palette neutral.

Also defines twelve CSS compatibility aliases (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--border-color`, `--accent-color`, `--success`, `--error`, `--danger`, `--font-mono`, `--shadow-lg`) that panels and overlays already referenced in about 79 places but which were never actually declared, so those rules silently resolved to nothing. Status badges and accent-tinted pills (search filter chips and result badges, session tab mode pills, respawn state, Ralph priority and circuit-breaker badges, tunnel and voice status, mobile case picker) no longer keep their pale light-on-dark ink under a light skin, where it measured 1.0 to 1.9:1 and made the search filter chips invisible.

New static regression `test/skin-themes.test.ts` guards the four-way parity between the CSS token block, the xterm palette, the pre-paint allowlist and the Settings picker.
