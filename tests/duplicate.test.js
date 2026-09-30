'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const contacts = require('../src/contacts/contacts');
const queue = require('../src/queue/queue');
const { now } = require('../src/utils/datetime');
const { makeWorkspace } = require('./helpers');

/* Duplicate protection pipeline (spec section 13):
 * number -> opt-in -> blacklist -> previous campaign -> cooldown -> queue */

const CAMPAIGN = { id: 1, message: 'halo' };

async function setupEligible(db, phone) {
  contacts.add(db, phone, 'Test', { optIn: true, defaultCC: '62' });
}

function insertCampaignRow(db) {
  const t = now();
  db.run("INSERT INTO campaigns (name, message, created_at, updated_at) VALUES ('Promo X', 'halo', ?, ?)", [t, t]);
}

test('duplicate: eligible recipient is queued as pending', async () => {
  const { db } = await makeWorkspace();
  insertCampaignRow(db);
  await setupEligible(db, '628111111111');
  const r = queue.buildQueue(db, CAMPAIGN, [{ phone: '628111111111', name: 'Test' }], { cooldownHours: 24 });
  assert.equal(r.queued, 1);
  assert.equal(r.skipped, 0);
  const row = db.get("SELECT * FROM queue WHERE campaign_id = 1");
  assert.equal(row.status, 'pending');
  db.close();
});

test('duplicate: NOT_IN_CONTACTS is skipped', async () => {
  const { db } = await makeWorkspace();
  insertCampaignRow(db);
  const r = queue.buildQueue(db, CAMPAIGN, [{ phone: '628222222222', name: '' }], { cooldownHours: 24 });
  assert.equal(r.skipped, 1);
  assert.equal(db.scalar('SELECT error FROM queue'), 'NOT_IN_CONTACTS');
  db.close();
});

test('duplicate: NOT_OPTED_IN is skipped', async () => {
  const { db } = await makeWorkspace();
  insertCampaignRow(db);
  contacts.add(db, '628333333333', '', { defaultCC: '62' }); // no opt-in
  const r = queue.buildQueue(db, CAMPAIGN, [{ phone: '628333333333' }], { cooldownHours: 24 });
  assert.equal(r.skipped, 1);
  assert.equal(db.scalar('SELECT error FROM queue'), 'NOT_OPTED_IN');
  db.close();
});

test('duplicate: OPTED_OUT is skipped (unsubscribed numbers never enter)', async () => {
  const { db } = await makeWorkspace();
  insertCampaignRow(db);
  contacts.add(db, '628444444444', '', { optIn: true, defaultCC: '62' });
  contacts.optOutContact(db, '628444444444', 'STOP');
  const r = queue.buildQueue(db, CAMPAIGN, [{ phone: '628444444444' }], { cooldownHours: 24 });
  assert.equal(r.skipped, 1);
  assert.equal(db.scalar('SELECT error FROM queue'), 'OPTED_OUT');
  db.close();
});

test('duplicate: BLACKLISTED is skipped', async () => {
  const { db } = await makeWorkspace();
  insertCampaignRow(db);
  await setupEligible(db, '628555555555');
  contacts.blacklistAdd(db, '628555555555', 'manual');
  const r = queue.buildQueue(db, CAMPAIGN, [{ phone: '628555555555' }], { cooldownHours: 24 });
  assert.equal(r.skipped, 1);
  assert.equal(db.scalar('SELECT error FROM queue'), 'BLACKLISTED');
  db.close();
});

test('duplicate: recently contacted within cooldown is skipped', async () => {
  const { db } = await makeWorkspace();
  insertCampaignRow(db);
  await setupEligible(db, '628666666666');
  db.run(
    `INSERT INTO messages (direction, phone, status, created_at) VALUES ('out', '628666666666', 'SENT', ?)`,
    [now()]
  );
  const r = queue.buildQueue(db, CAMPAIGN, [{ phone: '628666666666' }], { cooldownHours: 24 });
  assert.equal(r.skipped, 1);
  assert.equal(db.scalar('SELECT error FROM queue'), 'Recently contacted');
  db.close();
});

test('duplicate: old contact outside cooldown passes', async () => {
  const { db } = await makeWorkspace();
  insertCampaignRow(db);
  await setupEligible(db, '628777777777');
  db.run(
    `INSERT INTO messages (direction, phone, status, created_at) VALUES ('out', '628777777777', 'SENT', ?)`,
    ['2025-01-01 00:00:00']
  );
  const r = queue.buildQueue(db, CAMPAIGN, [{ phone: '628777777777' }], { cooldownHours: 24 });
  assert.equal(r.queued, 1);
  db.close();
});

test('duplicate: same campaign already received is skipped', async () => {
  const { db } = await makeWorkspace();
  insertCampaignRow(db);
  await setupEligible(db, '628888888888');
  db.run(
    `INSERT INTO messages (direction, phone, campaign_id, status, created_at) VALUES ('out', '628888888888', 1, 'SENT', ?)`,
    ['2025-01-01 00:00:00']
  );
  const r = queue.buildQueue(db, CAMPAIGN, [{ phone: '628888888888' }], { cooldownHours: 24 });
  assert.equal(r.skipped, 1);
  assert.equal(db.scalar('SELECT error FROM queue'), 'Already received this campaign');
  db.close();
});
