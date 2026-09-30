'use strict';
const ui = require('./ui');
const pc = require('picocolors');
const storage = require('../storage/storage');
const backup = require('../storage/backup');
const { Database } = require('../database/db');
const { saveConfig } = require('../utils/config');
const { Logger } = require('../logger/logger');
const { ensureAll } = require('../utils/paths');

/* ---------------------------------------------------------------------------
 * Storage / Logs / Settings menus (spec sections 7, 17, 18).
 * ------------------------------------------------------------------------- */

async function chooseAge(label = 'Delete data older than') {
  console.log(` ${label}:  [1] 7 days   [2] 30 days   [3] 90 days   [4] Custom`);
  const c = await ui.ask('> ');
  if (c === '1') return 7;
  if (c === '2') return 30;
  if (c === '3') return 90;
  if (c === '4') return ui.askInt('Days: ', { min: 1 });
  return null;
}

async function storageMenu(ctx) {
  for (;;) {
    ui.title('Storage Management');
    console.log(' [1] View Storage');
    console.log(' [2] Delete Old Messages');
    console.log(' [3] Delete Media');
    console.log(' [4] Export History');
    console.log(' [5] Backup Database');
    console.log(' [6] Restore Database');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '1') {
      storage.printSummary(storage.summary(ctx.db, ctx.paths));
    } else if (c === '2') {
      const days = await chooseAge('Delete messages older than');
      if (!days) continue;
      if (!(await ui.confirm(`Delete messages older than ${days} days? This cannot be undone.`, false))) continue;
      const n = storage.deleteOldMessages(ctx.db, days);
      ui.successLine(`Deleted ${n} messages older than ${days} days.`);
      ctx.logger.info(`Storage cleanup: deleted ${n} messages older than ${days} days`);
    } else if (c === '3') {
      const days = await chooseAge('Delete media older than');
      if (!days) continue;
      if (!(await ui.confirm(`Delete media files older than ${days} days? This cannot be undone.`, false))) continue;
      const r = storage.deleteOldMedia(ctx.db, ctx.paths, days);
      ui.successLine(`Deleted ${r.files} media files (${storage.fmtBytes(r.bytes)}), ${r.rows} index rows.`);
      ctx.logger.info(`Storage cleanup: deleted ${r.files} media files older than ${days} days`);
    } else if (c === '4') {
      await exportHistoryFlow(ctx);
    } else if (c === '5') {
      await backupDatabaseFlow(ctx);
    } else if (c === '6') {
      await restoreDatabaseFlow(ctx);
    } else if (c === '0') return;
    else ui.warnLine('Invalid choice.');
  }
}

async function exportHistoryFlow(ctx) {
  const f = await ui.ask('Format [1] CSV (default)  [2] JSON: ');
  const format = f === '2' ? 'json' : 'csv';
  const scope = await ui.ask('Scope [1] All (default)  [2] One campaign: ');
  let campaignId = null;
  if (scope === '2') {
    const id = await ui.ask('Campaign id: ');
    if (!/^\d+$/.test(id)) { ui.errorLine('Invalid campaign id.'); return; }
    campaignId = Number(id);
  }
  try {
    const r = storage.exportHistory(ctx.db, ctx.paths, { format, campaignId });
    ui.successLine(`Exported ${r.rows} messages to:`);
    console.log(`   ${r.file}`);
    ctx.logger.info(`History exported: ${r.file} (${r.rows} rows)`);
  } catch (e) {
    ui.errorLine(e.message);
  }
}

async function backupDatabaseFlow(ctx) {
  let includeSession = false;
  let password = null;
  const inc = await ui.confirm('Include ENCRYPTED session backup? (requires a password; raw credentials are never stored)', false);
  if (inc) {
    includeSession = true;
    password = await ui.askRequired('Encryption password: ');
  }
  try {
    const r = backup.createBackup({ db: ctx.db, paths: ctx.paths, root: ctx.root, logger: ctx.logger, includeSession, password });
    ui.successLine(`Backup created: ${r.name}`);
    console.log(`   Database  : ${storage.fmtBytes(require('fs').statSync(require('path').join(r.dir, 'database.sqlite')).size)}`);
    console.log(`   Contacts  : ${r.manifest.counts.contacts}`);
    console.log(`   Campaigns : ${r.manifest.counts.campaigns}`);
    console.log(`   Messages  : ${r.manifest.counts.messages}`);
    if (r.sessionArchive) ui.successLine('Encrypted session archive: sessions.enc (AES-256-GCM)');
    else ui.infoLine('Session credentials NOT included (privacy by default).');
  } catch (e) {
    ui.errorLine(e.message);
  }
}

async function restoreDatabaseFlow(ctx) {
  const list = backup.listBackups(ctx.paths);
  if (!list.length) { ui.warnLine('No backups found.'); return; }
  console.log(' Available backups:');
  list.forEach((name, i) => {
    const m = backup.readManifest(ctx.paths, name);
    console.log(` [${i + 1}] ${name}${m ? `  - ${m.created_at} (messages: ${m.counts.messages})` : ''}`);
  });
  const pick = await ui.ask('Backup number (empty = cancel): ');
  if (!pick) return;
  const idx = Number(pick) - 1;
  if (!list[idx]) { ui.errorLine('Invalid selection.'); return; }
  ui.warnLine('Restoring replaces the CURRENT database. Messages sent after the backup will be lost.');
  if (!(await ui.confirm(`Restore "${list[idx]}"?`, false))) return;
  try {
    const r = backup.restoreBackup({ db: ctx.db, paths: ctx.paths, backupName: list[idx] });
    ctx.db = await Database.open(ctx.paths.database);
    ui.successLine(`Database restored from: ${r.dir}`);
    ctx.logger.warn(`Database restored from backup: ${list[idx]}`);
  } catch (e) {
    // db may already be closed - reopen no matter what
    try { ctx.db = await Database.open(ctx.paths.database); } catch (_) { /* ignore */ }
    ui.errorLine(e.message);
  }
}

async function backupRestoreMenu(ctx) {
  for (;;) {
    ui.title('Backup & Restore');
    console.log(' [1] Create Backup');
    console.log(' [2] Restore Database');
    console.log(' [3] List Backups');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '1') await backupDatabaseFlow(ctx);
    else if (c === '2') await restoreDatabaseFlow(ctx);
    else if (c === '3') {
      const list = backup.listBackups(ctx.paths);
      if (!list.length) { ui.warnLine('No backups found.'); continue; }
      ui.printTable(
        ['Name', 'Created', 'Messages', 'Session'],
        list.map((n) => {
          const m = backup.readManifest(ctx.paths, n);
          return [n, m ? m.created_at : '?', m ? m.counts.messages : '?', m && m.includes_session ? 'encrypted' : 'no'];
        }),
        [30, 20, 10, 10]
      );
    } else if (c === '0') return;
  }
}

async function logsMenu(ctx) {
  for (;;) {
    ui.title('Logs');
    console.log(' [1] Today');
    console.log(' [2] Errors & Warnings');
    console.log(' [3] Last 50 lines');
    console.log(' [4] Cleanup old logs');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '0') return;
    let lines = [];
    if (c === '1') lines = ctx.logger.readToday();
    else if (c === '2') lines = ctx.logger.readErrors();
    else if (c === '3') lines = ctx.logger.tail(50);
    else if (c === '4') {
      const n = ctx.logger.cleanup(ctx.config.log_retention_days);
      ui.successLine(`Removed ${n} old log files (retention: ${ctx.config.log_retention_days} days).`);
      continue;
    } else continue;
    if (!lines.length) { ui.infoLine('(no log lines)'); continue; }
    const show = lines.slice(-100);
    console.log(pc.dim('─'.repeat(60)));
    for (const l of show) console.log(' ' + colorLogLine(l));
    console.log(pc.dim('─'.repeat(60)));
    console.log(pc.dim(` ${show.length} of ${lines.length} lines shown - full file: ${ctx.logger.currentFile()}`));
  }
}

function colorLogLine(line) {
  if (/ ERROR /.test(line)) return pc.red(line);
  if (/ WARNING /.test(line)) return pc.yellow(line);
  if (/ SUCCESS /.test(line)) return pc.green(line);
  if (/ DEBUG /.test(line)) return pc.dim(line);
  return pc.cyan(line);
}

/* -------------------------------- settings ------------------------------- */

async function settingsMenu(ctx) {
  for (;;) {
    ui.title('Settings (config/config.json)');
    const c = ctx.config;
    ui.kv('min_delay', `${c.min_delay}s`);
    ui.kv('max_delay', `${c.max_delay}s`);
    ui.kv('messages_per_session', c.messages_per_session || 'unlimited');
    ui.kv('cooldown_hours', `${c.cooldown_hours}h`);
    ui.kv('max_retry', c.max_retry);
    ui.kv('archive_after_send', String(c.archive_after_send));
    ui.kv('verify_recipients', String(c.verify_recipients));
    ui.kv('save_incoming_messages', String(c.save_incoming_messages));
    ui.kv('media_archive', String(c.media_archive));
    ui.kv('default_country_code', `+${c.default_country_code}`);
    ui.kv('name_fallback', c.name_fallback || '(phone number)');
    ui.kv('log_retention_days', `${c.log_retention_days} days`);
    console.log('');
    console.log(' [1] Safe Rate Limits   [2] Toggles   [3] Country/Name   [4] Log retention   [0] Back');
    const choice = await ui.ask('> ');
    if (choice === '1') await editRateLimits(ctx);
    else if (choice === '2') await editToggles(ctx);
    else if (choice === '3') await editLocale(ctx);
    else if (choice === '4') {
      const v = await ui.askInt(`Log retention days [${c.log_retention_days}]: `, { min: 1, def: c.log_retention_days });
      c.log_retention_days = v;
      persist(ctx);
    } else if (choice === '0') return;
  }
}

async function editRateLimits(ctx) {
  const c = ctx.config;
  c.min_delay = await ui.askInt(`Minimum delay seconds [${c.min_delay}]: `, { min: 2, def: c.min_delay });
  c.max_delay = await ui.askInt(`Maximum delay seconds [${c.max_delay}]: `, { min: c.min_delay, def: Math.max(c.max_delay, c.min_delay) });
  c.messages_per_session = await ui.askInt('Messages per session (0 = unlimited): ', { min: 0, def: c.messages_per_session });
  c.cooldown_hours = await ui.askInt('Cooldown hours per recipient: ', { min: 0, def: c.cooldown_hours });
  c.max_retry = await ui.askInt('Maximum retry per message: ', { min: 1, max: 5, def: c.max_retry });
  persist(ctx);
}

async function editToggles(ctx) {
  const c = ctx.config;
  c.archive_after_send = await ui.confirm('Archive conversation after each send?', c.archive_after_send);
  c.verify_recipients = await ui.confirm('Verify recipient is on WhatsApp before sending?', c.verify_recipients);
  c.save_incoming_messages = await ui.confirm('Save incoming messages to history?', c.save_incoming_messages);
  c.media_archive = await ui.confirm('Archive incoming media (Cloud Master)?', c.media_archive);
  persist(ctx);
}

async function editLocale(ctx) {
  const c = ctx.config;
  c.default_country_code = String(await ui.askInt(`Default country code [${c.default_country_code}]: `, { min: 1, max: 999, def: c.default_country_code }));
  const nf = await ui.ask(`Name fallback for {{name}} [${c.name_fallback || '-'}]: `);
  if (nf !== '') c.name_fallback = nf;
  persist(ctx);
}

function persist(ctx) {
  try {
    saveConfig(ctx.root, ctx.config);
    ensureAll(ctx.paths);
    ui.successLine('Settings saved to config/config.json');
    ctx.logger.info('Settings updated');
  } catch (e) {
    ui.errorLine(`Could not save settings: ${e.message}`);
  }
}

module.exports = { storageMenu, logsMenu, settingsMenu, backupRestoreMenu };
