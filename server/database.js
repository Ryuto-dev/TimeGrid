const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'schedule.db');

let db;

function getDb() {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'New Schedule',
      start_hour INTEGER NOT NULL DEFAULT 6,
      start_minute INTEGER NOT NULL DEFAULT 0,
      end_hour INTEGER NOT NULL DEFAULT 22,
      end_minute INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT '#4A90D9',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      event_type TEXT NOT NULL DEFAULT 'range',
      start_hour INTEGER NOT NULL,
      start_minute INTEGER NOT NULL,
      end_hour INTEGER,
      end_minute INTEGER,
      color TEXT DEFAULT '#4A90D9',
      text_color TEXT DEFAULT '#FFFFFF',
      icon TEXT DEFAULT '',
      place_ids TEXT NOT NULL DEFAULT '[]',
      notes_column TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      data TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      client_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_schedule ON events(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_places_schedule ON places(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_changelog_schedule ON change_log(schedule_id, id);
  `);
}

// ── Schedule CRUD ──

function createSchedule(name = 'New Schedule') {
  const d = getDb();
  const id = uuidv4();
  d.prepare(`INSERT INTO schedules (id, name) VALUES (?, ?)`).run(id, name);
  // Create default places
  const defaultPlaces = ['Stage A', 'Stage B', 'Stage C'];
  defaultPlaces.forEach((pname, i) => {
    const pid = uuidv4();
    const colors = ['#4A90D9', '#E8913A', '#50B83C'];
    d.prepare(`INSERT INTO places (id, schedule_id, name, sort_order, color) VALUES (?, ?, ?, ?, ?)`)
      .run(pid, id, pname, i, colors[i]);
  });
  return getSchedule(id);
}

function getSchedule(id) {
  const d = getDb();
  const schedule = d.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
  if (!schedule) return null;
  schedule.places = d.prepare(`SELECT * FROM places WHERE schedule_id = ? ORDER BY sort_order`).all(id);
  schedule.events = d.prepare(`SELECT * FROM events WHERE schedule_id = ?`).all(id);
  schedule.events = schedule.events.map(e => ({
    ...e,
    place_ids: JSON.parse(e.place_ids || '[]')
  }));
  return schedule;
}

function updateSchedule(id, data) {
  const d = getDb();
  const fields = [];
  const values = [];
  const allowed = ['name', 'start_hour', 'start_minute', 'end_hour', 'end_minute'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if (fields.length === 0) return getSchedule(id);
  fields.push(`updated_at = datetime('now')`);
  values.push(id);
  d.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getSchedule(id);
}

function listSchedules() {
  const d = getDb();
  return d.prepare(`SELECT id, name, created_at, updated_at FROM schedules ORDER BY updated_at DESC`).all();
}

function deleteSchedule(id) {
  const d = getDb();
  d.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
}

// ── Place CRUD ──

function addPlace(scheduleId, name, color = '#4A90D9') {
  const d = getDb();
  const id = uuidv4();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(sort_order), -1) as m FROM places WHERE schedule_id = ?`).get(scheduleId);
  d.prepare(`INSERT INTO places (id, schedule_id, name, sort_order, color) VALUES (?, ?, ?, ?, ?)`)
    .run(id, scheduleId, name, (maxOrder?.m ?? -1) + 1, color);
  return d.prepare(`SELECT * FROM places WHERE id = ?`).get(id);
}

function updatePlace(id, data) {
  const d = getDb();
  const fields = [];
  const values = [];
  const allowed = ['name', 'sort_order', 'color'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if (fields.length === 0) return d.prepare(`SELECT * FROM places WHERE id = ?`).get(id);
  values.push(id);
  d.prepare(`UPDATE places SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return d.prepare(`SELECT * FROM places WHERE id = ?`).get(id);
}

function deletePlace(id) {
  const d = getDb();
  const place = d.prepare(`SELECT * FROM places WHERE id = ?`).get(id);
  if (!place) return;
  // Remove place from events' place_ids
  const events = d.prepare(`SELECT * FROM events WHERE schedule_id = ?`).all(place.schedule_id);
  for (const evt of events) {
    const pids = JSON.parse(evt.place_ids || '[]');
    const filtered = pids.filter(p => p !== id);
    d.prepare(`UPDATE events SET place_ids = ? WHERE id = ?`).run(JSON.stringify(filtered), evt.id);
  }
  d.prepare(`DELETE FROM places WHERE id = ?`).run(id);
}

function reorderPlaces(scheduleId, placeIds) {
  const d = getDb();
  const stmt = d.prepare(`UPDATE places SET sort_order = ? WHERE id = ? AND schedule_id = ?`);
  const txn = d.transaction(() => {
    placeIds.forEach((pid, i) => {
      stmt.run(i, pid, scheduleId);
    });
  });
  txn();
  return d.prepare(`SELECT * FROM places WHERE schedule_id = ? ORDER BY sort_order`).all(scheduleId);
}

// ── Event CRUD ──

function addEvent(scheduleId, data) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(`INSERT INTO events (id, schedule_id, title, description, event_type, start_hour, start_minute, end_hour, end_minute, color, text_color, icon, place_ids, notes_column)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, scheduleId,
      data.title || 'New Event',
      data.description || '',
      data.event_type || 'range',
      data.start_hour ?? 9,
      data.start_minute ?? 0,
      data.end_hour ?? (data.event_type === 'task' ? null : 10),
      data.end_minute ?? (data.event_type === 'task' ? null : 0),
      data.color || '#4A90D9',
      data.text_color || '#FFFFFF',
      data.icon || '',
      JSON.stringify(data.place_ids || []),
      data.notes_column || ''
    );
  const evt = d.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
  evt.place_ids = JSON.parse(evt.place_ids || '[]');
  return evt;
}

function updateEvent(id, data) {
  const d = getDb();
  const fields = [];
  const values = [];
  const allowed = ['title', 'description', 'event_type', 'start_hour', 'start_minute',
    'end_hour', 'end_minute', 'color', 'text_color', 'icon', 'notes_column'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if (data.place_ids !== undefined) {
    fields.push(`place_ids = ?`);
    values.push(JSON.stringify(data.place_ids));
  }
  if (fields.length === 0) {
    const evt = d.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
    if (evt) evt.place_ids = JSON.parse(evt.place_ids || '[]');
    return evt;
  }
  fields.push(`updated_at = datetime('now')`);
  values.push(id);
  d.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const evt = d.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
  if (evt) evt.place_ids = JSON.parse(evt.place_ids || '[]');
  return evt;
}

function deleteEvent(id) {
  const d = getDb();
  d.prepare(`DELETE FROM events WHERE id = ?`).run(id);
}

// ── Change log for SSE ──

function logChange(scheduleId, action, entityType, entityId, data, clientId) {
  const d = getDb();
  d.prepare(`INSERT INTO change_log (schedule_id, action, entity_type, entity_id, data, client_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(scheduleId, action, entityType, entityId, JSON.stringify(data), clientId || null);
}

function getChangesSince(scheduleId, sinceId) {
  const d = getDb();
  return d.prepare(`SELECT * FROM change_log WHERE schedule_id = ? AND id > ? ORDER BY id ASC`)
    .all(scheduleId, sinceId || 0);
}

function getLatestChangeId(scheduleId) {
  const d = getDb();
  const row = d.prepare(`SELECT COALESCE(MAX(id), 0) as maxId FROM change_log WHERE schedule_id = ?`).get(scheduleId);
  return row?.maxId || 0;
}

module.exports = {
  getDb, initTables,
  createSchedule, getSchedule, updateSchedule, listSchedules, deleteSchedule,
  addPlace, updatePlace, deletePlace, reorderPlaces,
  addEvent, updateEvent, deleteEvent,
  logChange, getChangesSince, getLatestChangeId
};
