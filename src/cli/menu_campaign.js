'use strict';
const ui = require('./ui');
const pc = require('picocolors');
const manager = require('../campaign/manager');
const queue = require('../queue/queue');
const { CampaignRunner } = require('../campaign/runner');

/* ---------------------------------------------------------------------------
 * Campaign menu (spec sections 8, 10, 11, 19).
 * ------------------------------------------------------------------------- */

async function campaignMenu(ctx) {
  for (;;) {
    ui.title('Campaign Manager');
    console.log(' [1] Create Campaign');
    console.log(' [2] Start Campaign');
    console.log(' [3] Pause Campaign');
    console.log(' [4] Resume Campaign');
    console.log(' [5] Stop Campaign');
    console.log(' [6] Campaign History');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '1') await createCampaignFlow(ctx);
    else if (c === '2') await startCampaignFlow(ctx);
    else if (c === '3') await pauseCampaignFlow(ctx);
    else if (c === '4') await resumeCampaignFlow(ctx);
    else if (c === '5') await stopCampaignFlow(ctx);
    else if (c === '6') await campaignHistoryFlow(ctx);
    else if (c === '0') return;
    else ui.warnLine('Invalid choice.');
  }
}

async function createCampaignFlow(ctx) {
  const name = await ui.askRequired('Campaign Name: ');
  const rawMsg = await ui.askRequired('Message ({{name}}, {{phone}}, \\n supported): ');
  const message = rawMsg.replace(/\\n/g, '\n');
  const file = await ui.askRequired('Recipient File (.txt/.csv/.xlsx): ');

  const { parseRecipientsFile } = require('../campaign/recipients');
  let parsed;
  try {
    parsed = parseRecipientsFile(file.trim(), { defaultCC: ctx.config.default_country_code });
  } catch (e) {
    ui.errorLine(e.message);
    return;
  }
  ui.infoLine(`File loaded: ${parsed.recipients.length} valid recipients, ${parsed.invalid.length} invalid entries.`);
  if (!parsed.recipients.length) { ui.errorLine('No valid recipients in this file.'); return; }
  if (parsed.invalid.length) {
    for (const inv of parsed.invalid.slice(0, 5)) console.log(pc.dim(`   skipped "${inv.raw}" (${inv.reason})`));
  }

  let delay;
  for (;;) {
    const d = await ui.askRequired(`Delay in seconds (min-max) [default ${ctx.config.min_delay}-${ctx.config.max_delay}]: `);
    if (!d) { delay = { min: ctx.config.min_delay, max: ctx.config.max_delay }; break; }
    const m = d.match(/^(\d+)\s*-\s*(\d+)$/) || (d.match(/^\d+$/) ? null : null);
    if (m) { delay = { min: Number(m[1]), max: Number(m[2]) }; }
    else if (/^\d+$/.test(d)) { delay = { min: Number(d), max: Number(d) }; }
    else { ui.warnLine('Format: "6-15" or a single number.'); continue; }
    if (delay.min < 2) { ui.warnLine('Minimum delay is 2 seconds (safe rate limit).'); continue; }
    if (delay.max < delay.min) { ui.warnLine('Maximum must be >= minimum.'); continue; }
    break;
  }
  const maxRecipients = await ui.askInt('Maximum Recipients (0 = unlimited): ', { min: 0, def: 0 });

  try {
    const camp = manager.create(ctx.db, {
      name, message, recipientFile: file.trim(),
      delayMin: delay.min, delayMax: delay.max, maxRecipients,
    });
    ui.successLine(`Campaign created: #${camp.id} "${camp.name}"`);
    ctx.logger.info(`Campaign created: #${camp.id} ${camp.name} (recipients file: ${camp.recipient_file})`);
    const sample = parsed.recipients[0];
    const { renderTemplate } = require('../campaign/template');
    console.log(pc.dim(' Preview for first recipient:'));
    console.log(pc.dim('   ' + renderTemplate(message, { name: sample.name, phone: sample.phone, nameFallback: ctx.config.name_fallback }).split('\n').join('\n   ')));
  } catch (e) {
    ui.errorLine(e.message);
  }
}

async function pickCampaign(ctx, statuses, label) {
  const all = manager.list(ctx.db).filter((c) => !statuses || statuses.includes(c.status));
  if (!all.length) { ui.warnLine(`No campaigns ${label || 'found'}.`); return null; }
  const rows = all.map((c) => {
    const k = queue.counts(ctx.db, c.id);
    return [c.id, c.name, c.status, `${k.sent}/${k.total}`, c.created_at];
  });
  ui.printTable(['ID', 'Name', 'Status', 'Sent/Total', 'Created'], rows, [5, 24, 10, 12, 20]);
  const id = await ui.ask('Campaign id (empty = cancel): ');
  if (!id) return null;
  const camp = manager.get(ctx.db, Number(id));
  if (!camp) { ui.errorLine('Campaign not found.'); return null; }
  return camp;
}

async function startCampaignFlow(ctx) {
  const camp = await pickCampaign(ctx, ['draft', 'paused', 'stopped'], 'ready to start');
  if (!camp) return;
  const k = queue.counts(ctx.db, camp.id);
  console.log('');
  console.log(` Campaign : ${camp.name}`);
  console.log(` Message  : ${String(camp.message).replace(/\s+/g, ' ').slice(0, 60)}...`);
  console.log(` Queue    : ${k.pending} pending / ${k.total} total`);
  console.log(` Delay    : ${camp.delay_min}-${camp.delay_max}s | Per session: ${ctx.config.messages_per_session || '∞'} | Cooldown: ${ctx.config.cooldown_hours}h | Retry: ${ctx.config.max_retry}`);
  if (!(await ui.confirm('Start sending now?', false))) return;
  let started;
  try {
    started = manager.start(ctx.db, camp.id, { cooldownHours: ctx.config.cooldown_hours, defaultCC: ctx.config.default_country_code });
  } catch (e) {
    ui.errorLine(e.message);
    return;
  }
  ctx.logger.info(`Campaign started: ${started.name}`);
  await runRunner(ctx, started.id);
}

/** Runs the campaign with the live progress bar until done/paused/stopped. */
async function runRunner(ctx, id) {
  if (!ctx.wa || ctx.wa.state !== 'CONNECTED') {
    ui.errorLine('WhatsApp is not connected. Use menu [9] WhatsApp Connection first.');
    return;
  }
  const runner = new CampaignRunner({ db: ctx.db, wa: ctx.wa, config: ctx.config, logger: ctx.logger, ui });
  try {
    await runner.run(id);
  } catch (e) {
    ui.errorLine(`Campaign runner error: ${e.message || e}`);
    ctx.logger.error(`Campaign runner error: ${e.message || e}`);
    return;
  }
  const camp = manager.get(ctx.db, id);
  const k = queue.counts(ctx.db, id);
  ui.title('Campaign Progress');
  console.log(` Campaign : ${camp.name}`);
  console.log(` Status   : ${camp.status}${camp.status_note ? pc.yellow(`  (${camp.status_note})`) : ''}`);
  console.log(` Sent     : ${k.sent}`);
  console.log(` Pending  : ${k.pending}`);
  console.log(` Failed   : ${k.failed}`);
  console.log(` Skipped  : ${k.skipped}`);
  console.log(` Total    : ${k.total}`);
  if (camp.status === 'paused') ui.warnLine('Resume from Campaign menu [4] when ready.');
}

async function pauseCampaignFlow(ctx) {
  const camp = await pickCampaign(ctx, ['running'], 'currently running');
  if (!camp) return;
  try {
    const p = manager.pause(ctx.db, camp.id, 'paused by user');
    ctx.logger.info(`Campaign paused: ${p.name}`);
    ui.successLine(`Campaign paused: ${p.name}`);
  } catch (e) { ui.errorLine(e.message); }
}

async function resumeCampaignFlow(ctx) {
  const camp = await pickCampaign(ctx, ['paused'], 'paused');
  if (!camp) return;
  if (camp.status_note) console.log(pc.dim(` Last note: ${camp.status_note}`));
  if (!(await ui.confirm(`Resume "${camp.name}"?`, false))) return;
  try {
    manager.resume(ctx.db, camp.id);
    ctx.logger.info(`Campaign resumed: ${camp.name}`);
    await runRunner(ctx, camp.id);
  } catch (e) { ui.errorLine(e.message); }
}

async function stopCampaignFlow(ctx) {
  const camp = await pickCampaign(ctx, ['running', 'paused'], 'running or paused');
  if (!camp) return;
  if (!(await ui.confirm(`Stop "${camp.name}"? Pending recipients are kept and can be restarted later.`, false))) return;
  try {
    const s = manager.stop(ctx.db, camp.id);
    ctx.logger.info(`Campaign stopped: ${s.name}`);
    ui.successLine(`Campaign stopped: ${s.name}`);
  } catch (e) { ui.errorLine(e.message); }
}

async function campaignHistoryFlow(ctx) {
  const camp = await pickCampaign(ctx, null, 'found');
  if (!camp) return;
  const k = queue.counts(ctx.db, camp.id);
  ui.title(`Campaign #${camp.id}: ${camp.name}`);
  ui.kv('Status', camp.status + (camp.status_note ? ` (${camp.status_note})` : ''));
  ui.kv('Created', camp.created_at);
  ui.kv('Started', camp.started_at || '-');
  ui.kv('Finished', camp.finished_at || '-');
  ui.kv('Recipient file', camp.recipient_file);
  ui.kv('Delay', `${camp.delay_min}-${camp.delay_max}s`);
  ui.kv('Max recipients', camp.max_recipients || 'unlimited');
  ui.kv('Sent/Pending', `${k.sent} / ${k.pending} (failed ${k.failed}, skipped ${k.skipped}, total ${k.total})`);
  console.log('');
  console.log(pc.bold(' Message:'));
  console.log(pc.dim(camp.message.split('\n').map((l) => '   ' + l).join('\n')));
  console.log('');
  const list = queue.listByCampaign(ctx.db, camp.id, { limit: 30 });
  ui.printTable(
    ['Phone', 'Name', 'Status', 'Attempts', 'Info', 'Sent At'],
    list.map((r) => ['+' + r.phone, r.name || '-', r.status, r.attempts, (r.error || r.message_id || '').slice(0, 24), r.sent_at || '-']),
    [16, 14, 9, 9, 26, 20]
  );
}

module.exports = { campaignMenu, runRunner, createCampaignFlow };
