/**
 * @fileoverview Read My Mind UI: predict the prompt you were about to type.
 *
 * A 🧠 header button (marker-hidden until the synced opt-in `readMyMindEnabled`
 * setting is ON) opens a modal that asks the server for the user's most likely
 * next prompt (`POST /api/sessions/:id/readmymind`, one-shot predictor over the
 * case's intent profile + live session signals). The top suggestion lands in an
 * editable single-line field with its rationale below; the predictor returns up
 * to 3 kind-diverse suggestions (continue / verify / redirect) and the rest
 * render as tappable alternate rows that swap into the field. Buttons are Send
 * (with Enter), Insert (drop on the CLI composer WITHOUT Enter, for editing),
 * Rethink (re-run with every displayed suggestion recorded as rejected, plus an
 * optional free-text steer note from the field above the buttons), Dismiss.
 *
 * Phone surfaces reuse this same modal: the keyboard-accessory 🧠 key
 * (keyboard-accessory.js) and the phone overview's waiting-row shortcut
 * (mobile-overview.js) both call openReadMyMind(sessionId).
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

  /**
   * Open the modal and start a prediction. Defaults to the active session;
   * phone surfaces (accessory key, overview rows) pass an explicit id so a
   * prediction can start without switching tabs first.
   */
  openReadMyMind(sessionId) {
    const id = sessionId || this.activeSessionId;
    const session = id ? this.sessions.get(id) : null;
    if (!session) {
      this.showToast('Select a session first', 'warning');
      return;
    }
    if (session.mode && session.mode !== 'claude') {
      this.showToast('Read My Mind works on Claude sessions only', 'warning');
      return;
    }
    // Rethink memory resets on each open (a fresh open is a fresh question),
    // and so does the steer note (it belongs to the question it steered).
    this._rmm = { sessionId: id, shown: null, alternates: [], rejected: [], busy: false };
    const steer = document.getElementById('readMyMindSteer');
    if (steer) steer.value = '';
    // Name the target in the header: overview rows and the accessory key can
    // open this for a session that is not the active tab.
    const sessionLabel = document.getElementById('readMyMindSession');
    if (sessionLabel) sessionLabel.textContent = this.getSessionName?.(session) || session.name || '';
    document.getElementById('readMyMindModal')?.classList.add('active');
    this._readMyMindPredict();
  },

  closeReadMyMind() {
    document.getElementById('readMyMindModal')?.classList.remove('active');
    this._rmm = null;
  },

  /** Run (or re-run) the prediction and render the suggestions. */
  async _readMyMindPredict() {
    const state = this._rmm;
    if (!state || state.busy) return;
    state.busy = true;
    this._rmmSetPhase('loading');

    const body = {};
    if (state.rejected.length > 0) body.rejected = state.rejected.slice(-10);
    // The steer note is the user's own words; server-side it rides in the
    // highest-authority context tier. Bounds mirror ReadMyMindPredictSchema.
    const steerEl = document.getElementById('readMyMindSteer');
    const steer = steerEl
      ? steerEl.value
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 2000)
      : '';
    if (steer) body.steer = steer;
    const data = await this._apiJson(`/api/sessions/${state.sessionId}/readmymind`, { method: 'POST', body });

    // The modal may have been dismissed (or reopened for another session) while
    // the predictor ran; drop a stale response instead of painting over it.
    if (this._rmm !== state) return;
    state.busy = false;

    const suggestions = (data && data.suggestions) || [];
    if (suggestions.length === 0) {
      this._rmmSetPhase('error');
      return;
    }
    state.shown = suggestions[0];
    state.alternates = suggestions.slice(1);
    this._rmmSetPhase('ready');
    this._rmmShowSuggestion(state.shown);
    this._rmmRenderAlternates();
    document.getElementById('readMyMindPrompt')?.focus();
  },

  /** Paint one suggestion into the editable field, kind chip, and rationale. */
  _rmmShowSuggestion(suggestion) {
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
  },

  /** The non-primary suggestions as tappable rows below the rationale. */
  _rmmRenderAlternates() {
    const state = this._rmm;
    const box = document.getElementById('readMyMindAlternates');
    if (!box) return;
    box.textContent = '';
    if (!state) return;
    state.alternates.forEach((alt, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'readmymind-alt';
      const kind = document.createElement('span');
      kind.className = `readmymind-kind readmymind-kind-${alt.kind || 'continue'}`;
      kind.textContent = alt.kind || 'continue';
      const col = document.createElement('span');
      col.className = 'readmymind-alt-col';
      const text = document.createElement('span');
      text.className = 'readmymind-alt-text';
      text.textContent = alt.prompt;
      col.appendChild(text);
      // The rationale as a visible second line: phones have no hover, and the
      // why is what separates two plausible-looking prompts.
      if (alt.why) {
        const why = document.createElement('span');
        why.className = 'readmymind-alt-why';
        why.textContent = alt.why;
        col.appendChild(why);
      }
      row.appendChild(kind);
      row.appendChild(col);
      row.addEventListener('click', () => {
        // Swap: the tapped alternate becomes the shown suggestion and the
        // previously shown one takes its row, so browsing loses nothing.
        const prev = state.shown;
        state.shown = alt;
        state.alternates[i] = prev;
        this._rmmShowSuggestion(alt);
        this._rmmRenderAlternates();
      });
      box.appendChild(row);
    });
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

  /**
   * Re-run with every displayed suggestion recorded as a rejection (the user
   * saw them all and wanted none: strong negative signal) plus the optional
   * steer note, read by _readMyMindPredict from its field.
   */
  rethinkReadMyMind() {
    const state = this._rmm;
    if (!state || state.busy) return;
    for (const s of [state.shown, ...state.alternates]) {
      if (!s || !s.prompt) continue;
      const prompt = s.prompt.slice(0, 1000);
      if (!state.rejected.includes(prompt)) state.rejected.push(prompt);
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
    // The steer field shows in ready AND error phases: steering a failed run's
    // retry is exactly when a note helps. Hidden only while loading.
    const steer = document.getElementById('readMyMindSteer');
    if (steer) steer.style.display = phase === 'loading' ? 'none' : '';
    // While the predictor runs the hidden field still holds the previous text;
    // freeze every action so a stale suggestion cannot be sent mid-rethink.
    for (const btnId of ['readMyMindRethink', 'readMyMindInsert', 'readMyMindSend']) {
      const btn = document.getElementById(btnId);
      if (btn) btn.disabled = phase === 'loading';
    }
  },
});
