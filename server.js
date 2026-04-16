'use strict';

const express   = require('express');
const session   = require('express-session');
const helmet    = require('helmet');
const bcrypt    = require('bcryptjs');
const path      = require('path');
const ExcelJS   = require('exceljs');
const axios     = require('axios');
const db        = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
    }
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pullplan-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auto-login as Admin ───────────────────────────────────────────────────────
app.use(async (req, res, next) => {
  try {
    if (!req.session.userId) {
      const user = await db.queryOne('SELECT * FROM users WHERE username = $1', ['Admin']);
      if (user) {
        req.session.userId   = user.id;
        req.session.username = user.username;
        req.session.userRole = user.role;
      }
    }
  } catch (e) { /* ignore – db may not be ready yet */ }
  next();
});

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!['admin', 'sysadmin'].includes(req.session.userRole))
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

function requireSysAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.session.userRole !== 'sysadmin')
    return res.status(403).json({ error: 'Forbidden – System Admin only' });
  next();
}

// ── Root redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/app.html'));

// ── Auth API ──────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = await db.queryOne('SELECT * FROM users WHERE username = $1 AND active = 1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.userRole = user.role;
    res.json({ id: user.id, username: user.username, fullName: user.full_name, role: user.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await db.queryOne(
      'SELECT id, username, full_name, email, role FROM users WHERE id = $1',
      [req.session.userId]
    );
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Users API ─────────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.query(
      'SELECT id, username, full_name, email, role, active, created_at FROM users ORDER BY id'
    );
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, full_name, email, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const allowedRoles = ['user', 'admin', 'sysadmin'];
    const userRole = allowedRoles.includes(role) ? role : 'user';
    if (userRole === 'sysadmin' && req.session.userRole !== 'sysadmin')
      return res.status(403).json({ error: 'Only system admin can create sysadmin accounts' });
    const hash = bcrypt.hashSync(password, 10);
    const id = await db.insert(
      'INSERT INTO users (username, full_name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [username, full_name || '', email || '', hash, userRole]
    );
    const user = await db.queryOne('SELECT id, username, full_name, email, role, active FROM users WHERE id = $1', [id]);
    res.status(201).json(user);
  } catch (e) {
    if (e.message.includes('UNIQUE') || e.message.includes('unique')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'sysadmin' && req.session.userRole !== 'sysadmin')
      return res.status(403).json({ error: 'Cannot modify sysadmin accounts' });
    const { full_name, email, password, role, active } = req.body;
    const allowedRoles = ['user', 'admin', 'sysadmin'];
    const newRole   = allowedRoles.includes(role) ? role : user.role;
    const newActive = active !== undefined ? (active ? 1 : 0) : user.active;
    const newHash   = password ? bcrypt.hashSync(password, 10) : user.password_hash;
    await db.execute(
      'UPDATE users SET full_name = $1, email = $2, password_hash = $3, role = $4, active = $5 WHERE id = $6',
      [full_name ?? user.full_name, email ?? user.email, newHash, newRole, newActive, req.params.id]
    );
    const updated = await db.queryOne('SELECT id, username, full_name, email, role, active FROM users WHERE id = $1', [req.params.id]);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'sysadmin' && req.session.userRole !== 'sysadmin')
      return res.status(403).json({ error: 'Cannot delete sysadmin accounts' });
    if (user.id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
    await db.execute('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Trades API ────────────────────────────────────────────────────────────────
app.get('/api/trades', requireAuth, async (req, res) => {
  try {
    res.json(await db.query('SELECT * FROM trades ORDER BY sort_order, name'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trades', requireAdmin, async (req, res) => {
  try {
    const { name, bg_color, border_color, text_color, label_color } = req.body;
    if (!name) return res.status(400).json({ error: 'Trade name required' });
    const maxRow = await db.queryOne('SELECT MAX(sort_order) AS m FROM trades');
    const maxOrder = parseInt(maxRow?.m || 0);
    const id = await db.insert(
      'INSERT INTO trades (name, bg_color, border_color, text_color, label_color, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
      [name.trim(), bg_color || '#EEEDE8', border_color || '#5F5E5A', text_color || '#2C2C2A', label_color || '#5F5E5A', maxOrder + 1]
    );
    res.status(201).json(await db.queryOne('SELECT * FROM trades WHERE id = $1', [id]));
  } catch (e) {
    if (e.message.includes('UNIQUE') || e.message.includes('unique')) return res.status(409).json({ error: 'Trade name already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/trades/:id', requireAdmin, async (req, res) => {
  try {
    const trade = await db.queryOne('SELECT * FROM trades WHERE id = $1', [req.params.id]);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    const { name, bg_color, border_color, text_color, label_color, sort_order } = req.body;
    await db.execute(
      'UPDATE trades SET name=$1, bg_color=$2, border_color=$3, text_color=$4, label_color=$5, sort_order=$6 WHERE id=$7',
      [name ?? trade.name, bg_color ?? trade.bg_color, border_color ?? trade.border_color,
       text_color ?? trade.text_color, label_color ?? trade.label_color,
       sort_order ?? trade.sort_order, req.params.id]
    );
    res.json(await db.queryOne('SELECT * FROM trades WHERE id = $1', [req.params.id]));
  } catch (e) {
    if (e.message.includes('UNIQUE') || e.message.includes('unique')) return res.status(409).json({ error: 'Trade name already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/trades/:id', requireAdmin, async (req, res) => {
  try {
    if (!await db.queryOne('SELECT id FROM trades WHERE id = $1', [req.params.id]))
      return res.status(404).json({ error: 'Trade not found' });
    await db.execute('DELETE FROM trades WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Work Sessions API ─────────────────────────────────────────────────────────
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT ws.*, u.username FROM work_sessions ws
       JOIN users u ON ws.user_id = u.id
       WHERE ws.user_id = $1 ORDER BY ws.updated_at DESC`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/all', requireSysAdmin, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT ws.*, u.username FROM work_sessions ws
       JOIN users u ON ws.user_id = u.id ORDER BY ws.updated_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions', requireAuth, async (req, res) => {
  try {
    const { name, tasks } = req.body;
    if (!name) return res.status(400).json({ error: 'Session name required' });
    const id = await db.insert(
      'INSERT INTO work_sessions (user_id, name, tasks_json) VALUES ($1, $2, $3)',
      [req.session.userId, name, JSON.stringify(tasks || [])]
    );
    res.status(201).json(await db.queryOne('SELECT * FROM work_sessions WHERE id = $1', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const row = await db.queryOne('SELECT * FROM work_sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    const { name, tasks } = req.body;
    const updatedAt = new Date().toISOString();
    await db.execute(
      'UPDATE work_sessions SET name=$1, tasks_json=$2, updated_at=$3 WHERE id=$4',
      [name ?? row.name, tasks !== undefined ? JSON.stringify(tasks) : row.tasks_json, updatedAt, req.params.id]
    );
    res.json(await db.queryOne('SELECT * FROM work_sessions WHERE id = $1', [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const row = await db.queryOne('SELECT * FROM work_sessions WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    if (row.user_id !== req.session.userId && req.session.userRole !== 'sysadmin')
      return res.status(403).json({ error: 'Forbidden' });
    await db.execute('DELETE FROM work_sessions WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export XLSX ───────────────────────────────────────────────────────────────
app.post('/api/export/xlsx', requireAuth, async (req, res) => {
  const { tasks } = req.body;
  if (!tasks || !tasks.length) return res.status(400).json({ error: 'No tasks to export' });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pull Plan Note Creator v1.0 – AWC Technologies LLC';
  const ws = wb.addWorksheet('ACS Build');

  const headers = [
    'Title','Start date','Finish date','Duration (Days)','Type','Work type',
    'Status','Complete percentage','Assignee','Company','Role','Location',
    'WBS','Crew size','Description','Priority','Handoff ID','Previous handoffs IDs'
  ];
  const headerRow = ws.addRow(headers);
  headerRow.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D6DA8' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border    = { bottom: { style: 'thin', color: { argb: 'FF1A4A7A' } } };
  });
  ws.columns = [
    {width:30},{width:14},{width:14},{width:16},{width:10},{width:14},
    {width:14},{width:20},{width:24},{width:20},{width:16},{width:24},
    {width:20},{width:12},{width:30},{width:10},{width:12},{width:22}
  ];

  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return `${dt.getMonth()+1}/${dt.getDate()}/${dt.getFullYear()}`;
  }
  function calcFinish(start, dur) {
    if (!start || !dur) return fmtDate(start);
    const d = new Date(start + 'T00:00:00');
    d.setDate(d.getDate() + parseInt(dur) - 1);
    return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
  }

  tasks.forEach((t, i) => {
    const row = ws.addRow([
      t.title || '', fmtDate(t.start_date),
      t.finish_date ? fmtDate(t.finish_date) : calcFinish(t.start_date, t.duration),
      t.duration || '', t.type || 'Task', t.work_type || 'Work',
      t.status || 'Open', t.complete_pct ?? 0, t.assignee || '',
      t.company || t.trade || '', t.role || t.trade || '',
      t.location || '', t.wbs || '', t.crew_size || '',
      t.description || '', t.priority || 'Normal',
      t.handoff_id || '', t.prev_handoffs || ''
    ]);
    if (i % 2 === 1) row.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F8FC' } };
    });
  });

  ws.autoFilter = { from: 'A1', to: 'R1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="pull-plan-import.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// ── Autodesk Build Push ───────────────────────────────────────────────────────
app.post('/api/push-autodesk', requireAuth, async (req, res) => {
  const { tasks } = req.body;
  if (!tasks || !tasks.length) return res.status(400).json({ error: 'No tasks to push' });

  const rows = await db.query('SELECT key, value FROM settings');
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });

  if (!s.autodesk_client_id || !s.autodesk_client_secret || !s.autodesk_project_id)
    return res.status(400).json({ error: 'Autodesk credentials not configured. Set them in Admin > Settings.' });

  try {
    const tokenResp = await axios.post(
      'https://developer.api.autodesk.com/authentication/v2/token',
      new URLSearchParams({
        grant_type: 'client_credentials', scope: 'data:read data:write data:create',
        client_id: s.autodesk_client_id, client_secret: s.autodesk_client_secret
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const token = tokenResp.data.access_token;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('ACS Build');
    ws.addRow(['Title','Start date','Finish date','Duration (Days)','Type','Work type',
               'Status','Complete percentage','Assignee','Company','Role','Location',
               'WBS','Crew size','Description','Priority','Handoff ID','Previous handoffs IDs']);
    tasks.forEach(t => {
      const finish = t.finish_date ? t.finish_date : (() => {
        if (!t.start_date || !t.duration) return t.start_date || '';
        const d = new Date(t.start_date + 'T00:00:00');
        d.setDate(d.getDate() + parseInt(t.duration) - 1);
        return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
      })();
      ws.addRow([t.title||'', t.start_date||'', finish, t.duration||'',
        t.type||'Task', t.work_type||'Work', t.status||'Open', t.complete_pct||0,
        t.assignee||'', t.company||t.trade||'', t.role||t.trade||'',
        t.location||'', t.wbs||'', t.crew_size||'', t.description||'',
        t.priority||'Normal', t.handoff_id||'', t.prev_handoffs||'']);
    });
    const buffer = await wb.xlsx.writeBuffer();
    const filename = `pull-plan-${Date.now()}.xlsx`;
    const projId = s.autodesk_project_id.startsWith('b.') ? s.autodesk_project_id : `b.${s.autodesk_project_id}`;

    const storageResp = await axios.post(
      `https://developer.api.autodesk.com/data/v1/projects/${projId}/storage`,
      { jsonapi: { version: '1.0' }, data: { type: 'objects', attributes: { name: filename },
        relationships: { target: { data: { type: 'folders', id: s.autodesk_folder_urn || '' } } } } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' } }
    );
    const uploadUrl = storageResp.data.data.relationships?.storage?.meta?.link?.href;
    if (!uploadUrl) throw new Error('Could not get upload URL from Autodesk');
    await axios.put(uploadUrl, buffer, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }
    });
    res.json({ ok: true, message: `Uploaded "${filename}" to Autodesk Build. Open Build > Files to import.` });
  } catch (err) {
    const msg = err.response?.data?.detail || err.response?.data?.message || err.message;
    res.status(502).json({ error: `Autodesk API error: ${msg}` });
  }
});

// ── Settings API ──────────────────────────────────────────────────────────────
app.get('/api/settings', requireSysAdmin, async (req, res) => {
  try {
    const rows = await db.query('SELECT key, value FROM settings');
    const out = {};
    rows.forEach(r => { out[r.key] = r.value; });
    if (out.autodesk_client_secret) out.autodesk_client_secret = '••••••••';
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', requireSysAdmin, async (req, res) => {
  try {
    const keys = ['autodesk_client_id','autodesk_client_secret','autodesk_hub_id','autodesk_project_id','autodesk_folder_urn'];
    for (const k of keys) {
      if (req.body[k] !== undefined && req.body[k] !== '••••••••') {
        if (db.IS_PG) {
          await db.execute(
            'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            [k, req.body[k]]
          );
        } else {
          await db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)', [k, req.body[k]]);
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  Pull Plan Note Creator v1.0 – AWC Technologies LLC`);
    console.log(`  Running at http://localhost:${PORT}`);
    console.log(`  Database: ${db.IS_PG ? 'PostgreSQL' : 'SQLite (local)'}\n`);
  });
}).catch(err => {
  console.error('Database init failed:', err);
  process.exit(1);
});
