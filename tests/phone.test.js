'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizePhone } = require('../src/utils/phone');

test('normalizePhone: +62 international format', () => {
  const r = normalizePhone('+628123456789', '62');
  assert.equal(r.valid, true);
  assert.equal(r.phone, '628123456789');
  assert.equal(r.display, '+628123456789');
  assert.equal(r.jid, '628123456789@s.whatsapp.net');
});

test('normalizePhone: local 0-prefix becomes country code', () => {
  const r = normalizePhone('08123456789', '62');
  assert.equal(r.valid, true);
  assert.equal(r.phone, '628123456789');
});

test('normalizePhone: bare 8-prefix becomes country code', () => {
  const r = normalizePhone('8123456789', '62');
  assert.equal(r.valid, true);
  assert.equal(r.phone, '628123456789');
});

test('normalizePhone: strips spaces, dashes, dots and parentheses', () => {
  const r = normalizePhone('+62 812-3456.789', '62');
  assert.equal(r.valid, true);
  assert.equal(r.phone, '628123456789');
});

test('normalizePhone: 00 international prefix', () => {
  const r = normalizePhone('00628123456789', '62');
  assert.equal(r.valid, true);
  assert.equal(r.phone, '628123456789');
});

test('normalizePhone: other country numbers with + are preserved', () => {
  const r = normalizePhone('+14155552671', '62');
  assert.equal(r.valid, true);
  assert.equal(r.phone, '14155552671');
});

test('normalizePhone: already country-coded number is kept', () => {
  const r = normalizePhone('628123456789', '62');
  assert.equal(r.valid, true);
  assert.equal(r.phone, '628123456789');
});

test('normalizePhone: rejects empty input', () => {
  assert.equal(normalizePhone('', '62').valid, false);
  assert.equal(normalizePhone(null, '62').valid, false);
  assert.equal(normalizePhone('   ', '62').valid, false);
});

test('normalizePhone: rejects too-short numbers', () => {
  const r = normalizePhone('08123', '62');
  assert.equal(r.valid, false);
});

test('normalizePhone: rejects too-long numbers', () => {
  const r = normalizePhone('08123456789012345678', '62');
  assert.equal(r.valid, false);
});

test('normalizePhone: custom country code (1 = US)', () => {
  const r = normalizePhone('04155552671', '1');
  assert.equal(r.valid, true);
  assert.equal(r.phone, '14155552671');
});
