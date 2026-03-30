/**
 * @fileoverview Subagent panel (discovery, detail view, kill), subagent parent tracking,
 * agent teams (tasks panel, teammate badges, terminals), project insights (bash tool tracking),
 * file browser (directory tree, preview), log viewer (floating file streamers),
 * image popups (auto-popup for screenshots), mux sessions, monitor panel,
 * token statistics, toast notifications, and system stats.
 * Includes 19 SSE handlers for tasks, mux, bash tools, subagents, and images.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.subagents, this.subagentWindows, this.sessions)
 * @dependency constants.js (escapeHtml, ZINDEX_* constants)
 * @dependency subagent-windows.js (openSubagentWindow, closeSubagentWindow)
 * @loadorder 11 of 15 — loaded after settings-ui.js, before session-ui.js
 */

Object.assign(CodemanApp.prototype, {
  _addActivityEntry(agentId, entry, maxSize = 50) {
    const activity = this.subagentActivity.get(agentId) || [];
    activity.push(entry);
    if (activity.length > maxSize) activity.shift();
    this.subagentActivity.set(agentId, activity);
  },

  // Tasks
  _onTaskCreated(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskCompleted(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskFailed(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskUpdated(data) {
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  // Mux (tmux)
  _onMuxCreated(data) {
    this.muxSessions.push(data);
    this.renderMuxSessions();
  },

  _onMuxKilled(data) {
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
    this.renderMuxSessions();
  },

  _onMuxDied(data) {
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
    this.renderMuxSessions();
    this.showToast('Mux session died: ' + this.getShortId(data.sessionId), 'warning');
  },

  _onMuxStatsUpdated(data) {
    this.muxSessions = data;
    if (document.getElementById('monitorPanel').classList.contains('open')) {
      this.renderMuxSessions();
    }
  },


  // Bash tools
  _onBashToolStart(data) {
    this.handleBashToolStart(data.sessionId, data.tool);
  },

  _onBashToolEnd(data) {
    this.handleBashToolEnd(data.sessionId, data.tool);
  },

  _onBashToolsUpdate(data) {
    this.handleBashToolsUpdate(data.sessionId, data.tools);
  },


  // Subagents (Claude Code background agents)
  _onSubagentDiscovered(data) {
    // Clear all old data for this agentId (in case of ID reuse)
    this.subagents.set(data.agentId, data);
    this.subagentActivity.set(data.agentId, []);
    this.subagentToolResults.delete(data.agentId);
    // Close any existing window for this agentId (will be reopened fresh)
    if (this.subagentWindows.has(data.agentId)) {
      this.forceCloseSubagentWindow(data.agentId);
    }
    this.renderSubagentPanel();

    // Find which Codeman session owns this subagent (direct claudeSessionId match only)
    this.findParentSessionForSubagent(data.agentId);

    // Subagent windows are no longer auto-opened on discovery.
    // Users can open them manually from the monitor panel or via openAllActiveSubagentWindows().

    // Ensure connection lines are updated after window is created and DOM settles
    requestAnimationFrame(() => {
      this.updateConnectionLines();
    });

    // Notify about new subagent discovery
    const parentId = this.subagentParentMap.get(data.agentId);
    this._notifySession(parentId || data.sessionId, 'info', 'subagent-spawn', 'Subagent Spawned', data.description || 'New background agent started');
  },

  _onSubagentUpdated(data) {
    const existing = this.subagents.get(data.agentId);
    if (existing) {
      // Merge updated fields (especially description)
      Object.assign(existing, data);
      this.subagents.set(data.agentId, existing);
    } else {
      this.subagents.set(data.agentId, data);
    }
    this.renderSubagentPanel();
    // Update floating window if open (content + header/title)
    if (this.subagentWindows.has(data.agentId)) {
      this.renderSubagentWindowContent(data.agentId);
      this.updateSubagentWindowHeader(data.agentId);
    }
  },

  _onSubagentToolCall(data) {
    this._addActivityEntry(data.agentId, { type: 'tool', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    this.renderSubagentPanel();
    // Update floating window (debounced — tool_call events fire rapidly)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentProgress(data) {
    this._addActivityEntry(data.agentId, { type: 'progress', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentMessage(data) {
    this._addActivityEntry(data.agentId, { type: 'message', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentToolResult(data) {
    // Store tool result by toolUseId for later lookup (cap at 50 per agent)
    if (!this.subagentToolResults.has(data.agentId)) {
      this.subagentToolResults.set(data.agentId, new Map());
    }
    const resultsMap = this.subagentToolResults.get(data.agentId);
    resultsMap.set(data.toolUseId, data);
    if (resultsMap.size > 50) {
      const oldest = resultsMap.keys().next().value;
      resultsMap.delete(oldest);
    }

    // Add to activity stream
    this._addActivityEntry(data.agentId, { type: 'tool_result', ...data });

    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  async _onSubagentCompleted(data) {
    const existing = this.subagents.get(data.agentId);
    if (existing) {
      existing.status = 'completed';
      this.subagents.set(data.agentId, existing);
    }
    this.renderSubagentPanel();
    this.updateSubagentWindows();

    // Auto-minimize completed subagent windows
    if (this.subagentWindows.has(data.agentId)) {
      const windowData = this.subagentWindows.get(data.agentId);
      if (windowData && !windowData.minimized) {
        await this.closeSubagentWindow(data.agentId); // This minimizes to tab
        this.saveSubagentWindowStates(); // Persist the minimized state
      }
    }

    // Notify about subagent completion
    const parentId = this.subagentParentMap.get(data.agentId);
    this._notifySession(parentId || existing?.sessionId || data.sessionId, 'info', 'subagent-complete', 'Subagent Completed', existing?.description || data.description || 'Background agent finished');

    // Clean up activity/tool data for completed agents after 5 minutes
    // This prevents memory leaks from long-running sessions with many subagents
    setTimeout(() => {
      const agent = this.subagents.get(data.agentId);
      // Only clean up if agent is still completed (not restarted)
      if (agent?.status === 'completed') {
        this.subagentActivity.delete(data.agentId);
        this.subagentToolResults.delete(data.agentId);
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Prune stale completed agents from main maps after 30 minutes
    // Keeps subagents/subagentParentMap from growing unbounded in 24h sessions
    setTimeout(() => {
      const agent = this.subagents.get(data.agentId);
      if (agent?.status === 'completed' && !this.subagentWindows.has(data.agentId)) {
        this.subagents.delete(data.agentId);
        this.subagentParentMap.delete(data.agentId);
      }
    }, 30 * 60 * 1000); // 30 minutes
  },

  // Images
  _onImageDetected(data) {
    console.log('[Image Detected]', data);
    this.openImagePopup(data);
  },


  // ═══════════════════════════════════════════════════════════════
  // Token Statistics Modal
  // ═══════════════════════════════════════════════════════════════

  async openTokenStats() {
    try {
      const response = await fetch('/api/token-stats');
      const data = await response.json();
      if (data.success) {
        this.renderTokenStats(data);
        document.getElementById('tokenStatsModal').classList.add('active');
      } else {
        this.showToast('Failed to load token stats', 'error');
      }
    } catch (err) {
      console.error('Failed to fetch token stats:', err);
      this.showToast('Failed to load token stats', 'error');
    }
  },

  renderTokenStats(data) {
    const { daily, totals } = data;

    // Calculate period totals
    const today = new Date().toISOString().split('T')[0];
    const todayData = daily.find(d => d.date === today) || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

    // Last 7 days totals (for summary card)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const last7Days = daily.filter(d => new Date(d.date) >= sevenDaysAgo);
    const weekInput = last7Days.reduce((sum, d) => sum + d.inputTokens, 0);
    const weekOutput = last7Days.reduce((sum, d) => sum + d.outputTokens, 0);
    const weekCost = this.estimateCost(weekInput, weekOutput);

    // Lifetime totals (from aggregate stats)
    const lifetimeInput = totals.totalInputTokens;
    const lifetimeOutput = totals.totalOutputTokens;
    const lifetimeCost = this.estimateCost(lifetimeInput, lifetimeOutput);

    // Render summary cards
    const summaryEl = document.getElementById('statsSummary');
    summaryEl.innerHTML = `
      <div class="stat-card">
        <span class="stat-card-label">Today</span>
        <span class="stat-card-value">${this.formatTokens(todayData.inputTokens + todayData.outputTokens)}</span>
        <span class="stat-card-cost">~$${todayData.estimatedCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">7 Days</span>
        <span class="stat-card-value">${this.formatTokens(weekInput + weekOutput)}</span>
        <span class="stat-card-cost">~$${weekCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">Lifetime</span>
        <span class="stat-card-value">${this.formatTokens(lifetimeInput + lifetimeOutput)}</span>
        <span class="stat-card-cost">~$${lifetimeCost.toFixed(2)}</span>
      </div>
    `;

    // Render bar chart (last 7 days)
    const chartEl = document.getElementById('statsChart');
    const daysEl = document.getElementById('statsChartDays');

    // Get last 7 days (fill gaps with empty data)
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayData = daily.find(d => d.date === dateStr);
      chartData.push({
        date: dateStr,
        dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
        tokens: dayData ? dayData.inputTokens + dayData.outputTokens : 0,
        cost: dayData ? dayData.estimatedCost : 0,
      });
    }

    // Find max for scaling
    const maxTokens = Math.max(...chartData.map(d => d.tokens), 1);

    chartEl.innerHTML = chartData.map(d => {
      const height = Math.max((d.tokens / maxTokens) * 100, 3);
      const tooltip = `${d.dayName}: ${this.formatTokens(d.tokens)} (~$${d.cost.toFixed(2)})`;
      return `<div class="bar" style="height: ${height}%" data-tooltip="${tooltip}"></div>`;
    }).join('');

    daysEl.innerHTML = chartData.map(d => `<span>${d.dayName}</span>`).join('');

    // Render table (last 14 days with data)
    const tableEl = document.getElementById('statsTable');
    const tableData = daily.slice(0, 14);

    if (tableData.length === 0) {
      tableEl.innerHTML = '<div class="stats-no-data">No usage data recorded yet</div>';
    } else {
      tableEl.innerHTML = `
        <div class="stats-table-header">
          <span>Date</span>
          <span>Input</span>
          <span>Output</span>
          <span>Cost</span>
        </div>
        ${tableData.map(d => {
          const dateObj = new Date(d.date + 'T00:00:00');
          const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return `
            <div class="stats-table-row">
              <span class="cell cell-date">${dateStr}</span>
              <span class="cell">${this.formatTokens(d.inputTokens)}</span>
              <span class="cell">${this.formatTokens(d.outputTokens)}</span>
              <span class="cell cell-cost">$${d.estimatedCost.toFixed(2)}</span>
            </div>
          `;
        }).join('')}
      `;
    }
  },

  closeTokenStats() {
    const modal = document.getElementById('tokenStatsModal');
    if (modal) {
      modal.classList.remove('active');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Monitor Panel (combined Mux Sessions + Background Tasks)
  // ═══════════════════════════════════════════════════════════════

  async toggleMonitorPanel() {
    const panel = document.getElementById('monitorPanel');
    const toggleBtn = document.getElementById('monitorToggleBtn');
    panel.classList.toggle('open');

    if (panel.classList.contains('open')) {
      // Load screens and start stats collection
      await this.loadMuxSessions();
      await fetch('/api/mux-sessions/stats/start', { method: 'POST' });
      this.renderTaskPanel();
      if (toggleBtn) toggleBtn.innerHTML = '&#x25BC;'; // Down arrow when open
    } else {
      // Stop stats collection when panel is closed
      await fetch('/api/mux-sessions/stats/stop', { method: 'POST' });
      if (toggleBtn) toggleBtn.innerHTML = '&#x25B2;'; // Up arrow when closed
    }
  },

  // Legacy alias for task panel toggle (used by session tab badge)
  toggleTaskPanel() {
    this.toggleMonitorPanel();
  },

  // ═══════════════════════════════════════════════════════════════
  // Monitor Panel Detach & Drag
  // ═══════════════════════════════════════════════════════════════

  toggleMonitorDetach() {
    const panel = document.getElementById('monitorPanel');
    const detachBtn = document.getElementById('monitorDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupMonitorDrag();
    }
  },

  setupMonitorDrag() {
    const panel = document.getElementById('monitorPanel');
    const header = document.getElementById('monitorPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  },

  // ═══════════════════════════════════════════════════════════════
  // Subagents Panel Detach & Drag
  // ═══════════════════════════════════════════════════════════════

  toggleSubagentsDetach() {
    const panel = document.getElementById('subagentsPanel');
    const detachBtn = document.getElementById('subagentsDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupSubagentsDrag();
    }
  },

  setupSubagentsDrag() {
    const panel = document.getElementById('subagentsPanel');
    const header = document.getElementById('subagentsPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  },

  renderTaskPanel() {
    this._debouncedCall('taskPanel', this._renderTaskPanelImmediate);
  },

  _renderTaskPanelImmediate() {
    const session = this.sessions.get(this.activeSessionId);
    const body = document.getElementById('backgroundTasksBody');
    const stats = document.getElementById('taskPanelStats');
    const section = document.getElementById('backgroundTasksSection');

    if (!session || !session.taskTree || session.taskTree.length === 0) {
      // Hide the entire section when there are no background tasks
      if (section) section.style.display = 'none';
      body.innerHTML = '';
      stats.textContent = '0 tasks';
      return;
    }

    // Show the section when there are tasks
    if (section) section.style.display = '';

    const taskStats = session.taskStats || { running: 0, completed: 0, failed: 0, total: 0 };
    stats.textContent = `${taskStats.running} running, ${taskStats.completed} done`;

    // Render task tree recursively
    const renderTask = (task, allTasks) => {
      const statusIcon = task.status === 'running' ? '' :
                        task.status === 'completed' ? '&#x2713;' : '&#x2717;';
      const duration = task.endTime
        ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
        : `${((Date.now() - task.startTime) / 1000).toFixed(0)}s...`;

      let childrenHtml = '';
      if (task.children && task.children.length > 0) {
        childrenHtml = '<div class="task-children">';
        for (const childId of task.children) {
          // Find child task in allTasks map
          const childTask = allTasks.find(t => t.id === childId);
          if (childTask) {
            childrenHtml += `<div class="task-node">${renderTask(childTask, allTasks)}</div>`;
          }
        }
        childrenHtml += '</div>';
      }

      return `
        <div class="task-item">
          <span class="task-status-icon ${task.status}">${statusIcon}</span>
          <div class="task-info">
            <div class="task-description">${escapeHtml(task.description)}</div>
            <div class="task-meta">
              <span class="task-type">${task.subagentType}</span>
              <span>${duration}</span>
            </div>
          </div>
        </div>
        ${childrenHtml}
      `;
    };

    // Flatten all tasks for lookup
    const allTasks = this.flattenTaskTree(session.taskTree);

    // Render only root tasks (those without parents or with null parentId)
    let html = '<div class="task-tree">';
    for (const task of session.taskTree) {
      html += `<div class="task-node">${renderTask(task, allTasks)}</div>`;
    }
    html += '</div>';

    body.innerHTML = html;
  },

  flattenTaskTree(tasks, result = []) {
    for (const task of tasks) {
      result.push(task);
      // Children are stored as IDs, not nested objects in taskTree
      // The task tree from server already has the structure we need
    }
    return result;
  },


  // ═══════════════════════════════════════════════════════════════
  // Subagent Panel (Claude Code Background Agents)
  // ═══════════════════════════════════════════════════════════════

  // Legacy alias
  toggleSubagentPanel() {
    this.toggleSubagentsPanel();
  },

  updateSubagentBadge() {
    const badge = this.$('subagentCountBadge');
    const activeCount = Array.from(this.subagents.values()).filter(s => s.status === 'active' || s.status === 'idle').length;

    // Update badge with active count
    if (badge) {
      badge.textContent = activeCount > 0 ? activeCount : '';
    }
  },

  renderSubagentPanel() {
    // Debounce renders at 150ms to prevent excessive DOM updates from rapid subagent events
    if (this._subagentPanelRenderTimeout) {
      clearTimeout(this._subagentPanelRenderTimeout);
    }
    this._subagentPanelRenderTimeout = setTimeout(() => {
      scheduleBackground(() => this._renderSubagentPanelImmediate());
    }, 150);
  },

  _renderSubagentPanelImmediate() {
    const list = this.$('subagentList');
    if (!list) return;

    // Always update badge count
    this.updateSubagentBadge();

    // Always update monitor panel (even if subagent panel is hidden)
    this.renderMonitorSubagents();

    // If panel is not visible, don't render content
    if (!this.subagentPanelVisible) {
      return;
    }

    // Render subagent list
    if (this.subagents.size === 0) {
      list.innerHTML = '<div class="subagent-empty">No background agents detected</div>';
      return;
    }

    const html = [];
    const sorted = Array.from(this.subagents.values()).sort((a, b) => {
      // Active first, then by last activity
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });

    for (const agent of sorted) {
      const isActive = this.activeSubagentId === agent.agentId;
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const activity = this.subagentActivity.get(agent.agentId) || [];
      const lastActivity = activity[activity.length - 1];
      const lastTool = lastActivity?.type === 'tool' ? lastActivity.tool : null;
      const hasWindow = this.subagentWindows.has(agent.agentId);
      const canKill = agent.status === 'active' || agent.status === 'idle';
      const modelBadge = agent.modelShort
        ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
        : '';

      const teammateInfo = this.getTeammateInfo(agent);
      const displayName = teammateInfo ? teammateInfo.name : (agent.description || agent.agentId.substring(0, 7));
      const teammateBadge = this.getTeammateBadgeHtml(agent);
      const agentIcon = teammateInfo ? `<span class="subagent-icon teammate-dot teammate-color-${teammateInfo.color}">●</span>` : '<span class="subagent-icon">🤖</span>';
      html.push(`
        <div class="subagent-item ${statusClass} ${isActive ? 'selected' : ''}${teammateInfo ? ' is-teammate' : ''}"
             onclick="app.selectSubagent('${escapeHtml(agent.agentId)}')"
             ondblclick="app.openSubagentWindow('${escapeHtml(agent.agentId)}')"
             title="Double-click to open tracking window">
          <div class="subagent-header">
            ${agentIcon}
            <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(displayName.length > 40 ? displayName.substring(0, 40) + '...' : displayName)}</span>
            ${teammateBadge}
            ${modelBadge}
            <span class="subagent-status ${statusClass}">${agent.status}</span>
            ${canKill ? `<button class="subagent-kill-btn" onclick="event.stopPropagation(); app.killSubagent('${escapeHtml(agent.agentId)}')" title="Kill agent">&#x2715;</button>` : ''}
            <button class="subagent-window-btn" onclick="event.stopPropagation(); app.${hasWindow ? 'closeSubagentWindow' : 'openSubagentWindow'}('${escapeHtml(agent.agentId)}')" title="${hasWindow ? 'Close window' : 'Open in window'}">
              ${hasWindow ? '✕' : '⧉'}
            </button>
          </div>
          <div class="subagent-meta">
            <span class="subagent-tools">${agent.toolCallCount} tools</span>
            ${lastTool ? `<span class="subagent-last-tool">${this.getToolIcon(lastTool)} ${lastTool}</span>` : ''}
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  },

  selectSubagent(agentId) {
    this.activeSubagentId = agentId;
    this.renderSubagentPanel();
    this.renderSubagentDetail();
  },

  renderSubagentDetail() {
    const detail = this.$('subagentDetail');
    if (!detail) return;

    if (!this.activeSubagentId) {
      detail.innerHTML = '<div class="subagent-empty">Select an agent to view details</div>';
      return;
    }

    const agent = this.subagents.get(this.activeSubagentId);
    const activity = this.subagentActivity.get(this.activeSubagentId) || [];

    if (!agent) {
      detail.innerHTML = '<div class="subagent-empty">Agent not found</div>';
      return;
    }

    const activityHtml = activity.slice(-30).map(a => {
      const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
      if (a.type === 'tool') {
        const toolDetail = this.getToolDetailExpanded(a.tool, a.input, a.fullInput, a.toolUseId);
        return `<div class="subagent-activity tool" data-tool-use-id="${a.toolUseId || ''}">
          <span class="time">${time}</span>
          <span class="icon">${this.getToolIcon(a.tool)}</span>
          <span class="name">${a.tool}</span>
          <span class="detail">${toolDetail.primary}</span>
          ${toolDetail.hasMore ? `<button class="tool-expand-btn" onclick="app.toggleToolParams('${escapeHtml(a.toolUseId)}')">▶</button>` : ''}
          ${toolDetail.hasMore ? `<div class="tool-params-expanded" id="tool-params-${a.toolUseId}" style="display:none;"><pre>${escapeHtml(JSON.stringify(a.fullInput || a.input, null, 2))}</pre></div>` : ''}
        </div>`;
      } else if (a.type === 'tool_result') {
        const icon = a.isError ? '❌' : '📄';
        const statusClass = a.isError ? 'error' : '';
        const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
        const preview = a.preview.length > 80 ? a.preview.substring(0, 80) + '...' : a.preview;
        return `<div class="subagent-activity tool-result ${statusClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="name">${a.tool || 'result'}</span>
          <span class="detail">${escapeHtml(preview)}${sizeInfo}</span>
        </div>`;
      } else if (a.type === 'progress') {
        // Check for hook events
        const isHook = a.hookEvent || a.hookName;
        const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
        const hookClass = isHook ? ' hook' : '';
        const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
        return `<div class="subagent-activity progress${hookClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="detail">${displayText}</span>
        </div>`;
      } else if (a.type === 'message') {
        const preview = a.text.length > 100 ? a.text.substring(0, 100) + '...' : a.text;
        return `<div class="subagent-activity message">
          <span class="time">${time}</span>
          <span class="icon">💬</span>
          <span class="detail">${escapeHtml(preview)}</span>
        </div>`;
      }
      return '';
    }).join('');

    const detailTitle = agent.description || `Agent ${agent.agentId}`;
    const modelBadge = agent.modelShort
      ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
      : '';
    const tokenStats = (agent.totalInputTokens || agent.totalOutputTokens)
      ? `<span>Tokens: ${this.formatTokenCount(agent.totalInputTokens || 0)}↓ ${this.formatTokenCount(agent.totalOutputTokens || 0)}↑</span>`
      : '';

    detail.innerHTML = `
      <div class="subagent-detail-header">
        <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(detailTitle.length > 60 ? detailTitle.substring(0, 60) + '...' : detailTitle)}</span>
        ${modelBadge}
        <span class="subagent-status ${agent.status}">${agent.status}</span>
        <button class="subagent-transcript-btn" onclick="app.viewSubagentTranscript('${escapeHtml(agent.agentId)}')">
          View Full Transcript
        </button>
      </div>
      <div class="subagent-detail-stats">
        <span>Tools: ${agent.toolCallCount}</span>
        <span>Entries: ${agent.entryCount}</span>
        <span>Size: ${(agent.fileSize / 1024).toFixed(1)}KB</span>
        ${tokenStats}
      </div>
      <div class="subagent-activity-log">
        ${activityHtml || '<div class="subagent-empty">No activity yet</div>'}
      </div>
    `;
  },

  toggleToolParams(toolUseId) {
    const el = document.getElementById(`tool-params-${toolUseId}`);
    if (!el) return;
    const btn = el.previousElementSibling;
    if (el.style.display === 'none') {
      el.style.display = 'block';
      if (btn) btn.textContent = '▼';
    } else {
      el.style.display = 'none';
      if (btn) btn.textContent = '▶';
    }
  },

  formatTokenCount(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
  },

  formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return bytes + 'B';
  },

  getToolIcon(tool) {
    const icons = {
      WebSearch: '🔍',
      WebFetch: '🌐',
      Read: '📖',
      Write: '📝',
      Edit: '✏️',
      Bash: '💻',
      Glob: '📁',
      Grep: '🔎',
      Task: '🤖',
    };
    return icons[tool] || '🔧';
  },

  getToolDetail(tool, input) {
    if (!input) return '';
    if (tool === 'WebSearch' && input.query) return `"${input.query}"`;
    if (tool === 'WebFetch' && input.url) return input.url;
    if (tool === 'Read' && input.file_path) return input.file_path;
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) return input.file_path;
    if (tool === 'Bash' && input.command) {
      const cmd = input.command;
      return cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
    }
    if (tool === 'Glob' && input.pattern) return input.pattern;
    if (tool === 'Grep' && input.pattern) return input.pattern;
    return '';
  },

  getToolDetailExpanded(tool, input, fullInput, toolUseId) {
    const primary = this.getToolDetail(tool, input);
    // Check if there are additional params beyond the primary one
    const primaryKeys = ['query', 'url', 'file_path', 'command', 'pattern'];
    const inputKeys = Object.keys(fullInput || input || {});
    const extraKeys = inputKeys.filter(k => !primaryKeys.includes(k));
    const hasMore = extraKeys.length > 0 || (fullInput && JSON.stringify(fullInput).length > 100);
    return { primary, hasMore, fullInput: fullInput || input };
  },

  async killSubagent(agentId) {
    try {
      const res = await this._apiDelete(`/api/subagents/${agentId}`);
      const data = await res?.json();
      if (data?.success) {
        // Update local state
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.status = 'completed';
          this.subagents.set(agentId, agent);
        }
        this.renderSubagentPanel();
        this.renderSubagentDetail();
        this.updateSubagentWindows();
        this.showToast(`Subagent ${agentId.substring(0, 7)} killed`, 'success');
      } else {
        this.showToast(data.error || 'Failed to kill subagent', 'error');
      }
    } catch (err) {
      console.error('Failed to kill subagent:', err);
      this.showToast('Failed to kill subagent: ' + err.message, 'error');
    }
  },

  async viewSubagentTranscript(agentId) {
    try {
      const res = await fetch(`/api/subagents/${agentId}/transcript?format=formatted`);
      const data = await res.json();

      if (!data.success) {
        alert('Failed to load transcript');
        return;
      }

      // Show in a modal or new window
      const content = data.data.formatted.join('\n');
      const win = window.open('', '_blank', 'width=800,height=600');
      win.document.write(`
        <html>
          <head>
            <title>Subagent ${escapeHtml(agentId)} Transcript</title>
            <style>
              body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 20px; }
              pre { white-space: pre-wrap; word-wrap: break-word; }
            </style>
          </head>
          <body>
            <h2>Subagent ${escapeHtml(agentId)} Transcript (${data.data.entryCount} entries)</h2>
            <pre>${escapeHtml(content)}</pre>
          </body>
        </html>
      `);
    } catch (err) {
      console.error('Failed to load transcript:', err);
      alert('Failed to load transcript: ' + err.message);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Subagent Parent TAB Tracking
  // ═══════════════════════════════════════════════════════════════
  //
  // CRITICAL: This system tracks which TAB an agent window connects to.
  // The association is stored in `subagentParentMap` (agentId -> sessionId).
  // The sessionId IS the tab identifier (tabs have data-id="${sessionId}").
  // Once set, this association is PERMANENT and persisted across restarts.

  /**
   * Find and assign the parent TAB for a subagent.
   *
   * Matching strategy (in order):
   * 1. Use existing stored association from subagentParentMap (permanent)
   * 2. Match via claudeSessionId (agent.sessionId === session.claudeSessionId)
   * 3. FALLBACK: Use the currently active session (since that's where the user typed the command)
   *
   * Once found, the association is stored PERMANENTLY in subagentParentMap.
   */
  findParentSessionForSubagent(agentId) {
    // Check if we already have a permanent association
    if (this.subagentParentMap.has(agentId)) {
      // Already have a parent - update agent object from stored value
      const storedSessionId = this.subagentParentMap.get(agentId);
      // Verify the session still exists
      if (this.sessions.has(storedSessionId)) {
        const agent = this.subagents.get(agentId);
        if (agent && !agent.parentSessionId) {
          agent.parentSessionId = storedSessionId;
          const session = this.sessions.get(storedSessionId);
          if (session) {
            agent.parentSessionName = this.getSessionName(session);
          }
          this.subagents.set(agentId, agent);
          this.updateSubagentWindowParent(agentId);
        }
        return;
      }
      // Stored session no longer exists - clear and re-discover
      this.subagentParentMap.delete(agentId);
    }

    const agent = this.subagents.get(agentId);
    if (!agent) return;

    // Strategy 1: Match via claudeSessionId (most accurate)
    if (agent.sessionId) {
      for (const [sessionId, session] of this.sessions) {
        if (session.claudeSessionId === agent.sessionId) {
          // FOUND! Store this association PERMANENTLY
          this.setAgentParentSessionId(agentId, sessionId);
          this.updateSubagentWindowParent(agentId);
          this.updateSubagentWindowVisibility();
          this.updateConnectionLines();
          return;
        }
      }
    }

    // Strategy 2: FALLBACK - Use the currently active session
    // This works because agents spawn from where the user typed the command
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      this.setAgentParentSessionId(agentId, this.activeSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
      return;
    }

    // Strategy 3: If no active session, use the first session
    if (this.sessions.size > 0) {
      const firstSessionId = this.sessions.keys().next().value;
      this.setAgentParentSessionId(agentId, firstSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
    }
  },

  /**
   * Re-check all orphan subagents (those without a parent TAB) when a session updates.
   * Called when session:updated fires with claudeSessionId.
   *
   * Also re-validates existing associations when claudeSessionId becomes available,
   * in case the fallback association was wrong.
   */
  recheckOrphanSubagents() {
    let anyChanged = false;
    for (const [agentId, agent] of this.subagents) {
      // Check if this agent has no parent in the persistent map
      if (!this.subagentParentMap.has(agentId)) {
        this.findParentSessionForSubagent(agentId);
        if (this.subagentParentMap.has(agentId)) {
          anyChanged = true;
        }
      } else if (agent.sessionId) {
        // Agent has a stored parent, but check if we can now do a proper claudeSessionId match
        // This handles the case where fallback was used but now the real parent is known
        const storedParent = this.subagentParentMap.get(agentId);
        const storedSession = this.sessions.get(storedParent);

        // If the stored session doesn't have a matching claudeSessionId, try to find the real match
        if (storedSession && storedSession.claudeSessionId !== agent.sessionId) {
          for (const [sessionId, session] of this.sessions) {
            if (session.claudeSessionId === agent.sessionId) {
              // Found the real parent - update the association
              this.subagentParentMap.set(agentId, sessionId);
              agent.parentSessionId = sessionId;
              agent.parentSessionName = this.getSessionName(session);
              this.subagents.set(agentId, agent);
              this.updateSubagentWindowParent(agentId);
              anyChanged = true;
              break;
            }
          }
        }
      }
    }
    if (anyChanged) {
      this.saveSubagentParentMap();
      this.updateConnectionLines();
    }
  },

  /**
   * Update parentSessionName for all subagents belonging to a TAB.
   * Called when a session is renamed to keep cached names fresh.
   */
  updateSubagentParentNames(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const newName = this.getSessionName(session);

    // Skip iteration if name hasn't changed (avoids O(n) loop on every session:updated)
    const cachedName = this._parentNameCache?.get(sessionId);
    if (cachedName === newName) return;
    if (!this._parentNameCache) this._parentNameCache = new Map();
    this._parentNameCache.set(sessionId, newName);

    for (const [agentId, storedSessionId] of this.subagentParentMap) {
      if (storedSessionId === sessionId) {
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.parentSessionName = newName;
          this.subagents.set(agentId, agent);

          // Update the window header if open
          const windowData = this.subagentWindows.get(agentId);
          if (windowData) {
            const parentNameEl = windowData.element.querySelector('.subagent-window-parent .parent-name');
            if (parentNameEl) {
              parentNameEl.textContent = newName;
            }
          }
        }
      }
    }
  },

  /**
   * Add parent header to an agent window, showing which TAB it belongs to.
   */
  updateSubagentWindowParent(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (!windowData) return;

    // Get parent from persistent map (THE source of truth)
    const parentSessionId = this.subagentParentMap.get(agentId);
    if (!parentSessionId) return;

    const session = this.sessions.get(parentSessionId);
    const parentName = session ? this.getSessionName(session) : 'Unknown';

    // Check if parent header already exists
    const win = windowData.element;
    const existingParent = win.querySelector('.subagent-window-parent');
    if (existingParent) {
      // Update existing
      existingParent.dataset.parentSession = parentSessionId;
      const nameEl = existingParent.querySelector('.parent-name');
      if (nameEl) {
        nameEl.textContent = parentName;
        nameEl.onclick = () => this.selectSession(parentSessionId);
      }
      return;
    }

    // Insert new parent header after the main header
    const header = win.querySelector('.subagent-window-header');
    if (header) {
      const parentDiv = document.createElement('div');
      parentDiv.className = 'subagent-window-parent';
      parentDiv.dataset.parentSession = parentSessionId;
      parentDiv.innerHTML = `
        <span class="parent-label">from</span>
        <span class="parent-name" onclick="app.selectSession('${escapeHtml(parentSessionId)}')">${escapeHtml(parentName)}</span>
      `;
      header.insertAdjacentElement('afterend', parentDiv);
    }
  },


  /**
   * Show/hide subagent windows based on active session.
   * Behavior controlled by "Subagents for Active Tab Only" setting.
   * Uses the PERSISTENT subagentParentMap for accurate tab-based visibility.
   */
  updateSubagentWindowVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;

    for (const [agentId, windowInfo] of this.subagentWindows) {
      // Get parent from PERSISTENT map (THE source of truth)
      const storedParent = this.subagentParentMap.get(agentId);
      const agent = this.subagents.get(agentId);
      const parentSessionId = storedParent || agent?.parentSessionId;

      // Determine visibility based on setting
      let shouldShow;
      if (activeTabOnly) {
        // Show if: no parent known yet, or parent matches active session
        const hasKnownParent = !!parentSessionId;
        shouldShow = !hasKnownParent || parentSessionId === this.activeSessionId;
      } else {
        // Show all windows (original behavior)
        shouldShow = true;
      }

      if (shouldShow) {
        // Show window (unless it was minimized by user)
        if (!windowInfo.minimized) {
          windowInfo.element.style.display = 'flex';
          // Lazily re-create teammate terminal if it was disposed when hidden
          if (windowInfo._lazyTerminal) {
            this._restoreTeammateTerminalFromLazy(agentId);
          }
        }
        windowInfo.hidden = false;
      } else {
        // Hide window (but don't close it)
        // Dispose teammate terminal to free memory while hidden on inactive tab
        this._disposeTeammateTerminalForMinimize(agentId);
        windowInfo.element.style.display = 'none';
        windowInfo.hidden = true;
      }
    }
    // Update connection lines after visibility changes
    this.updateConnectionLines();
    // Restack mobile windows after visibility changes
    this.relayoutMobileSubagentWindows();
  },


  // Close all subagent windows for a session (fully removes them, not minimize)
  // If cleanupData is true, also remove activity and toolResults data to prevent memory leaks
  closeSessionSubagentWindows(sessionId, cleanupData = false) {
    const toClose = [];
    for (const [agentId, _windowData] of this.subagentWindows) {
      const agent = this.subagents.get(agentId);
      // Check both subagent parentSessionId and subagentParentMap
      // (standalone pane windows use subagentParentMap, not subagents map)
      const parentFromMap = this.subagentParentMap.get(agentId);
      if (agent?.parentSessionId === sessionId || parentFromMap === sessionId) {
        toClose.push(agentId);
      }
    }
    for (const agentId of toClose) {
      this.forceCloseSubagentWindow(agentId);
      // Clean up activity and tool results data if requested (prevents memory leaks)
      if (cleanupData) {
        this.subagents.delete(agentId);
        this.subagentActivity.delete(agentId);
        this.subagentToolResults.delete(agentId);
        this.subagentParentMap.delete(agentId);
      }
    }
    // Also clean up minimized agents for this session
    this.minimizedSubagents.delete(sessionId);
    this.renderSessionTabs();
  },

  // Fully close a subagent window (removes from DOM, not minimize)
  forceCloseSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Clean up resize observer
      if (windowData.resizeObserver) {
        windowData.resizeObserver.disconnect();
      }
      // Clean up drag event listeners (both document-level and handle-level)
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
        // Remove handle-level listeners before DOM removal
        if (windowData.dragListeners.handle) {
          windowData.dragListeners.handle.removeEventListener('mousedown', windowData.dragListeners.handleMouseDown);
          windowData.dragListeners.handle.removeEventListener('touchstart', windowData.dragListeners.handleTouchStart);
        }
      }
      windowData.element.remove();
      this.subagentWindows.delete(agentId);
    }
    // Clean up teammate terminal if present
    const termData = this.teammateTerminals.get(agentId);
    if (termData) {
      if (termData.resizeObserver) {
        termData.resizeObserver.disconnect();
      }
      if (termData.terminal) {
        try { termData.terminal.dispose(); } catch {}
      }
      this.teammateTerminals.delete(agentId);
    }
  },


  minimizeSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Dispose teammate terminal on minimize to free DOM/memory (lazy re-creation on restore)
      this._disposeTeammateTerminalForMinimize(agentId);
      windowData.element.style.display = 'none';
      windowData.minimized = true;
      this.updateConnectionLines();
    }
  },


  // Debounced wrapper — coalesces rapid subagent events (tool_call, progress,
  // message) into a single DOM update per 100ms per agent window.
  scheduleSubagentWindowRender(agentId) {
    // Skip DOM updates for windows with lazy (disposed) terminals — they're minimized
    const windowData = this.subagentWindows.get(agentId);
    if (windowData?.minimized) return;

    if (!this._subagentWindowRenderTimeouts) this._subagentWindowRenderTimeouts = new Map();
    if (this._subagentWindowRenderTimeouts.has(agentId)) {
      clearTimeout(this._subagentWindowRenderTimeouts.get(agentId));
    }
    this._subagentWindowRenderTimeouts.set(agentId, setTimeout(() => {
      this._subagentWindowRenderTimeouts.delete(agentId);
      scheduleBackground(() => this.renderSubagentWindowContent(agentId));
    }, 100));
  },

  renderSubagentWindowContent(agentId) {
    // Skip if this window has a live terminal (don't overwrite xterm with activity HTML)
    if (this.teammateTerminals.has(agentId)) return;
    // Skip if this window has a lazy (disposed) terminal — it will be re-created on restore
    const windowData = this.subagentWindows.get(agentId);
    if (windowData?._lazyTerminal) return;

    const body = document.getElementById(`subagent-window-body-${agentId}`);
    if (!body) return;

    const activity = this.subagentActivity.get(agentId) || [];

    if (activity.length === 0) {
      body.innerHTML = '<div class="subagent-empty">No activity yet</div>';
      return;
    }

    // Incremental rendering: track how many items are already rendered
    const renderedCount = body.dataset.renderedCount ? parseInt(body.dataset.renderedCount, 10) : 0;
    const maxItems = 100;
    const visibleActivity = activity.slice(-maxItems);

    // If activity was trimmed or this is a fresh render, do full rebuild
    if (renderedCount === 0 || renderedCount > visibleActivity.length || body.children.length === 0 ||
        (body.children.length === 1 && body.querySelector('.subagent-empty'))) {
      // Full rebuild
      const html = visibleActivity.map(a => this._renderActivityItem(a)).join('');
      body.innerHTML = html;
      body.dataset.renderedCount = String(visibleActivity.length);
    } else {
      // Incremental: only append new items
      const newItems = visibleActivity.slice(renderedCount);
      if (newItems.length > 0) {
        const newHtml = newItems.map(a => this._renderActivityItem(a)).join('');
        body.insertAdjacentHTML('beforeend', newHtml);
        body.dataset.renderedCount = String(visibleActivity.length);

        // Trim excess children from the front if over maxItems
        while (body.children.length > maxItems) {
          body.removeChild(body.firstChild);
        }
      }
    }

    body.scrollTop = body.scrollHeight;
  },

  _renderActivityItem(a) {
    const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
    if (a.type === 'tool') {
      return `<div class="activity-line">
        <span class="time">${time}</span>
        <span class="tool-icon">${this.getToolIcon(a.tool)}</span>
        <span class="tool-name">${a.tool}</span>
        <span class="tool-detail">${escapeHtml(this.getToolDetail(a.tool, a.input))}</span>
      </div>`;
    } else if (a.type === 'tool_result') {
      const icon = a.isError ? '❌' : '📄';
      const statusClass = a.isError ? ' error' : '';
      const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
      const preview = a.preview.length > 60 ? a.preview.substring(0, 60) + '...' : a.preview;
      return `<div class="activity-line result-line${statusClass}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${a.tool || '→'}</span>
        <span class="tool-detail">${escapeHtml(preview)}${sizeInfo}</span>
      </div>`;
    } else if (a.type === 'progress') {
      const isHook = a.hookEvent || a.hookName;
      const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
      const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
      return `<div class="activity-line progress-line${isHook ? ' hook-line' : ''}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-detail">${escapeHtml(displayText)}</span>
      </div>`;
    } else if (a.type === 'message') {
      const preview = a.text.length > 150 ? a.text.substring(0, 150) + '...' : a.text;
      return `<div class="message-line">
        <span class="time">${time}</span> 💬 ${escapeHtml(preview)}
      </div>`;
    }
    return '';
  },

  // Update all open subagent windows
  updateSubagentWindows() {
    for (const agentId of this.subagentWindows.keys()) {
      this.renderSubagentWindowContent(agentId);
      this.updateSubagentWindowHeader(agentId);
    }
  },

  // Update subagent window header (title and status)
  updateSubagentWindowHeader(agentId) {
    const agent = this.subagents.get(agentId);
    if (!agent) return;

    const win = document.getElementById(`subagent-window-${agentId}`);
    if (!win) return;

    // Update title/id element with description if available
    const idEl = win.querySelector('.subagent-window-title .id');
    if (idEl) {
      const teammateInfo = this.getTeammateInfo(agent);
      const windowTitle = teammateInfo ? teammateInfo.name : (agent.description || agentId.substring(0, 7));
      const truncatedTitle = windowTitle.length > 50 ? windowTitle.substring(0, 50) + '...' : windowTitle;
      idEl.textContent = truncatedTitle;
    }

    // Add or update teammate badge
    let tmBadge = win.querySelector('.teammate-badge');
    const teammateInfo = this.getTeammateInfo(agent);
    if (teammateInfo && !tmBadge) {
      const titleContainer = win.querySelector('.subagent-window-title');
      if (titleContainer) {
        const badge = document.createElement('span');
        badge.className = `teammate-badge teammate-color-${teammateInfo.color}`;
        badge.title = `Team: ${teammateInfo.teamName}`;
        badge.textContent = `@${teammateInfo.name}`;
        const statusEl = titleContainer.querySelector('.status');
        if (statusEl) statusEl.insertAdjacentElement('beforebegin', badge);
      }
    }

    // Update full tooltip
    const titleContainer = win.querySelector('.subagent-window-title');
    if (titleContainer) {
      titleContainer.title = agent.description || agentId;
    }

    // Update or add model badge
    let modelBadge = win.querySelector('.subagent-window-title .subagent-model-badge');
    if (agent.modelShort) {
      if (!modelBadge) {
        modelBadge = document.createElement('span');
        modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
        const statusEl = win.querySelector('.subagent-window-title .status');
        if (statusEl) {
          statusEl.insertAdjacentElement('beforebegin', modelBadge);
        }
      }
      modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
      modelBadge.textContent = agent.modelShort;
    }

    // Update status
    const statusEl = win.querySelector('.subagent-window-title .status');
    if (statusEl) {
      statusEl.className = `status ${agent.status}`;
      statusEl.textContent = agent.status;
    }
  },

  // Open windows for all active subagents
  openAllActiveSubagentWindows() {
    for (const [agentId, agent] of this.subagents) {
      if (agent.status === 'active' && !this.subagentWindows.has(agentId)) {
        this.openSubagentWindow(agentId);
      }
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Agent Teams
  // ═══════════════════════════════════════════════════════════════

  /** Initialize an xterm.js terminal for a teammate's tmux pane */
  initTeammateTerminal(agentId, paneInfo, windowElement) {
    const body = windowElement.querySelector('.subagent-window-body');
    if (!body) return;

    // Clear the activity log content
    body.innerHTML = '';
    body.classList.add('teammate-terminal-body');
    windowElement.classList.add('has-terminal');

    const sessionId = paneInfo.sessionId;

    // Buffer incoming terminal data until xterm is ready
    const pendingData = [];
    this.teammateTerminals.set(agentId, {
      terminal: null,
      fitAddon: null,
      paneTarget: paneInfo.paneTarget,
      sessionId,
      resizeObserver: null,
      pendingData,
    });

    // Defer terminal creation to next frame so the body element has computed dimensions
    requestAnimationFrame(() => {
      // Safety: if window was closed before we got here, bail out
      if (!document.contains(body)) {
        this.teammateTerminals.delete(agentId);
        return;
      }

      const terminal = new Terminal({
        theme: {
          background: '#0d0d0d',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
          cursorAccent: '#0d0d0d',
          selection: 'rgba(255, 255, 255, 0.3)',
          black: '#0d0d0d',
          red: '#ff6b6b',
          green: '#51cf66',
          yellow: '#ffd43b',
          blue: '#339af0',
          magenta: '#cc5de8',
          cyan: '#22b8cf',
          white: '#e0e0e0',
          brightBlack: '#495057',
          brightRed: '#ff8787',
          brightGreen: '#69db7c',
          brightYellow: '#ffe066',
          brightBlue: '#5c7cfa',
          brightMagenta: '#da77f2',
          brightCyan: '#66d9e8',
          brightWhite: '#ffffff',
        },
        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 5000,
        allowTransparency: true,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      if (typeof Unicode11Addon !== 'undefined') {
        try {
          const unicode11Addon = new Unicode11Addon.Unicode11Addon();
          terminal.loadAddon(unicode11Addon);
          terminal.unicode.activeVersion = '11';
        } catch (_e) { /* Unicode11 addon failed */ }
      }

      try {
        terminal.open(body);
      } catch (err) {
        console.warn('[TeammateTerminal] Failed to open terminal:', err);
        this.teammateTerminals.delete(agentId);
        return;
      }

      // Wait for terminal renderer to fully initialize before any writes.
      // xterm.js needs a few frames after open() before write() is safe.
      setTimeout(() => {
        try { fitAddon.fit(); } catch {}

        // Fetch initial pane buffer
        fetch(`/api/sessions/${sessionId}/teammate-pane-buffer/${encodeURIComponent(paneInfo.paneTarget)}`)
          .then(r => r.json())
          .then(resp => {
            if (resp.success && resp.data?.buffer) {
              try { terminal.write(resp.data.buffer); } catch {}
            }
          })
          .catch(err => console.error('[TeammateTerminal] Failed to fetch buffer:', err));

        // Flush any data that arrived while terminal was initializing
        for (const chunk of pendingData) {
          try { terminal.write(chunk); } catch {}
        }
        pendingData.length = 0;
      }, 100);

      // Forward keyboard input to the teammate's pane
      terminal.onData((data) => {
        fetch(`/api/sessions/${sessionId}/teammate-pane-input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paneTarget: paneInfo.paneTarget, input: data }),
        }).catch(err => console.error('[TeammateTerminal] Failed to send input:', err));
      });

      // Resize observer to refit terminal when window is resized
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
      });
      resizeObserver.observe(body);

      // Update the stored entry with the real terminal
      const entry = this.teammateTerminals.get(agentId);
      if (entry) {
        entry.terminal = terminal;
        entry.fitAddon = fitAddon;
        entry.resizeObserver = resizeObserver;
      }
    });
  },

  /** Open a standalone terminal window for a tmux-pane teammate (no subagent entry needed) */
  openTeammateTerminalWindow(paneData) {
    // Only open if the session has a tab in Codeman
    if (!this.sessions.has(paneData.sessionId)) return;

    // Use pane target as the unique ID for this window
    const windowId = `pane-${paneData.paneTarget}`;

    // If window already exists, focus it
    if (this.subagentWindows.has(windowId)) {
      const existing = this.subagentWindows.get(windowId);
      if (existing.hidden) {
        existing.element.style.display = 'flex';
        existing.hidden = false;
      }
      existing.element.style.zIndex = ++this.subagentWindowZIndex;
      if (existing.minimized) {
        this.restoreSubagentWindow(windowId);
      }
      return;
    }

    // Calculate position
    const windowCount = this.subagentWindows.size;
    const windowWidth = 550;
    const windowHeight = 400;
    const gap = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const startX = 50;
    const startY = 120;
    const maxCols = Math.floor((viewportWidth - startX - 50) / (windowWidth + gap)) || 1;
    const maxRows = Math.floor((viewportHeight - startY - 50) / (windowHeight + gap)) || 1;
    const col = windowCount % maxCols;
    const row = Math.floor(windowCount / maxCols) % maxRows;
    let finalX = startX + col * (windowWidth + gap);
    let finalY = startY + row * (windowHeight + gap);
    finalX = Math.max(10, Math.min(finalX, viewportWidth - windowWidth - 10));
    finalY = Math.max(10, Math.min(finalY, viewportHeight - windowHeight - 10));

    // Color badge
    const colorClass = paneData.color || 'blue';

    // Create window element
    const win = document.createElement('div');
    win.className = 'subagent-window has-terminal';
    win.id = `subagent-window-${windowId}`;
    win.style.zIndex = ++this.subagentWindowZIndex;
    win.style.left = `${finalX}px`;
    win.style.top = `${finalY}px`;
    win.style.width = `${windowWidth}px`;
    win.style.height = `${windowHeight}px`;
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title" title="Teammate terminal: ${escapeHtml(paneData.teammateName)} (pane ${paneData.paneTarget})">
          <span class="icon" style="color: var(--team-color-${colorClass}, #339af0)">⬤</span>
          <span class="id">${escapeHtml(paneData.teammateName)}</span>
          <span class="status running">terminal</span>
        </div>
        <div class="subagent-window-actions">
          <button onclick="app.closeSubagentWindow('${escapeHtml(windowId)}')" title="Minimize to tab">─</button>
        </div>
      </div>
      <div class="subagent-window-body teammate-terminal-body" id="subagent-window-body-${windowId}">
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.subagent-window-header'));

    // Make resizable if method exists
    if (typeof this.makeWindowResizable === 'function') {
      this.makeWindowResizable(win);
    }

    // Check visibility based on active session
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;
    const shouldHide = activeTabOnly && paneData.sessionId !== this.activeSessionId;

    // Store reference
    this.subagentWindows.set(windowId, {
      element: win,
      minimized: false,
      hidden: shouldHide,
      dragListeners,
      description: `Teammate: ${paneData.teammateName}`,
    });

    // Also add to subagentParentMap for tab-based visibility
    this.subagentParentMap.set(windowId, paneData.sessionId);

    if (shouldHide) {
      win.style.display = 'none';
    }

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.subagentWindowZIndex;
    });

    // Resize observer for connection lines
    const resizeObserver = new ResizeObserver(() => {
      this.updateConnectionLines();
    });
    resizeObserver.observe(win);
    this.subagentWindows.get(windowId).resizeObserver = resizeObserver;

    // Init the xterm.js terminal (lazy if hidden)
    if (shouldHide) {
      // Window starts hidden — defer terminal creation until visible (lazy init)
      const windowEntry = this.subagentWindows.get(windowId);
      if (windowEntry) {
        windowEntry._lazyTerminal = true;
        windowEntry._lazyPaneTarget = paneData.paneTarget;
        windowEntry._lazySessionId = paneData.sessionId;
      }
    } else {
      this.initTeammateTerminal(windowId, paneData, win);
    }

    // Animate in
    requestAnimationFrame(() => {
      win.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      win.style.transform = 'scale(1)';
      win.style.opacity = '1';
    });
  },

  /** Rebuild the teammate lookup map from all team configs */
  rebuildTeammateMap() {
    this.teammateMap.clear();
    for (const [teamName, team] of this.teams) {
      for (const member of team.members) {
        if (member.agentType !== 'team-lead') {
          // Use name as key prefix for matching subagent descriptions
          this.teammateMap.set(member.name, {
            name: member.name,
            color: member.color || 'blue',
            teamName,
            agentId: member.agentId,
          });
        }
      }
    }
  },

  /** Check if a subagent is a teammate and return its info */
  getTeammateInfo(agent) {
    if (!agent?.description) return null;
    // Teammate descriptions start with <teammate-message teammate_id=
    const match = agent.description.match(/<teammate-message\s+teammate_id="?([^">\s]+)/);
    if (!match) return null;
    const teammateId = match[1];
    // Extract name from teammate_id (format: name@teamName)
    const name = teammateId.split('@')[0];
    return this.teammateMap.get(name) || { name, color: 'blue', teamName: 'unknown' };
  },

  /** Get teammate badge HTML for a subagent */
  getTeammateBadgeHtml(agent) {
    const info = this.getTeammateInfo(agent);
    if (!info) return '';
    return `<span class="teammate-badge teammate-color-${info.color}" title="Team: ${escapeHtml(info.teamName)}">@${escapeHtml(info.name)}</span>`;
  },

  /** Render the team tasks panel */
  renderTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (!panel) return;

    // Find team for active session
    let activeTeam = null;
    let activeTeamName = null;
    if (this.activeSessionId) {
      for (const [name, team] of this.teams) {
        if (team.leadSessionId === this.activeSessionId) {
          activeTeam = team;
          activeTeamName = name;
          break;
        }
      }
    }

    if (!activeTeam) {
      panel.style.display = 'none';
      return;
    }

    // Set initial position and make draggable on first show
    const wasHidden = panel.style.display === 'none';
    panel.style.display = 'flex';

    if (wasHidden && !this.teamTasksDragListeners) {
      // Position bottom-right
      const panelWidth = 360;
      const panelHeight = 300;
      panel.style.left = `${Math.max(10, window.innerWidth - panelWidth - 20)}px`;
      panel.style.top = `${Math.max(10, window.innerHeight - panelHeight - 70)}px`;
      // Make draggable
      const header = panel.querySelector('.team-tasks-header');
      if (header) {
        this.teamTasksDragListeners = this.makeWindowDraggable(panel, header);
      }
    }

    const tasks = this.teamTasks.get(activeTeamName) || [];
    const completed = tasks.filter(t => t.status === 'completed').length;
    const total = tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const headerEl = panel.querySelector('.team-tasks-header-text');
    if (headerEl) {
      const teammateCount = activeTeam.members.filter(m => m.agentType !== 'team-lead').length;
      headerEl.textContent = `Team Tasks (${teammateCount} teammates)`;
    }

    const progressEl = panel.querySelector('.team-tasks-progress-fill');
    if (progressEl) {
      progressEl.style.width = `${pct}%`;
    }

    const progressText = panel.querySelector('.team-tasks-progress-text');
    if (progressText) {
      progressText.textContent = `${completed}/${total}`;
    }

    const listEl = panel.querySelector('.team-tasks-list');
    if (!listEl) return;

    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="team-task-empty">No tasks yet</div>';
      return;
    }

    const html = tasks.map(task => {
      const statusIcon = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◉' : '○';
      const statusClass = task.status.replace('_', '-');
      const ownerBadge = task.owner
        ? `<span class="team-task-owner teammate-color-${this.getTeammateColor(task.owner)}">${escapeHtml(task.owner)}</span>`
        : '';
      return `<div class="team-task-item ${statusClass}">
        <span class="team-task-status">${statusIcon}</span>
        <span class="team-task-subject">${escapeHtml(task.subject)}</span>
        ${ownerBadge}
      </div>`;
    }).join('');

    listEl.innerHTML = html;
  },

  /** Hide team tasks panel and clean up drag listeners */
  hideTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (panel) panel.style.display = 'none';
    if (this.teamTasksDragListeners) {
      document.removeEventListener('mousemove', this.teamTasksDragListeners.move);
      document.removeEventListener('mouseup', this.teamTasksDragListeners.up);
      if (this.teamTasksDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.teamTasksDragListeners.touchMove);
        document.removeEventListener('touchend', this.teamTasksDragListeners.up);
        document.removeEventListener('touchcancel', this.teamTasksDragListeners.up);
      }
      if (this.teamTasksDragListeners.handle) {
        this.teamTasksDragListeners.handle.removeEventListener('mousedown', this.teamTasksDragListeners.handleMouseDown);
        this.teamTasksDragListeners.handle.removeEventListener('touchstart', this.teamTasksDragListeners.handleTouchStart);
      }
      this.teamTasksDragListeners = null;
    }
  },

  /** Get teammate color by name */
  getTeammateColor(name) {
    const info = this.teammateMap.get(name);
    return info?.color || 'blue';
  },


  // ═══════════════════════════════════════════════════════════════
  // Project Insights Panel (Bash Tools with Clickable File Paths)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Normalize a file path to its canonical form for comparison.
   * - Expands ~ to home directory approximation
   * - Resolves relative paths against working directory (case folder)
   * - Normalizes . and .. components
   */
  normalizeFilePath(path, workingDir) {
    if (!path) return '';

    let normalized = path.trim();
    const homeDir = '/home/' + (window.USER || 'user'); // Approximation

    // Expand ~ to home directory
    if (normalized.startsWith('~/')) {
      normalized = homeDir + normalized.slice(1);
    } else if (normalized === '~') {
      normalized = homeDir;
    }

    // If not absolute, resolve against working directory (case folder)
    if (!normalized.startsWith('/') && workingDir) {
      normalized = workingDir + '/' + normalized;
    }

    // Normalize path components (resolve . and ..)
    const parts = normalized.split('/');
    const stack = [];

    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      } else if (part === '..') {
        if (stack.length > 1) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }

    return '/' + stack.join('/');
  },

  /**
   * Extract just the filename from a path.
   */
  getFilename(path) {
    const parts = path.split('/');
    return parts[parts.length - 1] || '';
  },

  /**
   * Check if a path is a "shallow root path" - an absolute path with only one
   * component after root (e.g., /test.txt, /file.log).
   * These are often typos where the user meant a relative path in the case folder.
   */
  isShallowRootPath(path) {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter(p => p !== '');
    return parts.length === 1;
  },

  /**
   * Check if a path is inside (or is) the working directory (case folder).
   */
  isPathInWorkingDir(path, workingDir) {
    if (!workingDir) return false;
    const normalized = this.normalizeFilePath(path, workingDir);
    return normalized.startsWith(workingDir + '/') || normalized === workingDir;
  },

  /**
   * Smart path equivalence check.
   * Two paths are considered equivalent if:
   * 1. They normalize to the same path (standard case)
   * 2. One is a "shallow root path" (e.g., /test.txt) and the other is the
   *    same filename inside the case folder - the shallow root path
   *    is likely a typo and they probably meant the same file.
   */
  pathsAreEquivalent(path1, path2, workingDir) {
    const norm1 = this.normalizeFilePath(path1, workingDir);
    const norm2 = this.normalizeFilePath(path2, workingDir);

    // Standard check: exact normalized match
    if (norm1 === norm2) return true;

    // Smart check: shallow root path vs case folder path with same filename
    const file1 = this.getFilename(norm1);
    const file2 = this.getFilename(norm2);

    if (file1 !== file2) return false; // Different filenames, can't be equivalent

    const shallow1 = this.isShallowRootPath(path1);
    const shallow2 = this.isShallowRootPath(path2);
    const inWorkDir1 = this.isPathInWorkingDir(norm1, workingDir);
    const inWorkDir2 = this.isPathInWorkingDir(norm2, workingDir);

    // If one is shallow root (e.g., /test.txt) and other is in case folder
    // with same filename, treat as equivalent (user likely made a typo)
    if (shallow1 && inWorkDir2) return true;
    if (shallow2 && inWorkDir1) return true;

    return false;
  },

  /**
   * Pick the "better" of two paths that resolve to the same file.
   * Prefers paths inside the case folder, longer/more explicit paths, and absolute paths.
   */
  pickBetterPath(path1, path2, workingDir) {
    // Prefer paths inside the case folder (working directory)
    if (workingDir) {
      const inWorkDir1 = this.isPathInWorkingDir(path1, workingDir);
      const inWorkDir2 = this.isPathInWorkingDir(path2, workingDir);
      if (inWorkDir1 && !inWorkDir2) return path1;
      if (inWorkDir2 && !inWorkDir1) return path2;
    }

    // Prefer absolute paths
    const abs1 = path1.startsWith('/');
    const abs2 = path2.startsWith('/');
    if (abs1 && !abs2) return path1;
    if (abs2 && !abs1) return path2;

    // Both absolute or both relative - prefer longer (more explicit)
    if (path1.length !== path2.length) {
      return path1.length > path2.length ? path1 : path2;
    }

    // Prefer paths without ~
    if (!path1.includes('~') && path2.includes('~')) return path1;
    if (!path2.includes('~') && path1.includes('~')) return path2;

    return path1;
  },

  /**
   * Deduplicate file paths across all tools, keeping the "best" version.
   * Uses smart equivalence checking:
   * - Standard normalization for relative vs absolute paths
   * - Detects likely typos (e.g., /file.txt when caseFolder/file.txt exists)
   * - Prefers paths inside the case folder (working directory)
   * - Prefers longer, more explicit paths
   * Returns a Map of normalized path -> best raw path.
   */
  deduplicateProjectInsightPaths(tools, workingDir) {
    // Collect all paths with their tool IDs
    const allPaths = [];
    for (const tool of tools) {
      for (const rawPath of tool.filePaths) {
        allPaths.push({ rawPath, toolId: tool.id });
      }
    }

    if (allPaths.length <= 1) {
      const pathMap = new Map();
      for (const p of allPaths) {
        pathMap.set(this.normalizeFilePath(p.rawPath, workingDir), p);
      }
      return pathMap;
    }

    // Sort paths: prefer paths in case folder first, then by length (longer first)
    allPaths.sort((a, b) => {
      const aInWorkDir = this.isPathInWorkingDir(a.rawPath, workingDir);
      const bInWorkDir = this.isPathInWorkingDir(b.rawPath, workingDir);
      if (aInWorkDir && !bInWorkDir) return -1;
      if (bInWorkDir && !aInWorkDir) return 1;
      return b.rawPath.length - a.rawPath.length; // Longer paths first
    });

    const result = new Map(); // normalized -> { rawPath, toolId }
    const seenNormalized = new Set();

    for (const { rawPath, toolId } of allPaths) {
      const normalized = this.normalizeFilePath(rawPath, workingDir);

      // Check if we've already seen an equivalent path
      let isDuplicate = false;
      for (const [, existing] of result) {
        if (this.pathsAreEquivalent(rawPath, existing.rawPath, workingDir)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && !seenNormalized.has(normalized)) {
        result.set(normalized, { rawPath, toolId });
        seenNormalized.add(normalized);
      }
    }

    return result;
  },

  handleBashToolStart(sessionId, tool) {
    let tools = this.projectInsights.get(sessionId) || [];
    // Add new tool
    tools = tools.filter(t => t.id !== tool.id);
    tools.push(tool);
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  },

  handleBashToolEnd(sessionId, tool) {
    const tools = this.projectInsights.get(sessionId) || [];
    const existing = tools.find(t => t.id === tool.id);
    if (existing) {
      existing.status = 'completed';
    }
    this.renderProjectInsightsPanel();
    // Remove after a short delay
    setTimeout(() => {
      const current = this.projectInsights.get(sessionId) || [];
      this.projectInsights.set(sessionId, current.filter(t => t.id !== tool.id));
      this.renderProjectInsightsPanel();
    }, 2000);
  },

  handleBashToolsUpdate(sessionId, tools) {
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  },

  renderProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    const list = this.$('projectInsightsList');
    if (!panel || !list) return;

    // Check if panel is enabled in settings
    const settings = this.loadAppSettingsFromStorage();
    const showProjectInsights = settings.showProjectInsights ?? false;
    if (!showProjectInsights) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    // Get tools for active session only
    const tools = this.projectInsights.get(this.activeSessionId) || [];
    const runningTools = tools.filter(t => t.status === 'running');

    if (runningTools.length === 0) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    panel.classList.add('visible');
    this.projectInsightsPanelVisible = true;

    // Get working directory for path normalization
    const session = this.sessions.get(this.activeSessionId);
    const workingDir = session?.workingDir || this.currentSessionWorkingDir;

    // Smart deduplication: collect all unique paths across all tools
    // Paths that resolve to the same file are deduplicated, keeping the most complete version
    const deduplicatedPaths = this.deduplicateProjectInsightPaths(runningTools, workingDir);

    // Build a set of paths to show (only the best version of each unique file)
    const pathsToShow = new Set(Array.from(deduplicatedPaths.values()).map(p => p.rawPath));

    const html = [];
    for (const tool of runningTools) {
      // Filter this tool's paths to only include those that weren't deduplicated away
      const filteredPaths = tool.filePaths.filter(p => pathsToShow.has(p));

      // Skip tools with no paths to show (all were duplicates of better paths elsewhere)
      if (filteredPaths.length === 0) continue;

      const cmdDisplay = tool.command.length > 50
        ? tool.command.substring(0, 50) + '...'
        : tool.command;

      html.push(`
        <div class="project-insight-item" data-tool-id="${tool.id}">
          <div class="project-insight-command">
            <span class="icon">💻</span>
            <span class="cmd" title="${escapeHtml(tool.command)}">${escapeHtml(cmdDisplay)}</span>
            <span class="project-insight-status ${tool.status}">${tool.status}</span>
            ${tool.timeout ? `<span class="project-insight-timeout">${escapeHtml(tool.timeout)}</span>` : ''}
          </div>
          <div class="project-insight-paths">
      `);

      for (const path of filteredPaths) {
        const fileName = path.split('/').pop();
        html.push(`
            <span class="project-insight-filepath"
                  onclick="app.openLogViewerWindow('${escapeHtml(path)}', '${escapeHtml(tool.sessionId)}')"
                  title="${escapeHtml(path)}">${escapeHtml(fileName)}</span>
        `);
      }

      html.push(`
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  },

  closeProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    if (panel) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // File Browser Panel
  // ═══════════════════════════════════════════════════════════════

  async loadFileBrowser(sessionId) {
    if (!sessionId) return;

    const treeEl = this.$('fileBrowserTree');
    const statusEl = this.$('fileBrowserStatus');
    if (!treeEl) return;

    // Show loading state
    treeEl.innerHTML = '<div class="file-browser-loading">Loading files...</div>';

    try {
      const res = await fetch(`/api/sessions/${sessionId}/files?depth=5&showHidden=false`);
      if (!res.ok) throw new Error('Failed to load files');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load files');

      this.fileBrowserData = result.data;
      this.renderFileBrowserTree();

      // Update status
      if (statusEl) {
        const { totalFiles, totalDirectories, truncated } = result.data;
        statusEl.textContent = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}`;
      }
    } catch (err) {
      console.error('Failed to load file browser:', err);
      treeEl.innerHTML = `<div class="file-browser-empty">Failed to load files: ${escapeHtml(err.message)}</div>`;
    }
  },

  renderFileBrowserTree() {
    const treeEl = this.$('fileBrowserTree');
    if (!treeEl || !this.fileBrowserData) return;

    const { tree } = this.fileBrowserData;
    if (!tree || tree.length === 0) {
      treeEl.innerHTML = '<div class="file-browser-empty">No files found</div>';
      return;
    }

    const html = [];
    const filter = this.fileBrowserFilter.toLowerCase();

    const renderNode = (node, depth) => {
      const isDir = node.type === 'directory';
      const isExpanded = this.fileBrowserExpandedDirs.has(node.path);
      const matchesFilter = !filter || node.name.toLowerCase().includes(filter);

      // For directories, check if any children match
      let hasMatchingChildren = false;
      if (isDir && filter && node.children) {
        hasMatchingChildren = this.hasMatchingChild(node, filter);
      }

      const shouldShow = matchesFilter || hasMatchingChildren;
      const hiddenClass = !shouldShow && filter ? ' hidden-by-filter' : '';

      const icon = isDir
        ? (isExpanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1')
        : this.getFileIcon(node.extension);

      const expandIcon = isDir
        ? `<span class="file-tree-expand${isExpanded ? ' expanded' : ''}">\u25B6</span>`
        : '<span class="file-tree-expand"></span>';

      const sizeStr = !isDir && node.size !== undefined
        ? `<span class="file-tree-size">${this.formatFileSize(node.size)}</span>`
        : '';

      const nameClass = isDir ? 'file-tree-name directory' : 'file-tree-name';

      const downloadBtn = !isDir
        ? `<a class="file-tree-download" href="/api/sessions/${this.activeSessionId}/file-raw?path=${encodeURIComponent(node.path)}&download=true" title="Download" onclick="event.stopPropagation()">&#x2B07;</a>`
        : '';

      html.push(`
        <div class="file-tree-item${hiddenClass}" data-path="${escapeHtml(node.path)}" data-type="${node.type}" data-depth="${depth}">
          ${expandIcon}
          <span class="file-tree-icon">${icon}</span>
          <span class="${nameClass}">${escapeHtml(node.name)}</span>
          ${sizeStr}
          ${downloadBtn}
        </div>
      `);

      // Render children if directory is expanded
      if (isDir && isExpanded && node.children) {
        for (const child of node.children) {
          renderNode(child, depth + 1);
        }
      }
    };

    for (const node of tree) {
      renderNode(node, 0);
    }

    treeEl.innerHTML = html.join('');

    // Add click handlers
    treeEl.querySelectorAll('.file-tree-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = item.dataset.path;
        const type = item.dataset.type;

        if (type === 'directory') {
          this.toggleFileBrowserFolder(path);
        } else {
          this.openFilePreview(path);
        }
      });
    });
  },

  hasMatchingChild(node, filter) {
    if (!node.children) return false;
    for (const child of node.children) {
      if (child.name.toLowerCase().includes(filter)) return true;
      if (child.type === 'directory' && this.hasMatchingChild(child, filter)) return true;
    }
    return false;
  },

  toggleFileBrowserFolder(path) {
    if (this.fileBrowserExpandedDirs.has(path)) {
      this.fileBrowserExpandedDirs.delete(path);
    } else {
      this.fileBrowserExpandedDirs.add(path);
    }
    this.renderFileBrowserTree();
  },

  filterFileBrowser(value) {
    this.fileBrowserFilter = value;
    // Auto-expand all if filtering
    if (value) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
    }
    this.renderFileBrowserTree();
  },

  expandAllDirectories(nodes) {
    for (const node of nodes) {
      if (node.type === 'directory') {
        this.fileBrowserExpandedDirs.add(node.path);
        if (node.children) {
          this.expandAllDirectories(node.children);
        }
      }
    }
  },

  collapseAllDirectories() {
    this.fileBrowserExpandedDirs.clear();
  },

  toggleFileBrowserExpand() {
    this.fileBrowserAllExpanded = !this.fileBrowserAllExpanded;
    const btn = this.$('fileBrowserExpandBtn');

    if (this.fileBrowserAllExpanded) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
      if (btn) btn.innerHTML = '\u229F'; // Collapse icon
    } else {
      this.collapseAllDirectories();
      if (btn) btn.innerHTML = '\u229E'; // Expand icon
    }
    this.renderFileBrowserTree();
  },

  refreshFileBrowser() {
    if (this.activeSessionId) {
      this.fileBrowserExpandedDirs.clear();
      this.fileBrowserFilter = '';
      this.fileBrowserAllExpanded = false;
      const searchInput = this.$('fileBrowserSearch');
      if (searchInput) searchInput.value = '';
      this.loadFileBrowser(this.activeSessionId);
    }
  },

  closeFileBrowserPanel() {
    const panel = this.$('fileBrowserPanel');
    if (panel) {
      panel.classList.remove('visible');
      // Reset position so it reopens at default location
      panel.style.left = '';
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.right = '';
    }
    // Clean up drag listeners
    if (this.fileBrowserDragListeners) {
      const dl = this.fileBrowserDragListeners;
      document.removeEventListener('mousemove', dl.move);
      document.removeEventListener('mouseup', dl.up);
      document.removeEventListener('touchmove', dl.touchMove);
      document.removeEventListener('touchend', dl.up);
      document.removeEventListener('touchcancel', dl.up);
      if (dl.handle) {
        dl.handle.removeEventListener('mousedown', dl.handleMouseDown);
        dl.handle.removeEventListener('touchstart', dl.handleTouchStart);
        if (dl._onFirstDrag) {
          dl.handle.removeEventListener('mousedown', dl._onFirstDrag);
          dl.handle.removeEventListener('touchstart', dl._onFirstDrag);
        }
      }
      this.fileBrowserDragListeners = null;
    }
    // Save setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showFileBrowser = false;
    this.saveAppSettingsToStorage(settings);
  },

  async openFilePreview(filePath) {
    if (!this.activeSessionId || !filePath) return;

    const overlay = this.$('filePreviewOverlay');
    const titleEl = this.$('filePreviewTitle');
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');

    if (!overlay || !bodyEl) return;

    // Show overlay with loading state
    overlay.classList.add('visible');
    titleEl.textContent = filePath;
    bodyEl.innerHTML = '<div class="binary-message">Loading...</div>';
    footerEl.textContent = '';

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/file-content?path=${encodeURIComponent(filePath)}&lines=500`);
      if (!res.ok) throw new Error('Failed to load file');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load file');

      const data = result.data;

      if (data.type === 'image') {
        bodyEl.innerHTML = `<img src="${data.url}" alt="${escapeHtml(filePath)}">`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'video') {
        bodyEl.innerHTML = `<video src="${data.url}" controls autoplay></video>`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'binary') {
        bodyEl.innerHTML = `<div class="binary-message">Binary file (${this.formatFileSize(data.size)})<br>Cannot preview</div>`;
        footerEl.textContent = data.extension || 'binary';
      } else {
        // Text content
        this.filePreviewContent = data.content;
        bodyEl.innerHTML = `<pre><code>${escapeHtml(data.content)}</code></pre>`;
        const truncNote = data.truncated ? ` (showing 500/${data.totalLines} lines)` : '';
        footerEl.textContent = `${data.totalLines} lines \u2022 ${this.formatFileSize(data.size)}${truncNote}`;
      }
    } catch (err) {
      console.error('Failed to preview file:', err);
      bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(err.message)}</div>`;
    }
  },

  closeFilePreview() {
    const overlay = this.$('filePreviewOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    this.filePreviewContent = '';
  },

  copyFilePreviewContent() {
    if (this.filePreviewContent) {
      navigator.clipboard.writeText(this.filePreviewContent).then(() => {
        this.showToast('Copied to clipboard', 'success');
      }).catch(() => {
        this.showToast('Failed to copy', 'error');
      });
    }
  },

  getFileIcon(ext) {
    if (!ext) return '\uD83D\uDCC4'; // Default file

    const icons = {
      // TypeScript/JavaScript
      'ts': '\uD83D\uDCD8', 'tsx': '\uD83D\uDCD8', 'js': '\uD83D\uDCD2', 'jsx': '\uD83D\uDCD2',
      'mjs': '\uD83D\uDCD2', 'cjs': '\uD83D\uDCD2',
      // Python
      'py': '\uD83D\uDC0D', 'pyx': '\uD83D\uDC0D', 'pyw': '\uD83D\uDC0D',
      // Rust/Go/C
      'rs': '\uD83E\uDD80', 'go': '\uD83D\uDC39', 'c': '\u2699\uFE0F', 'cpp': '\u2699\uFE0F',
      'h': '\u2699\uFE0F', 'hpp': '\u2699\uFE0F',
      // Web
      'html': '\uD83C\uDF10', 'htm': '\uD83C\uDF10', 'css': '\uD83C\uDFA8', 'scss': '\uD83C\uDFA8',
      'sass': '\uD83C\uDFA8', 'less': '\uD83C\uDFA8',
      // Data
      'json': '\uD83D\uDCCB', 'yaml': '\uD83D\uDCCB', 'yml': '\uD83D\uDCCB', 'xml': '\uD83D\uDCCB',
      'toml': '\uD83D\uDCCB', 'csv': '\uD83D\uDCCB',
      // Docs
      'md': '\uD83D\uDCDD', 'markdown': '\uD83D\uDCDD', 'txt': '\uD83D\uDCDD', 'rst': '\uD83D\uDCDD',
      // Images
      'png': '\uD83D\uDDBC\uFE0F', 'jpg': '\uD83D\uDDBC\uFE0F', 'jpeg': '\uD83D\uDDBC\uFE0F',
      'gif': '\uD83D\uDDBC\uFE0F', 'svg': '\uD83D\uDDBC\uFE0F', 'webp': '\uD83D\uDDBC\uFE0F',
      'ico': '\uD83D\uDDBC\uFE0F', 'bmp': '\uD83D\uDDBC\uFE0F',
      // Video/Audio
      'mp4': '\uD83C\uDFAC', 'webm': '\uD83C\uDFAC', 'mov': '\uD83C\uDFAC',
      'mp3': '\uD83C\uDFB5', 'wav': '\uD83C\uDFB5', 'ogg': '\uD83C\uDFB5',
      // Config/Shell
      'sh': '\uD83D\uDCBB', 'bash': '\uD83D\uDCBB', 'zsh': '\uD83D\uDCBB',
      'env': '\uD83D\uDD10', 'gitignore': '\uD83D\uDEAB', 'dockerfile': '\uD83D\uDC33',
      // Lock files
      'lock': '\uD83D\uDD12',
    };

    return icons[ext.toLowerCase()] || '\uD83D\uDCC4';
  },

  formatFileSize(bytes) {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  },


  // ═══════════════════════════════════════════════════════════════
  // Log Viewer Windows (Floating File Streamers)
  // ═══════════════════════════════════════════════════════════════

  openLogViewerWindow(filePath, sessionId) {
    sessionId = sessionId || this.activeSessionId;
    if (!sessionId) return;

    // Create unique window ID
    const windowId = `${sessionId}-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // If window already exists, focus it
    if (this.logViewerWindows.has(windowId)) {
      const existing = this.logViewerWindows.get(windowId);
      existing.element.style.zIndex = ++this.logViewerWindowZIndex;
      return;
    }

    // Calculate position (cascade from top-left)
    const windowCount = this.logViewerWindows.size;
    const offsetX = 100 + (windowCount % 5) * 30;
    const offsetY = 100 + (windowCount % 5) * 30;

    // Get filename for title
    const fileName = filePath.split('/').pop();

    // Create window element
    const win = document.createElement('div');
    win.className = 'log-viewer-window';
    win.id = `log-viewer-window-${windowId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.logViewerWindowZIndex;

    win.innerHTML = `
      <div class="log-viewer-window-header">
        <div class="log-viewer-window-title" title="${escapeHtml(filePath)}">
          <span class="icon">📄</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="status streaming">streaming</span>
        </div>
        <div class="log-viewer-window-actions">
          <button onclick="app.closeLogViewerWindow('${escapeHtml(windowId)}')" title="Close">×</button>
        </div>
      </div>
      <div class="log-viewer-window-body" id="log-viewer-body-${windowId}">
        <div class="log-info">Connecting to ${escapeHtml(filePath)}...</div>
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable (returns listener refs for cleanup)
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.log-viewer-window-header'));

    // Connect to SSE stream
    const eventSource = new EventSource(
      `/api/sessions/${sessionId}/tail-file?path=${encodeURIComponent(filePath)}&lines=50`
    );

    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const body = document.getElementById(`log-viewer-body-${windowId}`);
      if (!body) return;

      switch (data.type) {
        case 'connected':
          body.innerHTML = '';
          break;
        case 'data':
          // Append data, auto-scroll
          const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 10;
          const content = escapeHtml(data.content);
          body.innerHTML += content;
          if (wasAtBottom) {
            body.scrollTop = body.scrollHeight;
          }
          // Trim if too large
          if (body.innerHTML.length > 500000) {
            body.innerHTML = body.innerHTML.slice(-400000);
          }
          break;
        case 'end':
          this.updateLogViewerStatus(windowId, 'disconnected', 'ended');
          break;
        case 'error':
          body.innerHTML += `<div class="log-error">${escapeHtml(data.error)}</div>`;
          this.updateLogViewerStatus(windowId, 'error', 'error');
          break;
      }
    };

    eventSource.onerror = () => {
      this.updateLogViewerStatus(windowId, 'disconnected', 'connection error');
    };

    // Store reference (including drag listeners for cleanup)
    this.logViewerWindows.set(windowId, {
      element: win,
      eventSource,
      filePath,
      sessionId,
      dragListeners, // Store for cleanup to prevent memory leaks
    });
  },

  updateLogViewerStatus(windowId, statusClass, statusText) {
    const statusEl = document.querySelector(`#log-viewer-window-${windowId} .status`);
    if (statusEl) {
      statusEl.className = `status ${statusClass}`;
      statusEl.textContent = statusText;
    }
  },

  closeLogViewerWindow(windowId) {
    const windowData = this.logViewerWindows.get(windowId);
    if (!windowData) return;

    // Close SSE connection
    if (windowData.eventSource) {
      windowData.eventSource.close();
    }

    // Clean up drag event listeners (both document-level and handle-level)
    if (windowData.dragListeners) {
      document.removeEventListener('mousemove', windowData.dragListeners.move);
      document.removeEventListener('mouseup', windowData.dragListeners.up);
      if (windowData.dragListeners.handle) {
        windowData.dragListeners.handle.removeEventListener('mousedown', windowData.dragListeners.handleMouseDown);
        windowData.dragListeners.handle.removeEventListener('touchstart', windowData.dragListeners.handleTouchStart);
      }
    }

    // Remove element
    windowData.element.remove();

    // Remove from map
    this.logViewerWindows.delete(windowId);
  },

  // Close all log viewer windows for a session
  closeSessionLogViewerWindows(sessionId) {
    const toClose = [];
    for (const [windowId, data] of this.logViewerWindows) {
      if (data.sessionId === sessionId) {
        toClose.push(windowId);
      }
    }
    for (const windowId of toClose) {
      this.closeLogViewerWindow(windowId);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Image Popup Windows (Auto-popup for Screenshots)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open a popup window to display a detected image.
   * Called automatically when image:detected SSE event is received.
   */
  openImagePopup(imageEvent) {
    const { sessionId, filePath, relativePath, fileName, timestamp, size } = imageEvent;

    // Create unique window ID
    const imageId = `${sessionId}-${timestamp}`;

    // If window already exists for this image, focus it
    if (this.imagePopups.has(imageId)) {
      const existing = this.imagePopups.get(imageId);
      existing.element.style.zIndex = ++this.imagePopupZIndex;
      return;
    }

    // Cap open popups at 20 — close oldest when at limit
    const MAX_IMAGE_POPUPS = 20;
    if (this.imagePopups.size >= MAX_IMAGE_POPUPS) {
      // Map iteration order is insertion order, so first key is oldest
      const oldestId = this.imagePopups.keys().next().value;
      if (oldestId) this.closeImagePopup(oldestId);
    }

    // Calculate position (cascade from center, with offset for multiple popups)
    const windowCount = this.imagePopups.size;
    const centerX = (window.innerWidth - 600) / 2;
    const centerY = (window.innerHeight - 500) / 2;
    const offsetX = centerX + (windowCount % 5) * 30;
    const offsetY = centerY + (windowCount % 5) * 30;

    // Get session name for display
    const session = this.sessions.get(sessionId);
    const sessionName = session?.name || sessionId.substring(0, 8);

    // Format file size
    const sizeKB = (size / 1024).toFixed(1);

    // Build image URL using the existing file-raw endpoint
    // Use relativePath (path from working dir) instead of fileName (basename) for subdirectory images
    const imageUrl = `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(relativePath || fileName)}`;

    // Create window element
    const win = document.createElement('div');
    win.className = 'image-popup-window';
    win.id = `image-popup-${imageId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.imagePopupZIndex;

    win.innerHTML = `
      <div class="image-popup-header">
        <div class="image-popup-title" title="${escapeHtml(filePath)}">
          <span class="icon">🖼️</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="session-badge">${escapeHtml(sessionName)}</span>
          <span class="size-badge">${sizeKB} KB</span>
        </div>
        <div class="image-popup-actions">
          <button onclick="app.openImageInNewTab('${escapeHtml(imageUrl)}')" title="Open in new tab">↗</button>
          <button onclick="app.closeImagePopup('${escapeHtml(imageId)}')" title="Close">×</button>
        </div>
      </div>
      <div class="image-popup-body">
        <img src="${imageUrl}" alt="${escapeHtml(fileName)}"
             onerror="this.parentElement.innerHTML='<div class=\\'image-error\\'>Failed to load image</div>'"
             onclick="app.openImageInNewTab('${escapeHtml(imageUrl)}')" />
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.image-popup-header'));

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.imagePopupZIndex;
    });

    // Store reference
    this.imagePopups.set(imageId, {
      element: win,
      sessionId,
      filePath,
      dragListeners,
    });
  },

  /**
   * Close an image popup window.
   */
  closeImagePopup(imageId) {
    const popupData = this.imagePopups.get(imageId);
    if (!popupData) return;

    // Clean up drag event listeners (both document-level and handle-level)
    if (popupData.dragListeners) {
      document.removeEventListener('mousemove', popupData.dragListeners.move);
      document.removeEventListener('mouseup', popupData.dragListeners.up);
      if (popupData.dragListeners.touchMove) {
        document.removeEventListener('touchmove', popupData.dragListeners.touchMove);
        document.removeEventListener('touchend', popupData.dragListeners.up);
        document.removeEventListener('touchcancel', popupData.dragListeners.up);
      }
      if (popupData.dragListeners.handle) {
        popupData.dragListeners.handle.removeEventListener('mousedown', popupData.dragListeners.handleMouseDown);
        popupData.dragListeners.handle.removeEventListener('touchstart', popupData.dragListeners.handleTouchStart);
      }
    }

    // Remove element
    popupData.element.remove();

    // Remove from map
    this.imagePopups.delete(imageId);
  },

  /**
   * Open image in a new browser tab.
   */
  openImageInNewTab(url) {
    window.open(url, '_blank');
  },

  /**
   * Close all image popups for a session.
   */
  closeSessionImagePopups(sessionId) {
    const toClose = [];
    for (const [imageId, data] of this.imagePopups) {
      if (data.sessionId === sessionId) {
        toClose.push(imageId);
      }
    }
    for (const imageId of toClose) {
      this.closeImagePopup(imageId);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Mux Sessions (in Monitor Panel)
  // ═══════════════════════════════════════════════════════════════

  async loadMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions');
      const data = await res.json();
      this.muxSessions = data.sessions || [];
      this.renderMuxSessions();
    } catch (err) {
      console.error('Failed to load mux sessions:', err);
    }
  },

  killAllMuxSessions() {
    const count = this.muxSessions?.length || 0;
    if (count === 0) {
      alert('No sessions to kill');
      return;
    }

    // Show the kill all modal
    document.getElementById('killAllCount').textContent = count;
    const modal = document.getElementById('killAllModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  closeKillAllModal() {
    document.getElementById('killAllModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  },

  async confirmKillAll(killMux) {
    this.closeKillAllModal();

    try {
      if (killMux) {
        // Kill everything including tmux sessions
        const res = await fetch('/api/sessions', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          this.sessions.clear();
          this.muxSessions = [];
          this.activeSessionId = null;
          try { localStorage.removeItem('codeman-active-session'); } catch {}
          this.renderSessionTabs();
          this.renderMuxSessions();
          this.terminal.clear();
          this.terminal.reset();
          this.toast('All sessions and tmux killed', 'success');
        }
      } else {
        // Just remove tabs, keep mux sessions running
        this.sessions.clear();
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        this.renderSessionTabs();
        this.terminal.clear();
        this.terminal.reset();
        this.toast('All tabs removed, tmux still running', 'info');
      }
    } catch (err) {
      console.error('Failed to kill sessions:', err);
      this.toast('Failed to kill sessions: ' + err.message, 'error');
    }
  },


  renderMuxSessions() {
    this._debouncedCall('muxSessions', this._renderMuxSessionsImmediate);
  },

  _renderMuxSessionsImmediate() {
    const body = document.getElementById('muxSessionsBody');

    if (!this.muxSessions || this.muxSessions.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No mux sessions</div>';
      return;
    }

    let html = '';
    for (const muxSession of this.muxSessions) {
      const stats = muxSession.stats || { memoryMB: 0, cpuPercent: 0, childCount: 0 };

      // Look up rich session data by sessionId
      const session = this.sessions.get(muxSession.sessionId);
      const status = session ? session.status : 'unknown';
      const isWorking = session ? session.isWorking : false;

      // Status badge
      let statusLabel, statusClass;
      if (status === 'idle' && !isWorking) {
        statusLabel = 'IDLE';
        statusClass = 'status-idle';
      } else if (status === 'busy' || isWorking) {
        statusLabel = 'WORKING';
        statusClass = 'status-working';
      } else if (status === 'stopped') {
        statusLabel = 'STOPPED';
        statusClass = 'status-stopped';
      } else {
        statusLabel = status.toUpperCase();
        statusClass = '';
      }

      // Token and cost info
      const tokens = session && session.tokens ? session.tokens : null;
      const totalCost = session ? session.totalCost : 0;
      const model = session ? (session.cliModel || '') : '';
      const modelShort = model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : model.includes('haiku') ? 'haiku' : '';

      // Ralph/Todo progress
      const todoStats = session ? session.ralphTodoStats : null;
      let todoHtml = '';
      if (todoStats && todoStats.total > 0) {
        const pct = Math.round((todoStats.completed / todoStats.total) * 100);
        todoHtml = `<span class="process-stat todo-progress">${todoStats.completed}/${todoStats.total} (${pct}%)</span>`;
      }

      // Format tokens
      let tokenHtml = '';
      if (tokens && tokens.total > 0) {
        const totalK = (tokens.total / 1000).toFixed(1);
        tokenHtml = `<span class="process-stat tokens">${totalK}k tok</span>`;
      }

      // Format cost
      let costHtml = '';
      if (totalCost > 0) {
        costHtml = `<span class="process-stat cost">$${totalCost.toFixed(2)}</span>`;
      }

      // Model badge
      let modelHtml = '';
      if (modelShort) {
        modelHtml = `<span class="monitor-model-badge ${modelShort}">${modelShort}</span>`;
      }

      const sid = escapeHtml(muxSession.sessionId);
      html += `
        <div class="process-item process-item-clickable" onclick="app.selectSession('${sid}')" title="Switch to session">
          <span class="monitor-status-badge ${statusClass}">${statusLabel}</span>
          <div class="process-info">
            <div class="process-name">${modelHtml} ${escapeHtml(muxSession.name || muxSession.muxName)}</div>
            <div class="process-meta">
              ${tokenHtml}
              ${costHtml}
              ${todoHtml}
              <span class="process-stat memory">${stats.memoryMB}MB</span>
              <span class="process-stat cpu">${stats.cpuPercent}%</span>
            </div>
          </div>
          <div class="process-actions">
            <button class="btn-toolbar btn-sm btn-danger" onclick="event.stopPropagation(); app.killMuxSession('${sid}')" title="Kill session">Kill</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  },

  renderMonitorSubagents() {
    const body = document.getElementById('monitorSubagentsBody');
    const stats = document.getElementById('monitorSubagentStats');
    if (!body) return;

    const subagents = Array.from(this.subagents.values());
    const activeCount = subagents.filter(s => s.status === 'active' || s.status === 'idle').length;

    if (stats) {
      stats.textContent = `${subagents.length} tracked` + (activeCount > 0 ? `, ${activeCount} active` : '');
    }

    if (subagents.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No background agents</div>';
      return;
    }

    let html = '';
    for (const agent of subagents) {
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const modelBadge = agent.modelShort ? `<span class="model-badge ${agent.modelShort}">${agent.modelShort}</span>` : '';
      const desc = agent.description ? escapeHtml(agent.description.substring(0, 40)) : agent.agentId;

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${desc}</div>
            <div class="process-meta">
              <span>ID: ${agent.agentId}</span>
              <span>${agent.toolCallCount || 0} tools</span>
            </div>
          </div>
          <div class="process-actions">
            ${agent.status !== 'completed' ? `<button class="btn-toolbar btn-sm btn-danger" onclick="app.killSubagent('${escapeHtml(agent.agentId)}')" title="Kill agent">Kill</button>` : ''}
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  },

  async killMuxSession(sessionId) {
    if (!confirm('Kill this mux session?')) return;

    try {
      // Use closeSession to properly clean up both the session tab and tmux process
      // (closeSession handles its own toast messaging)
      await this.closeSession(sessionId, true);
    } catch (err) {
      // Fallback: kill mux directly if session cleanup fails
      try { await fetch(`/api/mux-sessions/${sessionId}`, { method: 'DELETE' }); } catch (_ignored) {}
      this.showToast('Tmux session killed', 'success');
    }
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== sessionId);
    this.renderMuxSessions();
  },

  async reconcileMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions/reconcile', { method: 'POST' });
      const data = await res.json();

      if (data.dead && data.dead.length > 0) {
        this.showToast(`Found ${data.dead.length} dead mux session(s)`, 'warning');
        await this.loadMuxSessions();
      } else {
        this.showToast('All mux sessions are alive', 'success');
      }
    } catch (err) {
      this.showToast('Failed to reconcile mux sessions', 'error');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Toast
  // ═══════════════════════════════════════════════════════════════

  toggleNotifications() {
    this.notificationManager?.toggleDrawer();
  },

  // Alias for showToast
  toast(message, type = 'info') {
    return this.showToast(message, type);
  },

  showToast(message, type = 'info', opts = {}) {
    const { duration = 3000, action } = opts;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = 'margin-left:12px;padding:2px 10px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:3px;color:inherit;cursor:pointer;font-size:12px';
      btn.onclick = (e) => { e.stopPropagation(); action.onClick(); toast.remove(); };
      toast.appendChild(btn);
    }

    // Cache toast container reference
    if (!this._toastContainer) {
      this._toastContainer = document.querySelector('.toast-container');
      if (!this._toastContainer) {
        this._toastContainer = document.createElement('div');
        this._toastContainer.className = 'toast-container';
        document.body.appendChild(this._toastContainer);
      }
    }
    this._toastContainer.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }, duration);
  },


  // ═══════════════════════════════════════════════════════════════
  // System Stats
  // ═══════════════════════════════════════════════════════════════

  startSystemStatsPolling() {
    // Clear any existing interval to prevent duplicates
    this.stopSystemStatsPolling();

    // Initial fetch
    this.fetchSystemStats();

    // Poll every 2 seconds
    this.systemStatsInterval = setInterval(() => {
      this.fetchSystemStats();
    }, 2000);
  },

  stopSystemStatsPolling() {
    if (this.systemStatsInterval) {
      clearInterval(this.systemStatsInterval);
      this.systemStatsInterval = null;
    }
  },

  async fetchSystemStats() {
    // Skip polling when system stats display is hidden
    const statsEl = document.getElementById('headerSystemStats');
    if (!statsEl || statsEl.style.display === 'none') return;

    try {
      const res = await fetch('/api/system/stats');
      const stats = await res.json();
      this.updateSystemStatsDisplay(stats);
    } catch (err) {
      // Silently fail - system stats are not critical
    }
  },

  updateSystemStatsDisplay(stats) {
    const cpuEl = this.$('statCpu');
    const cpuBar = this.$('statCpuBar');
    const memEl = this.$('statMem');
    const memBar = this.$('statMemBar');

    if (cpuEl && cpuBar) {
      cpuEl.textContent = `${stats.cpu}%`;
      cpuBar.style.width = `${Math.min(100, stats.cpu)}%`;

      // Color classes based on usage
      cpuBar.classList.remove('medium', 'high');
      cpuEl.classList.remove('high');
      if (stats.cpu > 80) {
        cpuBar.classList.add('high');
        cpuEl.classList.add('high');
      } else if (stats.cpu > 50) {
        cpuBar.classList.add('medium');
      }
    }

    if (memEl && memBar) {
      const memGB = (stats.memory.usedMB / 1024).toFixed(1);
      memEl.textContent = `${memGB}G`;
      memBar.style.width = `${Math.min(100, stats.memory.percent)}%`;

      // Color classes based on usage
      memBar.classList.remove('medium', 'high');
      memEl.classList.remove('high');
      if (stats.memory.percent > 80) {
        memBar.classList.add('high');
        memEl.classList.add('high');
      } else if (stats.memory.percent > 50) {
        memBar.classList.add('medium');
      }
    }
  },
});
