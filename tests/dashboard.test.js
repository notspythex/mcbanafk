'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io: ioc } = require('socket.io-client');
const { BotManager } = require('../src/botManager');
const { createDashboard } = require('../src/dashboard');
const { makeConfig, fakeFactory, until, wait, driveToAfk, newLogger, PIN, PASSWORD } = require('./helpers');

let dash, mgr, f, base, logger, token;
const call = async (path, { method = 'GET', body, tok = token } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { 'x-auth-token': tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

before(async () => {
  logger = newLogger(); logger.addSecret(PASSWORD); logger.addSecret(PIN);
  f = fakeFactory();
  mgr = new BotManager(makeConfig({ connection: { connectTimeoutSeconds: 30 } }), logger, { createBot: f });
  dash = createDashboard({ pin: PIN, manager: mgr, logger, host: '127.0.0.1' });
  base = `http://127.0.0.1:${await dash.start(0)}`;
});
after(async () => { await mgr.stopAll(); await dash.stop(); });

test('health is public and leaks nothing', async () => {
  const r = await call('/api/health', { tok: null });
  assert.deepStrictEqual(r.body, { ok: true });
});

test('API requires a token', async () => {
  for (const [p, m] of [['/api/state', 'GET'], ['/api/all/start', 'POST'], ['/api/bots/SpyGotMace/stop', 'POST'], ['/api/logs', 'GET']]) {
    assert.strictEqual((await call(p, { method: m, tok: null })).status, 401, p);
  }
  assert.strictEqual((await call('/api/state', { tok: 'forged' })).status, 401);
});

test('wrong PIN rejected, then rate limited after 5 failures; correct PIN also blocked while locked', async () => {
  for (let i = 0; i < 5; i++) assert.strictEqual((await call('/api/login', { method: 'POST', body: { pin: 'nope' + i }, tok: null })).status, 401);
  const locked = await call('/api/login', { method: 'POST', body: { pin: PIN }, tok: null });
  assert.strictEqual(locked.status, 429);
});

test('correct PIN issues a token (fresh dashboard instance, new rate-limit state)', async () => {
  const d2 = createDashboard({ pin: PIN, manager: mgr, logger, host: '127.0.0.1' });
  const b2 = `http://127.0.0.1:${await d2.start(0)}`;
  const bad = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'x' }) });
  assert.strictEqual(bad.status, 401);
  const ok = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  assert.strictEqual(ok.status, 200);
  const j = await ok.json();
  assert.match(j.token, /^[0-9a-f]{48}$/);
  token = j.token;
  dash._tokens.set(token, Date.now() + 60000); // same manager, allow use against first dashboard
  await d2.stop();
});

test('state endpoint shows 4 bots, OFFLINE before start, no secrets', async () => {
  const r = await call('/api/state');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.bots.length, 4);
  assert.ok(r.body.bots.every((b) => b.state === 'OFFLINE'));
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(PASSWORD) && !text.includes(PIN));
  assert.strictEqual(r.body.server.host, 'bananasmp.net');
});

test('security headers present', async () => {
  const r = await call('/api/health', { tok: null });
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
  assert.strictEqual(r.headers.get('x-powered-by'), null);
});

test('individual start / duplicate start / stop', async () => {
  assert.strictEqual((await call('/api/bots/SpyGotMace/start', { method: 'POST' })).status, 202);
  assert.strictEqual((await call('/api/bots/SpyGotMace/start', { method: 'POST' })).status, 409);
  assert.strictEqual(f.created.length, 1);
  assert.strictEqual((await call('/api/bots/SpyGotMace/stop', { method: 'POST' })).status, 200);
  assert.strictEqual(mgr.getBot('SpyGotMace').state, 'OFFLINE');
});

test('unknown bot => 404, bad action => 400', async () => {
  assert.strictEqual((await call('/api/bots/Nobody/start', { method: 'POST' })).status, 404);
  assert.strictEqual((await call('/api/bots/SpyGotMace/explode', { method: 'POST' })).status, 400);
  assert.strictEqual((await call('/api/all/explode', { method: 'POST' })).status, 400);
});

test('command: refused when offline, validated, and sent when AFK', async () => {
  assert.strictEqual((await call('/api/bots/SpyGotMace/command', { method: 'POST', body: { text: '/hi' } })).status, 409);
  mgr.startBot('SpyGotMace');
  const bot = mgr.getBot('SpyGotMace'); const mc = f.latest('SpyGotMace');
  await driveToAfk(bot, mc);
  assert.strictEqual((await call('/api/bots/SpyGotMace/command', { method: 'POST', body: { text: '' } })).status, 400);
  assert.strictEqual((await call('/api/bots/SpyGotMace/command', { method: 'POST', body: { text: 'a\nb' } })).status, 400);
  assert.strictEqual((await call('/api/bots/SpyGotMace/command', { method: 'POST', body: { text: 'x'.repeat(300) } })).status, 400);
  assert.strictEqual((await call('/api/bots/SpyGotMace/command', { method: 'POST', body: { text: '/home' } })).status, 200);
  assert.ok(mc.sent.includes('/home'));
  const logs = await call('/api/logs');
  assert.ok(!JSON.stringify(logs.body).includes(PASSWORD), 'password leaked in /api/logs');
});

test('Start All / Restart All / Stop All', async () => {
  await call('/api/all/stop', { method: 'POST' });
  assert.ok(mgr.snapshot().bots.every((b) => b.state === 'OFFLINE'));
  assert.strictEqual((await call('/api/all/start', { method: 'POST' })).status, 202);
  await until(() => mgr.snapshot().bots.every((b) => b.state === 'CONNECTING'));
  const created = f.created.length;
  assert.strictEqual((await call('/api/all/restart', { method: 'POST' })).status, 202);
  await until(() => f.created.length === created + 4);
  assert.strictEqual((await call('/api/all/stop', { method: 'POST' })).status, 200);
  assert.ok(mgr.snapshot().bots.every((b) => b.state === 'OFFLINE'));
});

test('malformed JSON and oversized bodies do not crash the server', async () => {
  const r1 = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.ok([400, 401].includes(r1.status));
  const r2 = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'x'.repeat(5000) }) });
  assert.ok(r2.status >= 400 && r2.status < 500);
  assert.strictEqual((await call('/api/health', { tok: null })).status, 200);
});

test('socket.io: rejects without token; with token receives snapshot, logs and live updates', async () => {
  const bad = ioc(base, { auth: { token: 'nope' }, reconnection: false });
  const err = await new Promise((res) => bad.on('connect_error', res));
  assert.strictEqual(err.message, 'unauthorized');
  bad.close();

  const s = ioc(base, { auth: { token }, reconnection: false });
  const snap = await new Promise((res) => s.once('snapshot', res));
  assert.strictEqual(snap.bots.length, 4);
  const updates = [];
  s.on('snapshot', (x) => updates.push(x));
  const lines = [];
  s.on('log', (l) => lines.push(l));
  mgr.startBot('btw_iamspy');
  await until(() => updates.some((u) => u.bots.find((b) => b.name === 'btw_iamspy').state === 'CONNECTING'));
  await until(() => lines.some((l) => l.tag === 'CONNECTING'));
  await mgr.stopBot('btw_iamspy');
  s.close();
});

test('static dashboard files are served', async () => {
  for (const p of ['/', '/app.js', '/style.css']) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200, p);
  }
});

test('listen on an occupied port fails with a clear error instead of crashing', async () => {
  const net = require('node:net');
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const port = blocker.address().port;
  const d3 = createDashboard({ pin: PIN, manager: mgr, logger, host: '127.0.0.1' });
  await assert.rejects(() => d3.start(port), /EADDRINUSE/);
  blocker.close();
});
