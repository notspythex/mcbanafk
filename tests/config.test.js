'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validate, load, resolveDashboardPort, applyEnv } = require('../src/config');
const { validConfig: makeConfig } = require('./helpers');
const path = require('node:path');

const errs = (c) => validate(c).errors;

test('valid config passes', () => assert.deepStrictEqual(errs(makeConfig()), []));
test('shipped config.json is rejected until secrets are set', () => {
  const { errors } = load(path.join(__dirname, '..', 'config.json'), {});
  assert.ok(errors.some((e) => e.includes('login.password')));
  assert.ok(errors.some((e) => e.includes('dashboard.pin')));
});
test('env vars supply secrets', () => {
  const { errors } = load(path.join(__dirname, '..', 'config.json'), { MC_PASSWORD: 'abcdef12', DASHBOARD_PIN: 'pin-123456' });
  assert.deepStrictEqual(errors, []);
});
test('rejects bad host/port/version/auth', () => {
  const c = makeConfig(); c.server.host = ''; c.server.port = 70000; c.server.version = 'x'; c.server.auth = 'microsoft';
  assert.strictEqual(errs(c).length, 4);
});
test('rejects bad and duplicate usernames', () => {
  const c = makeConfig({ bots: ['ok_name', 'OK_NAME', 'bad name!'] });
  const e = errs(c);
  assert.ok(e.some((x) => x.includes('duplicate')));
  assert.ok(e.some((x) => x.includes('invalid bot username')));
});
test('rejects short PIN only when dashboard enabled', () => {
  const c = makeConfig(); c.dashboard.pin = '123';
  assert.ok(errs(c).some((e) => e.includes('at least 6')));
  c.dashboard.enabled = false;
  assert.deepStrictEqual(errs(c), []);
});
test('reconnect constraints', () => {
  const c = makeConfig(); c.reconnect.maxDelaySeconds = 1; c.reconnect.delaySeconds = 5; c.reconnect.backoffFactor = 0.5;
  assert.ok(errs(c).length >= 2);
});
test('missing section and non-object configs do not throw', () => {
  assert.ok(errs({}).length > 0);
  assert.ok(errs(null).length > 0);
  assert.ok(errs([]).length > 0);
});
test('dashboard port auto never falls back to 3000', () => {
  const c = makeConfig(); c.dashboard.port = 'auto';
  assert.strictEqual(resolveDashboardPort(c, {}), null);
  assert.strictEqual(resolveDashboardPort(c, { SERVER_PORT: '12849' }), 12849);
  assert.strictEqual(resolveDashboardPort(c, { SERVER_PORT: 'abc' }), null);
  c.dashboard.port = 4444;
  assert.strictEqual(resolveDashboardPort(c, { SERVER_PORT: '12849' }), 4444);
});
test('applyEnv does not mutate input', () => {
  const c = makeConfig(); const before = JSON.stringify(c);
  applyEnv(c, { MC_PASSWORD: 'zzzzzz' });
  assert.strictEqual(JSON.stringify(c), before);
});
