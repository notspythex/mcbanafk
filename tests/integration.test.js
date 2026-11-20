'use strict';
// Real mineflayer clients <-> real protocol server on localhost. This proves the connection logic
// against actual Minecraft packets. It does NOT prove behaviour against bananasmp.net.
const { test } = require('node:test');
const assert = require('node:assert');
const { Bot } = require('../src/bot');
const { BotManager } = require('../src/botManager');
const { createMock } = require('./mockServer');
const { makeConfig, until, wait, newLogger, PASSWORD } = require('./helpers');

const NAMES = ['SpyGotMace', 'btw_iamspy', 'spythex_00', 'ik_urnoob28'];

function cfgFor(mock, over = {}) {
  return makeConfig({
    server: { host: '127.0.0.1', port: mock.port, version: '1.20.4', auth: 'offline' },
    login: { readyDelaySeconds: 0.3, promptWaitSeconds: 2, timeoutSeconds: 5 },
    destination: { timeoutSeconds: 6, settleSeconds: 0.4, preCommandDelaySeconds: 0.3 },
    connection: { connectTimeoutSeconds: 10, startStaggerSeconds: 0.2 },
    reconnect: { delaySeconds: 0.5, maxDelaySeconds: 3, stableSeconds: 0.5 },
    ...over,
  });
}

test('real protocol: one bot logs in, switches server and is confirmed AFK', async () => {
  const mock = await createMock({ password: PASSWORD });
  const logger = newLogger();
  const bot = new Bot('SpyGotMace', cfgFor(mock), logger);
  const seen = [];
  bot.on('state', (s) => seen.push(s.state));
  try {
    bot.start();
    await until(() => bot.state === 'AFK', 15000);
    assert.deepStrictEqual(seen, ['CONNECTING', 'CONNECTED', 'AUTHENTICATING', 'SWITCHING_SERVER', 'AFK']);
    assert.deepStrictEqual(mock.state.commands.map((c) => c.cmd), [`login ${PASSWORD}`, 'server randomkits']);
    assert.ok(!JSON.stringify(logger.lines).includes(PASSWORD));
  } finally { await bot.stop(); await mock.close(); }
});

test('real protocol: version "auto" detection works against the mock', async () => {
  const mock = await createMock({ password: PASSWORD });
  const bot = new Bot('SpyGotMace', cfgFor(mock, { server: { host: '127.0.0.1', port: mock.port, version: 'auto', auth: 'offline' } }), newLogger());
  try {
    bot.start();
    await until(() => bot.state === 'AFK', 15000);
    assert.ok(bot.snapshot().serverVersion);
  } finally { await bot.stop(); await mock.close(); }
});

test('real protocol: wrong password => fatal ERROR, /server never sent', async () => {
  const mock = await createMock({ password: 'different-password' });
  const bot = new Bot('SpyGotMace', cfgFor(mock), newLogger());
  let fatal = 0;
  bot.on('fatal', () => fatal++);
  try {
    bot.start();
    await until(() => bot.state === 'ERROR', 15000);
    assert.strictEqual(fatal, 1);
    assert.ok(!mock.state.commands.some((c) => c.cmd.startsWith('server')));
  } finally { await bot.stop(); await mock.close(); }
});

test('real protocol: connection refused => ERROR with the real error text', async () => {
  const mock = await createMock({ password: PASSWORD });
  const port = mock.port; await mock.close();
  const bot = new Bot('SpyGotMace', cfgFor({ port }), newLogger());
  const events = [];
  bot.on('unexpected', (e) => events.push(e));
  bot.start();
  await until(() => events.length === 1, 15000);
  assert.match(events[0].reason, /ECONNREFUSED/);
  assert.strictEqual(bot.state, 'ERROR');
});

test('real protocol: 4 bots reach AFK; one kick => only that bot reconnects; Stop All is quiet', async () => {
  const mock = await createMock({ password: PASSWORD });
  const logger = newLogger();
  const mgr = new BotManager(cfgFor(mock), logger);
  const allAfk = () => mgr.snapshot().bots.every((b) => b.state === 'AFK');
  try {
    mgr.startAll();
    await until(allAfk, 30000);
    assert.deepStrictEqual([...new Set(mock.state.joins)].sort(), [...NAMES].sort());
    const joinsBefore = mock.state.joins.length;

    assert.ok(mock.kick('btw_iamspy', 'Timed out'));
    await until(() => mock.state.joins.length >= joinsBefore + 1, 30000);
    await until(allAfk, 30000);
    assert.strictEqual(mock.state.joins.length, joinsBefore + 1, 'only the kicked bot should rejoin');
    assert.ok(!logger.lines.some((l) => /group reconnect/i.test(l.message)));
    assert.ok(logger.lines.some((l) => l.tag === 'KICKED' && l.message.includes('Timed out')), 'kick reason text missing');

    const joins = mock.state.joins.length;
    await mgr.stopAll();
    await wait(1500);
    assert.strictEqual(mock.state.joins.length, joins, 'Stop All must not cause reconnects');
    assert.ok(mgr.snapshot().bots.every((b) => b.state === 'OFFLINE'));
  } finally { await mgr.stopAll(); await mock.close(); }
});
