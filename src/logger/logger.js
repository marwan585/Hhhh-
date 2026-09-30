'use strict';
const fs = require('fs');
const path = require('path');
const { now, today } = require('../utils/datetime');

/**
 * File + console logger.
 * File format:  2026-09-30 20:30:01 INFO WhatsApp connecting
 * One file per day: logs/app-YYYY-MM-DD.log
 *
 * `sink` allows the campaign runner to route console output through the
 * progress-bar safe printer while always writing to the log file.
 */
class Logger {
  constructor({ logPath, console: useConsole = true } = {}) {
    this.logPath = logPath;
    this.useConsole = useConsole;
    this.sink = null;
  }

  setSink(fn) {
    this.sink = fn;
  }

  clearSink() {
    this.sink = null;
  }

  fileFor(dateStr) {
    return path.join(this.logPath, `app-${dateStr}.log`);
  }

  currentFile() {
    return this.fileFor(today());
  }

  write(level, msg) {
    const line = `${now()} ${level} ${msg}`;
    if (this.useConsole) {
      const out = this.sink || ((l) => console.log(l));
      out(this.colorize(level, line));
    }
    try {
      fs.mkdirSync(this.logPath, { recursive: true });
      fs.appendFileSync(this.currentFile(), line + '\n');
    } catch (_) { /* logging must never crash the app */ }
  }

  colorize(level, line) {
    const pc = require('picocolors');
    if (!pc.isColorSupported) return line;
    switch (level) {
      case 'ERROR': return pc.red(line);
      case 'WARNING': return pc.yellow(line);
      case 'SUCCESS': return pc.green(line);
      case 'DEBUG': return pc.dim(line);
      default: return pc.cyan(line);
    }
  }

  info(m) { this.write('INFO', m); }
  success(m) { this.write('SUCCESS', m); }
  warn(m) { this.write('WARNING', m); }
  error(m) { this.write('ERROR', m); }
  debug(m) { this.write('DEBUG', m); }

  readFile(file) {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  allFiles() {
    try {
      return fs.readdirSync(this.logPath)
        .filter((f) => f.startsWith('app-') && f.endsWith('.log'))
        .sort();
    } catch (_) {
      return [];
    }
  }

  readToday() {
    return this.readFile(this.currentFile());
  }

  readErrors() {
    const out = [];
    for (const f of this.allFiles()) {
      for (const line of this.readFile(path.join(this.logPath, f))) {
        if (/ (ERROR|WARNING) /.test(line)) out.push(line);
      }
    }
    return out;
  }

  tail(n = 50) {
    const acc = [];
    for (const f of this.allFiles().reverse()) {
      acc.unshift(...this.readFile(path.join(this.logPath, f)));
      if (acc.length > n) break;
    }
    return acc.slice(-n);
  }

  cleanup(days) {
    const cutoff = Date.now() - Number(days || 30) * 86400000;
    let removed = 0;
    for (const f of this.allFiles()) {
      const p = path.join(this.logPath, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
      } catch (_) { /* ignore */ }
    }
    return removed;
  }
}

module.exports = { Logger };
