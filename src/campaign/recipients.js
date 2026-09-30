'use strict';
const fs = require('fs');
const path = require('path');
const { normalizePhone } = require('../utils/phone');

/* ---------------------------------------------------------------------------
 * Recipient file parser: .txt, .csv, .xlsx (spec section 8).
 *
 * TXT  - one recipient per line: "628123456789" or "Andi,628123456789"
 *        (also accepts ; tab and | separators, and # comment lines)
 * CSV  - with header  : name,phone / phone,name / nomor,nama ...
 *        without header: auto-detects which column is the phone number
 * XLSX - first worksheet, same header detection as CSV
 * ------------------------------------------------------------------------- */

const HEADER_PHONE = /^(phone|number|nomor|no|wa|whatsapp|msisdn|handphone|hp|tel|telp|telephone)$/i;
const HEADER_NAME = /^(name|nama|contact|penerima|fullname|full[_\s]?name|first[_\s]?name)$/i;

function splitLine(line) {
  return line.split(/[,;\t|]/).map((s) => s.trim());
}

function isHeaderRow(cells) {
  return cells.some((c) => HEADER_PHONE.test(String(c).trim()) || HEADER_NAME.test(String(c).trim()));
}

function parseRow(cells) {
  const list = cells.map((c) => String(c === null || c === undefined ? '' : c).trim()).filter((c) => c !== '');
  if (!list.length) return null;
  if (list.length === 1) return { phone: list[0], name: '' };
  const { isPhoneish } = require('../utils/phone');
  const phoneIdx = list.findIndex((c) => isPhoneish(c));
  if (phoneIdx === -1) return { phone: list[0], name: list.slice(1).join(' ') };
  const name = list.filter((_, i) => i !== phoneIdx).join(' ');
  return { phone: list[phoneIdx], name };
}

function mapHeaders(row) {
  let pi = -1;
  let ni = -1;
  row.forEach((c, i) => {
    const v = String(c).trim();
    if (pi === -1 && HEADER_PHONE.test(v)) pi = i;
    if (ni === -1 && HEADER_NAME.test(v)) ni = i;
  });
  return pi === -1 ? null : { pi, ni };
}

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => String(c).trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((c) => String(c).trim() !== '')) rows.push(row);
  }
  return rows;
}

function rowsToEntries(rows) {
  if (!rows.length) return [];
  const hdr = mapHeaders(rows[0]);
  const body = hdr ? rows.slice(1) : rows;
  const out = [];
  for (const r of body) {
    if (hdr) {
      const p = r[hdr.pi] === undefined || r[hdr.pi] === null ? '' : r[hdr.pi];
      const n = hdr.ni >= 0 ? (r[hdr.ni] === undefined ? '' : r[hdr.ni]) : '';
      out.push({ rawPhone: String(p).trim(), name: String(n).trim() });
    } else {
      const pr = parseRow(r);
      if (pr) out.push({ rawPhone: pr.phone, name: pr.name });
    }
  }
  return out;
}

function parseRecipientsFile(filePath, { defaultCC = '62' } = {}) {
  if (!filePath) throw new Error('Recipient file path is required');
  if (!fs.existsSync(filePath)) throw new Error(`Recipient file not found: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  let entries = [];

  if (ext === '.xlsx' || ext === '.xls') {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(filePath);
    if (!wb.SheetNames.length) throw new Error('XLSX file has no worksheets');
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' })
      .map((r) => (Array.isArray(r) ? r : [r]));
    entries = rowsToEntries(rows);
  } else if (ext === '.csv') {
    entries = rowsToEntries(parseCSV(fs.readFileSync(filePath, 'utf8')));
  } else if (ext === '.txt' || ext === '.text' || ext === '') {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    let first = true;
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const cells = splitLine(line);
      if (first && isHeaderRow(cells)) { first = false; continue; }
      first = false;
      const pr = parseRow(cells);
      if (pr) entries.push({ rawPhone: pr.phone, name: pr.name });
    }
  } else {
    throw new Error(`Unsupported recipient file type "${ext}". Use .txt, .csv or .xlsx`);
  }

  const seen = new Set();
  const recipients = [];
  const invalid = [];
  for (const e of entries) {
    const norm = normalizePhone(e.rawPhone, defaultCC);
    if (!norm.valid) {
      invalid.push({ raw: e.rawPhone, name: e.name, reason: norm.reason });
      continue;
    }
    if (seen.has(norm.phone)) continue;
    seen.add(norm.phone);
    recipients.push({ phone: norm.phone, display: norm.display, name: e.name || '', jid: norm.jid });
  }
  return { recipients, invalid };
}

module.exports = { parseRecipientsFile, parseCSV, parseRow, mapHeaders, isHeaderRow };
