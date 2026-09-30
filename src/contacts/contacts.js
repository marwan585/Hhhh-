'use strict';
const { now } = require('../utils/datetime');
const { normalizePhone } = require('../utils/phone');

/* ---------------------------------------------------------------------------
 * Contacts + consent database (spec sections 12-13).
 * Table `contacts` fields: id, phone, name, opt_in, opt_in_at, opt_out,
 * opt_out_at, created_at, updated_at. Plus a `blacklist` (Do Not Contact).
 * ------------------------------------------------------------------------- */

function get(db, phone) {
  return db.get('SELECT * FROM contacts WHERE phone = ?', [phone]);
}

/** Insert or update a contact by phone. Returns { created, contact }. */
function upsert(db, rawPhone, name = '', { defaultCC = '62' } = {}) {
  const norm = normalizePhone(rawPhone, defaultCC);
  if (!norm.valid) throw new Error(`Invalid phone number "${rawPhone}": ${norm.reason}`);
  const t = now();
  const existing = get(db, norm.phone);
  if (existing) {
    if (name && String(name).trim() && String(name).trim() !== existing.name) {
      db.run('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?', [String(name).trim(), t, existing.id]);
    }
    return { created: false, contact: get(db, norm.phone) };
  }
  db.run(
    'INSERT INTO contacts (phone, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [norm.phone, String(name || '').trim(), t, t]
  );
  return { created: true, contact: get(db, norm.phone) };
}

function add(db, rawPhone, name = '', { optIn = false, defaultCC = '62' } = {}) {
  const r = upsert(db, rawPhone, name, { defaultCC });
  if (optIn) optInContact(db, r.contact.phone);
  return { ...r, contact: get(db, r.contact.phone) };
}

function remove(db, phone) {
  db.run('DELETE FROM contacts WHERE phone = ?', [phone]);
}

function optInContact(db, phone) {
  const t = now();
  db.run(
    'UPDATE contacts SET opt_in = 1, opt_in_at = COALESCE(opt_in_at, ?), opt_out = 0, opt_out_at = NULL, updated_at = ? WHERE phone = ?',
    [t, t, phone]
  );
  // An explicit operator opt-in removes keyword/manual opt-out blocks.
  db.run('DELETE FROM blacklist WHERE phone = ?', [phone]);
}

function optOutContact(db, phone, reason = 'opt-out') {
  const t = now();
  db.run(
    'UPDATE contacts SET opt_out = 1, opt_out_at = ?, opt_in = 0, updated_at = ? WHERE phone = ?',
    [t, t, phone]
  );
  db.run(
    'INSERT OR IGNORE INTO blacklist (phone, reason, created_at) VALUES (?, ?, ?)',
    [phone, reason, t]
  );
}

/* ------------------------------- blacklist ------------------------------- */

function isBlacklisted(db, phone) {
  return !!db.get('SELECT id FROM blacklist WHERE phone = ?', [phone]);
}

function blacklistAdd(db, phone, reason = 'manual') {
  db.run('INSERT OR IGNORE INTO blacklist (phone, reason, created_at) VALUES (?, ?, ?)', [phone, reason, now()]);
}

function blacklistRemove(db, phone) {
  db.run('DELETE FROM blacklist WHERE phone = ?', [phone]);
}

function blacklistList(db) {
  return db.all('SELECT * FROM blacklist ORDER BY created_at DESC');
}

/* ------------------------------- eligibility ----------------------------- */

/**
 * Consent gate used before a number may enter a campaign queue.
 * Reasons: NOT_IN_CONTACTS | OPTED_OUT | BLACKLISTED | NOT_OPTED_IN | OK
 */
function eligibility(db, phone) {
  const c = get(db, phone);
  if (!c) return { eligible: false, reason: 'NOT_IN_CONTACTS' };
  if (c.opt_out) return { eligible: false, reason: 'OPTED_OUT' };
  if (isBlacklisted(db, phone)) return { eligible: false, reason: 'BLACKLISTED' };
  if (!c.opt_in) return { eligible: false, reason: 'NOT_OPTED_IN' };
  return { eligible: true, reason: 'OK', contact: c };
}

/* --------------------------------- listing ------------------------------- */

function list(db, { filter = 'all', search = '', limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM contacts';
  const where = [];
  const params = [];
  if (filter === 'opted_in') where.push('opt_in = 1 AND opt_out = 0');
  if (filter === 'opted_out') where.push('opt_out = 1');
  if (filter === 'not_opted_in') where.push('opt_in = 0');
  if (search) { where.push('(phone LIKE ? OR name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit) || 50, Number(offset) || 0);
  return db.all(sql, params);
}

function count(db) {
  return db.scalar('SELECT COUNT(*) FROM contacts') || 0;
}

module.exports = {
  get, upsert, add, remove,
  optInContact, optOutContact,
  isBlacklisted, blacklistAdd, blacklistRemove, blacklistList,
  eligibility, list, count,
};
