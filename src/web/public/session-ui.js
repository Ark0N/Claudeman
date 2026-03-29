/**
 * @fileoverview Quick start (case loading, session spawning for Claude/Shell/OpenCode),
 * session options modal (per-session settings, color picker, rename),
 * session options tabs (Ralph config tab), case settings (CRUD, links),
 * create case modal, and mobile case picker.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.sessions, this.cases, this.activeSessionId)
 * @dependency constants.js (escapeHtml)
 * @dependency mobile-handlers.js (MobileDetection)
 * @loadorder 12 of 15 — loaded after panels-ui.js, before ralph-wizard.js
 */

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Quick Start
  // ═══════════════════════════════════════════════════════════════

  async loadQuickStartCases(selectCaseName = null, settingsPromise = null) {
    try {
      // Load settings to get lastUsedCase (reuse shared promise if provided)
      let lastUsedCase = null;
      try {
        const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null);
        if (settings) {
          lastUsedCase = settings.lastUsedCase || null;
        }
      } catch {
        // Ignore settings load errors
      }

      const res = await fetch('/api/cases');
      const cases = await res.json();
      this.cases = cases;
      console.log('[loadQuickStartCases] Loaded cases:', cases.map(c => c.name), 'lastUsedCase:', lastUsedCase);

      const select = document.getElementById('quickStartCase');

      // Build options - existing cases first, then testcase as fallback if not present
      let options = '';
      const hasTestcase = cases.some(c => c.name === 'testcase');
      const isMobile = MobileDetection.getDeviceType() === 'mobile';
      const maxNameLength = isMobile ? 8 : 20; // Truncate to 8 chars on mobile

      cases.forEach(c => {
        const displayName = c.name.length > maxNameLength
          ? c.name.substring(0, maxNameLength) + '…'
          : c.name;
        options += `<option value="${escapeHtml(c.name)}">${escapeHtml(displayName)}</option>`;
      });

      // Add testcase option if it doesn't exist (will be created on first run)
      if (!hasTestcase) {
        options = `<option value="testcase">testcase</option>` + options;
      }

      select.innerHTML = options;
      console.log('[loadQuickStartCases] Set options:', select.innerHTML.substring(0, 200));

      // If a specific case was requested, select it
      if (selectCaseName) {
        select.value = selectCaseName;
        this.updateDirDisplayForCase(selectCaseName);
        this.updateMobileCaseLabel(selectCaseName);
      } else if (lastUsedCase && cases.some(c => c.name === lastUsedCase)) {
        // Use lastUsedCase if available and exists
        select.value = lastUsedCase;
        this.updateDirDisplayForCase(lastUsedCase);
        this.updateMobileCaseLabel(lastUsedCase);
      } else if (cases.length > 0) {
        // Fallback to testcase or first case
        const firstCase = cases.find(c => c.name === 'testcase') || cases[0];
        select.value = firstCase.name;
        this.updateDirDisplayForCase(firstCase.name);
        this.updateMobileCaseLabel(firstCase.name);
      } else {
        // No cases exist yet - show the default case name as directory
        select.value = 'testcase';
        document.getElementById('dirDisplay').textContent = '~/codeman-cases/testcase';
        this.updateMobileCaseLabel('testcase');
      }

      // Only add event listener once (on first load)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          this.updateDirDisplayForCase(select.value);
          this.saveLastUsedCase(select.value);
          this.updateMobileCaseLabel(select.value);
        });
        select.dataset.listenerAdded = 'true';
      }
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  },

  async updateDirDisplayForCase(caseName) {
    try {
      const res = await fetch(`/api/cases/${caseName}`);
      const data = await res.json();
      if (data.path) {
        document.getElementById('dirDisplay').textContent = data.path;
        document.getElementById('dirInput').value = data.path;
      }
    } catch (err) {
      document.getElementById('dirDisplay').textContent = caseName;
    }
  },

  async saveLastUsedCase(caseName) {
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastUsedCase: caseName })
      });
    } catch (err) {
      console.error('Failed to save last used case:', err);
    }
  },

  async quickStart() {
    return this.run();
  },

  /** Run using the selected mode (Claude Code or OpenCode) */
  async run() {
    const mode = this._runMode || 'claude';
    if (mode === 'opencode') {
      return this.runOpenCode();
    }
    return this.runClaude();
  },

  /** Get/set the run mode, persisted in localStorage */
  get runMode() { return this._runMode || 'claude'; },

  setRunMode(mode) {
    this._runMode = mode;
    try { localStorage.setItem('codeman_runMode', mode); } catch {}
    this._applyRunMode();
    // Sync to server for cross-device persistence
    this._apiPut('/api/settings', { runMode: mode }).catch(() => {});
    // Close menu
    document.getElementById('runModeMenu')?.classList.remove('active');
  },

  toggleRunModeMenu(e) {
    e?.stopPropagation();
    const menu = document.getElementById('runModeMenu');
    if (!menu) return;
    menu.classList.toggle('active');
    // Update selected state
    menu.querySelectorAll('.run-mode-option').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.mode === this.runMode);
    });
    // Load history sessions when menu opens
    if (menu.classList.contains('active')) {
      this._loadRunModeHistory();
      const close = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.classList.remove('active');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  },

  async _loadRunModeHistory() {
    const container = document.getElementById('runModeHistory');
    if (!container) return;
    container.innerHTML = '<div class="run-mode-hist-empty">Loading...</div>';

    try {
      const display = await this._fetchHistorySessions(10);
      if (display.length === 0) {
        container.innerHTML = '<div class="run-mode-hist-empty">No history</div>';
        return;
      }

      // Build items using DOM API for reliable mobile touch handling
      container.replaceChildren();
      for (const s of display) {
        const date = new Date(s.lastModified);
        const timeStr = date.toLocaleDateString('en', { month: 'short', day: 'numeric' })
          + ' ' + date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
        const shortDir = s.workingDir.replace(/^\/home\/[^/]+\//, '~/');

        const btn = document.createElement('button');
        btn.className = 'run-mode-option';
        btn.title = s.workingDir;
        btn.dataset.sessionId = s.sessionId;
        btn.dataset.workingDir = s.workingDir;

        const dirSpan = document.createElement('span');
        dirSpan.className = 'hist-dir';
        dirSpan.textContent = shortDir;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'hist-meta';
        metaSpan.textContent = timeStr;

        btn.append(dirSpan, metaSpan);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.resumeHistorySession(s.sessionId, s.workingDir);
        });
        container.appendChild(btn);
      }
    } catch (err) {
      container.innerHTML = '<div class="run-mode-hist-empty">Failed to load</div>';
    }
  },

  _applyRunMode() {
    const mode = this.runMode;
    const runBtn = document.getElementById('runBtn');
    const gearBtn = runBtn?.nextElementSibling;
    const label = document.getElementById('runBtnLabel');
    if (runBtn) {
      runBtn.className = `btn-toolbar btn-run mode-${mode}`;
    }
    if (gearBtn) {
      gearBtn.className = `btn-toolbar btn-run-gear mode-${mode}`;
    }
    if (label) {
      label.textContent = mode === 'opencode' ? 'Run OC' : 'Run';
    }
  },

  _initRunMode() {
    try { this._runMode = localStorage.getItem('codeman_runMode') || 'claude'; } catch { this._runMode = 'claude'; }
    this._applyRunMode();
  },

  // Tab count stepper functions
  incrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  },

  decrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  },

  // Shell count stepper functions
  incrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  },

  decrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  },

  async runClaude() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const tabCount = Math.min(20, Math.max(1, parseInt(document.getElementById('tabCount').value) || 1));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting ${tabCount} Claude session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');
    // Focus terminal NOW, in the synchronous user-gesture context (button click).
    // iOS Safari ignores programmatic focus() after any await, so this must happen
    // before the first async call. The keyboard opens here and stays open through
    // the session creation flow; selectSession at the end inherits the focus state.
    this.terminal.focus();

    try {
      // Get case path first
      const caseRes = await fetch(`/api/cases/${caseName}`);
      let caseData = await caseRes.json();

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create case');
        // Use the newly created case data (API returns { success, case: { name, path } })
        caseData = createCaseData.case;
      }

      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');
      let firstSessionId = null;

      // Find the highest existing w-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^w(\d+)-([a-zA-Z0-9_-]+)/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Get global Ralph tracker setting
      const ralphEnabled = this.isRalphTrackerEnabledByDefault();

      // Create all sessions in parallel for speed
      const sessionNames = [];
      for (let i = 0; i < tabCount; i++) {
        sessionNames.push(`w${startNumber + i}-${caseName}`);
      }

      // Build env overrides from global + case settings (case overrides global)
      const caseSettings = this.getCaseSettings(caseName);
      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = {};
      if (caseSettings.agentTeams || globalSettings.agentTeamsEnabled) {
        envOverrides.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      }
      const hasEnvOverrides = Object.keys(envOverrides).length > 0;
      const useOpus1m = caseSettings.opusContext1m || globalSettings.opusContext1mEnabled;
      const modelOverride = useOpus1m ? 'opus[1m]' : '';

      // Step 1: Create all sessions in parallel
      this.terminal.writeln(`\x1b[90m Creating ${tabCount} session(s)...\x1b[0m`);
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workingDir, name,
            ...(hasEnvOverrides ? { envOverrides } : {}),
            ...(modelOverride !== undefined ? { modelOverride } : {}),
          })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      // Collect created session IDs
      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.session.id);
      }
      firstSessionId = sessionIds[0];

      // Step 2: Configure Ralph for all sessions in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/ralph-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: ralphEnabled, disableAutoEnable: !ralphEnabled })
        })
      ));

      // Step 3: Start all sessions in parallel (biggest speedup)
      this.terminal.writeln(`\x1b[90m Starting ${tabCount} session(s) in parallel...\x1b[0m`);
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/interactive`, { method: 'POST' })
      ));

      this.terminal.writeln(`\x1b[90m All ${tabCount} sessions ready\x1b[0m`);

      // Auto-switch to the new session using selectSession (does proper refresh)
      if (firstSessionId) {
        await this.selectSession(firstSessionId);
        this.loadQuickStartCases();
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  /** Send Ctrl+C to the active session to stop the current operation.
   *  Requires double-tap: first tap turns button amber, second tap within 2s sends Ctrl+C. */
  stopClaude() {
    if (!this.activeSessionId) return;
    const btn = document.querySelector('.btn-toolbar.btn-stop');
    if (!btn) return;

    if (this._stopConfirmTimer) {
      // Second tap — send Ctrl+C
      clearTimeout(this._stopConfirmTimer);
      this._stopConfirmTimer = null;
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
      btn.classList.remove('confirming');
      fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x03' })
      });
    } else {
      // First tap — enter confirm state
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Tap again';
      btn.classList.add('confirming');
      this._stopConfirmTimer = setTimeout(() => {
        this._stopConfirmTimer = null;
        if (btn.dataset.origHtml) {
          btn.innerHTML = btn.dataset.origHtml;
          delete btn.dataset.origHtml;
        }
        btn.classList.remove('confirming');
      }, 2000);
    }
  },

  async runShell() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const shellCount = Math.min(20, Math.max(1, parseInt(document.getElementById('shellCount').value) || 1));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;33m Starting ${shellCount} Shell session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get the case path
      const caseRes = await fetch(`/api/cases/${caseName}`);
      const caseData = await caseRes.json();
      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');

      // Find the highest existing s-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^s(\d+)-([a-zA-Z0-9_-]+)/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Create all shell sessions in parallel
      const sessionNames = [];
      for (let i = 0; i < shellCount; i++) {
        sessionNames.push(`s${startNumber + i}-${caseName}`);
      }

      // Step 1: Create all sessions in parallel
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir, mode: 'shell', name })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.session.id);
      }

      // Step 2: Start all shells in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/shell`, { method: 'POST' })
      ));

      // Step 3: Resize all in parallel (with minimum dimension enforcement)
      const dims = this.getTerminalDimensions();
      if (dims) {
        await Promise.all(sessionIds.map(id =>
          fetch(`/api/sessions/${id}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dims)
          })
        ));
      }

      // Switch to first session
      if (sessionIds.length > 0) {
        this.activeSessionId = sessionIds[0];
        await this.selectSession(sessionIds[0]);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  async runOpenCode() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting OpenCode session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');
    // Focus in sync gesture context (see runClaude comment)
    this.terminal.focus();

    try {
      // Check if OpenCode is available
      const statusRes = await fetch('/api/opencode/status');
      const status = await statusRes.json();
      if (!status.available) {
        this.terminal.writeln('\x1b[1;31m OpenCode CLI not found.\x1b[0m');
        this.terminal.writeln('\x1b[90m Install with: curl -fsSL https://opencode.ai/install | bash\x1b[0m');
        return;
      }

      // Quick-start with opencode mode (auto-allow tools by default)
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'opencode',
          openCodeConfig: { autoAllowTools: true },
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start OpenCode');

      // Switch to the new session (don't pre-set activeSessionId — selectSession
      // early-returns when IDs match, skipping buffer load and sendResize)
      if (data.sessionId) {
        await this.selectSession(data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Session Options Modal
  // ═══════════════════════════════════════════════════════════════

  openSessionOptions(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.editingSessionId = sessionId;

    // Reset to an appropriate tab — Summary for OpenCode (Respawn/Ralph are Claude-only)
    this.switchOptionsTab(session.mode === 'opencode' ? 'summary' : 'respawn');

    // Update respawn status display and buttons
    const respawnStatus = document.getElementById('sessionRespawnStatus');
    const enableBtn = document.getElementById('modalEnableRespawnBtn');
    const stopBtn = document.getElementById('modalStopRespawnBtn');

    if (this.respawnStatus[sessionId]) {
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent =
        this.respawnStatus[sessionId].state || 'Active';
      enableBtn.style.display = 'none';
      stopBtn.style.display = '';
    } else {
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      enableBtn.style.display = '';
      stopBtn.style.display = 'none';
    }

    // Only show respawn section for claude mode sessions with a running process
    const respawnSection = document.getElementById('sessionRespawnSection');
    if (session.mode === 'claude' && session.pid) {
      respawnSection.style.display = '';
    } else {
      respawnSection.style.display = 'none';
    }

    // Hide Claude-specific options for OpenCode sessions
    const isOpenCode = session.mode === 'opencode';
    const claudeOnlyEls = document.querySelectorAll('[data-claude-only]');
    claudeOnlyEls.forEach(el => { el.style.display = isOpenCode ? 'none' : ''; });

    // Reset duration presets to default (unlimited)
    this.selectDurationPreset('');

    // Populate respawn config from saved state
    this.loadSavedRespawnConfig(sessionId);

    // Populate auto-compact/clear from session state
    document.getElementById('modalAutoCompactEnabled').checked = session.autoCompactEnabled ?? false;
    document.getElementById('modalAutoCompactThreshold').value = session.autoCompactThreshold ?? 110000;
    document.getElementById('modalAutoCompactPrompt').value = session.autoCompactPrompt ?? '';
    document.getElementById('modalAutoClearEnabled').checked = session.autoClearEnabled ?? false;
    document.getElementById('modalAutoClearThreshold').value = session.autoClearThreshold ?? 140000;
    document.getElementById('modalImageWatcherEnabled').checked = session.imageWatcherEnabled ?? true;
    document.getElementById('modalFlickerFilterEnabled').checked = session.flickerFilterEnabled ?? false;

    // Populate session name input with prefix/suffix split
    const _modalParsed = parseSessionPrefix(session.name);
    const _prefixEl = document.getElementById('modalSessionPrefix');
    if (_modalParsed) {
      _prefixEl.textContent = _modalParsed.prefix + ': ';
      _prefixEl.style.display = '';
      document.getElementById('modalSessionName').value = _modalParsed.suffix;
      document.getElementById('modalSessionName').placeholder = 'Add description...';
    } else {
      _prefixEl.style.display = 'none';
      _prefixEl.textContent = '';
      document.getElementById('modalSessionName').value = session.name || '';
      document.getElementById('modalSessionName').placeholder = 'Auto (directory name)';
    }

    // Initialize color picker with current session color
    const currentColor = session.color || 'default';
    const colorPicker = document.getElementById('sessionColorPicker');
    colorPicker?.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.toggle('selected', s.dataset.color === currentColor);
    });

    // Initialize respawn preset dropdown
    this.renderPresetDropdown();
    document.getElementById('respawnPresetSelect').value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    // Hide Ralph/Todo tab and Respawn tab for opencode sessions (not supported)
    const ralphTabBtn = document.querySelector('#sessionOptionsModal .modal-tab-btn[data-tab="ralph"]');
    const respawnTabBtn = document.querySelector('#sessionOptionsModal .modal-tab-btn[data-tab="respawn"]');
    if (isOpenCode) {
      if (ralphTabBtn) ralphTabBtn.style.display = 'none';
      if (respawnTabBtn) respawnTabBtn.style.display = 'none';
      // Default to Context tab for opencode sessions since Respawn is hidden
      this.switchOptionsTab('context');
    } else {
      if (ralphTabBtn) ralphTabBtn.style.display = '';
      if (respawnTabBtn) respawnTabBtn.style.display = '';
    }

    // Populate Ralph Wiggum form with current session values (skip for opencode)
    if (!isOpenCode) {
      const ralphState = this.ralphStates.get(sessionId);
      this.populateRalphForm({
        enabled: ralphState?.loop?.enabled ?? session.ralphLoop?.enabled ?? false,
        completionPhrase: ralphState?.loop?.completionPhrase || session.ralphLoop?.completionPhrase || '',
        maxIterations: ralphState?.loop?.maxIterations || session.ralphLoop?.maxIterations || 0,
      });
    }

    const modal = document.getElementById('sessionOptionsModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  async saveSessionName() {
    if (!this.editingSessionId) return;
    const session = this.sessions.get(this.editingSessionId);
    const parsed = session ? parseSessionPrefix(session.name) : null;
    const inputVal = document.getElementById('modalSessionName').value.trim();
    let name;
    if (parsed) {
      name = parsed.prefix + (inputVal ? ': ' + inputVal : '');
    } else {
      name = inputVal;
    }
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/name`, { name });
    } catch (err) {
      this.showToast('Failed to save session name: ' + err.message, 'error');
    }
  },

  async autoSaveAutoCompact() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-compact`, {
        enabled: document.getElementById('modalAutoCompactEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000,
        prompt: document.getElementById('modalAutoCompactPrompt').value.trim() || undefined
      });
    } catch { /* silent */ }
  },

  async autoSaveAutoClear() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-clear`, {
        enabled: document.getElementById('modalAutoClearEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000
      });
    } catch { /* silent */ }
  },

  async toggleSessionImageWatcher() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalImageWatcherEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/image-watcher`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.imageWatcherEnabled = enabled;
      }
      this.showToast(`Image watcher ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle image watcher', 'error');
    }
  },

  async toggleFlickerFilter() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalFlickerFilterEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/flicker-filter`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.flickerFilterEnabled = enabled;
      }
      this.showToast(`Flicker filter ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle flicker filter', 'error');
    }
  },

  async autoSaveRespawnConfig() {
    if (!this.editingSessionId) return;
    const config = {
      updatePrompt: document.getElementById('modalRespawnPrompt').value,
      sendClear: document.getElementById('modalRespawnSendClear').checked,
      sendInit: document.getElementById('modalRespawnSendInit').checked,
      kickstartPrompt: document.getElementById('modalRespawnKickstart').value.trim() || undefined,
      autoAcceptPrompts: document.getElementById('modalRespawnAutoAccept').checked,
    };
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/respawn/config`, config);
    } catch {
      // Silent save - don't interrupt user
    }
  },

  async loadSavedRespawnConfig(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/respawn/config`);
      const data = await res.json();
      if (data.success && data.config) {
        const c = data.config;
        document.getElementById('modalRespawnPrompt').value = c.updatePrompt || 'update all the docs and CLAUDE.md';
        document.getElementById('modalRespawnSendClear').checked = c.sendClear ?? true;
        document.getElementById('modalRespawnSendInit').checked = c.sendInit ?? true;
        document.getElementById('modalRespawnKickstart').value = c.kickstartPrompt || '';
        document.getElementById('modalRespawnAutoAccept').checked = c.autoAcceptPrompts ?? true;
        // Restore duration if set
        if (c.durationMinutes) {
          const presetBtn = document.querySelector(`.duration-preset-btn[data-minutes="${c.durationMinutes}"]`);
          if (presetBtn) {
            this.selectDurationPreset(String(c.durationMinutes));
          } else {
            this.selectDurationPreset('custom');
            document.getElementById('modalRespawnDuration').value = c.durationMinutes;
          }
        }
      }
    } catch {
      // Ignore - use defaults
    }
  },

  // Handle duration preset selection
  selectDurationPreset(value) {
    // Remove active from all buttons
    document.querySelectorAll('.duration-preset-btn').forEach(btn => btn.classList.remove('active'));

    // Find and activate the clicked button
    const btn = document.querySelector(`.duration-preset-btn[data-minutes="${value}"]`);
    if (btn) btn.classList.add('active');

    // Show/hide custom input
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (value === 'custom') {
      customInput.classList.add('visible');
      durationInput.focus();
    } else {
      customInput.classList.remove('visible');
      durationInput.value = ''; // Clear custom value when using preset
    }
  },

  // Get selected duration from preset buttons or custom input
  getSelectedDuration() {
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (customInput.classList.contains('visible')) {
      // Custom mode - use input value
      return durationInput.value ? parseInt(durationInput.value) : null;
    } else {
      // Preset mode - get from active button
      const activeBtn = document.querySelector('.duration-preset-btn.active');
      const minutes = activeBtn?.dataset.minutes;
      return minutes ? parseInt(minutes) : null;
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Session Options Modal Tabs
  // ═══════════════════════════════════════════════════════════════

  switchOptionsTab(tabName) {
    // Toggle active class on tab buttons
    document.querySelectorAll('#sessionOptionsModal .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Toggle hidden class on tab content
    document.getElementById('respawn-tab').classList.toggle('hidden', tabName !== 'respawn');
    document.getElementById('context-tab').classList.toggle('hidden', tabName !== 'context');
    document.getElementById('ralph-tab').classList.toggle('hidden', tabName !== 'ralph');
    document.getElementById('summary-tab').classList.toggle('hidden', tabName !== 'summary');

    // Load run summary data when switching to summary tab
    if (tabName === 'summary' && this.editingSessionId) {
      this.loadRunSummary(this.editingSessionId);
    }
  },

  getRalphConfig() {
    return {
      enabled: document.getElementById('modalRalphEnabled').checked,
      completionPhrase: document.getElementById('modalRalphPhrase').value.trim(),
      maxIterations: parseInt(document.getElementById('modalRalphMaxIterations').value) || 0,
      maxTodos: parseInt(document.getElementById('modalRalphMaxTodos').value) || 50,
      todoExpirationMinutes: parseInt(document.getElementById('modalRalphTodoExpiration').value) || 60
    };
  },

  populateRalphForm(config) {
    document.getElementById('modalRalphEnabled').checked = config?.enabled ?? false;
    document.getElementById('modalRalphPhrase').value = config?.completionPhrase || '';
    document.getElementById('modalRalphMaxIterations').value = config?.maxIterations || 0;
    document.getElementById('modalRalphMaxTodos').value = config?.maxTodos || 50;
    document.getElementById('modalRalphTodoExpiration').value = config?.todoExpirationMinutes || 60;
  },

  async saveRalphConfig() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const config = this.getRalphConfig();

    // If user is enabling Ralph, clear from closed set
    if (config.enabled) {
      this.ralphClosedSessions.delete(this.editingSessionId);
    }

    try {
      const res = await fetch(`/api/sessions/${this.editingSessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.showToast('Ralph config saved', 'success');
    } catch (err) {
      this.showToast('Failed to save Ralph config: ' + err.message, 'error');
    }
  },

  // Inline rename on right-click
  startInlineRename(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const tabName = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`);
    if (!tabName) return;

    const currentName = this.getSessionName(session);
    const parsed = parseSessionPrefix(session.name);
    const originalContent = tabName.textContent;
    tabName.textContent = '';
    tabName.innerHTML = '';

    // If prefix detected, show it as non-editable label
    if (parsed) {
      const prefixLabel = document.createElement('span');
      prefixLabel.textContent = parsed.prefix + ': ';
      prefixLabel.style.cssText = 'color: var(--text-muted); font-size: 0.75rem; white-space: nowrap;';
      tabName.appendChild(prefixLabel);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = parsed ? parsed.suffix : (session.name || '');
    input.placeholder = parsed ? 'Add description...' : currentName;
    input.className = 'tab-rename-input';
    input.style.cssText = 'width: 80px; font-size: 0.75rem; padding: 2px 4px; background: var(--bg-input); border: 1px solid var(--accent); border-radius: 3px; color: var(--text); outline: none;';

    tabName.appendChild(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const suffix = input.value.trim();
      let fullName;
      if (parsed) {
        fullName = parsed.prefix + (suffix ? ': ' + suffix : '');
      } else {
        fullName = suffix;
      }
      tabName.textContent = fullName || originalContent;

      if (fullName !== session.name) {
        try {
          await fetch(`/api/sessions/${sessionId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: fullName })
          });
        } catch (err) {
          tabName.textContent = originalContent;
          this.showToast('Failed to rename', 'error');
        }
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
  },


  // ═══════════════════════════════════════════════════════════════
  // Case Settings
  // ═══════════════════════════════════════════════════════════════

  toggleCaseSettings() {
    const popover = document.getElementById('caseSettingsPopover');
    if (popover.classList.contains('hidden')) {
      // Load settings for current case
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeams').checked = settings.agentTeams;
      document.getElementById('caseOpusContext1m').checked = settings.opusContext1m;
      popover.classList.remove('hidden');

      // Close on outside click (one-shot listener)
      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      // Defer to avoid catching the current click
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  },

  getCaseSettings(caseName) {
    try {
      const stored = localStorage.getItem('caseSettings_' + caseName);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return { agentTeams: false, opusContext1m: true };
  },

  saveCaseSettings(caseName, settings) {
    localStorage.setItem('caseSettings_' + caseName, JSON.stringify(settings));
  },

  onCaseSettingChanged() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeams').checked;
    settings.opusContext1m = document.getElementById('caseOpusContext1m').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync mobile checkboxes
    const mobileCheckbox = document.getElementById('caseAgentTeamsMobile');
    if (mobileCheckbox) mobileCheckbox.checked = settings.agentTeams;
    const mobileOpusCheckbox = document.getElementById('caseOpusContext1mMobile');
    if (mobileOpusCheckbox) mobileOpusCheckbox.checked = settings.opusContext1m;
  },

  toggleCaseSettingsMobile() {
    const popover = document.getElementById('caseSettingsPopoverMobile');
    if (popover.classList.contains('hidden')) {
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeamsMobile').checked = settings.agentTeams;
      document.getElementById('caseOpusContext1mMobile').checked = settings.opusContext1m;
      popover.classList.remove('hidden');

      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings-mobile')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  },

  onCaseSettingChangedMobile() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeamsMobile').checked;
    settings.opusContext1m = document.getElementById('caseOpusContext1mMobile').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync desktop checkboxes
    const desktopCheckbox = document.getElementById('caseAgentTeams');
    if (desktopCheckbox) desktopCheckbox.checked = settings.agentTeams;
    const desktopOpusCheckbox = document.getElementById('caseOpusContext1m');
    if (desktopOpusCheckbox) desktopOpusCheckbox.checked = settings.opusContext1m;
  },

  // ═══════════════════════════════════════════════════════════════
  // Create Case Modal
  // ═══════════════════════════════════════════════════════════════

  showCreateCaseModal() {
    document.getElementById('newCaseName').value = '';
    document.getElementById('newCaseDescription').value = '';
    document.getElementById('linkCaseName').value = '';
    document.getElementById('linkCasePath').value = '';
    // Reset to first tab
    this.caseModalTab = 'case-create';
    this.switchCaseModalTab('case-create');
    // Wire up tab buttons
    const modal = document.getElementById('createCaseModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchCaseModalTab(btn.dataset.tab);
    });
    // Scroll-into-view on focus for mobile keyboard visibility
    modal.querySelectorAll('input[type="text"]').forEach(input => {
      if (!input._mobileScrollWired) {
        input._mobileScrollWired = true;
        input.addEventListener('focus', () => {
          if (window.innerWidth <= 430) {
            setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
          }
        });
      }
    });
    modal.classList.add('active');
    document.getElementById('newCaseName').focus();
  },

  switchCaseModalTab(tabName) {
    this.caseModalTab = tabName;
    const modal = document.getElementById('createCaseModal');
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
    // Update submit button (hide for manage tab)
    const submitBtn = document.getElementById('caseModalSubmit');
    if (tabName === 'case-manage') {
      submitBtn.style.display = 'none';
      this.renderCaseManageList();
    } else {
      submitBtn.style.display = '';
      submitBtn.textContent = tabName === 'case-create' ? 'Create' : 'Link';
    }
    // Focus appropriate input
    if (tabName === 'case-create') {
      document.getElementById('newCaseName').focus();
    } else if (tabName === 'case-link') {
      document.getElementById('linkCaseName').focus();
    }
  },

  closeCreateCaseModal() {
    document.getElementById('createCaseModal').classList.remove('active');
  },

  async submitCaseModal() {
    const btn = document.getElementById('caseModalSubmit');
    const originalText = btn.textContent;
    btn.classList.add('loading');
    btn.textContent = this.caseModalTab === 'case-create' ? 'Creating...' : 'Linking...';
    try {
      if (this.caseModalTab === 'case-create') {
        await this.createCase();
      } else {
        await this.linkCase();
      }
    } finally {
      btn.classList.remove('loading');
      btn.textContent = originalText;
    }
  },

  async createCase() {
    const name = document.getElementById('newCaseName').value.trim();
    const description = document.getElementById('newCaseDescription').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" created`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to create case', 'error');
      }
    } catch (err) {
      console.error('Failed to create case:', err);
      this.showToast('Failed to create case: ' + err.message, 'error');
    }
  },

  async linkCase() {
    const name = document.getElementById('linkCaseName').value.trim();
    const path = document.getElementById('linkCasePath').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    if (!path) {
      this.showToast('Please enter a folder path', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" linked to ${path}`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to link case', 'error');
      }
    } catch (err) {
      console.error('Failed to link case:', err);
      this.showToast('Failed to link case: ' + err.message, 'error');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Case Management (reorder + delete)
  // ═══════════════════════════════════════════════════════════════

  renderCaseManageList() {
    const container = document.getElementById('caseManageList');
    const cases = this.cases || [];
    if (cases.length === 0) {
      container.innerHTML = '<div class="form-hint" style="text-align: center; padding: 2rem 0;">No cases yet</div>';
      return;
    }

    let html = '';
    cases.forEach((c, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === cases.length - 1;
      const pathDisplay = c.path ? c.path.replace(/^\/Users\/[^/]+/, '~') : '';
      html += `
        <div class="case-manage-item" data-case="${escapeHtml(c.name)}">
          <div class="case-manage-info">
            <span class="case-manage-name">${escapeHtml(c.name)}</span>
            <span class="case-manage-path">${escapeHtml(pathDisplay)}</span>
          </div>
          <div class="case-manage-actions">
            <button class="case-manage-btn" onclick="app.moveCaseUp('${escapeHtml(c.name)}')"
                    title="Move up" ${isFirst ? 'disabled' : ''}>&#x25B2;</button>
            <button class="case-manage-btn" onclick="app.moveCaseDown('${escapeHtml(c.name)}')"
                    title="Move down" ${isLast ? 'disabled' : ''}>&#x25BC;</button>
            <button class="case-manage-btn case-manage-btn-delete" onclick="app.deleteCase('${escapeHtml(c.name)}')"
                    title="Delete case">&#x2715;</button>
          </div>
        </div>
      `;
    });
    container.innerHTML = html;
  },

  async moveCaseUp(name) {
    const cases = this.cases || [];
    const idx = cases.findIndex(c => c.name === name);
    if (idx <= 0) return;
    // Swap positions (immutable)
    const reordered = [...cases];
    [reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]];
    this.cases = reordered;
    this.renderCaseManageList();
    await this.saveCaseOrder(reordered.map(c => c.name));
  },

  async moveCaseDown(name) {
    const cases = this.cases || [];
    const idx = cases.findIndex(c => c.name === name);
    if (idx < 0 || idx >= cases.length - 1) return;
    const reordered = [...cases];
    [reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]];
    this.cases = reordered;
    this.renderCaseManageList();
    await this.saveCaseOrder(reordered.map(c => c.name));
  },

  async deleteCase(name) {
    if (!confirm(`Delete case "${name}"? Linked cases will only be unlinked (folder preserved). Created cases will be permanently deleted.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Case "${name}" ${data.data?.type === 'unlinked' ? 'unlinked' : 'deleted'}`, 'success');
        // Remove from current list and refresh
        this.cases = (this.cases || []).filter(c => c.name !== name);
        this.renderCaseManageList();
        // Refresh the dropdown
        const select = document.getElementById('quickStartCase');
        const currentCase = select.value;
        await this.loadQuickStartCases(currentCase === name ? null : currentCase);
      } else {
        this.showToast(data.error || 'Failed to delete case', 'error');
      }
    } catch (err) {
      this.showToast('Failed to delete case: ' + err.message, 'error');
    }
  },

  async saveCaseOrder(order) {
    try {
      await fetch('/api/cases/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order })
      });
      // Refresh dropdown to reflect new order
      const select = document.getElementById('quickStartCase');
      const currentCase = select.value;
      await this.loadQuickStartCases(currentCase);
    } catch (err) {
      this.showToast('Failed to save case order: ' + err.message, 'error');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Mobile Case Picker
  // ═══════════════════════════════════════════════════════════════

  showMobileCasePicker() {
    const modal = document.getElementById('mobileCasePickerModal');
    const listContainer = document.getElementById('mobileCaseList');
    const select = document.getElementById('quickStartCase');
    const currentCase = select.value;

    // Build case list HTML
    let html = '';
    const cases = this.cases || [];

    // Add testcase if not in list
    const hasTestcase = cases.some(c => c.name === 'testcase');
    const allCases = hasTestcase ? cases : [{ name: 'testcase' }, ...cases];

    for (const c of allCases) {
      const isSelected = c.name === currentCase;
      html += `
        <button class="mobile-case-item ${isSelected ? 'selected' : ''}"
                onclick="app.selectMobileCase('${escapeHtml(c.name)}')">
          <span class="mobile-case-item-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
          <span class="mobile-case-item-name">${escapeHtml(c.name)}</span>
          <span class="mobile-case-item-delete" onclick="event.stopPropagation(); app.deleteCaseMobile('${escapeHtml(c.name)}')" title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </span>
          <span class="mobile-case-item-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </span>
        </button>
      `;
    }

    listContainer.innerHTML = html;
    modal.classList.add('active');
  },

  closeMobileCasePicker() {
    document.getElementById('mobileCasePickerModal').classList.remove('active');
  },

  selectMobileCase(caseName) {
    // Update the desktop select (source of truth)
    const select = document.getElementById('quickStartCase');
    select.value = caseName;

    // Update mobile button label
    this.updateMobileCaseLabel(caseName);

    // Update directory display
    this.updateDirDisplayForCase(caseName);

    // Save as last used
    this.saveLastUsedCase(caseName);

    // Close the picker
    this.closeMobileCasePicker();

    this.showToast(`Selected: ${caseName}`, 'success');
  },

  updateMobileCaseLabel(caseName) {
    const label = document.getElementById('mobileCaseName');
    if (label) {
      // Let CSS handle truncation via text-overflow: ellipsis
      label.textContent = caseName;
    }
  },

  async deleteCaseMobile(name) {
    if (!confirm(`Delete case "${name}"?`)) return;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Case "${name}" ${data.data?.type === 'unlinked' ? 'unlinked' : 'deleted'}`, 'success');
        this.cases = (this.cases || []).filter(c => c.name !== name);
        // Refresh mobile picker and dropdown
        this.closeMobileCasePicker();
        await this.loadQuickStartCases();
      } else {
        this.showToast(data.error || 'Failed to delete case', 'error');
      }
    } catch (err) {
      this.showToast('Failed to delete case: ' + err.message, 'error');
    }
  },

  showCreateCaseFromMobile() {
    // Close mobile picker first
    this.closeMobileCasePicker();
    // Open the create case modal with slide-up animation
    this.showCreateCaseModal();
    const modal = document.getElementById('createCaseModal');
    modal.classList.add('from-mobile');
    // Remove animation class after it plays
    setTimeout(() => modal.classList.remove('from-mobile'), 300);
  },
});
