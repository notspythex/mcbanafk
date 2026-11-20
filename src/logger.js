'use strict';
const { EventEmitter } = require('node:events');

/** Central logger. Redacts registered secrets from every line, keeps a ring buffer for the dashboard. */
class Logger extends EventEmitter {
  constructor({ maxLines = 500, silent = false } = {}) {
    super();
    this.maxLines = maxLines;
    this.silent = silent;
    this.secrets = new Set();
    this.lines = [];
  }

  addSecret(value) {
    if (typeof value === 'string' && value.length >= 3) this.secrets.add(value);
  }

  redact(text) {
    let out = String(text);
    for (const s of this.secrets) out = out.split(s).join('******');
    return out;
  }

  log(tag, message, bot = null) {
    const entry = { ts: Date.now(), tag, bot, message: this.redact(message) };
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) this.lines.shift();
    if (!this.silent) {
      const out = `[${tag}] ${entry.message}`;
      (tag === 'ERROR' ? console.error : console.log)(out);
    }
    this.emit('line', entry);
    return entry;
  }

  info(m, b) { return this.log('INFO', m, b); }
  warn(m, b) { return this.log('WARN', m, b); }
  error(m, b) { return this.log('ERROR', m, b); }
  recent(n = 200) { return this.lines.slice(-n); }
}

module.exports = { Logger };
