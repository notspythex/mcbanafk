'use strict';
const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDERS = new Set(['CHANGE_ME', 'changeme', 'password', '']);
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Environment variables override config.json so secrets can live in the hosting panel. */
function applyEnv(cfg, env) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (!isObj(c.login)) c.login = c.login || {};
  if (!isObj(c.dashboard)) c.dashboard = c.dashboard || {};
  if (env.MC_PASSWORD) c.login.password = env.MC_PASSWORD;
  if (env.SOCKS_PASSWORD && isObj(c.antiVpnFallback) && isObj(c.antiVpnFallback.socksProxy)) c.antiVpnFallback.socksProxy.password = env.SOCKS_PASSWORD;
  if (env.DASHBOARD_PIN) c.dashboard.pin = env.DASHBOARD_PIN;
  if (env.DASHBOARD_ENABLED) c.dashboard.enabled = ['1', 'true', 'yes'].includes(env.DASHBOARD_ENABLED.toLowerCase());
  if (env.DASHBOARD_PORT) c.dashboard.port = Number(env.DASHBOARD_PORT);
  return c;
}

/** "auto" => first of DASHBOARD_PORT / SERVER_PORT / PORT. Never guesses 3000. Returns null if none. */
function resolveDashboardPort(cfg, env = process.env) {
  const p = cfg.dashboard.port;
  if (typeof p === 'number') return p;
  for (const key of ['DASHBOARD_PORT', 'SERVER_PORT', 'PORT']) {
    const n = Number(env[key]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return null;
}

/** Returns { errors: string[], warnings: string[] }. Never throws. */
function validate(cfg) {
  const errors = [];
  const warnings = [];
  if (!isObj(cfg)) return { errors: ['config must be a JSON object'], warnings };
  for (const sec of ['server', 'bots', 'login', 'destination', 'connection', 'reconnect', 'dashboard']) {
    if (cfg[sec] === undefined) errors.push(`missing section "${sec}"`);
  }
  if (errors.length) return { errors, warnings };

  if (cfg.autoStart !== undefined && typeof cfg.autoStart !== 'boolean') errors.push('autoStart must be true/false');
  const s = cfg.server;
  if (typeof s.host !== 'string' || !s.host.trim()) errors.push('server.host must be a non-empty string');
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) errors.push('server.port must be an integer 1-65535');
  if (s.version !== 'auto' && (typeof s.version !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(s.version))) {
    errors.push('server.version must be "auto" or a version like "1.20.4"');
  }
  if (s.auth !== 'offline') errors.push('server.auth must be "offline" (this project only supports offline-mode servers)');

  if (!Array.isArray(cfg.bots) || cfg.bots.length === 0) errors.push('bots must be a non-empty array of usernames');
  else {
    const seen = new Set();
    for (const b of cfg.bots) {
      if (typeof b !== 'string' || !USERNAME_RE.test(b)) errors.push(`invalid bot username: ${JSON.stringify(b)} (3-16 chars, letters/digits/_)`);
      else if (seen.has(b.toLowerCase())) errors.push(`duplicate bot username: ${b}`);
      else seen.add(b.toLowerCase());
    }
  }

  const l = cfg.login;
  if (typeof l.password !== 'string' || PLACEHOLDERS.has(l.password)) errors.push('login.password is not set (edit config.json or set MC_PASSWORD env var)');
  if (typeof l.command !== 'string' || !l.command.startsWith('/')) errors.push('login.command must be a string starting with "/"');
  for (const k of ['readyDelaySeconds', 'promptWaitSeconds', 'timeoutSeconds']) if (!posNum(l[k])) errors.push(`login.${k} must be a number >= 0`);
  for (const k of ['promptPatterns', 'successPatterns', 'failurePatterns', 'registerPatterns']) if (!strArr(l[k])) errors.push(`login.${k} must be an array of strings`);
  if (l.requireConfirmation !== undefined && typeof l.requireConfirmation !== 'boolean') errors.push('login.requireConfirmation must be true/false');
  if (strArr(l.successPatterns) && l.successPatterns.length === 0 && l.requireConfirmation) errors.push('login.successPatterns is empty but requireConfirmation is true');

  for (const k of ['resendAfterSeconds', 'maxSends']) if (l[k] !== undefined && !posNum(l[k])) errors.push(`login.${k} must be a number >= 0`);
  const fb = cfg.antiVpnFallback;
  if (fb !== undefined) {
    if (!isObj(fb)) errors.push('antiVpnFallback must be an object');
    else {
      if (typeof fb.enabled !== 'boolean') errors.push('antiVpnFallback.enabled must be true/false');
      if (fb.host !== undefined && (typeof fb.host !== 'string')) errors.push('antiVpnFallback.host must be a string');
      if (fb.port !== undefined && (!Number.isInteger(fb.port) || fb.port < 1 || fb.port > 65535)) errors.push('antiVpnFallback.port must be an integer 1-65535');
      if (fb.enabled && !fb.host && !(isObj(fb.socksProxy) && fb.socksProxy.host)) errors.push('antiVpnFallback.enabled needs a host and/or socksProxy.host');
      if (fb.socksProxy !== undefined && isObj(fb.socksProxy) && fb.socksProxy.host && !Number.isInteger(fb.socksProxy.port)) errors.push('antiVpnFallback.socksProxy.port must be an integer');
    }
  }
  const d = cfg.destination;
  if (typeof d.server !== 'string' || !d.server) errors.push('destination.server must be a non-empty string');
  if (typeof d.command !== 'string' || !d.command.startsWith('/')) errors.push('destination.command must start with "/"');
  for (const k of ['timeoutSeconds', 'settleSeconds']) if (!posNum(d[k])) errors.push(`destination.${k} must be a number >= 0`);
  for (const k of ['confirmPatterns', 'failurePatterns']) if (!strArr(d[k])) errors.push(`destination.${k} must be an array of strings`);

  if (cfg.connection.blockedPatterns !== undefined && !strArr(cfg.connection.blockedPatterns)) errors.push('connection.blockedPatterns must be an array of strings');
  const c = cfg.connection;
  if (!posNum(c.connectTimeoutSeconds) || c.connectTimeoutSeconds < 5) errors.push('connection.connectTimeoutSeconds must be a number >= 5');
  if (!posNum(c.startStaggerSeconds)) errors.push('connection.startStaggerSeconds must be a number >= 0');
  else if (c.startStaggerSeconds < 3) warnings.push('connection.startStaggerSeconds < 3 may trigger the server connection throttle');

  const r = cfg.reconnect;
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') errors.push('reconnect.enabled must be true/false');
  if (!posNum(r.delaySeconds) || r.delaySeconds < 1) errors.push('reconnect.delaySeconds must be a number >= 1');
  if (!posNum(r.maxDelaySeconds) || r.maxDelaySeconds < 1) errors.push('reconnect.maxDelaySeconds must be a number >= 1');
  else if (posNum(r.delaySeconds) && r.maxDelaySeconds < r.delaySeconds) errors.push('reconnect.maxDelaySeconds must be >= delaySeconds');
  if (typeof r.backoffFactor !== 'number' || r.backoffFactor < 1) errors.push('reconnect.backoffFactor must be a number >= 1');
  if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 0) errors.push('reconnect.maxAttempts must be an integer >= 0 (0 = unlimited)');
  if (!posNum(r.stableSeconds)) errors.push('reconnect.stableSeconds must be a number >= 0');
  if (!posNum(r.jitterPercent) || r.jitterPercent > 50) errors.push('reconnect.jitterPercent must be 0-50');

  const dash = cfg.dashboard;
  if (typeof dash.enabled !== 'boolean') errors.push('dashboard.enabled must be true/false');
  if (dash.port !== 'auto' && (!Number.isInteger(dash.port) || dash.port < 1 || dash.port > 65535)) errors.push('dashboard.port must be "auto" or an integer 1-65535');
  if (typeof dash.host !== 'string' || !dash.host) errors.push('dashboard.host must be a string');
  if (dash.enabled) {
    if (typeof dash.pin !== 'string' || PLACEHOLDERS.has(dash.pin)) errors.push('dashboard.pin is not set (edit config.json, set DASHBOARD_PIN, or disable the dashboard)');
    else if (dash.pin.length < 6) errors.push('dashboard.pin must be at least 6 characters');
  }
  return { errors, warnings };
}

function load(file = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json'), env = process.env) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { config: null, errors: [`cannot read ${file}: ${e.message}`], warnings: [] }; }
  const config = applyEnv(raw, env);
  // Backwards compatibility: old configs used reconnect.groupDelaySeconds.
  if (isObj(config.reconnect) && config.reconnect.delaySeconds === undefined && config.reconnect.groupDelaySeconds !== undefined) {
    config.reconnect.delaySeconds = config.reconnect.groupDelaySeconds;
  }
  const { errors, warnings } = validate(config);
  return { config, errors, warnings };
}

module.exports = { load, validate, applyEnv, resolveDashboardPort };
