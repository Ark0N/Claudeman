# Session lineage lines (spawn lines between tabs)

**Goal:** when a session spawns another session (the `codeman` agent skill starting a
worker, or anything else that says who it is), draw the same kind of glowing connection
line the subagent windows already use, but **tab → tab**, so a glance at the strip shows
which tab spawned which.

Status: PLAN. Nothing implemented yet.

---

## 1. The blocking fact: no parent relationship exists today

There is no spawn-parent link between sessions anywhere in the codebase:

- `SessionState` (`src/types/session.ts:388`) has no `parentSessionId` / `spawnedBy` /
  `createdBy`.
- `POST /api/quick-start` and `POST /api/sessions` record only `owner = ownerFor(req)`,
  which is the multi-user **human**, not the calling session.
- The only parent links that do exist are `TeamConfig.leadSessionId` (agent teams) and
  `subagent-parents.json` (a frontend **window-layout** store for subagent windows).
  Neither says "session A spawned session B".
- Nothing in the HTTP request identifies the caller: an agent's spawn call is plain
  `curl` from inside a tmux pane, so there is no socket-level identity to recover
  (`SO_PEERCRED` needs a unix socket; the API is TCP).

So the caller has to **tell** us. It already knows its own id: every managed pane gets
`CODEMAN_SESSION_ID` exported by `session-cli-builder.ts` (and the skill's §0 preamble
already binds it to `$SELF`).

## 2. Wire format

Two ways in, because they serve different callers. Body wins when both are present.

| Where | Shape | Who uses it |
| --- | --- | --- |
| body field | `"parentSessionId": "<uuid>"` | anything hand-writing one create call |
| request header | `X-Codeman-Parent-Session: <uuid>` | the skill: added **once** to the `CURL` array in the §0 preamble, so every present and future create call carries it with no per-recipe edit |

Rules, all of them deliberate:

- **Advisory decoration only.** It never grants access, never scopes anything, never
  affects lifecycle. A child is not killed when its parent dies; the line just stops
  being drawn once the parent tab is gone.
- **Never fails a spawn.** An unknown / stale / foreign parent id is silently dropped
  (field ends up `undefined`), not a `400`. A cosmetic field must not be able to break
  worker creation.
- **Resolved, not trusted.** The id must match a live session the caller can already
  see (`canAccessOwned`), and the resolved parent's `owner` must equal the new
  session's `owner`. Otherwise a user could staple their session under another user's
  tab in multi-user mode.
- Exact id match first; a `>= 8`-char **unique** prefix match as a fallback (ids appear
  truncated in mux names and UI surfaces; ambiguous prefixes resolve to nothing).

## 3. Server changes

| File | Change |
| --- | --- |
| `src/types/session.ts` | `SessionState.parentSessionId?: string` with a doc comment saying it is UI decoration and never a permission signal |
| `src/session.ts` | constructor option `parentSessionId` → `_parentSessionId`, public getter, emitted from `toState()` (~line 1170) |
| `src/web/schemas.ts` | `parentSessionId: z.string().max(100).optional()` on `CreateSessionSchema` (272) and `QuickStartSchema` (680). Neither is `.strict()`, so this is additive |
| `src/web/route-helpers.ts` | new `resolveParentSessionId(ctx, req, bodyValue, owner)` implementing §2's rules; returns `string \| undefined`, never throws |
| `src/web/routes/session-routes.ts` | pass it into the three `new Session({...})` sites: `POST /api/sessions` (846), `POST /api/run` (2522), `POST /api/quick-start` (2896) |
| `src/web/server.ts` | recovery path (~2617): `parentSessionId: savedState?.parentSessionId` so the link survives a restart |

**No new SSE event.** `session_created` / `session_updated` broadcast
`getSessionStateWithRespawn(session)`, which is `toState()`-derived, so the field rides
along to the browser for free — and the frontend already does
`this.sessions.set(data.id, data)`, so `session.parentSessionId` is simply there.

Optional follow-up: surface it on `/api/sessions/unified` rows so the Session Manager
and the home rails can show "spawned by w3-claudeman".

## 4. Frontend rendering

### 4.1 Where the code goes

`_updateConnectionLinesImmediate()` (`subagent-windows.js:242`) is a strict
**batched read → batched write** pass, and it already has an extension point:
ultracode appends its own layer via `_appendUltracodeConnectionLines(svg, rects)` at
the end, sharing the `rects` cache so no layer forces a second reflow.

Lineage lines follow that exactly: a new module `src/web/public/session-lineage.js`
(load order 15.6, after `ultracode-windows.js`) exporting
`_appendLineageConnectionLines(svg, rects)` onto `CodemanApp.prototype`, called from the
same tail. **The core function keeps ownership of the read/write split**; the new layer
only reads through the shared `rects` map and only appends paths.

The path math itself lives in `constants.js` as a pure
`computeLineagePath(parentRect, childRect, stripRect, depth)` — same treatment as
`computeTabScrollLeft`, so the geometry is unit-testable without a browser.

### 4.2 Geometry

Both endpoints are tabs in one horizontal strip, so the subagent shape (tab-bottom →
window-top) does not apply. **One case**, a **U-bridge hanging below the strip** that
touches both tabs on their bottom edge:

```
y0 = max(parent.bottom, child.bottom)
d  = clamp(14 + |x2 - x1| * 0.085, 22, 104) + depth * 8 + |child.bottom - parent.bottom|
path: M x1 parent.bottom  C x1 y0+d, x2 y0+d, x2 child.bottom
```

`depth` is the child's index among its siblings, so several children of one parent
**nest** instead of overprinting.

> **Superseded (2026-08-14): the two shapes this section used to specify.** The dip was
> `clamp(14 + span * 0.06, 16, 44) + depth * 6`, and a wrapped strip
> (`tabs-two-rows` / `tabs-auto-wrap`) got its own parent-bottom → child-**top** bezier.
> Both were tuned against two tabs side by side and failed at the distances the feature
> is used at:
>
> - a skill worker is appended to the **end** of the strip, so the real span is
>   800-1500px, where a 44px cap is a 33px sag, i.e. a line that reads as straight and
>   crosses the terminal instead of bracketing under the strip;
> - and when the strip wraps, parent-bottom (34) to child-top (48) leaves **14px** to
>   bend in, so the arc was a flat line hidden in the row gap, with siblings drawn on
>   top of each other. Reported as *"they connect already, but the lines are straight
>   and not easy visible"*.
>
> Anchoring both ends at the tab bottoms and hanging the control points below the
> **lower** row gives the wrapped case the same bracket as the flat one, and removes the
> branch. Pinned by `test/session-lineage-lines.test.ts`.

A small `<circle r="3.5">` at the child end marks direction (it breathes to 4.5 while that worker is busy) (an SVG `marker` would need a
`<defs>` block and fights `stroke-dasharray`).

Each path gets `class="connection-line lineage-line"`, `data-parent-tab`,
`data-child-tab`, and `data-agent-id="lineage:<childId>"` — that last one is what makes
the existing entrance machinery (`markConnectionLineEntering` / `_applyLineEntrances`,
keyed on `data-agent-id`) work on these lines with **zero** new animation code,
including the negative-`animation-delay` resume across the `svg.innerHTML = ''` rebuild.

### 4.3 Clipping

`.session-tabs` is `overflow-x: auto`, so a tab scrolled out of the strip still has a
rect — one that lies outside the strip box and would draw an arc across the logo or the
header buttons. **Skip any edge whose parent or child center falls outside
`stripRect` (4px tolerance).** Skipping is honest; clamping would draw a line to a tab
that is not there.

### 4.4 Redraw triggers

`updateConnectionLines()` already coalesces through `scheduleBackground`, so extra
callers are cheap. Needed:

- `_fullRenderSessionTabs()` — already calls it (app.js:3912). Free.
- `_renderSessionTabsImmediate()` — does **not**. A badge appearing widens a tab and
  moves every tab after it, which slides the arcs off their anchors. Add the call,
  guarded on `this._lineageEdgeCount > 0` so nobody pays for it without the feature.
- **strip `scroll`** (passive listener on `#sessionTabs`) — the arcs must track the
  scroller. This is new; no existing line layer needed it.
- window `resize` — piggyback the throttled handler in `terminal-ui.js:930`.
- `_onSessionCreated` — `markConnectionLineEntering('lineage:' + data.id)` so a new
  child draws in **if** the user has a line-entrance theme on (all entrance styles are
  `legacy`/off by default, so this is a no-op for an untouched install).

### 4.5 Styling

`.connection-line.lineage-line`: blue stroke from the per-skin `--session-blue` token
(violet until 2026-08-14, changed because it lost contrast against the terminal's own
dim foreground the moment the arc crossed text),
`stroke-width: 2.5`, `dasharray 5 5`, `opacity: .72` (`.95` while the child works),
softer than the subagent lines so the two layers still read as different things now that
hue no longer separates them (shape does most of that work: a lineage arc hangs under the
strip and never reaches a window), but the contrast against the terminal comes from a
**second, wider glow** rather than more weight, because the first
cut (2px / `4 4` / `.55` / one 5px glow) disappeared into terminal text on a real 1080p
desktop. `lineage-flow` marches by two dash cycles, so it moves with the dash array
(`5 5` → `-20`). Trap to respect: the skin block nests under
`html:not([data-skin="og"])`, so a bare `.lineage-line` rule inside it would outrank the
base rule at higher specificity. **Define the color as a token per skin, keep exactly
one `.lineage-line` rule.** Light skins get a darker stroke.

Optional signal worth having: `.lineage-line--working` (a slow `stroke-dashoffset`
march) only while the **child** session is working, wrapped in
`prefers-reduced-motion: no-preference`. Static otherwise — a permanently marching line
per tab pair is noise and battery.

### 4.6 Desktop only, and why

The SVG overlay is `z-index: 999`. On desktop the header is `z-index: 100`, so arcs
paint **over** the header and can touch tab bottoms. Under 1024px `mobile.css` makes the
header `position: fixed; z-index: 1200`, which would **bury** the arcs — and the phone
strip is a scroller where both endpoints are rarely on screen together anyway. So the
layer returns early unless `MobileDetection.getDeviceType() === 'desktop'`.

Raising the SVG to ~1250 (above the fixed header, below modals at 1300) is a possible
phase 2, but it needs a real check against the mobile overview and the drawer.

### 4.7 Setting

`sessionLineageLines`, **per-device** — so it goes in the `displayKeys` set in
`settings-ui.js` and must **not** be added to `SettingsUpdateSchema` (`.strict()`;
sending an undeclared key fails the whole PUT). Rendered as a switch in
App Settings → Appearance, beside the entrance-animation pickers.

**Default: ON for desktop** (phones never render it). This is the one deliberate
departure from the "new visual surfaces ship OFF" convention — the feature is the
request, and a user with 12 unrelated tabs has a one-click off switch. Flag for the
owner if the convention should win instead.

## 5. Optional extras (call them separately, none are required)

1. **Order children after their parent** in `sessionOrder` on create, so arcs stay short
   and the strip reads as a tree. Real cost: it renumbers the Alt+N badges and moves
   tabs under the user's cursor, so it should be its own toggle, default OFF.
2. **Lineage hover focus**: hovering a tab dims unrelated arcs and brightens its own
   subtree.
3. **"Spawned by" in the Session Manager / home rails**, once `parentSessionId` is on
   the unified rows.
4. **Inherited tab tint**: children pick up a faded version of the parent's tab color.

## 6. Tests

- `test/session-lineage.test.ts` (route-level, `app.inject`): round-trips through
  `POST /api/sessions` + `POST /api/quick-start`, header path, body-wins-over-header,
  unknown id dropped without failing the spawn, cross-owner parent dropped in
  multi-user, field present in `GET /api/sessions` and persisted state.
- `test/session-lineage-lines.test.ts` (jsdom, pure): `computeLineagePath` — same-row U,
  wrapped-row bezier, sibling nesting depth, off-strip skip, degenerate zero-width rects.
- Browser check (not in `test:ci`): spawn two workers with a parent, assert two
  `path.lineage-line` elements anchored to the right tabs, then scroll the strip and
  assert they moved.
- Existing guards that must stay green: `test/mobile-header-buttons-policy.test.ts`
  (nothing new on phones), `test/app-settings-structure.test.ts` (the new switch pairs
  with its rail section).

## 7. Skill side (owned by the release session, not this plan)

One line in the `codeman` skill's §0 preamble covers every spawn recipe:

```bash
CURL=(curl -sk "${AUTH[@]}" -H "X-Codeman-Parent-Session: $SELF")
```

plus a `CODEMAN_PREAMBLE` version bump so stale cached preambles fail loudly instead of
silently spawning unparented workers. Recipes that build a create payload by hand can
alternatively send `"parentSessionId":"'"$SELF"'"`.

## 8. Docs to update when it lands

`CLAUDE.md` (a Key Patterns bullet), `docs/architecture-invariants.md` (new anchor: the
resolve-don't-trust rule, the desktop-only z-index reason, the shared `rects` pass),
`docs/api-reference.md` (the new field + header on the create endpoints).
