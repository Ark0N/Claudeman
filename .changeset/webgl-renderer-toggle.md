---
"aicodeman": patch
---

Add a **WebGL Renderer** toggle to Settings → Appearance (desktop). WebGL stays on by default; turning it off forces the DOM renderer for users who hit GPU glitches, without needing the `?nowebgl` URL param. Turning it back on (or `?webgl=force`) clears any stale auto-fallback marker. The existing mobile skip and long-task auto-fallback safety net are unchanged. The skip decision is factored into a pure, unit-tested `shouldSkipWebGL()` helper.
