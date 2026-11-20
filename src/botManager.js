'use strict';
const { EventEmitter } = require('node:events');
const { Bot } = require('./bot');
const { ReconnectManager } = require('./reconnectManager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Owns every Bot and the per-bot reconnect policy.
 *
 * Each bot reconnects on its own: when one drops, ONLY that bot is retried (with its own
 * exponential backoff). The other bots are never touched.
 *
 * `desired` = bots the operator wants running. Only these are ever retried.
 * `epoch`   = bumps on every Stop All; any in-flight staggered start from an older epoch aborts,
 *             so stale work can never start bots after a stop.
 */
class BotManager extends EventEmitter {
  constructor(config, logger, { createBot, reconnectDeps } = {}) {
    super();
    this.cfg = config;
    this.log = logger;
    this.bots = new Map();
    this.desired = new Set();
    this.reconnectDeps = reconnectDeps;
    this.rms = new Map(); // bot name -> ReconnectManager
    this.stableTimers = new Map(); // bot name -> timer
    this.epoch = 0;
    this.startupPromise = Promise.resolve();
    this.startedAt = Date.now();

    for (const name of config.bots) {
      this.log.info(`Initializing ${name}`, name);
      const bot = new Bot(name, config, logger, { createBot });
      bot.on('state', () => { this._checkStable(); this.emit('update'); });
      bot.on('unexpected', (info) => this._onUnexpected(info));
      bot.on('fatal', (info) => this._onFatal(info));
      this.bots.set(name, bot);
      this.rms.set(name, new ReconnectManager(config.reconnect, reconnectDeps));
    }
  }

  getBot(name) {
    const b = this.bots.get(name);
    if (!b) throw Object.assign(new Error(`unknown bot "${name}"`), { code: 'UNKNOWN_BOT' });
    return b;
  }

  // ---------- operator actions ----------
  startAll(names = [...this.bots.keys()]) {
    names.forEach((n) => this._cancelReconnect(n));
    const epoch = ++this.epoch;
    names.forEach((n) => { this.getBot(n); this.desired.add(n); });
    this.log.info(`Starting ${names.length} bot(s)`);
    this.startupPromise = this._startStaggered(names, epoch).catch((e) => this.log.error(`startup failed: ${e.message}`));
    this.emit('update');
    return this.startupPromise;
  }

  async stopAll() {
    this.log.info('Stop All requested');
    this._cancelAllReconnects();
    this.epoch += 1;
    this.desired.clear();
    await Promise.all([...this.bots.values()].map((b) => b.stop()));
    this.emit('update');
  }

  async restartAll() {
    await this.stopAll();
    return this.startAll();
  }

  startBot(name) {
    const bot = this.getBot(name);
    this._cancelReconnect(name);
    this.desired.add(name);
    const ok = bot.start();
    this.emit('update');
    return ok;
  }

  async stopBot(name) {
    const bot = this.getBot(name);
    this.desired.delete(name);
    this._cancelReconnect(name);
    await bot.stop();
    this.emit('update');
  }

  // ---------- per-bot reconnect ----------
  _cancelReconnect(name) {
    const rm = this.rms.get(name);
    if (rm) rm.reset();
    this._clearStable(name);
  }

  _cancelAllReconnects() {
    for (const n of this.bots.keys()) this._cancelReconnect(n);
  }

  async _startStaggered(names, epoch) {
    const gap = this.cfg.connection.startStaggerSeconds * 1000;
    for (let i = 0; i < names.length; i++) {
      if (epoch !== this.epoch) return;
      const bot = this.bots.get(names[i]);
      if (this.desired.has(names[i])) bot.start();
      if (i < names.length - 1 && gap > 0) {
        await sleep(gap);
      }
    }
  }

  /** One bot dropped: retry ONLY that bot. Every other bot keeps running untouched. */
  _onUnexpected({ name, reason }) {
    if (!this.desired.has(name)) return; // already stopped by the operator
    const bot = this.bots.get(name);
    const rm = this.rms.get(name);
    this._clearStable(name);

    if (this.cfg.reconnect.enabled === false) {
      this.log.warn(`${name} dropped (${reason}); auto-reconnect is disabled (reconnect.enabled=false)`, name);
      this.emit('update');
      return;
    }
    if (rm.pending) return; // timer already armed for this bot
    if (rm.exhausted()) {
      this.log.error(`${name}: giving up after ${rm.attempts} reconnect attempts (reconnect.maxAttempts)`, name);
      this.desired.delete(name);
      this.emit('update');
      return;
    }

    bot.markReconnecting('waiting to reconnect');
    const delay = rm.schedule((attempt) => {
      if (!this.desired.has(name)) return;
      this.log.log('RECONNECTING', `${name}: reconnect attempt #${attempt}`, name);
      bot.start();
      this.emit('update');
    });
    if (delay !== null) {
      const max = this.cfg.reconnect.maxAttempts;
      this.log.log('RECONNECTING', `${name}: reconnecting in ${Math.round(delay / 1000)}s (attempt ${rm.attempts}${max ? '/' + max : ''}; trigger: ${reason})`, name);
    }
    this.emit('update');
  }

  _onFatal({ name, message }) {
    // Wrong password / unregistered account / proxy-VPN block: retrying only risks lockouts or bans.
    this.desired.delete(name);
    this._cancelReconnect(name);
    this.log.error(`${name} will not be retried automatically: ${message}`, name);
    this.emit('update');
  }

  /** Reset a bot's backoff only after it has stayed AFK for stableSeconds. */
  _checkStable() {
    for (const [name, bot] of this.bots) {
      const rm = this.rms.get(name);
      if (bot.state !== 'AFK') { this._clearStable(name); continue; }
      if (this.stableTimers.has(name) || rm.attempts === 0) continue;
      const t = setTimeout(() => {
        this.stableTimers.delete(name);
        rm.reset();
        this.log.info(`${name}: stable; reconnect backoff reset`, name);
        this.emit('update');
      }, this.cfg.reconnect.stableSeconds * 1000);
      this.stableTimers.set(name, t);
    }
  }

  _clearStable(name) {
    const t = this.stableTimers.get(name);
    if (t) clearTimeout(t);
    this.stableTimers.delete(name);
  }

  // ---------- views ----------
  snapshot() {
    const per = [...this.rms.entries()].map(([name, rm]) => ({ name, ...rm.status() }));
    const pend = per.filter((r) => r.pending).sort((x, y) => x.dueAt - y.dueAt);
    const rs = {
      pending: pend.length > 0,
      dueAt: pend.length ? pend[0].dueAt : null,
      delayMs: pend.length ? pend[0].delayMs : null,
      attempts: Math.max(0, ...per.map((r) => r.attempts)),
      maxAttempts: this.cfg.reconnect.maxAttempts,
      bot: pend.length ? pend[0].name : null,
      pendingCount: pend.length,
    };
    return {
      serverTime: Date.now(),
      appStartedAt: this.startedAt,
      server: { host: this.cfg.server.host, port: this.cfg.server.port, destination: this.cfg.destination.server },
      bots: [...this.bots.values()].map((b) => ({ ...b.snapshot(), wanted: this.desired.has(b.name), reconnectAttempts: this.rms.get(b.name).attempts })),
      reconnect: { ...rs, groupPending: false, trigger: rs.bot },
    };
  }

  async shutdown() {
    await this.stopAll();
  }
}

module.exports = { BotManager };
