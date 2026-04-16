'use strict';

const path   = require('path');
const bcrypt = require('bcryptjs');

// ── Backend detection ─────────────────────────────────────────────────────────
const IS_PG = !!process.env.DATABASE_URL;

let pgPool, sqliteDb;

if (IS_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  const Database = require('better-sqlite3');
  sqliteDb = new Database(path.join(__dirname, 'pullplan.db'));
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
}

// ── Query helpers ─────────────────────────────────────────────────────────────
// All SQL uses $1/$2/... placeholders (Postgres style).
// For SQLite, they are auto-converted to ?.

function toSqlite(sql) {
  return sql.replace(/\$\d+/g, '?');
}

async function query(sql, params = []) {
  if (IS_PG) {
    const { rows } = await pgPool.query(sql, params);
    return rows;
  }
  return sqliteDb.prepare(toSqlite(sql)).all(params);
}

async function queryOne(sql, params = []) {
  if (IS_PG) {
    const { rows } = await pgPool.query(sql, params);
    return rows[0] || null;
  }
  return sqliteDb.prepare(toSqlite(sql)).get(params) || null;
}

// Returns inserted row id
async function insert(sql, params = []) {
  if (IS_PG) {
    const pgSql = sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
    const { rows } = await pgPool.query(pgSql, params);
    return rows[0]?.id;
  }
  const info = sqliteDb.prepare(toSqlite(sql)).run(params);
  return info.lastInsertRowid;
}

async function execute(sql, params = []) {
  if (IS_PG) {
    const result = await pgPool.query(sql, params);
    return result.rowCount;
  }
  const info = sqliteDb.prepare(toSqlite(sql)).run(params);
  return info.changes;
}

// ── Migration ─────────────────────────────────────────────────────────────────
async function migrate() {
  if (IS_PG) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT    UNIQUE NOT NULL,
        full_name     TEXT    NOT NULL DEFAULT '',
        email         TEXT    NOT NULL DEFAULT '',
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL DEFAULT 'user',
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS trades (
        id           SERIAL PRIMARY KEY,
        name         TEXT    UNIQUE NOT NULL,
        bg_color     TEXT    NOT NULL DEFAULT '#EEEDE8',
        border_color TEXT    NOT NULL DEFAULT '#5F5E5A',
        text_color   TEXT    NOT NULL DEFAULT '#2C2C2A',
        label_color  TEXT    NOT NULL DEFAULT '#5F5E5A',
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS work_sessions (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT    NOT NULL,
        tasks_json  TEXT    NOT NULL DEFAULT '[]',
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS session_history (
        id           SERIAL PRIMARY KEY,
        session_id   INTEGER,
        user_id      INTEGER NOT NULL,
        username     TEXT    NOT NULL DEFAULT '',
        session_name TEXT    NOT NULL DEFAULT '',
        action       TEXT    NOT NULL DEFAULT 'saved',
        task_count   INTEGER NOT NULL DEFAULT 0,
        tasks_json   TEXT    NOT NULL DEFAULT '[]',
        saved_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else {
    sqliteDb.exec(`
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
      CREATE TABLE IF NOT EXISTS session_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   INTEGER,
        user_id      INTEGER NOT NULL,
        username     TEXT    NOT NULL DEFAULT '',
        session_name TEXT    NOT NULL DEFAULT '',
        action       TEXT    NOT NULL DEFAULT 'saved',
        task_count   INTEGER NOT NULL DEFAULT 0,
        tasks_json   TEXT    NOT NULL DEFAULT '[]',
        saved_at     DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
}

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seed() {
  // Admin user
  const existing = await queryOne('SELECT id FROM users WHERE username = $1', ['Admin']);
  if (!existing) {
    const hash = bcrypt.hashSync('Admin&123', 10);
    await insert(
      `INSERT INTO users (username, full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Admin', 'System Administrator', 'admin@pullplan.local', hash, 'sysadmin']
    );
  }

  // Default trades
  const { count } = await queryOne('SELECT COUNT(*) AS count FROM trades') || { count: 0 };
  if (parseInt(count) === 0) {
    const defaultTrades = [
      { name: 'Concrete',   bg: '#EEEDE8', border: '#5F5E5A', text: '#2C2C2A', label: '#5F5E5A', order: 1 },
      { name: 'Masonry',    bg: '#FAECE7', border: '#993C1D', text: '#712B13', label: '#993C1D', order: 2 },
      { name: 'Electrical', bg: '#FAEEDA', border: '#854F0B', text: '#633806', label: '#854F0B', order: 3 },
      { name: 'Carpentry',  bg: '#EAF3DE', border: '#3B6D11', text: '#173404', label: '#3B6D11', order: 4 },
      { name: 'Plumbing',   bg: '#E7EEF9', border: '#1D4F99', text: '#0D2B5E', label: '#1D4F99', order: 5 },
      { name: 'HVAC',       bg: '#F0E7F9', border: '#6B1D99', text: '#3D0D5E', label: '#6B1D99', order: 6 },
      { name: 'Steel',      bg: '#E7F0F9', border: '#1D6B99', text: '#0D3B5E', label: '#1D6B99', order: 7 },
    ];
    for (const t of defaultTrades) {
      await insert(
        `INSERT INTO trades (name, bg_color, border_color, text_color, label_color, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [t.name, t.bg, t.border, t.text, t.label, t.order]
      );
    }
  }

  // Default settings
  const settingKeys = [
    'autodesk_client_id', 'autodesk_client_secret',
    'autodesk_hub_id', 'autodesk_project_id', 'autodesk_folder_urn'
  ];
  for (const k of settingKeys) {
    if (IS_PG) {
      await pgPool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [k, '']
      );
    } else {
      sqliteDb.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, '');
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await migrate();
  await seed();
}

module.exports = { init, query, queryOne, insert, execute, IS_PG };
