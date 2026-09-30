'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/database/db');
const { initSchema } = require('../src/database/schema');

/** Isolated temp workspace with an initialized database for every test. */
async function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-test-'));
  const paths = {
    root: dir,
    database: path.join(dir, 'database.sqlite'),
    sessions: path.join(dir, 'sessions'),
    logs: path.join(dir, 'logs'),
    messages: path.join(dir, 'messages'),
    media: path.join(dir, 'media'),
    backups: path.join(dir, 'backups'),
    exports: path.join(dir, 'exports'),
    config: path.join(dir, 'config.json'),
  };
  for (const k of ['sessions', 'logs', 'messages', 'media', 'backups', 'exports']) {
    fs.mkdirSync(paths[k], { recursive: true });
  }
  const db = await Database.open(paths.database);
  initSchema(db);
  return { dir, paths, db };
}

module.exports = { makeWorkspace };
