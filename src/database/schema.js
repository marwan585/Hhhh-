'use strict';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  opt_in INTEGER NOT NULL DEFAULT 0,
  opt_in_at TEXT,
  opt_out INTEGER NOT NULL DEFAULT 0,
  opt_out_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  recipient_file TEXT NOT NULL DEFAULT '',
  delay_min INTEGER NOT NULL DEFAULT 6,
  delay_max INTEGER NOT NULL DEFAULT 15,
  max_recipients INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  status_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  queued_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  campaign_id INTEGER,
  message_id TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  media_file TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  file TEXT NOT NULL,
  mimetype TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_campaign_status ON queue (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages (phone, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages (campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
`;

function initSchema(db) {
  db.exec(SCHEMA_SQL);
  db.flushNow();
}

module.exports = { SCHEMA_SQL, initSchema };
