'use strict';

/**
 * Owns ONE reconnect timer (one instance per bot).
 * - schedule() refuses to create a second timer while one is pending (no duplicate timers).
 * - Delay grows exponentially (delay * factor^attempts), capped at maxDelay, plus small jitter.
 * - reset() is called only after the group has been stable (the bot stayed AFK for stableSeconds).
 */
class ReconnectManager {
  constructor(cfg, { setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, random = Math.random } = {}) {
    this.cfg = cfg;
    this._set = setTimer;
    this._clear = clearTimer;
    this._now = now;
    this._random = random;
    this.timer = null;
    this.attempts = 0;
    this.dueAt = null;
    this.delayMs = null;
  }

  get pending() { return this.timer !== null; }

  exhausted() {
    return this.cfg.maxAttempts > 0 && this.attempts >= this.cfg.maxAttempts;
  }

  /** Delay for the *next* attempt, without consuming it. */
  peekDelayMs() {
    const { delaySeconds, backoffFactor, maxDelaySeconds, jitterPercent } = this.cfg;
    const base = Math.min(delaySeconds * Math.pow(backoffFactor, this.attempts), maxDelaySeconds);
    const jitter = base * (jitterPercent / 100) * this._random();
    return Math.round(Math.min(base + jitter, maxDelaySeconds) * 1000);
  }

  /** Returns the delay in ms, or null if a timer is already pending / attempts are exhausted. */
  schedule(fn) {
    if (this.timer !== null) return null;
    if (this.exhausted()) return null;
    const delay = this.peekDelayMs();
    this.attempts += 1;
    this.delayMs = delay;
    this.dueAt = this._now() + delay;
    this.timer = this._set(() => {
      this.timer = null;
      this.dueAt = null;
      try { fn(this.attempts); } catch { /* caller handles its own errors */ }
    }, delay);
    return delay;
  }

  cancel() {
    if (this.timer !== null) this._clear(this.timer);
    this.timer = null;
    this.dueAt = null;
    this.delayMs = null;
  }

  reset() {
    this.cancel();
    this.attempts = 0;
  }

  status() {
    return { pending: this.pending, attempts: this.attempts, dueAt: this.dueAt, delayMs: this.delayMs, maxAttempts: this.cfg.maxAttempts };
  }
}

module.exports = { ReconnectManager };
