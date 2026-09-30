'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Logger } = require('../src/logger/logger');

function makeLogger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-log-'));
  return new Logger({ logPath: dir, console: false });
}

test('logger: writes lines in the spec format', () => {
  const log = makeLogger();
  log.info('WhatsApp connecting');
  log.success('WhatsApp connected');
  log.warn('Message failed');
  log.error('Boom');
  const lines = log.readToday();
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO WhatsApp connecting$/);
  assert.match(lines[1], / SUCCESS WhatsApp connected$/);
  assert.match(lines[2], / WARNING Message failed$/);
  assert.match(lines[3], / ERROR Boom$/);
});

test('logger: readErrors returns only ERROR and WARNING lines', () => {
  const log = makeLogger();
  log.info('ok');
  log.error('bad thing');
  log.warn('careful');
  const errs = log.readErrors();
  assert.equal(errs.length, 2);
  assert.ok(errs.every((l) => / (ERROR|WARNING) /.test(l)));
});

test('logger: tail returns the last N lines', () => {
  const log = makeLogger();
  for (let i = 0; i < 10; i++) log.info(`line ${i}`);
  const t = log.tail(3);
  assert.equal(t.length, 3);
  assert.ok(t[2].endsWith('line 9'));
});

test('logger: cleanup removes old files', async () => {
  const log = makeLogger();
  log.info('x');
  // backdate the log file so the retention cutoff definitely matches
  const file = log.currentFile();
  const old = new Date(Date.now() - 5 * 86400000);
  fs.utimesSync(file, old, old);
  const removed = log.cleanup(2);
  assert.equal(removed >= 1, true);
});

test('logger: works when log dir is missing (creates it)', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-log2-')), 'nested', 'logs');
  const log = new Logger({ logPath: dir, console: false });
  log.info('create me');
  assert.ok(fs.existsSync(path.join(dir, path.basename(log.currentFile()))));
});
