/**
 * @fileoverview Shared constants, utility functions, and SSE event type registry for all frontend modules.
 *
 * This is the first script loaded in index.html. Every other frontend module depends on the
 * globals defined here: timing constants, Z-index layers, respawn
 * preset definitions, the SSE_EVENTS registry, and shared utilities (escapeHtml,
 * getEventCoords, scheduleBackground, urlBase64ToUint8Array).
 *
 * @globals {function} urlBase64ToUint8Array - VAPID key conversion for Web Push
 * @globals {function} scheduleBackground - scheduler.postTask wrapper (background priority)
 * @globals {function} getEventCoords - Unified mouse/touch coordinate extractor
 * @globals {function} escapeHtml - XSS-safe HTML escaping
 * @globals {object} SSE_EVENTS - Centralized SSE event type constants (120 event types; must match backend src/web/sse-events.ts)
 * @globals {Array} BUILTIN_RESPAWN_PRESETS - Built-in respawn configuration presets
 *
 * @dependency None (first in load order)
 * @loadorder 1 of 15 — constants.js → mobile-handlers.js → voice-input.js → notification-manager.js
 *   → keyboard-accessory.js → input-cjk.js → app.js → terminal-ui.js → respawn-ui.js
 *   → ralph-panel.js → settings-ui.js → panels-ui.js → session-ui.js → ralph-wizard.js
 *   → api-client.js → subagent-windows.js
 */

// Codeman — Shared constants and utility functions for frontend modules

// ═══════════════════════════════════════════════════════════════
// Web Push Utilities
// ═══════════════════════════════════════════════════════════════

/** Convert a base64-encoded VAPID key to Uint8Array for pushManager.subscribe() */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

// Default terminal scrollback (can be changed via settings)
const DEFAULT_SCROLLBACK = 50000;

// Timing constants
const STUCK_THRESHOLD_DEFAULT_MS = 600000;  // 10 minutes - default for stuck detection
const GROUPING_TIMEOUT_MS = 5000;           // 5 seconds - notification grouping window
const NOTIFICATION_LIST_CAP = 100;          // Max notifications in list
const TITLE_FLASH_INTERVAL_MS = 1500;       // Title flash rate
const BROWSER_NOTIF_RATE_LIMIT_MS = 3000;   // Rate limit for browser notifications
const MOBILE_RESIZE_RETRY_MS = 30000;       // Small-viewport resize re-send while a desktop sizing claim is hot
const AUTO_CLOSE_NOTIFICATION_MS = 8000;    // Auto-close browser notifications
const THROTTLE_DELAY_MS = 100;              // General UI throttle delay
const TERMINAL_CHUNK_SIZE = 32 * 1024;      // 32KB chunks for terminal buffer loading
const TERMINAL_TAIL_SIZE = 1024 * 1024;     // 1MB tail for initial load (more scrollback on tab switch)
const SYNC_WAIT_TIMEOUT_MS = 50;            // Wait timeout for terminal sync
const STATS_POLLING_INTERVAL_MS = 2000;     // System stats polling
const TUI_REDRAW_SETTLE_MS = 400;           // Grace for a TUI to redraw after a real resize, before fetching its buffer

// Z-index base values for layered floating windows
const ZINDEX_SUBAGENT_BASE = 1000;
const ZINDEX_PLAN_SUBAGENT_BASE = 1100;
const ZINDEX_LOG_VIEWER_BASE = 2000;
const ZINDEX_IMAGE_POPUP_BASE = 3000;

// Subagent/floating window layout
const WINDOW_INITIAL_TOP_PX = 120;
const WINDOW_CASCADE_OFFSET_PX = 30;
const WINDOW_MIN_WIDTH_PX = 200;
const WINDOW_MIN_HEIGHT_PX = 200;
const WINDOW_DEFAULT_WIDTH_PX = 300;

// WebGL renderer auto-fallback thresholds.
// _installWebGLLongTaskGuard() observes longtask entries and disables WebGL
// after LONGTASK_COUNT stalls of >= LONGTASK_MS within WINDOW_MS. GRACE_MS
// suppresses the noisy initial-load stalls. STICKY_EXPIRY_MS is how long
// localStorage's webgl-disabled marker survives before we retry WebGL on a
// fresh load (driver/Chrome may have been updated).
const WEBGL_FALLBACK = {
  LONGTASK_MS: 200,
  LONGTASK_COUNT: 3,
  WINDOW_MS: 30000,
  GRACE_MS: 5000,
  STICKY_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Pure rolling-window trip evaluator for the WebGL longtask guard.
 * Mutates `recent` in place (prunes entries older than `now - WINDOW_MS`)
 * and appends each new duration's startTime that meets the threshold.
 * Returns true when the count inside the window reaches `LONGTASK_COUNT`.
 *
 * Exposed on `window` for unit testing — the production guard in app.js
 * inlines this same logic in its PerformanceObserver callback. Splitting it
 * out keeps the threshold math testable without a real PerformanceObserver.
 *
 * @param {number[]} recent - mutable array of startTimes inside the window
 * @param {{startTime: number, duration: number}[]} entries - new longtask entries
 * @param {number} now - performance.now() at evaluation time
 * @param {typeof WEBGL_FALLBACK} [config=WEBGL_FALLBACK] - thresholds
 * @returns {boolean} true if the rolling window has reached the trip count
 */
function evaluateWebGLLongTaskTrip(recent, entries, now, config = WEBGL_FALLBACK) {
  for (const entry of entries) {
    if (entry.duration >= config.LONGTASK_MS) recent.push(entry.startTime);
  }
  while (recent.length && now - recent[0] > config.WINDOW_MS) recent.shift();
  return recent.length >= config.LONGTASK_COUNT;
}

/**
 * Pure decision for whether to skip the WebGL renderer at terminal init, and
 * whether to clear the auto-fallback sticky marker. Keeps the interaction
 * between device type, URL params, the sticky marker, and the user's settings
 * toggle in one testable place (terminal-ui.js calls this).
 *
 * Precedence (desktop only — mobile always skips):
 *   1. user toggle OFF        -> skip (one-shot opt-out, sticky untouched)
 *   2. ?nowebgl               -> skip (one-shot opt-out, sticky untouched)
 *   3. ?webgl=force           -> enable + clear stale sticky marker
 *   4. toggle ON / untouched  -> respect the auto-fallback sticky marker
 *
 * A stored `true` is treated like the untouched default here: the checkbox
 * ships checked on desktop, so any unrelated settings save stores `true` —
 * letting it clear the marker would permanently defeat the GPU-stall
 * auto-fallback safety net. The marker is only retired by ?webgl=force or by
 * a real OFF->ON toggle flip, which saveAppSettings() detects at save time.
 *
 * @param {{deviceType?: string, noWebglParam?: boolean, forceParam?: boolean,
 *          stickyDisabled?: boolean, userPrefEnabled?: (boolean|undefined)}} [input]
 * @returns {{skip: boolean, clearSticky: boolean}}
 */
function shouldSkipWebGL(input = {}) {
  if (input.deviceType !== 'desktop') return { skip: true, clearSticky: false };
  if (input.userPrefEnabled === false) return { skip: true, clearSticky: false };
  if (input.noWebglParam) return { skip: true, clearSticky: false };
  if (input.forceParam) return { skip: false, clearSticky: true };
  return { skip: !!input.stickyDisabled, clearSticky: false };
}

// Expose for tests. `const` declarations at the top of a non-module script
// are global lexical bindings but not `window` properties, so explicit
// assignment is the test-visible API surface.
// Desktop tab-overflow policy: auto-wrap the session tabs to a second row when
// they overflow one row (and the user hasn't pinned the manual two-row layout).
function shouldAutoWrapTabs(input) {
  if (!input || input.deviceType !== 'desktop') return false;
  if (input.manualTwoRows) return false;
  if ((input.tabCount || 0) < 2) return false;

  const scrollWidth = Number(input.scrollWidth) || 0;
  const clientWidth = Number(input.clientWidth) || 0;
  return scrollWidth > clientWidth + 1;
}

// Sliver of the neighbouring tab left visible when the strip scrolls a tab into
// view. Landing a tab flush against the edge reads as "this is the last one";
// the gap is what tells the user there is more strip to swipe to.
const TAB_SCROLL_REVEAL_PX = 16;

// Phone/tablet tab-strip scroll policy (issue #257). Those breakpoints scroll
// the strip horizontally (desktop wraps to a second row instead and never
// scrolls), so the active tab can sit entirely outside the visible slice with
// no way back except a swipe the user may not know is possible.
//
// Returns the scrollLeft that puts the tab inside the window, clamped to the
// scrollable range, and returns the CURRENT scrollLeft when the tab is already
// visible: callers compare and skip the write, so an already-correct strip is
// never nudged. Pure: the caller measures, this decides.
function computeTabScrollLeft(input) {
  const scrollWidth = Number(input?.scrollWidth) || 0;
  const clientWidth = Number(input?.clientWidth) || 0;
  const maxScroll = Math.max(0, scrollWidth - clientWidth);
  if (maxScroll === 0 || clientWidth <= 0) return 0;

  const pad = input?.padding == null ? TAB_SCROLL_REVEAL_PX : Number(input.padding) || 0;
  const tabLeft = Number(input?.tabLeft) || 0;
  const tabWidth = Number(input?.tabWidth) || 0;
  const tabRight = tabLeft + tabWidth;
  const viewLeft = Math.min(Math.max(Number(input?.scrollLeft) || 0, 0), maxScroll);
  const viewRight = viewLeft + clientWidth;

  let target = viewLeft;
  if (tabWidth + pad >= clientWidth) {
    // Tab is as wide as the window (long session name on a narrow phone):
    // there is no position that shows all of it plus padding, so align its
    // start, since the name matters more than the trailing badges.
    target = tabLeft;
  } else if (tabLeft - pad < viewLeft) {
    target = tabLeft - pad;
  } else if (tabRight + pad > viewRight) {
    target = tabRight + pad - clientWidth;
  }
  return Math.min(Math.max(Math.round(target), 0), maxScroll);
}

// Session lineage lines — geometry for the arc drawn between a tab and a tab it
// spawned (a worker started through the codeman agent skill, which passes its own
// id as parentSessionId). Pure: the caller measures and appends, this decides.
//
// ONE shape, because both endpoints live in the same horizontal strip and the subagent
// shape (tab-bottom → window-top) has nothing to aim at: a U-bridge HANGING BELOW the
// strip, from the parent's bottom edge to the child's bottom edge, so it reads as a
// bracket joining two tabs rather than as a line crossing them. The dip grows with
// horizontal distance and with `depth` (the child's index among its siblings), so
// several children of one parent nest instead of overprinting.
//
// ⚠ A WRAPPED STRIP USED TO GET ITS OWN SHAPE, AND THAT SHAPE WAS THE BUG. When the
// desktop strip wraps (`tabs-two-rows` / `tabs-auto-wrap`) a parent on row 1 and its
// child on row 2 are ~4px apart vertically, so the old parent-bottom → child-TOP bezier
// had a 4px span to work with and drew a flat horizontal line inside the row gap
// (reported as "they connect already, but the lines are straight and not easy visible"),
// and three siblings drew three of them on top of each other. Aiming BOTH ends at the
// tab BOTTOMS and putting the control points below the LOWER row gives the wrapped case
// the same bracket as the flat case: it leaves the parent downward, crosses the lower
// row once, and comes back up under the child. Same formula, no branch.
//
// Returns null when the edge must not be drawn: a missing/degenerate rect, or an
// endpoint scrolled outside the strip. `.session-tabs` is `overflow-x: auto`, so a
// scrolled-out tab still HAS a rect — one lying over the logo or the header
// buttons. Skipping is honest; clamping would point at a tab that isn't there.
// ⚠ THE DIP IS WHAT MAKES THE ARC AN ARC, and the first shipped numbers were tuned
// against two tabs sitting side by side. A worker the agent skill starts is appended
// to the END of the strip, so the real span between a lead and its worker is 800-1500px,
// not 200, and a 44px cap over 1300px of span is a 33px sag, i.e. a line that reads as
// STRAIGHT and crosses the terminal instead of bracketing under the strip. The dip now
// keeps growing with the span (0.085/px, ~3x steeper against the old cap) so the bracket
// survives the distance the feature is actually used at. The ceiling is what keeps a
// full-width pair out of the terminal's fourth line: 104 + the sibling step lands the
// deepest sag around y=140 on a 1080 screen, the same proportion two adjacent tabs get.
const LINEAGE_DIP_BASE_PX = 14;
const LINEAGE_DIP_PER_PX = 0.085;
const LINEAGE_DIP_MIN_PX = 22;
const LINEAGE_DIP_MAX_PX = 104;
// Siblings nest by this much. Widened with the stroke: at 2.5px plus its glow, arcs 6px
// apart bled into one thick band instead of reading as three separate lines.
const LINEAGE_SIBLING_STEP_PX = 8;
const LINEAGE_STRIP_TOLERANCE_PX = 4;

function computeLineagePath(input) {
  const parent = input?.parent;
  const child = input?.child;
  if (!parent || !child) return null;

  const pw = Number(parent.width) || 0;
  const ph = Number(parent.height) || 0;
  const cw = Number(child.width) || 0;
  const ch = Number(child.height) || 0;
  if (pw <= 0 || ph <= 0 || cw <= 0 || ch <= 0) return null;

  const px = Number(parent.left) + pw / 2;
  const cx = Number(child.left) + cw / 2;
  if (!Number.isFinite(px) || !Number.isFinite(cx)) return null;

  const strip = input?.strip;
  if (strip && Number(strip.width) > 0) {
    const min = Number(strip.left) - LINEAGE_STRIP_TOLERANCE_PX;
    const max = Number(strip.left) + Number(strip.width) + LINEAGE_STRIP_TOLERANCE_PX;
    if (px < min || px > max || cx < min || cx > max) return null;
  }

  const depth = Math.max(0, Math.min(6, Number(input?.depth) || 0));
  const pTop = Number(parent.top);
  const pBottom = pTop + ph;
  const cTop = Number(child.top);
  const cBottom = cTop + ch;
  const sameRow = Math.abs(pTop + ph / 2 - (cTop + ch / 2)) <= Math.min(ph, ch) / 2;

  // Both ends anchor on the tab BOTTOM, and the control points hang below whichever
  // row is lower, so one formula covers a flat strip and a wrapped one.
  const span = Math.abs(cx - px);
  const rowDrop = Math.abs(cBottom - pBottom);
  // ⚠ A wrapped pair needs the dip measured from the LOWER row, or the bracket would
  // only reach the row gap again. Adding the row offset also keeps the curve clear of
  // the row it crosses instead of grazing its bottom edge.
  const dip =
    Math.min(LINEAGE_DIP_MAX_PX, Math.max(LINEAGE_DIP_MIN_PX, LINEAGE_DIP_BASE_PX + span * LINEAGE_DIP_PER_PX)) +
    depth * LINEAGE_SIBLING_STEP_PX +
    rowDrop;
  const yc = Math.max(pBottom, cBottom) + dip;
  const d = `M ${r1(px)} ${r1(pBottom)} C ${r1(px)} ${r1(yc)}, ${r1(cx)} ${r1(yc)}, ${r1(cx)} ${r1(cBottom)}`;
  return { d, endX: cx, endY: cBottom, sameRow };
}

// One decimal is plenty for a screen-space path and keeps the `d` string short.
function r1(n) {
  return Math.round(n * 10) / 10;
}

// COD-134 — Terminal WebSocket reconnect policy.
//
// Decide what to do after a terminal WebSocket closes, given the close `code`
// and `attempt` (0-based count of consecutive reconnects already made):
//   - transient closes (code < 4004: 1000/1001/1005/1006/etc.) → 'reconnect'
//     with exponential backoff (0 on the first attempt; the caller adds jitter),
//     250ms → 500 → 1000 → ... capped at 10s.
//   - 4004 (session not found) / 4009 (session terminated) → 'give-up': the
//     session is gone, retrying only wastes connections.
//   - 4008 (too many connections) and any other code >= 4004 → 'retry-fallback':
//     show the HTTP fallback but keep retrying on a bounded 5s timer so the
//     transport returns to WS once the transient condition clears (un-stick).
// Pure: no DOM, no side effects.
function planWsReconnect(code, attempt) {
  if (code === 4004 || code === 4009) {
    return { action: 'give-up', delayMs: 0 };
  }
  if (code >= 4004) {
    return { action: 'retry-fallback', delayMs: 5000 };
  }
  const delayMs = attempt <= 0 ? 0 : Math.min(250 * Math.pow(2, attempt - 1), 10000);
  return { action: 'reconnect', delayMs };
}

// Connection-loss UI policy.
//
// With the service worker serving the cached app shell, Codeman still *renders*
// when the server is unreachable (phone off the tailnet, VPN down, server
// stopped): a dashboard with no sessions and an 8px red dot in the header
// corner. That reads as "there are no sessions", not "you are not connected".
// This decides what the app surfaces instead:
//
//   'overlay': full-screen "can't reach Codeman". Used while the page has
//               never loaded server state, where the UI behind it is empty
//               anyway, so blocking it costs nothing and explains everything.
//   'banner':  non-blocking bar under the header. Used once state HAS loaded,
//               so the terminal scrollback stays readable while the link is down.
//   'hidden':  connected, or still inside the grace window.
//
// Grace: a COM deploy restarts the server and SSE is back in ~200ms. Shouting
// on every deploy trains the user to ignore the warning, so a transport that is
// merely *not yet connected* gets CONNECTION_LOSS_GRACE_MS to recover.
// `navigator.onLine === false` skips the grace entirely: the device itself is
// saying there is no network, which is never a 200ms blip.
//
// Pure: no DOM, no timers, no side effects. `now` is passed in.
const CONNECTION_LOSS_GRACE_MS = 2500;

function computeConnectionLossUi(input) {
  const {
    isOnline = true,
    status = 'connected',
    everLoaded = false,
    downSince = null,
    now = 0,
    nextRetryAt = null,
    overlayDismissed = false,
    retryPending = false,
  } = input || {};

  const hidden = { mode: 'hidden', kind: 'connected', title: '', detail: '', retryInSec: null };

  // The browser's own offline flag outranks the transport state: no network
  // means no reconnect is coming until it returns.
  const hardOffline = !isOnline || status === 'offline';
  if (!hardOffline) {
    if (status === 'connected') return hidden;
    const downMs = downSince == null ? 0 : Math.max(0, now - downSince);
    if (downMs < CONNECTION_LOSS_GRACE_MS) return { ...hidden, kind: 'connecting' };
  }

  // Dismissing the overlay ("show cached view") demotes it to the banner for
  // the rest of this outage, never back to invisible.
  const mode = everLoaded || overlayDismissed ? 'banner' : 'overlay';
  // A retry the user just triggered has no scheduled time; the caller renders
  // an indeterminate "Retrying…" for null.
  const retryInSec =
    retryPending || nextRetryAt == null ? null : Math.max(0, Math.ceil((nextRetryAt - now) / 1000));

  if (hardOffline) {
    return {
      mode,
      kind: 'offline',
      title: 'No network connection',
      detail: 'This device is offline. Codeman is showing the last cached view.',
      retryInSec,
    };
  }
  return {
    mode,
    kind: 'unreachable',
    title: "Can't reach the Codeman server",
    detail:
      'This device has a network, but the Codeman server is not answering. ' +
      'If you reach Codeman over Tailscale or a VPN, check that it is connected.',
    retryInSec,
  };
}

// SSE staleness policy: is this stream a zombie?
//
// An EventSource that stops delivering does not always error. A proxy that
// idle-closed the connection, a laptop resumed from sleep, a tailnet
// reconnect: `onerror` never fires, the header dot stays green, and every
// SSE-driven surface (tab status dots, sessions created on another device,
// renames) freezes until the user reloads. The server writes a
// `sse:heartbeat` frame every 15s, so silence longer than three of them means
// the stream is dead even though the transport still claims otherwise.
//
// Stale ONLY when the transport believes it is 'connected': the other states
// already have the reconnect/backoff machinery running, and re-firing on top
// of them would stack reconnects. That guard is also the loop breaker: a
// forced reconnect leaves 'connected' immediately, so the watchdog cannot
// fire again while one is in flight. `navigator.onLine === false` is not
// staleness either; there is nothing to reconnect to yet.
//
// Pure: no DOM, no timers, no side effects. `now` is passed in.
const SSE_STALE_TIMEOUT_MS = 45000; // three missed 15s heartbeats

function computeSseStale(input) {
  const {
    lastMessageAt = null,
    now = 0,
    status = 'connected',
    isOnline = true,
    timeoutMs = SSE_STALE_TIMEOUT_MS,
  } = input || {};
  if (!isOnline || status !== 'connected') return false;
  // No frame has ever arrived: `init` lands on connect, so this is a stream
  // that has not opened yet rather than one that went quiet.
  if (typeof lastMessageAt !== 'number' || !(lastMessageAt > 0)) return false;
  return now - lastMessageAt >= timeoutMs;
}

if (typeof window !== 'undefined') {
  window.WEBGL_FALLBACK = WEBGL_FALLBACK;
  window.evaluateWebGLLongTaskTrip = evaluateWebGLLongTaskTrip;
  window.shouldSkipWebGL = shouldSkipWebGL;
  window.CodemanTabOverflow = {
    shouldAutoWrapTabs,
    computeTabScrollLeft,
    TAB_SCROLL_REVEAL_PX,
  };
  window.CodemanWsReconnect = {
    plan: planWsReconnect,
  };
  window.CodemanLineage = {
    computePath: computeLineagePath,
    DIP_MIN_PX: LINEAGE_DIP_MIN_PX,
    DIP_MAX_PX: LINEAGE_DIP_MAX_PX,
    SIBLING_STEP_PX: LINEAGE_SIBLING_STEP_PX,
  };
  window.CodemanConnectionLoss = {
    compute: computeConnectionLossUi,
    GRACE_MS: CONNECTION_LOSS_GRACE_MS,
  };
  window.CodemanSseStale = {
    compute: computeSseStale,
    TIMEOUT_MS: SSE_STALE_TIMEOUT_MS,
  };
}

// Scheduler API — prioritize terminal writes over background UI updates.
// scheduler.postTask('background') defers non-critical work (connection lines, panel renders)
// so the main thread stays free for terminal rendering at 60fps.
const _hasScheduler = typeof globalThis.scheduler?.postTask === 'function';
function scheduleBackground(fn) {
  if (_hasScheduler) { scheduler.postTask(fn, { priority: 'background' }); }
  else { requestAnimationFrame(fn); }
}

// DEC mode 2026 marker stripping — xterm.js 6.0 handles sync natively,
// but server-sent terminal buffers may still contain markers from Claude CLI.
const DEC_SYNC_STRIP_RE = /\x1b\[\?2026[hl]/g;

// Built-in respawn configuration presets
const BUILTIN_RESPAWN_PRESETS = [
  {
    id: 'solo-work',
    name: 'Solo',
    description: 'Claude working alone — fast respawn cycles with context reset',
    config: {
      idleTimeoutMs: 3000,
      updatePrompt: 'summarize your progress so far before the context reset.',
      interStepDelayMs: 2000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'continue working. Pick up where you left off based on the context above.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 60,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'subagent-workflow',
    name: 'Subagents',
    description: 'Lead session with Task tool subagents — longer idle tolerance',
    config: {
      idleTimeoutMs: 45000,
      updatePrompt: 'check on your running subagents and summarize their results before the context reset. If all subagents have finished, note what was completed and what remains.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'check on your running subagents and continue coordinating their work. If all subagents have finished, summarize their results and proceed with the next step.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 240,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'team-lead',
    name: 'Team',
    description: 'Leading an agent team via TeamCreate — tolerates long silences',
    config: {
      idleTimeoutMs: 90000,
      updatePrompt: 'review the task list and teammate progress. Summarize the current state before the context reset.',
      interStepDelayMs: 5000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'check on your teammates by reviewing the task list and any messages in your inbox. Assign new tasks if teammates are idle, or continue coordinating the team effort.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'ralph-todo',
    name: 'Ralph/Todo',
    description: 'Ralph Loop task list — works through todos with progress tracking',
    config: {
      idleTimeoutMs: 8000,
      updatePrompt: 'update CLAUDE.md with discoveries and progress notes, mark completed tasks in @fix_plan.md, write a brief summary so the next cycle can continue seamlessly.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'read @fix_plan.md for task status, continue on the next uncompleted task. When ALL tasks are complete, output <promise>COMPLETE</promise>.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'overnight-autonomous',
    name: 'Overnight',
    description: 'Unattended overnight runs with full context reset between cycles',
    config: {
      idleTimeoutMs: 10000,
      updatePrompt: 'summarize what you accomplished so far and write key progress notes to CLAUDE.md so the next cycle can pick up where you left off.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'continue working on the task. Pick up where you left off based on the context above.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
];

// ═══════════════════════════════════════════════════════════════
// SSE Event Types
// ═══════════════════════════════════════════════════════════════

/** @type {Record<string, string>} Centralized SSE event type constants */
const SSE_EVENTS = {
  // Core
  INIT: 'init',

  // Transport
  HEARTBEAT: 'sse:heartbeat',

  // Session lifecycle
  SESSION_CREATED: 'session:created',
  SESSION_UPDATED: 'session:updated',
  SESSION_DELETED: 'session:deleted',
  SESSION_TERMINAL: 'session:terminal',
  SESSION_NEEDS_REFRESH: 'session:needsRefresh',
  SESSION_CLEAR_TERMINAL: 'session:clearTerminal',
  SESSION_COMPLETION: 'session:completion',
  SESSION_ERROR: 'session:error',
  SESSION_EXIT: 'session:exit',
  SESSION_IDLE: 'session:idle',
  SESSION_WORKING: 'session:working',
  SESSION_AUTO_CLEAR: 'session:autoClear',
  SESSION_AUTO_COMPACT: 'session:autoCompact',
  SESSION_LIMIT_PAUSE_SCHEDULED: 'session:limitPauseScheduled',
  SESSION_LIMIT_RESUME: 'session:limitResume',
  SESSION_LIMIT_RESUME_CANCELLED: 'session:limitResumeCancelled',
  SESSION_RESPAWN_BREAKER_TRIPPED: 'session:respawnBreakerTripped',
  SESSION_CLI_INFO: 'session:cliInfo',
  SESSION_PINNED: 'session:pinned',
  SESSION_MESSAGE: 'session:message',
  SESSION_INTERACTIVE: 'session:interactive',
  SESSION_RUNNING: 'session:running',
  SESSION_STATUS_TELEMETRY: 'session:statusTelemetry',

  // Scheduled runs
  SCHEDULED_CREATED: 'scheduled:created',
  SCHEDULED_UPDATED: 'scheduled:updated',
  SCHEDULED_COMPLETED: 'scheduled:completed',
  SCHEDULED_STOPPED: 'scheduled:stopped',
  SCHEDULED_LOG: 'scheduled:log',
  SCHEDULED_DELETED: 'scheduled:deleted',

  // Cron jobs
  CRON_JOBS_CHANGED: 'cron:jobsChanged',
  CRON_JOB_DELETED: 'cron:jobDeleted',
  CRON_RUN_CREATED: 'cron:runCreated',
  CRON_RUN_UPDATED: 'cron:runUpdated',

  // Respawn
  RESPAWN_STARTED: 'respawn:started',
  RESPAWN_STOPPED: 'respawn:stopped',
  RESPAWN_STATE_CHANGED: 'respawn:stateChanged',
  RESPAWN_CYCLE_STARTED: 'respawn:cycleStarted',
  RESPAWN_CYCLE_COMPLETED: 'respawn:cycleCompleted',
  RESPAWN_BLOCKED: 'respawn:blocked',
  RESPAWN_STEP_SENT: 'respawn:stepSent',
  RESPAWN_STEP_COMPLETED: 'respawn:stepCompleted',
  RESPAWN_DETECTION_UPDATE: 'respawn:detectionUpdate',
  RESPAWN_AUTO_ACCEPT_SENT: 'respawn:autoAcceptSent',
  RESPAWN_AI_CHECK_STARTED: 'respawn:aiCheckStarted',
  RESPAWN_AI_CHECK_COMPLETED: 'respawn:aiCheckCompleted',
  RESPAWN_AI_CHECK_FAILED: 'respawn:aiCheckFailed',
  RESPAWN_AI_CHECK_COOLDOWN: 'respawn:aiCheckCooldown',
  RESPAWN_PLAN_CHECK_STARTED: 'respawn:planCheckStarted',
  RESPAWN_PLAN_CHECK_COMPLETED: 'respawn:planCheckCompleted',
  RESPAWN_PLAN_CHECK_FAILED: 'respawn:planCheckFailed',
  RESPAWN_TIMER_STARTED: 'respawn:timerStarted',
  RESPAWN_TIMER_CANCELLED: 'respawn:timerCancelled',
  RESPAWN_TIMER_COMPLETED: 'respawn:timerCompleted',
  RESPAWN_ACTION_LOG: 'respawn:actionLog',
  RESPAWN_LOG: 'respawn:log',
  RESPAWN_ERROR: 'respawn:error',
  RESPAWN_CONFIG_UPDATED: 'respawn:configUpdated',

  // Tasks
  TASK_CREATED: 'task:created',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  TASK_UPDATED: 'task:updated',

  // Mux (tmux)
  MUX_CREATED: 'mux:created',
  MUX_KILLED: 'mux:killed',
  MUX_DIED: 'mux:died',
  MUX_STATS_UPDATED: 'mux:statsUpdated',

  // Remote auto-reconnect (COD-108)
  REMOTE_SESSION_DROPPED: 'remote:sessionDropped',
  REMOTE_SESSION_RECONNECTED: 'remote:sessionReconnected',
  REMOTE_RECONNECT_EXHAUSTED: 'remote:reconnectExhausted',

  // Ralph
  SESSION_RALPH_LOOP_UPDATE: 'session:ralphLoopUpdate',
  SESSION_RALPH_TODO_UPDATE: 'session:ralphTodoUpdate',
  SESSION_RALPH_COMPLETION_DETECTED: 'session:ralphCompletionDetected',
  SESSION_RALPH_STATUS_UPDATE: 'session:ralphStatusUpdate',
  SESSION_CIRCUIT_BREAKER_UPDATE: 'session:circuitBreakerUpdate',
  SESSION_EXIT_GATE_MET: 'session:exitGateMet',

  // Bash tools
  SESSION_BASH_TOOL_START: 'session:bashToolStart',
  SESSION_BASH_TOOL_END: 'session:bashToolEnd',
  SESSION_BASH_TOOLS_UPDATE: 'session:bashToolsUpdate',

  // Session: Plan
  SESSION_PLAN_TASK_UPDATE: 'session:planTaskUpdate',
  SESSION_PLAN_CHECKPOINT: 'session:planCheckpoint',
  SESSION_PLAN_ROLLBACK: 'session:planRollback',
  SESSION_PLAN_TASK_ADDED: 'session:planTaskAdded',

  // Hooks (Claude Code hook events)
  HOOK_IDLE_PROMPT: 'hook:idle_prompt',
  HOOK_PERMISSION_PROMPT: 'hook:permission_prompt',
  HOOK_ELICITATION_DIALOG: 'hook:elicitation_dialog',
  HOOK_ELICITATION_COMPLETE: 'hook:elicitation_complete',
  HOOK_ELICITATION_RESPONSE: 'hook:elicitation_response',
  HOOK_STOP: 'hook:stop',
  HOOK_TEAMMATE_IDLE: 'hook:teammate_idle',
  HOOK_TASK_COMPLETED: 'hook:task_completed',

  // Approvals Inbox
  APPROVAL_PENDING: 'approval:pending',
  APPROVAL_UPDATED: 'approval:updated',
  APPROVAL_RESOLVED: 'approval:resolved',

  // Subagents (Claude Code background agents)
  SUBAGENT_DISCOVERED: 'subagent:discovered',
  SUBAGENT_UPDATED: 'subagent:updated',
  SUBAGENT_TOOL_CALL: 'subagent:tool_call',
  SUBAGENT_PROGRESS: 'subagent:progress',
  SUBAGENT_MESSAGE: 'subagent:message',
  SUBAGENT_TOOL_RESULT: 'subagent:tool_result',
  SUBAGENT_COMPLETED: 'subagent:completed',

  // Workflow runs (ultracode / Workflow tool)
  WORKFLOW_RUN_DISCOVERED: 'workflow:run_discovered',
  WORKFLOW_RUN_UPDATED: 'workflow:run_updated',
  WORKFLOW_RUN_REMOVED: 'workflow:run_removed',

  // Images
  IMAGE_DETECTED: 'image:detected',
  ATTACHMENT_DETECTED: 'attachment:detected',

  // Tunnel
  TUNNEL_STARTED: 'tunnel:started',
  TUNNEL_STOPPED: 'tunnel:stopped',
  TUNNEL_PROGRESS: 'tunnel:progress',
  TUNNEL_ERROR: 'tunnel:error',
  TUNNEL_QR_ROTATED: 'tunnel:qrRotated',
  TUNNEL_QR_REGENERATED: 'tunnel:qrRegenerated',
  TUNNEL_QR_AUTH_USED: 'tunnel:qrAuthUsed',

  // Plan orchestration
  PLAN_SUBAGENT: 'plan:subagent',
  PLAN_PROGRESS: 'plan:progress',
  PLAN_STARTED: 'plan:started',
  PLAN_CANCELLED: 'plan:cancelled',
  PLAN_COMPLETED: 'plan:completed',

  // Orchestrator Loop
  ORCHESTRATOR_STATE_CHANGED: 'orchestrator:stateChanged',
  ORCHESTRATOR_PLAN_PROGRESS: 'orchestrator:planProgress',
  ORCHESTRATOR_PLAN_READY: 'orchestrator:planReady',
  ORCHESTRATOR_PHASE_STARTED: 'orchestrator:phaseStarted',
  ORCHESTRATOR_PHASE_COMPLETED: 'orchestrator:phaseCompleted',
  ORCHESTRATOR_PHASE_FAILED: 'orchestrator:phaseFailed',
  ORCHESTRATOR_VERIFICATION: 'orchestrator:verification',
  ORCHESTRATOR_TASK_ASSIGNED: 'orchestrator:taskAssigned',
  ORCHESTRATOR_TASK_COMPLETED: 'orchestrator:taskCompleted',
  ORCHESTRATOR_TASK_FAILED: 'orchestrator:taskFailed',
  ORCHESTRATOR_COMPLETED: 'orchestrator:completed',
  ORCHESTRATOR_ERROR: 'orchestrator:error',

  // Teams (agent teams)
  TEAM_CREATED: 'team:created',
  TEAM_UPDATED: 'team:updated',
  TEAM_REMOVED: 'team:removed',
  TEAM_TASK_UPDATED: 'team:taskUpdated',

  // Transcript
  TRANSCRIPT_COMPLETE: 'transcript:complete',
  TRANSCRIPT_PLAN_MODE: 'transcript:plan_mode',
  TRANSCRIPT_TOOL_START: 'transcript:tool_start',
  TRANSCRIPT_TOOL_END: 'transcript:tool_end',

  // Clipboard
  CLIPBOARD_WRITE: 'clipboard:write',

  // Cases
  CASE_CREATED: 'case:created',
  CASE_LINKED: 'case:linked',
  CASE_DELETED: 'case:deleted',
  CASE_ORDER_CHANGED: 'case:order-changed',
  DOCKER_EXPORT_COMPLETE: 'docker:exportComplete',
  DOCKER_EXPORT_FAILED: 'docker:exportFailed',
  DOCKER_IMPORT_COMPLETE: 'docker:importComplete',
  DOCKER_IMAGE_BUILD_STARTED: 'docker:imageBuildStarted',
  DOCKER_IMAGE_BUILD_PROGRESS: 'docker:imageBuildProgress',
  DOCKER_IMAGE_BUILD_COMPLETE: 'docker:imageBuildComplete',
  DOCKER_IMAGE_BUILD_FAILED: 'docker:imageBuildFailed',
  // Multi-user (admin-only / targeted)
  ADMIN_USERS_CHANGED: 'admin:usersChanged',
  AUTH_PASSWORD_CHANGE_REQUIRED: 'auth:passwordChangeRequired',
  DOCKER_CONTAINER_RECREATED: 'docker:containerRecreated',

  // Session order (global tab order sync)
  SESSION_ORDER_CHANGED: 'session:orderChanged',

  // Web tabs (dashboard URLs)
  WEBVIEW_CHANGED: 'webview:changed',
};

// ═══════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════

/**
 * Get unified coordinates from mouse or touch event.
 * @param {MouseEvent|TouchEvent} e - The event
 * @returns {{ clientX: number, clientY: number }} Coordinates
 */
function getEventCoords(e) {
  if (e.touches && e.touches.length > 0) {
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  if (e.changedTouches && e.changedTouches.length > 0) {
    return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
  }
  return { clientX: e.clientX, clientY: e.clientY };
}

// HTML escape utility (shared by NotificationManager, CodemanApp, and ralph-wizard.js)
const _htmlEscapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _htmlEscapePattern = /[&<>"']/g;
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(_htmlEscapePattern, (ch) => _htmlEscapeMap[ch]);
}

/**
 * Human-readable byte size for the partial-history banner (#258).
 *
 * Deliberately coarse: the banner is telling the user roughly how much of a
 * transcript they are looking at, not accounting for bytes. Sub-KB amounts read
 * as "less than 1 KB" rather than an exact count nobody can act on.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatHistoryBytes(bytes) {
  const n = typeof bytes === 'number' && isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return 'less than 1 KB';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Decide what the partial-history banner should say (#258).
 *
 * PURE so the three states can be tested without a DOM. They exist because one
 * `truncated` boolean could not distinguish messages the user acts on very
 * differently:
 *   - recoverable: we tailed for speed and the rest is still retained
 *   - atCeiling:   the FULL capture itself hit the byte ceiling
 *   - exhausted:   a full pull was refused as a downgrade, so this is all there is
 *
 * @param {{truncated?: boolean, reason?: string|null, source?: string|null,
 *          fullSize?: number, retainedBytes?: number, exhausted?: boolean}} state
 * @returns {{visible: boolean, message: string, canLoadMore: boolean}}
 */
function computeHistoryTruncationNotice(state = {}) {
  if (!state.truncated) return { visible: false, message: '', canLoadMore: false };

  const retained = Math.max(0, state.retainedBytes || 0);
  const dropped = Math.max(0, (state.fullSize || 0) - retained);
  const shown = formatHistoryBytes(retained);
  // A full-history capture that was STILL capped is already everything tmux
  // holds, so the remainder is out of reach rather than one request away.
  const atCeiling = state.source === 'mux-full-history' && state.reason === 'capped';

  if (state.exhausted) {
    return {
      visible: true,
      message: `Showing all ${shown} of retained history. Earlier output is no longer kept for this session.`,
      canLoadMore: false,
    };
  }
  if (atCeiling) {
    return {
      visible: true,
      message: `Showing the most recent ${shown}. Earlier output exceeds the retained history limit and cannot be recovered.`,
      canLoadMore: false,
    };
  }
  return {
    visible: true,
    message: `Showing the most recent ${shown} of this session. ${formatHistoryBytes(dropped)} more may still be retained.`,
    canLoadMore: true,
  };
}

/**
 * Where to land after a rewrite that REPLACES the whole buffer (#259).
 *
 * The backpressure refresh clears the terminal and reloads it from a freshly
 * fetched capture, so an absolute viewportY captured beforehand means nothing
 * afterwards: the line it pointed at may not even exist. Distance from the
 * BOTTOM is the anchor that survives a rewrite, so a reader stays roughly
 * where they were reading.
 *
 * Returns null when the user was following live output, which the caller reads
 * as "scroll to bottom" — the historical behavior, kept for that case.
 *
 * @param {{linesFromBottom?: number, baseY?: number}} input
 * @returns {number|null}
 */
function computeRewriteScrollLine(input) {
  const linesFromBottom = input?.linesFromBottom || 0;
  if (!(linesFromBottom > 0)) return null;
  return Math.max(0, (input?.baseY || 0) - linesFromBottom);
}

if (typeof window !== 'undefined') {
  window.CodemanHistoryFormat = { formatHistoryBytes, computeHistoryTruncationNotice, computeRewriteScrollLine };
}
