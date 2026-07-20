/**
 * @fileoverview Multi-user frontend: identity boot, admin Users panel, the
 * change-password flow, and the full Admin Panel modal (user CRUD, per-user
 * permissions, case-folder management) opened by the header Admin Panel button
 * (#adminPanelBtn, revealed for admins in multi-user mode). Self-contained
 * (builds its own DOM) so it needs no index.html surgery beyond the script tag
 * and button; integrates with the existing App Settings modal by injecting a
 * "Users" tab (admins in multi-user mode only). Live-refreshes on the SSE
 * admin:usersChanged event (wired in app.js → window.codemanAdmin.onUsersChanged).
 *
 * @dependency app.js (window.app), settings-ui.js (App Settings modal + tab switch)
 * @loadorder after settings-ui.js / ultracode-panel.js, before session-ui.js
 *
 * In single-user mode GET /api/me returns a synthetic admin with multiUser:false,
 * so none of the admin UI is shown and behavior is unchanged.
 */
(function () {
  'use strict';

  const unwrap = (body) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

  async function apiGet(path) {
    const res = await window.fetch(path, { headers: { Accept: 'application/json' } });
    return unwrap(await res.json());
  }
  async function apiSend(method, path, body) {
    const res = await window.fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { ok: res.ok, status: res.status, body: json, data: unwrap(json) };
  }

  // ── Change-password modal ─────────────────────────────────────────────────
  let cpModal = null;
  function buildChangePasswordModal() {
    if (cpModal) return cpModal;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'changePasswordModal';
    el.style.zIndex = '3100';
    el.innerHTML = `
      <div class="modal-content" style="max-width:420px">
        <div class="modal-header"><h2>Change Password</h2></div>
        <div class="modal-body">
          <p id="cpMustNote" class="form-hint" style="display:none;color:var(--warning,#c80)">
            You must change your password before continuing.</p>
          <div class="form-row"><label>Current password</label>
            <input type="password" id="cpCurrent" class="form-input" autocomplete="current-password"></div>
          <div class="form-row"><label>New password (min 8)</label>
            <input type="password" id="cpNew" class="form-input" autocomplete="new-password"></div>
          <div class="form-row"><label>Confirm new password</label>
            <input type="password" id="cpConfirm" class="form-input" autocomplete="new-password"></div>
          <p id="cpError" style="color:var(--error,#c33);min-height:1.2em"></p>
        </div>
        <div class="modal-footer">
          <button class="btn" id="cpCancel">Cancel</button>
          <button class="btn btn-primary" id="cpSubmit">Change password</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#cpCancel').onclick = () => (el.style.display = 'none');
    el.querySelector('#cpSubmit').onclick = async () => {
      const current = el.querySelector('#cpCurrent').value;
      const nw = el.querySelector('#cpNew').value;
      const confirm = el.querySelector('#cpConfirm').value;
      const err = el.querySelector('#cpError');
      err.textContent = '';
      if (nw.length < 8) return (err.textContent = 'New password must be at least 8 characters.');
      if (nw !== confirm) return (err.textContent = 'Passwords do not match.');
      const r = await apiSend('POST', '/api/me/password', { currentPassword: current, newPassword: nw });
      if (!r.ok) return (err.textContent = (r.body && r.body.error) || 'Change failed.');
      el.style.display = 'none';
      if (window.app && window.app.showToast) window.app.showToast('Password changed');
    };
    cpModal = el;
    return el;
  }
  function openChangePassword(forced) {
    const el = buildChangePasswordModal();
    el.querySelector('#cpMustNote').style.display = forced ? '' : 'none';
    el.querySelector('#cpCancel').style.display = forced ? 'none' : '';
    el.querySelector('#cpError').textContent = '';
    el.style.display = 'flex';
  }

  // ── Fetch interceptor: surface PASSWORD_CHANGE_REQUIRED ───────────────────
  function installInterceptor() {
    const orig = window.fetch;
    window.fetch = async function (...args) {
      const res = await orig.apply(this, args);
      if (res.status === 403) {
        try {
          const clone = res.clone();
          const j = await clone.json();
          if (j && j.errorCode === 'PASSWORD_CHANGE_REQUIRED') openChangePassword(true);
        } catch {
          /* not JSON */
        }
      }
      return res;
    };
  }

  // ── Admin Users panel (injected into the App Settings modal) ──────────────
  function injectUsersTab() {
    const modal = document.getElementById('appSettingsModal');
    if (!modal || modal.querySelector('[data-tab="settings-users"]')) return;
    const tabs = modal.querySelector('.modal-tabs');
    const body = modal.querySelector('.modal-body');
    if (!tabs || !body) return;
    const btn = document.createElement('button');
    btn.className = 'modal-tab-btn';
    btn.dataset.tab = 'settings-users';
    btn.textContent = 'Users';
    tabs.appendChild(btn);
    const content = document.createElement('div');
    content.className = 'modal-tab-content hidden';
    content.id = 'settings-users';
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>Users</strong>
        <span>
          <button class="btn btn-sm" id="adminOpenPanel">Open Admin Panel</button>
          <button class="btn btn-sm" id="adminAddUser">+ Add user</button>
        </span>
      </div>
      <p class="form-hint">Users share the host account; this separates workspaces, it does not sandbox
        users from each other. Pair with Docker cases for isolation.</p>
      <div id="adminUsersTable"></div>
      <p id="adminUsersMsg" style="min-height:1.2em;color:var(--muted,#888)"></p>`;
    body.appendChild(content);
    // Render whenever the tab is shown (the shared switchSettingsTab toggles it).
    btn.addEventListener('click', renderUsers);
    content.querySelector('#adminAddUser').onclick = addUserFlow;
    content.querySelector('#adminOpenPanel').onclick = openAdminPanel;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  async function renderUsers() {
    const table = document.getElementById('adminUsersTable');
    if (!table) return;
    table.innerHTML = 'Loading…';
    let users;
    try {
      users = await apiGet('/api/admin/users');
    } catch {
      table.innerHTML = 'Failed to load users.';
      return;
    }
    const rows = users
      .map((u) => {
        const flags = [
          u.role === 'admin' ? 'admin' : 'user',
          u.disabled ? 'disabled' : 'enabled',
          u.canBypassPermissions ? 'can-bypass' : '',
          u.mustChangePassword ? 'must-change-pw' : '',
        ]
          .filter(Boolean)
          .join(', ');
        const st = u.stats || {};
        return `<tr data-u="${esc(u.username)}">
          <td>${esc(u.username)}</td>
          <td style="font-size:.85em;color:var(--muted,#888)">${esc(flags)}</td>
          <td style="font-size:.85em">${st.liveSessions ?? 0} live · ${st.caseCount ?? 0} cases</td>
          <td style="white-space:nowrap">
            <button class="btn btn-xs" data-act="role">${u.role === 'admin' ? 'Demote' : 'Promote'}</button>
            <button class="btn btn-xs" data-act="disabled">${u.disabled ? 'Enable' : 'Disable'}</button>
            <button class="btn btn-xs" data-act="bypass">${u.canBypassPermissions ? 'Revoke bypass' : 'Grant bypass'}</button>
            <button class="btn btn-xs" data-act="reset">Reset pw</button>
            <button class="btn btn-xs" data-act="delete">Delete</button>
          </td></tr>`;
      })
      .join('');
    table.innerHTML = `<table style="width:100%;border-collapse:collapse" class="admin-users">
      <thead><tr><th align="left">User</th><th align="left">Flags</th><th align="left">Usage</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    table.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () =>
        userAction(
          b.closest('tr').dataset.u,
          b.dataset.act,
          users.find((x) => x.username === b.closest('tr').dataset.u)
        );
    });
  }

  function setMsg(t) {
    const m = document.getElementById('adminUsersMsg');
    if (m) m.textContent = t || '';
  }

  async function userAction(username, act, u) {
    if (act === 'role') {
      const r = await apiSend('PATCH', `/api/admin/users/${encodeURIComponent(username)}`, {
        role: u.role === 'admin' ? 'user' : 'admin',
      });
      setMsg(r.ok ? `Updated ${username}.` : (r.body && r.body.error) || 'Failed.');
    } else if (act === 'disabled') {
      const r = await apiSend('PATCH', `/api/admin/users/${encodeURIComponent(username)}`, { disabled: !u.disabled });
      setMsg(r.ok ? `Updated ${username}.` : (r.body && r.body.error) || 'Failed.');
    } else if (act === 'bypass') {
      const r = await apiSend('PATCH', `/api/admin/users/${encodeURIComponent(username)}`, {
        canBypassPermissions: !u.canBypassPermissions,
      });
      setMsg(r.ok ? `Updated ${username}.` : (r.body && r.body.error) || 'Failed.');
    } else if (act === 'reset') {
      if (!window.confirm(`Reset ${username}'s password? They must set a new one on next login.`)) return;
      const r = await apiSend('POST', `/api/admin/users/${encodeURIComponent(username)}/reset-password`);
      if (r.ok && r.data && r.data.oneTimePassword) {
        window.prompt(`One-time password for ${username} (copy it now — shown once):`, r.data.oneTimePassword);
      } else setMsg((r.body && r.body.error) || 'Reset failed.');
    } else if (act === 'delete') {
      const typed = window.prompt(`Type "${username}" to delete this user. Add " +space" to also delete their files.`);
      if (typed !== username && typed !== `${username} +space`) return setMsg('Delete cancelled.');
      const deleteSpace = typed.endsWith(' +space');
      const r = await apiSend('DELETE', `/api/admin/users/${encodeURIComponent(username)}`, { deleteSpace });
      setMsg(r.ok ? `Deleted ${username}.` : (r.body && r.body.error) || 'Delete failed.');
    }
    renderUsers();
  }

  async function addUserFlow() {
    const username = window.prompt('New username (lowercase, 2-32 chars, [a-z0-9_-]):');
    if (!username) return;
    const admin = window.confirm('Make this user an admin? (OK = admin, Cancel = regular user)');
    const r = await apiSend('POST', '/api/admin/users', { username: username.trim(), role: admin ? 'admin' : 'user' });
    if (r.ok && r.data && r.data.oneTimePassword) {
      window.prompt(`Created ${username}. One-time password (copy it now — shown once):`, r.data.oneTimePassword);
    } else setMsg((r.body && r.body.error) || 'Create failed.');
    renderUsers();
  }

  // ── Admin Panel (big header-button modal) ─────────────────────────────────
  let apModal = null;
  let apUsersCache = [];
  const apOpenDrawers = new Set(); // usernames with an expanded case-folder drawer

  function fmtDate(ts) {
    return ts ? new Date(ts).toLocaleString() : 'never';
  }
  function cssEsc(s) {
    return window.CSS && window.CSS.escape ? window.CSS.escape(s) : String(s).replace(/"/g, '\\"');
  }
  function apSetMsg(t) {
    const m = document.getElementById('apMsg');
    if (m) m.textContent = t || '';
  }

  function buildAdminPanel() {
    if (apModal) return apModal;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'adminPanelModal';
    el.style.zIndex = '3000';
    el.innerHTML = `
      <div class="modal-content" style="max-width:940px;width:min(96vw,940px)">
        <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <h2 style="display:flex;align-items:center;gap:8px;margin:0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            Admin Panel</h2>
          <span id="apIdentity" style="color:var(--text-muted,#888);font-size:.85em"></span>
        </div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>Users</strong>
            <button class="btn btn-sm btn-primary" id="apAddToggle">+ Add user</button>
          </div>
          <div id="apAddForm" style="display:none;border:1px solid var(--border,#333);border-radius:8px;padding:10px;margin-bottom:10px">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
              <div class="form-row" style="margin:0"><label>Username</label>
                <input id="apNewName" class="form-input" placeholder="lowercase a-z 0-9 _ -" style="width:170px"></div>
              <div class="form-row" style="margin:0"><label>Role</label>
                <select id="apNewRole" class="form-input" style="width:110px">
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select></div>
              <div class="form-row" style="margin:0"><label>Password (optional)</label>
                <input id="apNewPw" type="password" class="form-input" placeholder="blank = one-time pw"
                  style="width:170px" autocomplete="new-password"></div>
              <label style="display:flex;align-items:center;gap:5px;white-space:nowrap;margin-bottom:6px">
                <input type="checkbox" id="apNewBypass"> allow bypass permissions</label>
              <button class="btn btn-sm btn-primary" id="apCreateUser" style="margin-bottom:2px">Create</button>
            </div>
            <p class="form-hint" style="margin:6px 0 0">Without a password a one-time password is generated and shown
              once; the user must change it on first login. "Bypass" allows shell sessions, cron launch commands, and
              skip-permissions agents.</p>
          </div>
          <div id="apOtp" style="display:none;border:1px solid var(--accent,#38b6f0);border-radius:8px;padding:10px;margin-bottom:10px"></div>
          <div id="apTable">Loading…</div>
          <p class="form-hint" style="margin-top:10px">Users share the host OS account: this separates workspaces, it
            does not sandbox users from each other. Pair with Docker cases for isolation.</p>
          <p id="apMsg" style="min-height:1.2em;color:var(--text-muted,#888)"></p>
        </div>
        <div class="modal-footer">
          <button class="btn" id="apClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#apClose').onclick = () => (el.style.display = 'none');
    el.addEventListener('click', (e) => {
      if (e.target === el) el.style.display = 'none';
    });
    el.querySelector('#apAddToggle').onclick = () => {
      const f = el.querySelector('#apAddForm');
      f.style.display = f.style.display === 'none' ? '' : 'none';
      if (f.style.display === '') f.querySelector('#apNewName').focus();
    };
    el.querySelector('#apCreateUser').onclick = createUserFromForm;
    apModal = el;
    return el;
  }

  function showOneTimePassword(username, otp) {
    const box = document.getElementById('apOtp');
    if (!box) return;
    box.style.display = '';
    box.innerHTML = `One-time password for <strong>${esc(username)}</strong> (shown once, copy it now):
      <code style="user-select:all;font-size:1.05em;margin:0 8px">${esc(otp)}</code>
      <button class="btn btn-xs" id="apOtpCopy">Copy</button>
      <button class="btn btn-xs" id="apOtpDismiss">Dismiss</button>`;
    box.querySelector('#apOtpCopy').onclick = () => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(otp).then(() => apSetMsg('Password copied to clipboard.'));
      }
    };
    box.querySelector('#apOtpDismiss').onclick = () => {
      box.style.display = 'none';
      box.innerHTML = '';
    };
  }

  async function createUserFromForm() {
    const name = (document.getElementById('apNewName').value || '').trim().toLowerCase();
    const role = document.getElementById('apNewRole').value;
    const pw = document.getElementById('apNewPw').value;
    const bypass = document.getElementById('apNewBypass').checked;
    if (!name) return apSetMsg('Enter a username.');
    const body = { username: name, role };
    if (pw) body.password = pw;
    if (bypass) body.canBypassPermissions = true;
    const r = await apiSend('POST', '/api/admin/users', body);
    if (!r.ok) return apSetMsg((r.body && r.body.error) || 'Create failed.');
    document.getElementById('apNewName').value = '';
    document.getElementById('apNewPw').value = '';
    document.getElementById('apNewBypass').checked = false;
    apSetMsg(`Created ${name}.`);
    if (r.data && r.data.oneTimePassword) showOneTimePassword(name, r.data.oneTimePassword);
    renderPanel();
  }

  async function renderPanel() {
    const table = document.getElementById('apTable');
    if (!table) return;
    let users;
    try {
      users = await apiGet('/api/admin/users');
    } catch {
      table.innerHTML = 'Failed to load users.';
      return;
    }
    apUsersCache = users;
    const meName = (window.__codemanUser || {}).username;
    const rows = users
      .map((u) => {
        const st = u.stats || {};
        const you = u.username === meName ? ' <span style="color:var(--accent,#38b6f0)">(you)</span>' : '';
        const role = `<span style="font-weight:600;color:${
          u.role === 'admin' ? 'var(--accent,#38b6f0)' : 'var(--text-muted,#888)'
        }">${u.role}</span>`;
        const status = u.disabled
          ? '<span style="color:var(--red,#c33)">disabled</span>'
          : '<span style="color:var(--accent-soft,#4b9)">enabled</span>';
        const pwFlag = u.mustChangePassword ? ' · must-change-pw' : '';
        return `<tr data-u="${esc(u.username)}">
          <td><strong>${esc(u.username)}</strong>${you}</td>
          <td>${role}</td>
          <td>${status}${pwFlag}</td>
          <td>${u.canBypassPermissions ? 'yes' : 'no'}</td>
          <td style="white-space:nowrap">${st.liveSessions ?? 0} live · ${st.activeSessions ?? 0} logins ·
            <button class="btn btn-xs" data-act="cases">${st.caseCount ?? 0} cases</button></td>
          <td style="font-size:.85em;color:var(--text-muted,#888)">${fmtDate(u.lastLoginAt)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-xs" data-act="role">${u.role === 'admin' ? 'Demote' : 'Promote'}</button>
            <button class="btn btn-xs" data-act="disabled">${u.disabled ? 'Enable' : 'Disable'}</button>
            <button class="btn btn-xs" data-act="bypass">${u.canBypassPermissions ? 'Revoke bypass' : 'Grant bypass'}</button>
            <button class="btn btn-xs" data-act="reset">Reset pw</button>
            <button class="btn btn-xs" data-act="logout">Logout</button>
            <button class="btn btn-xs" data-act="delete" style="color:var(--red,#c33)">Delete</button>
          </td></tr>
          <tr data-drawer="${esc(u.username)}" style="display:none"><td colspan="7"></td></tr>`;
      })
      .join('');
    table.innerHTML = `<table style="width:100%;border-collapse:collapse" class="admin-users">
      <thead><tr>
        <th align="left">User</th><th align="left">Role</th><th align="left">Status</th>
        <th align="left">Bypass</th><th align="left">Activity</th><th align="left">Last login</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>`;
    table.querySelectorAll('button[data-act]').forEach((b) => {
      const username = b.closest('tr').dataset.u;
      b.onclick = () => {
        if (b.dataset.act === 'cases') return toggleCaseDrawer(username);
        return panelAction(
          username,
          b.dataset.act,
          apUsersCache.find((x) => x.username === username)
        );
      };
    });
    // Re-open drawers that were expanded before this refresh.
    for (const name of [...apOpenDrawers]) {
      if (users.some((u) => u.username === name)) void renderCaseDrawer(name);
      else apOpenDrawers.delete(name);
    }
  }

  async function panelAction(username, act, u) {
    const path = `/api/admin/users/${encodeURIComponent(username)}`;
    if (act === 'role') {
      const r = await apiSend('PATCH', path, { role: u.role === 'admin' ? 'user' : 'admin' });
      apSetMsg(r.ok ? `Updated ${username}.` : (r.body && r.body.error) || 'Failed.');
    } else if (act === 'disabled') {
      const r = await apiSend('PATCH', path, { disabled: !u.disabled });
      apSetMsg(r.ok ? `Updated ${username}.` : (r.body && r.body.error) || 'Failed.');
    } else if (act === 'bypass') {
      const r = await apiSend('PATCH', path, { canBypassPermissions: !u.canBypassPermissions });
      apSetMsg(r.ok ? `Updated ${username}.` : (r.body && r.body.error) || 'Failed.');
    } else if (act === 'reset') {
      if (!window.confirm(`Reset ${username}'s password? They must set a new one on next login.`)) return;
      const r = await apiSend('POST', `${path}/reset-password`);
      if (r.ok && r.data && r.data.oneTimePassword) showOneTimePassword(username, r.data.oneTimePassword);
      else if (!r.ok) apSetMsg((r.body && r.body.error) || 'Reset failed.');
    } else if (act === 'logout') {
      const r = await apiSend('POST', `${path}/logout`);
      apSetMsg(r.ok ? `Revoked ${(r.data && r.data.revoked) || 0} login session(s) for ${username}.` : 'Failed.');
    } else if (act === 'delete') {
      if (!window.confirm(`Delete user "${username}"? Their live sessions are killed and logins revoked.`)) return;
      const deleteSpace = window.confirm(
        `Also delete ${username}'s files (their cases/workspace folder)?\nOK = delete files too, Cancel = keep files on disk.`
      );
      const r = await apiSend('DELETE', path, { deleteSpace });
      apSetMsg(r.ok ? `Deleted ${username}.` : (r.body && r.body.error) || 'Delete failed.');
    }
    renderPanel();
  }

  async function toggleCaseDrawer(username) {
    if (apOpenDrawers.has(username)) {
      apOpenDrawers.delete(username);
      const row = apModal && apModal.querySelector(`tr[data-drawer="${cssEsc(username)}"]`);
      if (row) row.style.display = 'none';
      return;
    }
    apOpenDrawers.add(username);
    await renderCaseDrawer(username);
  }

  async function renderCaseDrawer(username) {
    const row = apModal && apModal.querySelector(`tr[data-drawer="${cssEsc(username)}"]`);
    if (!row) return;
    row.style.display = '';
    const cell = row.firstElementChild;
    cell.innerHTML = 'Loading folders…';
    let data;
    try {
      data = await apiGet(`/api/admin/users/${encodeURIComponent(username)}/cases`);
    } catch {
      cell.innerHTML = 'Failed to load case folders.';
      return;
    }
    const items = (data.cases || [])
      .map(
        (c) => `
      <li style="display:flex;gap:10px;align-items:center;padding:2px 0">
        <code>${esc(c.name)}</code>
        <span style="color:var(--text-muted,#888);font-size:.85em">${fmtDate(c.modifiedAt)}</span>
        ${c.liveSessions ? `<span style="color:var(--yellow,#ca0)">${c.liveSessions} live session(s)</span>` : ''}
        <button class="btn btn-xs" data-case="${esc(c.name)}"
          ${c.liveSessions ? 'disabled title="In use by a live session"' : ''}>Delete</button>
      </li>`
      )
      .join('');
    cell.innerHTML = `<div style="padding:6px 4px 6px 16px">
      <div style="color:var(--text-muted,#888);font-size:.85em;margin-bottom:4px">${esc(data.dir || '')}</div>
      ${items ? `<ul style="list-style:none;margin:0;padding:0">${items}</ul>` : 'No case folders yet.'}
    </div>`;
    cell.querySelectorAll('button[data-case]').forEach((b) => {
      b.onclick = async () => {
        const name = b.dataset.case;
        if (!window.confirm(`Permanently delete ${username}'s case folder "${name}" and ALL files in it?`)) return;
        const r = await apiSend(
          'DELETE',
          `/api/admin/users/${encodeURIComponent(username)}/cases/${encodeURIComponent(name)}`
        );
        apSetMsg(r.ok ? `Deleted folder ${name}.` : (r.body && r.body.error) || 'Delete failed.');
        renderPanel();
      };
    });
  }

  function openAdminPanel() {
    const me = window.__codemanUser || {};
    if (!me.multiUser || me.role !== 'admin') return;
    const el = buildAdminPanel();
    el.querySelector('#apIdentity').textContent = `signed in as ${me.username} (admin)`;
    apSetMsg('');
    el.style.display = 'flex';
    renderPanel();
  }

  /** SSE admin:usersChanged: live-refresh whichever admin views are visible. */
  function onUsersChanged() {
    if (apModal && apModal.style.display === 'flex') renderPanel();
    const tab = document.getElementById('settings-users');
    if (tab && !tab.classList.contains('hidden')) renderUsers();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  async function boot() {
    installInterceptor();
    let me = null;
    try {
      me = await apiGet('/api/me');
    } catch {
      /* server may be pre-auth */
    }
    window.__codemanUser = me || { username: 'admin', role: 'admin', multiUser: false };
    document.dispatchEvent(new CustomEvent('codeman:me', { detail: window.__codemanUser }));
    if (window.__codemanUser.mustChangePassword) openChangePassword(true);
    if (window.__codemanUser.multiUser && window.__codemanUser.role === 'admin') {
      injectUsersTab();
      // Reveal the big header Admin Panel button (template ships it hidden).
      const btn = document.getElementById('adminPanelBtn');
      if (btn) btn.classList.remove('btn-admin-panel--hidden');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.codemanAdmin = { openChangePassword, renderUsers, openAdminPanel, onUsersChanged };
})();
