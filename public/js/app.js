'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentTrade = null;
let trades       = [];
let tasks        = [];
let currentUser  = null;
let advOpen      = false;
let editingSessionId = null;

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    currentUser = me;
    document.getElementById('userAvatar').textContent = me.username.charAt(0).toUpperCase();
    document.getElementById('userName').textContent   = me.full_name || me.username;
    if (['admin','sysadmin'].includes(me.role)) {
      document.getElementById('adminBtn').style.display = 'inline-flex';
    }
  } catch {
    window.location.href = '/login.html';
    return;
  }

  await loadTrades();
  await loadSessions();
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
  if (res.headers.get('content-type')?.includes('json')) return res.json();
  return res;
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

// ── Trades ────────────────────────────────────────────────────────────────────
async function loadTrades() {
  trades = await apiFetch('/api/trades');
  const sel = document.getElementById('tradeSelect');
  sel.innerHTML = trades.map(t =>
    `<option value="${t.id}">${t.name}</option>`
  ).join('');
  if (trades.length) selectTrade(trades[0].id);
}

function selectTrade(tradeId) {
  const t = trades.find(x => x.id == tradeId);
  if (!t) return;
  currentTrade = t;

  // Style the select
  const sel = document.getElementById('tradeSelect');
  sel.style.background  = t.bg_color;
  sel.style.borderColor = t.border_color;
  sel.style.color       = t.text_color;

  // Dot
  document.getElementById('tradeDot').style.background = t.border_color;

  // Form panel
  const panel = document.getElementById('formPanel');
  panel.style.background    = t.bg_color;
  panel.style.borderTopColor = t.border_color;

  // Panel header
  const tradeLabel = document.getElementById('panelTrade');
  tradeLabel.textContent = t.name;
  tradeLabel.style.color = t.text_color;

  // Add button
  const btn = document.getElementById('addBtn');
  btn.style.background = t.border_color;
  btn.style.color      = '#ffffff';
}

// ── Advanced fields toggle ────────────────────────────────────────────────────
function toggleAdvanced() {
  advOpen = !advOpen;
  document.getElementById('advancedFields').classList.toggle('open', advOpen);
  document.getElementById('advIcon').textContent = advOpen ? '▼' : '►';
}

// ── Validate & collect form ───────────────────────────────────────────────────
function readForm() {
  const v = (id) => document.getElementById(id).value.trim();
  const n = (id) => { const x = parseInt(v(id)); return isNaN(x) ? null : x; };

  const title = v('fTitle');
  const start = v('fStart');
  const dur   = n('fDur');
  const crew  = n('fCrew');

  let ok = true;
  function chk(errId, cond) {
    document.getElementById(errId).classList.toggle('show', !cond);
    if (!cond) ok = false;
  }
  chk('eTitle', title.length > 0);
  chk('eStart', start.length > 0);
  chk('eDur',   dur !== null && dur >= 1);
  chk('eCrew',  crew !== null && crew >= 1);

  if (!ok) return null;

  return {
    trade:        currentTrade?.name || '',
    trade_id:     currentTrade?.id,
    title,
    start_date:   start,
    finish_date:  v('fFinish') || null,
    duration:     dur,
    crew_size:    crew,
    type:         v('fType')       || 'Task',
    work_type:    v('fWorkType')   || 'Work',
    status:       v('fStatus')     || 'Open',
    complete_pct: n('fCompletePct') ?? 0,
    assignee:     v('fAssignee')   || '',
    company:      v('fCompany')    || '',
    role:         v('fRole')       || '',
    location:     v('fLocation')   || '',
    wbs:          v('fWbs')        || '',
    description:  v('fDesc')       || '',
    priority:     v('fPriority')   || 'Normal',
    handoff_id:   n('fHandoffId')  ?? '',
    prev_handoffs: v('fPrevHandoffs') || ''
  };
}

function clearForm() {
  ['fTitle','fStart','fFinish','fDur','fCrew','fCompletePct',
   'fAssignee','fCompany','fRole','fLocation','fWbs','fDesc',
   'fHandoffId','fPrevHandoffs'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('fType').value     = 'Task';
  document.getElementById('fWorkType').value = 'Work';
  document.getElementById('fStatus').value   = 'Open';
  document.getElementById('fPriority').value = 'Normal';
}

// ── Add task ──────────────────────────────────────────────────────────────────
function addTask() {
  const task = readForm();
  if (!task) return;
  tasks.push(task);
  clearForm();
  renderBoard();
  updateSummary();
  toast('Task added to board', 'success');
}

// ── Remove task ───────────────────────────────────────────────────────────────
function removeTask(i) {
  tasks.splice(i, 1);
  renderBoard();
  updateSummary();
}

// ── Board render ──────────────────────────────────────────────────────────────
function renderBoard() {
  const board = document.getElementById('stickyBoard');
  const count = document.getElementById('taskQueueCount');
  const expBtn  = document.getElementById('exportBtn');
  const pushBtn = document.getElementById('pushBtn');
  const clearBtn = document.getElementById('clearBtn');

  count.textContent = tasks.length === 1 ? '1 task queued' : `${tasks.length} tasks queued`;
  expBtn.disabled   = tasks.length === 0;
  pushBtn.disabled  = tasks.length === 0;
  clearBtn.disabled = tasks.length === 0;

  if (tasks.length === 0) {
    board.innerHTML = '<p class="empty-state">No tasks yet – add one using the form above.</p>';
    return;
  }

  board.innerHTML = tasks.map((t, i) => {
    const trade = trades.find(x => x.id == t.trade_id) || { bg_color: '#eee', border_color: '#999', text_color: '#333', label_color: '#666' };
    const ds = t.start_date ? fmtDateShort(t.start_date) : '—';
    return `
      <div class="sc" style="background:${trade.bg_color};border-top-color:${trade.border_color};">
        <button class="sc-rm" onclick="removeTask(${i})" title="Remove">&#10005;</button>
        <div class="sc-label" style="color:${trade.label_color};">${t.trade}</div>
        <div class="sc-title" style="color:${trade.text_color};">${escHtml(t.title)}</div>
        <div class="sc-meta" style="color:${trade.text_color};">
          ${ds} &middot; ${t.duration}d &middot; ${t.crew_size} crew
          ${t.status !== 'Open' ? `<br>${t.status}` : ''}
          ${t.priority !== 'Normal' ? `<br>${t.priority} priority` : ''}
        </div>
      </div>`;
  }).join('');
}

function fmtDateShort(s) {
  const d = new Date(s + 'T00:00:00');
  return `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Summary ───────────────────────────────────────────────────────────────────
function updateSummary() {
  const total     = tasks.length;
  const totalDays = tasks.reduce((s, t) => s + (parseInt(t.duration) || 0), 0);
  const crewDays  = tasks.reduce((s, t) => s + ((parseInt(t.duration) || 0) * (parseInt(t.crew_size) || 0)), 0);
  document.getElementById('boardCount').textContent    = `${total} task${total !== 1 ? 's' : ''}`;
  document.getElementById('sumTotal').textContent      = total;
  document.getElementById('sumDays').textContent       = totalDays;
  document.getElementById('sumCrewDays').textContent   = crewDays;
}

// ── Clear board ───────────────────────────────────────────────────────────────
function clearBoard() {
  if (!tasks.length) return;
  if (!confirm('Clear all tasks from the board?')) return;
  tasks = [];
  editingSessionId = null;
  renderBoard();
  updateSummary();
}

// ── Export XLSX ───────────────────────────────────────────────────────────────
async function exportXLSX() {
  if (!tasks.length) return;
  try {
    const btn = document.getElementById('exportBtn');
    btn.disabled = true;
    btn.textContent = '…Generating';
    const res = await fetch('/api/export/xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Export failed');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'pull-plan-import.xlsx';
    a.click();
    URL.revokeObjectURL(url);
    toast('XLSX exported', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    const btn = document.getElementById('exportBtn');
    btn.disabled = tasks.length === 0;
    btn.innerHTML = '&#8595; Export XLSX';
  }
}

// ── Push to Autodesk ──────────────────────────────────────────────────────────
async function pushToAutodesk() {
  if (!tasks.length) return;
  if (!confirm(`Push ${tasks.length} task(s) to Autodesk Build?`)) return;
  const btn = document.getElementById('pushBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Pushing…';
  try {
    const d = await apiFetch('/api/push-autodesk', {
      method: 'POST',
      body: JSON.stringify({ tasks })
    });
    toast(d.message || 'Pushed to Autodesk Build!', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = tasks.length === 0;
    btn.innerHTML = '&#9652; Push to Autodesk Build';
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const sessions = await apiFetch('/api/sessions');
    renderSessionList(sessions);
  } catch { /* ignore */ }
}

function renderSessionList(sessions) {
  const list = document.getElementById('sessionList');
  if (!sessions.length) {
    list.innerHTML = '<span class="no-sessions">No saved sessions.</span>';
    return;
  }
  list.innerHTML = sessions.map(s => {
    const tasks = JSON.parse(s.tasks_json || '[]');
    const dt    = new Date(s.updated_at).toLocaleDateString();
    return `
      <div class="session-item">
        <div>
          <div class="session-item-name">${escHtml(s.name)}</div>
          <div class="session-item-meta">${tasks.length} task${tasks.length !== 1 ? 's' : ''} &middot; ${dt}</div>
        </div>
        <div class="session-item-actions">
          <button class="btn btn-secondary btn-xs" onclick="loadSessionById(${s.id})">Load</button>
          <button class="btn btn-danger btn-xs" onclick="deleteSession(${s.id})">Del</button>
        </div>
      </div>`;
  }).join('');
}

async function loadSessionById(id) {
  try {
    const sessions  = await apiFetch('/api/sessions');
    const session   = sessions.find(s => s.id === id);
    if (!session) return toast('Session not found', 'error');
    if (tasks.length && !confirm('Replace current board with this session?')) return;
    tasks = JSON.parse(session.tasks_json || '[]');
    editingSessionId = session.id;
    renderBoard();
    updateSummary();
    toast(`Loaded: ${session.name}`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteSession(id) {
  if (!confirm('Delete this saved session?')) return;
  try {
    await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (editingSessionId === id) editingSessionId = null;
    await loadSessions();
    toast('Session deleted');
  } catch (e) { toast(e.message, 'error'); }
}

function showSaveModal() {
  const inp = document.getElementById('sessionNameInput');
  inp.value = '';
  openModal('saveModal');
  setTimeout(() => inp.focus(), 150);
}

async function saveSession() {
  const name = document.getElementById('sessionNameInput').value.trim();
  if (!name) return toast('Please enter a session name', 'error');
  if (!tasks.length) return toast('No tasks to save', 'error');
  try {
    if (editingSessionId) {
      await apiFetch(`/api/sessions/${editingSessionId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, tasks })
      });
    } else {
      const s = await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name, tasks })
      });
      editingSessionId = s.id;
    }
    closeModal('saveModal');
    await loadSessions();
    toast('Session saved', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login.html';
}
