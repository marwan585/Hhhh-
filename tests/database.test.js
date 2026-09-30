'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { makeWorkspace } = require('./helpers');

test('database: creates schema tables and indexes', async () => {
  const { db } = await makeWorkspace();
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const t of ['contacts', 'blacklist', 'campaigns', 'queue', 'messages', 'media', 'meta']) {
    assert.ok(tables.includes(t), `table ${t} should exist`);
  }
  db.close();
});

test('database: run/get/all/lastId/changes behave correctly', async () => {
  const { db } = await makeWorkspace();
  const r1 = db.run("INSERT INTO contacts (phone, name, created_at, updated_at) VALUES ('628123', 'Andi', '2026-01-01 00:00:00', '2026-01-01 00:00:00')");
  assert.equal(r1.changes, 1);
  assert.equal(r1.lastId, 1);
  const c = db.get('SELECT * FROM contacts WHERE phone = ?', ['628123']);
  assert.equal(c.name, 'Andi');
  const r2 = db.run('UPDATE contacts SET name = ? WHERE phone = ?', ['Budi', '628123']);
  assert.equal(r2.changes, 1);
  assert.equal(db.all('SELECT * FROM contacts').length, 1);
  db.close();
});

test('database: persists to disk and reloads data (session/queue durability)', async () => {
  const { db, paths } = await makeWorkspace();
  db.run("INSERT INTO campaigns (name, message, created_at, updated_at) VALUES ('Promo', 'halo', '2026-01-01 00:00:00', '2026-01-01 00:00:00')");
  db.flushNow();
  db.close();
  assert.ok(fs.existsSync(paths.database));

  const db2 = await Database_open(paths.database);
  const row = db2.get('SELECT * FROM campaigns WHERE name = ?', ['Promo']);
  assert.equal(row.message, 'halo');
  db2.close();
});

async function Database_open(file) {
  const { Database } = require('../src/database/db');
  return Database.open(file);
}

test('database: flushes automatically after debounce (dirty flag)', async () => {
  const { db, paths } = await makeWorkspace();
  db.run("INSERT INTO contacts (phone, created_at, updated_at) VALUES ('628001', 't', 't')");
  assert.ok(db.isDirty());
  await new Promise((r) => setTimeout(r, 600)); // debounce is 400ms
  assert.ok(!db.isDirty());
  assert.ok(fs.existsSync(paths.database));
  db.close();
});

test('database: corrupt file is quarantined and replaced, never crashes', async () => {
  const { db, paths } = await makeWorkspace();
  db.run("INSERT INTO contacts (phone, created_at, updated_at) VALUES ('628002', 't', 't')");
  db.flushNow();
  db.close();
  fs.writeFileSync(paths.database, Buffer.from('this is not a sqlite file at all'));
  const db2 = await Database_open(paths.database);
  require('../src/database/schema').initSchema(db2); // production always bootstraps schema after open
  assert.equal(db2.scalar('SELECT COUNT(*) FROM contacts'), 0);
  const quarantined = fs.readdirSync(require('path').dirname(paths.database)).some((f) => f.includes('.corrupt-'));
  assert.ok(quarantined, 'corrupt file should be kept aside');
  db2.close();
});
