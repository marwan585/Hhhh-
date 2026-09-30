'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  downloadContentFromMessage,
} = baileys;
const pino = require('pino');
const { now } = require('../utils/datetime');

/* ---------------------------------------------------------------------------
 * WhatsApp connection built on Baileys (WhatsApp Web Multi-Device protocol).
 *
 * REAL mechanisms only:
 * - Pairing code comes from sock.requestPairingCode() (the same mechanism
 *   WhatsApp Web uses for "Link with phone number") - never fabricated.
 * - Sessions are stored/loaded with useMultiFileAuthState (the library's own
 *   credential store) under data/sessions/ - restored on every restart.
 * - Sending uses sock.sendMessage(); the returned key.id is the REAL
 *   WhatsApp message id, persisted for delivery-status tracking.
 * - Delivery/read receipts arrive via the 'messages.update' event.
 *
 * This is an UNOFFICIAL integration: see README "Batasan & Risiko".
 * ------------------------------------------------------------------------- */

const STATE = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  PAIRING: 'PAIRING',
  CONNECTED: 'CONNECTED',
};

const ACK_STATUS = { 2: 'SENT', 3: 'DELIVERED', 4: 'READ', 5: 'READ' };

class WhatsAppConnection extends EventEmitter {
  constructor({ paths, config, logger, db }) {
    super();
    this.paths = paths;
    this.config = config;
    this.logger = logger;
    this.db = db;
    this.sock = null;
    this.state = STATE.DISCONNECTED;
    this.number = null;
    this._wantConnection = false;
    this._autoRetries = 0;
    this._pairCtx = null;
    this._resolveOpen = null;
    this._rejectOpen = null;
  }

  setState(s) {
    if (this.state !== s) {
      this.state = s;
      this.emit('state', s);
    }
  }

  hasSession() {
    try {
      return fs.existsSync(path.join(this.paths.sessions, 'creds.json'));
    } catch (_) {
      return false;
    }
  }

  /** Own number from the stored session credentials (never displays keys). */
  sessionNumber() {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(this.paths.sessions, 'creds.json'), 'utf8'));
      const id = (creds.me && creds.me.id) || '';
      const num = String(id).split(':')[0].split('@')[0];
      return /^\d+$/.test(num) ? num : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Connect. Resolves on first successful open. Auto-reconnects on transient
   * drops; rejects on fatal problems (session expired / replaced / gave up).
   * `phone` (digits) is required only when pairing a brand-new session.
   */
  connect({ phone, onPairingCode, onStatus } = {}) {
    this._wantConnection = true;
    this._autoRetries = 0;
    this._pairCtx = { phone: phone ? String(phone).replace(/\D/g, '') : null, onPairingCode, onStatus };
    return new Promise((resolve, reject) => {
      this._resolveOpen = resolve;
      this._rejectOpen = reject;
      this._start();
    });
  }

  _start() {
    fs.mkdirSync(this.paths.sessions, { recursive: true });
    const ctx = this._pairCtx || {};
    const logger = pino({ level: 'silent' });
    useMultiFileAuthState(this.paths.sessions)
      .then(({ state, saveCreds }) => {
        const registered = !!state.creds.registered;
        const socketOpts = {
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
          },
          logger,
          printQRInTerminal: false,
          browser: Browsers.ubuntu('Chrome'),
          markOnlineOnConnect: false,
          syncFullHistory: false,
          generateHighQualityLinkPreview: false,
        };
        const sock = makeWASocket(socketOpts);
        this.sock = sock;
        // Let the app attach event handlers (incoming messages, media) to
        // every socket instance - including after automatic reconnects.
        if (typeof this.onSocket === 'function') {
          try { this.onSocket(sock); } catch (e) { this.logger.error(`onSocket hook error: ${e.message}`); }
        }
        this.setState(registered ? STATE.CONNECTING : STATE.PAIRING);
        if (ctx.onStatus) ctx.onStatus(this.state);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (u) => {
          this._onConnectionUpdate(u, { registered });
        });

        sock.ev.on('messages.update', (updates) => {
          this._onMessagesUpdate(updates);
        });

        if (!registered && ctx.phone) {
          this._requestPairing(ctx.phone, ctx.onPairingCode).catch((e) => {
            this._failOpen(new Error(`Pairing failed: ${e.message}`));
          });
        } else if (!registered && !ctx.phone) {
          this._failOpen(new Error('NO_SESSION'));
        }
      })
      .catch((e) => this._failOpen(new Error(`Cannot start WhatsApp socket: ${e.message}`)));
  }

  async _requestPairing(phoneDigits, onPairingCode) {
    const delays = [0, 3000, 6000];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
      if (!this.sock || !this._wantConnection) throw new Error('connection cancelled');
      try {
        const raw = await this.sock.requestPairingCode(phoneDigits);
        const code = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (!code) throw new Error('empty pairing code');
        const formatted = code.slice(0, 4) + '-' + code.slice(4, 8);
        this.logger.info(`Pairing code generated for +${phoneDigits}`);
        if (onPairingCode) onPairingCode(formatted);
        this.emit('pairing_code', formatted);
        return formatted;
      } catch (e) {
        if (i === delays.length - 1) throw e;
        this.logger.debug(`Pairing code request retry ${i + 1}: ${e.message}`);
      }
    }
    throw new Error('pairing code could not be requested');
  }

  _onConnectionUpdate(u, { registered }) {
    const { connection, lastDisconnect } = u || {};

    if (connection === 'open') {
      this._autoRetries = 0;
      this.setState(STATE.CONNECTED);
      const jid = (this.sock && this.sock.user && this.sock.user.id) || '';
      const num = String(jid).split(':')[0].split('@')[0];
      if (/^\d+$/.test(num)) this.number = num;
      this.logger.success(`WhatsApp connected${this.number ? ': +' + this.number : ''}`);
      if (this._resolveOpen) {
        const r = this._resolveOpen;
        this._resolveOpen = null;
        this._rejectOpen = null;
        r({ number: this.number });
      }
      this.emit('open', { number: this.number });
      return;
    }

    if (connection === 'close') {
      const code =
        (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode) ??
        (lastDisconnect && lastDisconnect.error && lastDisconnect.error.error && lastDisconnect.error.error.output && lastDisconnect.error.error.output.statusCode);
      this._onClose(code, registered);
    }
  }

  _onClose(code, registered) {
    const D = DisconnectReason || {};
    this.logger.info(`WhatsApp connection closed (code ${code === undefined ? 'unknown' : code})`);
    this.setState(STATE.DISCONNECTED);

    // Session dead: logged out from phone / forbidden.
    if (code === D.loggedOut || code === 401 || code === 403) {
      this._wantConnection = false;
      this.logger.error('WhatsApp session expired or was logged out from the phone. Delete the session and pair again.');
      this.emit('session_expired');
      this._failOpen(new Error('SESSION_EXPIRED'));
      return;
    }
    // Another session took over.
    if (code === D.connectionReplaced || code === 440) {
      this._wantConnection = false;
      this.logger.error('Connection replaced by another linked session.');
      this.emit('connection_replaced');
      this._failOpen(new Error('CONNECTION_REPLACED'));
      return;
    }
    // restartRequired (515) right after pairing is NORMAL - reconnect.
    const transient = code === 515 || code === 428 || code === 408 || code === 411 ||
      code === D.restartRequired || code === D.connectionClosed || code === D.connectionLost || code === D.timedOut ||
      code === undefined;
    if (transient && this._wantConnection && this._autoRetries < 8) {
      this._autoRetries += 1;
      const delay = Math.min(30000, 2000 * this._autoRetries);
      this.logger.info(`Reconnecting... (attempt ${this._autoRetries}/8 in ${Math.round(delay / 1000)}s)`);
      if (this._pairCtx && this._pairCtx.onStatus) this._pairCtx.onStatus(STATE.CONNECTING, this._autoRetries);
      this.emit('reconnecting', this._autoRetries, delay);
      setTimeout(() => {
        if (this._wantConnection) this._start();
      }, delay);
      return;
    }

    this._wantConnection = false;
    this.emit('disconnected', code);
    this._failOpen(new Error('CONNECTION_FAILED'));
  }

  _failOpen(err) {
    if (this._rejectOpen) {
      const r = this._rejectOpen;
      this._resolveOpen = null;
      this._rejectOpen = null;
      r(err);
    }
  }

  _onMessagesUpdate(updates) {
    if (!Array.isArray(updates) || !this.db) return;
    for (const u of updates) {
      try {
        const mid = u && u.key && u.key.id;
        const st = u && u.update && u.update.status;
        const mapped = ACK_STATUS[st];
        if (!mid || !mapped) continue;
        this.db.run(
          "UPDATE messages SET status = ?, updated_at = ? WHERE message_id = ? AND direction = 'out' AND status != 'READ'",
          [mapped, now(), mid]
        );
      } catch (_) { /* receipt bookkeeping must never throw */ }
    }
  }

  _requireConnected() {
    if (!this.sock || this.state !== STATE.CONNECTED) {
      throw new Error('WhatsApp is not connected');
    }
  }

  /** Send a text message. Returns { messageId } - a REAL WhatsApp message id. */
  async sendText(phone, text) {
    this._requireConnected();
    const jid = `${phone}@s.whatsapp.net`;
    const res = await this.sock.sendMessage(jid, { text });
    return { messageId: (res && res.key && res.key.id) || '', jid };
  }

  /**
   * Real number-registered check via WhatsApp. Returns:
   *   true  - registered
   *   false - not registered on WhatsApp
   *   null  - could not check (network/API error)
   */
  async verifyNumber(phone) {
    this._requireConnected();
    try {
      const res = await this.sock.onWhatsApp(`${phone}@s.whatsapp.net`);
      return !!(res && res[0] && res[0].exists);
    } catch (e) {
      this.logger.debug(`verifyNumber failed for +${phone}: ${e.message}`);
      return null;
    }
  }

  /** Archive a conversation (Cloud Save). Uses the official chatModify API. */
  async archiveChat(phone) {
    this._requireConnected();
    const jid = `${phone}@s.whatsapp.net`;
    await this.sock.chatModify({ archive: true }, jid);
  }

  /** Gracefully end the current socket (saved session stays on disk). */
  end() {
    this._wantConnection = false;
    try {
      if (this.sock) this.sock.end(new Error('client closed'));
    } catch (_) { /* ignore */ }
    this.sock = null;
    this.setState(STATE.DISCONNECTED);
  }

  /** Log out from WhatsApp AND delete the stored session files. */
  async logoutAndClear() {
    try {
      if (this.sock && this.state === STATE.CONNECTED) await this.sock.logout();
    } catch (_) { /* ignore */ }
    this.end();
    this._clearSessionFiles();
  }

  /** Delete session files without logging out (used after SESSION_EXPIRED). */
  _clearSessionFiles() {
    try {
      fs.rmSync(this.paths.sessions, { recursive: true, force: true });
      fs.mkdirSync(this.paths.sessions, { recursive: true });
      this.logger.info('Session files deleted');
      this.number = null;
    } catch (e) {
      this.logger.error(`Could not delete session files: ${e.message}`);
    }
  }

  deleteSessionFiles() {
    this._clearSessionFiles();
  }
}

module.exports = { WhatsAppConnection, STATE, downloadContentFromMessage };
