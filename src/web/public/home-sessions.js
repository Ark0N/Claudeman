/**
 * @fileoverview Desktop home screen session list: the open tabs as a vertical
 * column down the left of the welcome overlay.
 *
 * The welcome screen centers ~560px of content in a window that is usually
 * 1400px+, so the two gutters are dead space. The left one now carries the same
 * list a phone gets on its home screen (mobile-overview.js), turned vertical:
 * one row per live tab, in TAB ORDER (not sorted by state) so it reads as the
 * tab strip rotated, and so Alt+1..9 still matches what you see.
 *
 * DESKTOP ONLY, and only in a wide enough window: the column is absolutely
 * positioned so the centered welcome content never moves, which means it can
 * only exist where the gutter is genuinely wider than the column. Below
 * `HOME_SESSIONS_MIN_WIDTH` nothing renders; on a phone the mobile overview owns
 * the home screen entirely and this surface stays out of its way.
 *
 * The working state is deliberately identical to the phone's: a pulsing green
 * dot ringed by the spinner a tab shows while it loads (`tab-load-spin`, reused
 * from styles.css), plus a green halo. Same signal, same motion, both surfaces.
 *
 * Everything renders from state the page already holds (`this.sessions`,
 * `this.cases`, `this.pendingHooks`, `this.webviews`) — no endpoint, no SSE
 * event, no schema. State classification and case matching are reused from
 * mobile-overview.js rather than re-derived, so the two home screens can never
 * disagree about what "working" means.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.sessions, this.cases, this.pendingHooks, selectSession)
 * @dependency mobile-overview.js (_mobileOverviewState, _mobileOverviewCaseFor, shouldUseMobileOverview)
 * @dependency webview-tabs.js (this.webviews, this.webviewOrder, openWebview)
 * @dependency mobile-handlers.js (MobileDetection)
 * @loadorder 12.56 of 16, after mobile-overview.js, before entrance-animations.js
 */

/**
 * Narrowest window that gets the column. The welcome content is 560px wide and
 * centered, so at 1180px each gutter is 310px — enough for the 256px column plus
 * its 20px offset and still a visible gap. Anything narrower would overlap the
 * search panel, which is why this is a width gate and not a device-type gate.
 */
const HOME_SESSIONS_MIN_WIDTH = 1180;

/** Pill copy per state. Same words as the phone overview, same reasons. */
const HOME_SESSIONS_PILL_LABEL = {
  needs: 'needs you',
  error: 'error',
  waiting: 'waiting',
  working: 'working',
  idle: 'idle',
  done: 'done',
};

/** Short backend badge, mirroring `.tab-mode` in the tab strip. */
const HOME_SESSIONS_MODE_BADGE = {
  shell: 'sh',
  opencode: 'oc',
  codex: 'cx',
  gemini: 'gm',
  antigravity: 'ag',
};

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Gate + visibility
  // ═══════════════════════════════════════════════════════════════

  /**
   * Width-driven, like every other layout decision in the app. Explicitly yields
   * to the phone overview: that surface already lists the same sessions, and two
   * lists of the same thing on one screen is worse than none.
   */
  shouldShowHomeSessions() {
    if (this.isSoloWindow) return false;
    if (this.shouldUseMobileOverview?.()) return false;
    return window.innerWidth >= HOME_SESSIONS_MIN_WIDTH;
  },

  /** True while the column is the visible home surface. */
  isHomeSessionsVisible() {
    const el = document.getElementById('homeSessions');
    return !!el && !el.hidden;
  },

  showHomeSessions() {
    const el = document.getElementById('homeSessions');
    if (!el) return;
    this._wireHomeSessions(el);
    if (!this.shouldShowHomeSessions()) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    this.renderHomeSessions();
  },

  hideHomeSessions() {
    const el = document.getElementById('homeSessions');
    if (el) el.hidden = true;
  },

  /** Re-render only when showing (called from the tab renderer's tail). */
  _refreshHomeSessionsIfVisible() {
    if (!this.isHomeSessionsVisible()) return;
    this._debouncedCall('homeSessions', () => this.renderHomeSessions(), 150);
  },

  /**
   * One delegated click listener for every row, plus a width listener so
   * resizing the window while on the home screen adds or drops the column
   * instead of leaving it overlapping the content it was sized to clear.
   */
  _wireHomeSessions(el) {
    if (this._homeSessionsWired) return;
    this._homeSessionsWired = true;

    el.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-hs-action]');
      if (!target) return;
      if (target.dataset.hsAction === 'session') {
        void this.selectSession(target.dataset.hsSession);
      } else if (target.dataset.hsAction === 'webview') {
        void this.openWebview?.(target.dataset.hsWebview);
      }
    });

    if (window.matchMedia) {
      const mq = window.matchMedia(`(min-width: ${HOME_SESSIONS_MIN_WIDTH}px)`);
      const onChange = () => {
        // Only relevant while the welcome screen is up; entering a session
        // re-decides through hideWelcome()/showWelcome() anyway.
        if (this.activeSessionId) return;
        const overlay = document.getElementById('welcomeOverlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        this.showHomeSessions();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Model
  // ═══════════════════════════════════════════════════════════════

  /**
   * One row per live session, in the user's tab order. State classification is
   * `_mobileOverviewState()` (mobile-overview.js) so both home screens agree on
   * what counts as needing you; the ORDER differs on purpose — the phone sorts
   * by urgency because it shows one screenful at a time, this column mirrors the
   * tab strip so the number badges line up with Alt+1..9.
   * @returns {Array<object>} row descriptors, ready to render
   */
  buildHomeSessionRows() {
    const cases = Array.isArray(this.cases) ? this.cases : [];
    const order = Array.isArray(this.sessionOrder) ? this.sessionOrder : [];
    const ids = order.filter((id) => this.sessions?.has(id));
    // A session created before the order list caught up would otherwise be
    // invisible here while its tab already exists.
    for (const id of this.sessions?.keys() || []) if (!ids.includes(id)) ids.push(id);

    return ids.map((id, index) => {
      const session = this.sessions.get(id);
      const matched = this._mobileOverviewCaseFor(session.workingDir, cases);
      const state = this._mobileOverviewState(session, this.pendingHooks?.get(id));
      const mode = session.mode || 'claude';
      return {
        id,
        index,
        name: this.getSessionName ? this.getSessionName(session) : session.name || id.slice(0, 8),
        mode,
        modeBadge: HOME_SESSIONS_MODE_BADGE[mode] || '',
        caseName: matched ? matched.name : '',
        dir: this._shortenHomePath ? this._shortenHomePath(session.workingDir) : session.workingDir || '',
        state,
        pill: HOME_SESSIONS_PILL_LABEL[state] || state,
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  renderHomeSessions() {
    const el = document.getElementById('homeSessions');
    if (!el) return;

    const rows = this.buildHomeSessionRows();
    const webviews = (this.webviewOrder || []).map((id) => this.webviews?.get(id)).filter(Boolean);

    // Nothing open means nothing to list: an empty framed box next to a
    // first-run welcome screen is noise, not information.
    if (!rows.length && !webviews.length) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    el.hidden = false;

    el.replaceChildren();
    el.appendChild(this._buildHomeSessionsHeader(rows.length + webviews.length));

    const list = document.createElement('div');
    list.className = 'home-sessions-list';
    for (const row of rows) list.appendChild(this._buildHomeSessionRow(row));
    for (const webview of webviews) list.appendChild(this._buildHomeSessionsWebviewRow(webview));
    el.appendChild(list);
  },

  _buildHomeSessionsHeader(count) {
    const header = document.createElement('div');
    header.className = 'home-sessions-header';

    const label = document.createElement('span');
    label.className = 'home-sessions-title';
    label.textContent = 'Open tabs';
    header.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'home-sessions-count';
    badge.setAttribute('data-i18n-skip', '');
    badge.textContent = String(count);
    header.appendChild(badge);

    return header;
  },

  /**
   * A session row. The state class drives the same visual language as the
   * session tabs and the phone overview: green dot when it is fine (pulsing and
   * ringed by the load spinner while working), a yellow row when it wants input,
   * a red row when it asked a question.
   */
  _buildHomeSessionRow(row) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'home-sessions-row home-sessions-row--' + row.state;
    item.dataset.hsAction = 'session';
    item.dataset.hsSession = row.id;
    item.title = row.dir ? `${row.name} (${row.dir})` : row.name;

    if (row.index < 9) {
      const number = document.createElement('span');
      number.className = 'home-sessions-number';
      number.setAttribute('data-i18n-skip', '');
      number.textContent = String(row.index + 1);
      item.appendChild(number);
    }

    const dot = document.createElement('span');
    dot.className = 'home-sessions-dot home-sessions-dot--' + row.state;
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'home-sessions-row-body';

    const line1 = document.createElement('span');
    line1.className = 'home-sessions-row-title';
    if (row.modeBadge) {
      const badge = document.createElement('span');
      badge.className = `home-sessions-mode ${row.mode}`;
      badge.setAttribute('data-i18n-skip', '');
      badge.textContent = row.modeBadge;
      line1.appendChild(badge);
    }
    const name = document.createElement('span');
    // .session-name is in the i18n skip list: a session name is user content.
    name.className = 'session-name';
    name.textContent = row.name;
    line1.appendChild(name);
    body.appendChild(line1);

    const line2 = document.createElement('span');
    line2.className = 'home-sessions-row-sub';
    line2.setAttribute('data-i18n-skip', '');
    line2.textContent = row.caseName || row.dir || row.mode;
    body.appendChild(line2);

    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className = 'home-sessions-pill home-sessions-pill--' + row.state;
    // Skipped by i18n on purpose: generic single words ("idle", "done", "error")
    // that collide with state strings on other surfaces.
    pill.setAttribute('data-i18n-skip', '');
    pill.textContent = row.pill;
    item.appendChild(pill);

    return item;
  },

  /** A saved dashboard, listed after the sessions exactly as in the tab strip. */
  _buildHomeSessionsWebviewRow(webview) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'home-sessions-row home-sessions-row--web';
    item.dataset.hsAction = 'webview';
    item.dataset.hsWebview = webview.id;
    item.title = webview.url || webview.name;

    const dot = document.createElement('span');
    dot.className = 'home-sessions-dot home-sessions-dot--web';
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'home-sessions-row-body';

    const title = document.createElement('span');
    title.className = 'home-sessions-row-title';
    const name = document.createElement('span');
    // A dashboard name is user content.
    name.className = 'case-name';
    name.textContent = webview.name;
    title.appendChild(name);
    body.appendChild(title);

    const sub = document.createElement('span');
    sub.className = 'home-sessions-row-sub';
    sub.setAttribute('data-i18n-skip', '');
    sub.textContent = webview.url || '';
    body.appendChild(sub);

    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className = 'home-sessions-pill home-sessions-pill--web';
    pill.setAttribute('data-i18n-skip', '');
    pill.textContent = 'web';
    item.appendChild(pill);

    return item;
  },
});
