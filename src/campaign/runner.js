'use strict';
const manager = require('./manager');
const queue = require('../queue/queue');
const contacts = require('../contacts/contacts');
const { renderTemplate } = require('./template');
const { now } = require('../utils/datetime');

/* ---------------------------------------------------------------------------
 * Campaign runner (spec sections 10, 11, 13).
 *
 * - Sends strictly one message at a time through the WhatsApp connection.
 * - Random delay between min..max seconds for every recipient (rate limiting).
 * - Pause / resume / stop are honored within 100 ms via campaign status
 *   polling, so state changes survive even a killed process (persistent DB).
 * - On WhatsApp restriction / rate-limit errors the campaign is
 *   AUTOMATICALLY PAUSED (never bypassed, never retried aggressively).
 * - `wa` is injected (real WhatsAppConnection in production; a clearly
 *   marked TEST STUB in unit tests only).
 * ------------------------------------------------------------------------- */

let activeRunner = null;
function getActiveRunner() {
  return activeRunner;
}

function classifySendError(err) {
  const code = Number(
    (err && err.output && err.output.statusCode) ||
    (err && err.statusCode) ||
    (err && err.code) || 0
  );
  const msg = String((err && err.message) || err || '').toLowerCase();
  if ([401, 403, 429].includes(code)) return 'restriction';
  if (/banned|blocked|restriction|violation|spam|forbidden|too many|rate.?limit/.test(msg)) return 'restriction';
  if (/logged ?out|session/.test(msg)) return 'session';
  return 'generic';
}

class CampaignRunner {
  constructor({ db, wa, config, logger, ui }) {
    this.db = db;
    this.wa = wa;
    this.config = config;
    this.logger = logger;
    this.ui = ui;
    this.campaignId = null;
    this.sessionSent = 0;
    this.aborted = false;
  }

  /** Runs a campaign to completion / pause / stop. One runner at a time. */
  async run(campaignId) {
    if (activeRunner) throw new Error('Another campaign is already running');
    activeRunner = this;
    this.campaignId = Number(campaignId);
    this.sessionSent = 0;
    // Route console logs through the progress-safe printer while running.
    this.logger.setSink((l) => this.ui.safePrint(l));
    this.ui.progressStart();
    try {
      await this._loop();
    } finally {
      this.ui.progressStop();
      this.logger.clearSink();
      activeRunner = null;
      this.db.flushNow();
    }
  }

  _stillRunning() {
    const c = manager.get(this.db, this.campaignId);
    return !!c && c.status === 'running' && !this.aborted;
  }

  sleepInterruptible(ms) {
    return new Promise((resolve) => {
      if (ms <= 0) { resolve(); return; }
      const started = Date.now();
      const timer = setInterval(() => {
        if (!this._stillRunning() || Date.now() - started >= ms) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
      if (timer.unref) timer.unref();
    });
  }

  async _loop() {
    const db = this.db;
    for (;;) {
      if (!this._stillRunning()) break;
      const camp = manager.get(db, this.campaignId);
      if (!camp) break;

      const item = queue.nextPending(db, this.campaignId);
      if (!item) {
        manager.markCompleted(db, this.campaignId);
        this.logger.success(`Campaign completed: ${camp.name}`);
        break;
      }

      /* ---- guard re-check at send time (consent may change mid-campaign) */
      const el = contacts.eligibility(db, item.phone);
      if (!el.eligible) {
        queue.markSkipped(db, item.id, el.reason);
        this.logger.warn(`Skipped: +${item.phone} Reason: ${el.reason}`);
        this._progress(item.phone, `skipped (${el.reason})`);
        continue;
      }
      const rc = queue.runtimeChecks(db, item.phone, this.campaignId, this.config.cooldown_hours, item.id);
      if (!rc.ok) {
        queue.markSkipped(db, item.id, rc.reason);
        this.logger.warn(`Skipped: +${item.phone} Reason: ${rc.reason}`);
        this._progress(item.phone, `skipped (${rc.reason})`);
        continue;
      }

      /* ---- verify the number is registered on WhatsApp ----------------- */
      if (this.config.verify_recipients && typeof this.wa.verifyNumber === 'function') {
        let exists = null;
        try { exists = await this.wa.verifyNumber(item.phone); } catch (_) { exists = null; }
        if (exists === false) {
          queue.markFailed(db, item.id, 'Number is not registered on WhatsApp');
          this.logger.warn(`Failed: +${item.phone} Reason: Number not on WhatsApp`);
          this._progress(item.phone, 'not on WhatsApp');
          continue;
        }
        // exists === null (network error) -> attempt send anyway
      }

      const text = renderTemplate(item.message || camp.message, {
        name: item.name,
        phone: item.phone,
        nameFallback: this.config.name_fallback,
      });

      queue.markSending(db, item.id);
      db.flushNow();

      const outcome = await this._sendWithRetry(item, text, camp);
      if (outcome === 'restricted') {
        // Spec section 11: WhatsApp restriction => campaign automatically
        // pauses. The in-flight message goes back to pending (no data loss).
        queue.markPending(db, item.id);
        manager.pause(db, this.campaignId, 'auto-paused: WhatsApp restriction detected');
        this.logger.warn('WhatsApp restriction detected - campaign automatically paused. Please review recipient consent and messaging activity.');
        break;
      }

      this.sessionSent += 1;
      const perSession = Number(this.config.messages_per_session || 0);
      if (perSession > 0 && this.sessionSent >= perSession) {
        manager.pause(db, this.campaignId, `session limit reached (${perSession} messages) - let the account cool down, then resume`);
        this.logger.warn(`Messages per session limit reached (${perSession}) - campaign paused. Resume later from the Campaign menu.`);
        break;
      }

      this._progress(item.phone, outcome === 'sent' ? '✓ sent' : '✗ failed');
      const min = Math.max(0, Number(camp.delay_min) || 0);
      const max = Math.max(min, Number(camp.delay_max) || 0);
      const delayMs = (min + Math.random() * (max - min)) * 1000;
      await this.sleepInterruptible(delayMs);
    }
    db.flushNow();
  }

  async _sendWithRetry(item, text, camp) {
    const db = this.db;
    const maxRetry = Math.max(1, Number(this.config.max_retry) || 1);
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      queue.incrementAttempts(db, item.id);
      try {
        const res = await this.wa.sendText(item.phone, text);
        if (!res || !res.messageId) throw new Error('No message id returned by WhatsApp');
        queue.markSent(db, item.id, res.messageId);
        db.run(
          "INSERT INTO messages (direction, phone, name, campaign_id, message_id, body, status, created_at) VALUES ('out', ?, ?, ?, ?, ?, 'SENT', ?)",
          [item.phone, item.name || '', camp.id, res.messageId, text, now()]
        );
        contacts.upsert(db, item.phone, item.name || '');
        this.logger.success(`Message sent successfully - Recipient: +${item.phone} (Campaign: ${camp.name}, Message ID: ${res.messageId})`);

        // Cloud Save: archive the conversation if supported (spec section 5).
        if (this.config.archive_after_send && typeof this.wa.archiveChat === 'function') {
          try {
            await this.wa.archiveChat(item.phone);
            this.logger.info(`Conversation archived: +${item.phone}`);
          } catch (e) {
            this.logger.debug(`Archive not applied for +${item.phone}: ${e.message}`);
          }
        }
        db.flushNow();
        return 'sent';
      } catch (err) {
        const kind = classifySendError(err);
        if (kind === 'restriction' || kind === 'session') {
          this.logger.error(`Send rejected for +${item.phone}: ${err.message || err}`);
          return 'restricted';
        }
        this.logger.warn(`Message failed (attempt ${attempt}/${maxRetry}) for +${item.phone}: ${err.message || err}`);
        if (attempt >= maxRetry) {
          queue.markFailed(db, item.id, err.message || String(err));
          db.run(
            "INSERT INTO messages (direction, phone, name, campaign_id, body, status, error, created_at) VALUES ('out', ?, ?, ?, ?, 'FAILED', ?, ?)",
            [item.phone, item.name || '', camp.id, text, String(err.message || err).slice(0, 300), now()]
          );
          db.flushNow();
          return 'failed';
        }
        await new Promise((r) => setTimeout(r, Math.min(5000, 1500 * attempt)));
      }
    }
    return 'failed';
  }

  _progress(current, lastAction) {
    const c = queue.counts(this.db, this.campaignId);
    const camp = manager.get(this.db, this.campaignId);
    this.ui.progressUpdate({
      name: camp ? camp.name : `#${this.campaignId}`,
      sent: c.sent,
      pending: c.pending,
      failed: c.failed,
      skipped: c.skipped,
      total: c.total,
      current: current ? `+${current}${lastAction ? ' ' + lastAction : ''}` : '',
    });
  }
}

module.exports = { CampaignRunner, getActiveRunner, classifySendError };
