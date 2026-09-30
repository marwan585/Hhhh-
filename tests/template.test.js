'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { renderTemplate } = require('../src/campaign/template');

test('template: replaces {{name}} and {{phone}}', () => {
  const out = renderTemplate('Halo {{name}}, nomor Anda {{phone}}.', { name: 'Andi', phone: '628123' });
  assert.equal(out, 'Halo Andi, nomor Anda 628123.');
});

test('template: case-insensitive and tolerant of spaces in braces', () => {
  const out = renderTemplate('Hi {{ NAME }} / {{ Phone }}', { name: 'Budi', phone: '628999' });
  assert.equal(out, 'Hi Budi / 628999');
});

test('template: falls back to nameFallback when name is empty', () => {
  const out = renderTemplate('Halo {{name}}', { name: '', phone: '628123', nameFallback: 'Pelanggan' });
  assert.equal(out, 'Halo Pelanggan');
});

test('template: falls back to phone when no name and no fallback', () => {
  const out = renderTemplate('Halo {{name}}', { name: '', phone: '628123', nameFallback: '' });
  assert.equal(out, 'Halo 628123');
});

test('template: handles multiple occurrences and preserves newlines', () => {
  const out = renderTemplate('Halo {{name}},\nTerima kasih, {{name}}.', { name: 'Citra', phone: '6281' });
  assert.equal(out, 'Halo Citra,\nTerima kasih, Citra.');
});

test('template: non-string input returns empty string', () => {
  assert.equal(renderTemplate(null, {}), '');
  assert.equal(renderTemplate(undefined, {}), '');
});
