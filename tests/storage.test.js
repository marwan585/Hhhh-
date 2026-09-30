'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const storage = require('../src/storage/storage');
const { now, daysAgo } = require('../src/utils/datetime');
const { makeWorkspace } = require('./helpers');

function seedMessages(db) {
  db.run("INSERT INTO campaigns (name, message, created_at, updated_at) VALUES ('Promo', 'm', ?, ?)", [now(), now()]);
  db.run("INSERT INTO messages (direction, phone, campaign_id, body, status, created_at) VALUES ('out', '628111111111', 1, 'halo', 'SENT', ?)", [now()]);
  db.run("INSERT INTO messages (direction, phone, campaign_id, body, status, created_at) VALUES ('out', '628222222222', 1, 'lama', 'SENT', ?)", [daysAgo(40)]);
  db.run("INSERT INTO messages (direction, phone, body, status, created_at) VALUES ('in', '628111111111', 'STOP', 'RECEIVED', ?)", [daysAgo(60)]);
}

test('storage: summary counts messages and sizes dirs', async () => {
  const ws = await makeWorkspace();
  seedMessages(ws.db);
  fs.writeFileSync(path.join(ws.paths.media, 'a.jpg'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(ws.paths.logs, 'app-x.log'), Buffer.alloc(512));
  const s = storage.summary(ws.db, ws.paths);
  assert.equal(s.messages, 3);
  assert.equal(s.mediaSize, 1024);
  assert.equal(s.logs, 512);
  assert.ok(s.total > 0);
  ws.db.close();
});

test('storage: deleteOldMessages removes only old rows', async () => {
  const ws = await makeWorkspace();
  seedMessages(ws.db);
  const n = storage.deleteOldMessages(ws.db, 30);
  assert.equal(n, 2);
  const left = ws.db.all("SELECT phone FROM messages WHERE direction = 'out'").map((r) => r.phone);
  assert.deepEqual(left, ['628111111111']);
  ws.db.close();
});

test('storage: deleteOldMedia removes old files and index rows', async () => {
  const ws = await makeWorkspace();
  const oldFile = path.join(ws.paths.media, 'old.jpg');
  const newFile = path.join(ws.paths.media, 'new.jpg');
  fs.writeFileSync(oldFile, Buffer.alloc(256));
  fs.writeFileSync(newFile, Buffer.alloc(256));
  const oldTime = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(oldFile, oldTime, oldTime);
  ws.db.run("INSERT INTO media (phone, file, created_at) VALUES ('628111111111', 'old.jpg', ?)", [daysAgo(40)]);
  ws.db.run("INSERT INTO media (phone, file, created_at) VALUES ('628111111111', 'new.jpg', ?)", [now()]);

  const r = storage.deleteOldMedia(ws.db, ws.paths, 30);
  assert.equal(r.files, 1);
  assert.ok(!fs.existsSync(oldFile));
  assert.ok(fs.existsSync(newFile));
  assert.equal(ws.db.scalar('SELECT COUNT(*) FROM media'), 1);
  ws.db.close();
});

test('storage: exportHistory writes CSV with consent-friendly phone format', async () => {
  const ws = await makeWorkspace();
  seedMessages(ws.db);
  const r = storage.exportHistory(ws.db, ws.paths, { format: 'csv' });
  assert.equal(r.rows, 3);
  const content = fs.readFileSync(r.file, 'utf8');
  assert.ok(content.includes('+628111111111'));
  assert.ok(content.startsWith('id,direction,phone'));
});

test('storage: exportHistory JSON by campaign', async () => {
  const ws = await makeWorkspace();
  seedMessages(ws.db);
  const r = storage.exportHistory(ws.db, ws.paths, { format: 'json', campaignId: 1 });
  const data = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(data.length, 2);
  assert.equal(data[0].campaign, 'Promo');
  ws.db.close();
});

test('storage: fmtBytes and formatInt', () => {
  assert.equal(storage.fmtBytes(512), '512 B');
  assert.equal(storage.fmtBytes(1024), '1.0 KB');
  assert.equal(storage.fmtBytes(182 * 1024 * 1024), '182.0 MB');
  assert.equal(storage.formatInt(14820), '14,820');
});
