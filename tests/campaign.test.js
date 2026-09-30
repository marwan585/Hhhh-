'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const manager = require('../src/campaign/manager');
const queue = require('../src/queue/queue');
const contacts = require('../src/contacts/contacts');
const { CampaignRunner, classifySendError } = require('../src/campaign/runner');
const { makeWorkspace } = require('./helpers');

/* ===========================================================================
 * UNIT TESTS with a clearly marked TEST STUB WhatsApp connection.
 * The stub exists ONLY inside this test file. Production code never fakes
 * WhatsApp successes: with the real connection, a send either truly succeeds
 * (real message id from Baileys) or an error is raised and handled.
 * =========================================================================== */
class StubWhatsApp {
  constructor() {
    this.sent = [];
    this.failMode = null; // 'restriction' | 'fail' | null
    this.failAfter = 0;   // number of successful sends before failing kicks in
    this.delayMs = 20;
  }
  async sendText(phone, text) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    const shouldFail = this.failMode !== null && this.sent.length >= this.failAfter;
    if (shouldFail && this.failMode === 'restriction') {
      const err = new Error('forbidden');
      err.output = { statusCode: 403 };
      throw err;
    }
    if (shouldFail && this.failMode === 'fail') throw new Error('network down');
    this.sent.push({ phone, text });
    return { messageId: `TESTMSG.${this.sent.length}` }; // STUB id (unit test only)
  }
  async verifyNumber(phone) { return !phone.endsWith('00000'); }
  async archiveChat(phone) { this.archived = (this.archived || []).concat(phone); return true; }
}

function baseConfig(overrides = {}) {
  return {
    cooldown_hours: 24,
    verify_recipients: true,
    archive_after_send: false,
    messages_per_session: 0,
    max_retry: 2,
    min_delay: 0,
    max_delay: 0,
    name_fallback: '',
    ...overrides,
  };
}

async function seedCampaign(ws, { recipients = 4, optIn = true } = {}) {
  const file = path.join(ws.dir, 'recipients.txt');
  const lines = [];
  for (let i = 0; i < recipients; i++) {
    const phone = `62811111111${i}`;
    lines.push(`User${i},${phone}`);
    if (optIn) contacts.add(ws.db, phone, `User${i}`, { optIn: true, defaultCC: '62' });
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return manager.create(ws.db, {
    name: 'Promo September',
    message: 'Halo {{name}} ({{phone}})',
    recipientFile: file,
    delayMin: 0,
    delayMax: 0,
    maxRecipients: 0,
  });
}

async function runRunner(ws, wa, config, campaignId) {
  const ui = require('../src/cli/ui');
  const logger = new (require('../src/logger/logger').Logger)({ logPath: ws.paths.logs, console: false });
  const runner = new CampaignRunner({ db: ws.db, wa, config, logger, ui });
  await runner.run(campaignId);
  return runner;
}

/* ------------------------------ manager tests --------------------------- */

test('campaign: create validates name, message and file', async () => {
  const ws = await makeWorkspace();
  assert.throws(() => manager.create(ws.db, { name: '', message: 'x', recipientFile: '/tmp/x.txt' }), /name/i);
  assert.throws(() => manager.create(ws.db, { name: 'A', message: '', recipientFile: '/tmp/x.txt' }), /message/i);
  assert.throws(() => manager.create(ws.db, { name: 'A', message: 'x', recipientFile: '' }), /file/i);
  assert.throws(() => manager.create(ws.db, { name: 'A', message: 'x', recipientFile: '/nonexistent.txt' }), /not found/i);
  ws.db.close();
});

test('campaign: create rejects duplicate names', async () => {
  const ws = await makeWorkspace();
  const file = path.join(ws.dir, 'r.txt');
  fs.writeFileSync(file, '628123456789\n');
  manager.create(ws.db, { name: 'Promo', message: 'x', recipientFile: file, delayMin: 5, delayMax: 10, maxRecipients: 0 });
  assert.throws(() => manager.create(ws.db, { name: 'Promo', message: 'y', recipientFile: file }), /already exists/i);
  ws.db.close();
});

test('campaign: create rejects delay max < min', async () => {
  const ws = await makeWorkspace();
  const file = path.join(ws.dir, 'r.txt');
  fs.writeFileSync(file, '628123456789\n');
  assert.throws(() => manager.create(ws.db, { name: 'A', message: 'm', recipientFile: file, delayMin: 10, delayMax: 5 }), /Delay maximum/);
  ws.db.close();
});

/* -------------------------- runner happy path --------------------------- */

test('campaign: runner sends all recipients and marks completed', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 4 });
  const wa = new StubWhatsApp();
  await manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });
  await runRunner(ws, wa, baseConfig(), camp.id);

  const c = manager.get(ws.db, camp.id);
  assert.equal(c.status, 'completed');
  const k = queue.counts(ws.db, camp.id);
  assert.equal(k.sent, 4);
  assert.equal(k.failed, 0);
  assert.equal(wa.sent.length, 4);
  assert.equal(wa.sent[0].text, 'Halo User0 (628111111110)');
  // message history stored with the (stub) message id + SENT status
  const msg = ws.db.get('SELECT * FROM messages WHERE direction = ?', ['out']);
  assert.equal(msg.status, 'SENT');
  assert.ok(msg.message_id.startsWith('TESTMSG.'));
  // contacts were saved/kept on send
  assert.equal(ws.db.scalar('SELECT COUNT(*) FROM contacts'), 4);
  ws.db.close();
});

test('campaign: start builds queue only once and skips non-opted-in', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 3, optIn: false });
  assert.throws(() => manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' }), /No eligible recipients/);
  ws.db.close();
});

/* ------------------------------- pause tests ---------------------------- */

test('campaign: session limit auto-pauses, resume finishes the job', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 5 });
  const wa = new StubWhatsApp();
  await manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });

  await runRunner(ws, wa, baseConfig({ messages_per_session: 2 }), camp.id);
  let c = manager.get(ws.db, camp.id);
  assert.equal(c.status, 'paused');
  assert.ok(/session limit/.test(c.status_note));
  let k = queue.counts(ws.db, camp.id);
  assert.equal(k.sent, 2);
  assert.equal(k.pending, 3);

  // resume and finish
  manager.resume(ws.db, camp.id);
  await runRunner(ws, wa, baseConfig({ messages_per_session: 0 }), camp.id);
  c = manager.get(ws.db, camp.id);
  assert.equal(c.status, 'completed');
  k = queue.counts(ws.db, camp.id);
  assert.equal(k.sent, 5);
  ws.db.close();
});

test('campaign: WhatsApp restriction auto-pauses and keeps the item pending', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 3 });
  const wa = new StubWhatsApp();
  await manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });

  wa.failMode = 'restriction';
  wa.failAfter = 1; // first send succeeds, the next one gets rejected by WhatsApp
  await runRunner(ws, wa, baseConfig(), camp.id);
  const c = manager.get(ws.db, camp.id);
  assert.equal(c.status, 'paused');
  assert.ok(/restriction/i.test(c.status_note));
  const k = queue.counts(ws.db, camp.id);
  assert.equal(k.sent, 1);       // first message went through
  assert.equal(k.pending, 2);    // in-flight item restored, rest untouched

  // after the restriction clears, resume completes the campaign
  wa.failMode = null;
  manager.resume(ws.db, camp.id);
  await runRunner(ws, wa, baseConfig(), camp.id);
  assert.equal(manager.get(ws.db, camp.id).status, 'completed');
  ws.db.close();
});

test('campaign: pause is honored mid-run within the delay slice', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 10 });
  const wa = new StubWhatsApp();
  await manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });

  const runPromise = runRunner(ws, wa, baseConfig(), camp.id);
  setTimeout(() => { try { manager.pause(ws.db, camp.id, 'user'); } catch (_) { /* already finished */ } }, 60);
  await runPromise;

  const c = manager.get(ws.db, camp.id);
  assert.equal(c.status, 'paused');
  const k = queue.counts(ws.db, camp.id);
  assert.ok(k.sent < 10, 'runner stopped before finishing');
  assert.ok(k.pending > 0);
  ws.db.close();
});

/* -------------------------------- stop tests ---------------------------- */

test('campaign: stop keeps pending rows and stops sending', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 10 });
  const wa = new StubWhatsApp();
  await manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });

  const runPromise = runRunner(ws, wa, baseConfig(), camp.id);
  setTimeout(() => { try { manager.stop(ws.db, camp.id); } catch (_) { /* already finished */ } }, 60);
  await runPromise;

  assert.equal(manager.get(ws.db, camp.id).status, 'stopped');
  const k = queue.counts(ws.db, camp.id);
  assert.ok(k.sent + k.pending + k.skipped === k.total);
  ws.db.close();
});

test('campaign: stopped campaign can be started again to finish the queue', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 3 });
  const wa = new StubWhatsApp();
  await manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });
  wa.delayMs = 40;
  const runPromise = runRunner(ws, wa, baseConfig(), camp.id);
  setTimeout(() => { try { manager.stop(ws.db, camp.id); } catch (_) { /* already finished */ } }, 60);
  await runPromise;
  assert.equal(manager.get(ws.db, camp.id).status, 'stopped');

  manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' }); // continues remaining queue
  await runRunner(ws, wa, baseConfig(), camp.id);
  const c = manager.get(ws.db, camp.id);
  assert.equal(c.status, 'completed');
  assert.equal(queue.counts(ws.db, camp.id).sent, 3);
  ws.db.close();
});

/* ---------------------------- manager transitions ----------------------- */

test('campaign: state transition guards', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 2 });
  assert.throws(() => manager.pause(ws.db, camp.id), /not running/);
  assert.throws(() => manager.resume(ws.db, camp.id), /paused campaigns can be resumed/i);
  manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });
  assert.equal(manager.get(ws.db, camp.id).status, 'running');
  manager.pause(ws.db, camp.id, 'test');
  assert.equal(manager.get(ws.db, camp.id).status, 'paused');
  manager.resume(ws.db, camp.id);
  assert.equal(manager.get(ws.db, camp.id).status, 'running');
  assert.throws(() => manager.remove(ws.db, 999), /not found/i);
  ws.db.close();
});

/* ------------------------------ error handling -------------------------- */

test('campaign: transient failures retry up to max_retry then mark FAILED', async () => {
  const ws = await makeWorkspace();
  const camp = await seedCampaign(ws, { recipients: 1 });
  const wa = new StubWhatsApp();
  wa.failMode = 'fail';
  await manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });
  await runRunner(ws, wa, baseConfig({ max_retry: 3 }), camp.id);
  const k = queue.counts(ws.db, camp.id);
  assert.equal(k.failed, 1);
  const row = ws.db.get('SELECT attempts, error FROM queue');
  assert.equal(row.attempts, 3);
  assert.ok(/network down/.test(row.error));
  assert.equal(wa.sent.length, 0); // nothing fake-sent
  ws.db.close();
});

test('campaign: failed number verification is marked FAILED', async () => {
  const ws = await makeWorkspace();
  const file = path.join(ws.dir, 'r.txt');
  fs.writeFileSync(file, '6281000000000\n'); // ends with 0000 -> stub returns false
  const camp = manager.create(ws.db, { name: 'BadNum', message: 'hi', recipientFile: file, delayMin: 0, delayMax: 0, maxRecipients: 0 });
  contacts.add(ws.db, '6281000000000', '', { optIn: true, defaultCC: '62' });
  const wa = new StubWhatsApp();
  await manager.start(ws.db, camp.id, { cooldownHours: 24, defaultCC: '62' });
  await runRunner(ws, wa, baseConfig(), camp.id);
  const k = queue.counts(ws.db, camp.id);
  assert.equal(k.failed, 1);
  assert.equal(wa.sent.length, 0);
  ws.db.close();
});

test('classifySendError: maps WhatsApp restriction signatures', () => {
  assert.equal(classifySendError({ output: { statusCode: 403 } }), 'restriction');
  assert.equal(classifySendError({ output: { statusCode: 429 } }), 'restriction');
  assert.equal(classifySendError(new Error('Banned from sending')), 'restriction');
  assert.equal(classifySendError(new Error('rate limit exceeded')), 'restriction');
  assert.equal(classifySendError(new Error('socket hang up')), 'generic');
});
