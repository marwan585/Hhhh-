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

/* Test seam (unit tests only - production always uses the real library).
 * Lets tests inject a stub Baileys so pairing logic can be verified without
 * touching the real WhatsApp network. */
let baileysLib = baileys;

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
    this._pairPending = null;   // pairing armed for the CURRENT socket
    this._pairTimer = null;     // fallback timer if no QR event arrives
    this._waVersion = null;     // cached WA Web version from the server
    // Tunables (unit tests shorten these to keep the suite fast)
    this._pairReadyFallbackMs = 8000;    // request pairing even without QR after this
    this._pairRequestDelays = [0, 5000, 10000];
    this._pairRequestTimeoutMs = 20000;
    this._pairRetryDelay = 2000;         // delay before a clean pairing restart
    this._pairMaxRetries = 2;
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
    this._pairPending = null;
    this._pairCtx = { phone: phone ? String(phone).replace(/\D/g, '') : null, onPairingCode, onStatus };
    return new Promise((resolve, reject) => {
      this._resolveOpen = resolve;
      this._rejectOpen = reject;
      this._start();
    });
  }

  /** Fetch the current WhatsApp Web version from the server (cached). */
  async _fetchVersion() {
    if (this._waVersion) return this._waVersion;
    try {
      const res = await baileysLib.fetchLatestBaileysVersion();
      if (res && Array.isArray(res.version)) {
        this._waVersion = res.version;
        this.logger.debug(`Using WhatsApp Web version ${res.version.join('.')}`);
      }
    } catch (e) {
      this.logger.debug(`Could not fetch latest WA version (using library default): ${e.message}`);
    }
    return this._waVersion;
  }

  _clearPairTimer() {
    if (this._pairTimer) { clearTimeout(this._pairTimer); this._pairTimer = null; }
  }

  /** Request the pairing code for the CURRENT socket (readiness gate passed). */
  _armPairingRequest() {
    const ctx = this._pairCtx || {};
    if (!ctx.phone || !this._pairPending) return;
    const sock = this.sock;
    this._clearPairTimer();
    this._pairPending.requested = true;
    this._requestPairing(ctx.phone, ctx.onPairingCode, sock).catch((e) => {
      // Only fail the connect promise if this socket is still the current one;
      // a stale socket's rejection must not kill a newer pairing attempt.
      if (this.sock === sock && this._wantConnection) {
        this._failOpen(new Error(`Pairing failed: ${e.message}`));
      }
    });
  }

  async _start() {
    fs.mkdirSync(this.paths.sessions, { recursive: true });
    const ctx = this._pairCtx || {};
    const logger = pino({ level: 'silent' });
    try {
      const version = await this._fetchVersion();
      const { state, saveCreds } = await baileysLib.useMultiFileAuthState(this.paths.sessions);
      const registered = !!state.creds.registered;
      const socketOpts = {
        auth: {
          creds: state.creds,
          keys: baileysLib.makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        printQRInTerminal: false,
        version: version || undefined,
        browser: baileysLib.Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      };
      const sock = baileysLib.makeWASocket(socketOpts);
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
        // Do NOT request the pairing code immediately: the socket has not
        // finished its handshake yet and an early request is rejected with
        // "Connection Closed"/401. Wait for the first QR event (proof the
        // handshake completed); fall back to a timer if no QR arrives.
        this._pairPending = { requested: false };
        this._pairTimer = setTimeout(() => {
          if (this._pairPending && !this._pairPending.requested) {
            this.logger.debug('No QR event - requesting pairing code via fallback timer');
            this._armPairingRequest();
          }
        }, this._pairReadyFallbackMs);
      } else if (!registered && !ctx.phone) {
        this._failOpen(new Error('NO_SESSION'));
      }
    } catch (e) {
      this._failOpen(new Error(`Cannot start WhatsApp socket: ${e.message}`));
    }
  }

  async _requestPairing(phoneDigits, onPairingCode, sock) {
    const delays = this._pairRequestDelays;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
      // If the socket was replaced/died while waiting, stop hammering it -
      // the close handler owns reconnection from here.
      if (!this._wantConnection || !this.sock || this.sock !== sock) {
        throw new Error('pairing socket changed');
      }
      try {
        const raw = await Promise.race([
          sock.requestPairingCode(phoneDigits),
          new Promise((_, rej) => {
            const t = setTimeout(() => rej(new Error('pairing request timed out')), this._pairRequestTimeoutMs);
            if (t.unref) t.unref();
          }),
        ]);
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

    // The first QR event proves the socket handshake with WhatsApp servers
    // is complete - this is the safe moment to request a pairing code.
    if (u && u.qr && this._pairPending && !this._pairPending.requested) {
      this.logger.debug('Handshake ready (QR received) - requesting pairing code');
      this._armPairingRequest();
    }

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
    const D = baileysLib.DisconnectReason || {};
    this._clearPairTimer();
    this.logger.info(`WhatsApp connection closed (code ${code === undefined ? 'unknown' : code})`);
    this.setState(STATE.DISCONNECTED);

    // Fresh pairing rejected (there is NO session yet - "logged out" is
    // misleading here). Clean the partial session files and retry with a
    // brand-new socket instead of claiming the session expired.
    if (!registered && (code === D.loggedOut || code === 401 || code === 403)) {
      if (this._wantConnection && this._autoRetries < this._pairMaxRetries) {
        this._autoRetries += 1;
        this.logger.warn(`Pairing attempt ${this._autoRetries}/${this._pairMaxRetries} failed (code ${code}) - restarting with a clean session...`);
        this.emit('pairing_retry', this._autoRetries);
        if (this._pairCtx && this._pairCtx.onStatus) this._pairCtx.onStatus(STATE.PAIRING, this._autoRetries);
        this._clearSessionFiles();
        setTimeout(() => {
          if (this._wantConnection) this._start();
        }, this._pairRetryDelay);
        return;
      }
      this._wantConnection = false;
      this.logger.error('Pairing failed repeatedly. Check your internet connection, make sure the number is active on WhatsApp, then try again.');
      this._failOpen(new Error('PAIRING_FAILED'));
      return;
    }

    // Session dead: logged out from phone / forbidden (a REAL session existed).
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
    this._clearPairTimer();
    this._pairPending = null;
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

module.exports = { WhatsAppConnection, STATE, downloadContentFromMessage, __setBaileysLib: (lib) => { baileysLib = lib; } };
