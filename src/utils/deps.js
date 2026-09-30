'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Environment / dependency check (spec section 21).
 * Never fails silently: every check produces a visible line with a fix hint.
 */
async function checkEnvironment({ paths } = {}) {
  const checks = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js',
    ok: nodeMajor >= 18,
    ideal: nodeMajor >= 20,
    detail: process.version,
    hint: nodeMajor < 18 ? 'Please install Node.js 20 or newer first.' : null,
  });

  let npmOk = false;
  let npmDetail = 'not found';
  try {
    const r = spawnSync('npm', ['-v'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status === 0 && r.stdout) { npmOk = true; npmDetail = 'npm ' + String(r.stdout).trim(); }
  } catch (_) { /* leave as not found */ }
  checks.push({
    name: 'npm',
    ok: npmOk,
    ideal: true,
    detail: npmDetail,
    hint: npmOk ? null : 'Please install Node.js first (npm is bundled with it).',
  });

  const packages = ['sql.js', '@whiskeysockets/baileys', 'picocolors', 'pino', 'xlsx', 'dotenv'];
  for (const pkg of packages) {
    let ok = false;
    let detail = 'missing';
    try {
      const resolved = require.resolve(pkg);
      ok = true;
      detail = 'installed';
      void resolved;
    } catch (_) { /* missing */ }
    checks.push({
      name: pkg,
      ok,
      ideal: ok,
      detail,
      hint: ok ? null : 'Run: npm install',
    });
  }

  const sqliteCheck = { name: 'SQLite (sql.js WASM)', ok: false, ideal: true, detail: 'not loaded', hint: 'Run: npm install' };
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const c = new SQL.Database();
    c.exec('SELECT 1');
    c.close();
    sqliteCheck.ok = true;
    sqliteCheck.detail = 'working';
  } catch (e) {
    sqliteCheck.detail = e.message;
  }
  checks.push(sqliteCheck);

  if (paths && paths.data) {
    let writable = false;
    try {
      fs.mkdirSync(paths.data, { recursive: true });
      const probe = path.join(paths.data, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      writable = true;
    } catch (_) { /* not writable */ }
    checks.push({
      name: 'Data directory writable',
      ok: writable,
      ideal: writable,
      detail: paths.data,
      hint: writable ? null : 'Check filesystem permissions for the data/ directory.',
    });
  }

  return checks;
}

function printChecks(checks, { quiet = false } = {}) {
  const pc = require('picocolors');
  if (!quiet) console.log('Checking environment...');
  let hardFail = false;
  for (const c of checks) {
    const mark = c.ok ? pc.green('✓') : pc.red('✗');
    let line = ` ${mark} ${c.name}`;
    if (c.detail) line += ` (${c.detail})`;
    console.log(line);
    if (!c.ok) {
      hardFail = true;
      if (c.hint) console.log(pc.red(`   ${c.hint}`));
    } else if (!c.ideal && c.hint) {
      console.log(pc.yellow(`   ${c.hint}`));
    }
  }
  if (!hardFail) {
    if (!quiet) console.log(pc.green('Environment ready.'));
    return true;
  }
  console.log(pc.red('Environment is NOT ready. Fix the items marked with ✗ above.'));
  return false;
}

module.exports = { checkEnvironment, printChecks };
