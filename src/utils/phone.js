'use strict';

/**
 * Normalize a phone number into full international digits (no '+').
 *
 * Accepted inputs:
 *   +62 812-3456-789  ->  628123456789
 *   08123456789       ->  628123456789   (leading 0 -> default country code)
 *   8123456789        ->  628123456789   (starts with 8, 9-12 digits)
 *   00 62 812 ...     ->  628123456789   (international prefix 00)
 *
 * For other countries always provide the full international number
 * (with or without '+').
 */
function normalizePhone(raw, defaultCC = '62') {
  if (raw === null || raw === undefined) return { valid: false, reason: 'empty' };
  let s = String(raw).trim();
  if (!s) return { valid: false, reason: 'empty' };

  s = s.replace(/[\s\-().]/g, '');
  let digits = s.startsWith('+') ? s.slice(1) : s;
  if (digits.startsWith('00')) digits = digits.slice(2);
  digits = digits.replace(/\D/g, '');
  if (!digits) return { valid: false, reason: 'no digits' };

  const cc = String(defaultCC || '62').replace(/\D/g, '') || '62';
  if (digits.startsWith('0')) {
    digits = cc + digits.slice(1);
  } else if (digits.startsWith('8') && digits.length >= 9 && digits.length <= 12) {
    digits = cc + digits;
  }
  // numbers already starting with the country code (or any other country
  // provided in international form) are kept as-is

  if (!/^\d+$/.test(digits)) return { valid: false, reason: 'invalid characters' };
  if (digits.length < 10 || digits.length > 15) {
    return { valid: false, reason: 'length must be 10-15 digits (got ' + digits.length + ')' };
  }
  return { valid: true, phone: digits, display: '+' + digits, jid: digits + '@s.whatsapp.net' };
}

/** True when the string looks like a phone number (digit-heavy). */
function isPhoneish(s) {
  const str = String(s || '');
  const d = (str.match(/\d/g) || []).length;
  return d >= 8 && d / Math.max(str.length, 1) > 0.5;
}

module.exports = { normalizePhone, isPhoneish };
