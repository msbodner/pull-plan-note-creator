'use strict';

const express        = require('express');
const session        = require('express-session');
const helmet         = require('helmet');
const bcrypt         = require('bcryptjs');
const path           = require('path');
const ExcelJS        = require('exceljs');
const axios          = require('axios');
const { getDb }      = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
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
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth helpers ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.accepts('html')) return res.redirect('/login.html');
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return req.accepts('html') ? res.redirect('/login.html') : res.status(401).json({ error: 'Unauthorized' });
  }
  if (!['admin', 'sysadmin'].includes(req.session.userRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function requireSysAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.session.userRole !== 'sysadmin') {
    return res.status(403).json({ error: 'Forbidden – System Admin only' });
  }
  next();
}

// ── Root redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/app.html');
  res.redirect('/login.html');
});

// ── Auth API ──────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.userRole = user.role;

  res.json({ id: user.id, username: user.username, fullName: user.full_name, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT id, username, full_name, email, role FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// ── Users API (Admin) ─────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, full_name, email, role, active, created_at FROM users ORDER BY id').all();
  res.json(users);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, full_name, email, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const allowedRoles = ['user', 'admin', 'sysadmin'];
  const userRole = allowedRoles.includes(role) ? role : 'user';

  // Only sysadmin can create sysadmin accounts
  if (userRole === 'sysadmin' && req.session.userRole !== 'sysadmin') {
    return res.status(403).json({ error: 'Only system admin can create sysadmin accounts' });
  }

  const db   = getDb();
  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db.prepare(`
      INSERT INTO users (username, full_name, email, password_hash, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, full_name || '', email || '', hash, userRole);
    const user = db.prepare('SELECT id, username, full_name, email, role, active FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(user);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    throw e;
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { full_name, email, password, role, active } = req.body;
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Protect sysadmin from demotion unless caller is sysadmin
  if (user.role === 'sysadmin' && req.session.userRole !== 'sysadmin') {
    return res.status(403).json({ error: 'Cannot modify sysadmin accounts' });
  }

  const allowedRoles = ['user', 'admin', 'sysadmin'];
  const newRole   = allowedRoles.includes(role) ? role : user.role;
  const newActive = active !== undefined ? (active ? 1 : 0) : user.active;
  const newHash   = password ? bcrypt.hashSync(password, 10) : user.password_hash;

  db.prepare(`
    UPDATE users SET full_name = ?, email = ?, password_hash = ?, role = ?, active = ?
    WHERE id = ?
  `).run(full_name ?? user.full_name, email ?? user.email, newHash, newRole, newActive, req.params.id);

  const updated = db.prepare('SELECT id, username, full_name, email, role, active FROM users WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'sysadmin' && req.session.userRole !== 'sysadmin') {
    return res.status(403).json({ error: 'Cannot delete sysadmin accounts' });
  }
  if (user.id === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Trades API ────────────────────────────────────────────────────────────────
app.get('/api/trades', requireAuth, (req, res) => {
  const db = getDb();
  const trades = db.prepare('SELECT * FROM trades ORDER BY sort_order, name').all();
  res.json(trades);
});

app.post('/api/trades', requireAdmin, (req, res) => {
  const { name, bg_color, border_color, text_color, label_color } = req.body;
  if (!name) return res.status(400).json({ error: 'Trade name required' });
  const db = getDb();
  try {
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM trades').get().m || 0;
    const info = db.prepare(`
      INSERT INTO trades (name, bg_color, border_color, text_color, label_color, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      bg_color     || '#EEEDE8',
      border_color || '#5F5E5A',
      text_color   || '#2C2C2A',
      label_color  || '#5F5E5A',
      maxOrder + 1
    );
    res.status(201).json(db.prepare('SELECT * FROM trades WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Trade name already exists' });
    throw e;
  }
});

app.put('/api/trades/:id', requireAdmin, (req, res) => {
  const db    = getDb();
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const { name, bg_color, border_color, text_color, label_color, sort_order } = req.body;
  try {
    db.prepare(`
      UPDATE trades SET name = ?, bg_color = ?, border_color = ?, text_color = ?, label_color = ?, sort_order = ?
      WHERE id = ?
    `).run(
      name         ?? trade.name,
      bg_color     ?? trade.bg_color,
      border_color ?? trade.border_color,
      text_color   ?? trade.text_color,
      label_color  ?? trade.label_color,
      sort_order   ?? trade.sort_order,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Trade name already exists' });
    throw e;
  }
});

app.delete('/api/trades/:id', requireAdmin, (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM trades WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Trade not found' });
  }
  db.prepare('DELETE FROM trades WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Work Sessions API ─────────────────────────────────────────────────────────
app.get('/api/sessions', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ws.*, u.username FROM work_sessions ws
    JOIN users u ON ws.user_id = u.id
    WHERE ws.user_id = ?
    ORDER BY ws.updated_at DESC
  `).all(req.session.userId);
  res.json(rows);
});

app.get('/api/sessions/all', requireSysAdmin, (req, res) => {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT ws.*, u.username FROM work_sessions ws
    JOIN users u ON ws.user_id = u.id
    ORDER BY ws.updated_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/sessions', requireAuth, (req, res) => {
  const { name, tasks } = req.body;
  if (!name) return res.status(400).json({ error: 'Session name required' });
  const db   = getDb();
  const info = db.prepare(`
    INSERT INTO work_sessions (user_id, name, tasks_json) VALUES (?, ?, ?)
  `).run(req.session.userId, name, JSON.stringify(tasks || []));
  res.status(201).json(db.prepare('SELECT * FROM work_sessions WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/sessions/:id', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM work_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!row) return res.status(404).json({ error: 'Session not found' });

  const { name, tasks } = req.body;
  db.prepare(`
    UPDATE work_sessions SET name = ?, tasks_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(name ?? row.name, tasks !== undefined ? JSON.stringify(tasks) : row.tasks_json, req.params.id);
  res.json(db.prepare('SELECT * FROM work_sessions WHERE id = ?').get(req.params.id));
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM work_sessions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  if (row.user_id !== req.session.userId && req.session.userRole !== 'sysadmin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('DELETE FROM work_sessions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Export XLSX ───────────────────────────────────────────────────────────────
app.post('/api/export/xlsx', requireAuth, async (req, res) => {
  const { tasks } = req.body;
  if (!tasks || !tasks.length) return res.status(400).json({ error: 'No tasks to export' });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pull Plan Creator';
  const ws = wb.addWorksheet('ACS Build');

  // Headers matching Forma import template exactly
  const headers = [
    'Title', 'Start date', 'Finish date', 'Duration (Days)',
    'Type', 'Work type', 'Status', 'Complete percentage',
    'Assignee', 'Company', 'Role', 'Location', 'WBS', 'Crew size',
    'Description', 'Priority', 'Handoff ID', 'Previous handoffs IDs'
  ];

  const headerRow = ws.addRow(headers);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D6DA8' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF1A4A7A' } }
    };
  });

  ws.columns = [
    { width: 30 }, { width: 14 }, { width: 14 }, { width: 16 },
    { width: 10 }, { width: 14 }, { width: 14 }, { width: 20 },
    { width: 24 }, { width: 20 }, { width: 16 }, { width: 24 },
    { width: 20 }, { width: 12 }, { width: 30 }, { width: 10 },
    { width: 12 }, { width: 22 }
  ];

  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
  }

  function calcFinish(startStr, durationDays) {
    if (!startStr || !durationDays) return startStr || '';
    const d = new Date(startStr + 'T00:00:00');
    d.setDate(d.getDate() + parseInt(durationDays) - 1);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  }

  tasks.forEach((t, i) => {
    const row = ws.addRow([
      t.title        || '',
      fmtDate(t.start_date),
      t.finish_date  ? fmtDate(t.finish_date) : calcFinish(t.start_date, t.duration),
      t.duration     || '',
      t.type         || 'Task',
      t.work_type    || 'Work',
      t.status       || 'Open',
      t.complete_pct !== undefined ? t.complete_pct : 0,
      t.assignee     || '',
      t.company      || t.trade || '',
      t.role         || t.trade || '',
      t.location     || '',
      t.wbs          || '',
      t.crew_size    || '',
      t.description  || '',
      t.priority     || 'Normal',
      t.handoff_id   || '',
      t.prev_handoffs || ''
    ]);

    if (i % 2 === 1) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F8FC' } };
      });
    }
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

  const db = getDb();
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings[r.key] = r.value; });

  const { autodesk_client_id, autodesk_client_secret, autodesk_hub_id, autodesk_project_id, autodesk_folder_urn } = settings;
  if (!autodesk_client_id || !autodesk_client_secret || !autodesk_project_id) {
    return res.status(400).json({ error: 'Autodesk credentials not configured. Please set them in Admin > Settings.' });
  }

  try {
    // Step 1: Get 2-legged OAuth token
    const tokenResp = await axios.post(
      'https://developer.api.autodesk.com/authentication/v2/token',
      new URLSearchParams({
        grant_type:    'client_credentials',
        scope:         'data:read data:write data:create',
        client_id:     autodesk_client_id,
        client_secret: autodesk_client_secret
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const token = tokenResp.data.access_token;

    // Step 2: Generate XLSX in memory
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('ACS Build');
    const headers = [
      'Title', 'Start date', 'Finish date', 'Duration (Days)',
      'Type', 'Work type', 'Status', 'Complete percentage',
      'Assignee', 'Company', 'Role', 'Location', 'WBS', 'Crew size',
      'Description', 'Priority', 'Handoff ID', 'Previous handoffs IDs'
    ];
    ws.addRow(headers);

    function fmtDate(d) {
      if (!d) return '';
      const dt = new Date(d + 'T00:00:00');
      return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
    }

    tasks.forEach(t => {
      const finish = t.finish_date ? fmtDate(t.finish_date) : (() => {
        if (!t.start_date || !t.duration) return fmtDate(t.start_date);
        const d = new Date(t.start_date + 'T00:00:00');
        d.setDate(d.getDate() + parseInt(t.duration) - 1);
        return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
      })();
      ws.addRow([
        t.title || '', fmtDate(t.start_date), finish, t.duration || '',
        t.type || 'Task', t.work_type || 'Work', t.status || 'Open',
        t.complete_pct || 0, t.assignee || '', t.company || t.trade || '',
        t.role || t.trade || '', t.location || '', t.wbs || '', t.crew_size || '',
        t.description || '', t.priority || 'Normal', t.handoff_id || '', t.prev_handoffs || ''
      ]);
    });

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `pull-plan-${Date.now()}.xlsx`;

    // Step 3: Create storage location in Autodesk Build
    const projId = autodesk_project_id.startsWith('b.') ? autodesk_project_id : `b.${autodesk_project_id}`;
    const storageResp = await axios.post(
      `https://developer.api.autodesk.com/data/v1/projects/${projId}/storage`,
      {
        jsonapi: { version: '1.0' },
        data: {
          type: 'objects',
          attributes: { name: filename },
          relationships: {
            target: {
              data: { type: 'folders', id: autodesk_folder_urn || `urn:adsk.wipprod:fs.folder:${autodesk_project_id}` }
            }
          }
        }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' } }
    );

    const objectId  = storageResp.data.data.id;
    const uploadUrl = storageResp.data.data.relationships?.storage?.meta?.link?.href;

    if (!uploadUrl) throw new Error('Could not get upload URL from Autodesk');

    // Step 4: Upload XLSX to OSS
    await axios.put(uploadUrl, buffer, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.byteLength
      }
    });

    // Step 5: Create first version in project folder
    const folderId = autodesk_folder_urn;
    if (folderId) {
      await axios.post(
        `https://developer.api.autodesk.com/data/v1/projects/${projId}/folders/${encodeURIComponent(folderId)}/contents`,
        {
          jsonapi: { version: '1.0' },
          data: {
            type: 'items',
            attributes: {
              displayName: filename,
              extension: {
                type:    'items:autodesk.bim360:File',
                version: '1.0'
              }
            },
            relationships: {
              tip: {
                data: { type: 'versions', id: '1' }
              },
              parent: {
                data: { type: 'folders', id: folderId }
              }
            }
          },
          included: [{
            type: 'versions',
            id:   '1',
            attributes: {
              name: filename,
              extension: {
                type:    'versions:autodesk.bim360:File',
                version: '1.0'
              }
            },
            relationships: {
              storage: {
                data: { type: 'objects', id: objectId }
              }
            }
          }]
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' } }
      );
    }

    res.json({ ok: true, message: `Successfully uploaded "${filename}" to Autodesk Build. Open Build > Files to import the work plan.` });
  } catch (err) {
    const msg = err.response?.data?.detail || err.response?.data?.message || err.message;
    console.error('Autodesk push error:', msg);
    res.status(502).json({ error: `Autodesk API error: ${msg}` });
  }
});

// ── Settings API (SysAdmin) ───────────────────────────────────────────────────
app.get('/api/settings', requireSysAdmin, (req, res) => {
  const db   = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out  = {};
  rows.forEach(r => { out[r.key] = r.value; });
  // Mask secrets in response
  if (out.autodesk_client_secret) out.autodesk_client_secret = '••••••••';
  res.json(out);
});

app.put('/api/settings', requireSysAdmin, (req, res) => {
  const db   = getDb();
  const keys = ['autodesk_client_id', 'autodesk_client_secret', 'autodesk_hub_id', 'autodesk_project_id', 'autodesk_folder_urn'];
  const upd  = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const txn  = db.transaction(() => {
    for (const k of keys) {
      if (req.body[k] !== undefined && req.body[k] !== '••••••••') {
        upd.run(k, req.body[k]);
      }
    }
  });
  txn();
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
getDb(); // initialize DB on startup
app.listen(PORT, () => {
  console.log(`\n  Pull Plan App running at http://localhost:${PORT}\n  Default login: Admin / Admin&123\n`);
});
