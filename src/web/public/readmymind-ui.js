/**
 * @fileoverview Read My Mind UI: predict the prompt you were about to type.
 *
 * A 🧠 header button (marker-hidden until the synced opt-in `readMyMindEnabled`
 * setting is ON; phones get a keyboard-accessory 🧠 key gated on the same
 * setting) opens a modal that asks the server for the user's most likely
 * next prompt (`POST /api/sessions/:id/readmymind`, one-shot predictor over the
 * case's intent profile + live session signals). The top suggestion lands in an
 * editable single-line field with its rationale below; the predictor's other
 * suggestions render as tappable alternate rows that swap into the field
 * without losing edits. Buttons are Send (with Enter), Insert (drop on the CLI
 * composer WITHOUT Enter, for editing), Rethink (re-run with the whole shown
 * set, main + alternates, recorded as rejected), Dismiss.
 *
 * Suggestions are NEVER auto-sent: the explicit click here is the security
 * boundary for observed/injectable predictor inputs, so suggestion text is
 * always rendered via value/textContent, never innerHTML. Send/Insert go
 * server-side through `POST /api/sessions/:id/input` (UI chrome, not terminal
 * typing, so the local-echo-overlay `sendEnterKey` trap does not apply);
 * Send appends the `\r` that actually submits, Insert omits it.
 *
 * Backend: src/web/routes/readmymind-routes.ts, design: docs/readmymind-plan.md.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.sessions, this.activeSessionId, showToast)
 * @dependency mobile-handlers.js (MobileDetection.isTouchDevice, focus policy)
 * @dependency settings-ui.js (loadAppSettingsFromStorage)
 * @dependency api-client.js at runtime (this._apiJson; loads later but is only called after init)
 * @loadorder 11.3, after panels-ui.js, before ultracode-panel.js
 */

Object.assign(CodemanApp.prototype, {
  /** Synced setting, default OFF, opt-in via App Settings → Panels. */
  readMyMindEnabled() {
    return this.loadAppSettingsFromStorage().readMyMindEnabled === true;
  },

  /** Open the modal for the active session and start a prediction. */
  openReadMyMind() {
    const sessionId = this.activeSessionId;
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session) {
      this.showToast('Select a session first', 'warning');
      return;
    }
    if (session.mode && session.mode !== 'claude') {
      this.showToast('Read My Mind works on Claude sessions only', 'warning');
      return;
    }
    // Rethink memory resets on each open (a fresh open is a fresh question).
    this._rmm = { sessionId, suggestions: [], selected: 0, rejected: [], busy: false };
    document.getElementById('readMyMindModal')?.classList.add('active');
    this._readMyMindPredict();
  },

  closeReadMyMind() {
    document.getElementById('readMyMindModal')?.classList.remove('active');
    this._rmm = null;
  },

  /** Run (or re-run) the prediction and render the suggestion set. */
  async _readMyMindPredict() {
    const state = this._rmm;
    if (!state || state.busy) return;
    state.busy = true;
    this._rmmSetPhase('loading');

    const body = state.rejected.length > 0 ? { rejected: state.rejected.slice(-10) } : {};
    const data = await this._apiJson(`/api/sessions/${state.sessionId}/readmymind`, { method: 'POST', body });

    // The modal may have been dismissed (or reopened for another session) while
    // the predictor ran; drop a stale response instead of painting over it.
    if (this._rmm !== state) return;
    state.busy = false;

    const suggestions = (data && Array.isArray(data.suggestions) ? data.suggestions : []).filter(
      (s) => s && typeof s.prompt === 'string' && s.prompt.trim()
    );
    if (suggestions.length === 0) {
      this._rmmSetPhase('error');
      return;
    }
    state.suggestions = suggestions.slice(0, 3);
    state.selected = 0;
    this._rmmSetPhase('ready');
    this._rmmRender();
    this._rmmFocusPrompt();
  },

  /** Paint the selected suggestion into the editable field, the rest as alternates. */
  _rmmRender() {
    const state = this._rmm;
    const current = state && state.suggestions[state.selected];
    if (!current) return;

    const input = document.getElementById('readMyMindPrompt');
    const why = document.getElementById('readMyMindWhy');
    const kind = document.getElementById('readMyMindKind');
    // Predictor output is derived from observable (injectable) content:
    // value/textContent only, never innerHTML.
    if (input) input.value = current.prompt;
    if (why) why.textContent = current.why || '';
    if (kind) {
      kind.textContent = current.kind || 'continue';
      kind.className = `readmymind-kind readmymind-kind-${current.kind || 'continue'}`;
    }

    const alternates = document.getElementById('readMyMindAlternates');
    if (!alternates) return;
    alternates.replaceChildren();
    // The container is data-i18n-skip (suggestion text must never be mistaken
    // for app copy), so the one piece of app copy inside it is pre-translated.
    const translate = window.codemanT || ((s) => s);
    state.suggestions.forEach((suggestion, index) => {
      if (index === state.selected) return;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'readmymind-alt';
      row.title = suggestion.why || '';
      row.setAttribute('aria-label', translate('Use this suggestion instead'));
      const badge = document.createElement('span');
      badge.className = `readmymind-kind readmymind-kind-${suggestion.kind || 'continue'}`;
      badge.textContent = suggestion.kind || 'continue';
      const text = document.createElement('span');
      text.className = 'readmymind-alt-text';
      text.textContent = suggestion.prompt;
      row.append(badge, text);
      row.addEventListener('click', () => this._rmmSelect(index));
      alternates.appendChild(row);
    });
    alternates.style.display = alternates.childElementCount > 0 ? '' : 'none';
  },

  /** Swap an alternate into the field, folding the current edit back first. */
  _rmmSelect(index) {
    const state = this._rmm;
    if (!state || state.busy || !state.suggestions[index]) return;
    const input = document.getElementById('readMyMindPrompt');
    const current = state.suggestions[state.selected];
    // Keep edits: fold the field text back into the suggestion it belongs to,
    // so toggling between alternates never loses typing.
    if (input && current) current.prompt = input.value;
    state.selected = index;
    this._rmmRender();
    this._rmmFocusPrompt();
  },

  /** Focus the editable field on desktop. On touch devices leave it blurred so
   *  the OS keyboard doesn't pop over the alternates that just rendered. */
  _rmmFocusPrompt() {
    if (typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice()) return;
    document.getElementById('readMyMindPrompt')?.focus();
  },

  /**
   * Send the (possibly edited) suggestion. `withEnter` submits (`\r`, the
   * documented single-line input rule); without it the text sits unsubmitted
   * on the CLI composer for further editing (Insert).
   */
  async sendReadMyMind(withEnter) {
    const state = this._rmm;
    const input = document.getElementById('readMyMindPrompt');
    const text = input ? input.value.replace(/[\r\n]+/g, ' ').trim() : '';
    if (!state || !text) return;

    const res = await this._apiJson(`/api/sessions/${state.sessionId}/input`, {
      method: 'POST',
      body: { input: withEnter ? `${text}\r` : text },
    });
    if (res === null) {
      this.showToast('Could not reach the session', 'error');
      return;
    }
    this.closeReadMyMind();
    this.showToast(withEnter ? 'Prompt sent' : 'Inserted, press Enter in the terminal to send', 'success');
  },

  /** Re-run with the whole shown set (main + alternates) recorded as rejected:
   *  the user saw every row and asked for something else. */
  rethinkReadMyMind() {
    const state = this._rmm;
    if (!state || state.busy) return;
    for (const suggestion of state.suggestions) {
      if (suggestion.prompt && suggestion.prompt.trim()) state.rejected.push(suggestion.prompt);
    }
    this._readMyMindPredict();
  },

  /** Toggle the modal between its loading / ready / error phases. */
  _rmmSetPhase(phase) {
    const modal = document.getElementById('readMyMindModal');
    if (!modal) return;
    modal.querySelector('.readmymind-loading').style.display = phase === 'loading' ? '' : 'none';
    modal.querySelector('.readmymind-result').style.display = phase === 'ready' ? '' : 'none';
    modal.querySelector('.readmymind-error').style.display = phase === 'error' ? '' : 'none';
    const rethinkBtn = document.getElementById('readMyMindRethink');
    if (rethinkBtn) rethinkBtn.disabled = phase === 'loading';
  },
});
