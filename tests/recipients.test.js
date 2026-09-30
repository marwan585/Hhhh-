'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseRecipientsFile, parseCSV } = require('../src/campaign/recipients');

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-rcpt-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test('recipients: plain txt one number per line', () => {
  const f = tmpFile('a.txt', '628123456789\n628987654321\n');
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients.length, 2);
  assert.equal(r.recipients[0].phone, '628123456789');
  assert.equal(r.recipients[0].name, '');
});

test('recipients: txt with name,phone lines and comments', () => {
  const f = tmpFile('b.txt', '# daftar penerima\nAndi,628123456789\nBudi;628987654321\n\n08111111111\n');
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients.length, 3);
  assert.equal(r.recipients[0].name, 'Andi');
  assert.equal(r.recipients[1].phone, '628987654321');
  assert.equal(r.recipients[2].phone, '628111111111');
});

test('recipients: txt skips header-looking first line', () => {
  const f = tmpFile('c.txt', 'name,phone\nAndi,628123456789\n');
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients.length, 1);
  assert.equal(r.recipients[0].name, 'Andi');
});

test('recipients: csv with name,phone header', () => {
  const f = tmpFile('d.csv', 'name,phone\n"Andi, Jr.",628123456789\nBudi,628987654321\n');
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients.length, 2);
  assert.equal(r.recipients[0].name, 'Andi, Jr.');
  assert.equal(r.recipients[1].phone, '628987654321');
});

test('recipients: csv with phone,name header order', () => {
  const f = tmpFile('e.csv', 'phone,name\n628123456789,Andi\n');
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients[0].phone, '628123456789');
  assert.equal(r.recipients[0].name, 'Andi');
});

test('recipients: csv without header auto-detects phone column', () => {
  const f = tmpFile('f.csv', 'Andi,628123456789\n628987654321,Budi\n');
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients.length, 2);
  assert.equal(r.recipients[0].phone, '628123456789');
  assert.equal(r.recipients[1].name, 'Budi');
});

test('recipients: xlsx first sheet is parsed', () => {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['name', 'phone'],
    ['Andi', '628123456789'],
    ['Budi', '08987654321'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-xlsx-'));
  const f = path.join(dir, 'recipients.xlsx');
  XLSX.writeFile(wb, f);
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients.length, 2);
  assert.equal(r.recipients[0].phone, '628123456789');
  assert.equal(r.recipients[1].phone, '628987654321');
});

test('recipients: deduplicates numbers', () => {
  const f = tmpFile('g.txt', '628123456789\n08123456789\n+628123456789\n');
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients.length, 1);
});

test('recipients: collects invalid entries with reasons', () => {
  const f = tmpFile('h.txt', '12345\n628123456789\nnotanumber\n');
  const r = parseRecipientsFile(f, { defaultCC: '62' });
  assert.equal(r.recipients.length, 1);
  assert.equal(r.invalid.length, 2);
  assert.ok(r.invalid[0].reason);
});

test('recipients: missing file throws a clear error', () => {
  assert.throws(() => parseRecipientsFile('/nonexistent/file.txt', {}), /not found/i);
});

test('recipients: unsupported extension throws', () => {
  const f = tmpFile('i.docx', 'hello');
  assert.throws(() => parseRecipientsFile(f, {}), /Unsupported/i);
});

test('parseCSV: handles quotes, escaped quotes and CRLF', () => {
  const rows = parseCSV('a,"b""x",c\r\n1,2,3\r\n');
  assert.deepEqual(rows[0], ['a', 'b"x', 'c']);
  assert.deepEqual(rows[1], ['1', '2', '3']);
});
