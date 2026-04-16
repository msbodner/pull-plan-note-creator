'use strict';

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');

const DB_PATH = path.join(__dirname, 'pullplan.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate();
    seed();
  }
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    UNIQUE NOT NULL,
      full_name     TEXT    NOT NULL DEFAULT '',
      email         TEXT    NOT NULL DEFAULT '',
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'user',
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trades (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    UNIQUE NOT NULL,
      bg_color     TEXT    NOT NULL DEFAULT '#EEEDE8',
      border_color TEXT    NOT NULL DEFAULT '#5F5E5A',
      text_color   TEXT    NOT NULL DEFAULT '#2C2C2A',
      label_color  TEXT    NOT NULL DEFAULT '#5F5E5A',
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS work_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      tasks_json  TEXT    NOT NULL DEFAULT '[]',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
}

function seed() {
  // Default admin user
  const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('Admin');
  if (!existingAdmin) {
    const hash = bcrypt.hashSync('Admin&123', 10);
    db.prepare(`
      INSERT INTO users (username, full_name, email, password_hash, role)
      VALUES ('Admin', 'System Administrator', 'admin@pullplan.local', ?, 'sysadmin')
    `).run(hash);
  }

  // Default trades
  const tradeCount = db.prepare('SELECT COUNT(*) as c FROM trades').get().c;
  if (tradeCount === 0) {
    const insertTrade = db.prepare(`
      INSERT INTO trades (name, bg_color, border_color, text_color, label_color, sort_order)
      VALUES (@name, @bg, @border, @text, @label, @order)
    `);
    const defaultTrades = [
      { name: 'Concrete',   bg: '#EEEDE8', border: '#5F5E5A', text: '#2C2C2A', label: '#5F5E5A', order: 1 },
      { name: 'Masonry',    bg: '#FAECE7', border: '#993C1D', text: '#712B13', label: '#993C1D', order: 2 },
      { name: 'Electrical', bg: '#FAEEDA', border: '#854F0B', text: '#633806', label: '#854F0B', order: 3 },
      { name: 'Carpentry',  bg: '#EAF3DE', border: '#3B6D11', text: '#173404', label: '#3B6D11', order: 4 },
      { name: 'Plumbing',   bg: '#E7EEF9', border: '#1D4F99', text: '#0D2B5E', label: '#1D4F99', order: 5 },
      { name: 'HVAC',       bg: '#F0E7F9', border: '#6B1D99', text: '#3D0D5E', label: '#6B1D99', order: 6 },
      { name: 'Steel',      bg: '#E7F0F9', border: '#1D6B99', text: '#0D3B5E', label: '#1D6B99', order: 7 },
    ];
    const ins = db.transaction(() => {
      for (const t of defaultTrades) {
        insertTrade.run({ name: t.name, bg: t.bg, border: t.border, text: t.text, label: t.label, order: t.order });
      }
    });
    ins();
  }

  // Default settings
  const settingsDefaults = [
    'autodesk_client_id', 'autodesk_client_secret',
    'autodesk_hub_id', 'autodesk_project_id', 'autodesk_folder_urn'
  ];
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const k of settingsDefaults) {
    insertSetting.run(k, '');
  }
}

module.exports = { getDb };
