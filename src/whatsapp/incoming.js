'use strict';
const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('./connection');
const contacts = require('../contacts/contacts');
const { now } = require('../utils/datetime');

/* ---------------------------------------------------------------------------
 * Incoming message handler (spec sections 12 & 14).
 *
 * - Shows incoming messages in the terminal when the UI is idle.
 * - STOP / UNSUBSCRIBE / BERHENTI keywords process an immediate opt-out and
 *   add the number to the Do Not Contact list.
 * - Incoming messages are stored to history when save_incoming_messages is on.
 * - Incoming media is archived (Cloud Master) when media_archive is on.
 * ------------------------------------------------------------------------- */

const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'BERHENTI']);

function extractText(m) {
  const M = m.message;
  if (!M) return '';
  return (
    M.conversation ||
    (M.extendedTextMessage && M.extendedTextMessage.text) ||
    (M.imageMessage && M.imageMessage.caption) ||
    (M.videoMessage && M.videoMessage.caption) ||
    (M.documentMessage && M.documentMessage.caption) ||
    (M.buttonsResponseMessage && M.buttonsResponseMessage.selectedDisplayText) ||
    (M.listResponseMessage && M.listResponseMessage.title) ||
    ''
  );
}

function jidToPhone(jid, key) {
  if (!jid) return null;
  if (jid.endsWith('@s.whatsapp.net')) {
    const p = jid.split('@')[0].split(':')[0];
    return /^\d+$/.test(p) ? p : null;
  }
  if (jid.endsWith('@lid')) {
    const pn = (key && (key.participantPn || key.participant)) || '';
    if (pn.endsWith('@s.whatsapp.net')) {
      const p = pn.split('@')[0].split(':')[0];
      return /^\d+$/.test(p) ? p : null;
    }
    return null;
  }
  return null; // group chats and other JID types are ignored
}

function mediaKind(m) {
  if (m.message.imageMessage) return { field: 'imageMessage', type: 'image' };
  if (m.message.videoMessage) return { field: 'videoMessage', type: 'video' };
  if (m.message.audioMessage) return { field: 'audioMessage', type: 'audio' };
  if (m.message.documentMessage) return { field: 'documentMessage', type: 'document' };
  if (m.message.stickerMessage) return { field: 'stickerMessage', type: 'sticker' };
  return null;
}

function mimeExt(mt) {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
  };
  const base = String(mt || '').split(';')[0].trim().toLowerCase();
  if (map[base]) return map[base];
  const sub = base.split('/')[1];
  return (sub || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
}

async function downloadBuffer(mediaObj, type) {
  const stream = downloadContentFromMessage(mediaObj, type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function attachIncoming({ sock, db, config, paths, logger, ui }) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !Array.isArray(messages)) return;
    for (const m of messages) {
      try {
        await handleOne(m);
      } catch (e) {
        logger.error(`Incoming handler error: ${e.message || e}`);
      }
    }
  });

  async function handleOne(m) {
    if (!m || !m.key || m.key.fromMe) return;
    const jid = m.key.remoteJid || '';
    const phone = jidToPhone(jid, m.key);
    if (!phone) return;
    const display = '+' + phone;
    const text = extractText(m);
    const kind = mediaKind(m);

    /* ---- Cloud Master media archive ------------------------------------ */
    if (config.media_archive && kind) {
      try {
        const buf = await downloadBuffer(m.message[kind.field], kind.type === 'sticker' ? 'image' : kind.type);
        if (buf && buf.length) {
          fs.mkdirSync(paths.media, { recursive: true });
          const fname = `${Date.now()}_${phone}.${mimeExt(kind.field === 'documentMessage' ? m.message.documentMessage.mimetype : m.message[kind.field].mimetype)}`;
          fs.writeFileSync(path.join(paths.media, fname), buf);
          db.run(
            'INSERT INTO media (phone, file, mimetype, size, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [phone, fname, (m.message[kind.field] && m.message[kind.field].mimetype) || '', buf.length, m.key.id || '', now()]
          );
          db.run(
            "INSERT INTO messages (direction, phone, name, body, status, media_file, created_at) VALUES ('in', ?, ?, ?, 'RECEIVED', ?, ?)",
            [phone, m.pushName || '', `[media:${kind.type}] ${(m.message[kind.field] && m.message[kind.field].caption) || ''}`, fname, now()]
          );
          logger.info(`Incoming media archived: ${fname} (${buf.length} bytes)`);
        }
      } catch (e) {
        logger.warn(`Could not archive incoming media: ${e.message || e}`);
      }
    }

    /* ---- history -------------------------------------------------------- */
    if (config.save_incoming_messages && text) {
      db.run(
        "INSERT INTO messages (direction, phone, name, body, status, created_at) VALUES ('in', ?, ?, ?, 'RECEIVED', ?)",
        [phone, m.pushName || '', text, now()]
      );
    }

    /* ---- opt-out keywords ----------------------------------------------- */
    const norm = String(text || '').trim().toUpperCase();
    const first = norm.replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)[0] || '';
    if (STOP_WORDS.has(norm) || STOP_WORDS.has(first)) {
      contacts.optOutContact(db, phone, 'opt-out keyword');
      logger.success(`Recipient added to Do Not Contact: ${display}`);
      ui.safePrint(ui.green(`✓ Recipient added to Do Not Contact: ${display}`));
      return;
    }

    if (text || kind) {
      logger.debug(`Incoming message from ${display}`);
      ui.printIncoming(display, text || `[${kind ? kind.type : 'media'}]`);
    }
  }
}

module.exports = { attachIncoming, extractText, jidToPhone, STOP_WORDS };
