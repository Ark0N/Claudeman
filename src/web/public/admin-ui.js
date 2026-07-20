/**
 * @fileoverview Multi-user frontend: identity boot, admin Users panel, and the
 * change-password flow. Self-contained (builds its own DOM) so it needs no
 * index.html surgery beyond the script tag and integrates with the existing App
 * Settings modal by injecting a "Users" tab (admins in multi-user mode only).
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
        <button class="btn btn-sm" id="adminAddUser">+ Add user</button>
      </div>
      <p class="form-hint">Users share the host account; this separates workspaces, it does not sandbox
        users from each other. Pair with Docker cases for isolation.</p>
      <div id="adminUsersTable"></div>
      <p id="adminUsersMsg" style="min-height:1.2em;color:var(--muted,#888)"></p>`;
    body.appendChild(content);
    // Render whenever the tab is shown (the shared switchSettingsTab toggles it).
    btn.addEventListener('click', renderUsers);
    content.querySelector('#adminAddUser').onclick = addUserFlow;
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
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.codemanAdmin = { openChangePassword, renderUsers };
})();
