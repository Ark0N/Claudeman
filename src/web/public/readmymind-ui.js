/**
 * @fileoverview Read My Mind UI: predict the prompt you were about to type.
 *
 * A 🧠 header button (marker-hidden until the synced opt-in `readMyMindEnabled`
 * setting is ON) opens a modal that asks the server for the user's most likely
 * next prompt (`POST /api/sessions/:id/readmymind`, one-shot predictor over the
 * case's intent profile + live session signals). The top suggestion lands in an
 * editable single-line field with its rationale below; buttons are Send (with
 * Enter), Insert (drop on the CLI composer WITHOUT Enter, for editing), Rethink
 * (re-run with the shown suggestion recorded as rejected), Dismiss.
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
    this._rmm = { sessionId, shown: null, rejected: [], busy: false };
    document.getElementById('readMyMindModal')?.classList.add('active');
    this._readMyMindPredict();
  },

  closeReadMyMind() {
    document.getElementById('readMyMindModal')?.classList.remove('active');
    this._rmm = null;
  },

  /** Run (or re-run) the prediction and render the top suggestion. */
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

    const suggestion = data && data.suggestions && data.suggestions[0];
    if (!suggestion) {
      this._rmmSetPhase('error');
      return;
    }
    state.shown = suggestion;
    this._rmmSetPhase('ready');

    const input = document.getElementById('readMyMindPrompt');
    const why = document.getElementById('readMyMindWhy');
    const kind = document.getElementById('readMyMindKind');
    // Predictor output is derived from observable (injectable) content:
    // value/textContent only, never innerHTML.
    if (input) input.value = suggestion.prompt;
    if (why) why.textContent = suggestion.why || '';
    if (kind) {
      kind.textContent = suggestion.kind || 'continue';
      kind.className = `readmymind-kind readmymind-kind-${suggestion.kind || 'continue'}`;
    }
    input?.focus();
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

  /** Re-run with the shown suggestion recorded as a rejection. */
  rethinkReadMyMind() {
    const state = this._rmm;
    if (!state || state.busy) return;
    if (state.shown && state.shown.prompt) state.rejected.push(state.shown.prompt);
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
