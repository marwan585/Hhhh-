'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let sqlPromise = null;
function loadSQL() {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise;
}

/**
 * SQLite database backed by sql.js (real SQLite compiled to WebAssembly).
 * - Zero native compilation: installs cleanly on Termux/Linux/Windows.
 * - The on-disk file is a standard SQLite database (readable by sqlite3 CLI).
 * - Writes are persisted with a short debounce plus explicit flushNow()
 *   at every critical point (queue mutations, send results, status changes)
 *   so a crash cannot lose campaign state.
 */
class Database {
  constructor(conn, file) {
    this.conn = conn;
    this.file = file;
    this._dirty = false;
    this._timer = null;
  }

  static async open(file) {
    const SQL = await loadSQL();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let conn;
    if (fs.existsSync(file)) {
      try {
        conn = new SQL.Database(fs.readFileSync(file));
        conn.exec('SELECT count(*) FROM sqlite_master');
      } catch (e) {
        // Corrupt file: keep a copy aside, start fresh - never silently fail.
        try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (_) { /* ignore */ }
        conn = new SQL.Database();
      }
    } else {
      conn = new SQL.Database();
    }
    return new Database(conn, file);
  }

  /** Raw multi-statement SQL (schema bootstrap). */
  exec(sql) {
    this.conn.exec(sql);
    this._markDirty();
  }

  run(sql, params = []) {
    const stmt = this.conn.prepare(sql);
    try {
      stmt.bind(params.map((p) => (p === undefined ? null : p)));
      stmt.step();
    } finally {
      stmt.free();
    }
    const changes = this.conn.getRowsModified();
    const lastId = this.scalar('SELECT last_insert_rowid()');
    this._markDirty();
    return { changes, lastId };
  }

  all(sql, params = []) {
    const stmt = this.conn.prepare(sql);
    const rows = [];
    try {
      stmt.bind(params.map((p) => (p === undefined ? null : p)));
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  get(sql, params = []) {
    return this.all(sql, params)[0];
  }

  scalar(sql, params = []) {
    const r = this.get(sql, params);
    if (!r) return undefined;
    return Object.values(r)[0];
  }

  _markDirty() {
    this._dirty = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flushNow(), 400);
    if (this._timer.unref) this._timer.unref();
  }

  isDirty() {
    return this._dirty;
  }

  /** Synchronously persist to disk (atomic tmp+rename). */
  flushNow() {
    if (!this._dirty) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const data = Buffer.from(this.conn.export());
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }

  close() {
    try { this.flushNow(); } catch (_) { /* best effort */ }
    try { this.conn.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { Database };
