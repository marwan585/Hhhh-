'use strict';
const pc = require('picocolors');
const ui = require('./ui');
const manager = require('../campaign/manager');
const queue = require('../queue/queue');
const contacts = require('../contacts/contacts');
const { normalizePhone } = require('../utils/phone');

/* ---------------------------------------------------------------------------
 * Cloud Save / Cloud Master / Contacts / History menus (spec sections 5, 6, 12).
 * ------------------------------------------------------------------------- */

async function cloudSaveMenu(ctx) {
  for (;;) {
    ui.title('CLOUD SAVE - Contacts & Campaign History');
    console.log(' [1] Quick Send Message');
    console.log(' [2] Saved Messages (recent outbox)');
    console.log(' [3] Contacts');
    console.log(' [4] Campaign');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '1') await quickSendFlow(ctx);
    else if (c === '2') await showRecentOutbox(ctx);
    else if (c === '3') await contactsMenu(ctx);
    else if (c === '4') { const { campaignMenu } = require('./menu_campaign'); await campaignMenu(ctx); }
    else if (c === '0') return;
    else ui.warnLine('Invalid choice.');
  }
}

async function cloudMasterMenu(ctx) {
  for (;;) {
    ui.title('CLOUD MASTER - Advanced Mode');
    console.log(' [1] Quick Send Message');
    console.log(' [2] Message Archive');
    console.log(' [3] Media Archive');
    console.log(' [4] Campaign History');
    console.log(' [5] Recipient History');
    console.log(' [6] Storage Management');
    console.log(' [7] Backup & Restore');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '1') await quickSendFlow(ctx);
    else if (c === '2') await historyMenu(ctx);
    else if (c === '3') await mediaArchiveMenu(ctx);
    else if (c === '4') { const { campaignMenu } = require('./menu_campaign'); await campaignMenu(ctx); }
    else if (c === '5') await recipientHistoryMenu(ctx);
    else if (c === '6') { const { storageMenu } = require('./menu_system'); await storageMenu(ctx); }
    else if (c === '7') { const { backupRestoreMenu } = require('./menu_system'); await backupRestoreMenu(ctx); }
    else if (c === '0') return;
    else ui.warnLine('Invalid choice.');
  }
}

/* ------------------------------- quick send ------------------------------ */

async function quickSendFlow(ctx) {
  const { db, wa, config, logger } = ctx;
  if (wa.state !== 'CONNECTED') { ui.errorLine('WhatsApp is not connected. Use menu [9] first.'); return; }
  const raw = await ui.askRequired('Recipient number: ');
  const norm = normalizePhone(raw, config.default_country_code);
  if (!norm.valid) { ui.errorLine(`Invalid number: ${norm.reason}`); return; }

  let exists = null;
  try { exists = await wa.verifyNumber(norm.phone); } catch (_) { exists = null; }
  if (exists === false) { ui.errorLine('Number is not registered on WhatsApp.'); return; }

  const el = contacts.eligibility(db, norm.phone);
  if (!el.eligible) {
    ui.warnLine(`Consent status: ${el.reason}`);
    const ok = await ui.confirm('This recipient has not opted in. Send this single manual message anyway?', false);
    if (!ok) return;
  }

  const name = await ui.ask('Recipient name (optional, used by {{name}}): ');
  const rawMsg = await ui.askRequired('Message ({{name}}, {{phone}}, \\n supported): ');
  const text = renderUserMessage(rawMsg, { name: name || '', phone: norm.phone, fallback: config.name_fallback });

  ui.hr();
  console.log(pc.dim(previewText(text)));
  ui.hr();
  if (!(await ui.confirm(`Send to ${norm.display}?`, false))) return;

  try {
    const res = await wa.sendText(norm.phone, text);
    db.run(
      "INSERT INTO messages (direction, phone, name, campaign_id, message_id, body, status, created_at) VALUES ('out', ?, ?, NULL, ?, ?, 'SENT', ?)",
      [norm.phone, name || '', res.messageId, text, require('../utils/datetime').now()]
    );
    contacts.upsert(db, norm.phone, name || '');
    db.flushNow();
    ui.successLine('Message sent successfully');
    console.log(`Recipient: ${norm.display}`);
    ui.successLine('Contact saved');
    if (config.archive_after_send) {
      try { await wa.archiveChat(norm.phone); ui.successLine('Conversation archived'); }
      catch (e) { ui.warnLine(`Conversation archive skipped: ${e.message}`); }
    }
    logger.success(`Message sent successfully - Recipient: ${norm.display} (Message ID: ${res.messageId})`);
  } catch (e) {
    ui.errorLine(`Send failed: ${e.message || e}`);
    logger.error(`Quick send failed for ${norm.display}: ${e.message || e}`);
  }
}

function renderUserMessage(msg, { name, phone, fallback }) {
  const { renderTemplate } = require('../campaign/template');
  return renderTemplate(msg.replace(/\\n/g, '\n'), { name, phone, nameFallback: fallback });
}

function previewText(s) {
  return String(s).split('\n').slice(0, 12).map((l) => '  | ' + l).join('\n');
}

/* ----------------------------- recent outbox ----------------------------- */

async function showRecentOutbox(ctx) {
  const rows = ctx.db.all(
    `SELECT m.id, m.phone, m.name, c.name AS campaign, m.message_id, m.status, m.created_at
     FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.direction = 'out' ORDER BY m.id DESC LIMIT 20`
  );
  ui.title('Saved Messages (last 20)');
  ui.printTable(
    ['ID', 'Phone', 'Name', 'Campaign', 'Status', 'Sent At'],
    rows.map((r) => [r.id, r.phone ? '+' + r.phone : '', r.name || '-', r.campaign || '-', r.status, r.created_at]),
    [6, 16, 14, 16, 10, 20]
  );
  const id = await ui.ask('Enter message id for details (empty = back): ');
  if (id) await showMessageDetail(ctx, id);
}

async function showMessageDetail(ctx, id) {
  const m = ctx.db.get(
    `SELECT m.*, c.name AS campaign FROM messages m
     LEFT JOIN campaigns c ON c.id = m.campaign_id WHERE m.id = ?`, [Number(id)]
  );
  if (!m) { ui.errorLine('Message not found.'); return; }
  ui.hr();
  ui.kv('Message ID', m.message_id || '(local #' + m.id + ')');
  ui.kv('Recipient', m.phone ? '+' + m.phone : '-');
  ui.kv('Name', m.name || '-');
  ui.kv('Campaign', m.campaign || '-');
  ui.kv('Time', m.created_at);
  ui.kv('Status', m.status + (m.media_file ? ` (media: ${m.media_file})` : ''));
  if (m.error) ui.kv('Error', m.error);
  ui.hr();
  console.log(pc.dim(previewText(m.body)));
  ui.hr();
}

/* ------------------------------- history --------------------------------- */

async function historyMenu(ctx) {
  for (;;) {
    ui.title('Message History');
    console.log(' [1] All messages   [2] Sent   [3] Received');
    console.log(' [4] By campaign    [5] By phone');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '0') return;
    let where = '';
    const params = [];
    if (c === '2') where = "direction = 'out'";
    else if (c === '3') where = "direction = 'in'";
    else if (c === '4') {
      const cid = await ui.ask('Campaign id: ');
      if (!/^\d+$/.test(cid)) { ui.warnLine('Invalid id.'); continue; }
      where = 'campaign_id = ?'; params.push(Number(cid));
    } else if (c === '5') {
      const raw = await ui.ask('Phone number: ');
      const norm = normalizePhone(raw, ctx.config.default_country_code);
      if (!norm.valid) { ui.warnLine(`Invalid number: ${norm.reason}`); continue; }
      where = 'phone = ?'; params.push(norm.phone);
    } else if (c !== '1') { ui.warnLine('Invalid choice.'); continue; }

    let sql = `SELECT m.id, m.direction, m.phone, c.name AS campaign, m.status, m.created_at
               FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id`;
    if (where) sql += ' WHERE ' + where;
    sql += ' ORDER BY m.id DESC LIMIT 30';
    const rows = ctx.db.all(sql, params);
    ui.printTable(
      ['ID', 'Dir', 'Phone', 'Campaign', 'Status', 'Time'],
      rows.map((r) => [r.id, r.direction === 'out' ? 'out' : 'in', r.phone ? '+' + r.phone : '', r.campaign || '-', r.status, r.created_at]),
      [6, 4, 16, 18, 10, 20]
    );
    const id = await ui.ask('Enter message id for details (empty = back): ');
    if (id) await showMessageDetail(ctx, id);
  }
}

/* --------------------------- media archive (CM) -------------------------- */

async function mediaArchiveMenu(ctx) {
  const rows = ctx.db.all('SELECT * FROM media ORDER BY id DESC LIMIT 50');
  const fs = require('fs');
  const path = require('path');
  const storage = require('../storage/storage');
  ui.title('Media Archive (local)');
  ui.printTable(
    ['File', 'Phone', 'Type', 'Size', 'Date'],
    rows.map((r) => [r.file, r.phone ? '+' + r.phone : '', r.mimetype || '-', storage.fmtBytes(r.size), r.created_at]),
    [34, 16, 18, 9, 20]
  );
  const s = storage.summary(ctx.db, ctx.paths);
  console.log(` Total media: ${storage.fmtBytes(s.mediaSize)} (${storage.formatInt(s.mediaFiles)} files) in ${ctx.paths.media}`);
  const f = await ui.ask('File name to verify on disk (empty = back): ');
  if (f) {
    const p = path.join(ctx.paths.media, f.trim());
    console.log(fs.existsSync(p) ? ui.green(`✓ Exists: ${p} (${storage.fmtBytes(fs.statSync(p).size)})`) : ui.red(`✗ Not found: ${p}`));
  }
}

/* -------------------------- recipient history (CM) ----------------------- */

async function recipientHistoryMenu(ctx) {
  const raw = await ui.askRequired('Recipient number: ');
  const norm = normalizePhone(raw, ctx.config.default_country_code);
  if (!norm.valid) { ui.errorLine(`Invalid number: ${norm.reason}`); return; }
  const db = ctx.db;
  const contact = db.get('SELECT * FROM contacts WHERE phone = ?', [norm.phone]);
  const el = contacts.eligibility(db, norm.phone);
  ui.title(`Recipient History: ${norm.display}`);
  ui.kv('In contacts', contact ? 'yes' : 'no');
  ui.kv('Name', contact ? (contact.name || '-') : '-');
  ui.kv('Consent', el.reason);
  if (contact) {
    ui.kv('Opt-in at', contact.opt_in_at || '-');
    ui.kv('Opt-out at', contact.opt_out_at || '-');
  }
  const bl = db.get('SELECT * FROM blacklist WHERE phone = ?', [norm.phone]);
  if (bl) ui.kv('Do Not Contact', `${bl.reason} (since ${bl.created_at})`);
  const sent = db.all(
    `SELECT m.status, m.created_at, c.name AS campaign, m.body FROM messages m
     LEFT JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.phone = ? AND m.direction = 'out' ORDER BY m.id DESC LIMIT 10`, [norm.phone]
  );
  console.log(pc.bold('\n Last messages to this recipient:'));
  ui.printTable(
    ['Status', 'Campaign', 'Time', 'Message'],
    sent.map((r) => [r.status, r.campaign || '-', r.created_at, String(r.body || '').replace(/\s+/g, ' ').slice(0, 38)]),
    [10, 18, 20, 40]
  );
}

/* -------------------------------- contacts ------------------------------- */

async function contactsMenu(ctx) {
  for (;;) {
    ui.title('Contacts & Consent');
    console.log(' [1] Add Contact');
    console.log(' [2] Import Contacts (txt/csv/xlsx)');
    console.log(' [3] View Contacts');
    console.log(' [4] Delete Contact');
    console.log(' [5] Opt-in');
    console.log(' [6] Opt-out');
    console.log(' [7] Do Not Contact list');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '1') await addContactFlow(ctx);
    else if (c === '2') await importContactsFlow(ctx);
    else if (c === '3') await viewContactsFlow(ctx);
    else if (c === '4') await deleteContactFlow(ctx);
    else if (c === '5') await optFlow(ctx, true);
    else if (c === '6') await optFlow(ctx, false);
    else if (c === '7') await dncMenu(ctx);
    else if (c === '0') return;
    else ui.warnLine('Invalid choice.');
  }
}

async function addContactFlow(ctx) {
  const raw = await ui.askRequired('Phone number: ');
  const name = await ui.ask('Name (optional): ');
  const optIn = await ui.confirm('Mark as OPTED-IN to receive campaigns?', false);
  try {
    const r = contacts.add(ctx.db, raw, name, { optIn, defaultCC: ctx.config.default_country_code });
    ctx.db.flushNow();
    ui.successLine(`${r.created ? 'Contact added' : 'Contact updated'}: +${r.contact.phone}${name ? ` (${name})` : ''}`);
    if (optIn) ui.successLine('Contact opted in');
    ctx.logger.info(`Contact ${r.created ? 'added' : 'updated'}: +${r.contact.phone} optIn=${optIn}`);
  } catch (e) {
    ui.errorLine(e.message);
  }
}

async function importContactsFlow(ctx) {
  const file = await ui.askRequired('Path to file (.txt/.csv/.xlsx): ');
  const optIn = await ui.confirm('Mark imported contacts as OPTED-IN? (only if they really consented!)', false);
  try {
    const { parseRecipientsFile } = require('../campaign/recipients');
    const parsed = parseRecipientsFile(file.trim(), { defaultCC: ctx.config.default_country_code });
    let added = 0;
    let updated = 0;
    for (const r of parsed.recipients) {
      const res = contacts.add(ctx.db, r.phone, r.name, { optIn, defaultCC: ctx.config.default_country_code });
      if (res.created) added++; else updated++;
    }
    ctx.db.flushNow();
    ui.successLine(`Imported ${added} new contacts, updated ${updated}.`);
    if (parsed.invalid.length) {
      ui.warnLine(`${parsed.invalid.length} invalid entries skipped:`);
      for (const inv of parsed.invalid.slice(0, 10)) console.log(`   - "${inv.raw}" (${inv.reason})`);
    }
    if (!optIn) ui.infoLine('Note: imported contacts are NOT opted-in. Use Opt-in (menu 5) for consenting numbers.');
    ctx.logger.info(`Contacts imported from ${file}: +${added}, ~${updated}, invalid ${parsed.invalid.length}, optIn=${optIn}`);
  } catch (e) {
    ui.errorLine(e.message);
  }
}

async function viewContactsFlow(ctx) {
  console.log(' Filter: [1] All  [2] Opted-in  [3] Opted-out  [4] Not opted-in  [5] Search');
  const f = await ui.ask('> ');
  const filter = { 1: 'all', 2: 'opted_in', 3: 'opted_out', 4: 'not_opted_in' }[f] || 'all';
  let search = '';
  if (f === '5') search = await ui.ask('Search (phone/name): ');
  const page = Number(await ui.askInt('Page (1): ', { min: 1, def: 1 }));
  const rows = contacts.list(ctx.db, { filter, search, limit: 20, offset: (page - 1) * 20 });
  ui.title(`Contacts (page ${page})`);
  ui.printTable(
    ['ID', 'Phone', 'Name', 'Opt-in', 'Opt-out', 'Created'],
    rows.map((r) => [
      r.id, '+' + r.phone, r.name || '-',
      r.opt_in ? `${ui.green('yes')}` : 'no',
      r.opt_out ? `${ui.red('yes')}` : 'no',
      r.created_at,
    ]),
    [6, 16, 18, 8, 8, 20]
  );
}

async function deleteContactFlow(ctx) {
  const raw = await ui.askRequired('Phone number to delete: ');
  const norm = normalizePhone(raw, ctx.config.default_country_code);
  if (!norm.valid) { ui.errorLine(`Invalid number: ${norm.reason}`); return; }
  const c = contacts.get(ctx.db, norm.phone);
  if (!c) { ui.errorLine('Contact not found.'); return; }
  if (!(await ui.confirm(`Delete contact ${norm.display} (${c.name || 'no name'})? Message history is kept.`, false))) return;
  contacts.remove(ctx.db, norm.phone);
  ctx.db.flushNow();
  ui.successLine(`Contact deleted: ${norm.display}`);
  ctx.logger.info(`Contact deleted: ${norm.display}`);
}

async function optFlow(ctx, isIn) {
  const raw = await ui.askRequired(isIn ? 'Phone number to OPT-IN: ' : 'Phone number to OPT-OUT: ');
  const norm = normalizePhone(raw, ctx.config.default_country_code);
  if (!norm.valid) { ui.errorLine(`Invalid number: ${norm.reason}`); return; }
  if (!contacts.get(ctx.db, norm.phone)) {
    const create = await ui.confirm('Contact does not exist. Create it first?', true);
    if (!create) return;
    const name = await ui.ask('Name (optional): ');
    contacts.upsert(ctx.db, norm.phone, name, { defaultCC: ctx.config.default_country_code });
  }
  if (isIn) {
    contacts.optInContact(ctx.db, norm.phone);
    ui.successLine(`Opted in: ${norm.display}`);
  } else {
    const reason = await ui.ask('Reason (optional): ');
    contacts.optOutContact(ctx.db, norm.phone, reason || 'manual opt-out');
    ui.successLine('Recipient added to Do Not Contact');
  }
  ctx.db.flushNow();
  ctx.logger.info(`Consent change: ${norm.display} ${isIn ? 'OPT-IN' : 'OPT-OUT'}`);
}

async function dncMenu(ctx) {
  for (;;) {
    const rows = contacts.blacklistList(ctx.db);
    ui.title('Do Not Contact list');
    ui.printTable(
      ['Phone', 'Reason', 'Added'],
      rows.map((r) => ['+' + r.phone, r.reason || '-', r.created_at]),
      [16, 30, 20]
    );
    console.log(' [1] Add number    [2] Remove number    [0] Back');
    const c = await ui.ask('> ');
    if (c === '1') {
      const raw = await ui.askRequired('Phone number: ');
      const norm = normalizePhone(raw, ctx.config.default_country_code);
      if (!norm.valid) { ui.errorLine(`Invalid number: ${norm.reason}`); continue; }
      const reason = await ui.ask('Reason: ');
      contacts.blacklistAdd(ctx.db, norm.phone, reason || 'manual');
      contacts.optOutContact(ctx.db, norm.phone, reason || 'manual');
      ctx.db.flushNow();
      ui.successLine('Recipient added to Do Not Contact');
    } else if (c === '2') {
      const raw = await ui.askRequired('Phone number to remove: ');
      const norm = normalizePhone(raw, ctx.config.default_country_code);
      if (!norm.valid) { ui.errorLine(`Invalid number: ${norm.reason}`); continue; }
      contacts.blacklistRemove(ctx.db, norm.phone);
      ctx.db.flushNow();
      ui.successLine(`Removed from Do Not Contact: ${norm.display}`);
    } else if (c === '0') return;
  }
}

module.exports = {
  cloudSaveMenu, cloudMasterMenu, quickSendFlow,
  showRecentOutbox, historyMenu, mediaArchiveMenu, recipientHistoryMenu,
  contactsMenu,
};
