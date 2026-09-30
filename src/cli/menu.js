'use strict';
const pc = require('picocolors');
const ui = require('./ui');
const manager = require('../campaign/manager');
const queue = require('../queue/queue');
const { normalizePhone } = require('../utils/phone');
const { STATE } = require('../whatsapp/connection');

/* ---------------------------------------------------------------------------
 * Main menu + WhatsApp connection flows (spec sections 2, 3, 4, 19).
 * ------------------------------------------------------------------------- */

const APP_VERSION = '1.0.0';

function whatsappDot(state) {
  if (state === STATE.CONNECTED) return ui.green('●');
  if (state === STATE.CONNECTING || state === STATE.PAIRING) return ui.yellow('●');
  return ui.red('●');
}

function campaignBadge(ctx) {
  const running = manager.list(ctx.db).find((c) => c.status === 'running');
  const paused = manager.list(ctx.db).find((c) => c.status === 'paused');
  if (running) return { campaign: running.name, status: 'RUNNING' };
  if (paused) return { campaign: paused.name, status: 'PAUSED' };
  return { campaign: null, status: null };
}

async function mainMenu(ctx) {
  for (;;) {
    console.log('');
    const badge = campaignBadge(ctx);
    ui.statusBox({
      state: ctx.wa ? ctx.wa.state : STATE.DISCONNECTED,
      number: ctx.wa && ctx.wa.number ? '+' + ctx.wa.number : null,
      campaign: badge.campaign,
      campaignStatus: badge.status,
    });
    console.log(' [1] Cloud Save          [6] Storage');
    console.log(' [2] Cloud Master        [7] Logs');
    console.log(' [3] Campaign            [8] Settings');
    console.log(' [4] Contacts            [9] WhatsApp Connection');
    console.log(' [5] Message History     [0] Exit');
    const c = await ui.ask('> ');

    if (c === '1') { const m = require('./menu_features'); await m.cloudSaveMenu(ctx); }
    else if (c === '2') { const m = require('./menu_features'); await m.cloudMasterMenu(ctx); }
    else if (c === '3') { const m = require('./menu_campaign'); await m.campaignMenu(ctx); }
    else if (c === '4') { const m = require('./menu_features'); await m.contactsMenu(ctx); }
    else if (c === '5') { const m = require('./menu_features'); await m.historyMenu(ctx); }
    else if (c === '6') { const m = require('./menu_system'); await m.storageMenu(ctx); }
    else if (c === '7') { const m = require('./menu_system'); await m.logsMenu(ctx); }
    else if (c === '8') { const m = require('./menu_system'); await m.settingsMenu(ctx); }
    else if (c === '9') await connectionMenu(ctx);
    else if (c === '0') {
      if (await ui.confirm('Exit CLOUD WA TOOLS? (session stays saved)', false)) {
        await exitApp(ctx);
        return;
      }
    } else {
      ui.warnLine('Invalid choice.');
    }
  }
}

async function exitApp(ctx) {
  try {
    if (ctx.wa) ctx.wa.end();
    ctx.db.flushNow();
    ctx.logger.info('Application closed (session saved)');
  } catch (_) { /* ignore */ }
  console.log(ui.cyan('Session saved. Goodbye!'));
  process.exit(0);
}

/* --------------------------- connection flows ---------------------------- */

async function connectFlow(ctx) {
  const { wa, config, logger } = ctx;
  if (wa.state === STATE.CONNECTED) {
    ui.successLine(`WhatsApp already connected: +${wa.number || 'unknown'}`);
    return true;
  }
  let phone = null;
  if (!wa.hasSession()) {
    const raw = await ui.askRequired('Enter WhatsApp number: ');
    const norm = normalizePhone(raw, config.default_country_code);
    if (!norm.valid) { ui.errorLine(`Invalid number: ${norm.reason}`); return false; }
    phone = norm.phone;
    console.log('Generating pairing code...');
  } else {
    ui.successLine('Existing WhatsApp session found');
    console.log('Restoring session...');
  }

  try {
    const res = await wa.connect({
      phone,
      onPairingCode: (code) => {
        console.log('');
        console.log(`Pairing Code: ${ui.bold(code)}`);
        console.log('Open WhatsApp: Settings → Linked Devices → Link a Device → Link with phone number');
        console.log('Waiting for connection...');
      },
      onStatus: (s, retry) => {
        if (retry) console.log(pc.yellow(`Reconnecting... (attempt ${retry})`));
      },
    });
    console.log('');
    ui.successLine('WhatsApp Connected');
    console.log(`Number : ${res.number ? '+' + res.number : 'unknown'}`);
    console.log('Status : CONNECTED');
    logger.success('WhatsApp ready');
    return true;
  } catch (e) {
    const msg = e.message || String(e);
    if (msg === 'SESSION_EXPIRED') {
      ui.errorLine('Session expired or was logged out from the phone.');
      const del = await ui.confirm('Delete stored session and prepare for fresh pairing?', false);
      if (del) {
        wa.deleteSessionFiles();
        ui.successLine('Session deleted. Use Connect to pair again.');
      }
    } else if (msg === 'CONNECTION_REPLACED') {
      ui.errorLine('Connection replaced by another WhatsApp Web/Desktop session.');
    } else if (msg === 'NO_SESSION') {
      ui.errorLine('No usable session found. Connect with your WhatsApp number.');
    } else if (msg === 'CONNECTION_FAILED') {
      ui.errorLine('Could not connect after several attempts. Check your internet connection.');
    } else {
      ui.errorLine(`Connection failed: ${msg}`);
      logger.error(`Connection failed: ${msg}`);
    }
    return false;
  }
}

async function disconnectFlow(ctx) {
  const { wa, logger } = ctx;
  if (wa.state === STATE.CONNECTED) {
    wa.end();
    logger.info('WhatsApp disconnected by user');
    ui.successLine('WhatsApp disconnected. The saved session is kept for the next run.');
  } else {
    ui.infoLine('WhatsApp is not connected in this session.');
  }
}

async function deleteSessionFlow(ctx) {
  const { wa, logger } = ctx;
  if (!wa.hasSession()) { ui.infoLine('No stored session found.'); return; }
  ui.warnLine('This removes the linked-device credentials from this machine.');
  if (!(await ui.confirm('Delete WhatsApp session? You will need to pair again.', false))) return;
  wa.deleteSessionFiles();
  logger.warn('WhatsApp session deleted by user');
  ui.successLine('Session deleted.');
}

async function connectionMenu(ctx) {
  for (;;) {
    ui.title('WhatsApp Connection');
    ui.kv('State', `${whatsappDot(ctx.wa.state)} ${ctx.wa.state}`);
    ui.kv('Number', ctx.wa.number ? '+' + ctx.wa.number : (ctx.wa.hasSession() ? `(stored: ${ctx.wa.sessionNumber() ? '+' + ctx.wa.sessionNumber() : 'unknown'})` : '-'));
    ui.kv('Session files', ctx.wa.hasSession() ? 'found' : 'none');
    console.log('');
    console.log(' [1] Connect WhatsApp (pairing code)');
    console.log(' [2] Reconnect');
    console.log(' [3] Disconnect');
    console.log(' [4] Delete Session');
    console.log(' [0] Back');
    const c = await ui.ask('> ');
    if (c === '1') await connectFlow(ctx);
    else if (c === '2') { ctx.wa.end(); await connectFlow(ctx); }
    else if (c === '3') await disconnectFlow(ctx);
    else if (c === '4') await deleteSessionFlow(ctx);
    else if (c === '0') return;
    else ui.warnLine('Invalid choice.');
  }
}

module.exports = { mainMenu, connectFlow, disconnectFlow, deleteSessionFlow, connectionMenu, exitApp, APP_VERSION };
