/**
 * @fileoverview Core UI controller for Codeman — tab-based terminal manager with xterm.js.
 *
 * Defines the CodemanApp class (constructor, init, SSE connection, session lifecycle, tabs,
 * navigation). Domain-specific methods are mixed in from separate modules via Object.assign:
 *
 *   terminal-ui.js   — Terminal setup, rendering pipeline, controls
 *   respawn-ui.js    — Respawn banner, countdown timers, presets, run summary
 *   ralph-panel.js   — Ralph state panel, fix_plan, plan versioning
 *   settings-ui.js   — App settings, visibility, web push, lifecycle log, tunnel/QR, help
 *   panels-ui.js     — Subagent panel, agent teams, project insights, file browser, log viewer,
 *                       image popups, monitor, token stats, toast, system stats
 *   session-ui.js    — Quick start, session options modal, case settings, mobile case picker
 *   ralph-wizard.js  — Ralph Loop wizard modal
 *   api-client.js    — API helper methods (fetch wrappers)
 *   subagent-windows.js — Floating subagent terminal windows
 *
 * ═══ Sections in this file ═══
 *
 *   SSE Handler Map            — Event-to-method routing table (resolves at runtime via `this`)
 *   CodemanApp Class           — Constructor and all state initialization (~80 properties)
 *   Pending Hooks              — Hook state machine for tab alerts
 *   Init                       — App bootstrap, mobile setup, WebGL init
 *   Event Listeners            — Keyboard shortcuts, resize, beforeunload
 *   SSE Connection             — connectSSE with exponential backoff (1-30s)
 *   Core SSE Event Handlers    — Session lifecycle, scheduled runs (~20 handlers)
 *   Connection Status          — Online detection, input queuing, state sync
 *   WebSocket Terminal I/O     — Low-latency WS bypass for terminal input
 *   Session Tabs               — Tab rendering, selection, drag-and-drop reordering
 *   Tab Order & Drag-and-Drop  — Persistent ordering with localStorage sync
 *   Session Lifecycle          — Select, close, navigate, rename, cleanup
 *   Navigation                 — goHome
 *   Kill Sessions              — Kill active/all sessions
 *   Timer / Tokens             — Session timer, token/cost display
 *   Module Init                — localStorage migration, app instantiation
 *
 * @class CodemanApp
 * @globals {CodemanApp} app - Singleton instance (also on window.app)
 *
 * @dependency constants.js (SSE_EVENTS, timing constants, escapeHtml, DEC_SYNC_STRIP_RE)
 * @dependency mobile-handlers.js (MobileDetection, KeyboardHandler, SwipeHandler)
 * @dependency voice-input.js (VoiceInput, DeepgramProvider)
 * @dependency notification-manager.js (NotificationManager class)
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar, FocusTrap)
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js, vendor/xterm-addon-webgl.js
 * @dependency vendor/xterm-zerolag-input.iife.js (LocalEchoOverlay)
 * @loadorder 6 of 15 — loaded after keyboard-accessory.js, before terminal-ui.js
 */

// Codeman App - Tab-based Terminal UI
// Constants, utilities, and escapeHtml() are in constants.js (loaded before this file)
// MobileDetection, KeyboardHandler, SwipeHandler are in mobile-handlers.js
// DeepgramProvider, VoiceInput are in voice-input.js

// ═══════════════════════════════════════════════════════════════
// Global Error & Performance Diagnostics
// ═══════════════════════════════════════════════════════════════
// Writes breadcrumbs to localStorage so they survive tab freezes.
// After a crash, check: localStorage.getItem('codeman-crash-diag')

const _crashDiag = {
  _entries: [],
  _maxEntries: 50,
  log(msg) {
    const entry = `${new Date().toISOString().slice(11,23)} ${msg}`;
    this._entries.push(entry);
    if (this._entries.length > this._maxEntries) this._entries.shift();
    try { localStorage.setItem('codeman-crash-diag', this._entries.join('\n')); } catch {}
  }
};

// Log previous crash breadcrumbs on startup
try {
  const prev = localStorage.getItem('codeman-crash-diag');
  if (prev) console.log('[CRASH-DIAG] Previous session breadcrumbs:\n' + prev);
} catch {}
_crashDiag.log('PAGE LOAD');

// Heartbeat: send breadcrumbs to server every 2s so they survive tab freezes.
setInterval(() => {
  try {
    localStorage.setItem('codeman-crash-heartbeat', String(Date.now()));
    if (_crashDiag._entries.length > 0) {
      navigator.sendBeacon('/api/crash-diag', JSON.stringify({ data: _crashDiag._entries.join('\n') }));
    }
  } catch {}
}, 2000);

window.addEventListener('error', (e) => {
  _crashDiag.log(`ERROR: ${e.message} at ${e.filename}:${e.lineno}`);
  console.error('[CRASH-DIAG] Uncaught error:', e.message, '\n  File:', e.filename, ':', e.lineno, ':', e.colno, '\n  Stack:', e.error?.stack);
});

window.addEventListener('unhandledrejection', (e) => {
  _crashDiag.log(`UNHANDLED: ${e.reason?.message || e.reason}`);
  console.error('[CRASH-DIAG] Unhandled promise rejection:', e.reason?.message || e.reason, '\n  Stack:', e.reason?.stack);
});

// Detect long tasks (>50ms main thread blocks) — these cause "page unresponsive"
if (typeof PerformanceObserver !== 'undefined') {
  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 200) {
          _crashDiag.log(`LONG_TASK: ${entry.duration.toFixed(0)}ms`);
          console.warn(`[CRASH-DIAG] Long task: ${entry.duration.toFixed(0)}ms (type: ${entry.entryType}, name: ${entry.name})`);
        }
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
  } catch { /* longtask not supported */ }
}

// Track WebGL context loss/restore events on all canvases
const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(type, ...args) {
  const ctx = _origGetContext.call(this, type, ...args);
  if (type === 'webgl2' || type === 'webgl') {
    this.addEventListener('webglcontextlost', (e) => {
      _crashDiag.log(`WEBGL_LOST: ${this.width}x${this.height}`);
      console.error('[CRASH-DIAG] WebGL context LOST on canvas', this.width, 'x', this.height, '— prevented:', e.defaultPrevented);
    });
    this.addEventListener('webglcontextrestored', () => {
      _crashDiag.log('WEBGL_RESTORED');
      console.warn('[CRASH-DIAG] WebGL context restored');
    });
  }
  return ctx;
};


// ═══════════════════════════════════════════════════════════════
// SSE Handler Map — event-to-method routing table
// ═══════════════════════════════════════════════════════════════
// connectSSE() iterates this array to register all listeners in a single loop.
// Omitted no-op events (registered by server but unused in UI):
//   respawn:stepSent, respawn:aiCheckStarted, respawn:aiCheckCompleted,
//   respawn:aiCheckFailed, respawn:aiCheckCooldown
const _SSE_HANDLER_MAP = [
  // Core
  [SSE_EVENTS.INIT, '_onInit'],

  // Session lifecycle
  [SSE_EVENTS.SESSION_CREATED, '_onSessionCreated'],
  [SSE_EVENTS.SESSION_UPDATED, '_onSessionUpdated'],
  [SSE_EVENTS.SESSION_DELETED, '_onSessionDeleted'],
  [SSE_EVENTS.SESSION_TERMINAL, '_onSSETerminal'],
  [SSE_EVENTS.SESSION_NEEDS_REFRESH, '_onSSENeedsRefresh'],
  [SSE_EVENTS.SESSION_CLEAR_TERMINAL, '_onSSEClearTerminal'],
  [SSE_EVENTS.SESSION_COMPLETION, '_onSessionCompletion'],
  [SSE_EVENTS.SESSION_ERROR, '_onSessionError'],
  [SSE_EVENTS.SESSION_EXIT, '_onSessionExit'],
  [SSE_EVENTS.SESSION_IDLE, '_onSessionIdle'],
  [SSE_EVENTS.SESSION_WORKING, '_onSessionWorking'],
  [SSE_EVENTS.SESSION_AUTO_CLEAR, '_onSessionAutoClear'],
  [SSE_EVENTS.SESSION_CLI_INFO, '_onSessionCliInfo'],

  // Scheduled runs
  [SSE_EVENTS.SCHEDULED_CREATED, '_onScheduledCreated'],
  [SSE_EVENTS.SCHEDULED_UPDATED, '_onScheduledUpdated'],
  [SSE_EVENTS.SCHEDULED_COMPLETED, '_onScheduledCompleted'],
  [SSE_EVENTS.SCHEDULED_STOPPED, '_onScheduledStopped'],

  // Respawn
  [SSE_EVENTS.RESPAWN_STARTED, '_onRespawnStarted'],
  [SSE_EVENTS.RESPAWN_STOPPED, '_onRespawnStopped'],
  [SSE_EVENTS.RESPAWN_STATE_CHANGED, '_onRespawnStateChanged'],
  [SSE_EVENTS.RESPAWN_CYCLE_STARTED, '_onRespawnCycleStarted'],
  [SSE_EVENTS.RESPAWN_BLOCKED, '_onRespawnBlocked'],
  [SSE_EVENTS.RESPAWN_AUTO_ACCEPT_SENT, '_onRespawnAutoAcceptSent'],
  [SSE_EVENTS.RESPAWN_DETECTION_UPDATE, '_onRespawnDetectionUpdate'],
  [SSE_EVENTS.RESPAWN_TIMER_STARTED, '_onRespawnTimerStarted'],
  [SSE_EVENTS.RESPAWN_TIMER_CANCELLED, '_onRespawnTimerCancelled'],
  [SSE_EVENTS.RESPAWN_TIMER_COMPLETED, '_onRespawnTimerCompleted'],
  [SSE_EVENTS.RESPAWN_ERROR, '_onRespawnError'],
  [SSE_EVENTS.RESPAWN_ACTION_LOG, '_onRespawnActionLog'],

  // Tasks
  [SSE_EVENTS.TASK_CREATED, '_onTaskCreated'],
  [SSE_EVENTS.TASK_COMPLETED, '_onTaskCompleted'],
  [SSE_EVENTS.TASK_FAILED, '_onTaskFailed'],
  [SSE_EVENTS.TASK_UPDATED, '_onTaskUpdated'],

  // Mux (tmux)
  [SSE_EVENTS.MUX_CREATED, '_onMuxCreated'],
  [SSE_EVENTS.MUX_KILLED, '_onMuxKilled'],
  [SSE_EVENTS.MUX_DIED, '_onMuxDied'],
  [SSE_EVENTS.MUX_STATS_UPDATED, '_onMuxStatsUpdated'],

  // Ralph
  [SSE_EVENTS.SESSION_RALPH_LOOP_UPDATE, '_onRalphLoopUpdate'],
  [SSE_EVENTS.SESSION_RALPH_TODO_UPDATE, '_onRalphTodoUpdate'],
  [SSE_EVENTS.SESSION_RALPH_COMPLETION_DETECTED, '_onRalphCompletionDetected'],
  [SSE_EVENTS.SESSION_RALPH_STATUS_UPDATE, '_onRalphStatusUpdate'],
  [SSE_EVENTS.SESSION_CIRCUIT_BREAKER_UPDATE, '_onCircuitBreakerUpdate'],
  [SSE_EVENTS.SESSION_EXIT_GATE_MET, '_onExitGateMet'],

  // Bash tools
  [SSE_EVENTS.SESSION_BASH_TOOL_START, '_onBashToolStart'],
  [SSE_EVENTS.SESSION_BASH_TOOL_END, '_onBashToolEnd'],
  [SSE_EVENTS.SESSION_BASH_TOOLS_UPDATE, '_onBashToolsUpdate'],

  // Hooks (Claude Code hook events)
  [SSE_EVENTS.HOOK_IDLE_PROMPT, '_onHookIdlePrompt'],
  [SSE_EVENTS.HOOK_PERMISSION_PROMPT, '_onHookPermissionPrompt'],
  [SSE_EVENTS.HOOK_ELICITATION_DIALOG, '_onHookElicitationDialog'],
  [SSE_EVENTS.HOOK_STOP, '_onHookStop'],
  [SSE_EVENTS.HOOK_TEAMMATE_IDLE, '_onHookTeammateIdle'],
  [SSE_EVENTS.HOOK_TASK_COMPLETED, '_onHookTaskCompleted'],

  // Subagents (Claude Code background agents)
  [SSE_EVENTS.SUBAGENT_DISCOVERED, '_onSubagentDiscovered'],
  [SSE_EVENTS.SUBAGENT_UPDATED, '_onSubagentUpdated'],
  [SSE_EVENTS.SUBAGENT_TOOL_CALL, '_onSubagentToolCall'],
  [SSE_EVENTS.SUBAGENT_PROGRESS, '_onSubagentProgress'],
  [SSE_EVENTS.SUBAGENT_MESSAGE, '_onSubagentMessage'],
  [SSE_EVENTS.SUBAGENT_TOOL_RESULT, '_onSubagentToolResult'],
  [SSE_EVENTS.SUBAGENT_COMPLETED, '_onSubagentCompleted'],

  // Images
  [SSE_EVENTS.IMAGE_DETECTED, '_onImageDetected'],

  // Tunnel
  [SSE_EVENTS.TUNNEL_STARTED, '_onTunnelStarted'],
  [SSE_EVENTS.TUNNEL_STOPPED, '_onTunnelStopped'],
  [SSE_EVENTS.TUNNEL_PROGRESS, '_onTunnelProgress'],
  [SSE_EVENTS.TUNNEL_ERROR, '_onTunnelError'],
  [SSE_EVENTS.TUNNEL_QR_ROTATED, '_onTunnelQrRotated'],
  [SSE_EVENTS.TUNNEL_QR_REGENERATED, '_onTunnelQrRegenerated'],
  [SSE_EVENTS.TUNNEL_QR_AUTH_USED, '_onTunnelQrAuthUsed'],

  // Plan orchestration
  [SSE_EVENTS.PLAN_SUBAGENT, '_onPlanSubagent'],
  [SSE_EVENTS.PLAN_PROGRESS, '_onPlanProgress'],
  [SSE_EVENTS.PLAN_STARTED, '_onPlanStarted'],
  [SSE_EVENTS.PLAN_CANCELLED, '_onPlanCancelled'],
  [SSE_EVENTS.PLAN_COMPLETED, '_onPlanCompleted'],

  // Orchestrator loop
  [SSE_EVENTS.ORCHESTRATOR_STATE_CHANGED, '_onOrchestratorStateChanged'],
  [SSE_EVENTS.ORCHESTRATOR_PLAN_PROGRESS, '_onOrchestratorPlanProgress'],
  [SSE_EVENTS.ORCHESTRATOR_PLAN_READY, '_onOrchestratorPlanReady'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_STARTED, '_onOrchestratorPhaseStarted'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_COMPLETED, '_onOrchestratorPhaseCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_FAILED, '_onOrchestratorPhaseFailed'],
  [SSE_EVENTS.ORCHESTRATOR_VERIFICATION, '_onOrchestratorVerification'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_ASSIGNED, '_onOrchestratorTaskAssigned'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_COMPLETED, '_onOrchestratorTaskCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_FAILED, '_onOrchestratorTaskFailed'],
  [SSE_EVENTS.ORCHESTRATOR_COMPLETED, '_onOrchestratorCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_ERROR, '_onOrchestratorError'],

  // Clipboard
  [SSE_EVENTS.CLIPBOARD_WRITE, '_onClipboardWrite'],
];


// ═══════════════════════════════════════════════════════════════
// Session Name Prefix Parser
// ═══════════════════════════════════════════════════════════════
// Parses w<N>-<caseName> or s<N>-<caseName> prefix from session names.
// Returns { prefix, suffix } or null if name does not match the pattern.
function parseSessionPrefix(name) {
  if (!name) return null;
  const m = name.match(/^(w\d+-[a-zA-Z0-9_-]+|s\d+-[a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const prefix = m[1];
  const rest = name.slice(prefix.length);
  if (rest === "") return { prefix, suffix: "" };
  if (rest.startsWith(": ")) return { prefix, suffix: rest.slice(2) };
  return null;
}

// ═══════════════════════════════════════════════════════════════
// CodemanApp Class — constructor and global state
// ═══════════════════════════════════════════════════════════════

class CodemanApp {
  constructor() {
    this.sessions = new Map();
    this._shortIdCache = new Map(); // Cache session ID .slice(0, 8) results
    this.sessionOrder = []; // Track tab order for drag-and-drop reordering
    this.draggedTabId = null; // Currently dragged tab session ID
    this.cases = [];
    this.currentRun = null;
    this.totalTokens = 0;
    this.globalStats = null; // Global token/cost stats across all sessions
    this.eventSource = null;
    // Stable per-page client ID — lets the server target this connection
    // for live filter updates (POST /api/events/subscribe) without forcing
    // an SSE reconnect on session switches.
    this._clientId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;
    this._initGeneration = 0;     // dedup concurrent handleInit calls
    this._initFallbackTimer = null; // fallback timer if SSE init doesn't arrive
    this._selectGeneration = 0;   // cancel stale selectSession loads
    this.respawnStatus = {};
    this.respawnTimers = {}; // Track timed respawn timers
    this.respawnCountdownTimers = {}; // { sessionId: { timerName: { endsAt, totalMs, reason } } }
    this.respawnActionLogs = {};      // { sessionId: [action, action, ...] } (max 20)
    this.timerCountdownInterval = null; // Interval for updating countdown display
    this.terminalBuffers = new Map(); // Store terminal content per session
    this.editingSessionId = null; // Session being edited in options modal
    this.pendingCloseSessionId = null; // Session pending close confirmation
    this.muxSessions = []; // Screen sessions for process monitor

    // Ralph loop/todo state per session
    this.ralphStates = new Map(); // Map<sessionId, { loop, todos }>

    // Subagent (Claude Code background agent) tracking
    this.subagents = new Map(); // Map<agentId, SubagentInfo>
    this.subagentActivity = new Map(); // Map<agentId, activity[]> - recent tool calls/progress
    this.subagentToolResults = new Map(); // Map<agentId, Map<toolUseId, result>> - tool results by toolUseId
    this.activeSubagentId = null; // Currently selected subagent for detail view
    this.subagentPanelVisible = false;
    this.subagentWindows = new Map(); // Map<agentId, { element, position }>
    this.subagentWindowZIndex = ZINDEX_SUBAGENT_BASE;
    this.minimizedSubagents = new Map(); // Map<sessionId, Set<agentId>> - minimized to tab
    this._subagentHideTimeout = null; // Timeout for hover-based dropdown hide

    // PERSISTENT parent associations - agentId -> sessionId
    // This is the SINGLE SOURCE OF TRUTH for which tab an agent window connects to.
    // Once set, never recalculated. Persisted to localStorage and server.
    this.subagentParentMap = new Map();

    // Agent Teams tracking
    this.teams = new Map(); // Map<teamName, TeamConfig>
    this.teamTasks = new Map(); // Map<teamName, TeamTask[]>
    this.teammateMap = new Map(); // Map<agentId-prefix, {name, color, teamName}> for quick lookup

    // Teammate tmux pane terminals (Agent Teams feature)
    this.teammatePanesByName = new Map(); // Map<name, { paneTarget, sessionId, color }>
    this.teammateTerminals = new Map(); // Map<agentId, { terminal, fitAddon, paneTarget, sessionId, resizeObserver }>

    this.terminalBufferCache = new Map(); // Map<sessionId, string> — client-side cache for instant tab re-visits (max 20)

    this.ralphStatePanelCollapsed = true; // Default to collapsed
    this.ralphClosedSessions = new Set(); // Sessions where user explicitly closed Ralph panel

    // Plan subagent windows (visible agents during plan generation)
    this.planSubagents = new Map(); // Map<agentId, { type, model, status, startTime, element, relativePos }>
    this.planSubagentWindowZIndex = ZINDEX_PLAN_SUBAGENT_BASE;
    this.planGenerationStopped = false; // Flag to ignore SSE events after Stop
    this.planAgentsMinimized = false; // Whether agent windows are minimized to tab

    // Wizard dragging state
    this.wizardDragState = null; // { startX, startY, startLeft, startTop, isDragging }
    this.wizardDragListeners = null; // { move, up } for cleanup
    this.wizardPosition = null; // { left, top } - null means centered

    // Project Insights tracking (active Bash tools with clickable file paths)
    this.projectInsights = new Map(); // Map<sessionId, ActiveBashTool[]>
    this.logViewerWindows = new Map(); // Map<windowId, { element, eventSource, filePath }>
    this.logViewerWindowZIndex = ZINDEX_LOG_VIEWER_BASE;
    this.projectInsightsPanelVisible = false;

    // Orchestrator loop state
    this.orchestratorState = null; // { state, plan, currentPhaseIndex, stats }
    this.orchestratorPanelVisible = false;
    this.currentSessionWorkingDir = null; // Track current session's working dir for path normalization

    // Image popup windows (auto-open for detected screenshots/images)
    this.imagePopups = new Map(); // Map<imageId, { element, sessionId, filePath }>
    this.imagePopupZIndex = ZINDEX_IMAGE_POPUP_BASE;

    // File browser state (methods in panels-ui.js)
    this.fileBrowserData = null;
    this.fileBrowserExpandedDirs = new Set();
    this.fileBrowserFilter = '';
    this.fileBrowserAllExpanded = false;
    this.fileBrowserDragListeners = null;
    this.filePreviewContent = '';

    // Toast container cache (methods in panels-ui.js)
    this._toastContainer = null;

    // Tunnel indicator state
    this._tunnelUrl = null;

    // Tab alert states: Map<sessionId, 'action' | 'idle'>
    this.tabAlerts = new Map();

    // Pending hooks per session: Map<sessionId, Set<hookType>>
    // Tracks pending hook events that need resolution (permission_prompt, elicitation_dialog, idle_prompt)
    this.pendingHooks = new Map();

    // WebSocket terminal I/O (low-latency bypass of HTTP POST + SSE)
    this._ws = null;            // WebSocket instance for active session
    this._wsSessionId = null;   // Session ID the WS is connected to
    this._wsReady = false;      // True when WS is open and ready for I/O

    // Terminal write batching with DEC 2026 sync support
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._wasAtBottomBeforeWrite = true; // Default to true for sticky scroll
    this.syncWaitTimeout = null; // Timeout for incomplete sync blocks
    this._isLoadingBuffer = false; // true during chunkedTerminalWrite — blocks live SSE writes
    this._loadBufferQueue = null;  // queued SSE events during buffer load

    // Flicker filter state (buffers output after screen clears)
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    this.flickerFilterTimeout = null;

    // Render debounce timers (managed by _debouncedCall)
    this._debounceTimers = Object.create(null);

    // System stats polling
    this.systemStatsInterval = null;

    // SSE reconnect timeout (to prevent orphaned timeouts)
    this.sseReconnectTimeout = null;

    // SSE event listener cleanup function (to prevent listener accumulation on reconnect)
    this._sseListenerCleanup = null;

    // SSE connection status tracking
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isOnline = navigator.onLine;

    // Offline input queue
    this._inputQueue = new Map(); // Map<sessionId, string>
    this._inputQueueMaxBytes = 64 * 1024; // 64KB cap per session
    this._connectionStatus = 'connected';

    // Sequential input send chain — ensures keystroke ordering across async fetches
    this._inputSendChain = Promise.resolve();

    // Local echo overlay — DOM overlay positioned at the visible ❯ prompt
    // (not at buffer.cursorY, which reflects Ink's internal cursor position)
    this._localEchoOverlay = null;  // created after terminal.open()
    this._localEchoEnabled = false; // true when setting on + session active
    this._restoringFlushedState = false; // true during selectSession buffer load — protects flushed Maps

    // Accessibility: Focus trap for modals
    this.activeFocusTrap = null;

    // Notification system
    this.notificationManager = new NotificationManager(this);
    this.idleTimers = new Map(); // Map<sessionId, timeout> for stuck detection

    // DOM element cache for performance (avoid repeated getElementById calls)
    this._elemCache = {};

    this.init();
  }

  // Cached element getter - avoids repeated DOM queries
  $(id) {
    if (!this._elemCache[id]) {
      this._elemCache[id] = document.getElementById(id);
    }
    return this._elemCache[id];
  }

  // Clear a named timeout property: if (this[name]) { clearTimeout(this[name]); this[name] = null; }
  _clearTimer(timerName) {
    if (this[timerName]) {
      clearTimeout(this[timerName]);
      this[timerName] = null;
    }
  }

  // Check if a selectSession generation is stale (a newer tab switch has started).
  // If stale, cleans up buffer-loading state and returns true.
  _isStaleSelect(selectGen) {
    if (selectGen !== this._selectGeneration) {
      if (this._isLoadingBuffer) this._finishBufferLoad();
      this._restoringFlushedState = false;
      return true;
    }
    return false;
  }

  // Format token count: 1000k -> 1m, 1450k -> 1.45m, 500 -> 500
  formatTokens(count) {
    if (count >= 1000000) {
      const m = count / 1000000;
      return m >= 10 ? `${m.toFixed(1)}m` : `${m.toFixed(2)}m`;
    } else if (count >= 1000) {
      const k = count / 1000;
      return k >= 100 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
    }
    return String(count);
  }

  // Estimate cost from tokens using Claude Opus pricing
  // Input: $15/M tokens, Output: $75/M tokens
  estimateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000000) * 15;
    const outputCost = (outputTokens / 1000000) * 75;
    return inputCost + outputCost;
  }

  // ═══════════════════════════════════════════════════════════════
  // Pending Hooks State Machine
  // ═══════════════════════════════════════════════════════════════
  // Track pending hook events per session to determine tab alerts.
  // Action hooks (permission_prompt, elicitation_dialog) take priority over idle_prompt.

  setPendingHook(sessionId, hookType) {
    if (!this.pendingHooks.has(sessionId)) {
      this.pendingHooks.set(sessionId, new Set());
    }
    this.pendingHooks.get(sessionId).add(hookType);
    this.updateTabAlertFromHooks(sessionId);
  }

  clearPendingHooks(sessionId, hookType = null) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks) return;
    if (hookType) {
      hooks.delete(hookType);
    } else {
      hooks.clear();
    }
    if (hooks.size === 0) {
      this.pendingHooks.delete(sessionId);
    }
    this.updateTabAlertFromHooks(sessionId);
  }

  updateTabAlertFromHooks(sessionId) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks || hooks.size === 0) {
      this.tabAlerts.delete(sessionId);
    } else if (hooks.has('permission_prompt') || hooks.has('elicitation_dialog')) {
      this.tabAlerts.set(sessionId, 'action');
    } else if (hooks.has('idle_prompt')) {
      this.tabAlerts.set(sessionId, 'idle');
    }
    this.renderSessionTabs();
  }

  // ═══════════════════════════════════════════════════════════════
  // Init — app bootstrap and mobile setup
  // ═══════════════════════════════════════════════════════════════

  init() {
    // Initialize mobile detection first (adds device classes to body)
    MobileDetection.init();
    // Initialize mobile handlers
    KeyboardHandler.init();
    SwipeHandler.init();
    VoiceInput.init();
    KeyboardAccessoryBar.init();
    // Apply keyboard bar mode from settings
    const _kbSettings = this.loadAppSettingsFromStorage();
    if (_kbSettings.extendedKeyboardBar) KeyboardAccessoryBar.setMode('extended');
    this.applyHeaderVisibilitySettings();
    this.applyTabWrapSettings();
    this.applyMonitorVisibility();
    // Remove mobile-init class now that JS has applied visibility settings.
    // The inline <script> in <head> added this to prevent flash-of-content on mobile.
    document.documentElement.classList.remove('mobile-init');
    // Defer heavy terminal canvas creation to next frame — lets browser paint header/skeleton first.
    // IMPORTANT: connectSSE must run AFTER initTerminal to prevent a race where SSE data
    // arrives before the terminal exists, orphaning data in pendingWrites and corrupting
    // escape sequence boundaries when later concatenated with fresh data.
    requestAnimationFrame(() => {
      this.initTerminal();
      this.loadFontSize();
      this.connectSSE();
      // Only fetch state if SSE init event hasn't arrived within 3s (avoids duplicate handleInit)
      this._initFallbackTimer = setTimeout(() => {
        if (this._initGeneration === 0) this.loadState();
      }, 3000);
    });
    // Register service worker for push notifications
    this.registerServiceWorker();
    // Fetch tunnel status for header indicator (desktop only)
    this.loadTunnelStatus();
    // Share a single settings fetch between both consumers
    const settingsPromise = fetch('/api/settings').then(r => r.ok ? r.json() : null).catch(() => null);
    this.loadQuickStartCases(null, settingsPromise);
    this._initRunMode();
    this.setupEventListeners();
    // Mobile: ensure button taps register even when keyboard is visible.
    // On mobile, tapping a button while the soft keyboard is up causes the
    // browser to dismiss the keyboard first (blur event), swallowing the tap.
    // The button only receives the click on a second tap. Fix: intercept
    // touchstart on buttons while keyboard is visible, preventDefault to stop
    // the dismiss-swallows-tap behavior, and trigger the click programmatically.
    if (MobileDetection.isTouchDevice()) {
      const addKeyboardTapFix = (container) => {
        if (!container) return;
        container.addEventListener('touchstart', (e) => {
          if (!KeyboardHandler.keyboardVisible) return;
          const btn = e.target.closest('button');
          if (!btn) return;
          e.preventDefault();
          btn.click();
          // Refocus terminal so keyboard stays open (e.g. voice input button)
          if (typeof app !== 'undefined' && app.terminal) {
            app.terminal.focus();
          }
        }, { passive: false });
      };
      addKeyboardTapFix(document.querySelector('.toolbar'));
      addKeyboardTapFix(document.querySelector('.welcome-overlay'));
    }
    // System stats polling deferred until sessions exist (started in handleInit/session:created)
    // Setup online/offline detection
    this.setupOnlineDetection();
    // Load server-stored settings (async, re-applies visibility after load)
    this.loadAppSettingsFromServer(settingsPromise).then(() => {
      this.applyHeaderVisibilitySettings();
      this.applyTabWrapSettings();
      this.applyMonitorVisibility();
    });
    // Hide loading skeleton now that the app shell is ready
    document.body.classList.add('app-loaded');
  }

  _initWebGL() {
    if (typeof WebglAddon === 'undefined') return;
    try {
      this._webglAddon = new WebglAddon.WebglAddon();
      this._webglAddon.onContextLoss(() => {
        console.error('[CRASH-DIAG] WebGL context LOST — falling back to canvas renderer');
        _crashDiag.log('WEBGL_LOST');
        this._disableWebGLSticky('context-lost');
        this._disposeWebGLObserver();
        this._webglAddon?.dispose();
        this._webglAddon = null;
      });
      this.terminal.loadAddon(this._webglAddon);
      console.log('[CRASH-DIAG] WebGL renderer enabled');
      this._installWebGLLongTaskGuard();
    } catch (_e) { /* WebGL2 unavailable — canvas renderer used */ }
  }

  /**
   * Watch for sustained main-thread stalls that indicate WebGL/GPU trouble.
   * After WEBGL_FALLBACK.LONGTASK_COUNT long tasks (>=LONGTASK_MS each) within
   * WINDOW_MS, dispose the WebGL addon and persist a sticky disable so
   * subsequent reloads also use the DOM renderer. GRACE_MS skips initial-load
   * stalls. Force-re-enable: ?webgl=force.
   */
  _installWebGLLongTaskGuard() {
    if (typeof PerformanceObserver === 'undefined' || this._webglLongTaskObserver) return;
    const installedAt = performance.now();
    const recent = [];
    try {
      this._webglLongTaskObserver = new PerformanceObserver((list) => {
        if (!this._webglAddon) return;
        const now = performance.now();
        if (now - installedAt < WEBGL_FALLBACK.GRACE_MS) return;
        if (evaluateWebGLLongTaskTrip(recent, list.getEntries(), now)) {
          console.warn(`[CRASH-DIAG] WebGL long-task threshold (${recent.length} stalls/${WEBGL_FALLBACK.WINDOW_MS}ms) — falling back to canvas renderer`);
          _crashDiag.log(`WEBGL_FALLBACK: ${recent.length}`);
          this._disableWebGLSticky('long-tasks');
          this._disposeWebGLObserver();
          this._webglAddon?.dispose();
          this._webglAddon = null;
          try { this.terminal.refresh(0, this.terminal.rows - 1); } catch {}
        }
      });
      this._webglLongTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch { /* longtask not supported */ }
  }

  /**
   * Disconnect the WebGL longtask observer. Idempotent. Called from the trip
   * path, the onContextLoss handler, and any future terminal-teardown path —
   * the observer outlives its addon otherwise, holding a closure reference
   * over `this` for every long task the page emits.
   */
  _disposeWebGLObserver() {
    if (!this._webglLongTaskObserver) return;
    try { this._webglLongTaskObserver.disconnect(); } catch {}
    this._webglLongTaskObserver = null;
  }

  _disableWebGLSticky(reason) {
    try {
      localStorage.setItem('codeman-webgl-disabled', JSON.stringify({ reason, at: Date.now() }));
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════
  // Event Listeners (Keyboard Shortcuts, Resize, Beforeunload)
  // ═══════════════════════════════════════════════════════════════

  setupEventListeners() {
    // Keyboard shortcut lookup table — data-driven to avoid 12 separate if-blocks.
    // Each entry: { key, altKey? (alternative key match), ctrl? (require Ctrl/Cmd),
    //               shift? (require Shift), action }.
    const SHORTCUTS = [
      { key: '?', altKey: '/', ctrl: true, action: () => this.showHelp() },
      { key: 'w', ctrl: true, action: () => this.killActiveSession() },
      { key: 'Tab', ctrl: true, action: () => this.nextSession() },
      { key: 'l', ctrl: true, action: () => this.clearTerminal() },
      { key: 'R', ctrl: true, shift: true, action: () => this.restoreTerminalSize() },
      { key: '=', altKey: '+', ctrl: true, action: () => this.increaseFontSize() },
      { key: '-', ctrl: true, action: () => this.decreaseFontSize() },
      { key: 'V', ctrl: true, shift: true, action: () => VoiceInput.toggle() },
      { key: '{', ctrl: true, shift: true, action: () => this.moveActiveTabLeft() },
      { key: '}', ctrl: true, shift: true, action: () => this.moveActiveTabRight() },
    ];

    // Use capture to handle before terminal
    document.addEventListener('keydown', (e) => {
      // Don't intercept keys during CJK IME composition
      if (e.isComposing || e.keyCode === 229) return;

      // Escape - close panels and modals (different logic: no preventDefault, no return)
      if (e.key === 'Escape') {
        this.closeAllPanels();
        this.closeHelp();
      }

      // Alt+1-9: switch to Codeman session by index
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < this.sessionOrder.length) {
          e.preventDefault();
          this.selectSession(this.sessionOrder[idx]);
        }
        return;
      }

      // Match against shortcut table
      for (const s of SHORTCUTS) {
        const keyMatch = e.key === s.key || (s.altKey && e.key === s.altKey);
        const ctrlMatch = s.ctrl ? (e.ctrlKey || e.metaKey) : true;
        const shiftMatch = s.shift ? e.shiftKey : !e.shiftKey;
        if (keyMatch && ctrlMatch && shiftMatch) {
          e.preventDefault();
          s.action();
          return;
        }
      }
    }, true); // Use capture phase to handle before terminal

    // Token stats click handler (with guard to prevent duplicate handlers on reconnect)
    const tokenEl = this.$('headerTokens');
    if (tokenEl && !tokenEl._statsHandlerAttached) {
      tokenEl.classList.add('clickable');
      tokenEl._statsHandlerAttached = true;
      tokenEl.addEventListener('click', () => this.openTokenStats());
    }

    // Color picker for session customization
    this.setupColorPicker();
  }

  // ═══════════════════════════════════════════════════════════════
  // SSE Connection
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST a live subscription update so the server filters terminal events
   * to the given session(s) for this client. Fire-and-forget — failures
   * are non-fatal because we'll still get every event we don't want
   * (just at higher cost), and the next reconnect carries the filter via
   * the SSE query string.
   */
  _updateSseSubscription(sessionId) {
    try {
      const body = JSON.stringify({
        clientId: this._clientId,
        sessions: sessionId ? [sessionId] : null,
      });
      fetch('/api/events/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => { /* non-fatal */ });
    } catch { /* non-fatal */ }
  }

  connectSSE() {
    // Check if browser is offline
    if (!navigator.onLine) {
      this.setConnectionStatus('offline');
      return;
    }

    // Clear any pending reconnect timeout to prevent duplicate connections
    this._clearTimer('sseReconnectTimeout');

    // Clean up existing SSE listeners before creating new connection (prevents listener accumulation)
    if (this._sseListenerCleanup) {
      this._sseListenerCleanup();
      this._sseListenerCleanup = null;
    }

    // Close existing EventSource before creating new one to prevent duplicate connections
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Show connecting state
    if (this.reconnectAttempts === 0) {
      this.setConnectionStatus('connecting');
    } else {
      this.setConnectionStatus('reconnecting');
    }

    // Build URL with stable client ID and (if known) the active-session
    // filter so the server only streams session:terminal events for the
    // session we're rendering. Lifecycle/metadata events are sent globally
    // regardless of filter (server side).
    const _sseParams = new URLSearchParams({ clientId: this._clientId });
    if (this.activeSessionId) _sseParams.set('sessions', this.activeSessionId);
    this.eventSource = new EventSource(`/api/events?${_sseParams.toString()}`);

    // Store all event listeners for cleanup on reconnect
    const listeners = [];
    const addListener = (event, handler) => {
      this.eventSource.addEventListener(event, handler);
      listeners.push({ event, handler });
    };

    // Create cleanup function to remove all listeners
    this._sseListenerCleanup = () => {
      for (const { event, handler } of listeners) {
        if (this.eventSource) {
          this.eventSource.removeEventListener(event, handler);
        }
      }
      listeners.length = 0;
    };

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConnectionStatus('connected');
    };
    this.eventSource.onerror = () => {
      this.reconnectAttempts++;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.setConnectionStatus('disconnected');
      } else {
        this.setConnectionStatus('reconnecting');
      }
      // Close the failed connection before scheduling reconnect
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      // Clear any existing reconnect timeout before setting new one (prevents orphaned timeouts)
      this._clearTimer('sseReconnectTimeout');
      // Exponential backoff: 200ms, 500ms, 1s, 2s, 4s, ... up to 30s
      // Fast first retry (200ms) for server-restart case (COM deploy),
      // then ramp up for real network issues.
      const delay = this.reconnectAttempts <= 1 ? 200
        : Math.min(500 * Math.pow(2, this.reconnectAttempts - 2), 30000);
      this.sseReconnectTimeout = setTimeout(() => this.connectSSE(), delay);
    };

    // Create stable handler wrappers once (reused across reconnects so
    // removeEventListener always matches the original reference)
    if (!this._sseHandlerWrappers) {
      this._sseHandlerWrappers = new Map();
      for (const [event, method] of _SSE_HANDLER_MAP) {
        const fn = this[method];
        this._sseHandlerWrappers.set(event, (e) => {
          try {
            fn.call(this, e.data ? JSON.parse(e.data) : {});
          } catch (err) {
            console.error(`[SSE] Error handling ${event}:`, err);
          }
        });
      }
    }

    // Register all SSE event handlers via centralized map
    for (const [event] of _SSE_HANDLER_MAP) {
      addListener(event, this._sseHandlerWrappers.get(event));
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SSE Event Handlers
  // ═══════════════════════════════════════════════════════════════
  // Each _on* method receives pre-parsed SSE data (JSON.parse done in connectSSE loop).
  // Async handlers have their own internal try/catch for fetch errors.

  _onInit(data) {
    _crashDiag.log(`INIT: ${data.sessions?.length || 0} sessions`);
    this.handleInit(data);
  }

  _onSessionCreated(data) {
    this.sessions.set(data.id, data);
    // Add new session to end of tab order
    if (!this.sessionOrder.includes(data.id)) {
      this.sessionOrder.push(data.id);
      this.saveSessionOrder();
    }
    this.renderSessionTabs();
    this.updateCost();
    // Start stats polling when first session appears
    if (this.sessions.size === 1) this.startSystemStatsPolling();
  }

  _onSessionUpdated(data) {
    const session = data.session || data;
    const oldSession = this.sessions.get(session.id);
    const claudeSessionIdJustSet = session.claudeSessionId && (!oldSession || !oldSession.claudeSessionId);
    this.sessions.set(session.id, session);
    this.renderSessionTabs();
    this.updateCost();
    // Update tokens display if this is the active session
    if (session.id === this.activeSessionId && session.tokens) {
      this.updateRespawnTokens(session.tokens);
    }
    // Update parentSessionName for any subagents belonging to this session
    // (fixes stale name display after session rename)
    this.updateSubagentParentNames(session.id);
    // If claudeSessionId was just set, re-check orphan subagents
    // This connects subagents that were waiting for the session to identify itself
    if (claudeSessionIdJustSet) {
      this.recheckOrphanSubagents();
      // Update connection lines after DOM settles (ensure tabs are rendered)
      requestAnimationFrame(() => {
        this.updateConnectionLines();
      });
    }
  }

  _onSessionDeleted(data) {
    if (this._wsSessionId === data.id) this._disconnectWs();
    this._cleanupSessionData(data.id);
    if (this.activeSessionId === data.id) {
      this.activeSessionId = null;
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.terminal.clear();
      this.showWelcome();
    }
    this.renderSessionTabs();
    this.renderRalphStatePanel();  // Update ralph panel after session deleted
    this.renderProjectInsightsPanel();  // Update project insights panel after session deleted
    // Stop stats polling when no sessions remain
    if (this.sessions.size === 0) this.stopSystemStatsPolling();
  }

  // SSE wrappers — skip terminal events when WebSocket is delivering for this session.
  // WS handler calls the underlying _onSession* methods directly.
  _onSSETerminal(data) {
    if (this._wsReady && this._wsSessionId === data.id) return;
    this._onSessionTerminal(data);
  }
  _onSSENeedsRefresh(data) {
    if (this._wsReady && this._wsSessionId === data?.id) return;
    this._onSessionNeedsRefresh(data);
  }
  _onSSEClearTerminal(data) {
    if (this._wsReady && this._wsSessionId === data?.id) return;
    this._onSessionClearTerminal(data);
  }

  _onSessionTerminal(data) {
    if (data.id === this.activeSessionId) {
      if (data.data.length > 32768) _crashDiag.log(`TERMINAL: ${(data.data.length/1024).toFixed(0)}KB`);

      // Hard cap: track total bytes queued in render buffers (pendingWrites +
      // flickerFilterBuffer). When rAF is throttled (tab
      // backgrounded, GPU busy), data accumulates with no flush, reaching
      // 889KB+ and freezing Chrome for minutes. Drop data beyond 128KB and
      // schedule a buffer reload to recover the display once the burst subsides.
      const queued = (this.pendingWrites?.reduce((s, w) => s + w.length, 0) || 0)
        + (this.flickerFilterBuffer?.length || 0);
      if (queued > 131072) { // 128KB — drop to prevent accumulation
        // Schedule a self-recovery: reload the full terminal buffer once the
        // queue drains (debounced to avoid hammering the API during sustained bursts).
        if (!this._clientDropRecoveryTimer) {
          this._clientDropRecoveryTimer = setTimeout(() => {
            this._clientDropRecoveryTimer = null;
            this._onSessionNeedsRefresh();
          }, 2000);
        }
        return;
      }

      this.batchTerminalWrite(data.data);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Response Viewer — native-scroll panel for reading full Claude responses
  // ═══════════════════════════════════════════════════════════════

  /** Strip dangerous elements and attributes from HTML (XSS prevention) */
  _sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const frag = tpl.content;
    for (const el of frag.querySelectorAll('script, iframe, object, embed, form, base, meta, link, style')) {
      el.remove();
    }
    for (const el of frag.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
        } else if (['href', 'src', 'action', 'xlink:href', 'formaction'].includes(name)) {
          const val = attr.value.replace(/\s/g, '').toLowerCase();
          if (val.startsWith('javascript:') || val.startsWith('vbscript:') || val.startsWith('data:text/html')) {
            el.removeAttribute(attr.name);
          }
        }
      }
    }
    const div = document.createElement('div');
    div.appendChild(frag);
    return div.innerHTML;
  }

  /**
   * Strip ANSI escape sequences and Claude CLI chrome (status bar, hints,
   * spinner, progress bar) from a terminal buffer so the response viewer can
   * show just the conversational text when the JSONL transcript is missing.
   */
  _cleanTerminalBuffer(buf) {
    const stripped = buf
      // CSI sequences — params (0x30-0x3F includes digits, ?, ;, <, =, >),
      // intermediates (0x20-0x2F), final byte (0x40-0x7E). Catches \x1b[>c,
      // \x1b[>q, \x1b[?25l etc. that the previous regex missed.
      .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
      // OSC sequences (window titles etc.) terminated by BEL or ST
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // DCS / APC / PM / SOS sequences
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
      // SS2/SS3 + charset selects + single-char escapes
      .replace(/\x1b[NO()][A-Z0-9]?/g, '')
      .replace(/\x1b[>=<78cDEHM]/g, '')
      // Stray control chars (except \t \n)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Drop Claude CLI chrome lines that aren't part of the response.
    const CHROME_PATTERNS = [
      /^\s*❯\s*/,                                  // shell prompt
      /^\s*[⏵⏺⏸⏹]+\s*/,                           // status glyphs
      /^\s*✻\s*(Crunching|Crunched|Thinking)/i,   // spinner lines
      /bypass permissions/i,
      /\bshift\+tab to cycle\b/i,
      /^\s*focus\s*$/,
      /^\s*new task\?/i,
      /\/clear to save/i,
      /^\s*─{5,}\s*$/,                            // horizontal dividers
      /\[(Opus|Sonnet|Haiku|GPT|Claude)[\s\S]*(tokens?|\$|¥|%|↑|↓)/i, // status bar
      /^\s*\[\d+[km]?\/\d+[km]?\]/i,              // token counter
      /[█░▓▒]{3,}/,                              // progress bar
      /^\s*\(.*\s*(tokens?|context).*\)\s*$/i,
    ];

    const lines = stripped.split('\n');
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true; // keep blanks so paragraphs survive
      return !CHROME_PATTERNS.some((re) => re.test(line));
    });

    return kept
      .join('\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  /**
   * Wrap ASCII/box diagrams in fenced code blocks so marked.js preserves whitespace.
   * Claude often emits box-drawing diagrams without triple-backticks; without this
   * step, HTML collapses the whitespace and the diagram becomes unreadable prose.
   */
  _preprocessAsciiArt(text) {
    // Only trigger on characters that rarely appear in prose:
    //   U+2500-U+257F  Box Drawing      (─│┌┐└┘├┤┬┴┼╔╗╚╝═║)
    //   U+2580-U+259F  Block Elements   (▀▄█▌▐░▒▓, progress bars)
    // Deliberately excluded:
    //   U+2190-U+21FF  Arrows           (→←↑↓⇒ — common rhetorical prose)
    //   U+25A0-U+25FF  Geometric Shapes (●○■□◆◇ — common bullets)
    // Triggering on those would wrap numbered lists / prose that merely uses
    // arrows in code blocks and break their markdown rendering.
    const BOX_PATTERN = /[─-╿▀-▟]/;

    // Preserve existing fenced code blocks as-is (hide them behind placeholders)
    const fenceRe = /```[\s\S]*?```/g;
    const placeholders = [];
    const masked = text.replace(fenceRe, (m) => {
      placeholders.push(m);
      return ` FENCE${placeholders.length - 1} `;
    });

    // Split on blank-line paragraph boundaries; wrap any paragraph containing
    // box-drawing/arrow chars in its own fenced block.
    const processed = masked
      .split(/(\n{2,})/)
      .map((chunk) => {
        if (/^\n{2,}$/.test(chunk)) return chunk; // keep separators
        if (!chunk.trim()) return chunk;
        if (chunk.includes(' FENCE')) return chunk;
        if (BOX_PATTERN.test(chunk)) return '\n```\n' + chunk + '\n```\n';
        return chunk;
      })
      .join('');

    return processed.replace(/ FENCE(\d+) /g, (_m, i) => placeholders[Number(i)]);
  }

  /** Render markdown to sanitized HTML, falling back to plain text if marked.js unavailable */
  _renderMarkdown(text) {
    if (typeof marked !== 'undefined' && marked.parse) {
      try {
        const prepared = this._preprocessAsciiArt(text);
        let html = this._sanitizeHtml(marked.parse(prepared, { breaks: true, gfm: true }));
        // Wrap tables in a horizontal-scroll container so they overflow gracefully
        // on mobile without collapsing into block-level cells.
        html = html.replace(/<table>/g, '<div class="rv-table-wrap"><table>')
                   .replace(/<\/table>/g, '</table></div>');
        // Tag code blocks containing box-drawing glyphs as diagrams (same
        // narrow trigger as _preprocessAsciiArt — arrows/geometric shapes
        // don't count because they appear frequently in prose).
        // Default is wrap (readable on mobile); a toggle button lets the user
        // switch to horizontal-scroll mode when the original structure matters.
        // The button must live OUTSIDE the <pre> scroll container so it stays
        // pinned to the visual right edge when the user scrolls horizontally.
        const DIAGRAM_CHAR = /[─-╿▀-▟]/;
        const tmpl = document.createElement('template');
        tmpl.innerHTML = html;
        tmpl.content.querySelectorAll('pre > code').forEach((code) => {
          if (!DIAGRAM_CHAR.test(code.textContent || '')) return;
          const pre = code.parentElement;
          pre.classList.add('rv-diagram');

          const wrap = document.createElement('div');
          wrap.className = 'rv-diagram-wrap';

          const btn = document.createElement('button');
          btn.className = 'rv-wrap-toggle';
          btn.type = 'button';
          btn.setAttribute('aria-label', 'Toggle line wrapping');
          btn.setAttribute('title', 'Toggle line wrapping');

          pre.parentNode.insertBefore(wrap, pre);
          wrap.appendChild(btn);
          wrap.appendChild(pre);
        });
        return tmpl.innerHTML;
      } catch { /* fall through */ }
    }
    // Fallback: escape HTML and preserve whitespace
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre style="white-space:pre-wrap;word-break:break-word">${escaped}</pre>`;
  }

  /**
   * Bind click handlers inside the response viewer body. Uses event delegation
   * so a single listener serves every diagram-toggle button, including those
   * added when the conversation is reloaded. Idempotent via a dataset flag.
   */
  _bindResponseViewerInteractions(body) {
    if (!body || body.dataset.rvBound === '1') return;
    body.dataset.rvBound = '1';
    body.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.rv-wrap-toggle');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const wrap = btn.closest('.rv-diagram-wrap');
      const pre = wrap?.querySelector('pre.rv-diagram');
      if (!pre || !wrap) return;
      const nowrap = pre.classList.toggle('rv-nowrap');
      wrap.classList.toggle('rv-wrap-nowrap', nowrap);
    });
  }

  async toggleResponseViewer() {
    const viewer = document.getElementById('responseViewer');
    const backdrop = document.getElementById('responseViewerBackdrop');
    if (!viewer) return;

    const isOpen = viewer.classList.contains('visible');
    if (isOpen) {
      viewer.classList.remove('visible');
      backdrop.classList.remove('visible');
      return;
    }

    if (!this.activeSessionId) return;
    try {
      // Source 1: Transcript JSONL (best quality — clean structured text from Claude)
      const res = await fetch(`/api/sessions/${this.activeSessionId}/last-response`);
      const data = await res.json();
      let lastResponse = data.text || '';

      // Source 2: Terminal buffer fallback — strip ANSI, drop Claude CLI chrome
      if (!lastResponse) {
        const termRes = await fetch(`/api/sessions/${this.activeSessionId}/terminal`);
        const termData = await termRes.json();
        if (termData.terminalBuffer) {
          lastResponse = this._cleanTerminalBuffer(termData.terminalBuffer);
        }
      }

      const body = document.getElementById('responseViewerBody');
      body.innerHTML = this._renderMarkdown(lastResponse);
      this._bindResponseViewerInteractions(body);

      // Reset state for fresh open
      const title = document.getElementById('responseViewerTitle');
      const moreBtn = document.getElementById('responseViewerMore');
      if (title) title.textContent = 'Last Response';
      if (moreBtn) { moreBtn.style.display = ''; moreBtn.textContent = 'More'; }

      viewer.classList.add('visible');
      backdrop.classList.add('visible');
      body.scrollTop = 0;
    } catch (err) {
      console.error('Failed to load response:', err);
    }
  }

  async loadFullContext() {
    if (!this.activeSessionId) return;
    const moreBtn = document.getElementById('responseViewerMore');
    if (moreBtn) moreBtn.textContent = '...';
    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/last-response?context=full`);
      const data = await res.json();
      const messages = data.messages || [];
      const body = document.getElementById('responseViewerBody');
      const title = document.getElementById('responseViewerTitle');
      if (!body) return;

      if (messages.length === 0) {
        body.textContent = 'No conversation history available';
        return;
      }

      // Render conversation thread
      body.innerHTML = '';
      for (const msg of messages) {
        const div = document.createElement('div');
        const isUser = msg.role === 'user';
        div.className = 'rv-message ' + (isUser ? 'rv-msg-user' : 'rv-msg-assistant');

        const role = document.createElement('div');
        role.className = 'rv-role ' + (isUser ? 'rv-role-user' : 'rv-role-assistant');
        role.textContent = isUser ? 'You' : 'Claude';
        div.appendChild(role);

        const text = document.createElement('div');
        text.className = 'rv-text';
        text.innerHTML = this._renderMarkdown(msg.text);
        div.appendChild(text);

        body.appendChild(div);
      }
      this._bindResponseViewerInteractions(body);

      if (title) title.textContent = `Conversation (${messages.length} messages)`;
      if (moreBtn) moreBtn.style.display = 'none';
      // Scroll to bottom (latest message)
      body.scrollTop = body.scrollHeight;
    } catch (err) {
      console.error('Failed to load context:', err);
    } finally {
      if (moreBtn) moreBtn.textContent = 'More';
    }
  }

  async _onSessionNeedsRefresh() {
    // Server sends this after SSE backpressure clears — terminal data was dropped,
    // so reload the buffer to recover from any display corruption.
    if (!this.activeSessionId || !this.terminal) return;
    // Skip if buffer load already in progress — avoids competing clear+rewrite cycles
    if (this._isLoadingBuffer) return;
    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`);
      const data = await res.json();
      if (data.terminalBuffer) {
        this.terminal.clear();
        this.terminal.reset();
        await this.chunkedTerminalWrite(data.terminalBuffer);
        this.terminal.scrollToBottom();
        // Re-position local echo overlay at new prompt location
        this._localEchoOverlay?.rerender();
        // Resize PTY to match actual browser dimensions (critical for OpenCode
        // TUI sessions that render at fixed 120x40 until told the real size)
        if (this.activeSessionId) {
          this.sendResize(this.activeSessionId);
        }
      }
    } catch (err) {
      console.error('needsRefresh reload failed:', err);
    }
  }

  async _onSessionClearTerminal(data) {
    if (data.id === this.activeSessionId) {
      // Skip if selectSession is already loading the buffer — clearTerminal arriving
      // during buffer load would clear the terminal mid-write, causing visible flicker
      // and a race between two concurrent chunkedTerminalWrite calls (especially on mobile
      // where rAF is slower). selectSession will handle the final buffer state.
      if (this._isLoadingBuffer) return;

      // Fetch buffer, clear terminal, write buffer, resize (no Ctrl+L needed)
      try {
        const res = await fetch(`/api/sessions/${data.id}/terminal`);
        const termData = await res.json();

        this.terminal.clear();
        this.terminal.reset();
        if (termData.terminalBuffer) {
          // Strip any DEC 2026 markers and write raw content
          // (markers don't help here - this is a static buffer reload, not live Ink redraws)
          const cleanBuffer = termData.terminalBuffer.replace(DEC_SYNC_STRIP_RE, '');
          // Use chunked write to avoid UI freeze with large buffers (can be 1-2MB)
          await this.chunkedTerminalWrite(cleanBuffer);
        }

        // Fire-and-forget resize — don't block on it
        this.sendResize(data.id);
        // Re-position local echo overlay at new prompt location
        this._localEchoOverlay?.rerender();
      } catch (err) {
        console.error('clearTerminal refresh failed:', err);
      }
    }
  }

  _onSessionCompletion(data) {
    this.totalCost += data.cost || 0;
    this.updateCost();
    if (data.id === this.activeSessionId) {
      this.terminal.writeln('');
      this.terminal.writeln(`\x1b[1;32m Done (Cost: $${(data.cost || 0).toFixed(4)})\x1b[0m`);
    }
  }

  _onSessionError(data) {
    if (data.id === this.activeSessionId) {
      this.terminal.writeln(`\x1b[1;31m Error: ${data.error}\x1b[0m`);
    }
    this._notifySession(data.id, 'critical', 'session-error', 'Session Error', data.error || 'Unknown error');
  }

  _onSessionExit(data) {
    if (this._wsSessionId === data.id) this._disconnectWs();
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'stopped';
      this.renderSessionTabs();
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Notify on unexpected exit (non-zero code)
    if (data.code && data.code !== 0) {
      this._notifySession(data.id, 'critical', 'session-crash', 'Session Crashed', `Exited with code ${data.code}`);
    }
  }

  _onSessionIdle(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'idle';
      this.renderSessionTabs();
      this.sendPendingCtrlL(data.id);
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Start stuck detection timer (only if no respawn running)
    if (!this.respawnStatus[data.id]?.enabled) {
      const threshold = this.notificationManager?.preferences?.stuckThresholdMs || 600000;
      clearTimeout(this.idleTimers.get(data.id));
      this.idleTimers.set(data.id, setTimeout(() => {
        this._notifySession(data.id, 'warning', 'session-stuck', 'Session Idle', `Idle for ${Math.round(threshold / 60000)}+ minutes`);
        this.idleTimers.delete(data.id);
      }, threshold));
    }
  }

  _onSessionWorking(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'busy';
      // Only clear tab alert if no pending hooks (permission_prompt, elicitation_dialog, etc.)
      if (!this.pendingHooks.has(data.id)) {
        this.tabAlerts.delete(data.id);
      }
      this.renderSessionTabs();
      this.sendPendingCtrlL(data.id);
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Clear stuck detection timer
    const timer = this.idleTimers.get(data.id);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(data.id);
    }
  }

  _onSessionAutoClear(data) {
    if (data.sessionId === this.activeSessionId) {
      this.showToast(`Auto-cleared at ${data.tokens.toLocaleString()} tokens`, 'info');
      this.updateRespawnTokens(0);
    }
    this._notifySession(data.sessionId, 'info', 'auto-clear', 'Auto-Cleared', `Context reset at ${(data.tokens || 0).toLocaleString()} tokens`);
  }

  _onSessionCliInfo(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) {
      if (data.version) session.cliVersion = data.version;
      if (data.model) session.cliModel = data.model;
      if (data.accountType) session.cliAccountType = data.accountType;
      if (data.latestVersion) session.cliLatestVersion = data.latestVersion;
    }
    if (data.sessionId === this.activeSessionId) {
      this.updateCliInfoDisplay();
    }
  }

  // Scheduled runs
  _onScheduledCreated(data) {
    this.currentRun = data;
    this.showTimer();
  }

  _onScheduledUpdated(data) {
    this.currentRun = data;
    this.updateTimer();
  }

  _onScheduledCompleted(data) {
    this.currentRun = data;
    this.hideTimer();
    this.showToast('Scheduled run completed!', 'success');
  }

  _onScheduledStopped() {
    this.currentRun = null;
    this.hideTimer();
  }

  // ═══════════════════════════════════════════════════════════════
  // Connection Status, Input Queuing & State Initialization
  // ═══════════════════════════════════════════════════════════════

  setConnectionStatus(status) {
    this._connectionStatus = status;
    this._updateConnectionIndicator();
    if (status === 'connected' && this._inputQueue.size > 0) {
      this._drainInputQueues();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // WebSocket Terminal I/O
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open a WebSocket for terminal I/O on the given session.
   * Replaces HTTP POST input and SSE terminal output with a single
   * bidirectional connection. Falls back to SSE+POST if WS fails.
   */
  _connectWs(sessionId) {
    this._disconnectWs();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/sessions/${sessionId}/terminal`;
    const ws = new WebSocket(url);
    this._ws = ws;
    this._wsSessionId = sessionId;

    ws.onopen = () => {
      // Only mark ready if this is still the intended session
      if (this._ws === ws) {
        this._wsReady = true;
        this._wsReconnectAttempts = 0;
      }
    };

    ws.onmessage = (event) => {
      if (this._ws !== ws) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.t === 'o') {
          // Terminal output — route through the same batching pipeline as SSE
          this._onSessionTerminal({ id: sessionId, data: msg.d });
        } else if (msg.t === 'c') {
          this._onSessionClearTerminal({ id: sessionId });
        } else if (msg.t === 'r') {
          this._onSessionNeedsRefresh({ id: sessionId });
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      if (this._ws !== ws) return;
      this._ws = null;
      this._wsSessionId = null;
      this._wsReady = false;

      // Reconnect on unexpected close (server restart, network blip, ping timeout).
      // Don't reconnect if we intentionally disconnected (_disconnectWs nulls onclose)
      // or if the server rejected the session (4004=not found, 4008=too many, 4009=terminated).
      if (event.code < 4004 && this.activeSessionId === sessionId) {
        const delay = Math.min(1000 * Math.pow(2, this._wsReconnectAttempts || 0), 10000);
        this._wsReconnectAttempts = (this._wsReconnectAttempts || 0) + 1;
        this._wsReconnectTimer = setTimeout(() => {
          this._wsReconnectTimer = null;
          if (this.activeSessionId === sessionId) {
            this._connectWs(sessionId);
          }
        }, delay);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror — cleanup happens there
    };
  }

  /** Close the active WebSocket connection (if any). */
  _disconnectWs() {
    this._clearTimer('_wsReconnectTimer');
    this._wsReconnectAttempts = 0;
    if (this._ws) {
      this._ws.onclose = null; // Prevent re-entrant cleanup
      this._ws.close();
      this._ws = null;
      this._wsSessionId = null;
      this._wsReady = false;
    }
  }

  /**
   * Send input to server without blocking the keystroke flush cycle.
   * Uses a sequential promise chain to preserve character ordering
   * across concurrent async fetches.
   */
  _sendInputAsync(sessionId, input) {
    // Queue immediately if offline
    if (!this.isOnline || this._connectionStatus === 'disconnected') {
      this._enqueueInput(sessionId, input);
      return;
    }

    // Fast path: WebSocket — fire-and-forget, inherently ordered (single TCP stream).
    if (this._wsReady && this._wsSessionId === sessionId) {
      try {
        this._ws.send(JSON.stringify({ t: 'i', d: input }));
        this.clearPendingHooks(sessionId);
        return;
      } catch {
        // WS send failed — fall through to HTTP POST
      }
    }

    // Slow path: HTTP POST — chain on dispatch only, don't wait for response.
    // The server handles writeViaMux as fire-and-forget anyway.
    this._inputSendChain = this._inputSendChain.then(() => {
      const fetchPromise = fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        keepalive: input.length < 65536,
      });

      // Handle response asynchronously — don't block next keystroke on response
      fetchPromise.then(resp => {
        if (!resp.ok) {
          this._enqueueInput(sessionId, input);
        } else {
          this.clearPendingHooks(sessionId);
        }
      }).catch(() => {
        this._enqueueInput(sessionId, input);
      });

      // Return immediately after fetch is dispatched (don't await response)
    });
  }


  _enqueueInput(sessionId, input) {
    const existing = this._inputQueue.get(sessionId) || '';
    let combined = existing + input;
    // Enforce 64KB cap — keep most recent keystrokes
    if (combined.length > this._inputQueueMaxBytes) {
      combined = combined.slice(combined.length - this._inputQueueMaxBytes);
    }
    this._inputQueue.set(sessionId, combined);
    this._updateConnectionIndicator();
  }

  async _drainInputQueues() {
    if (this._inputQueue.size === 0) return;
    // Snapshot and clear
    const queued = new Map(this._inputQueue);
    this._inputQueue.clear();
    this._updateConnectionIndicator();

    for (const [sessionId, input] of queued) {
      const resp = await this._apiPost(`/api/sessions/${sessionId}/input`, { input });
      if (!resp?.ok) {
        this._enqueueInput(sessionId, input);
      }
    }
    this._updateConnectionIndicator();
  }

  _updateConnectionIndicator() {
    const indicator = this.$('connectionIndicator');
    const dot = this.$('connectionDot');
    const text = this.$('connectionText');
    if (!indicator || !dot || !text) return;

    let totalBytes = 0;
    for (const v of this._inputQueue.values()) totalBytes += v.length;

    const status = this._connectionStatus;
    const hasQueue = totalBytes > 0;

    // Connected with empty queue — hide
    if ((status === 'connected' || status === 'connecting') && !hasQueue) {
      indicator.style.display = 'none';
      return;
    }

    indicator.style.display = 'flex';
    dot.className = 'connection-dot';

    const formatBytes = (b) => b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`;

    if (status === 'connected' && hasQueue) {
      // Draining
      dot.classList.add('draining');
      text.textContent = `Sending ${formatBytes(totalBytes)}...`;
    } else if (status === 'reconnecting') {
      dot.classList.add('reconnecting');
      text.textContent = hasQueue ? `Reconnecting (${formatBytes(totalBytes)} queued)` : 'Reconnecting...';
    } else {
      // Offline or disconnected
      dot.classList.add('offline');
      text.textContent = hasQueue ? `Offline (${formatBytes(totalBytes)} queued)` : 'Offline';
    }
  }

  setupOnlineDetection() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.reconnectAttempts = 0;
      this.connectSSE();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.setConnectionStatus('offline');
    });
  }

  /** Show/hide the CJK input textarea based on user setting or server override */
  _updateCjkInputState() {
    const cjkEl = document.getElementById('cjkInput');
    if (!cjkEl) return;
    const settings = this.loadAppSettingsFromStorage();
    const showCjk = this._serverCjkOverride || settings.cjkInputEnabled || false;
    cjkEl.style.display = showCjk ? 'block' : 'none';
    if (!showCjk) window.cjkActive = false;
  }

  /**
   * Reset all app state maps, timers, and handlers to a clean baseline.
   * Called by handleInit() on SSE reconnect / page reload to prevent
   * memory leaks and stale data.
   */
  _resetAllAppState() {
    this.sessions.clear();
    this.ralphStates.clear();
    this.terminalBuffers.clear();
    this.terminalBufferCache.clear();
    this.projectInsights.clear();
    this.teams.clear();
    this.teamTasks.clear();
    // Clear all idle timers to prevent stale timers from firing
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    // Clear flicker filter state
    this._clearTimer('flickerFilterTimeout');
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    // Clear pending terminal writes
    this._clearTimer('syncWaitTimeout');
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    // Abort any in-flight chunkedTerminalWrite (SSE reconnect reloads buffers)
    this._chunkedWriteGen = (this._chunkedWriteGen || 0) + 1;
    // Preserve local echo overlay text across SSE reconnect — just hide until
    // terminal buffer reloads and prompt is visible again.  _render() re-scans
    // for the ❯ prompt on every call, so rerender() after buffer load repositions it.
    this._localEchoOverlay?.rerender();
    // Clear pending hooks
    this.pendingHooks.clear();
    // Clear parent name cache (prevents stale session name entries accumulating)
    if (this._parentNameCache) this._parentNameCache.clear();
    // Clear subagent activity/results maps (prevents leaks if data.subagents is missing)
    this.subagentActivity.clear();
    this.subagentToolResults.clear();
    // Clean up mobile/keyboard handlers and re-init (prevents listener accumulation on reconnect)
    MobileDetection.cleanup();
    KeyboardHandler.cleanup();
    MobileDetection.init();
    KeyboardHandler.init();
    // Clear tab alerts
    this.tabAlerts.clear();
    // Clear shown completions (used for duplicate notification prevention)
    if (this._shownCompletions) {
      this._shownCompletions.clear();
    }
    // Clear notification manager title flash interval to prevent memory leak
    if (this.notificationManager?.titleFlashInterval) {
      clearInterval(this.notificationManager.titleFlashInterval);
      this.notificationManager.titleFlashInterval = null;
    }
    // Clear notification manager grouping timeouts (prevents orphaned timers)
    if (this.notificationManager?.groupingMap) {
      for (const { timeout } of this.notificationManager.groupingMap.values()) {
        clearTimeout(timeout);
      }
      this.notificationManager.groupingMap.clear();
    }
    // Disconnect terminal resize observer (prevents memory leak on reconnect)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
      this.terminalResizeObserver = null;
    }
    // Clear any other orphaned timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
  }

  handleInit(data) {
    // Clear the init fallback timer since we got data
    this._clearTimer('_initFallbackTimer');
    const gen = ++this._initGeneration;

    // CJK input form: controlled by user setting (with server env as override)
    this._serverCjkOverride = data.inputCjkForm || false;
    this._updateCjkInputState();

    // Update version displays (header and toolbar)
    if (data.version) {
      const versionEl = this.$('versionDisplay');
      const headerVersionEl = this.$('headerVersion');
      if (versionEl) {
        versionEl.textContent = `v${data.version}`;
        versionEl.title = `Codeman v${data.version}`;
      }
      if (headerVersionEl) {
        headerVersionEl.textContent = `v${data.version}`;
        headerVersionEl.title = `Codeman v${data.version}`;
      }
    }

    // Stop any active voice recording on reconnect
    VoiceInput.cleanup();

    this._resetAllAppState();

    data.sessions.forEach(s => {
      this.sessions.set(s.id, s);
      // Load ralph state from session data (only if not explicitly closed by user)
      if ((s.ralphLoop || s.ralphTodos) && !this.ralphClosedSessions.has(s.id)) {
        this.ralphStates.set(s.id, {
          loop: s.ralphLoop || null,
          todos: s.ralphTodos || []
        });
      }
    });

    // Restore tabs that were open before refresh but are no longer on the server
    this._restoreEndedTabs();

    // Sync sessionOrder with current sessions (preserve order, add new, remove stale)
    this.syncSessionOrder();

    if (data.respawnStatus) {
      this.respawnStatus = data.respawnStatus;
    } else {
      // Clear respawn status on init if not provided (prevents stale data)
      this.respawnStatus = {};
    }
    // Clean up respawn state for sessions that no longer exist
    this.respawnTimers = {};
    this.respawnCountdownTimers = {};
    this.respawnActionLogs = {};

    // Store global stats for aggregate tracking
    if (data.globalStats) {
      this.globalStats = data.globalStats;
    }

    this.totalCost = data.sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    this.totalCost += data.scheduledRuns.reduce((sum, r) => sum + (r.totalCost || 0), 0);

    const activeRun = data.scheduledRuns.find(r => r.status === 'running');
    if (activeRun) {
      this.currentRun = activeRun;
      this.showTimer();
    }

    this.updateCost();
    this.renderSessionTabs();

    // Start/stop system stats polling based on session count
    if (this.sessions.size > 0) {
      this.startSystemStatsPolling();
    } else {
      this.stopSystemStatsPolling();
    }

    // CRITICAL: Clean up all floating windows before loading new subagents
    // This prevents memory leaks from ResizeObservers, EventSources, and DOM elements
    this.cleanupAllFloatingWindows();

    // Load subagents - clear all related maps to prevent memory leaks on reconnect
    if (data.subagents) {
      this.subagents.clear();
      this.subagentActivity.clear();
      this.subagentToolResults.clear();
      data.subagents.forEach(s => {
        this.subagents.set(s.agentId, s);
      });
      this.renderSubagentPanel();

      // Load PERSISTENT parent associations FIRST, before restoring windows
      // This ensures connection lines are drawn to the correct tabs
      // Clear the in-memory map first to ensure fresh state from storage
      this.subagentParentMap.clear();
      this.loadSubagentParentMap().then(() => {
        // Apply stored parent associations to agents
        for (const [agentId, sessionId] of this.subagentParentMap) {
          const agent = this.subagents.get(agentId);
          if (agent && this.sessions.has(sessionId)) {
            agent.parentSessionId = sessionId;
            const session = this.sessions.get(sessionId);
            if (session) {
              agent.parentSessionName = this.getSessionName(session);
            }
            this.subagents.set(agentId, agent);
          }
        }

        // Now try to find parents for any agents that don't have one yet
        for (const [agentId] of this.subagents) {
          if (!this.subagentParentMap.has(agentId)) {
            this.findParentSessionForSubagent(agentId);
          }
        }

        // Finally, restore window states (this opens windows with correct parent info)
        this.restoreSubagentWindowStates();
      });
    }

    // Restore previously active session (survives page reload + SSE reconnect)
    // Must always re-select because handleInit clears terminal state above.
    // Reset activeSessionId so selectSession doesn't early-return.
    // Guard: skip if a newer handleInit has already started (race between loadState + SSE init).
    if (gen !== this._initGeneration) return;
    const previousActiveId = this.activeSessionId;
    this.activeSessionId = null;
    if (this.sessionOrder.length > 0) {
      // Priority: current active > localStorage > first session
      let restoreId = previousActiveId;
      if (!restoreId || !this.sessions.has(restoreId)) {
        try { restoreId = localStorage.getItem('codeman-active-session'); } catch {}
      }
      if (restoreId && this.sessions.has(restoreId)) {
        this.selectSession(restoreId);
      } else {
        this.selectSession(this.sessionOrder[0]);
      }
    }
  }

  async loadState() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      this.handleInit(data);
    } catch (err) {
      console.error('Failed to load state:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Debounce Utility
  // ═══════════════════════════════════════════════════════════════

  /** Debounce a method call using a named timer key. */
  _debouncedCall(timerKey, fn, delayMs = 100) {
    if (this._debounceTimers[timerKey]) {
      clearTimeout(this._debounceTimers[timerKey]);
    }
    this._debounceTimers[timerKey] = setTimeout(() => {
      this._debounceTimers[timerKey] = null;
      fn.call(this);
    }, delayMs);
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Tabs
  // ═══════════════════════════════════════════════════════════════

  renderSessionTabs() {
    // Don't re-render while user is typing in the inline rename input
    if (this._activeRename) return;
    this._debouncedCall('sessionTabs', this._renderSessionTabsImmediate);
  }

  /** Toggle .active class on tabs immediately (no debounce). Used by selectSession(). */
  _updateActiveTabImmediate(sessionId) {
    const container = this.$('sessionTabs');
    if (!container) return;
    const tabs = container.querySelectorAll('.session-tab[data-id]');
    for (const tab of tabs) {
      if (tab.dataset.id === sessionId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    }
  }

  _renderSessionTabsImmediate() {
    const container = this.$('sessionTabs');
    const existingTabs = container.querySelectorAll('.session-tab[data-id]');
    const existingIds = new Set([...existingTabs].map(t => t.dataset.id));
    const currentIds = new Set(this.sessions.keys());

    // Check if we can do incremental update (same session IDs)
    const canIncremental = existingIds.size === currentIds.size &&
      [...existingIds].every(id => currentIds.has(id));

    if (canIncremental) {
      // Incremental update - only modify changed properties
      for (const [id, session] of this.sessions) {
        const tab = container.querySelector(`.session-tab[data-id="${id}"]`);
        if (!tab) continue;

        const isActive = id === this.activeSessionId;
        const status = session.status || 'idle';
        const name = this.getSessionName(session);
        const taskStats = session.taskStats || { running: 0, total: 0 };
        const hasRunningTasks = taskStats.running > 0;

        // Update active class
        if (isActive && !tab.classList.contains('active')) {
          tab.classList.add('active');
        } else if (!isActive && tab.classList.contains('active')) {
          tab.classList.remove('active');
        }

        // Update alert class
        const alertType = this.tabAlerts.get(id);
        const wantAction = alertType === 'action';
        const wantIdle = alertType === 'idle';
        const hasAction = tab.classList.contains('tab-alert-action');
        const hasIdle = tab.classList.contains('tab-alert-idle');
        if (wantAction && !hasAction) { tab.classList.add('tab-alert-action'); tab.classList.remove('tab-alert-idle'); }
        else if (wantIdle && !hasIdle) { tab.classList.add('tab-alert-idle'); tab.classList.remove('tab-alert-action'); }
        else if (!alertType && (hasAction || hasIdle)) { tab.classList.remove('tab-alert-action', 'tab-alert-idle'); }

        // Inject tab-number badge if missing (added after initial render)
        if (!tab.querySelector('.tab-number')) {
          const idx = this.sessionOrder.indexOf(id);
          if (idx >= 0 && idx < 9) {
            const numSpan = document.createElement('span');
            numSpan.className = 'tab-number';
            numSpan.textContent = String(idx + 1);
            tab.insertBefore(numSpan, tab.firstChild);
          }
        }

        // Update status indicator
        const statusEl = tab.querySelector('.tab-status');
        if (statusEl && !statusEl.classList.contains(status)) {
          statusEl.className = `tab-status ${status}`;
        }

        // Update name if changed
        const nameEl = tab.querySelector('.tab-name');
        if (nameEl && nameEl.textContent !== name) {
          const _p = parseSessionPrefix(name);
          if (_p && _p.suffix) {
            nameEl.innerHTML = '<span class="tab-prefix">' + escapeHtml(_p.prefix) + '</span><span class="tab-suffix">: ' + escapeHtml(_p.suffix) + '</span>';
          } else {
            nameEl.textContent = name;
          }
        }

        // Update task badge
        const badgeEl = tab.querySelector('.tab-badge');
        if (hasRunningTasks) {
          if (badgeEl) {
            if (badgeEl.textContent !== String(taskStats.running)) {
              badgeEl.textContent = taskStats.running;
            }
          } else {
            // Need to add badge - do full rebuild
            this._fullRenderSessionTabs();
            return;
          }
        } else if (badgeEl) {
          // Need to remove badge - do full rebuild
          this._fullRenderSessionTabs();
          return;
        }

        // Update subagent badge - targeted update without full rebuild
        const subagentBadgeEl = tab.querySelector('.tab-subagent-badge');
        const minimizedAgents = this.minimizedSubagents.get(id);
        const minimizedCount = minimizedAgents?.size || 0;
        if (minimizedCount > 0 && subagentBadgeEl) {
          // Badge exists and still has agents - update label and dropdown in-place
          const labelEl = subagentBadgeEl.querySelector('.subagent-label');
          const newLabel = minimizedCount === 1 ? 'AGENT' : `AGENTS (${minimizedCount})`;
          if (labelEl && labelEl.textContent !== newLabel) {
            labelEl.textContent = newLabel;
          }
          // Rebuild dropdown items (agent list may have changed)
          const dropdownEl = subagentBadgeEl.querySelector('.subagent-dropdown');
          if (dropdownEl) {
            const newBadgeHtml = this.renderSubagentTabBadge(id, minimizedAgents);
            const temp = document.createElement('div');
            temp.innerHTML = newBadgeHtml;
            const newDropdown = temp.querySelector('.subagent-dropdown');
            if (newDropdown) {
              dropdownEl.innerHTML = newDropdown.innerHTML;
            }
          }
        } else if (minimizedCount > 0 && !subagentBadgeEl) {
          // Need to add badge - insert before gear icon
          const badgeHtml = this.renderSubagentTabBadge(id, minimizedAgents);
          const gearEl = tab.querySelector('.tab-gear');
          if (gearEl) {
            gearEl.insertAdjacentHTML('beforebegin', badgeHtml);
          }
        } else if (minimizedCount === 0 && subagentBadgeEl) {
          // Count went to 0 - remove badge
          subagentBadgeEl.remove();
        }
      }
    } else {
      // Full rebuild needed (sessions added/removed)
      this._fullRenderSessionTabs();
    }

  }

  _fullRenderSessionTabs() {
    if (this._activeRename) return;
    const container = this.$('sessionTabs');

    // Clean up any orphaned dropdowns before re-rendering
    document.querySelectorAll('body > .subagent-dropdown').forEach(d => d.remove());
    this.cancelHideSubagentDropdown();

    // Build tabs HTML using array for better string concatenation performance
    // Iterate in sessionOrder to respect user's custom tab arrangement
    // On mobile: put active session first (only one tab visible anyway)
    const parts = [];
    let tabOrder = this.sessionOrder;
    if (MobileDetection.getDeviceType() === 'mobile' && this.activeSessionId) {
      // Reorder to put active tab first
      tabOrder = [this.activeSessionId, ...this.sessionOrder.filter(id => id !== this.activeSessionId)];
    }
    let _tabIdx = 0;
    for (const id of tabOrder) {
      const session = this.sessions.get(id);
      if (!session) continue; // Skip if session was removed

      const isActive = id === this.activeSessionId;
      const status = session.status || 'idle';
      const name = this.getSessionName(session);
      const mode = session.mode || 'claude';
      const color = session.color || 'default';
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;
      const alertType = this.tabAlerts.get(id);
      const alertClass = alertType === 'action' ? ' tab-alert-action' : alertType === 'idle' ? ' tab-alert-idle' : '';

      // Get minimized subagents for this session
      const minimizedAgents = this.minimizedSubagents.get(id);
      const minimizedCount = minimizedAgents?.size || 0;
      const subagentBadge = minimizedCount > 0 ? this.renderSubagentTabBadge(id, minimizedAgents) : '';

      // Show folder name if session has a custom name AND tall tabs setting is enabled
      const folderName = session.workingDir ? session.workingDir.split('/').pop() || '' : '';
      const tallTabsEnabled = this._tallTabsEnabled ?? false;
      const showFolder = tallTabsEnabled && session.name && folderName && folderName !== name;

      const endedAttr = session._ended ? ' data-ended="1"' : '';
      parts.push(`<div class="session-tab ${isActive ? 'active' : ''}${alertClass}" data-id="${id}" data-color="${color}"${endedAttr} onclick="app.selectSession('${escapeHtml(id)}')" oncontextmenu="event.preventDefault(); app.startInlineRename('${escapeHtml(id)}')" tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-label="${escapeHtml(name)} session" ${session.workingDir ? `title="${escapeHtml(session.workingDir)}"` : ''}>
          ${_tabIdx < 9 ? '<span class="tab-number">' + (_tabIdx + 1) + '</span>' : ''}
          <span class="tab-status ${status}" aria-hidden="true"></span>
          <span class="tab-info">
            <span class="tab-name-row">
              ${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : mode === 'opencode' ? '<span class="tab-mode opencode" aria-hidden="true">oc</span>' : ''}
              <span class="tab-name" data-session-id="${id}">${(() => { const p = parseSessionPrefix(name); return p && p.suffix ? '<span class="tab-prefix">' + escapeHtml(p.prefix) + '</span><span class="tab-suffix">: ' + escapeHtml(p.suffix) + '</span>' : escapeHtml(name); })()}</span>
            </span>
            ${showFolder ? `<span class="tab-folder">\u{1F4C1} ${escapeHtml(folderName)}</span>` : ''}
          </span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()" aria-label="${taskStats.running} running tasks">${taskStats.running}</span>` : ''}
          ${subagentBadge}
          <span class="tab-gear" onclick="event.stopPropagation(); app.openSessionOptions('${escapeHtml(id)}')" title="Session options" aria-label="Session options" tabindex="0">&#x2699;</span>
          <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession('${escapeHtml(id)}')" title="Close session" aria-label="Close session" tabindex="0">&times;</span>
        </div>`);
      _tabIdx++;
    }

    container.innerHTML = parts.join('');

    // Persist tab metadata for refresh recovery
    this._saveTabMetadata();

    // Set up drag-and-drop handlers for tab reordering
    this.setupTabDragHandlers();

    // Set up keyboard navigation for tabs
    this.setupTabKeyboardNavigation(container);

    // Update connection lines after tabs change (positions may have shifted)
    this.updateConnectionLines();
  }

  // Set up arrow key navigation for session tabs (accessibility)
  setupTabKeyboardNavigation(container) {
    // Remove existing listener if any to avoid duplicates
    if (this._tabKeydownHandler) {
      container.removeEventListener('keydown', this._tabKeydownHandler);
    }

    this._tabKeydownHandler = (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;

      const tabs = [...container.querySelectorAll('.session-tab')];
      const currentIndex = tabs.indexOf(document.activeElement);

      // Enter or Space activates the tab
      if ((e.key === 'Enter' || e.key === ' ') && currentIndex >= 0) {
        e.preventDefault();
        const sessionId = tabs[currentIndex].dataset.id;
        this.selectSession(sessionId);
        return;
      }

      if (currentIndex < 0) return;

      let newIndex;
      switch (e.key) {
        case 'ArrowLeft':
          newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
          break;
        case 'ArrowRight':
          newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
          break;
        case 'Home':
          newIndex = 0;
          break;
        case 'End':
          newIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      tabs[newIndex]?.focus();
    };

    container.addEventListener('keydown', this._tabKeydownHandler);
  }


  // ═══════════════════════════════════════════════════════════════
  // Tab Order and Drag-and-Drop
  // ═══════════════════════════════════════════════════════════════

  // Sync sessionOrder with current sessions (preserve order for existing, add new at end)
  syncSessionOrder() {
    const currentIds = new Set(this.sessions.keys());

    // Load saved order from localStorage
    const savedOrder = this.loadSessionOrder();

    // Start with saved order, keeping only sessions that still exist
    const preserved = savedOrder.filter(id => currentIds.has(id));
    const preservedSet = new Set(preserved);

    // Add any new sessions at the end
    const newSessions = [...currentIds].filter(id => !preservedSet.has(id));

    this.sessionOrder = [...preserved, ...newSessions];
  }

  // Load session order from localStorage
  loadSessionOrder() {
    try {
      const saved = localStorage.getItem('codeman-session-order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  // Save session order to localStorage
  saveSessionOrder() {
    try {
      localStorage.setItem('codeman-session-order', JSON.stringify(this.sessionOrder));
    } catch {
      // Ignore storage errors
    }
  }

  // Save tab metadata to localStorage so ended sessions can be restored after refresh
  _saveTabMetadata() {
    try {
      const meta = {};
      for (const [id, s] of this.sessions) {
        if (s._ended) continue; // Don't persist ended stubs back
        meta[id] = { id, name: s.name || '', workingDir: s.workingDir || '', mode: s.mode || 'claude', color: s.color || 'default' };
      }
      localStorage.setItem('codeman-tab-meta', JSON.stringify(meta));
    } catch { /* ignore */ }
  }

  // Restore tabs that were open before refresh but are no longer on the server
  _restoreEndedTabs() {
    try {
      const saved = localStorage.getItem('codeman-tab-meta');
      if (!saved) return;
      const meta = JSON.parse(saved);
      for (const [id, info] of Object.entries(meta)) {
        if (!this.sessions.has(id)) {
          // Add a stub session so the tab renders
          this.sessions.set(id, { id, name: info.name, workingDir: info.workingDir, mode: info.mode, color: info.color, status: 'ended', _ended: true });
        }
      }
    } catch { /* ignore */ }
  }

  // Set up drag-and-drop handlers on tab elements
  setupTabDragHandlers() {
    const container = this.$('sessionTabs');
    const tabs = container.querySelectorAll('.session-tab[data-id]');

    tabs.forEach(tab => {
      tab.setAttribute('draggable', 'true');

      tab.addEventListener('dragstart', (e) => {
        this.draggedTabId = tab.dataset.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.dataset.id);
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        this.draggedTabId = null;
        // Remove all drag-over indicators
        container.querySelectorAll('.session-tab').forEach(t => {
          t.classList.remove('drag-over-left', 'drag-over-right');
        });
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        e.dataTransfer.dropEffect = 'move';

        // Determine drop position based on mouse position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const isLeftHalf = e.clientX < midpoint;

        // Update visual indicator
        tab.classList.toggle('drag-over-left', isLeftHalf);
        tab.classList.toggle('drag-over-right', !isLeftHalf);
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over-left', 'drag-over-right');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over-left', 'drag-over-right');

        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        const targetId = tab.dataset.id;
        const draggedId = this.draggedTabId;

        // Determine insertion position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const insertBefore = e.clientX < midpoint;

        // Reorder sessionOrder array
        const fromIndex = this.sessionOrder.indexOf(draggedId);
        let toIndex = this.sessionOrder.indexOf(targetId);

        if (fromIndex === -1 || toIndex === -1) return;

        // Remove dragged item
        this.sessionOrder.splice(fromIndex, 1);

        // Recalculate target index after removal
        toIndex = this.sessionOrder.indexOf(targetId);
        if (toIndex === -1) return;

        // Insert at correct position
        if (insertBefore) {
          this.sessionOrder.splice(toIndex, 0, draggedId);
        } else {
          this.sessionOrder.splice(toIndex + 1, 0, draggedId);
        }

        // Save and re-render
        this.saveSessionOrder();
        this._fullRenderSessionTabs();
      });
    });
  }

  moveActiveTabLeft() {
    if (!this.activeSessionId) return;
    const idx = this.sessionOrder.indexOf(this.activeSessionId);
    if (idx <= 0) return;
    [this.sessionOrder[idx - 1], this.sessionOrder[idx]] = [this.sessionOrder[idx], this.sessionOrder[idx - 1]];
    this.saveSessionOrder();
    this._fullRenderSessionTabs();
  }

  moveActiveTabRight() {
    if (!this.activeSessionId) return;
    const idx = this.sessionOrder.indexOf(this.activeSessionId);
    if (idx === -1 || idx >= this.sessionOrder.length - 1) return;
    [this.sessionOrder[idx], this.sessionOrder[idx + 1]] = [this.sessionOrder[idx + 1], this.sessionOrder[idx]];
    this.saveSessionOrder();
    this._fullRenderSessionTabs();
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Lifecycle — select, close, navigate
  // ═══════════════════════════════════════════════════════════════

  getShortId(id) {
    if (!id) return '';
    let short = this._shortIdCache.get(id);
    if (!short) {
      short = id.slice(0, 8);
      this._shortIdCache.set(id, short);
    }
    return short;
  }

  getSessionName(session) {
    // Use custom name if set
    if (session.name) {
      return session.name;
    }
    // Fall back to directory name
    if (session.workingDir) {
      return session.workingDir.split('/').pop() || session.workingDir;
    }
    return this.getShortId(session.id);
  }

  _notifySession(sessionId, urgency, category, title, message) {
    const session = this.sessions.get(sessionId);
    this.notificationManager?.notify({
      urgency,
      category,
      sessionId,
      sessionName: session?.name || this.getShortId(sessionId),
      title,
      message,
    });
  }

  /**
   * Clean up state from the previous session before switching tabs.
   * Handles: WebSocket teardown, CJK clear, flicker filter, tab completion,
   * terminal write queue, IME composition, and local echo flush.
   * @param {string} newSessionId - The session being switched TO.
   */
  _cleanupPreviousSession(newSessionId) {
    // Close WebSocket for previous session (new one opens after buffer load)
    this._disconnectWs();

    // Clear CJK textarea to prevent sending stale text to the wrong session
    const cjkEl = document.getElementById('cjkInput');
    if (cjkEl) cjkEl.value = '';

    // Clean up flicker filter state when switching sessions
    this._clearTimer('flickerFilterTimeout');
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Clear tab completion detection flag — don't carry across sessions
    this._tabCompletionSessionId = null;
    this._tabCompletionRetries = 0;
    this._tabCompletionBaseText = null;
    this._clearTimer('_tabCompletionFallback');
    this._clearTimer('_clientDropRecoveryTimer');

    // Clean up pending terminal writes to prevent old session data from appearing in new session
    this._clearTimer('syncWaitTimeout');
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    // Abort any in-flight chunkedTerminalWrite from the previous session.
    // Without this, old rAF-scheduled chunks continue writing stale data
    // into the terminal, interleaving with the new session's buffer.
    this._chunkedWriteGen = (this._chunkedWriteGen || 0) + 1;
    // End any in-flight IME composition.
    // iOS Safari keeps autocorrect composing; switching tabs without ending it
    // leaves xterm's _compositionHelper._isComposing stuck true, which blocks
    // keyboard input when the user returns to this tab.
    try {
      const ch = this.terminal?._core?._compositionHelper;
      if (ch?._isComposing) {
        ch._isComposing = false;
        // Also fire compositionend on the textarea so any other listeners reset
        const ta = this.terminal?.element?.querySelector('.xterm-helper-textarea');
        if (ta) ta.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
      }
    } catch {}
    // Flush local echo text to PTY before switching tabs.
    // Send as a single batch (no Enter) so it lands in the session's readline
    // input buffer — avoids "old text resent on Enter" and overlay render bugs.
    // Track flushed length so _render() offsets the overlay correctly even before
    // the PTY echo arrives in the terminal buffer.
    if (this.activeSessionId) {
      const echoText = this._localEchoOverlay?.pendingText || '';
      // Include buffer-detected flushed text (from Tab completion, etc.)
      // so it's preserved across tab switches.
      const existingFlushed = this._localEchoOverlay?.getFlushed()?.count || 0;
      const existingFlushedText = this._localEchoOverlay?.getFlushed()?.text || '';
      if (echoText) {
        this._sendInputAsync(this.activeSessionId, echoText);
      }
      const totalOffset = existingFlushed + echoText.length;
      if (totalOffset > 0) {
        if (!this._flushedOffsets) this._flushedOffsets = new Map();
        if (!this._flushedTexts) this._flushedTexts = new Map();
        this._flushedOffsets.set(this.activeSessionId, totalOffset);
        this._flushedTexts.set(this.activeSessionId, existingFlushedText + echoText);
      }
    }
    this._localEchoOverlay?.clear();
    // Prevent _detectBufferText() from picking up Claude's Ink UI text
    // (status bar, model info, etc.) as "user input" on fresh sessions.
    // Only sessions with prior flushed text (from tab-switch-away) need detection.
    // After the user's first Enter, clear() resets _bufferDetectDone = false,
    // re-enabling detection for tab completion and other legitimate cases.
    if (this._localEchoOverlay && !this._flushedOffsets?.has(newSessionId)) {
      this._localEchoOverlay.suppressBufferDetection();
    }
  }

  async selectSession(sessionId) {
    if (this.activeSessionId === sessionId) return;
    // Focus terminal SYNCHRONOUSLY before any await — iOS Safari only honors
    // programmatic focus() within the user-gesture call stack (e.g. tab click).
    // After the first await the gesture context is lost and focus() is silently
    // ignored, leaving the keyboard unable to send input to the terminal.
    if (this.terminal) this.terminal.focus();

    const _selStart = performance.now();
    const _selName = this.sessions.get(sessionId)?.name || sessionId.slice(0,8);
    _crashDiag.log(`SELECT: ${_selName}`);
    console.log(`[CRASH-DIAG] selectSession START: ${sessionId.slice(0,8)}`);

    const selectGen = ++this._selectGeneration;

    if (selectGen !== this._selectGeneration) return; // newer tab switch won

    this._cleanupPreviousSession(sessionId);
    this.activeSessionId = sessionId;
    try { localStorage.setItem('codeman-active-session', sessionId); } catch {}
    // Narrow SSE filter to the active session — server stops streaming
    // session:terminal events for other sessions to this client. Cuts
    // SSE traffic ~Nx for N concurrent sessions. Fire-and-forget; on the
    // rare race where server doesn't know our clientId yet, the next
    // selectSession or reconnect catches up.
    this._updateSseSubscription(sessionId);
    this.hideWelcome();
    // Clear idle hooks on view, but keep action hooks until user interacts
    this.clearPendingHooks(sessionId, 'idle_prompt');
    // Instant active-class toggle (no 100ms debounce), then schedule full render for badges/status
    this._updateActiveTabImmediate(sessionId);
    this.renderSessionTabs();
    this._updateLocalEchoState();

    // Restore flushed offset AND text IMMEDIATELY so backspace/typing work during
    // the async buffer load.  Without this, the offset is 0 during the
    // fetch() gap: backspace is swallowed, and typing a space covers the
    // canvas text with an opaque overlay showing only the new char.
    if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
      this._localEchoOverlay.setFlushed(
        this._flushedOffsets.get(sessionId),
        this._flushedTexts?.get(sessionId) || '',
        false  // render=false: buffer not loaded yet
      );
    }

    // Glow the newly-active tab
    const activeTab = document.querySelector(`.session-tab.active[data-id="${sessionId}"]`);
    if (activeTab) {
      activeTab.classList.add('tab-glow');
      activeTab.addEventListener('animationend', () => activeTab.classList.remove('tab-glow'), { once: true });
    }

    // Check if this is a restored session that needs to be attached
    const session = this.sessions.get(sessionId);

    // Ended tabs (restored from localStorage, no longer on server) — show message, skip buffer load
    if (session?._ended) {
      this.terminal.clear();
      this.terminal.write('\r\n  \x1b[2mSession ended. Close tab or click to reopen.\x1b[0m\r\n');
      return;
    }

    // Track working directory for path normalization in Project Insights
    this.currentSessionWorkingDir = session?.workingDir || null;
    if (session && session.pid === null && !session._ended) {
      // Session has no PTY attached — either restored after server restart
      // or detached for some other reason. Re-attach regardless of status.
      try {
        const endpoint = session.mode === 'shell'
          ? `/api/sessions/${sessionId}/shell`
          : `/api/sessions/${sessionId}/interactive`;
        await fetch(endpoint, { method: 'POST' });
        // Update local session state
        session.status = 'busy';
      } catch (err) {
        console.error('Failed to attach to restored session:', err);
      }
    }

    // Load terminal buffer for this session
    // Show cached content instantly while fetching fresh data in background.
    // Use tail mode for faster initial load (128KB is enough for recent visible content).
    //
    // Protect flushed state during buffer load: terminal.write() can trigger
    // xterm.js onData responses (DA, OSC, etc.) that would otherwise clear
    // the flushed Maps via the control char handler.  The multi-byte ESC
    // filter catches most cases, but _restoringFlushedState provides a
    // belt-and-suspenders guard for any edge cases.
    this._restoringFlushedState = true;
    // Gate live SSE terminal writes for the ENTIRE buffer load sequence.
    // Without this, SSE events arriving during the fetch() gap compete with
    // the buffer write, causing 70KB+ single-frame flushes that stall WebGL.
    // chunkedTerminalWrite also sets this, but we need it before the fetch too.
    this._isLoadingBuffer = true;
    this._loadBufferQueue = [];
    try {
      // Fit terminal to container BEFORE writing any buffer data.
      // If the browser was resized while viewing another session, the terminal
      // canvas may be at stale dimensions — content would render at wrong width.
      if (this.fitAddon) this.fitAddon.fit();

      // Instant cache restore for IDLE sessions only.
      // For busy sessions, the cache is always stale — writing it first causes a
      // jarring double-render: stale content appears, then the terminal flashes
      // blank and rewrites with fresh data. Skip the cache and write the fresh
      // buffer once for a single clean transition.
      const cachedBuffer = this.terminalBufferCache.get(sessionId);
      const sessionIsBusy = session && (session.status === 'busy' || session.status === 'working');
      if (cachedBuffer && !sessionIsBusy) {
        _crashDiag.log(`CACHE_WRITE: ${(cachedBuffer.length/1024).toFixed(0)}KB`);
        this.terminal.clear();
        this.terminal.reset();
        await this.chunkedTerminalWrite(cachedBuffer);
        if (this._isStaleSelect(selectGen)) return;
        this.terminal.scrollToBottom();
        _crashDiag.log('CACHE_DONE');
      } else if (sessionIsBusy) {
        // Clear stale content immediately — fresh buffer is being fetched
        this.terminal.clear();
        this.terminal.reset();
        _crashDiag.log('CACHE_SKIP_BUSY');
      }

      _crashDiag.log('FETCH_START');
      const res = await fetch(`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`);
      if (this._isStaleSelect(selectGen)) return;
      const data = await res.json();
      _crashDiag.log(`FETCH_DONE: ${data.terminalBuffer ? (data.terminalBuffer.length/1024).toFixed(0) + 'KB' : 'empty'} truncated=${data.truncated}`);

      if (data.terminalBuffer) {
        // Skip rewrite if fresh buffer matches cache — avoids visible clear+rewrite flash.
        // On slow connections (mobile 5G), the gap between clear() and chunkedWrite() is
        // very visible, causing the terminal to flash blank then repaint.
        const needsRewrite = data.terminalBuffer !== cachedBuffer;
        if (needsRewrite) {
          _crashDiag.log(`REWRITE: ${(data.terminalBuffer.length/1024).toFixed(0)}KB`);
          this.terminal.clear();
          this.terminal.reset();
          // Show truncation indicator if buffer was cut
          if (data.truncated) {
            this.terminal.write('\x1b[90m... (earlier output truncated for performance) ...\x1b[0m\r\n\r\n');
          }
          // Use chunked write for large buffers to avoid UI jank
          await this.chunkedTerminalWrite(data.terminalBuffer);
          if (this._isStaleSelect(selectGen)) return;
          // Ensure terminal is scrolled to bottom after buffer load
          this.terminal.scrollToBottom();
        }

        // Update cache (cap at 20 entries)
        this.terminalBufferCache.set(sessionId, data.terminalBuffer);
        if (this.terminalBufferCache.size > 20) {
          // Evict oldest entry (first key in Map iteration order)
          const oldest = this.terminalBufferCache.keys().next().value;
          this.terminalBufferCache.delete(oldest);
        }
      } else if (!cachedBuffer) {
        // No fresh buffer and no cache — clear any stale content
        this.terminal.clear();
        this.terminal.reset();
      }

      // Buffer load complete — unblock live SSE writes (queued events are discarded
      // to prevent duplicate content). chunkedTerminalWrite calls _finishBufferLoad
      // internally, but if we skipped the write (cache hit or empty), call it here.
      if (this._isLoadingBuffer) {
        this._finishBufferLoad();
      }
      // Drop the guard so user input clears state normally
      this._restoringFlushedState = false;

      // Restore flushed offset and text for this session so the overlay positions
      // correctly even before the PTY echo arrives in the terminal buffer.
      if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
        this._localEchoOverlay.setFlushed(
          this._flushedOffsets.get(sessionId),
          this._flushedTexts?.get(sessionId) || '',
          false  // render=false: buffer just loaded, defer to rerender
        );
        // Trigger render after xterm.js finishes processing the buffer data.
        // terminal.write('', callback) fires the callback after ALL previously
        // queued writes have been parsed — so findPrompt() can find ❯ in the buffer.
        const zl = this._localEchoOverlay;
        this.terminal.write('', () => {
          if (zl.hasPending) zl.rerender();
        });
      }

      // Fire-and-forget resize + Ctrl+L to force Ink redraw.
      // Tailed buffers accumulate stale CUP-positioned Ink frames that overlap
      // in the viewport (e.g. duplicate "bypass permissions" bars). Ctrl+L
      // triggers a full Ink redraw which overwrites all stale frame content.
      // sendResize may be a no-op if dimensions match, so Ctrl+L is essential.
      this.sendResize(sessionId).then(() => {
        if (selectGen !== this._selectGeneration) return;
        fetch(`/api/sessions/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: '\x0c' })
        }).catch(() => {});
      });

      // Defer secondary panel updates so they don't block the main thread
      // after terminal content is already visible.
      const idleCb = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb) => setTimeout(cb, 16);
      idleCb(() => {
        // Guard against stale generation — user may have switched tabs again
        if (selectGen !== this._selectGeneration) return;

        // Update respawn banner
        if (this.respawnStatus[sessionId]) {
          this.showRespawnBanner();
          this.updateRespawnBanner(this.respawnStatus[sessionId].state);
          document.getElementById('respawnCycleCount').textContent = this.respawnStatus[sessionId].cycleCount || 0;
          this.updateCountdownTimerDisplay();
          this.updateActionLogDisplay();
          if (Object.keys(this.respawnCountdownTimers[sessionId] || {}).length > 0) {
            this.startCountdownInterval();
          }
        } else {
          this.hideRespawnBanner();
          this.stopCountdownInterval();
        }

        // Update task panel if open
        const taskPanel = document.getElementById('taskPanel');
        if (taskPanel && taskPanel.classList.contains('open')) {
          this.renderTaskPanel();
        }

        // Update ralph state panel for this session
        const curSession = this.sessions.get(sessionId);
        if (curSession && (curSession.ralphLoop || curSession.ralphTodos)) {
          this.updateRalphState(sessionId, {
            loop: curSession.ralphLoop,
            todos: curSession.ralphTodos
          });
        }
        this.renderRalphStatePanel();

        // Update CLI info bar (mobile - shows Claude version/model)
        this.updateCliInfoDisplay();

        // Update project insights panel for this session
        this.renderProjectInsightsPanel();

        // Update subagent window visibility for active session
        this.updateSubagentWindowVisibility();

        // Load file browser if enabled
        const settings = this.loadAppSettingsFromStorage();
        if (settings.showFileBrowser) {
          const fileBrowserPanel = this.$('fileBrowserPanel');
          if (fileBrowserPanel) {
            fileBrowserPanel.classList.add('visible');
            this.loadFileBrowser(sessionId);
            // Attach drag listeners if not already attached
            if (!this.fileBrowserDragListeners) {
              const header = fileBrowserPanel.querySelector('.file-browser-header');
              if (header) {
                const onFirstDrag = () => {
                  if (!fileBrowserPanel.style.left) {
                    const rect = fileBrowserPanel.getBoundingClientRect();
                    fileBrowserPanel.style.left = `${rect.left}px`;
                    fileBrowserPanel.style.top = `${rect.top}px`;
                    fileBrowserPanel.style.right = 'auto';
                  }
                };
                header.addEventListener('mousedown', onFirstDrag);
                header.addEventListener('touchstart', onFirstDrag, { passive: true });
                this.fileBrowserDragListeners = this.makeWindowDraggable(fileBrowserPanel, header);
                this.fileBrowserDragListeners._onFirstDrag = onFirstDrag;
              }
            }
          }
        }
      });

      // Open WebSocket for low-latency terminal I/O (after buffer load completes)
      this._connectWs(sessionId);

      _crashDiag.log('FOCUS');
      this.terminal.focus();
      this.terminal.scrollToBottom();
      _crashDiag.log(`SELECT_DONE: ${(performance.now() - _selStart).toFixed(0)}ms`);
      console.log(`[CRASH-DIAG] selectSession DONE: ${sessionId.slice(0,8)} in ${(performance.now() - _selStart).toFixed(0)}ms`);
    } catch (err) {
      if (this._isLoadingBuffer) this._finishBufferLoad();
      this._restoringFlushedState = false;
      console.error('Failed to load session terminal:', err);
    }
  }

  // Shared cleanup for all session data — called from both closeSession() and session:deleted handler
  _cleanupSessionData(sessionId) {
    // If the deleted session is currently being renamed, abort the rename
    // so the inline <input> doesn't ghost as a stale tab on screen.
    if (this._activeRename?.sessionId === sessionId) {
      this._activeRename.cancel();
    }
    this.sessions.delete(sessionId);
    // Remove from tab order
    const orderIndex = this.sessionOrder.indexOf(sessionId);
    if (orderIndex !== -1) {
      this.sessionOrder.splice(orderIndex, 1);
      this.saveSessionOrder();
    }
    this.terminalBuffers.delete(sessionId);
    this.terminalBufferCache.delete(sessionId);

    this._flushedOffsets?.delete(sessionId);
    this._flushedTexts?.delete(sessionId);
    this._inputQueue.delete(sessionId);
    this.ralphStates.delete(sessionId);
    this.ralphClosedSessions.delete(sessionId);
    this.projectInsights.delete(sessionId);
    this.pendingHooks.delete(sessionId);
    this.tabAlerts.delete(sessionId);
    this.clearCountdownTimers(sessionId);
    this.closeSessionLogViewerWindows(sessionId);
    this.closeSessionImagePopups(sessionId);
    this.closeSessionSubagentWindows(sessionId, true);

    // Clean up idle timer
    const idleTimer = this.idleTimers.get(sessionId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(sessionId);
    }
    // Clean up respawn state
    delete this.respawnStatus[sessionId];
    delete this.respawnTimers[sessionId];
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
  }

  async closeSession(sessionId, killMux = true) {
    try {
      await this._apiDelete(`/api/sessions/${sessionId}?killMux=${killMux}`);
      this._cleanupSessionData(sessionId);

      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        // Select another session or show welcome (use sessionOrder for consistent ordering)
        if (this.sessionOrder.length > 0 && this.sessions.size > 0) {
          const nextSessionId = this.sessionOrder[0];
          this.selectSession(nextSessionId);
        } else {
          this.terminal.clear();
          this.showWelcome();
          this.renderRalphStatePanel();  // Clear ralph panel when no sessions
        }
      }

      this.renderSessionTabs();

      if (killMux) {
        this.showToast('Session closed and tmux killed', 'success');
      } else {
        this.showToast('Tab hidden, tmux still running', 'info');
      }
    } catch (err) {
      this.showToast('Failed to close session', 'error');
    }
  }

  // Request confirmation before closing a session
  requestCloseSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.pendingCloseSessionId = sessionId;

    // Show session name in confirmation dialog
    const name = this.getSessionName(session);
    const sessionNameEl = document.getElementById('closeConfirmSessionName');
    sessionNameEl.textContent = name;

    // Update kill button text based on session mode
    const killTitle = document.getElementById('closeConfirmKillTitle');
    if (killTitle) {
      killTitle.textContent = session.mode === 'opencode'
        ? 'Kill Tmux & OpenCode'
        : 'Kill Tmux & Claude Code';
    }

    document.getElementById('closeConfirmModal').classList.add('active');
  }

  cancelCloseSession() {
    this.pendingCloseSessionId = null;
    document.getElementById('closeConfirmModal').classList.remove('active');
  }

  async confirmCloseSession(killMux = true) {
    const sessionId = this.pendingCloseSessionId;
    this.cancelCloseSession();

    if (sessionId) {
      await this.closeSession(sessionId, killMux);
    }
  }

  nextSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const nextIndex = (currentIndex + 1) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[nextIndex]);
  }

  prevSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const prevIndex = (currentIndex - 1 + this.sessionOrder.length) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[prevIndex]);
  }

  // ═══════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════

  goHome() {
    // Deselect active session and show welcome screen
    this.activeSessionId = null;
    try { localStorage.removeItem('codeman-active-session'); } catch {}
    this.terminal.clear();
    this.showWelcome();
    this.renderSessionTabs();
    this.renderRalphStatePanel();
  }

  // ═══════════════════════════════════════════════════════════════
  // Ralph Loop Wizard (methods in ralph-wizard.js)
  // ═══════════════════════════════════════════════════════════════

  // Wizard state (initialized here, methods loaded from ralph-wizard.js)
  ralphWizardStep = 1;
  ralphWizardConfig = {
    taskDescription: '',
    completionPhrase: 'COMPLETE',
    maxIterations: 10,
    caseName: 'testcase',
    enableRespawn: false,
    generatedPlan: null,
    planGenerated: false,
    skipPlanGeneration: false,
    planDetailLevel: 'detailed',
    existingPlan: null,
    useExistingPlan: false,
  };
  planLoadingTimer = null;
  planLoadingStartTime = null;

  // ═══════════════════════════════════════════════════════════════
  // Kill Sessions
  // ═══════════════════════════════════════════════════════════════

  async killActiveSession() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }
    await this.closeSession(this.activeSessionId);
  }

  async killAllSessions() {
    if (this.sessions.size === 0) return;

    if (!confirm(`Kill all ${this.sessions.size} session(s)?`)) return;

    try {
      await this._apiDelete('/api/sessions');
      this.sessions.clear();
      this.terminalBuffers.clear();
      this.terminalBufferCache.clear();
      this.activeSessionId = null;
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.respawnStatus = {};
      this.respawnCountdownTimers = {};
      this.respawnActionLogs = {};
      this.stopCountdownInterval();
      this.hideRespawnBanner();
      this.renderSessionTabs();
      this.terminal.clear();
      this.showWelcome();
      this.showToast('All sessions killed', 'success');
    } catch (err) {
      this.showToast('Failed to kill sessions', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Timer
  // ═══════════════════════════════════════════════════════════════

  showTimer() {
    document.getElementById('timerBanner').style.display = 'flex';
    this.updateTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 1000);
  }

  hideTimer() {
    document.getElementById('timerBanner').style.display = 'none';
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  updateTimer() {
    if (!this.currentRun || this.currentRun.status !== 'running') return;

    const now = Date.now();
    const remaining = Math.max(0, this.currentRun.endAt - now);
    const total = this.currentRun.endAt - this.currentRun.startedAt;
    const elapsed = now - this.currentRun.startedAt;
    const percent = Math.min(100, (elapsed / total) * 100);

    document.getElementById('timerValue').textContent = this.formatTime(remaining);
    document.getElementById('timerProgress').style.width = `${percent}%`;
    document.getElementById('timerMeta').textContent =
      `${this.currentRun.completedTasks} tasks | $${this.currentRun.totalCost.toFixed(2)}`;
  }

  async stopCurrentRun() {
    if (!this.currentRun) return;
    try {
      await fetch(`/api/scheduled/${this.currentRun.id}`, { method: 'DELETE' });
    } catch (err) {
      this.showToast('Failed to stop run', 'error');
    }
  }

  formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Tokens
  // ═══════════════════════════════════════════════════════════════

  updateCost() {
    // Now updates tokens instead of cost
    this.updateTokens();
  }

  updateTokens() {
    // Debounce at 200ms — token display is non-critical and shouldn't
    // compete with input handling on the main thread
    this._clearTimer('_updateTokensTimeout');
    this._updateTokensTimeout = setTimeout(() => {
      this._updateTokensTimeout = null;
      this._updateTokensImmediate();
    }, 200);
  }

  _updateTokensImmediate() {
    // Use global stats if available (includes deleted sessions)
    let totalInput = 0;
    let totalOutput = 0;
    if (this.globalStats) {
      totalInput = this.globalStats.totalInputTokens || 0;
      totalOutput = this.globalStats.totalOutputTokens || 0;
    } else {
      // Fallback to active sessions only
      this.sessions.forEach(s => {
        if (s.tokens) {
          totalInput += s.tokens.input || 0;
          totalOutput += s.tokens.output || 0;
        }
      });
    }
    const total = totalInput + totalOutput;
    this.totalTokens = total;
    const display = this.formatTokens(total);

    // Estimate cost from tokens (more accurate than stored cost in interactive mode)
    const estimatedCost = this.estimateCost(totalInput, totalOutput);
    const tokenEl = this.$('headerTokens');
    if (tokenEl) {
      const settings = this.loadAppSettingsFromStorage();
      const showCost = settings.showCost ?? false;
      tokenEl.textContent = total > 0
        ? (showCost ? `${display} tokens · $${estimatedCost.toFixed(2)}` : `${display} tokens`)
        : '0 tokens';
      tokenEl.title = this.globalStats
        ? `Lifetime: ${this.globalStats.totalSessionsCreated} sessions created${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`
        : `Token usage across active sessions${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`;
    }
  }

}

// ═══════════════════════════════════════════════════════════════
// Module Init — localStorage migration and app start
// ═══════════════════════════════════════════════════════════════

// Migrate legacy localStorage keys (claudeman-* → codeman-*)
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('claudeman-') || key.startsWith('claudeman_'))) {
      const newKey = key.replace(/^claudeman[-_]/, (m) => 'codeman' + m.charAt(m.length - 1));
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, localStorage.getItem(key));
      }
    }
  }
} catch {}

// Initialize — use DOMContentLoaded to ensure all defer'd mixin modules
// (terminal-ui.js, settings-ui.js, etc.) have executed their Object.assign
// onto CodemanApp.prototype before we instantiate.
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new CodemanApp();
  window.app = app;
});
window.MobileDetection = MobileDetection;
