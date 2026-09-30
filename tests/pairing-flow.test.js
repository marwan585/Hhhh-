'use strict';
/* Unit tests for the WhatsApp pairing flow (src/whatsapp/connection.js).
 *
 * STUB NOTICE (clearly marked per project spec): the Baileys library is
 * replaced with an in-memory fake via the __setBaileysLib test seam so the
 * pairing state machine can be verified deterministically. Nothing here
 * fakes a real WhatsApp connection - the LIVE integration test
 * (tests/whatsapp.integration.test.js) stays the only real-network test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const realBaileys = require('@whiskeysockets/baileys');
const { WhatsAppConnection, __setBaileysLib } = require('../src/whatsapp/connection');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeout = 2000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await wait(5);
  }
  assert.ok(fn(), `timeout waiting for ${label}`);
}

function silentLogger() {
  const noop = () => {};
  return { info: noop, success: noop, warn: noop, error: noop, debug: noop };
}

/** Build a fake Baileys module (STUB). */
function makeFakeBaileys(opts = {}) {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.ev = new EventEmitter();
      this.user = null;
      this.pairingCalls = 0;
      sockets.push(this);
    }
    async requestPairingCode(num) {
      this.pairingCalls += 1;
      if (opts.pairingShouldFail && opts.pairingShouldFail(this.pairingCalls, this)) {
        throw new Error('Connection Closed');
      }
      return 'ABCD1234';
    }
    end() {}
  }
  return {
    __sockets: sockets,
    useMultiFileAuthState: async (dir) => {
      const credsPath = path.join(dir, 'creds.json');
      if (!fs.existsSync(credsPath)) {
        fs.writeFileSync(credsPath, JSON.stringify({ registered: !!opts.registered }));
      }
      return {
        state: { creds: { registered: !!opts.registered }, keys: {} },
        saveCreds: async () => {},
      };
    },
    makeCacheableSignalKeyStore: (keys) => keys,
    Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '1'] },
    DisconnectReason: {
      loggedOut: 401, connectionClosed: 428, restartRequired: 515,
      connectionReplaced: 440, timedOut: 408, connectionLost: 411,
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 101] }),
    makeWASocket: () => new FakeSocket(),
  };
}

function makeConn(t, fake) {
  __setBaileysLib(fake);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-pair-'));
  t.after(() => {
    __setBaileysLib(realBaileys);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const conn = new WhatsAppConnection({ paths: { sessions: dir }, config: {}, logger: silentLogger(), db: null });
  // Shorten timers so tests stay fast (same logic, tiny delays).
  conn._pairReadyFallbackMs = 500;
  conn._pairRequestDelays = [0, 5, 5];
  conn._pairRequestTimeoutMs = 100;
  conn._pairRetryDelay = 5;
  conn._pairMaxRetries = 2;
  return { conn, dir };
}

test('pairing code is requested only after handshake-ready (QR) event, not at 0ms', async (t) => {
  const fake = makeFakeBaileys();
  const { conn } = makeConn(t, fake);
  const codes = [];
  const p = conn.connect({ phone: '628123456789', onPairingCode: (c) => codes.push(c) });
  await until(() => fake.__sockets.length === 1, 2000, 'socket created');
  await wait(60); // give a (wrong) immediate request time to happen (< fallback 500ms)
  const sock1 = fake.__sockets[0];
  assert.strictEqual(sock1.pairingCalls, 0, 'must NOT request pairing before handshake ready');
  sock1.ev.emit('connection.update', { qr: 'QRDATA', connection: 'connecting' });
  await until(() => codes.length === 1, 2000, 'pairing code delivered to callback');
  assert.strictEqual(sock1.pairingCalls, 1);
  assert.deepStrictEqual(codes, ['ABCD-1234']);
  sock1.user = { id: '628123456789:1@s.whatsapp.net' };
  sock1.ev.emit('connection.update', { connection: 'open' });
  const res = await p;
  assert.strictEqual(res.number, '628123456789');
});

test('401 during FRESH pairing clears partial session and retries with a clean socket (not session_expired)', async (t) => {
  const fake = makeFakeBaileys({ pairingShouldFail: (_n, sock) => sock === fake.__sockets[0] });
  const { conn, dir } = makeConn(t, fake);
  const expired = [];
  const retries = [];
  conn.on('session_expired', () => expired.push(true));
  conn.on('pairing_retry', (n) => retries.push(n));
  const p = conn.connect({ phone: '628987654321', onPairingCode: () => {} });
  await until(() => fake.__sockets.length === 1, 2000, 'first socket');
  const sock1 = fake.__sockets[0];
  sock1.ev.emit('connection.update', { qr: 'QR', connection: 'connecting' }); // arms pairing
  await until(() => sock1.pairingCalls >= 1, 2000, 'first pairing attempt');
  sock1.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await until(() => retries.length === 1, 2000, 'clean retry scheduled');
  assert.strictEqual(fs.existsSync(path.join(dir, 'creds.json')), false, 'partial session files cleared');
  await until(() => fake.__sockets.length === 2, 2000, 'fresh socket started');
  const sock2 = fake.__sockets[1];
  sock2.ev.emit('connection.update', { qr: 'QR', connection: 'connecting' });
  await until(() => sock2.pairingCalls === 1, 2000, 'pairing requested on fresh socket');
  sock2.user = { id: '628987654321:1@s.whatsapp.net' };
  sock2.ev.emit('connection.update', { connection: 'open' });
  await p;
  assert.strictEqual(expired.length, 0, 'session_expired must NOT fire for a fresh pairing');
});

test('401 with a REGISTERED session still reports session_expired', async (t) => {
  const fake = makeFakeBaileys({ registered: true });
  const { conn } = makeConn(t, fake);
  const expired = [];
  conn.on('session_expired', () => expired.push(1));
  const p = conn.connect({});
  await until(() => fake.__sockets.length === 1, 2000, 'socket created');
  fake.__sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await assert.rejects(p, /SESSION_EXPIRED/);
  assert.strictEqual(expired.length, 1);
});

test('pairing code falls back to timer request when no QR event arrives', async (t) => {
  const fake = makeFakeBaileys();
  const { conn } = makeConn(t, fake);
  const codes = [];
  const p = conn.connect({ phone: '628111222333', onPairingCode: (c) => codes.push(c) });
  await until(() => fake.__sockets.length === 1, 2000, 'socket created');
  await until(() => fake.__sockets[0].pairingCalls === 1, 2000, 'fallback pairing request');
  await until(() => codes.length === 1, 2000, 'fallback pairing code delivered');
  assert.deepStrictEqual(codes, ['ABCD-1234']);
  const sock1 = fake.__sockets[0];
  sock1.user = { id: '628111222333:1@s.whatsapp.net' };
  sock1.ev.emit('connection.update', { connection: 'open' });
  await p;
});

test('stale socket pairing rejection must not kill a newer pairing attempt', async (t) => {
  // Socket 1: request fails, then the socket closes (401) and a clean retry
  // starts. Any late rejection from socket 1 must be ignored.
  const fake = makeFakeBaileys({ pairingShouldFail: (_n, sock) => sock === fake.__sockets[0] });
  const { conn } = makeConn(t, fake);
  const p = conn.connect({ phone: '628777888999', onPairingCode: () => {} });
  await until(() => fake.__sockets.length === 1, 2000, 'first socket');
  const sock1 = fake.__sockets[0];
  sock1.ev.emit('connection.update', { qr: 'QR', connection: 'connecting' });
  await until(() => sock1.pairingCalls >= 1, 2000, 'first attempt');
  sock1.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await until(() => fake.__sockets.length === 2, 2000, 'fresh socket');
  const sock2 = fake.__sockets[1];
  sock2.ev.emit('connection.update', { qr: 'QR', connection: 'connecting' });
  await until(() => sock2.pairingCalls === 1, 2000, 'pairing on fresh socket');
  sock2.user = { id: '628777888999:1@s.whatsapp.net' };
  sock2.ev.emit('connection.update', { connection: 'open' });
  await p; // resolves -> stale rejection did not reject the connect promise
});
