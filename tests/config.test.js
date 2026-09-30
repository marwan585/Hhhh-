'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, saveConfig, DEFAULTS } = require('../src/utils/config');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-cfg-'));
}

test('config: defaults when no config file exists (file auto-created)', () => {
  const root = tmpRoot();
  const cfg = loadConfig(root);
  assert.equal(cfg.min_delay, DEFAULTS.min_delay);
  assert.equal(cfg.max_delay, DEFAULTS.max_delay);
  assert.equal(cfg.cooldown_hours, DEFAULTS.cooldown_hours);
  assert.equal(cfg.archive_after_send, DEFAULTS.archive_after_send);
  assert.ok(fs.existsSync(path.join(root, 'config', 'config.json')));
});

test('config: reads values from config.json', () => {
  const root = tmpRoot();
  saveConfig(root, { ...DEFAULTS, min_delay: 9, max_delay: 20, name_fallback: 'Pelanggan' });
  const cfg = loadConfig(root);
  assert.equal(cfg.min_delay, 9);
  assert.equal(cfg.max_delay, 20);
  assert.equal(cfg.name_fallback, 'Pelanggan');
});

test('config: environment variables override the file (spec section 17)', () => {
  const root = tmpRoot();
  process.env.CLOUD_WA_MIN_DELAY = '11';
  process.env.CLOUD_WA_MAX_DELAY = '25';
  try {
    const cfg = loadConfig(root);
    assert.equal(cfg.min_delay, 11);
    assert.equal(cfg.max_delay, 25);
  } finally {
    delete process.env.CLOUD_WA_MIN_DELAY;
    delete process.env.CLOUD_WA_MAX_DELAY;
  }
});

test('config: invalid JSON fails loudly, never silently', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'config.json'), '{not json');
  assert.throws(() => loadConfig(root), /not valid JSON/);
});

test('config: max_delay is bumped to min_delay when inverted', () => {
  const root = tmpRoot();
  saveConfig(root, { ...DEFAULTS, min_delay: 30, max_delay: 5 });
  const cfg = loadConfig(root);
  assert.ok(Number(cfg.max_delay) >= Number(cfg.min_delay));
});

test('config: .env file values are loaded', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.env'), 'CLOUD_WA_COOLDOWN_HOURS=48\n');
  const cfg = loadConfig(root);
  assert.equal(cfg.cooldown_hours, 48);
});
