'use strict';
const { now, hoursAgo } = require('../utils/datetime');
const contacts = require('../contacts/contacts');

/* ---------------------------------------------------------------------------
 * Persistent send queue (spec sections 10 & 13).
 *
 * Duplicate protection pipeline applied before a recipient enters the queue:
 *   check number -> check opt-in -> check blacklist -> check previous
 *   campaign -> check cooldown -> queue message
 * ------------------------------------------------------------------------- */

const SENT_STATUSES = "('SENT','DELIVERED','READ')";

/**
 * Checks that stay valid over time and are re-verified right before sending:
 * previous-campaign receipt + per-recipient cooldown.
 * `excludeQueueId` lets the runner skip the item's own row when re-checking.
 */
function runtimeChecks(db, phone, campaignId, cooldownHours, excludeQueueId = null) {
  let dupQ;
  if (excludeQueueId !== null) {
    dupQ = db.get(
      "SELECT 1 AS x FROM queue WHERE campaign_id = ? AND phone = ? AND id != ? AND status IN ('pending','sending','sent') LIMIT 1",
      [campaignId, phone, excludeQueueId]
    );
  } else {
    dupQ = db.get(
      "SELECT 1 AS x FROM queue WHERE campaign_id = ? AND phone = ? AND status IN ('pending','sending','sent') LIMIT 1",
      [campaignId, phone]
    );
  }
  if (dupQ) return { ok: false, reason: 'Already in this campaign' };

  const dupM = db.get(
    `SELECT 1 AS x FROM messages WHERE campaign_id = ? AND phone = ? AND direction = 'out' AND status IN ${SENT_STATUSES} LIMIT 1`,
    [campaignId, phone]
  );
  if (dupM) return { ok: false, reason: 'Already received this campaign' };

  const cd = Number(cooldownHours || 0);
  if (cd > 0) {
    const cutoff = hoursAgo(cd);
    const recent = db.get(
      `SELECT 1 AS x FROM messages WHERE phone = ? AND direction = 'out' AND status IN ${SENT_STATUSES} AND created_at >= ? LIMIT 1`,
      [phone, cutoff]
    );
    if (recent) return { ok: false, reason: 'Recently contacted' };
  }
  return { ok: true };
}

/** Full pipeline used when building the queue from a recipient file. */
function precheck(db, phone, campaignId, cooldownHours) {
  const el = contacts.eligibility(db, phone);
  if (!el.eligible) return { ok: false, reason: el.reason };
  return runtimeChecks(db, phone, campaignId, cooldownHours);
}

/**
 * Build the queue for a campaign from parsed recipients.
 * Recipients failing any check are recorded as 'skipped' with the reason.
 */
function buildQueue(db, campaign, recipients, { cooldownHours = 24 } = {}) {
  const t = now();
  let queued = 0;
  let skipped = 0;
  for (const r of recipients) {
    const check = precheck(db, r.phone, campaign.id, cooldownHours);
    const status = check.ok ? 'pending' : 'skipped';
    if (check.ok) queued++; else skipped++;
    db.run(
      'INSERT INTO queue (campaign_id, phone, name, message, status, error, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [campaign.id, r.phone, r.name || '', campaign.message || '', status, check.ok ? '' : check.reason, t]
    );
  }
  db.flushNow();
  return { queued, skipped };
}

function counts(db, campaignId) {
  const rows = db.all('SELECT status, COUNT(*) AS n FROM queue WHERE campaign_id = ? GROUP BY status', [campaignId]);
  const c = { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of rows) {
    if (r.status in c) c[r.status] = Number(r.n);
    c.total += Number(r.n);
  }
  return c;
}

function nextPending(db, campaignId) {
  return db.get(
    "SELECT * FROM queue WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 1",
    [campaignId]
  );
}

function pendingCount(db, campaignId) {
  return db.scalar("SELECT COUNT(*) FROM queue WHERE campaign_id = ? AND status = 'pending'", [campaignId]) || 0;
}

function markPending(db, id) {
  db.run("UPDATE queue SET status = 'pending', sent_at = NULL WHERE id = ?", [id]);
}

function markSending(db, id) {
  db.run("UPDATE queue SET status = 'sending' WHERE id = ?", [id]);
}

function markSent(db, id, messageId) {
  db.run("UPDATE queue SET status = 'sent', message_id = ?, sent_at = ?, error = '' WHERE id = ?", [messageId || '', now(), id]);
}

function markFailed(db, id, error) {
  db.run("UPDATE queue SET status = 'failed', error = ? WHERE id = ?", [String(error || '').slice(0, 300), id]);
}

function markSkipped(db, id, reason) {
  db.run("UPDATE queue SET status = 'skipped', error = ? WHERE id = ?", [String(reason || '').slice(0, 300), id]);
}

function incrementAttempts(db, id) {
  db.run('UPDATE queue SET attempts = attempts + 1 WHERE id = ?', [id]);
}

/** Crash recovery: anything stuck mid-send goes back to pending. */
function requeueStuck(db) {
  const r = db.run("UPDATE queue SET status = 'pending' WHERE status = 'sending'");
  return r.changes;
}

function listByCampaign(db, campaignId, { limit = 100 } = {}) {
  return db.all(
    'SELECT * FROM queue WHERE campaign_id = ? ORDER BY id LIMIT ?',
    [campaignId, Number(limit) || 100]
  );
}

module.exports = {
  runtimeChecks, precheck, buildQueue, counts, nextPending, pendingCount,
  markPending, markSending, markSent, markFailed, markSkipped,
  incrementAttempts, requeueStuck, listByCampaign,
};
