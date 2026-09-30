'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const queue = require('../src/queue/queue');
const { makeWorkspace } = require('./helpers');

function seed(db, n) {
  const t = '2026-01-01 00:00:00';
  db.run("INSERT INTO campaigns (name, message, created_at, updated_at) VALUES ('C', 'm', ?, ?)", [t, t]);
  for (let i = 0; i < n; i++) {
    db.run(
      'INSERT INTO queue (campaign_id, phone, name, message, status, queued_at) VALUES (1, ?, ?, ?, ?, ?)',
      [`6280000000${i}`, `R${i}`, 'm', 'pending', t]
    );
  }
}

test('queue: FIFO nextPending and counts', async () => {
  const { db } = await makeWorkspace();
  seed(db, 3);
  assert.equal(queue.counts(db, 1).total, 3);
  assert.equal(queue.counts(db, 1).pending, 3);
  const first = queue.nextPending(db, 1);
  assert.equal(first.phone, '62800000000');
  queue.markSent(db, first.id, 'MSG-1');
  const second = queue.nextPending(db, 1);
  assert.equal(second.phone, '62800000001');
  const c = queue.counts(db, 1);
  assert.equal(c.sent, 1);
  assert.equal(c.pending, 2);
  db.close();
});

test('queue: markFailed and markSkipped record reasons', async () => {
  const { db } = await makeWorkspace();
  seed(db, 2);
  const a = queue.nextPending(db, 1);
  queue.markFailed(db, a.id, 'network down');
  const b = queue.nextPending(db, 1);
  queue.markSkipped(db, b.id, 'Recently contacted');
  const rows = db.all('SELECT status, error FROM queue ORDER BY id');
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].error, 'network down');
  assert.equal(rows[1].status, 'skipped');
  assert.equal(rows[1].error, 'Recently contacted');
  assert.equal(queue.pendingCount(db, 1), 0);
  db.close();
});

test('queue: crash recovery requeues stuck sending rows (no data loss)', async () => {
  const { db } = await makeWorkspace();
  seed(db, 2);
  const a = queue.nextPending(db, 1);
  queue.markSending(db, a.id);
  assert.equal(queue.counts(db, 1).sending, 1);
  const n = queue.requeueStuck(db);
  assert.equal(n, 1);
  assert.equal(queue.counts(db, 1).pending, 2);
  assert.equal(queue.counts(db, 1).sending, 0);
  db.close();
});

test('queue: incrementAttempts accumulates', async () => {
  const { db } = await makeWorkspace();
  seed(db, 1);
  const a = queue.nextPending(db, 1);
  queue.incrementAttempts(db, a.id);
  queue.incrementAttempts(db, a.id);
  assert.equal(db.scalar('SELECT attempts FROM queue WHERE id = ?', [a.id]), 2);
  db.close();
});

test('queue: listByCampaign returns rows in insertion order', async () => {
  const { db } = await makeWorkspace();
  seed(db, 3);
  const rows = queue.listByCampaign(db, 1, { limit: 10 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'R0');
  db.close();
});
