'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const backup = require('../src/storage/backup');
const { Database } = require('../src/database/db');
const { initSchema } = require('../src/database/schema');
const { now } = require('../src/utils/datetime');
const { makeWorkspace } = require('./helpers');

async function seedData(ws) {
  ws.db.run("INSERT INTO contacts (phone, name, opt_in, created_at, updated_at) VALUES ('628123456789', 'Andi', 1, ?, ?)", [now(), now()]);
  ws.db.run("INSERT INTO campaigns (name, message, created_at, updated_at) VALUES ('Promo', 'halo', ?, ?)", [now(), now()]);
  ws.db.run("INSERT INTO messages (direction, phone, body, status, created_at) VALUES ('out', '628123456789', 'halo', 'SENT', ?)", [now()]);
  ws.db.flushNow();
}

test('backup: creates folder with database, config and manifest (NO session files)', async () => {
  const ws = await makeWorkspace();
  await seedData(ws);
  fs.writeFileSync(path.join(ws.paths.sessions, 'creds.json'), '{"secret":true}');

  const r = backup.createBackup({ db: ws.db, paths: ws.paths, root: ws.dir, logger: null });
  assert.ok(fs.existsSync(path.join(r.dir, 'database.sqlite')));
  assert.ok(fs.existsSync(path.join(r.dir, 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(r.dir, 'sessions.enc')), 'session must NOT be included by default');
  assert.equal(r.manifest.counts.contacts, 1);
  assert.equal(r.manifest.counts.messages, 1);
  assert.equal(r.manifest.includes_session, false);
  const files = backup.listBackups(ws.paths);
  assert.equal(files.length, 1);
  ws.db.close();
});

test('backup: encrypted session backup roundtrip (AES-256-GCM)', async () => {
  const ws = await makeWorkspace();
  await seedData(ws);
  fs.writeFileSync(path.join(ws.paths.sessions, 'creds.json'), '{"secret":true}');
  fs.writeFileSync(path.join(ws.paths.sessions, 'key-abc'), 'binarydata');

  const r = backup.createBackup({
    db: ws.db, paths: ws.paths, root: ws.dir, logger: null,
    includeSession: true, password: 'S3cret!',
  });
  assert.ok(fs.existsSync(r.sessionArchive));
  assert.equal(r.manifest.includes_session, true);

  // wipe live session, then restore from the encrypted archive
  fs.rmSync(ws.paths.sessions, { recursive: true, force: true });
  const outDir = path.join(ws.dir, 'restored-sessions');
  const n = backup.decryptSessionBackup({ encFile: r.sessionArchive, password: 'S3cret!', outDir });
  assert.equal(n, 2);
  assert.equal(fs.readFileSync(path.join(outDir, 'creds.json'), 'utf8'), '{"secret":true}');
  assert.equal(fs.readFileSync(path.join(outDir, 'key-abc'), 'utf8'), 'binarydata');
  ws.db.close();
});

test('backup: wrong password fails loudly (auth tag mismatch)', async () => {
  const ws = await makeWorkspace();
  fs.writeFileSync(path.join(ws.paths.sessions, 'creds.json'), '{"x":1}');
  const r = backup.createBackup({ db: ws.db, paths: ws.paths, root: ws.dir, logger: null, includeSession: true, password: 'right' });
  assert.throws(() => backup.decryptSessionBackup({ encFile: r.sessionArchive, password: 'wrong', outDir: path.join(ws.dir, 'o2') }));
  ws.db.close();
});

test('backup: include-session without password throws', async () => {
  const ws = await makeWorkspace();
  assert.throws(
    () => backup.createBackup({ db: ws.db, paths: ws.paths, root: ws.dir, logger: null, includeSession: true }),
    /password/i
  );
  ws.db.close();
});

test('backup: restore rolls the database back to the backup point', async () => {
  const ws = await makeWorkspace();
  await seedData(ws);
  const r = backup.createBackup({ db: ws.db, paths: ws.paths, root: ws.dir, logger: null });

  // mutate after the backup
  ws.db.run("DELETE FROM contacts");
  ws.db.flushNow();
  assert.equal(ws.db.scalar('SELECT COUNT(*) FROM contacts'), 0);

  const res = backup.restoreBackup({ db: ws.db, paths: ws.paths, backupName: r.name });
  assert.ok(res.manifest);
  const db2 = await Database.open(ws.paths.database);
  initSchema(db2);
  assert.equal(db2.scalar('SELECT COUNT(*) FROM contacts'), 1);
  assert.equal(db2.scalar('SELECT COUNT(*) FROM messages'), 1);
  db2.close();
  ws.db.close();
});
