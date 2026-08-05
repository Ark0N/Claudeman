/**
 * @fileoverview Phone home screen: a scrolling overview of what every session is
 * doing, shown instead of the welcome overlay when the "C" logo is tapped.
 *
 * The welcome screen answers "how do I start something"; on a phone the more
 * urgent question is "which of my sessions is blocked on me". This surface
 * answers that first: NEEDS YOU (pending permission/question/idle hooks and
 * errored sessions), then SPACES (cases, expandable to their sessions), then
 * WORKING and IDLE / DONE.
 *
 * PHONE ONLY. The gate is `shouldUseMobileOverview()` (viewport < 430px, not a
 * popped-out solo window, per-device setting on). Tablet and desktop keep the
 * welcome overlay untouched. The container ships with the `hidden` attribute and
 * only this module removes it, so desktop (which never loads mobile.css) cannot
 * render an unstyled overview even if a class rule leaked.
 *
 * Everything renders from state the page already holds (`this.sessions`,
 * `this.cases`, `this.pendingHooks`) — no endpoint, no SSE event, no schema.
 * `buildMobileOverviewModel()` is pure and unit-tested (test/mobile-overview.test.ts).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.sessions, this.cases, this.pendingHooks, selectSession, run)
 * @dependency mobile-handlers.js (MobileDetection)
 * @dependency session-ui.js (selectQuickStartCase for "New session here")
 * @loadorder 12.55 of 16, after webview-tabs.js, before entrance-animations.js
 */

/** Viewport width that counts as a phone. Matches the mobile.css phone block. */
const MOBILE_OVERVIEW_PHONE_QUERY = '(max-width: 430px)';

/** Sort rank per state: the most demanding thing sorts first inside a section. */
const MOBILE_OVERVIEW_STATE_RANK = {
  needs: 0,
  error: 1,
  waiting: 2,
  working: 3,
  idle: 4,
  done: 5,
};

/** How many past conversations show before the "Show all" toggle. */
const MOBILE_OVERVIEW_PAST_LIMIT = 8;

/**
 * Backends offered by the Run picker, mirroring the toolbar's run-mode menu
 * (`#runModeMenu` in index.html). `short` is the badge on the Run button itself.
 */
const MOBILE_OVERVIEW_RUN_MODES = [
  { mode: 'claude', label: 'Claude Code', short: 'Claude' },
  { mode: 'opencode', label: 'OpenCode', short: 'OpenCode' },
  { mode: 'codex', label: 'Codex', short: 'Codex' },
  { mode: 'gemini', label: 'Gemini', short: 'Gemini' },
  { mode: 'antigravity', label: 'Antigravity', short: 'Antigravity' },
  { mode: 'shell', label: 'Terminal / Shell', short: 'Shell' },
];

/** Pill copy per state. Kept short: a phone row has ~90px for it. */
const MOBILE_OVERVIEW_PILL_LABEL = {
  needs: 'needs you',
  error: 'error',
  waiting: 'waiting',
  working: 'working',
  idle: 'idle',
  done: 'done',
};

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Model (pure)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Classify one session.
   * Order matters: an action hook outranks everything (it is literally blocking
   * the agent), and a pending idle_prompt outranks a stale 'busy' status because
   * the hook is the newer signal.
   * @param {object} session session state from this.sessions
   * @param {Set<string>|undefined} hooks pending hook types for that session
   * @returns {'needs'|'error'|'waiting'|'working'|'idle'|'done'}
   */
  _mobileOverviewState(session, hooks) {
    if (hooks && (hooks.has('permission_prompt') || hooks.has('elicitation_dialog'))) return 'needs';
    if (session.status === 'error') return 'error';
    if (hooks && hooks.has('idle_prompt')) return 'waiting';
    if (session.status === 'busy') return 'working';
    if (session.status === 'stopped') return 'done';
    return 'idle';
  },

  /**
   * Longest-prefix match of a workingDir against the case list, so a session
   * started in a subdirectory still belongs to its case. Mirrors the matching in
   * `_resolveCaseLabel()` (terminal-ui.js) but returns the case itself.
   * @returns {object|null} the matching case, or null when the dir is outside every case
   */
  _mobileOverviewCaseFor(workingDir, cases) {
    if (!workingDir) return null;
    let best = null;
    for (const c of cases || []) {
      if (!c || !c.path) continue;
      if (workingDir === c.path) return c;
      if (workingDir.startsWith(c.path + '/') && (!best || c.path.length > best.path.length)) {
        best = c;
      }
    }
    return best;
  },

  /**
   * Build the whole overview model. PURE: reads only its argument, touches no DOM
   * and no `this` state, so it can be unit-tested against plain objects.
   *
   * @param {object} input
   * @param {Map<string, object>|Array} input.sessions live sessions (this.sessions)
   * @param {Array} input.cases case list (this.cases)
   * @param {Array<string>} [input.sessionOrder] the user's tab order, used as the tiebreak
   * @param {Map<string, Set<string>>} [input.pendingHooks] this.pendingHooks
   * @param {Array} [input.history] unified session items (GET /api/sessions/unified)
   * @returns {{needsYou: Array, current: Array, past: Array, sessionCount: number}}
   */
  buildMobileOverviewModel(input) {
    const cases = Array.isArray(input && input.cases) ? input.cases : [];
    const order = Array.isArray(input && input.sessionOrder) ? input.sessionOrder : [];
    const pendingHooks = (input && input.pendingHooks) || new Map();
    const raw = (input && input.sessions) || [];
    const sessions = typeof raw.values === 'function' ? Array.from(raw.values()) : Array.from(raw);

    const rows = sessions.map((session) => {
      const matched = this._mobileOverviewCaseFor(session.workingDir, cases);
      const state = this._mobileOverviewState(session, pendingHooks.get && pendingHooks.get(session.id));
      const orderIndex = order.indexOf(session.id);
      return {
        id: session.id,
        name: this.getSessionName ? this.getSessionName(session) : session.name || session.id.slice(0, 8),
        mode: session.mode || 'claude',
        caseName: matched ? matched.name : '',
        dir: this._shortenHomePath ? this._shortenHomePath(session.workingDir) : session.workingDir || '',
        state,
        pill: MOBILE_OVERVIEW_PILL_LABEL[state] || state,
        orderIndex: orderIndex === -1 ? Number.MAX_SAFE_INTEGER : orderIndex,
      };
    });

    const bySeverityThenOrder = (a, b) => {
      const rank = MOBILE_OVERVIEW_STATE_RANK[a.state] - MOBILE_OVERVIEW_STATE_RANK[b.state];
      return rank !== 0 ? rank : a.orderIndex - b.orderIndex;
    };

    const inSection = (states) => rows.filter((r) => states.includes(r.state)).sort(bySeverityThenOrder);

    // Past = conversations from the unified list that are not currently live.
    // The endpoint already folds a transcript into its owning session (via the
    // claudeSessionId alias map), so a plain id check is enough to avoid listing
    // a running session twice.
    const liveIds = new Set(rows.map((r) => r.id));
    const past = (Array.isArray(input && input.history) ? input.history : [])
      .filter((item) => item && item.sessionId && !liveIds.has(item.sessionId))
      .map((item) => {
        const matched = this._mobileOverviewCaseFor(item.workingDir, cases);
        const dir = item.workingDir || '';
        // The transcript reader emits the literal "(no content)" for a
        // conversation it could not pull a prompt from; that is not a title.
        const prompt = (item.firstPrompt || '').trim();
        const title = prompt && prompt !== '(no content)' ? prompt : '';
        return {
          id: item.sessionId,
          claudeSessionId: item.claudeSessionId || '',
          workingDir: dir,
          name: item.name || '',
          title: title || item.name || dir.split('/').pop() || item.sessionId.slice(0, 8),
          mode: item.mode || 'claude',
          caseName: matched ? matched.name : '',
          dir: this._shortenHomePath ? this._shortenHomePath(dir) : dir,
          at: item.lastActivityAt || item.createdAt || 0,
        };
      })
      .sort((a, b) => b.at - a.at);

    return {
      needsYou: inSection(['needs', 'error', 'waiting']),
      current: inSection(['working', 'idle', 'done']),
      past,
      sessionCount: rows.length,
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // Gate + visibility
  // ═══════════════════════════════════════════════════════════════

  /**
   * Phone-only gate. Width-driven (not `isHandheldDevice()`): this is a LAYOUT
   * decision, and an unfolded foldable with a tablet-width viewport should get
   * the tablet welcome screen. Per-device settings identity is a separate
   * question and deliberately stays handheld-based.
   */
  shouldUseMobileOverview() {
    if (this.isSoloWindow) return false;
    const settings = this.loadAppSettingsFromStorage ? this.loadAppSettingsFromStorage() : {};
    if (settings.mobileOverviewEnabled === false) return false;
    if (typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType) {
      return MobileDetection.getDeviceType() === 'mobile';
    }
    return !!(window.matchMedia && window.matchMedia(MOBILE_OVERVIEW_PHONE_QUERY).matches);
  },

  /** True while the overview is the visible home surface. */
  isMobileOverviewVisible() {
    const el = document.getElementById('mobileOverview');
    return !!el && el.classList.contains('visible');
  },

  showMobileOverview() {
    const el = document.getElementById('mobileOverview');
    if (!el) return;
    el.hidden = false;
    el.classList.add('visible');
    this._wireMobileOverview(el);
    this.renderMobileOverview();
    void this.loadMobileOverviewHistory();
  },

  hideMobileOverview() {
    const el = document.getElementById('mobileOverview');
    if (!el) return;
    this._closeMobileOverviewRunMenu();
    el.classList.remove('visible');
    el.hidden = true;
  },

  /**
   * Past conversations, fetched once per home-screen visit. The unified list is
   * the same source the welcome screen resumes from, so a row resumed here and a
   * row resumed there behave identically. Failures leave the section out rather
   * than showing an error: the live sessions above it are the important part.
   */
  async loadMobileOverviewHistory() {
    if (this._mobileOverviewHistoryLoading) return;
    this._mobileOverviewHistoryLoading = true;
    try {
      this._mobileOverviewHistory = await this._fetchUnifiedSessions(60);
    } catch (err) {
      console.warn('[mobile-overview] history load failed:', err);
      this._mobileOverviewHistory = this._mobileOverviewHistory || [];
    } finally {
      this._mobileOverviewHistoryLoading = false;
      if (this.isMobileOverviewVisible()) this.renderMobileOverview();
    }
  },

  /** Re-render only when the surface is actually showing (called from the tab renderer). */
  _refreshMobileOverviewIfVisible() {
    if (!this.isMobileOverviewVisible()) return;
    this._debouncedCall('mobileOverview', () => this.renderMobileOverview(), 150);
  },

  /**
   * One delegated click listener for every row, plus a breakpoint listener so
   * rotating or unfolding while on the home screen swaps to the right surface
   * instead of stranding a phone layout on a tablet-width viewport.
   */
  _wireMobileOverview(el) {
    if (this._mobileOverviewWired) return;
    this._mobileOverviewWired = true;

    el.addEventListener('click', (event) => {
      const target = event.target && event.target.closest && event.target.closest('[data-mo-action]');
      if (!target) return;
      const action = target.dataset.moAction;
      if (action === 'session') {
        this._closeMobileOverviewRunMenu();
        void this.selectSession(target.dataset.moSession);
      } else if (action === 'resume') {
        this._closeMobileOverviewRunMenu();
        void this.resumeMobileOverviewSession(target.dataset.moSession);
      } else if (action === 'more-past') {
        this._mobileOverviewShowAllPast = !this._mobileOverviewShowAllPast;
        this.renderMobileOverview();
      } else if (action === 'run') {
        this._closeMobileOverviewRunMenu();
        void this.run();
      } else if (action === 'run-menu') {
        this._toggleMobileOverviewRunMenu();
      } else if (action === 'run-mode') {
        // Picking a backend both selects it (so the Run button keeps meaning what
        // you last chose, exactly like the toolbar) and launches it: on a phone
        // the pick IS the intent to start.
        this._closeMobileOverviewRunMenu();
        this.setRunMode(target.dataset.moMode);
        void this.run();
      } else if (action === 'run-webview') {
        this._closeMobileOverviewRunMenu();
        void this.openWebviewFromMenu(target.dataset.moWebview);
      } else if (action === 'run-add-url') {
        this._closeMobileOverviewRunMenu();
        this.showWebviewModal();
      }
    });

    if (window.matchMedia) {
      const mq = window.matchMedia(MOBILE_OVERVIEW_PHONE_QUERY);
      const onChange = () => {
        // Only relevant while a home surface is up; entering a session re-decides
        // through hideWelcome()/showWelcome() anyway.
        if (this.activeSessionId) return;
        if (typeof this.showWelcome === 'function') this.showWelcome();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  },

  _toggleMobileOverviewRunMenu() {
    this._mobileOverviewRunMenuOpen = !this._mobileOverviewRunMenuOpen;
    this.renderMobileOverview();
  },

  _closeMobileOverviewRunMenu() {
    if (!this._mobileOverviewRunMenuOpen) return;
    this._mobileOverviewRunMenuOpen = false;
    if (this.isMobileOverviewVisible()) this.renderMobileOverview();
  },

  /**
   * Resume a past conversation. Delegates to the same resumeHistorySession() the
   * welcome screen's Resume list uses, so name synthesis, envOverrides and the
   * resumeSessionId wiring stay in one place.
   */
  async resumeMobileOverviewSession(sessionId) {
    const row = (this._mobileOverviewPastRows || []).find((r) => r.id === sessionId);
    if (!row || !row.workingDir) return;
    await this.resumeHistorySession(row.claudeSessionId || row.id, row.workingDir, row.name || undefined);
  },

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  renderMobileOverview() {
    const el = document.getElementById('mobileOverview');
    if (!el) return;

    const model = this.buildMobileOverviewModel({
      sessions: this.sessions,
      cases: this.cases,
      sessionOrder: this.sessionOrder,
      pendingHooks: this.pendingHooks,
      history: this._mobileOverviewHistory,
    });
    // Resume needs the workingDir/claudeSessionId off the row the user tapped.
    this._mobileOverviewPastRows = model.past;

    el.replaceChildren();
    el.appendChild(this._buildMobileOverviewTop());

    if (model.needsYou.length) {
      el.appendChild(
        this._buildMobileOverviewSection(
          'Needs you',
          model.needsYou.length,
          model.needsYou.map((r) => this._buildMobileOverviewRow(r))
        )
      );
    }

    el.appendChild(
      this._buildMobileOverviewSection(
        'Current sessions',
        model.current.length,
        model.current.map((r) => this._buildMobileOverviewRow(r)),
        'Nothing running. Hit Run to start something.'
      )
    );

    el.appendChild(
      this._buildMobileOverviewSection(
        'Past sessions',
        model.past.length,
        this._buildMobileOverviewPast(model),
        this._mobileOverviewHistory ? 'No past conversations yet' : 'Loading…'
      )
    );
  },

  /**
   * Past conversations, newest first and capped: the unified list can run to
   * dozens, and this section sits below the live ones on purpose.
   */
  _buildMobileOverviewPast(model) {
    const showAll = !!this._mobileOverviewShowAllPast;
    const visible = showAll ? model.past : model.past.slice(0, MOBILE_OVERVIEW_PAST_LIMIT);
    const children = visible.map((r) => this._buildMobileOverviewPastRow(r));
    const hiddenCount = model.past.length - visible.length;
    if (hiddenCount > 0 || showAll) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mobile-overview-more';
      toggle.dataset.moAction = 'more-past';
      const label = document.createElement('span');
      label.textContent = showAll ? 'Show fewer' : 'Show all past sessions';
      toggle.appendChild(label);
      if (!showAll) {
        const count = document.createElement('span');
        count.className = 'mobile-overview-more-count';
        count.setAttribute('data-i18n-skip', '');
        count.textContent = String(hiddenCount);
        toggle.appendChild(count);
      }
      children.push(toggle);
    }
    return children;
  },

  _buildMobileOverviewTop() {
    const wrap = document.createElement('div');
    wrap.className = 'mobile-overview-header';

    const top = document.createElement('div');
    top.className = 'mobile-overview-top';

    const brand = document.createElement('span');
    brand.className = 'mobile-overview-brand';
    brand.textContent = (window.CodemanI18n && window.CodemanI18n.displayName) || 'Codeman';
    brand.setAttribute('data-i18n-skip', '');
    top.appendChild(brand);

    // Split button carrying the TOOLBAR's own classes (`btn-toolbar btn-run
    // mode-<mode>` / `btn-run-gear`), so the per-backend gradient, border and
    // text color come from the same rules as the Run button in the toolbar and
    // stay in sync with it for free. mobile.css only sizes it.
    const group = document.createElement('div');
    group.className = 'mobile-overview-run-group';

    const mode = this.runMode || 'claude';
    const run = document.createElement('button');
    run.className = `btn-toolbar btn-run mode-${mode} mobile-overview-run`;
    run.type = 'button';
    run.dataset.moAction = 'run';
    const runLabel = document.createElement('span');
    runLabel.textContent = 'Run';
    run.appendChild(runLabel);
    const runMode = document.createElement('span');
    runMode.className = 'mobile-overview-run-mode';
    runMode.setAttribute('data-i18n-skip', '');
    runMode.textContent = MOBILE_OVERVIEW_RUN_MODES.find((m) => m.mode === mode)?.short || mode;
    run.appendChild(runMode);
    group.appendChild(run);

    const caret = document.createElement('button');
    caret.className = `btn-toolbar btn-run-gear mode-${mode} mobile-overview-run-caret`;
    caret.type = 'button';
    caret.dataset.moAction = 'run-menu';
    caret.setAttribute('aria-label', 'Choose what to run');
    caret.setAttribute('aria-expanded', String(!!this._mobileOverviewRunMenuOpen));
    // An SVG chevron, not a "⌄" glyph: the character carries its own baseline
    // offset, so it sits visibly low in a flex-centered box no matter what the
    // line-height says. A path is centered by geometry. Same shape the toolbar's
    // run-mode gear uses.
    caret.appendChild(this._buildMobileOverviewChevron());
    group.appendChild(caret);

    top.appendChild(group);
    wrap.appendChild(top);

    if (this._mobileOverviewRunMenuOpen) wrap.appendChild(this._buildMobileOverviewRunMenu());
    return wrap;
  },

  /** Down chevron as SVG (see the note at its call site). */
  _buildMobileOverviewChevron() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6 9l6 6 6-6');
    svg.appendChild(path);
    return svg;
  },

  /**
   * The Run picker: the same backends as the toolbar's run-mode menu, plus saved
   * web tabs. Deliberately no "Recent Sessions" block, unlike the toolbar menu:
   * past conversations have their own section further down this screen.
   *
   * Gated the same way as the toolbar's #runModeMenu (isCliAvailable(), shell
   * exempt) — this list is a separate, hardcoded duplicate of the toolbar's menu
   * rather than a shared render, so it never picked up #201's gating and offered
   * every backend regardless of what's actually installed.
   */
  _buildMobileOverviewRunMenu() {
    const menu = document.createElement('div');
    menu.className = 'mobile-overview-run-menu';
    const current = this.runMode || 'claude';

    for (const entry of MOBILE_OVERVIEW_RUN_MODES) {
      if (entry.mode !== 'shell' && !this.isCliAvailable(entry.mode)) continue;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'mobile-overview-run-option' + (entry.mode === current ? ' selected' : '');
      option.dataset.moAction = 'run-mode';
      option.dataset.moMode = entry.mode;
      const dot = document.createElement('span');
      dot.className = 'run-mode-dot ' + entry.mode;
      dot.setAttribute('aria-hidden', 'true');
      option.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = entry.label;
      option.appendChild(label);
      menu.appendChild(option);
    }

    const header = document.createElement('div');
    header.className = 'mobile-overview-run-header';
    header.textContent = 'Web / URL';
    menu.appendChild(header);

    for (const webview of this.webviews ? this.webviews.values() : []) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'mobile-overview-run-option';
      option.dataset.moAction = 'run-webview';
      option.dataset.moWebview = webview.id;
      const dot = document.createElement('span');
      dot.className = 'run-mode-dot web';
      dot.setAttribute('aria-hidden', 'true');
      option.appendChild(dot);
      const label = document.createElement('span');
      // A dashboard name is user content.
      label.className = 'case-name';
      label.textContent = webview.name;
      option.appendChild(label);
      menu.appendChild(option);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mobile-overview-run-option mobile-overview-run-option--add';
    add.dataset.moAction = 'run-add-url';
    const addDot = document.createElement('span');
    addDot.className = 'run-mode-dot web';
    addDot.setAttribute('aria-hidden', 'true');
    add.appendChild(addDot);
    const addLabel = document.createElement('span');
    addLabel.textContent = 'Add URL…';
    add.appendChild(addLabel);
    menu.appendChild(add);

    return menu;
  },

  _buildMobileOverviewSection(title, count, children, emptyText) {
    const section = document.createElement('section');
    section.className = 'mobile-overview-section';

    const heading = document.createElement('h2');
    heading.className = 'mobile-overview-heading';
    const label = document.createElement('span');
    label.textContent = title;
    heading.appendChild(label);
    const badge = document.createElement('span');
    badge.className = 'mobile-overview-heading-count';
    badge.textContent = String(count);
    badge.setAttribute('data-i18n-skip', '');
    heading.appendChild(badge);
    section.appendChild(heading);

    if (!children.length && emptyText) {
      const empty = document.createElement('p');
      empty.className = 'mobile-overview-empty';
      empty.textContent = emptyText;
      section.appendChild(empty);
      return section;
    }
    for (const child of children) section.appendChild(child);
    return section;
  },

  /**
   * A session row. The state class drives the same visual language as the
   * session tabs: green dot when it is fine (pulsing while working), a yellow
   * blinking row when it wants input, a red blinking row when it asked a
   * question. Anything else here would mean two different meanings for the same
   * colors on one screen.
   */
  _buildMobileOverviewRow(row) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-overview-row mobile-overview-row--' + row.state;
    item.dataset.moAction = 'session';
    item.dataset.moSession = row.id;

    const dot = document.createElement('span');
    dot.className = 'mobile-overview-dot mobile-overview-dot--' + row.state;
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'mobile-overview-row-body';

    const line1 = document.createElement('span');
    line1.className = 'mobile-overview-row-title';
    const name = document.createElement('span');
    // .session-name is in the i18n skip list: a session name is user content.
    name.className = 'session-name';
    name.textContent = row.name;
    line1.appendChild(name);
    if (row.caseName) {
      const meta = document.createElement('span');
      meta.className = 'mobile-overview-row-case case-name';
      meta.textContent = ' · ' + row.caseName;
      line1.appendChild(meta);
    }
    body.appendChild(line1);

    const line2 = document.createElement('span');
    line2.className = 'mobile-overview-row-sub';
    line2.setAttribute('data-i18n-skip', '');
    line2.textContent = row.mode + (row.dir ? ' · ' + row.dir : '');
    body.appendChild(line2);

    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className = 'mobile-overview-pill mobile-overview-pill--' + row.state;
    // Skipped by i18n on purpose: the labels are generic single words ("idle",
    // "done", "error") that collide with state strings on other surfaces.
    pill.setAttribute('data-i18n-skip', '');
    pill.textContent = row.pill;
    item.appendChild(pill);

    const chevron = document.createElement('span');
    chevron.className = 'mobile-overview-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    item.appendChild(chevron);

    return item;
  },

  /** A past conversation. Tapping it resumes, which creates a fresh session. */
  _buildMobileOverviewPastRow(row) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-overview-row mobile-overview-row--past';
    item.dataset.moAction = 'resume';
    item.dataset.moSession = row.id;

    const dot = document.createElement('span');
    dot.className = 'mobile-overview-dot mobile-overview-dot--past';
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'mobile-overview-row-body';

    const title = document.createElement('span');
    // A first prompt is user content, never app copy.
    title.className = 'mobile-overview-row-title session-name';
    title.textContent = row.title;
    body.appendChild(title);

    const sub = document.createElement('span');
    sub.className = 'mobile-overview-row-sub';
    sub.setAttribute('data-i18n-skip', '');
    const when = row.at && this._formatTimeAgo ? this._formatTimeAgo(row.at) : '';
    sub.textContent = [row.caseName || row.dir, when].filter(Boolean).join(' · ');
    body.appendChild(sub);

    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className = 'mobile-overview-pill mobile-overview-pill--past';
    pill.textContent = 'resume';
    pill.setAttribute('data-i18n-skip', '');
    item.appendChild(pill);

    const chevron = document.createElement('span');
    chevron.className = 'mobile-overview-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    item.appendChild(chevron);

    return item;
  },
});
