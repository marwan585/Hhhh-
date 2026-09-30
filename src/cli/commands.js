'use strict';
const fs = require('fs');
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
const { normalizePhone } = require('../utils/phone');
const queue = require('../queue/queue');
const manager = require('../campaign/manager');
const contacts = require('../contacts/contacts');
const storage = require('../storage/storage');
const backup = require('../storage/backup');
const { CampaignRunner } = require('../campaign/runner');
const { parseRecipientsFile } = require('../campaign/recipients');

/* ---------------------------------------------------------------------------
 * Command mode (spec sections 16, 18, 20):
 *   cloud-wa status | connect | disconnect | campaign ... | contacts ... |
 *   history | storage | logs | backup | restore | init | check
 * ------------------------------------------------------------------------- */

const VERSION = '1.0.0';

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  return flags;
}

const USAGE = `CLOUD WA TOOLS v${VERSION}

Usage:
  cloud-wa                              Interactive menu
  cloud-wa init                         Create dirs, config and database
  cloud-wa check                        Environment / dependency check
  cloud-wa status                       Session, campaigns and queue status
  cloud-wa connect [--number +62xxx]    Connect (pairing code) and stay attached
  cloud-wa disconnect                   Detach (saved session is kept)
  cloud-wa session delete               Delete the stored WhatsApp session
  cloud-wa campaign list
  cloud-wa campaign create --name "Promo" --message "Halo {{name}}" --file recipients.csv [--delay 6-15] [--max 100]
  cloud-wa campaign start <id>          Sends until done/paused (Ctrl+C pauses)
  cloud-wa campaign pause <id>
  cloud-wa campaign resume <id>
  cloud-wa campaign stop <id>
  cloud-wa contacts list [--filter opted_in|opted_out|not_opted_in] [--search teks]
  cloud-wa contacts import contacts.csv [--opt-in]
  cloud-wa contacts add <phone> [name]
  cloud-wa contacts optin <phone>
  cloud-wa contacts optout <phone>
  cloud-wa history [--limit 20] [--campaign <id>] [--phone <num>]
  cloud-wa storage
  cloud-wa logs [--today] [--errors] [--tail 50]
  cloud-wa backup [--include-session --password <secret>]
  cloud-wa restore <backup-name>
  cloud-wa version | help
`;

async function makeCtx({ withWa = false } = {}) {
  const root = pathsModule.ROOT;
  ensureConfigFile(root);
  const config = loadConfig(root);
  const paths = pathsModule.buildPaths(config);
  pathsModule.ensureAll(paths);
  const logger = new Logger({ logPath: paths.logs, console: true });
  const db = await Database.open(paths.database);
  initSchema(db);
  const requeued = queue.requeueStuck(db);
  if (requeued) logger.info(`Crash recovery: ${requeued} in-flight messages requeued`);
  const ctx = { root, config, paths, logger, db, wa: null };
  if (withWa) {
    ctx.wa = new WhatsAppConnection({ paths, config, logger, db });
    ctx.wa.onSocket = (sock) => attachIncoming({ sock, db, config, paths, logger, ui });
  }
  return ctx;
}

function closeCtx(ctx) {
  try { ctx.db.close(); } catch (_) { /* ignore */ }
}

function keepAlive() {
  process.on('SIGINT', () => {
    console.log('');
    console.log('Detached. Session stays saved for the next run.');
    process.exit(0);
  });
  setInterval(() => {}, 1 << 30); // hold the event loop open
}

async function cmdConnect(ctx, flags) {
  if (ctx.wa.hasSession()) {
    console.log('✓ Existing WhatsApp session found');
    console.log('Restoring session...');
  } else {
    let raw = flags.number;
    if (!raw) raw = await ui.askRequired('Enter WhatsApp number: ');
    const norm = normalizePhone(raw, ctx.config.default_country_code);
    if (!norm.valid) { console.log(pc.red(`✗ Invalid number: ${norm.reason}`)); return 1; }
    flags.__phone = norm.phone;
    console.log('Generating pairing code...');
  }
  try {
    const res = await ctx.wa.connect({
      phone: flags.__phone || null,
      onPairingCode: (code) => {
        console.log('');
        console.log(`Pairing Code: ${pc.bold(code)}`);
        console.log('Open WhatsApp: Settings → Linked Devices → Link a Device → Link with phone number');
        console.log('Waiting for connection...');
      },
    });
    console.log(pc.green('✓ WhatsApp Connected'));
    console.log(`Number : ${res.number ? '+' + res.number : 'unknown'}`);
    console.log('Status : CONNECTED');
    console.log('Attached. Press Ctrl+C to end this process (session stays saved).');
    ctx.logger.success('WhatsApp connected via command mode');
    keepAlive();
    return 0;
  } catch (e) {
    console.log(pc.red(`✗ Connection failed: ${e.message || e}`));
    ctx.logger.error(`Command connect failed: ${e.message || e}`);
    return 1;
  }
}

async function cmdCampaignStart(ctx, id, flags) {
  if (!id) { console.log(pc.red('✗ Usage: cloud-wa campaign start <id>')); return 1; }
  if (!ctx.wa.hasSession()) {
    console.log(pc.red('✗ WhatsApp is not paired yet. Run: cloud-wa connect'));
    return 1;
  }
  console.log('Connecting WhatsApp...');
  try {
    await ctx.wa.connect({ onStatus: (s, retry) => { if (retry) console.log(`Reconnecting... (attempt ${retry})`); } });
  } catch (e) {
    console.log(pc.red(`✗ Cannot connect: ${e.message || e}`));
    return 1;
  }
  console.log(pc.green('✓ WhatsApp Connected'));
  try {
    manager.start(ctx.db, Number(id), { cooldownHours: ctx.config.cooldown_hours, defaultCC: ctx.config.default_country_code });
  } catch (e) {
    console.log(pc.red(`✗ ${e.message}`));
    return 1;
  }
  ctx.logger.info(`Campaign started (command mode): id ${id}`);
  const runner = new CampaignRunner({ db: ctx.db, wa: ctx.wa, config: ctx.config, logger: ctx.logger, ui });
  ui.setSigintHandler(() => {
    console.log('');
    console.log(pc.yellow('⚠ Campaign paused - progress saved.'));
    try { manager.pause(ctx.db, Number(id), 'paused by user (Ctrl+C)'); } catch (_) { /* ignore */ }
  });
  try {
    await runner.run(Number(id));
  } catch (e) {
    console.log(pc.red(`✗ Runner error: ${e.message || e}`));
    return 1;
  }
  const camp = manager.get(ctx.db, Number(id));
  const k = queue.counts(ctx.db, Number(id));
  console.log(`Campaign : ${camp.name}`);
  console.log(`Status   : ${camp.status}${camp.status_note ? ` (${camp.status_note})` : ''}`);
  console.log(`Sent : ${k.sent}  Pending : ${k.pending}  Failed : ${k.failed}  Skipped : ${k.skipped}  Total : ${k.total}`);
  return 0;
}

async function runCommand(argv) {
  const [cmd, sub, ...rest] = argv;
  const flags = parseFlags(argv);
  const arg0 = rest[0];

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;

    case 'version':
    case '--version':
    case '-v':
      console.log(`CLOUD WA TOOLS v${VERSION}`);
      return 0;

    case 'init': {
      const ctx = await makeCtx();
      console.log(pc.green('✓ Directories, config and database initialized'));
      console.log(`  Database: ${ctx.paths.database}`);
      closeCtx(ctx);
      return 0;
    }

    case 'check': {
      const ctx = await makeCtx();
      const ok = printChecks(await checkEnvironment({ paths: ctx.paths }));
      closeCtx(ctx);
      return ok ? 0 : 1;
    }

    case 'status': {
      const ctx = await makeCtx();
      const has = ctx.wa ? ctx.wa.hasSession() : fs.existsSync(require('path').join(ctx.paths.sessions, 'creds.json'));
      console.log('CLOUD WA TOOLS Status');
      console.log(` Session        : ${has ? 'FOUND' : 'NOT FOUND'}`);
      console.log(` Database       : ${ctx.paths.database}`);
      const counts = manager.countsSummary(ctx.db);
      const campStr = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  ') || 'none';
      console.log(` Campaigns      : ${campStr}`);
      console.log(` Queue pending  : ${ctx.db.scalar("SELECT COUNT(*) FROM queue WHERE status='pending'") || 0}`);
      console.log(` Contacts       : ${contacts.count(ctx.db)} (opted-in: ${ctx.db.scalar('SELECT COUNT(*) FROM contacts WHERE opt_in=1 AND opt_out=0') || 0})`);
      console.log(` Messages       : ${ctx.db.scalar('SELECT COUNT(*) FROM messages') || 0}`);
      const last = ctx.db.get('SELECT created_at FROM messages ORDER BY id DESC LIMIT 1');
      console.log(` Last activity  : ${last ? last.created_at : '-'}`);
      closeCtx(ctx);
      return 0;
    }

    case 'connect': {
      const ctx = await makeCtx({ withWa: true });
      const rc = await cmdConnect(ctx, flags);
      if (rc !== 0) closeCtx(ctx);
      return rc; // keepAlive holds the process when connected
    }

    case 'disconnect': {
      const ctx = await makeCtx();
      const running = ctx.db.all("SELECT * FROM campaigns WHERE status='running'");
      for (const c of running) {
        manager.pause(ctx.db, c.id, 'paused by cloud-wa disconnect');
        console.log(pc.yellow(`⚠ Campaign "${c.name}" was RUNNING - it has been paused.`));
      }
      console.log('CLI connections only live while a process is attached.');
      console.log('The saved session is kept. To remove it: cloud-wa session delete');
      closeCtx(ctx);
      return 0;
    }

    case 'session': {
      if (sub !== 'delete') { console.log(USAGE); return 1; }
      const ctx = await makeCtx();
      const dir = ctx.paths.sessions;
      if (!fs.existsSync(require('path').join(dir, 'creds.json'))) { console.log('No stored session found.'); closeCtx(ctx); return 0; }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      console.log(pc.green('✓ Session deleted. Pair again with: cloud-wa connect'));
      ctx.logger.warn('Session deleted via command mode');
      closeCtx(ctx);
      return 0;
    }

    case 'campaign': {
      const ctx = await makeCtx({ withWa: sub === 'start' || sub === 'resume' });
      try {
        if (sub === 'list') {
          const all = manager.list(ctx.db);
          if (!all.length) { console.log('No campaigns yet. Create one: cloud-wa campaign create --name ... --file ...'); closeCtx(ctx); return 0; }
          ui.printTable(
            ['ID', 'Name', 'Status', 'Delay', 'Sent/Total', 'Created'],
            all.map((c) => {
              const k = queue.counts(ctx.db, c.id);
              return [c.id, c.name, c.status, `${c.delay_min}-${c.delay_max}s`, `${k.sent}/${k.total}`, c.created_at];
            }),
            [5, 24, 10, 9, 12, 20]
          );
          closeCtx(ctx);
          return 0;
        }
        if (sub === 'create') {
          let dmin = ctx.config.min_delay;
          let dmax = ctx.config.max_delay;
          if (flags.delay) {
            const m = String(flags.delay).match(/^(\d+)-(\d+)$/);
            if (m) { dmin = Number(m[1]); dmax = Number(m[2]); }
            else if (/^\d+$/.test(String(flags.delay))) { dmin = dmax = Number(flags.delay); }
            else { console.log(pc.red('✗ --delay must be like 6-15')); closeCtx(ctx); return 1; }
          }
          const camp = manager.create(ctx.db, {
            name: flags.name, message: flags.message, recipientFile: flags.file,
            delayMin: dmin, delayMax: dmax, maxRecipients: Number(flags.max || 0),
          });
          console.log(pc.green(`✓ Campaign created: #${camp.id} "${camp.name}"`));
          closeCtx(ctx);
          return 0;
        }
        if (sub === 'pause') {
          const p = manager.pause(ctx.db, Number(arg0), 'paused via command');
          console.log(pc.green(`✓ Campaign paused: ${p.name}`));
          closeCtx(ctx);
          return 0;
        }
        if (sub === 'stop') {
          const s = manager.stop(ctx.db, Number(arg0));
          console.log(pc.green(`✓ Campaign stopped: ${s.name}`));
          closeCtx(ctx);
          return 0;
        }
        if (sub === 'start' || sub === 'resume') {
          const id = Number(arg0);
          if (!id) { console.log(pc.red('✗ Usage: cloud-wa campaign start <id>')); closeCtx(ctx); return 1; }
          if (sub === 'resume') manager.resume(ctx.db, id);
          const rc = await cmdCampaignStart(ctx, id, flags);
          closeCtx(ctx);
          return rc;
        }
        console.log(USAGE);
        closeCtx(ctx);
        return 1;
      } catch (e) {
        console.log(pc.red(`✗ ${e.message || e}`));
        closeCtx(ctx);
        return 1;
      }
    }

    case 'contacts': {
      const ctx = await makeCtx();
      try {
        if (sub === 'list') {
          const rows = contacts.list(ctx.db, { filter: flags.filter || 'all', search: flags.search || '', limit: Number(flags.limit || 50) });
          ui.printTable(
            ['ID', 'Phone', 'Name', 'Opt-in', 'Opt-out', 'Created'],
            rows.map((r) => [r.id, '+' + r.phone, r.name || '-', r.opt_in ? 'yes' : 'no', r.opt_out ? 'yes' : 'no', r.created_at]),
            [6, 16, 18, 8, 8, 20]
          );
        } else if (sub === 'import') {
          if (!arg0) throw new Error('Usage: cloud-wa contacts import contacts.csv [--opt-in]');
          const parsed = parseRecipientsFile(arg0, { defaultCC: ctx.config.default_country_code });
          let n = 0;
          for (const r of parsed.recipients) {
            contacts.add(ctx.db, r.phone, r.name, { optIn: !!flags['opt-in'], defaultCC: ctx.config.default_country_code });
            n++;
          }
          console.log(pc.green(`✓ Imported ${n} contacts (${parsed.invalid.length} invalid skipped), opt-in=${!!flags['opt-in']}`));
        } else if (sub === 'add') {
          if (!arg0) throw new Error('Usage: cloud-wa contacts add <phone> [name]');
          const r = contacts.add(ctx.db, arg0, rest[1] || '', { optIn: !!flags['opt-in'], defaultCC: ctx.config.default_country_code });
          console.log(pc.green(`✓ Contact saved: +${r.contact.phone}`));
        } else if (sub === 'optin') {
          if (!arg0) throw new Error('Usage: cloud-wa contacts optin <phone>');
          const norm = normalizePhone(arg0, ctx.config.default_country_code);
          if (!norm.valid) throw new Error(`Invalid number: ${norm.reason}`);
          if (!contacts.get(ctx.db, norm.phone)) contacts.upsert(ctx.db, norm.phone, '', { defaultCC: ctx.config.default_country_code });
          contacts.optInContact(ctx.db, norm.phone);
          console.log(pc.green(`✓ Opted in: ${norm.display}`));
        } else if (sub === 'optout') {
          if (!arg0) throw new Error('Usage: cloud-wa contacts optout <phone>');
          const norm = normalizePhone(arg0, ctx.config.default_country_code);
          if (!norm.valid) throw new Error(`Invalid number: ${norm.reason}`);
          if (!contacts.get(ctx.db, norm.phone)) contacts.upsert(ctx.db, norm.phone, '', { defaultCC: ctx.config.default_country_code });
          contacts.optOutContact(ctx.db, norm.phone, 'manual opt-out (command)');
          console.log(pc.green('✓ Recipient added to Do Not Contact'));
        } else {
          console.log(USAGE);
          closeCtx(ctx);
          return 1;
        }
        ctx.db.flushNow();
        closeCtx(ctx);
        return 0;
      } catch (e) {
        console.log(pc.red(`✗ ${e.message || e}`));
        closeCtx(ctx);
        return 1;
      }
    }

    case 'history': {
      const ctx = await makeCtx();
      let sql = `SELECT m.id, m.direction, m.phone, c.name AS campaign, m.status, m.created_at
                 FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id`;
      const where = [];
      const params = [];
      if (flags.campaign) { where.push('m.campaign_id = ?'); params.push(Number(flags.campaign)); }
      if (flags.phone) {
        const norm = normalizePhone(flags.phone, ctx.config.default_country_code);
        if (norm.valid) { where.push('m.phone = ?'); params.push(norm.phone); }
      }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ` ORDER BY m.id DESC LIMIT ${Number(flags.limit || 20)}`;
      const rows = ctx.db.all(sql, params);
      ui.printTable(
        ['ID', 'Dir', 'Phone', 'Campaign', 'Status', 'Time'],
        rows.map((r) => [r.id, r.direction, r.phone ? '+' + r.phone : '', r.campaign || '-', r.status, r.created_at]),
        [6, 4, 16, 18, 10, 20]
      );
      closeCtx(ctx);
      return 0;
    }

    case 'storage': {
      const ctx = await makeCtx();
      storage.printSummary(storage.summary(ctx.db, ctx.paths));
      closeCtx(ctx);
      return 0;
    }

    case 'logs': {
      const ctx = await makeCtx();
      let lines = [];
      if (flags.today) lines = ctx.logger.readToday();
      else if (flags.errors) lines = ctx.logger.readErrors();
      else lines = ctx.logger.tail(Number(flags.tail || 50));
      for (const l of lines) console.log(l);
      if (!lines.length) console.log('(no log lines)');
      closeCtx(ctx);
      return 0;
    }

    case 'backup': {
      const ctx = await makeCtx();
      try {
        const r = backup.createBackup({
          db: ctx.db, paths: ctx.paths, root: ctx.root, logger: ctx.logger,
          includeSession: !!flags['include-session'],
          password: flags.password || null,
        });
        console.log(pc.green(`✓ Backup created: ${r.dir}`));
        console.log(`  Messages: ${r.manifest.counts.messages}  Contacts: ${r.manifest.counts.contacts}  Campaigns: ${r.manifest.counts.campaigns}`);
        if (!flags['include-session']) console.log('  Session credentials NOT included (privacy by default).');
        closeCtx(ctx);
        return 0;
      } catch (e) {
        console.log(pc.red(`✗ ${e.message || e}`));
        closeCtx(ctx);
        return 1;
      }
    }

    case 'restore': {
      const ctx = await makeCtx();
      try {
        if (!sub) throw new Error('Usage: cloud-wa restore <backup-name>');
        const r = backup.restoreBackup({ db: ctx.db, paths: ctx.paths, backupName: sub });
        console.log(pc.green(`✓ Database restored from: ${r.dir}`));
        ctx.logger.warn(`Database restored from backup: ${sub}`);
        closeCtx(ctx);
        return 0;
      } catch (e) {
        console.log(pc.red(`✗ ${e.message || e}`));
        try { closeCtx(ctx); } catch (_) { /* ignore */ }
        return 1;
      }
    }

    default:
      console.log(pc.red(`✗ Unknown command: ${cmd}`));
      console.log(USAGE);
      return 1;
  }
}

module.exports = { runCommand, USAGE };
