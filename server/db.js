'use strict';
// SQLite (Node अंगभूत node:sqlite) वर खोल्या व गुण कायमस्वरूपी साठवतो.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'game.db'));
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL
  );`);
  const upsert = db.prepare(
    'INSERT INTO rooms (code, data, updated) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data=excluded.data, updated=excluded.updated'
  );
  const del = db.prepare('DELETE FROM rooms WHERE code = ?');
  const all = db.prepare('SELECT code, data, updated FROM rooms');
  const purge = db.prepare('DELETE FROM rooms WHERE updated < ?');
  return {
    save(code, obj) { upsert.run(code, JSON.stringify(obj), Date.now()); },
    remove(code) { del.run(code); },
    loadAll() {
      return all.all().map((r) => {
        try { return { code: r.code, data: JSON.parse(r.data), updated: r.updated }; } catch { return null; }
      }).filter(Boolean);
    },
    purgeOlderThan(ms) { purge.run(Date.now() - ms); },
    close() { try { db.close(); } catch {} },
  };
}

module.exports = { openDb };
