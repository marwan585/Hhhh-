'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const contacts = require('../src/contacts/contacts');
const { makeWorkspace } = require('./helpers');

test('contacts: add creates contact with opt-in', async () => {
  const { db } = await makeWorkspace();
  const r = contacts.add(db, '08123456789', 'Andi', { optIn: true, defaultCC: '62' });
  assert.equal(r.created, true);
  assert.equal(r.contact.phone, '628123456789');
  assert.equal(r.contact.opt_in, 1);
  assert.ok(r.contact.opt_in_at);
  db.close();
});

test('contacts: upsert updates name without duplicating', async () => {
  const { db } = await makeWorkspace();
  contacts.upsert(db, '628123456789', 'Andi', { defaultCC: '62' });
  const r2 = contacts.upsert(db, '+628123456789', 'Andi Saputra', { defaultCC: '62' });
  assert.equal(r2.created, false);
  assert.equal(db.scalar('SELECT COUNT(*) FROM contacts'), 1);
  assert.equal(db.scalar('SELECT name FROM contacts'), 'Andi Saputra');
  db.close();
});

test('contacts: invalid number throws with reason', async () => {
  const { db } = await makeWorkspace();
  assert.throws(() => contacts.add(db, '123', 'x', { defaultCC: '62' }), /Invalid phone/);
  db.close();
});

test('contacts: opt-in / opt-out transitions and blacklist linkage', async () => {
  const { db } = await makeWorkspace();
  contacts.add(db, '628123456789', 'Andi', { defaultCC: '62' });
  assert.equal(contacts.eligibility(db, '628123456789').reason, 'NOT_OPTED_IN');

  contacts.optInContact(db, '628123456789');
  assert.equal(contacts.eligibility(db, '628123456789').eligible, true);

  contacts.optOutContact(db, '628123456789', 'STOP keyword');
  const el = contacts.eligibility(db, '628123456789');
  assert.equal(el.reason, 'OPTED_OUT');
  assert.ok(contacts.isBlacklisted(db, '628123456789'), 'opt-out adds Do Not Contact entry');

  // re-opt-in clears the keyword block (explicit operator action)
  contacts.optInContact(db, '628123456789');
  assert.equal(contacts.eligibility(db, '628123456789').eligible, true);
  assert.ok(!contacts.isBlacklisted(db, '628123456789'));
  db.close();
});

test('contacts: blacklist add/remove works independently', async () => {
  const { db } = await makeWorkspace();
  contacts.add(db, '628987654321', 'Budi', { optIn: true, defaultCC: '62' });
  contacts.blacklistAdd(db, '628987654321', 'manual block');
  assert.equal(contacts.eligibility(db, '628987654321').reason, 'BLACKLISTED');
  contacts.blacklistRemove(db, '628987654321');
  assert.equal(contacts.eligibility(db, '628987654321').eligible, true);
  db.close();
});

test('contacts: eligibility requires contact to exist', async () => {
  const { db } = await makeWorkspace();
  assert.equal(contacts.eligibility(db, '62999').reason, 'NOT_IN_CONTACTS');
  db.close();
});

test('contacts: list filters and delete', async () => {
  const { db } = await makeWorkspace();
  contacts.add(db, '628111111111', 'A', { optIn: true, defaultCC: '62' });
  contacts.add(db, '628222222222', 'B', { defaultCC: '62' });
  contacts.optOutContact(db, '628222222222');
  assert.equal(contacts.list(db, { filter: 'opted_in' }).length, 1);
  assert.equal(contacts.list(db, { filter: 'opted_out' }).length, 1);
  assert.equal(contacts.list(db, { search: '628111' }).length, 1);
  contacts.remove(db, '628111111111');
  assert.equal(contacts.get(db, '628111111111'), undefined);
  db.close();
});

test('contacts: count', async () => {
  const { db } = await makeWorkspace();
  contacts.add(db, '628333333333', '', { defaultCC: '62' });
  assert.equal(contacts.count(db), 1);
  db.close();
});
