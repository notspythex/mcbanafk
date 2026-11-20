'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { ReconnectManager } = require('../src/reconnectManager');
const { BotManager } = require('../src/botManager');
const { makeConfig, fakeFactory, until, wait, driveToAfk, newLogger } = require('./helpers');

const NAMES = ['SpyGotMace', 'btw_iamspy', 'spythex_00', 'ik_urnoob28'];

test('backoff grows exponentially and is capped at the maximum', () => {
  const rm = new ReconnectManager({ delaySeconds: 10, backoffFactor: 2, maxDelaySeconds: 60, maxAttempts: 0, jitterPercent: 0 }, { setTimer: () => 1, clearTimer: () => {} });
  const delays = [];
  for (let i = 0; i < 6; i++) { rm.timer = null; delays.push(rm.schedule(() => {})); }
  assert.deepStrictEqual(delays, [10000, 20000, 40000, 60000, 60000, 60000]);
});

test('only one timer can be pending (no duplicate reconnect timers)', () => {
  let timers = 0;
  const rm = new ReconnectManager({ delaySeconds: 1, backoffFactor: 2, maxDelaySeconds: 10, maxAttempts: 0, jitterPercent: 0 }, { setTimer: () => { timers++; return 7; }, clearTimer: () => {} });
  assert.strictEqual(rm.schedule(() => {}), 1000);
  assert.strictEqual(rm.schedule(() => {}), null);
  assert.strictEqual(rm.schedule(() => {}), null);
  assert.strictEqual(timers, 1);
  assert.strictEqual(rm.attempts, 1);
});

test('jitter never exceeds the max; maxAttempts exhausts', () => {
  const rm = new ReconnectManager({ delaySeconds: 50, backoffFactor: 2, maxDelaySeconds: 60, maxAttempts: 2, jitterPercent: 50 }, { setTimer: () => 1, clearTimer: () => {}, random: () => 1 });
  assert.ok(rm.peekDelayMs() <= 60000);
  rm.schedule(() => {}); rm.timer = null; rm.schedule(() => {}); rm.timer = null;
  assert.strictEqual(rm.exhausted(), true);
  assert.strictEqual(rm.schedule(() => {}), null);
});

async function allAfk(mgr, f) {
  mgr.startAll();
  await until(() => f.created.length === 4);
  await Promise.all(NAMES.map((n) => driveToAfk(mgr.getBot(n), f.latest(n))));
}

function mk(over) {
  const cfg = makeConfig(over);
  const logger = newLogger();
  const f = fakeFactory();
  const mgr = new BotManager(cfg, logger, { createBot: f });
  return { cfg, logger, f, mgr };
}

test('4 bots start, each reaches AFK only after its own confirmation', async () => {
  const { mgr, f } = mk();
  mgr.startAll();
  await until(() => f.created.length === 4);
  assert.ok(mgr.snapshot().bots.every((b) => b.state === 'CONNECTING'));
  await driveToAfk(mgr.getBot('SpyGotMace'), f.latest('SpyGotMace'));
  const s = mgr.snapshot().bots;
  assert.strictEqual(s.filter((b) => b.state === 'AFK').length, 1);
  assert.strictEqual(s.filter((b) => b.state === 'CONNECTING').length, 3);
  await mgr.stopAll();
});

test('one bot drops => ONLY that bot reconnects; the other 3 are never touched', async () => {
  const { mgr, f, logger } = mk();
  await allAfk(mgr, f);
  const before = f.created.length;
  const untouched = ['SpyGotMace', 'spythex_00', 'ik_urnoob28'].map((n) => f.latest(n));
  f.latest('btw_iamspy').emit('end', 'Timed out'); // unexpected
  await until(() => mgr.snapshot().reconnect.pending);
  assert.strictEqual(mgr.getBot('btw_iamspy').state, 'RECONNECTING');
  ['SpyGotMace', 'spythex_00', 'ik_urnoob28'].forEach((n) => assert.strictEqual(mgr.getBot(n).state, 'AFK'));
  await until(() => f.created.length === before + 1, 3000);
  assert.strictEqual(f.created[before].username, 'btw_iamspy');
  assert.ok(untouched.every((mc) => !mc.ended), 'other bots must not be disconnected');
  assert.ok(!logger.lines.some((l) => /group reconnect/i.test(l.message)));
  await mgr.stopAll();
});

test('two bots dropping at once each reconnect on their own (one timer per bot)', async () => {
  const { mgr, f } = mk();
  await allAfk(mgr, f);
  const before = f.created.length;
  f.latest('SpyGotMace').emit('end', 'x');
  f.latest('spythex_00').emit('end', 'y');
  await until(() => f.created.length >= before + 2, 3000);
  await wait(300);
  assert.strictEqual(f.created.length, before + 2);
  assert.deepStrictEqual(f.created.slice(before).map((m) => m.username).sort(), ['SpyGotMace', 'spythex_00']);
  await mgr.stopAll();
});

test('reconnect.enabled=false: dropped bot stays down, nothing is restarted', async () => {
  const { mgr, f } = mk({ reconnect: { enabled: false } });
  await allAfk(mgr, f);
  const before = f.created.length;
  f.latest('SpyGotMace').emit('end', 'x');
  await wait(600);
  assert.strictEqual(f.created.length, before);
  assert.strictEqual(mgr.getBot('SpyGotMace').state, 'ERROR');
  assert.strictEqual(mgr.snapshot().bots.filter((b) => b.state === 'AFK').length, 3);
  await mgr.stopAll();
});

test('intentional Stop All never triggers a reconnect', async () => {
  const { mgr, f } = mk();
  await allAfk(mgr, f);
  const before = f.created.length;
  await mgr.stopAll();
  await wait(500);
  assert.strictEqual(f.created.length, before);
  assert.strictEqual(mgr.snapshot().reconnect.pending, false);
  assert.ok(mgr.snapshot().bots.every((b) => b.state === 'OFFLINE'));
});

test('intentional single-bot stop never triggers a reconnect; others stay AFK', async () => {
  const { mgr, f } = mk();
  await allAfk(mgr, f);
  const before = f.created.length;
  await mgr.stopBot('ik_urnoob28');
  await wait(400);
  assert.strictEqual(f.created.length, before);
  assert.strictEqual(mgr.getBot('ik_urnoob28').state, 'OFFLINE');
  assert.strictEqual(mgr.snapshot().bots.filter((b) => b.state === 'AFK').length, 3);
  await mgr.stopAll();
});

test('Stop All during a pending reconnect cancels the timer', async () => {
  const { mgr, f } = mk({ reconnect: { delaySeconds: 1 } });
  await allAfk(mgr, f);
  const before = f.created.length;
  f.latest('SpyGotMace').emit('end', 'x');
  await until(() => mgr.snapshot().reconnect.pending);
  await mgr.stopAll();
  assert.strictEqual(mgr.snapshot().reconnect.pending, false);
  await wait(1300);
  assert.strictEqual(f.created.length, before);
});

test('repeated failures back off exponentially instead of looping rapidly', async () => {
  const { mgr, logger } = mk({ bots: ['SpyGotMace'], reconnect: { delaySeconds: 0.2, backoffFactor: 2, maxDelaySeconds: 5 }, connection: { connectTimeoutSeconds: 0.1 } });
  mgr.startAll();
  const re = /reconnecting in (\d+)s/;
  await until(() => logger.lines.filter((l) => re.test(l.message)).length >= 3, 8000);
  const secs = logger.lines.filter((l) => re.test(l.message)).map((l) => Number(re.exec(l.message)[1]));
  assert.ok(secs[1] >= secs[0] && secs[2] >= secs[1], `delays should not shrink: ${secs}`);
  await mgr.stopAll();
});

test('maxAttempts stops retrying that bot and reports it', async () => {
  const { mgr, logger } = mk({ bots: ['SpyGotMace'], reconnect: { delaySeconds: 0.1, maxAttempts: 2, maxDelaySeconds: 1 }, connection: { connectTimeoutSeconds: 0.1 } });
  mgr.startAll();
  await until(() => logger.lines.some((l) => l.message.includes('giving up')), 8000);
  assert.strictEqual(mgr.snapshot().reconnect.pending, false);
  await mgr.stopAll();
});

test('server proxy/VPN kick is fatal: no retry loop, other bots unaffected', async () => {
  const { mgr, f, logger } = mk({ connection: { connectTimeoutSeconds: 10 } });
  try {
    mgr.startAll();
    await until(() => f.created.length === 4);
    const mc = f.latest('btw_iamspy');
    mc.emit('kicked', '{"text":"You cannot connect using a proxy or VPN!"}');
    mc.emit('end', 'disconnect.kicked');
    await until(() => mgr.getBot('btw_iamspy').state === 'ERROR');
    await wait(500);
    assert.strictEqual(mgr.snapshot().reconnect.pending, false);
    assert.strictEqual(mgr.desired.has('btw_iamspy'), false);
    assert.strictEqual(f.created.length, 4, 'must not retry a proxy/VPN block');
    assert.ok(logger.lines.some((l) => /proxy\/VPN/.test(l.message)));
    assert.strictEqual(mgr.getBot('SpyGotMace').state, 'CONNECTING');
  } finally { await mgr.stopAll(); }
});

test('wrong password on a bot is fatal: not retried, others unaffected', async () => {
  const { mgr, f } = mk({ connection: { connectTimeoutSeconds: 10 } });
  try {
    mgr.startAll();
    await until(() => f.created.length === 4);
    const bad = mgr.getBot('spythex_00');
    const mc = f.latest('spythex_00');
    mc.emit('spawn');
    await until(() => bad.state === 'AUTHENTICATING');
    mc.emit('messagestr', 'Wrong password');
    await until(() => bad.state === 'ERROR');
    await wait(400);
    assert.strictEqual(mgr.snapshot().reconnect.pending, false);
    assert.strictEqual(mgr.desired.has('spythex_00'), false);
    assert.strictEqual(f.created.length, 4);
    assert.strictEqual(mgr.getBot('SpyGotMace').state, 'CONNECTING');
  } finally { await mgr.stopAll(); }
});

test('unknown bot name is rejected', () => {
  const { mgr } = mk();
  assert.throws(() => mgr.startBot('nobody'), /unknown bot/);
});
