/**
 * @fileoverview Scheduled Jobs UI (cron-style scheduler) mixed into
 * CodemanApp.prototype. Renders the job list + create/edit form in the
 * #schedulerModal, and reacts to scheduler:* SSE events.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js, api-client.js, constants.js (escapeHtml)
 */

Object.assign(CodemanApp.prototype, {
  // ── SSE handlers ──────────────────────────────────────────────────────────

  _onSchedulerJobsChanged(data) {
    if (data && Array.isArray(data.jobs)) {
      this._schedulerJobs = data.jobs;
      if (this._isSchedulerOpen()) this.renderSchedulerJobs();
    } else if (this._isSchedulerOpen()) {
      this.refreshScheduler();
    }
  },

  _onSchedulerRunChanged() {
    // A run's status changed — refresh the list so lastStatus stays current.
    if (this._isSchedulerOpen()) this.refreshScheduler();
  },

  // ── Modal open/close ──────────────────────────────────────────────────────

  _isSchedulerOpen() {
    const el = document.getElementById('schedulerModal');
    return !!el && el.classList.contains('active');
  },

  openScheduler() {
    const el = document.getElementById('schedulerModal');
    if (!el) return;
    el.classList.add('active');
    this.cancelSchedulerJobForm();
    this.refreshScheduler();
  },

  closeScheduler() {
    const el = document.getElementById('schedulerModal');
    if (el) el.classList.remove('active');
  },

  async refreshScheduler() {
    const jobs = await this._apiJson('/api/scheduler/jobs');
    this._schedulerJobs = Array.isArray(jobs) ? jobs : [];
    this.renderSchedulerJobs();
  },

  // ── List rendering ────────────────────────────────────────────────────────

  renderSchedulerJobs() {
    const list = document.getElementById('schedulerJobList');
    if (!list) return;
    const jobs = this._schedulerJobs || [];
    if (jobs.length === 0) {
      list.innerHTML = '<div class="form-hint">No scheduled jobs yet. Click “+ New Job”.</div>';
      return;
    }
    const rows = jobs.map((j) => {
      const next = j.enabled ? this._fmtTime(j.nextRunAt) : '—';
      const last = this._fmtTime(j.lastRunAt);
      const status = j.lastStatus ? escapeHtml(j.lastStatus) : '—';
      return `
        <div class="scheduler-job-row">
          <div class="scheduler-job-main">
            <div class="scheduler-job-name">${escapeHtml(j.name || '(unnamed)')}
              <span class="scheduler-badge">${escapeHtml(j.agentType)}</span>
              <span class="scheduler-badge">${escapeHtml(this._fmtSchedule(j))}</span>
              ${j.enabled ? '' : '<span class="scheduler-badge scheduler-badge-off">disabled</span>'}
            </div>
            <div class="scheduler-job-meta">
              <span title="${escapeHtml(j.workingDir || '')}">${escapeHtml(j.workingDir || '')}</span>
              · next: ${escapeHtml(next)} · last: ${escapeHtml(last)} · status: ${status}
            </div>
          </div>
          <div class="scheduler-job-actions">
            <button class="btn-toolbar btn-sm btn-primary" onclick="app.runSchedulerJob('${j.id}')">Run Now</button>
            <button class="btn-toolbar btn-sm" onclick="app.toggleSchedulerJob('${j.id}', ${j.enabled ? 'false' : 'true'})">${j.enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn-toolbar btn-sm" onclick="app.editSchedulerJob('${j.id}')">Edit</button>
            <button class="btn-toolbar btn-sm btn-danger" onclick="app.deleteSchedulerJob('${j.id}')">Delete</button>
          </div>
        </div>`;
    });
    list.innerHTML = rows.join('');
  },

  _fmtTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return '—';
    }
  },

  _fmtSchedule(j) {
    switch (j.scheduleType) {
      case 'once':
        return 'once';
      case 'interval':
        return `every ${j.intervalMinutes}m`;
      case 'daily':
        return `daily ${j.dailyTime || ''}`;
      case 'weekly': {
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const days = (j.weeklyDays || []).map((d) => names[d] || d).join(',');
        return `weekly ${days} ${j.weeklyTime || ''}`;
      }
      default:
        return j.scheduleType || '';
    }
  },

  // ── Create / edit form ────────────────────────────────────────────────────

  openSchedulerJobForm(job) {
    const form = document.getElementById('schedulerJobForm');
    if (!form) return;
    document.getElementById('schedulerFormError').textContent = '';
    document.getElementById('schedulerFormTitle').textContent = job ? 'Edit Scheduled Job' : 'New Scheduled Job';
    document.getElementById('schJobId').value = job ? job.id : '';
    document.getElementById('schName').value = job ? job.name || '' : '';
    document.getElementById('schAgentType').value = job ? job.agentType || 'claude' : 'claude';
    document.getElementById('schWorkingDir').value = job ? job.workingDir || '' : '';
    document.getElementById('schPromptMode').value = job ? job.promptMode || 'inline_text' : 'inline_text';
    document.getElementById('schPromptText').value = job ? job.promptText || '' : '';
    document.getElementById('schPromptFilePath').value = job ? job.promptFilePath || '' : '';
    document.getElementById('schInputMode').value = job ? job.inputMode || 'typed' : 'typed';
    document.getElementById('schScheduleType').value = job ? job.scheduleType || 'once' : 'once';
    document.getElementById('schRunAt').value = job && job.runAt ? this._toLocalInput(job.runAt) : '';
    document.getElementById('schIntervalMinutes').value = job && job.intervalMinutes ? job.intervalMinutes : 60;
    document.getElementById('schDailyTime').value = job ? job.dailyTime || '' : '';
    document.getElementById('schWeeklyTime').value = job ? job.weeklyTime || '' : '';
    const weekly = (job && job.weeklyDays) || [];
    document.querySelectorAll('#schWeeklyDays input[type=checkbox]').forEach((cb) => {
      cb.checked = weekly.includes(Number(cb.value));
    });
    document.getElementById('schConcurrencyPolicy').value = job ? job.concurrencyPolicy || 'warn_only' : 'warn_only';
    document.getElementById('schEnabled').checked = job ? !!job.enabled : true;
    document.getElementById('schNotes').value = job ? job.notes || '' : '';

    this.onSchedulerPromptModeChange();
    this.onSchedulerScheduleTypeChange();
    form.classList.remove('hidden');
  },

  editSchedulerJob(id) {
    const job = (this._schedulerJobs || []).find((j) => j.id === id);
    if (job) this.openSchedulerJobForm(job);
  },

  cancelSchedulerJobForm() {
    const form = document.getElementById('schedulerJobForm');
    if (form) form.classList.add('hidden');
  },

  onSchedulerPromptModeChange() {
    const mode = document.getElementById('schPromptMode').value;
    document.getElementById('schPromptTextRow').classList.toggle('hidden', mode !== 'inline_text');
    document.getElementById('schPromptFileRow').classList.toggle('hidden', mode !== 'prompt_file_path');
  },

  onSchedulerScheduleTypeChange() {
    const t = document.getElementById('schScheduleType').value;
    document.getElementById('schRunAtRow').classList.toggle('hidden', t !== 'once');
    document.getElementById('schIntervalRow').classList.toggle('hidden', t !== 'interval');
    document.getElementById('schDailyRow').classList.toggle('hidden', t !== 'daily');
    document.getElementById('schWeeklyDaysRow').classList.toggle('hidden', t !== 'weekly');
    document.getElementById('schWeeklyTimeRow').classList.toggle('hidden', t !== 'weekly');
  },

  _toLocalInput(ts) {
    // epoch-ms → 'YYYY-MM-DDTHH:MM' in local time for <input datetime-local>.
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  _collectSchedulerForm() {
    const t = document.getElementById('schScheduleType').value;
    const promptMode = document.getElementById('schPromptMode').value;
    const body = {
      name: document.getElementById('schName').value.trim(),
      agentType: document.getElementById('schAgentType').value,
      workingDir: document.getElementById('schWorkingDir').value.trim(),
      promptMode,
      inputMode: document.getElementById('schInputMode').value,
      scheduleType: t,
      concurrencyPolicy: document.getElementById('schConcurrencyPolicy').value,
      enabled: document.getElementById('schEnabled').checked,
      notes: document.getElementById('schNotes').value.trim() || undefined,
    };
    if (promptMode === 'inline_text') body.promptText = document.getElementById('schPromptText').value;
    else body.promptFilePath = document.getElementById('schPromptFilePath').value.trim();

    if (t === 'once') {
      const v = document.getElementById('schRunAt').value;
      body.runAt = v ? new Date(v).getTime() : undefined;
    } else if (t === 'interval') {
      body.intervalMinutes = Number(document.getElementById('schIntervalMinutes').value);
    } else if (t === 'daily') {
      body.dailyTime = document.getElementById('schDailyTime').value;
    } else if (t === 'weekly') {
      body.weeklyTime = document.getElementById('schWeeklyTime').value;
      body.weeklyDays = Array.from(document.querySelectorAll('#schWeeklyDays input:checked')).map((cb) =>
        Number(cb.value)
      );
    }
    return body;
  },

  async saveSchedulerJob() {
    const errEl = document.getElementById('schedulerFormError');
    errEl.textContent = '';
    const body = this._collectSchedulerForm();
    if (!body.name) {
      errEl.textContent = 'Name is required.';
      return;
    }
    if (!body.workingDir) {
      errEl.textContent = 'Working directory is required.';
      return;
    }
    const id = document.getElementById('schJobId').value;
    const res = id
      ? await this._apiPut(`/api/scheduler/jobs/${id}`, body)
      : await this._apiPost('/api/scheduler/jobs', body);
    if (!res || !res.ok) {
      let msg = 'Failed to save job.';
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      errEl.textContent = msg;
      return;
    }
    this.showToast?.(id ? 'Scheduled job updated' : 'Scheduled job created', 'success');
    this.cancelSchedulerJobForm();
    this.refreshScheduler();
  },

  // ── Actions ───────────────────────────────────────────────────────────────

  async runSchedulerJob(id) {
    const job = (this._schedulerJobs || []).find((j) => j.id === id);
    if (job) {
      const active = this._countActiveAgents(job.agentType);
      if (active > 0 && !confirm(`${active} ${job.agentType} session(s) already active. Run this job anyway?`)) {
        return;
      }
    }
    const res = await this._apiPost(`/api/scheduler/jobs/${id}/run`, {});
    if (res && res.ok) {
      this.showToast?.('Run started — opening session', 'success');
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* ignore */
      }
      const run = data && (data.data ? data.data.run : data.run);
      if (run && run.sessionId) this._focusScheduledSession(run.sessionId);
      this.refreshScheduler();
    } else {
      this.showToast?.('Failed to run job', 'error');
    }
  },

  _focusScheduledSession(sessionId) {
    // Best-effort: switch to the created session tab if it exists.
    if (this.sessions && this.sessions.has(sessionId) && typeof this.switchSession === 'function') {
      this.closeScheduler();
      this.switchSession(sessionId);
    }
  },

  _countActiveAgents(agentType) {
    if (!this.sessions) return 0;
    let n = 0;
    for (const s of this.sessions.values()) if (s && s.mode === agentType) n++;
    return n;
  },

  async toggleSchedulerJob(id, enabled) {
    const res = await this._apiPut(`/api/scheduler/jobs/${id}/enabled`, { enabled });
    if (res && res.ok) this.refreshScheduler();
    else this.showToast?.('Failed to update job', 'error');
  },

  async deleteSchedulerJob(id) {
    if (!confirm('Delete this scheduled job and its run history?')) return;
    const res = await this._apiDelete(`/api/scheduler/jobs/${id}`);
    if (res && res.ok) {
      this.showToast?.('Scheduled job deleted', 'success');
      this.refreshScheduler();
    } else {
      this.showToast?.('Failed to delete job', 'error');
    }
  },
});
