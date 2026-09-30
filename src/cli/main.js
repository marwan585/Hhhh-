'use strict';
const fs = require('fs');
const path = require('path');
const pc = require('picocolors');
const ui = require('./ui');
const { Database } = require('../database/db');
const { initSchema } = require('../database/schema');
const { loadConfig, ensureConfigFile } = require('../utils/config');
const pathsModule = require('../utils/paths');
const { Logger } = require('../logger/logger');
const { checkEnvironment, printChecks } = require('../utils/deps');
const { WhatsAppConnection, STATE } = require('../whatsapp/connection');
const { attachIncoming } = require('../whatsapp/incoming');
const queue = require('../queue/queue');
const manager = require('../campaign/manager');
const { APP_VERSION, mainMenu, connectFlow } = require('./menu');
const { runRunner } = require('./menu_campaign');

/* ---------------------------------------------------------------------------
 * Interactive bootstrap (spec sections 2, 3, 19, 21, 22).
 * ------------------------------------------------------------------------- */

let globalCtx = null;
let lastSig = 0;

function handleSigint() {
  const { getActiveRunner } = require('../campaign/runner');
  const runner = getActiveRunner();
  if (runner && Date.now() - lastSig > 2000) {
    lastSig = Date.now();
    console.log('');
    ui.warnLine('Campaign paused - progress saved. Press Ctrl+C again to exit.');
    try {
      manager.pause(runner.db, runner.campaignId, 'paused by user (Ctrl+C)');
    } catch (_) { /* already paused */ }
    return;
  }
  console.log('');
  console.log(ui.cyan('Session saved. Goodbye!'));
  try { if (globalCtx) globalCtx.db.flushNow(); } catch (_) { /* ignore */ }
  process.exit(0);
}

async function boot() {
  const root = pathsModule.ROOT;
  ensureConfigFile(root);
  const config = loadConfig(root);
  const paths = pathsModule.buildPaths(config);
  pathsModule.ensureAll(paths);
  const logger = new Logger({ logPath: paths.logs });
  const db = await Database.open(paths.database);
  initSchema(db);
  const wa = new WhatsAppConnection({ paths, config, logger, db });
  wa.onSocket = (sock) => attachIncoming({ sock, db, config, paths, logger, ui });
  const ctx = { root, config, paths, logger, db, wa };
  globalCtx = ctx;
  return ctx;
}

/** Crash recovery (spec 19): campaigns stuck as RUNNING. */
async function crashRecoveryPrompt(ctx) {
  const stuck = ctx.db.all("SELECT * FROM campaigns WHERE status = 'running'");
  if (!stuck.length) return;
  const recovered = queue.requeueStuck(ctx.db);
  if (recovered) ctx.logger.info(`Crash recovery: ${recovered} in-flight messages requeued`);
  for (const camp of stuck) {
    console.log('');
    console.log(pc.yellow('Previous campaign detected.'));
    console.log(`Campaign: ${camp.name}`);
    console.log(`Last status: RUNNING`);
    console.log(' [1] Resume');
    console.log(' [2] Stop');
    console.log(' [3] View Progress');
    const c = await ui.ask('> ');
    if (c === '1') {
      try {
        manager.resume(ctx.db, camp.id);
        await runRunner(ctx, camp.id);
      } catch (e) {
        ui.errorLine(`Cannot resume now: ${e.message}`);
        ui.infoLine('You can resume later from Campaign menu [3] > Resume.');
      }
    } else if (c === '2') {
      try {
        manager.stop(ctx.db, camp.id);
        ui.successLine(`Campaign stopped: ${camp.name}`);
      } catch (e) { ui.errorLine(e.message); }
    } else {
      const k = queue.counts(ctx.db, camp.id);
      console.log(` Sent : ${k.sent}   Pending : ${k.pending}   Failed : ${k.failed}   Skipped : ${k.skipped}   Total : ${k.total}`);
    }
  }
}

async function interactive() {
  ui.banner(APP_VERSION);
  const ctx = await boot();
  ui.setSigintHandler(handleSigint);
  process.on('SIGINT', handleSigint);

  const ok = printChecks(await checkEnvironment({ paths: ctx.paths }));
  if (!ok) process.exit(1);

  ctx.logger.info('Application started');

  // Crash recovery first (queue must never lose data).
  await crashRecoveryPrompt(ctx);

  // Restore an existing session automatically (spec section 3).
  if (ctx.wa.hasSession()) {
    ui.successLine('Existing WhatsApp session found');
    console.log('Restoring session...');
    try {
      const res = await ctx.wa.connect({});
      console.log('');
      ui.successLine('WhatsApp Connected');
      console.log(`Number : ${res.number ? '+' + res.number : 'unknown'}`);
      console.log('Status : CONNECTED');
    } catch (e) {
      const msg = e.message || String(e);
      if (msg === 'SESSION_EXPIRED') {
        ui.errorLine('Stored session is no longer valid (logged out from phone).');
        ui.infoLine('Use menu [9] > Delete Session, then Connect to pair again.');
      } else if (msg !== 'NO_SESSION') {
        ui.warnLine(`Could not connect right now (${msg}). You can retry from menu [9].`);
      }
    }
  } else {
    // First-run screen (spec section 2).
    ui.statusBox({ state: STATE.DISCONNECTED });
    console.log(' [1] Connect WhatsApp');
    console.log(' [2] Exit');
    const c = await ui.ask('> ');
    if (c === '1') {
      await connectFlow(ctx);
    } else {
      console.log('Goodbye!');
      process.exit(0);
    }
  }

  await mainMenu(ctx);
}

async function main() {
  // Global safety nets: never die silently, never lose the queue.
  process.on('uncaughtException', (err) => {
    try { console.error(pc.red(`✗ Unexpected error: ${err.message || err}`)); } catch (_) { /* ignore */ }
    try { if (globalCtx) { globalCtx.logger.error(`Uncaught exception: ${err.stack || err}`); globalCtx.db.flushNow(); } } catch (_) { /* ignore */ }
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    try { if (globalCtx) { globalCtx.logger.error(`Unhandled rejection: ${err && err.stack ? err.stack : err}`); globalCtx.db.flushNow(); } } catch (_) { /* ignore */ }
  });

  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    const { runCommand } = require('./commands');
    process.exitCode = await runCommand(argv);
    return;
  }
  await interactive();
}

module.exports = { main, boot, interactive };
