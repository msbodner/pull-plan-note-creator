'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser  = null;
let editingUser  = null;
let editingTrade = null;
const _userCache    = {};   // id → user object
const _tradeCache   = {};   // id → trade object
const _sessionCache = {};   // id → session object (with parsed tasks)

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    currentUser = me;
    if (!['admin','sysadmin'].includes(me.role)) {
      window.location.href = '/app.html';
      return;
    }
    document.getElementById('userAvatar').textContent = me.username.charAt(0).toUpperCase();
    document.getElementById('userName').textContent   = me.full_name || me.username;

    // Show sysadmin-only tabs
    if (me.role === 'sysadmin') {
      document.querySelectorAll('.sysadmin-only').forEach(el => el.style.display = '');
    }

    await Promise.all([loadUsers(), loadTrades()]);
  } catch {
    window.location.href = '/login.html';
  }
})();

// ── API helper ────────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  if (res.status === 401) { window.location.href = '/login.html'; throw new Error('Unauth'); }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = '') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type ? 'toast-' + type : ''}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-btn').forEach(b  => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'data')     loadAllSessions();
  if (name === 'history')  loadSessionHistory();
  if (name === 'settings') loadSettings();
}

// ── Escape HTML ───────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// ═══════════════════════════════════════════════════════════════════
// USERS CRUD
// ═══════════════════════════════════════════════════════════════════
async function loadUsers() {
  try {
    const users = await apiFetch('/api/users');
    renderUsersTable(users);
  } catch (e) { toast(e.message, 'error'); }
}

function renderUsersTable(users) {
  const roleBadge = { sysadmin: 'badge-red', admin: 'badge-blue', user: 'badge-gray' };
  const roleLabel = { sysadmin: 'Sys Admin', admin: 'Admin', user: 'User' };

  users.forEach(u => { _userCache[u.id] = u; });

  document.getElementById('usersBody').innerHTML = users.map(u => `
    <tr>
      <td><strong>${escHtml(u.username)}</strong></td>
      <td>${escHtml(u.full_name)}</td>
      <td>${escHtml(u.email)}</td>
      <td><span class="badge ${roleBadge[u.role] || 'badge-gray'}">${roleLabel[u.role] || u.role}</span></td>
      <td>${u.active ? '<span class="badge badge-green">Yes</span>' : '<span class="badge badge-red">No</span>'}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td>
        <button class="btn btn-secondary btn-xs" onclick="openEditUser(${u.id})">Edit</button>
        ${u.id !== currentUser?.id
          ? `<button class="btn btn-danger btn-xs" onclick="confirmDelete('user',${u.id},'${escHtml(u.username)}')" style="margin-left:4px;">Del</button>`
          : '<span style="font-size:12px;color:var(--muted);margin-left:8px;">(you)</span>'}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No users found.</td></tr>';
}

function openAddUser() {
  editingUser = null;
  document.getElementById('userModalTitle').textContent = 'Add User';
  document.getElementById('uUsername').value  = '';
  document.getElementById('uFullName').value  = '';
  document.getElementById('uEmail').value     = '';
  document.getElementById('uPassword').value  = '';
  document.getElementById('uRole').value      = 'user';
  document.getElementById('uActive').value    = '1';
  document.getElementById('uPwHint').textContent = '(required)';
  document.getElementById('uUsername').disabled  = false;
  document.getElementById('userModalError').style.display = 'none';
  // Hide sysadmin option if current user is not sysadmin
  document.getElementById('sysadminOption').style.display = currentUser?.role === 'sysadmin' ? '' : 'none';
  openModal('userModal');
}

function openEditUser(id) {
  const u = _userCache[id];
  if (!u) return;
  editingUser = u;
  document.getElementById('userModalTitle').textContent = `Edit: ${u.username}`;
  document.getElementById('uUsername').value  = u.username;
  document.getElementById('uFullName').value  = u.full_name || '';
  document.getElementById('uEmail').value     = u.email || '';
  document.getElementById('uPassword').value  = '';
  document.getElementById('uRole').value      = u.role;
  document.getElementById('uActive').value    = String(u.active);
  document.getElementById('uPwHint').textContent = '(leave blank to keep current)';
  document.getElementById('uUsername').disabled  = true;
  document.getElementById('userModalError').style.display = 'none';
  document.getElementById('sysadminOption').style.display = currentUser?.role === 'sysadmin' ? '' : 'none';
  openModal('userModal');
}

async function saveUser() {
  const btn = document.getElementById('userSaveBtn');
  btn.disabled = true;
  const errEl  = document.getElementById('userModalError');
  errEl.style.display = 'none';

  const payload = {
    full_name: document.getElementById('uFullName').value.trim(),
    email:     document.getElementById('uEmail').value.trim(),
    role:      document.getElementById('uRole').value,
    active:    parseInt(document.getElementById('uActive').value),
  };
  const pw = document.getElementById('uPassword').value;
  if (pw) payload.password = pw;

  try {
    if (editingUser) {
      await apiFetch(`/api/users/${editingUser.id}`, { method:'PUT', body: JSON.stringify(payload) });
      toast('User updated', 'success');
    } else {
      const username = document.getElementById('uUsername').value.trim();
      if (!username) throw new Error('Username is required');
      if (!pw)       throw new Error('Password is required for new users');
      await apiFetch('/api/users', { method:'POST', body: JSON.stringify({ username, ...payload }) });
      toast('User created', 'success');
    }
    closeModal('userModal');
    await loadUsers();
  } catch (e) {
    errEl.textContent   = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// TRADES CRUD
// ═══════════════════════════════════════════════════════════════════
async function loadTrades() {
  try {
    const trades = await apiFetch('/api/trades');
    renderTradesTable(trades);
  } catch (e) { toast(e.message, 'error'); }
}

function renderTradesTable(trades) {
  trades.forEach(t => { _tradeCache[t.id] = t; });

  document.getElementById('tradesBody').innerHTML = trades.map(t => `
    <tr>
      <td><strong>${escHtml(t.name)}</strong></td>
      <td>
        <div class="trade-color-preview">
          <div class="color-chip" style="background:${escHtml(t.bg_color)};border-color:${escHtml(t.border_color)};"></div>
          <div style="background:${escHtml(t.border_color)};color:#fff;padding:2px 10px;border-radius:4px;font-size:12px;font-weight:600;">
            ${escHtml(t.name)}
          </div>
        </div>
      </td>
      <td><code style="font-size:12px;">${escHtml(t.bg_color)}</code></td>
      <td><code style="font-size:12px;">${escHtml(t.border_color)}</code></td>
      <td>${t.sort_order}</td>
      <td>
        <button class="btn btn-secondary btn-xs" onclick="openEditTrade(${t.id})">Edit</button>
        <button class="btn btn-danger btn-xs" onclick="confirmDelete('trade',${t.id},'${escHtml(t.name)}')" style="margin-left:4px;">Del</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">No trades found.</td></tr>';
}

function openAddTrade() {
  editingTrade = null;
  document.getElementById('tradeModalTitle').textContent = 'Add Trade';
  document.getElementById('tName').value        = '';
  document.getElementById('tBgColor').value     = '#EEEDE8';
  document.getElementById('tBorderColor').value = '#5F5E5A';
  document.getElementById('tTextColor').value   = '#2C2C2A';
  document.getElementById('tLabelColor').value  = '#5F5E5A';
  document.getElementById('tradeModalError').style.display = 'none';
  updateTradePreview();
  openModal('tradeModal');
}

function openEditTrade(id) {
  const t = _tradeCache[id];
  if (!t) return;
  editingTrade = t;
  document.getElementById('tradeModalTitle').textContent = `Edit: ${t.name}`;
  document.getElementById('tName').value        = t.name;
  document.getElementById('tBgColor').value     = t.bg_color;
  document.getElementById('tBorderColor').value = t.border_color;
  document.getElementById('tTextColor').value   = t.text_color;
  document.getElementById('tLabelColor').value  = t.label_color;
  document.getElementById('tradeModalError').style.display = 'none';
  updateTradePreview();
  openModal('tradeModal');
}

function updateTradePreview() {
  const name   = document.getElementById('tName').value || 'Trade Name';
  const bg     = document.getElementById('tBgColor').value;
  const border = document.getElementById('tBorderColor').value;
  const text   = document.getElementById('tTextColor').value;
  const prev   = document.getElementById('tradePreview');
  prev.style.background     = bg;
  prev.style.borderTopColor = border;
  document.getElementById('tPrevName').style.color = text;
  document.getElementById('tPrevName').textContent = name;
}

async function saveTrade() {
  const errEl = document.getElementById('tradeModalError');
  errEl.style.display = 'none';

  const payload = {
    name:         document.getElementById('tName').value.trim(),
    bg_color:     document.getElementById('tBgColor').value,
    border_color: document.getElementById('tBorderColor').value,
    text_color:   document.getElementById('tTextColor').value,
    label_color:  document.getElementById('tLabelColor').value
  };
  if (!payload.name) {
    errEl.textContent   = 'Trade name is required.';
    errEl.style.display = 'block';
    return;
  }
  try {
    if (editingTrade) {
      await apiFetch(`/api/trades/${editingTrade.id}`, { method:'PUT', body: JSON.stringify(payload) });
      toast('Trade updated', 'success');
    } else {
      await apiFetch('/api/trades', { method:'POST', body: JSON.stringify(payload) });
      toast('Trade created', 'success');
    }
    closeModal('tradeModal');
    await loadTrades();
  } catch (e) {
    errEl.textContent   = e.message;
    errEl.style.display = 'block';
  }
}

// ═══════════════════════════════════════════════════════════════════
// DELETE CONFIRM
// ═══════════════════════════════════════════════════════════════════
function confirmDelete(type, id, name) {
  document.getElementById('confirmText').textContent =
    `Delete ${type} "${name}"? This cannot be undone.`;
  const btn = document.getElementById('confirmDeleteBtn');
  btn.onclick = async () => {
    try {
      await apiFetch(`/api/${type === 'user' ? 'users' : 'trades'}/${id}`, { method:'DELETE' });
      toast(`${type === 'user' ? 'User' : 'Trade'} deleted`);
      closeModal('confirmModal');
      if (type === 'user')  await loadUsers();
      if (type === 'trade') await loadTrades();
    } catch (e) { toast(e.message, 'error'); }
  };
  openModal('confirmModal');
}

// ═══════════════════════════════════════════════════════════════════
// DATA ACCESS (SysAdmin)
// ═══════════════════════════════════════════════════════════════════
async function loadAllSessions() {
  try {
    const sessions = await apiFetch('/api/sessions/all');
    sessions.forEach(s => {
      _sessionCache[s.id] = { ...s, tasks: JSON.parse(s.tasks_json || '[]') };
    });
    document.getElementById('allSessionsBody').innerHTML = sessions.map(s => {
      const tasks = JSON.parse(s.tasks_json || '[]');
      return `
        <tr>
          <td>${s.id}</td>
          <td>${escHtml(s.username)}</td>
          <td>${escHtml(s.name)}</td>
          <td><button onclick="adminEditSession(${s.id})" style="background:none;border:none;cursor:pointer;padding:0;""><span class="badge badge-blue" style="cursor:pointer;text-decoration:underline;">${tasks.length} task${tasks.length !== 1 ? 's' : ''}</span></button></td>
          <td>${fmtDate(s.created_at)}</td>
          <td>${fmtDate(s.updated_at)}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-secondary btn-xs" onclick="adminEditSession(${s.id})">Edit</button>
            <button class="btn btn-danger btn-xs" onclick="adminDeleteSession(${s.id},'${escHtml(s.name)}')" style="margin-left:4px;">Del</button>
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No sessions found.</td></tr>';
  } catch (e) { toast(e.message, 'error'); }
}

// ── Edit session ──────────────────────────────────────────────────────────────
let _editingSessionId   = null;
let _editingSessionTasks = [];

function adminEditSession(id) {
  const s = _sessionCache[id];
  if (!s) return;
  _editingSessionId    = id;
  _editingSessionTasks = s.tasks.map(t => ({ ...t })); // clone

  document.getElementById('esName').value = s.name;
  renderEditTaskList();
  openModal('editSessionModal');
}

function renderEditTaskList() {
  const container = document.getElementById('esTaskList');
  if (!_editingSessionTasks.length) {
    container.innerHTML = '<p style="font-size:13px;color:var(--muted);font-style:italic;padding:8px 0;">No tasks in this session.</p>';
    return;
  }
  container.innerHTML = _editingSessionTasks.map((t, i) => `
    <div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:12px 14px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <span class="badge badge-blue" style="font-size:11px;flex-shrink:0;">${escHtml(t.trade || '—')}</span>
        <button class="btn btn-danger btn-xs" onclick="removeEditTask(${i})" style="flex-shrink:0;">&#10005; Remove</button>
      </div>
      <div class="grid-2" style="gap:10px;">
        <div class="field" style="grid-column:1/-1;margin-bottom:0;">
          <label>Task Title</label>
          <input type="text" value="${escHtml(t.title || '')}"
            oninput="_editingSessionTasks[${i}].title = this.value"
            style="font-size:13px;padding:7px 10px;" />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Start Date</label>
          <input type="date" value="${escHtml(t.start_date || '')}"
            oninput="_editingSessionTasks[${i}].start_date = this.value"
            style="font-size:13px;padding:7px 10px;" />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Duration (Days)</label>
          <input type="number" min="1" value="${t.duration || ''}"
            oninput="_editingSessionTasks[${i}].duration = parseInt(this.value)||this.value"
            style="font-size:13px;padding:7px 10px;" />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Crew Size</label>
          <input type="number" min="1" value="${t.crew_size || ''}"
            oninput="_editingSessionTasks[${i}].crew_size = parseInt(this.value)||this.value"
            style="font-size:13px;padding:7px 10px;" />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Status</label>
          <select onchange="_editingSessionTasks[${i}].status = this.value"
            style="font-size:13px;padding:7px 10px;">
            ${['Open','In progress','Work done','Complete','Incomplete','Backlog','Blocked'].map(st =>
              `<option${t.status === st ? ' selected' : ''}>${st}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="grid-column:1/-1;margin-bottom:0;">
          <label>Notes / Description</label>
          <textarea rows="2"
            oninput="_editingSessionTasks[${i}].description = this.value"
            style="font-size:13px;padding:7px 10px;min-height:52px;">${escHtml(t.description || '')}</textarea>
        </div>
      </div>
    </div>
  `).join('');
}

function removeEditTask(i) {
  _editingSessionTasks.splice(i, 1);
  renderEditTaskList();
}

async function adminSaveSession() {
  const name = document.getElementById('esName').value.trim();
  if (!name) return toast('Session name is required', 'error');
  try {
    await apiFetch(`/api/sessions/${_editingSessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ name, tasks: _editingSessionTasks })
    });
    toast('Session saved', 'success');
    closeModal('editSessionModal');
    await loadAllSessions();
  } catch (e) { toast(e.message, 'error'); }
}

async function adminDeleteSession(id, name) {
  if (!confirm(`Delete session "${name}"?`)) return;
  try {
    await apiFetch(`/api/sessions/${id}`, { method:'DELETE' });
    toast('Session deleted');
    loadAllSessions();
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════
// SESSION HISTORY (SysAdmin)
// ═══════════════════════════════════════════════════════════════════
const _historyCache = {};  // id → history row

async function loadSessionHistory() {
  try {
    const rows = await apiFetch('/api/session-history');
    rows.forEach(r => { _historyCache[r.id] = r; });
    const actionBadge = { created: 'badge-green', updated: 'badge-blue' };
    document.getElementById('sessionHistoryBody').innerHTML = rows.map(r => `
      <tr>
        <td style="color:var(--muted);font-size:12px;">${r.id}</td>
        <td style="white-space:nowrap;">${fmtDateTime(r.saved_at)}</td>
        <td>${escHtml(r.username)}</td>
        <td>${escHtml(r.session_name)}</td>
        <td><span class="badge ${actionBadge[r.action] || 'badge-gray'}">${escHtml(r.action)}</span></td>
        <td><span class="badge badge-gray">${r.task_count} task${r.task_count !== 1 ? 's' : ''}</span></td>
        <td style="color:var(--muted);font-size:12px;">${r.session_id ?? '—'}</td>
        <td>
          <button class="btn btn-secondary btn-xs" onclick="viewHistoryEntry(${r.id})">View</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px;">No history yet — saves will appear here automatically.</td></tr>';
  } catch (e) { toast(e.message, 'error'); }
}

function fmtDateTime(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function viewHistoryEntry(id) {
  const r = _historyCache[id];
  if (!r) return;
  const tasks = JSON.parse(r.tasks_json || '[]');

  document.getElementById('historyViewTitle').textContent =
    `Snapshot: ${r.session_name}`;
  document.getElementById('historyViewMeta').innerHTML =
    `<strong>${escHtml(r.username)}</strong> &middot; ${fmtDateTime(r.saved_at)}
     &middot; <span class="badge ${r.action === 'created' ? 'badge-green' : 'badge-blue'}">${r.action}</span>
     &middot; ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;

  const cols = ['Title','Trade','Status','Start Date','Duration','Crew','Priority','Assignee','Description'];
  const thead = `<thead style="position:sticky;top:0;"><tr>${cols.map(c =>
    `<th style="background:#1e3a5f;color:#fff;padding:7px 10px;text-align:left;font-weight:600;border-right:1px solid rgba(255,255,255,.15);">${c}</th>`
  ).join('')}</tr></thead>`;

  const tbody = tasks.length
    ? `<tbody>${tasks.map((t, i) => `
        <tr style="${i % 2 === 1 ? 'background:#f8f9fa;' : ''}">
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;">${escHtml(t.title || '—')}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;">${escHtml(t.trade || '—')}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;">${escHtml(t.status || '—')}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;">${escHtml(t.start_date || '—')}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;">${t.duration ?? '—'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;">${t.crew_size ?? '—'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;">${escHtml(t.priority || 'Normal')}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;">${escHtml(t.assignee || '—')}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0eeeb;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${escHtml(t.description || '—')}</td>
        </tr>`
      ).join('')}</tbody>`
    : `<tbody><tr><td colspan="${cols.length}" style="padding:20px;text-align:center;color:var(--muted);">No tasks in this snapshot.</td></tr></tbody>`;

  document.getElementById('historyViewTable').innerHTML = thead + tbody;
  openModal('historyViewModal');
}

async function clearSessionHistory() {
  if (!confirm('Clear all session history? This cannot be undone.')) return;
  try {
    await apiFetch('/api/session-history', { method: 'DELETE' });
    toast('Session history cleared');
    loadSessionHistory();
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS (SysAdmin)
// ═══════════════════════════════════════════════════════════════════
async function loadSettings() {
  try {
    const s = await apiFetch('/api/settings');
    document.getElementById('sClientId').value     = s.autodesk_client_id     || '';
    document.getElementById('sClientSecret').value = s.autodesk_client_secret || '';
    document.getElementById('sHubId').value        = s.autodesk_hub_id        || '';
    document.getElementById('sProjectId').value    = s.autodesk_project_id    || '';
    document.getElementById('sFolderUrn').value    = s.autodesk_folder_urn    || '';

    const statusEl = document.getElementById('autodeskStatus');
    if (s.autodesk_client_id && s.autodesk_project_id) {
      statusEl.className = 'alert alert-success';
      statusEl.innerHTML = '<span class="status-dot dot-green"></span> Autodesk credentials configured. Push to Build is enabled.';
    } else {
      statusEl.className = 'alert alert-info';
      statusEl.innerHTML = '<span class="status-dot dot-gray"></span> Configure credentials below to enable push to Autodesk Build.';
    }
  } catch (e) { toast(e.message, 'error'); }
}

async function saveSettings() {
  try {
    await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        autodesk_client_id:     document.getElementById('sClientId').value.trim(),
        autodesk_client_secret: document.getElementById('sClientSecret').value,
        autodesk_hub_id:        document.getElementById('sHubId').value.trim(),
        autodesk_project_id:    document.getElementById('sProjectId').value.trim(),
        autodesk_folder_urn:    document.getElementById('sFolderUrn').value.trim()
      })
    });
    toast('Settings saved', 'success');
    await loadSettings();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login.html';
}
