'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now, stamp } = require('../utils/datetime');

/* ---------------------------------------------------------------------------
 * Backup & restore (spec section 20).
 *
 * Backups contain: database (campaigns, contacts, message history) and
 * configuration. Session credentials are NEVER included unless the user
 * explicitly asks for an encrypted session backup (--include-session with a
 * password; AES-256-GCM + scrypt key derivation via node:crypto).
 * ------------------------------------------------------------------------- */

const APP_VERSION = '1.0.0';

function listBackups(paths) {
  try {
    return fs.readdirSync(paths.backups)
      .filter((d) => d.startsWith('backup-'))
      .filter((d) => fs.existsSync(path.join(paths.backups, d, 'manifest.json')))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
}

function readManifest(paths, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.backups, name, 'manifest.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function createBackup({ db, paths, root, configObj, logger, includeSession = false, password = null }) {
  db.flushNow();
  const name = `backup-${stamp()}`;
  const dir = path.join(paths.backups, name);
  fs.mkdirSync(dir, { recursive: true });

  // 1. Database (campaigns, contacts, message history, queue, media index)
  fs.copyFileSync(paths.database, path.join(dir, 'database.sqlite'));

  // 2. Configuration (config/config.json - contains no secrets)
  try {
    const cfgFile = path.join(root, 'config', 'config.json');
    if (fs.existsSync(cfgFile)) fs.copyFileSync(cfgFile, path.join(dir, 'config.json'));
  } catch (_) { /* non-fatal */ }

  // 3. Manifest
  const manifest = {
    app: 'CLOUD WA TOOLS',
    version: APP_VERSION,
    created_at: now(),
    includes_session: !!(includeSession && password),
    counts: {
      contacts: db.scalar('SELECT COUNT(*) FROM contacts') || 0,
      campaigns: db.scalar('SELECT COUNT(*) FROM campaigns') || 0,
      messages: db.scalar('SELECT COUNT(*) FROM messages') || 0,
      media: db.scalar('SELECT COUNT(*) FROM media') || 0,
    },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // 4. OPTIONAL explicit encrypted session backup
  let sessionArchive = null;
  if (includeSession && password) {
    sessionArchive = encryptSessionDir(paths.sessions, password, path.join(dir, 'sessions.enc'));
  } else if (includeSession && !password) {
    throw new Error('Encrypted session backup requires a password (--password)');
  }

  if (logger) logger.success(`Backup created: ${dir}`);
  return { dir, name, manifest, sessionArchive };
}

/** Restore the database from a backup folder (db is closed and reopened by caller). */
function restoreBackup({ db, paths, backupName }) {
  const dir = path.isAbsolute(backupName)
    ? backupName
    : path.join(paths.backups, backupName);
  const src = path.join(dir, 'database.sqlite');
  if (!fs.existsSync(src)) throw new Error(`Backup database not found: ${src}`);
  const manifest = fs.existsSync(path.join(dir, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    : null;
  db.close();
  fs.copyFileSync(src, paths.database);
  return { manifest, dir };
}

function decryptSessionBackup({ encFile, password, outDir }) {
  const raw = JSON.parse(fs.readFileSync(encFile, 'utf8'));
  if (raw.v !== 1) throw new Error('Unsupported session backup format');
  const salt = Buffer.from(raw.salt, 'base64');
  const iv = Buffer.from(raw.iv, 'base64');
  const tag = Buffer.from(raw.tag, 'base64');
  const data = Buffer.from(raw.data, 'base64');
  const key = crypto.scryptSync(String(password), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const files = JSON.parse(plain.toString('utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const p = path.join(outDir, f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(f.b64, 'base64'));
  }
  return files.length;
}

function encryptSessionDir(sessionsDir, password, outFile) {
  const files = [];
  try {
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        const p = path.join(sessionsDir, entry.name);
        files.push({ name: entry.name, b64: fs.readFileSync(p).toString('base64') });
      } else if (entry.isDirectory()) {
        for (const sub of fs.readdirSync(path.join(sessionsDir, entry.name), { withFileTypes: true })) {
          if (sub.isFile()) {
            const p = path.join(sessionsDir, entry.name, sub.name);
            files.push({ name: path.join(entry.name, sub.name), b64: fs.readFileSync(p).toString('base64') });
          }
        }
      }
    }
  } catch (_) { /* empty session dir */ }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = cipher.update(Buffer.from(JSON.stringify(files), 'utf8'));
  const encrypted = Buffer.concat([data, cipher.final()]);
  const out = {
    v: 1,
    created_at: now(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  return outFile;
}

module.exports = { listBackups, readManifest, createBackup, restoreBackup, encryptSessionDir, decryptSessionBackup };
