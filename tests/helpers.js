'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Logger } = require('../src/logger');

const PASSWORD = 'S3cretPw!9';
const PIN = 'pin-987654';

function makeConfig(over = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  base.login.password = PASSWORD;
  base.dashboard.pin = PIN;
  base.dashboard.port = 1; // overridden by tests
  base.login.readyDelaySeconds = 0.05;
  base.login.promptWaitSeconds = 0.3;
  base.login.timeoutSeconds = 0.6;
  base.destination.timeoutSeconds = 0.8;
  base.destination.settleSeconds = 0.05;
  base.destination.preCommandDelaySeconds = 0.05;
  base.connection.connectTimeoutSeconds = 0.5;
  base.connection.startStaggerSeconds = 0;
  base.reconnect.delaySeconds = 0.2;
  base.reconnect.maxDelaySeconds = 2;
  base.reconnect.jitterPercent = 0;
  base.reconnect.stableSeconds = 0.3;
  for (const [k, v] of Object.entries(over)) base[k] = typeof v === 'object' && !Array.isArray(v) ? { ...base[k], ...v } : v;
  return base;
}

/** Same as makeConfig but with timings that pass validation (for config tests). */
function validConfig(over = {}) {
  const c = makeConfig(over);
  c.connection.connectTimeoutSeconds = 30; c.connection.startStaggerSeconds = 6;
  c.reconnect.delaySeconds = 15; c.reconnect.maxDelaySeconds = 300;
  return c;
}

function fakeMc(username) {
  const mc = new EventEmitter();
  mc.username = username;
  mc._client = new EventEmitter();
  mc.sent = [];
  mc.version = '1.20.4';
  mc.ended = false;
  mc.chat = (t) => mc.sent.push(t);
  mc.end = (r) => { if (mc.ended) return; mc.ended = true; setImmediate(() => mc.emit('end', r || 'end')); };
  return mc;
}

/** createBot factory that records every created fake client. */
function fakeFactory() {
  const created = [];
  const factory = (opts) => { const mc = fakeMc(opts.username); mc.opts = opts; created.push(mc); return mc; };
  factory.created = created;
  factory.latest = (name) => [...created].reverse().find((m) => m.username === name);
  return factory;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, timeout = 3000, step = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await cond()) return true; await wait(step); }
  throw new Error(`timed out waiting for condition: ${cond.toString().slice(0, 100)}`);
}

/** Drive a fake client through the happy path up to AFK. */
async function driveToAfk(bot, mc) {
  mc.emit('spawn');
  await until(() => bot.state === 'CONNECTED');
  mc.emit('messagestr', 'Please /login <password>');
  await until(() => bot.state === 'AUTHENTICATING');
  mc.emit('messagestr', 'Successfully logged in!');
  await until(() => mc.sent.includes('/server randomkits'));
  mc._client.emit('login', {});
  await until(() => bot.state === 'AFK');
}

const newLogger = () => new Logger({ silent: true });

module.exports = { makeConfig, validConfig, fakeFactory, wait, until, driveToAfk, newLogger, PASSWORD, PIN };
