'use strict';
const fs = require('fs');
const path = require('path');
const { daysAgo, now } = require('../utils/datetime');

/* ---------------------------------------------------------------------------
 * Storage management (spec section 7).
 * ------------------------------------------------------------------------- */

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else {
        try { total += fs.statSync(p).size; } catch (_) { /* file vanished */ }
      }
    }
  } catch (_) { /* missing dir */ }
  return total;
}

function countFiles(dir) {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
      else n += 1;
    }
  } catch (_) { /* missing dir */ }
  return n;
}

function formatInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function summary(db, paths) {
  const messages = db.scalar('SELECT COUNT(*) FROM messages') || 0;
  const mediaSize = dirSize(paths.media);
  const mediaFiles = countFiles(paths.media);
  const database = fs.existsSync(paths.database) ? fs.statSync(paths.database).size : 0;
  const logs = dirSize(paths.logs);
  const backups = dirSize(paths.backups);
  return {
    messages,
    mediaSize,
    mediaFiles,
    database,
    logs,
    backups,
    total: mediaSize + database + logs + backups,
  };
}

function printSummary(s) {
  const pc = require('picocolors');
  console.log('');
  console.log(pc.bold(pc.cyan('CLOUD MASTER STORAGE')));
  console.log(` Messages : ${formatInt(s.messages)}`);
  console.log(` Media    : ${fmtBytes(s.mediaSize)} (${formatInt(s.mediaFiles)} files)`);
  console.log(` Database : ${fmtBytes(s.database)}`);
  console.log(` Logs     : ${fmtBytes(s.logs)}`);
  console.log(` Backups  : ${fmtBytes(s.backups)}`);
  console.log(` Total    : ${pc.bold(fmtBytes(s.total))}`);
  console.log('');
}

function deleteOldMessages(db, days) {
  const cutoff = daysAgo(days);
  const r = db.run('DELETE FROM messages WHERE created_at < ?', [cutoff]);
  db.flushNow();
  return r.changes;
}

function deleteOldMedia(db, paths, days) {
  const cutoffMs = Date.now() - Number(days || 0) * 86400000;
  let files = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(paths.media)) {
      const p = path.join(paths.media, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoffMs) {
          bytes += st.size;
          fs.unlinkSync(p);
          files += 1;
        }
      } catch (_) { /* ignore single-file errors */ }
    }
  } catch (_) { /* missing dir */ }
  const r = db.run('DELETE FROM media WHERE created_at < ?', [daysAgo(days)]);
  db.flushNow();
  return { files, bytes, rows: r.changes };
}

function deleteMessagesForPhone(db, phone) {
  const r = db.run('DELETE FROM messages WHERE phone = ?', [phone]);
  db.flushNow();
  return r.changes;
}

/**
 * Export message history to CSV or JSON (spec storage menu [4]).
 * Returns the absolute path of the written file.
 */
function exportHistory(db, paths, { format = 'csv', campaignId = null, phone = null } = {}) {
  fs.mkdirSync(paths.exports, { recursive: true });
  let sql = `SELECT m.id, m.direction, m.phone, m.name, c.name AS campaign,
                    m.message_id, m.body, m.status, m.error, m.media_file, m.created_at
             FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id`;
  const where = [];
  const params = [];
  if (campaignId) { where.push('m.campaign_id = ?'); params.push(Number(campaignId)); }
  if (phone) { where.push('m.phone = ?'); params.push(phone); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY m.id';
  const rows = db.all(sql, params);
  const stamp = now().replace(/[-: ]/g, '');
  const file = path.join(paths.exports, `history-${stamp}.${format === 'json' ? 'json' : 'csv'}`);

  if (format === 'json') {
    fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
  } else {
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const headers = ['id', 'direction', 'phone', 'name', 'campaign', 'message_id', 'body', 'status', 'error', 'media_file', 'created_at'];
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map((h) => esc(h === 'phone' ? '+' + r.phone : r[h])).join(','));
    fs.writeFileSync(file, lines.join('\n') + '\n');
  }
  return { file, rows: rows.length };
}

module.exports = {
  dirSize, countFiles, formatInt, fmtBytes,
  summary, printSummary,
  deleteOldMessages, deleteOldMedia, deleteMessagesForPhone,
  exportHistory,
};
