'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local timestamp 'YYYY-MM-DD HH:mm:ss' - the format used across logs & DB. */
function now(d) {
  const t = d || new Date();
  return (
    t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) +
    ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds())
  );
}

/** Local date 'YYYY-MM-DD'. */
function today(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

/** 'YYYY-MM-DD HH:mm:ss' for (now - hours). */
function hoursAgo(hours) {
  return now(new Date(Date.now() - Number(hours || 0) * 3600000));
}

/** 'YYYY-MM-DD HH:mm:ss' for (now - days). */
function daysAgo(days) {
  return now(new Date(Date.now() - Number(days || 0) * 86400000));
}

/** Compact stamp 'YYYYMMDDHHMMSS' for backup folder names. */
function stamp() {
  return now().replace(/[-: ]/g, '');
}

module.exports = { now, today, hoursAgo, daysAgo, stamp };
