'use strict';
const readline = require('readline');
const pc = require('picocolors');

/* ---------------------------------------------------------------------------
 * Terminal UI helpers: banner, status boxes, prompts, progress bar, tables.
 * Colors automatically degrade to plain text when the terminal does not
 * support them (picocolors respects NO_COLOR / non-TTY).
 * ------------------------------------------------------------------------- */

let rl = null;
let sigintHandler = null;

function rlInstance() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => {
      if (sigintHandler) sigintHandler();
    });
  }
  return rl;
}

function setSigintHandler(fn) {
  sigintHandler = fn;
}

function ask(question) {
  return new Promise((resolve) => {
    rlInstance().question(question, (answer) => resolve(String(answer || '').trim()));
  });
}

async function askRequired(question) {
  for (;;) {
    const a = await ask(question);
    if (a) return a;
    console.log(pc.red('  ✗ Value is required.'));
  }
}

async function confirm(question, def = false) {
  const suffix = def ? '[Y/n]' : '[y/N]';
  for (;;) {
    const a = await ask(`${question} ${suffix}: `);
    if (!a) return def;
    if (/^(y|yes|ya)$/i.test(a)) return true;
    if (/^(n|no|tidak)$/i.test(a)) return false;
    console.log(pc.yellow('  Please answer y or n.'));
  }
}

async function askInt(question, { min = null, max = null, def = null } = {}) {
  for (;;) {
    const a = await ask(question);
    if (!a && def !== null) return def;
    const n = Number(a);
    if (!Number.isFinite(n) || !/^\d+$/.test(String(a))) {
      console.log(pc.red('  ✗ Please enter a whole number.'));
      continue;
    }
    if (min !== null && n < min) { console.log(pc.red(`  ✗ Minimum is ${min}.`)); continue; }
    if (max !== null && n > max) { console.log(pc.red(`  ✗ Maximum is ${max}.`)); continue; }
    return n;
  }
}

/* ------------------------------ boxes & banner --------------------------- */

function banner(version = '') {
  const line = '═'.repeat(36);
  console.log('');
  console.log(pc.cyan(`╔${line}╗`));
  console.log(pc.cyan('║') + pc.bold(pc.white(center('CLOUD WA TOOLS', 36))) + pc.cyan('║'));
  if (version) console.log(pc.cyan('║') + pc.dim(center(`v${version}`, 36)) + pc.cyan('║'));
  console.log(pc.cyan(`╚${line}╝`));
  console.log('');
}

function center(text, width) {
  const t = String(text);
  const pad = Math.max(0, width - t.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + t + ' '.repeat(pad - left);
}

function padCell(s, width) {
  const t = String(s === null || s === undefined ? '' : s);
  return t.length >= width ? t.slice(0, width) : t + ' '.repeat(width - t.length);
}

function statusBox({ state, number, campaign, campaignStatus, note }) {
  let dot;
  if (state === 'CONNECTED') dot = pc.green('●');
  else if (state === 'CONNECTING' || state === 'PAIRING') dot = pc.yellow('●');
  else dot = pc.red('●');

  const rows = [['WhatsApp', `${dot} ${state || 'DISCONNECTED'}`]];
  if (number) rows.push(['Number', number]);
  if (campaign) rows.push(['Campaign', campaign]);
  if (campaignStatus) rows.push(['Status', campaignStatus]);
  if (note) rows.push(['Note', note]);

  const cells = rows.map(([k, v]) => ` ${padCell(k, 10)}: ${v} `);
  const width = Math.max(38, ...cells.map((c) => c.length));
  console.log(pc.cyan(`╔${'═'.repeat(width)}╗`));
  console.log(pc.cyan('║') + pc.bold(pc.white(center('CLOUD WA TOOLS', width))) + pc.cyan('║'));
  console.log(pc.cyan(`╠${'═'.repeat(width)}╣`));
  for (const c of cells) console.log(pc.cyan('║') + c + ' '.repeat(width - c.length) + pc.cyan('║'));
  console.log(pc.cyan(`╚${'═'.repeat(width)}╝`));
}

function boxRound(lines) {
  const inner = lines.map((l) => ` ${l} `);
  const width = Math.max(2, ...inner.map((l) => l.length));
  console.log(pc.cyan(`╭${'─'.repeat(width)}╮`));
  for (const l of inner) console.log(pc.cyan('│') + l + ' '.repeat(width - l.length) + pc.cyan('│'));
  console.log(pc.cyan(`╰${'─'.repeat(width)}╯`));
}

function title(text) {
  console.log('');
  console.log(pc.bold(pc.cyan(text)));
}

function hr() {
  console.log(pc.dim('─'.repeat(46)));
}

function kv(key, value) {
  console.log(` ${pc.bold(padCell(key, 12))}: ${value}`);
}

function successLine(msg) { console.log(pc.green(`✓ ${msg}`)); }
function warnLine(msg) { console.log(pc.yellow(`⚠ ${msg}`)); }
function errorLine(msg) { console.log(pc.red(`✗ ${msg}`)); }
function infoLine(msg) { console.log(pc.cyan(`${msg}`)); }

function printIncoming(from, text) {
  if (!isBusy()) {
    console.log('');
    console.log(pc.cyan('Incoming Message'));
    console.log(`From: ${pc.bold(from)}`);
    console.log(`Message: ${text}`);
    console.log('');
  }
}

/* ------------------------------ progress bar ----------------------------- */

let progress = null;
const printBuffer = [];

function progressStart() {
  progress = { active: true, n: 0, last: '' };
}

function progressUpdate({ name, sent, pending, failed, skipped, total, current }) {
  if (!progress || !progress.active) return;
  const done = (sent || 0) + (failed || 0) + (skipped || 0);
  const tot = Math.max(total || 0, done);
  const pct = tot ? Math.round((done * 100) / tot) : 0;
  const barW = 20;
  const filled = tot ? Math.round((barW * done) / tot) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(barW - filled);
  let line = `${pc.cyan('Campaign')} : ${name}  ${pc.green(bar)} ${pct}%  │  Sent : ${sent || 0}  Pending : ${pending || 0}  Failed : ${failed || 0}`;
  if (skipped) line += `  Skipped : ${skipped}`;
  if (current) line += `  │  ${current}`;
  progress.last = line;
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(line);
  } else {
    progress.n += 1;
    if (progress.n % 10 === 1) console.log(line);
  }
}

function progressStop() {
  if (process.stdout.isTTY && progress && progress.active) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
  progress = null;
  while (printBuffer.length) console.log(printBuffer.shift());
}

function isBusy() {
  return !!(progress && progress.active);
}

/** Print that waits when the progress bar is active. */
function safePrint(line) {
  if (isBusy()) printBuffer.push(line);
  else console.log(line);
}

/* --------------------------------- tables -------------------------------- */

function printTable(headers, rows, widths) {
  const w = widths || headers.map((h, i) => {
    let m = String(h).length;
    for (const r of rows) m = Math.max(m, String(r[i] === null || r[i] === undefined ? '' : r[i]).length);
    return Math.min(m + 2, 40);
  });
  const fmt = (cells) => cells.map((c, i) => padCell(c, w[i])).join(' ');
  console.log(pc.dim(' ' + fmt(headers)));
  console.log(pc.dim(' ' + w.map((x) => '─'.repeat(x)).join(' ')));
  for (const r of rows) console.log(' ' + fmt(r));
  if (!rows.length) console.log(pc.dim(' (empty)'));
}

module.exports = {
  ask, askRequired, askInt, confirm,
  setSigintHandler,
  banner, statusBox, boxRound, title, hr, kv, center,
  successLine, warnLine, errorLine, infoLine,
  progressStart, progressUpdate, progressStop, isBusy, safePrint,
  printIncoming, printTable,
  green: (s) => pc.green(s),
  red: (s) => pc.red(s),
  yellow: (s) => pc.yellow(s),
  cyan: (s) => pc.cyan(s),
  bold: (s) => pc.bold(s),
  dim: (s) => pc.dim(s),
};
