'use strict';

/**
 * Render a campaign message template.
 * Supported variables: {{name}} and {{phone}} (case-insensitive, spaces in
 * braces allowed). When the recipient has no name, `nameFallback` (from
 * config) is used, or the phone number as a last resort.
 */
function renderTemplate(text, vars = {}) {
  if (typeof text !== 'string') return '';
  const phone = vars.phone !== null && vars.phone !== undefined ? String(vars.phone) : '';
  let name;
  if (vars.name && String(vars.name).trim()) name = String(vars.name).trim();
  else if (vars.nameFallback && String(vars.nameFallback).trim()) name = String(vars.nameFallback).trim();
  else name = phone;
  return text
    .replace(/\{\{\s*name\s*\}\}/gi, name)
    .replace(/\{\{\s*phone\s*\}\}/gi, phone);
}

module.exports = { renderTemplate };
