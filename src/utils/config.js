'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  database_path: './data/database.sqlite',
  session_path: './data/sessions',
  log_path: './logs',
  message_storage: './data/messages',
  media_storage: './data/media',
  backup_path: './data/backups',
  export_path: './data/exports',

  default_country_code: '62',
  name_fallback: '',

  min_delay: 6,
  max_delay: 15,
  messages_per_session: 50,
  cooldown_hours: 24,
  max_retry: 3,

  archive_after_send: true,
  verify_recipients: true,
  save_incoming_messages: true,
  media_archive: true,

  log_retention_days: 30,
};

const NUMERIC_KEYS = [
  'min_delay', 'max_delay', 'messages_per_session', 'cooldown_hours',
  'max_retry', 'log_retention_days',
];

const ENV_MAP = {
  DATABASE_PATH: 'database_path',
  SESSION_PATH: 'session_path',
  LOG_PATH: 'log_path',
  MESSAGE_STORAGE: 'message_storage',
  MEDIA_STORAGE: 'media_storage',
  BACKUP_PATH: 'backup_path',
  EXPORT_PATH: 'export_path',
  CLOUD_WA_DEFAULT_CC: 'default_country_code',
  CLOUD_WA_NAME_FALLBACK: 'name_fallback',
  CLOUD_WA_MIN_DELAY: 'min_delay',
  CLOUD_WA_MAX_DELAY: 'max_delay',
  CLOUD_WA_MESSAGES_PER_SESSION: 'messages_per_session',
  CLOUD_WA_COOLDOWN_HOURS: 'cooldown_hours',
  CLOUD_WA_MAX_RETRY: 'max_retry',
  CLOUD_WA_LOG_RETENTION_DAYS: 'log_retention_days',
};

function loadDotenv(root) {
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return;
  // Minimal .env parser (KEY=VALUE, # comments, quoted values supported).
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function castValue(key, value) {
  if (NUMERIC_KEYS.includes(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : DEFAULTS[key];
  }
  if (['archive_after_send', 'verify_recipients', 'save_incoming_messages', 'media_archive'].includes(key)) {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  }
  return value;
}

function configPath(root) {
  return path.join(root, 'config', 'config.json');
}

function exampleConfigPath(root) {
  return path.join(root, 'config', 'config.example.json');
}

/** Ensure config/config.json exists (created from example on first run). */
function ensureConfigFile(root) {
  const cfg = configPath(root);
  if (!fs.existsSync(cfg)) {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const ex = exampleConfigPath(root);
    if (fs.existsSync(ex)) fs.copyFileSync(ex, cfg);
    else fs.writeFileSync(cfg, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }
  return cfg;
}

function loadConfig(root) {
  loadDotenv(root);
  ensureConfigFile(root);
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
  } catch (e) {
    throw new Error('config/config.json is not valid JSON: ' + e.message);
  }
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(fileCfg)) cfg[k] = castValue(k, fileCfg[k]);
  for (const [env, key] of Object.entries(ENV_MAP)) {
    const v = process.env[env];
    if (v !== undefined && v !== '') cfg[key] = castValue(key, v);
  }
  for (const k of NUMERIC_KEYS) if (!Number.isFinite(Number(cfg[k]))) cfg[k] = DEFAULTS[k];
  if (Number(cfg.max_delay) < Number(cfg.min_delay)) cfg.max_delay = cfg.min_delay;
  return cfg;
}

function saveConfig(root, cfg) {
  ensureConfigFile(root);
  const out = { ...cfg };
  fs.writeFileSync(configPath(root), JSON.stringify(out, null, 2) + '\n');
  return out;
}

module.exports = { DEFAULTS, loadConfig, saveConfig, ensureConfigFile, configPath };
