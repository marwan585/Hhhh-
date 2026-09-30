'use strict';
const fs = require('fs');
const { now } = require('../utils/datetime');
const { parseRecipientsFile } = require('./recipients');
const queue = require('../queue/queue');

/* ---------------------------------------------------------------------------
 * Campaign manager (spec section 8). Campaign lifecycle:
 *   draft -> running -> paused <-> running -> completed / stopped
 * ------------------------------------------------------------------------- */

const EDITABLE_STATES = ['draft', 'paused', 'stopped', 'completed'];

function create(db, { name, message, recipientFile, delayMin, delayMax, maxRecipients }) {
  if (!name || !String(name).trim()) throw new Error('Campaign name is required');
  if (!message || !String(message).trim()) throw new Error('Campaign message is required');
  if (!recipientFile) throw new Error('Recipient file is required (.txt, .csv or .xlsx)');
  const file = String(recipientFile).trim();
  if (!fs.existsSync(file)) throw new Error(`Recipient file not found: ${file}`);

  const dmin = Number(delayMin ?? 6);
  const dmax = Number(delayMax ?? Math.max(dmin, 15));
  if (!Number.isFinite(dmin) || dmin < 0) throw new Error('Delay minimum must be a number >= 0');
  if (!Number.isFinite(dmax) || dmax < dmin) throw new Error('Delay maximum must be >= delay minimum');
  const maxR = Number(maxRecipients ?? 0);
  if (!Number.isFinite(maxR) || maxR < 0) throw new Error('Maximum recipients must be a number >= 0 (0 = unlimited)');

  const dup = db.get('SELECT id FROM campaigns WHERE name = ?', [String(name).trim()]);
  if (dup) throw new Error(`A campaign named "${String(name).trim()}" already exists (id ${dup.id})`);

  const t = now();
  const r = db.run(
    'INSERT INTO campaigns (name, message, recipient_file, delay_min, delay_max, max_recipients, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [String(name).trim(), String(message), file, Math.round(dmin), Math.round(dmax), Math.round(maxR), 'draft', t, t]
  );
  db.flushNow();
  return get(db, r.lastId);
}

function get(db, id) {
  return db.get('SELECT * FROM campaigns WHERE id = ?', [Number(id)]);
}

function getByName(db, name) {
  return db.get('SELECT * FROM campaigns WHERE name = ?', [String(name)]);
}

function list(db) {
  return db.all('SELECT * FROM campaigns ORDER BY id DESC');
}

/**
 * Start (or resume) a campaign: builds the queue from the recipient file the
 * first time, applies the duplicate-protection pipeline, and sets RUNNING.
 */
function start(db, id, { cooldownHours = 24, defaultCC = '62' } = {}) {
  const c = get(db, id);
  if (!c) throw new Error(`Campaign not found: id ${id}`);
  if (c.status === 'running') throw new Error('Campaign is already running');

  const hasQueue = (db.scalar('SELECT COUNT(*) FROM queue WHERE campaign_id = ?', [c.id]) || 0) > 0;
  if (!hasQueue) {
    const { recipients, invalid } = parseRecipientsFile(c.recipient_file, { defaultCC });
    let listToQueue = recipients;
    if (c.max_recipients > 0) listToQueue = recipients.slice(0, c.max_recipients);
    const built = queue.buildQueue(db, c, listToQueue, { cooldownHours });
    if (built.queued === 0) {
      throw new Error(
        `No eligible recipients (queued 0, skipped ${built.skipped}, invalid ${invalid.length}). ` +
        'Check opt-in/consent, blacklist and cooldown rules.'
      );
    }
  } else if (queue.pendingCount(db, c.id) === 0) {
    throw new Error('No pending recipients left in the queue for this campaign');
  }

  db.run(
    "UPDATE campaigns SET status = 'running', status_note = '', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
    [now(), now(), c.id]
  );
  db.flushNow();
  return get(db, c.id);
}

function pause(db, id, note = '') {
  const c = get(db, id);
  if (!c) throw new Error(`Campaign not found: id ${id}`);
  if (c.status !== 'running') throw new Error(`Campaign is not running (status: ${c.status})`);
  db.run("UPDATE campaigns SET status = 'paused', status_note = ?, updated_at = ? WHERE id = ?", [note, now(), c.id]);
  db.flushNow();
  return get(db, c.id);
}

function resume(db, id) {
  const c = get(db, id);
  if (!c) throw new Error(`Campaign not found: id ${id}`);
  if (c.status !== 'paused') throw new Error(`Only paused campaigns can be resumed (status: ${c.status})`);
  if (queue.pendingCount(db, c.id) === 0) throw new Error('No pending recipients left to resume');
  db.run("UPDATE campaigns SET status = 'running', status_note = '', updated_at = ? WHERE id = ?", [now(), c.id]);
  db.flushNow();
  return get(db, c.id);
}

function stop(db, id) {
  const c = get(db, id);
  if (!c) throw new Error(`Campaign not found: id ${id}`);
  if (c.status === 'completed' || c.status === 'stopped') throw new Error(`Campaign already ${c.status}`);
  db.run("UPDATE campaigns SET status = 'stopped', updated_at = ? WHERE id = ?", [now(), c.id]);
  db.flushNow();
  return get(db, c.id);
}

function markCompleted(db, id) {
  db.run("UPDATE campaigns SET status = 'completed', finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?", [now(), now(), id]);
  db.flushNow();
}

function remove(db, id) {
  const c = get(db, id);
  if (!c) throw new Error(`Campaign not found: id ${id}`);
  db.run('DELETE FROM queue WHERE campaign_id = ?', [c.id]);
  db.run('DELETE FROM campaigns WHERE id = ?', [c.id]);
  db.flushNow();
}

function countsSummary(db) {
  const rows = db.all('SELECT status, COUNT(*) AS n FROM campaigns GROUP BY status');
  const map = {};
  for (const r of rows) map[r.status] = Number(r.n);
  return map;
}

module.exports = {
  EDITABLE_STATES,
  create, get, getByName, list, start, pause, resume, stop,
  markCompleted, remove, countsSummary,
};
