'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Bot, canTransition, chatText, STATES } = require('../src/bot');
const { makeConfig, fakeFactory, until, wait, driveToAfk, newLogger, PASSWORD } = require('./helpers');

function setup(over) {
  const cfg = makeConfig(over);
  const logger = newLogger();
  const f = fakeFactory();
  const bot = new Bot('SpyGotMace', cfg, logger, { createBot: f });
  const states = [];
  bot.on('state', (s) => states.push(s.state));
  return { cfg, logger, f, bot, states };
}

test('transition table: 8 states, linear progress, no skipping', () => {
  assert.strictEqual(STATES.length, 8);
  assert.ok(canTransition('OFFLINE', 'CONNECTING'));
  assert.ok(canTransition('CONNECTING', 'CONNECTED'));
  assert.ok(!canTransition('CONNECTING', 'AFK'));
  assert.ok(!canTransition('CONNECTED', 'AFK'));
  assert.ok(!canTransition('AUTHENTICATING', 'AFK'));
  assert.ok(!canTransition('OFFLINE', 'AFK'));
  assert.ok(!canTransition('OFFLINE', 'CONNECTED'));
  assert.ok(canTransition('AFK', 'ERROR'));
  assert.ok(canTransition('AFK', 'RECONNECTING'));
  assert.ok(!canTransition('AFK', 'AFK'));
});

test('chatText flattens JSON, components and plain strings', () => {
  assert.strictEqual(chatText('{"text":"You are ","extra":[{"text":"banned"}]}'), 'You are banned');
  assert.strictEqual(chatText({ translate: 'multiplayer.disconnect.kicked' }), 'multiplayer.disconnect.kicked');
  assert.strictEqual(chatText('plain'), 'plain');
  assert.strictEqual(chatText(null), '');
});

test('chatText unwraps NBT components (1.20.3+ kick reasons)', () => {
  const nbt = require('prismarine-nbt');
  assert.strictEqual(chatText(nbt.comp({ text: nbt.string('You are banned') })), 'You are banned');
  assert.strictEqual(chatText(nbt.comp({ text: nbt.string('A: '), extra: nbt.list(nbt.comp([{ text: nbt.string('B') }])) })), 'A: B');
});

test('happy path goes through every state in order and logs real transitions', async () => {
  const { bot, f, states, logger } = setup();
  bot.start();
  assert.strictEqual(bot.state, 'CONNECTING');
  const mc = f.latest('SpyGotMace');
  await driveToAfk(bot, mc);
  assert.deepStrictEqual(states, ['CONNECTING', 'CONNECTED', 'AUTHENTICATING', 'SWITCHING_SERVER', 'AFK']);
  assert.deepStrictEqual(mc.sent, [`/login ${PASSWORD}`, '/server randomkits']);
  const tags = logger.lines.map((l) => l.tag);
  for (const t of ['CONNECTING', 'CONNECTED', 'AUTHENTICATING', 'AUTHENTICATED', 'SWITCHING', 'AFK']) assert.ok(tags.includes(t), `missing log tag ${t}`);
  await bot.stop();
});

test('password never appears in any log line', async () => {
  const { bot, f, logger } = setup();
  logger.addSecret(PASSWORD);
  bot.start();
  const mc = f.latest('SpyGotMace');
  await driveToAfk(bot, mc);
  mc.emit('messagestr', `echo ${PASSWORD}`);
  assert.ok(!JSON.stringify(logger.lines).includes(PASSWORD));
  await bot.stop();
});

test('TCP-level activity alone never marks CONNECTED', async () => {
  const { bot, f } = setup();
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc._client.emit('connect');
  mc.emit('login');
  await wait(60);
  assert.strictEqual(bot.state, 'CONNECTING');
  await bot.stop();
});

test('/login is NOT sent before spawn, and only once even with repeated prompts', async () => {
  const { bot, f } = setup();
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc.emit('messagestr', 'Please /login <password>'); // before spawn: ignored
  await wait(80);
  assert.deepStrictEqual(mc.sent, []);
  mc.emit('spawn');
  await until(() => bot.state === 'CONNECTED');
  mc.emit('messagestr', 'Please /login <password>');
  mc.emit('messagestr', 'Please /login <password>');
  await until(() => bot.state === 'AUTHENTICATING');
  await wait(60);
  assert.strictEqual(mc.sent.filter((m) => m.startsWith('/login')).length, 1);
  await bot.stop();
});

test('/server is NOT sent before authentication succeeds', async () => {
  const { bot, f } = setup();
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc.emit('spawn');
  await until(() => bot.state === 'AUTHENTICATING'); // fallback timer sends login without prompt
  await wait(100);
  assert.ok(!mc.sent.includes('/server randomkits'));
  await bot.stop();
});

test('no login prompt: falls back to sending login after promptWait', async () => {
  const { bot, f } = setup();
  bot.start();
  f.latest('SpyGotMace').emit('spawn');
  await until(() => bot.state === 'AUTHENTICATING', 1500);
  await bot.stop();
});

test('login timeout without confirmation => ERROR + unexpected event (no fake success)', async () => {
  const { bot, f } = setup({ login: { requireConfirmation: true } });
  const events = [];
  bot.on('unexpected', (e) => events.push(e));
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc.emit('spawn');
  await until(() => events.length === 1, 3000);
  assert.strictEqual(bot.state, 'ERROR');
  assert.match(events[0].reason, /login not confirmed/);
  assert.notStrictEqual(bot.state, 'AFK');
});

test('wrong password is fatal (no unexpected/reconnect event)', async () => {
  const { bot, f } = setup();
  const ev = { unexpected: 0, fatal: 0 };
  bot.on('unexpected', () => ev.unexpected++);
  bot.on('fatal', () => ev.fatal++);
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc.emit('spawn');
  await until(() => bot.state === 'AUTHENTICATING');
  mc.emit('messagestr', 'Wrong password!');
  await until(() => bot.state === 'ERROR');
  assert.deepStrictEqual(ev, { unexpected: 0, fatal: 1 });
});

test('transfer timeout => ERROR, never AFK', async () => {
  const { bot, f } = setup();
  const events = [];
  bot.on('unexpected', (e) => events.push(e));
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc.emit('spawn');
  await until(() => bot.state === 'CONNECTED');
  mc.emit('messagestr', 'Please /login <password>');
  await until(() => bot.state === 'AUTHENTICATING');
  mc.emit('messagestr', 'Successfully logged in');
  await until(() => events.length === 1, 3000);
  assert.match(events[0].reason, /transfer to randomkits not confirmed/);
});

test('server switch failure message => error', async () => {
  const { bot, f } = setup();
  const events = [];
  bot.on('unexpected', (e) => events.push(e));
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc.emit('spawn');
  await until(() => bot.state === 'CONNECTED');
  mc.emit('messagestr', 'Please /login <password>');
  await until(() => bot.state === 'AUTHENTICATING');
  mc.emit('messagestr', 'Successfully logged in');
  await until(() => mc.sent.includes('/server randomkits'));
  mc.emit('messagestr', 'Could not connect to target server');
  await until(() => events.length === 1);
  assert.match(events[0].reason, /server switch refused/);
});

test('connection timeout while CONNECTING', async () => {
  const { bot } = setup();
  const events = [];
  bot.on('unexpected', (e) => events.push(e));
  bot.start();
  await until(() => events.length === 1, 3000);
  assert.match(events[0].reason, /connection timeout/);
  assert.strictEqual(bot.state, 'ERROR');
});

test('kick is detected and reported with the reason', async () => {
  const { bot, f } = setup();
  const events = [];
  bot.on('unexpected', (e) => events.push(e));
  bot.start();
  const mc = f.latest('SpyGotMace');
  await driveToAfk(bot, mc);
  mc.emit('kicked', '{"text":"You are AFK too long"}');
  mc.emit('end', 'disconnect.kicked');
  await until(() => events.length === 1);
  assert.match(events[0].reason, /kicked: You are AFK too long/);
});

test('socket error without end event still resolves to ERROR (ECONNREFUSED)', async () => {
  const { bot, f } = setup({ connection: { connectTimeoutSeconds: 5 } });
  const events = [];
  bot.on('unexpected', (e) => events.push(e));
  bot.start();
  f.latest('SpyGotMace').emit('error', new Error('connect ECONNREFUSED 1.2.3.4:25565'));
  await until(() => events.length === 1, 3000);
  assert.match(events[0].reason, /ECONNREFUSED/);
});

test('duplicate start prevented: only one client is ever created', async () => {
  const { bot, f } = setup();
  assert.strictEqual(bot.start(), true);
  assert.strictEqual(bot.start(), false);
  assert.strictEqual(bot.start(), false);
  assert.strictEqual(f.created.length, 1);
  await bot.stop();
});

test('intentional stop => OFFLINE, no unexpected event, restartable', async () => {
  const { bot, f } = setup();
  let unexpected = 0;
  bot.on('unexpected', () => unexpected++);
  bot.start();
  await driveToAfk(bot, f.latest('SpyGotMace'));
  await bot.stop();
  assert.strictEqual(bot.state, 'OFFLINE');
  assert.strictEqual(bot.active, false);
  assert.strictEqual(unexpected, 0);
  assert.strictEqual(bot.start(), true);
  assert.strictEqual(f.created.length, 2);
  await bot.stop();
});

test('stale events from an old connection cannot affect a new one', async () => {
  const { bot, f } = setup();
  bot.start();
  const old = f.latest('SpyGotMace');
  await bot.stop();
  bot.start();
  assert.strictEqual(bot.state, 'CONNECTING');
  old.emit('end', 'late event from old client');
  old.emit('spawn');
  await wait(50);
  assert.strictEqual(bot.state, 'CONNECTING');
  await bot.stop();
});

test('createBot throwing is handled as an error, not a crash', async () => {
  const cfg = makeConfig();
  const bot = new Bot('SpyGotMace', cfg, newLogger(), { createBot: () => { throw new Error('boom'); } });
  const events = [];
  bot.on('unexpected', (e) => events.push(e));
  bot.start();
  await until(() => events.length === 1);
  assert.match(events[0].reason, /boom/);
  assert.strictEqual(bot.active, false);
});

test('sendChat refuses when not connected', () => {
  const { bot } = setup();
  assert.throws(() => bot.sendChat('/hi'), /cannot send chat/);
});

test('login prompt shown again after /login => login is resent once, never more than maxSends', async () => {
  const { Bot } = require('../src/bot');
  const cfg = makeConfig({ login: { resendAfterSeconds: 0.1, maxSends: 2, timeoutSeconds: 5 } });
  const f = fakeFactory();
  const bot = new Bot('SpyGotMace', cfg, newLogger(), { createBot: f });
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc.emit('spawn');
  await until(() => bot.state === 'CONNECTED');
  mc.emit('messagestr', 'AUTH > Login using /login <password>. You have 3 attempts');
  await until(() => bot.state === 'AUTHENTICATING');
  assert.strictEqual(mc.sent.filter((m) => m.startsWith('/login')).length, 1);
  await wait(150);
  mc.emit('messagestr', 'AUTH > Login using /login <password>. You have 3 attempts');
  assert.strictEqual(mc.sent.filter((m) => m.startsWith('/login')).length, 2);
  await wait(150);
  mc.emit('messagestr', 'AUTH > Login using /login <password>. You have 3 attempts');
  assert.strictEqual(mc.sent.filter((m) => m.startsWith('/login')).length, 2, 'must not exceed maxSends');
  await bot.stop();
});

test('no success message + requireConfirmation=false => continues to the server switch', async () => {
  const { Bot } = require('../src/bot');
  const cfg = makeConfig({ login: { requireConfirmation: false, timeoutSeconds: 0.2, maxSends: 1 } });
  const f = fakeFactory();
  const bot = new Bot('SpyGotMace', cfg, newLogger(), { createBot: f });
  bot.start();
  const mc = f.latest('SpyGotMace');
  mc.emit('spawn');
  await until(() => bot.state === 'AUTHENTICATING', 3000);
  await until(() => mc.sent.includes('/server randomkits'), 3000);
  await bot.stop();
});

test('proxy/VPN kick with antiVpnFallback enabled => reconnect via fallback host, then fatal if blocked again', async () => {
  const { Bot } = require('../src/bot');
  const cfg = makeConfig({ antiVpnFallback: { enabled: true, host: 'alt.example.net', port: 25570 } });
  const f = fakeFactory();
  const bot = new Bot('SpyGotMace', cfg, newLogger(), { createBot: f });
  const events = []; bot.on('unexpected', (e) => events.push(['unexpected', e])); bot.on('fatal', (e) => events.push(['fatal', e]));
  bot.start();
  assert.strictEqual(f.latest('SpyGotMace').opts.host, 'bananasmp.net');
  let mc = f.latest('SpyGotMace');
  mc.emit('kicked', '{"text":"You cannot connect using a proxy or VPN"}'); mc.emit('end', 'x');
  await until(() => events.length === 1);
  assert.strictEqual(events[0][0], 'unexpected');
  bot.markReconnecting(); bot.start();
  mc = f.latest('SpyGotMace');
  assert.strictEqual(mc.opts.host, 'alt.example.net');
  assert.strictEqual(mc.opts.port, 25570);
  mc.emit('kicked', '{"text":"You cannot connect using a proxy or VPN"}'); mc.emit('end', 'x');
  await until(() => events.length === 2);
  assert.strictEqual(events[1][0], 'fatal');
});
