'use strict';
const { EventEmitter } = require('node:events');
const mineflayer = require('mineflayer');

const STATES = ['OFFLINE', 'CONNECTING', 'CONNECTED', 'AUTHENTICATING', 'SWITCHING_SERVER', 'AFK', 'RECONNECTING', 'ERROR'];

// Forward progress is strictly linear. OFFLINE / ERROR / RECONNECTING are reachable from anywhere.
const FORWARD = {
  OFFLINE: ['CONNECTING'],
  ERROR: ['CONNECTING'],
  RECONNECTING: ['CONNECTING'],
  CONNECTING: ['CONNECTED'],
  CONNECTED: ['AUTHENTICATING'],
  AUTHENTICATING: ['SWITCHING_SERVER'],
  SWITCHING_SERVER: ['AFK'],
  AFK: [],
};
const ANYTIME = new Set(['OFFLINE', 'ERROR', 'RECONNECTING']);
const LIVE_STATES = new Set(['CONNECTED', 'AUTHENTICATING', 'SWITCHING_SERVER', 'AFK']);
const DEFAULT_POST_AUTH_DELAY_S = 1.5;

function canTransition(from, to) {
  return from !== to && (ANYTIME.has(to) || (FORWARD[from] || []).includes(to));
}

/** 1.20.3+ sends chat components as NBT ({type, value} wrappers). Unwrap to plain JS. */
function unwrapNbt(n) {
  if (!n || typeof n !== 'object' || typeof n.type !== 'string' || !('value' in n)) return n;
  if (n.type === 'compound') return Object.fromEntries(Object.entries(n.value).map(([k, v]) => [k, unwrapNbt(v)]));
  if (n.type === 'list') return (n.value.value || []).map((item) => (n.value.type === 'compound' ? unwrapNbt({ type: 'compound', value: item }) : unwrapNbt({ type: n.value.type, value: item })));
  return n.value;
}

/** Flatten a Minecraft chat component / JSON string / ChatMessage into plain text. */
function chatText(c) {
  if (c == null) return '';
  if (typeof c === 'string') {
    const t = c.trim();
    if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
      try { return chatText(JSON.parse(t)); } catch { /* plain text */ }
    }
    return c;
  }
  if (Array.isArray(c)) return c.map(chatText).join('');
  if (typeof c === 'object') {
    if (typeof c.type === 'string' && 'value' in c) return chatText(unwrapNbt(c));
    if (typeof c.toString === 'function' && c.toString !== Object.prototype.toString) {
      const s = c.toString();
      if (s && s !== '[object Object]') return s;
    }
    let out = '';
    if (c.text !== undefined) out += chatText(c.text);
    else if (c.translate) out += c.translate + (Array.isArray(c.with) ? ' ' + c.with.map(chatText).join(' ') : '');
    if (c.extra) out += chatText(c.extra);
    return out;
  }
  return String(c);
}

const matches = (text, patterns) => {
  const t = String(text).toLowerCase();
  return patterns.some((p) => p && t.includes(p.toLowerCase()));
};

class Bot extends EventEmitter {
  constructor(name, config, logger, { createBot = mineflayer.createBot } = {}) {
    super();
    this.name = name;
    this.cfg = config;
    this.log = logger;
    this._createBot = createBot;

    this.state = 'OFFLINE';
    this.detail = '';
    this.lastError = null;
    this.mc = null;
    this.active = false; // true from start() until the connection has fully ended
    this.gen = 0; // bumps on every start(); stale event handlers compare against it
    this.sessionStart = null;
    this.afkSince = null;
    this.timers = new Set();
    this.useFallback = false; // set after an anti-VPN block; sticky across reconnects
    this._reset();
  }

  _reset() {
    this.intentional = false;
    this.fatalMessage = null;
    this.pendingFailure = null;
    this.kickReason = null;
    this.sessionError = null;
    this.ended = false;
    this.loginSent = false;
    this.loginSends = 0;
    this.loginSentAt = 0;
    this.ready = false;
    this.promptSeen = false;
    this.switchSent = false;
    this.transferSeen = false;
    this.chatConfirmed = false;
    this.transferEvidence = null;
    this.settleTimer = null;
    this.stopWaiters = [];
  }

  // ---------- state machine ----------
  setState(next, detail = '') {
    if (!STATES.includes(next)) throw new Error(`unknown state ${next}`);
    if (!canTransition(this.state, next)) {
      this.log.warn(`${this.name}: blocked invalid transition ${this.state} -> ${next}`, this.name);
      return false;
    }
    this.state = next;
    this.detail = detail;
    if (next === 'CONNECTED') this.sessionStart = Date.now();
    if (next === 'AFK') this.afkSince = Date.now();
    if (['OFFLINE', 'ERROR', 'RECONNECTING', 'CONNECTING'].includes(next)) { this.sessionStart = null; this.afkSince = null; }
    this.emit('state', this.snapshot());
    return true;
  }

  markReconnecting(detail = 'waiting for group reconnect') {
    if (this.active) return false;
    return this.setState('RECONNECTING', detail);
  }

  // ---------- timers ----------
  _after(ms, fn) {
    const gen = this.gen;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (gen !== this.gen || this.ended) return;
      try { fn(); } catch (e) { this._fail(`internal error: ${e.message}`); }
    }, ms);
    this.timers.add(t);
    return t;
  }

  _clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ---------- lifecycle ----------
  /** Returns false (and does nothing) if this bot already has a live or starting connection. */
  start() {
    if (this.active || !['OFFLINE', 'ERROR', 'RECONNECTING'].includes(this.state)) {
      this.log.warn(`${this.name} is already ${this.state}; duplicate start prevented`, this.name);
      return false;
    }
    this.active = true;
    this.gen += 1;
    this._reset();
    const gen = this.gen;
    const { server } = this.cfg;
    const fb = this.cfg.antiVpnFallback || {};
    const viaFallback = this.useFallback && fb.enabled;
    const host = viaFallback && fb.host ? fb.host : server.host;
    const port = viaFallback && fb.port ? fb.port : server.port;
    this.setState('CONNECTING', `${host}:${port}${viaFallback ? ' (anti-VPN fallback)' : ''}`);
    this.log.log('CONNECTING', `${this.name}${viaFallback ? ' [fallback route]' : ''}`, this.name);

    let mc;
    try {
      const opts = {
        host,
        port,
        username: this.name,
        auth: 'offline',
        version: server.version === 'auto' ? false : server.version,
        hideErrors: true,
        checkTimeoutInterval: 30000,
      };
      if (viaFallback && fb.socksProxy && fb.socksProxy.host) opts.connect = this._socksConnector(fb.socksProxy, host, port);
      mc = this._createBot(opts);
    } catch (e) {
      this.log.error(`${this.name} failed to create client: ${e.message}`, this.name);
      this._handleEnd(gen, `client creation failed: ${e.message}`);
      return true;
    }
    this.mc = mc;
    this._attach(mc, gen);
    this._after(this.cfg.connection.connectTimeoutSeconds * 1000, () => {
      if (this.state === 'CONNECTING') this._fail(`connection timeout after ${this.cfg.connection.connectTimeoutSeconds}s (no spawn from server)`);
    });
    return true;
  }

  /** Route the TCP connection through a SOCKS5 proxy (only used by the anti-VPN fallback). */
  _socksConnector(px, host, port) {
    return (client) => {
      let SocksClient;
      try { ({ SocksClient } = require('socks')); } catch { return client.emit('error', new Error('fallback socksProxy needs the "socks" package: run npm install')); }
      SocksClient.createConnection({
        proxy: { host: px.host, port: px.port, type: 5, userId: px.username || undefined, password: px.password || undefined },
        command: 'connect',
        destination: { host, port },
      }).then(({ socket }) => { client.setSocket(socket); client.emit('connect'); }).catch((err) => client.emit('error', err));
    };
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.active) {
        if (!['OFFLINE'].includes(this.state)) this.setState('OFFLINE', 'stopped');
        return resolve();
      }
      this.intentional = true;
      this.stopWaiters.push(resolve);
      this._closeClient('manual stop');
    });
  }

  _closeClient(reason) {
    const gen = this.gen;
    try { this.mc && this.mc.end(reason); } catch { /* already closed */ }
    // Safety net: some failure modes never emit 'end'.
    const t = setTimeout(() => this._handleEnd(gen, reason), 2000);
    this.timers.add(t);
  }

  _fail(reason) {
    if (this.ended) return;
    this.pendingFailure = reason;
    this.log.error(`${this.name} ${reason}`, this.name);
    this._closeClient(reason);
  }

  _fatal(message) {
    if (this.ended) return;
    this.fatalMessage = message;
    this.log.error(`${this.name} ${message}`, this.name);
    this._closeClient(message);
  }

  // ---------- mineflayer events ----------
  _attach(mc, gen) {
    const live = () => gen === this.gen && !this.ended;

    mc.on('spawn', () => {
      if (!live()) return;
      if (this.state === 'CONNECTING') this._onFirstSpawn();
      else if (this.state === 'SWITCHING_SERVER' && this.switchSent) this._onTransferSignal('spawn event');
    });

    // Raw packets: a second login / respawn after /server is how a proxy transfer shows up.
    const client = mc._client;
    if (client) {
      client.on('login', () => {
        if (!live()) return;
        // Join-game packet = the server really accepted us (not just TCP). Auth lobbies may never send health, so don't wait for 'spawn'.
        if (this.state === 'CONNECTING') this._onFirstSpawn();
        else if (this.state === 'SWITCHING_SERVER' && this.switchSent) this._onTransferSignal('login packet');
      });
      client.on('respawn', () => { if (live() && this.state === 'SWITCHING_SERVER' && this.switchSent) this._onTransferSignal('respawn packet'); });
    }

    mc.on('messagestr', (msg) => { if (live()) this._onMessage(String(msg)); });

    mc.on('kicked', (reason) => {
      if (gen !== this.gen) return;
      const text = chatText(reason).replace(/\s+/g, ' ').trim();
      this.kickReason = `kicked: ${text || 'no reason given'}`;
      this.log.log('KICKED', `${this.name} ${this.kickReason}`, this.name);
      // Server-side proxy/VPN filter: this IP is blocked, so retrying cannot help and only risks a ban.
      const blocked = (this.cfg.connection && this.cfg.connection.blockedPatterns) || [];
      if (text && matches(text, blocked)) {
        const fb = this.cfg.antiVpnFallback || {};
        if (fb.enabled && !this.useFallback) {
          this.useFallback = true; // not fatal: the manager will reconnect this bot via the fallback route
          this.log.warn(`${this.name}: blocked by the server's proxy/VPN filter, switching to the anti-VPN fallback route`, this.name);
        } else {
          this.fatalMessage = `server blocked this connection (proxy/VPN/datacenter IP filter): "${text.slice(0, 150)}". Not retrying. ${fb.enabled ? 'The fallback route was also blocked.' : 'Set antiVpnFallback in config.json (see README) or ask staff to whitelist this IP.'}`;
        }
      }
    });

    mc.on('error', (err) => {
      if (gen !== this.gen) return;
      const m = err && err.message ? err.message : String(err);
      this.sessionError = m;
      this.lastError = m;
      this.log.error(`${this.name} error: ${m}`, this.name);
      // Connection-level errors are normally followed by 'end'; make sure we never hang if not.
      this._after(500, () => this._handleEnd(gen, m));
    });

    mc.on('end', (reason) => this._handleEnd(gen, reason));
  }

  _onFirstSpawn() {
    const l = this.cfg.login;
    this.setState('CONNECTED', 'spawned, waiting for login prompt');
    this.log.log('CONNECTED', `${this.name} connected to ${this.cfg.server.host} (server version ${this.mc.version || 'unknown'})`, this.name);
    const readyMs = l.readyDelaySeconds * 1000;
    this._after(readyMs, () => {
      this.ready = true;
      if (this.promptSeen) this._sendLogin('login prompt seen');
    });
    this._after(Math.max(l.promptWaitSeconds * 1000, readyMs + 500), () => {
      if (!this.loginSent) {
        this.log.warn(`${this.name}: no login prompt seen after ${l.promptWaitSeconds}s, sending login anyway`, this.name);
        this._sendLogin('prompt wait elapsed');
      }
    });
  }

  _sendLogin(why) {
    if (this.loginSent || this.state !== 'CONNECTED') return;
    this.loginSent = true;
    const l = this.cfg.login;
    this.setState('AUTHENTICATING', why);
    this.log.log('AUTHENTICATING', this.name, this.name);
    this._doLoginChat();
    this._after(l.timeoutSeconds * 1000, () => {
      if (this.state !== 'AUTHENTICATING') return;
      if (l.requireConfirmation) this._fail(`login not confirmed within ${l.timeoutSeconds}s (no success message matched; check the [CHAT] lines and add the server's success text to login.successPatterns)`);
      else {
        this.log.warn(`${this.name}: no login success message within ${l.timeoutSeconds}s, continuing anyway; the server switch will prove whether login worked`, this.name);
        this._onAuthenticated();
      }
    });
  }

  _doLoginChat() {
    const l = this.cfg.login;
    this.loginSends += 1;
    this.loginSentAt = Date.now();
    this.mc.chat(`${l.command} ${l.password}`); // password is never logged
  }

  _onMessage(text) {
    const { login: l, destination: d, connection } = this.cfg;
    if (connection.logChat && text.trim()) this.log.log('CHAT', `${this.name}: ${text.slice(0, 300)}`, this.name);

    if (this.state === 'CONNECTED' || this.state === 'AUTHENTICATING') {
      const isPrompt = matches(text, l.promptPatterns);
      if (this.state === 'CONNECTED' && isPrompt) {
        this.promptSeen = true;
        if (this.ready) this._sendLogin('login prompt seen');
        return;
      }
      if (!isPrompt && matches(text, l.registerPatterns)) {
        return this._fatal('account is not registered on the server; register it manually, then start again');
      }
    }
    if (this.state === 'AUTHENTICATING') {
      // The server shows the login prompt again a few seconds after our /login => it probably ignored the command.
      // Resend, but never more than maxSends times in total (servers usually allow only ~3 attempts).
      const resendMs = (l.resendAfterSeconds ?? 6) * 1000;
      if (matches(text, l.promptPatterns) && !matches(text, l.successPatterns) && this.loginSends < (l.maxSends ?? 2) && Date.now() - this.loginSentAt >= resendMs) {
        this.log.warn(`${this.name}: login prompt shown again, resending login (${this.loginSends + 1}/${l.maxSends ?? 2})`, this.name);
        this._doLoginChat();
        return;
      }
      if (matches(text, l.failurePatterns)) return this._fatal('login rejected by server (wrong password?); not retrying to avoid lockouts');
      if (matches(text, l.successPatterns)) this._onAuthenticated();
      return;
    }
    if (this.state === 'SWITCHING_SERVER' && this.switchSent) {
      if (matches(text, d.failurePatterns)) return this._fail(`server switch refused: "${text.slice(0, 120)}"`);
      if (d.confirmPatterns.length && matches(text, d.confirmPatterns)) {
        this.chatConfirmed = true;
        this._armSettle('chat confirmation');
      }
    }
  }

  _onAuthenticated() {
    if (this.state !== 'AUTHENTICATING') return;
    const d = this.cfg.destination;
    this.log.log('AUTHENTICATED', this.name, this.name);
    this.setState('SWITCHING_SERVER', `-> ${d.server}`);
    this.log.log('SWITCHING', `${this.name} -> ${d.server}`, this.name);
    this._after((d.preCommandDelaySeconds ?? DEFAULT_POST_AUTH_DELAY_S) * 1000, () => {
      this.switchSent = true;
      this.mc.chat(d.command);
      this._after(d.timeoutSeconds * 1000, () => {
        if (this.state === 'SWITCHING_SERVER') this._fail(`transfer to ${d.server} not confirmed within ${d.timeoutSeconds}s`);
      });
    });
  }

  _onTransferSignal(kind) {
    this.transferSeen = true;
    this.transferEvidence = kind;
    this._armSettle(kind);
  }

  _armSettle(kind) {
    const d = this.cfg.destination;
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.timers.delete(this.settleTimer); }
    this.settleTimer = this._after(d.settleSeconds * 1000, () => {
      if (this.state !== 'SWITCHING_SERVER') return;
      const evidence = d.confirmPatterns.length ? this.chatConfirmed : this.transferSeen;
      if (!evidence) return; // keep waiting; the transfer timeout will catch a real failure
      this.setState('AFK', `joined ${d.server}`);
      this.log.log('AFK', `${this.name} successfully joined ${d.server} (confirmed by ${this.chatConfirmed ? 'chat message' : this.transferEvidence || kind})`, this.name);
      this.emit('afk');
    });
  }

  _handleEnd(gen, reason) {
    if (gen !== this.gen || this.ended) return;
    this.ended = true;
    this._clearTimers();
    const wasIntentional = this.intentional;
    const prev = this.state;
    this.mc = null;
    this.active = false;
    const waiters = this.stopWaiters;
    this.stopWaiters = [];

    const why = this.pendingFailure || this.kickReason || this.sessionError || (reason ? chatText(reason) : '') || 'connection closed';
    if (wasIntentional) {
      this.setState('OFFLINE', 'stopped');
      this.log.log('OFFLINE', `${this.name} stopped`, this.name);
    } else if (this.fatalMessage) {
      this.lastError = this.fatalMessage;
      this.setState('ERROR', this.fatalMessage);
      this.emit('fatal', { name: this.name, message: this.fatalMessage });
    } else {
      this.lastError = why;
      this.setState('ERROR', `disconnected: ${why}`);
      this.log.error(`${this.name} disconnected: ${why}`, this.name);
      this.emit('unexpected', { name: this.name, reason: why, previousState: prev });
    }
    waiters.forEach((r) => r());
  }

  // ---------- dashboard helpers ----------
  sendChat(text) {
    if (!this.mc || !LIVE_STATES.has(this.state)) throw new Error(`${this.name} is ${this.state}; cannot send chat`);
    this.mc.chat(text);
    this.log.log('CMD', `${this.name} <- ${text}`, this.name);
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      detail: this.detail,
      lastError: this.lastError,
      sessionStart: this.sessionStart,
      afkSince: this.afkSince,
      serverVersion: this.mc && this.mc.version ? String(this.mc.version) : null,
      destination: this.cfg.destination.server,
      destinationConfirmed: this.state === 'AFK',
    };
  }
}

module.exports = { Bot, STATES, canTransition, chatText, LIVE_STATES };
