'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

/* ===========================================================================
 * LIVE INTEGRATION TEST - DISABLED BY DEFAULT. NO FAKE SUCCESS IS POSSIBLE
 * HERE: this test talks to the REAL WhatsApp network through Baileys.
 *
 * Run manually (interactive: you must enter the pairing code on your phone):
 *
 *   WA_LIVE_TEST=1 \
 *   WA_TEST_NUMBER=+628xxxxxxxxxx \
 *   WA_TEST_TO=+628yyyyyyyyyy \
 *   node --test tests/whatsapp.integration.test.js
 *
 * Steps performed:
 *   1. REAL pairing code request (printed to your terminal) - comes from
 *      WhatsApp servers, never generated locally.
 *   2. Wait for the connection to actually open.
 *   3. Send ONE real message to WA_TEST_TO and verify a REAL message id
 *      is returned.
 * =========================================================================== */

const LIVE = process.env.WA_LIVE_TEST === '1';
const WA_TEST_NUMBER = process.env.WA_TEST_NUMBER;
const WA_TEST_TO = process.env.WA_TEST_TO;

test(
  'LIVE: real pairing code + real connection + real send',
  { skip: !LIVE ? 'LIVE WhatsApp test disabled - set WA_LIVE_TEST=1 with WA_TEST_NUMBER and WA_TEST_TO' : false },
  async () => {
    assert.ok(WA_TEST_NUMBER, 'WA_TEST_NUMBER is required for the LIVE test');
    assert.ok(WA_TEST_TO, 'WA_TEST_TO is required for the LIVE test');

    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { WhatsAppConnection } = require('../src/whatsapp/connection');
    const { initSchema } = require('../src/database/schema');
    const { Database } = require('../src/database/db');
    const { Logger } = require('../src/logger/logger');
    const { normalizePhone } = require('../src/utils/phone');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-live-'));
    const paths = {
      database: path.join(dir, 'database.sqlite'),
      sessions: path.join(dir, 'sessions'),
      logs: path.join(dir, 'logs'),
      media: path.join(dir, 'media'),
      messages: path.join(dir, 'messages'),
      backups: path.join(dir, 'backups'),
      exports: path.join(dir, 'exports'),
    };
    for (const k of Object.keys(paths)) fs.mkdirSync(paths[k], { recursive: true });
    const logger = new Logger({ logPath: paths.logs, console: true });
    const db = await Database.open(paths.database);
    initSchema(db);
    const wa = new WhatsAppConnection({ paths, config: {}, logger, db });

    const num = normalizePhone(WA_TEST_NUMBER, '62');
    const to = normalizePhone(WA_TEST_TO, '62');
    assert.ok(num.valid, 'WA_TEST_NUMBER invalid');
    assert.ok(to.valid, 'WA_TEST_TO invalid');

    console.log('Connecting to WhatsApp...');
    const res = await wa.connect({
      phone: num.phone,
      onPairingCode: (code) => {
        console.log('');
        console.log(`REAL Pairing Code: ${code}`);
        console.log('Open WhatsApp: Settings → Linked Devices → Link a Device → Link with phone number');
      },
    });
    assert.ok(res.number, 'connection opened without a number');

    const exists = await wa.verifyNumber(to.phone);
    console.log(`Recipient ${to.display} registered on WhatsApp: ${exists}`);

    const sent = await wa.sendText(to.phone, '[CLOUD WA TOOLS live test] This is a real test message.');
    assert.ok(sent.messageId, 'real send must return a real message id');
    console.log(`REAL message id: ${sent.messageId}`);

    wa.end();
    db.close();
  },
  { timeout: 180000 }
);
