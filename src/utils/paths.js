'use strict';
const fs = require('fs');
const path = require('path');

/** Walk up from a directory until a folder containing package.json is found. */
function findRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

const ROOT = process.env.CLOUD_WA_ROOT || findRoot(__dirname);

function resolveRel(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/** Build the concrete absolute path map from a loaded config object. */
function buildPaths(config) {
  return {
    root: ROOT,
    data: resolveRel('./data'),
    database: resolveRel(config.database_path),
    sessions: resolveRel(config.session_path),
    logs: resolveRel(config.log_path),
    messages: resolveRel(config.message_storage),
    media: resolveRel(config.media_storage),
    backups: resolveRel(config.backup_path),
    exports: resolveRel(config.export_path),
    config: path.join(ROOT, 'config', 'config.json'),
  };
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function ensureAll(paths) {
  for (const key of ['data', 'sessions', 'logs', 'messages', 'media', 'backups', 'exports']) {
    if (paths[key]) ensureDir(paths[key]);
  }
}

module.exports = { ROOT, findRoot, buildPaths, ensureDir, ensureAll };
